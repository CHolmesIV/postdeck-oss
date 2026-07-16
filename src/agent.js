// In-app chat agent (B10 feature 3 — SPEC.md "In-app chat agent"). Reuses the
// `claude -p` shell exactly like draft.js/copy_assist.js (lazy env overrides,
// --output-format json envelope, 60s timeout, 503-flagged error contract).
//
// HARD SAFETY BOUNDARY: this module exposes NO cancel/delete tools, ever.
// Every post the agent creates or edits via the draft-only tools stays
// status:'draft'. B14 adds `approve_post`/`publish_now` — but BOTH are
// gated behind the `agent_can_publish` setting (default '0' = off, armed
// only via an explicit Settings toggle). Unarmed, they refuse with a
// message pointing at Settings; armed, they reuse the exact same
// transition/validation/worker-submit code paths the human Approve/Submit
// buttons use (TikTok field validation, BLOTATO_DRY_RUN) — the agent never
// bypasses a safety check just because it has permission to publish. If the
// model asks for an unsupported tool (e.g. it hallucinates "delete_post"),
// executeAction() skips it with a summary explaining that's a human action —
// it never falls through to a state-changing code path.
//
// Loop: bounded at 3 rounds. Each round the model gets the user message +
// short history + the tool catalog + current context (brands/accounts,
// sticky brand) + any action results from the previous round, and must
// return STRICT JSON: {"reply": string, "actions": [{"tool":string,"args":{}}]}.
// Executed action results are fed back for one more round so the model can
// chain (draft_copy -> create_draft_post -> create_image_request). Stops
// when the model returns no actions, or after MAX_ROUNDS.

import { execFile } from 'node:child_process';
import { getDb, nowIso } from './db.js';
import { scrubText } from './scrub.js';
import { recordUsage } from './usage.js';
import { buildUsageStats } from './usage.js';
import { buildAnalytics } from './analytics.js';
import { recommendContentType } from './recommend.js';
import { buildBrief, createImageRequest } from './imagespec.js';
import { createResearchNote } from './research.js';
import { draftWithAi } from './draft.js';
import { copyAssist } from './copy_assist.js';
import { redistributeFromUrl } from './redistribute.js';
import { createExample } from './examples.js';
import { withGlobalVoice, getGlobalHardRules, mergeHardRules, getRawSetting } from './voice.js';
import { generateProfile } from './profiles.js';
import { validateTiktokFields } from './validate.js';
import { submitNow, isDryRun } from './worker.js';

const MAX_ROUNDS = 3;

// ---------- claude CLI shell (mirrors copy_assist.js's lazy-env pattern) ----------

function claudeBin() {
  return process.env.POSTDECK_CLAUDE_BIN || 'claude';
}
function draftModel() {
  return process.env.POSTDECK_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
}
function maxBudgetUsd() {
  // 0.10 headroom: the agent prompt carries the full tool catalog + context,
  // so it's larger than a plain draft. With tools disabled it still stays
  // well under this per round.
  return process.env.POSTDECK_DRAFT_BUDGET || '0.10';
}

function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      claudeBin(),
      [
        '-p',
        prompt,
        '--model',
        draftModel(),
        // CRITICAL (same fix as src/ai.js): `claude -p` is the full agentic
        // Claude Code by default - it reads files, web-searches, and loops
        // several turns, which blows --max-budget-usd (error_max_budget_usd)
        // and makes the chat agent fail. The assistant only needs to reason
        // over the provided context and emit its {reply,actions} JSON, so
        // disable all tools ("" = none) for a single cheap completion.
        '--tools',
        '',
        '--max-budget-usd',
        String(maxBudgetUsd()),
        '--output-format',
        'json',
      ],
      { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // Even on a non-zero exit, `--output-format json` prints a result
        // envelope on stdout (is_error / "Not logged in") - prefer it so
        // parseAgentOutput can surface a clean, actionable message.
        if (stdout && stdout.trim().startsWith('{')) {
          resolve(stdout);
          return;
        }
        if (err) {
          reject(Object.assign(new Error(stderr || err.message), { cause: err }));
          return;
        }
        resolve(stdout);
      }
    );
    // Close stdin so `claude -p` doesn't wait ~3s for input it never gets.
    if (child.stdin) child.stdin.end();
  });
}

/**
 * Extract the agent's {reply, actions} JSON from a claude CLI
 * --output-format json response. Same envelope shape as draft.js/
 * copy_assist.js's parseClaudeCliOutput.
 */
function parseAgentOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude CLI did not return valid JSON envelope: ${err.message}`);
  }
  const resultText = typeof outer.result === 'string' ? outer.result : stdout;
  // Surface CLI-level failures (not logged in, budget cap) as clean errors
  // instead of trying to parse an error envelope as {reply,actions}.
  if (/not logged in/i.test(resultText) || /\/login/i.test(resultText)) {
    const e = new Error('Agent unavailable: claude CLI is not logged in — use the "Log in to Claude" button, then retry.');
    e.statusCode = 503;
    throw e;
  }
  if (outer.is_error === true) {
    const e = new Error(`Agent unavailable: claude CLI returned an error (${outer.subtype || 'error'}).`);
    e.statusCode = 503;
    throw e;
  }
  // Tolerant parse: strip fences anywhere, try direct, then extract the first
  // balanced {...} object out of any surrounding prose the model added.
  let s = resultText.trim().replace(/```(?:json)?/gi, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through to extraction
  }
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(s.slice(start, end + 1));
    } catch {
      // fall through to error
    }
  }
  throw new Error(`claude CLI result was not strict JSON: ${s.slice(0, 100)}`);
}

// ---------- tool catalog (read + draft-only — NO approve/publish/submit/cancel/delete) ----------

const TOOL_CATALOG = [
  { name: 'query_posts', args: '{brand_id?, status?, from?, to?}', description: 'List posts, optionally filtered.' },
  { name: 'get_post', args: '{id}', description: 'Get one post with its metrics.' },
  { name: 'list_ideas', args: '{brand_id?, status?}', description: 'List ideas, optionally filtered.' },
  { name: 'list_brands_accounts', args: '{}', description: 'List all brands and their accounts.' },
  { name: 'get_usage', args: '{}', description: 'Ops-stats/usage rollup.' },
  { name: 'get_analytics', args: '{}', description: 'Analytics rollup (engagement metrics).' },
  {
    name: 'create_draft_post',
    args: '{brand_id, platform, account_id?, copy?, content_type?, publish_at?}',
    description: 'Create a new post. ALWAYS created as status "draft" — never published.',
  },
  {
    name: 'update_draft_post',
    args: '{id, copy?, publish_at?, content_type?}',
    description: 'Edit an existing post. Only works while the post is still status "draft"; refused otherwise.',
  },
  { name: 'create_idea', args: '{brand_id?, title, pillar?, notes?}', description: 'Add a content idea.' },
  {
    name: 'draft_copy',
    args: '{idea_text, brand_id, tone_profile_id?, platforms}',
    description: 'Draft copy for an idea (does not create a post — chain into create_draft_post to save it).',
  },
  {
    name: 'suggest_content_type',
    args: '{brand_id, pillar?, platform}',
    description: 'Recommend a content_type (static/carousel/image/text/video) for a brand+platform.',
  },
  {
    name: 'create_image_request',
    args: '{post_id?, brand_id, platforms, content_type?, copy?}',
    description: 'Request generated image variants for a post/brand.',
  },
  {
    name: 'create_research_note',
    args: '{brand_id?, source?, title, url?, body, tags?}',
    description: 'Save a research note.',
  },
  {
    name: 'redistribute_blog',
    args: '{url, brand_id?, platforms, make_images?}',
    description:
      'Turn a blog URL into a batch of DRAFT posts (one per platform, grounded in brand voice) plus an optional image request. Never publishes anything.',
  },
  {
    name: 'add_example',
    args: '{brand_id?, platform?, source?, text?, image_path?}',
    description:
      'Save an example post (pasted text or a screenshot) so future copy drafts match its style/format. source is "paste" or "screenshot".',
  },
  {
    name: 'generate_profile',
    args: '{brand_id, platform}',
    description:
      'Draft a brand platform profile (LinkedIn/Facebook/Reddit bio, tagline, about, etc.) in CB\'s voice for copy-paste into the actual platform. Saved as status "draft" — never auto-posted/published anywhere.',
  },
  {
    name: 'approve_post',
    args: '{id}',
    description:
      'Approve a draft/scheduled post so it can publish. ONLY works when CB has armed "Allow assistant to approve & publish" in Settings (agent_can_publish=1) — otherwise refuses and tells you to arm it. Honors TikTok required-field validation, same as the human Approve button.',
  },
  {
    name: 'publish_now',
    args: '{id}',
    description:
      'Immediately submit an approved/scheduled post to Blotato via the worker (respects BLOTATO_DRY_RUN — dry-run never makes a real post). ONLY works when agent_can_publish is armed in Settings; otherwise refuses.',
  },
];

/**
 * Build the per-round agent prompt. Exported for testability.
 * @param {{message: string, history?: Array<{role:string,content:string}>,
 *   context?: object, priorResults?: Array<object>}} params
 */
function buildAgentPrompt({ message, history = [], context = {}, priorResults = [] } = {}) {
  const catalogLines = TOOL_CATALOG.map((t) => `- ${t.name}(${t.args}): ${t.description}`).join('\n');
  const historyLines = history.length
    ? history.map((h) => `${h.role}: ${h.content}`).join('\n')
    : '(no prior turns)';
  const priorResultsLines = priorResults.length
    ? priorResults.map((r) => `- ${r.tool}(${JSON.stringify(r.args)}) -> ${r.summary}`).join('\n')
    : '(none yet this turn)';

  return [
    `You are PostDeck's in-app assistant for a social media content dashboard.`,
    ``,
    `HARD BOUNDARY: you may create/edit DRAFTS, write copy, add ideas, set`,
    `publish_at/content_type, request images, and answer questions from the`,
    `data. Publish authority (approve_post, publish_now) exists ONLY when CB`,
    `has armed "Allow assistant to approve & publish" in Settings (default`,
    `OFF) — when unarmed, those tools refuse and you should tell the user`,
    `it's off and point at Settings (or the human Approve button) instead.`,
    `You may NEVER cancel or delete anything, armed or not — there are no`,
    `tools for those actions; if asked, explain it's a human-only action`,
    `instead of inventing a tool call.`,
    ``,
    `Current context:`,
    JSON.stringify(context, null, 2),
    ``,
    `Conversation history so far:`,
    historyLines,
    ``,
    `User message: ${message}`,
    ``,
    `Tool catalog (only these tools exist):`,
    catalogLines,
    ``,
    `Results of actions already executed this turn:`,
    priorResultsLines,
    ``,
    `Decide whether to call any tools this round. If a prior action's result`,
    `gives you what you need to chain into another tool (e.g. draft_copy's`,
    `output feeding create_draft_post), do so. Otherwise return an empty`,
    `actions array and just reply.`,
    ``,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary:`,
    `{"reply": "...", "actions": [{"tool": "tool_name", "args": {}}]}`,
  ].join('\n');
}

// ---------- context builder ----------

function parseJsonColumns(row, columns) {
  if (!row) return row;
  const out = { ...row };
  for (const col of columns) {
    if (out[col] != null) {
      try {
        out[col] = JSON.parse(out[col]);
      } catch {
        // leave as raw string if it's not valid JSON
      }
    }
  }
  return out;
}

function listBrandsAccountsInternal(db) {
  const brands = db.prepare('SELECT * FROM brands ORDER BY id').all().map((r) => parseJsonColumns(r, ['colors']));
  const accounts = db.prepare('SELECT * FROM accounts ORDER BY id').all().map((r) => parseJsonColumns(r, ['target_fields']));
  return { brands, accounts };
}

// ---------- scrub helper ----------

/** Best-effort hard_rules lookup: the tool args don't carry a tone_profile_id
 * for create_draft_post, so fall back to the brand's first tone profile (if
 * any) as the scrub source; update_draft_post prefers the post's own. B12:
 * global hard rules (e.g. no_em_dash, default ON) are always merged in,
 * regardless of whether the brand has a tone profile at all. */
function hardRulesForBrand(db, brand_id) {
  const globalHardRules = getGlobalHardRules(db);
  if (brand_id == null) return globalHardRules;
  const tp = db.prepare('SELECT hard_rules FROM tone_profiles WHERE brand_id = ? ORDER BY id LIMIT 1').get(brand_id);
  let toneHardRules = {};
  if (tp) {
    try {
      toneHardRules = JSON.parse(tp.hard_rules || '{}');
    } catch {
      toneHardRules = {};
    }
  }
  return mergeHardRules(globalHardRules, toneHardRules);
}

function scrubCopyForBrand(db, brand_id, copy) {
  if (typeof copy !== 'string' || !copy.length) return copy;
  const hardRules = hardRulesForBrand(db, brand_id);
  return scrubText(copy, hardRules).text;
}

// ---------- tool implementations ----------

function toolQueryPosts(db, { brand_id, status, from, to } = {}) {
  const clauses = [];
  const params = [];
  let sql = `SELECT p.* FROM posts p LEFT JOIN brands b ON b.id = p.brand_id WHERE 1=1`;
  if (brand_id) {
    clauses.push('(b.slug = ? OR p.brand_id = ?)');
    params.push(brand_id, brand_id);
  }
  if (status) {
    clauses.push('p.status = ?');
    params.push(status);
  }
  if (from) {
    clauses.push('p.publish_at >= ?');
    params.push(from);
  }
  if (to) {
    clauses.push('p.publish_at <= ?');
    params.push(to);
  }
  if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
  sql += ' ORDER BY p.publish_at IS NULL, p.publish_at';
  const rows = db.prepare(sql).all(...params);
  const posts = rows.map((r) => parseJsonColumns(r, ['media', 'platform_fields']));
  return { posts, summary: `Found ${posts.length} post(s).` };
}

function toolGetPost(db, { id } = {}) {
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!row) return { post: null, summary: `Post #${id} not found.` };
  const post = parseJsonColumns(row, ['media', 'platform_fields']);
  post.metrics = db.prepare('SELECT * FROM metrics WHERE post_id = ? ORDER BY captured_at DESC').all(id);
  return { post, summary: `Loaded post #${id} (${post.status}).`, link: `#/post/${id}` };
}

function toolListIdeas(db, { brand_id, status } = {}) {
  const clauses = [];
  const params = [];
  let sql = `SELECT i.* FROM ideas i LEFT JOIN brands b ON b.id = i.brand_id WHERE 1=1`;
  if (brand_id) {
    clauses.push('(b.slug = ? OR i.brand_id = ?)');
    params.push(brand_id, brand_id);
  }
  if (status) {
    clauses.push('i.status = ?');
    params.push(status);
  }
  if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
  sql += ' ORDER BY i.id';
  const ideas = db.prepare(sql).all(...params);
  return { ideas, summary: `Found ${ideas.length} idea(s).` };
}

function toolListBrandsAccounts(db) {
  const data = listBrandsAccountsInternal(db);
  return { ...data, summary: `${data.brands.length} brand(s), ${data.accounts.length} account(s).` };
}

function toolGetUsage(db) {
  return { usage: buildUsageStats(db), summary: 'Loaded usage/ops stats.' };
}

function toolGetAnalytics(db) {
  return { analytics: buildAnalytics(db), summary: 'Loaded analytics rollup.' };
}

function toolCreateDraftPost(db, { brand_id, platform, account_id = null, copy = '', content_type = null, publish_at = null } = {}) {
  if (!platform) {
    return { post: null, summary: 'Cannot create post: platform is required.' };
  }
  const now = nowIso();
  const scrubbedCopy = scrubCopyForBrand(db, brand_id, copy || '');
  const info = db
    .prepare(
      `
      INSERT INTO posts (
        brand_id, account_id, platform, copy, media, platform_fields,
        content_type, publish_at, status, created_at, updated_at
      ) VALUES (
        @brand_id, @account_id, @platform, @copy, '[]', '{}',
        @content_type, @publish_at, 'draft', @now, @now
      )
    `
    )
    .run({
      brand_id: brand_id ?? null,
      account_id: account_id ?? null,
      platform,
      copy: scrubbedCopy || '',
      content_type: content_type ?? null,
      publish_at: publish_at ?? null,
      now,
    });
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
  const post = parseJsonColumns(row, ['media', 'platform_fields']);
  return {
    post,
    summary: `Created draft #${post.id} (${post.platform}).`,
    link: `#/post/${post.id}`,
  };
}

function toolUpdateDraftPost(db, { id, copy, publish_at, content_type } = {}) {
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!existing) {
    return { post: null, summary: `Post #${id} not found.` };
  }
  if (existing.status !== 'draft') {
    return {
      post: parseJsonColumns(existing, ['media', 'platform_fields']),
      summary: `Post #${id} is status '${existing.status}' — the agent can only edit drafts. Use the Approve/Cancel buttons for anything else.`,
      link: `#/post/${id}`,
    };
  }
  const now = nowIso();
  const merged = {
    copy: copy !== undefined ? scrubCopyForBrand(db, existing.brand_id, copy) : existing.copy,
    publish_at: publish_at !== undefined ? publish_at : existing.publish_at,
    content_type: content_type !== undefined ? content_type : existing.content_type,
    now,
    id,
  };
  db.prepare(
    `UPDATE posts SET copy = @copy, publish_at = @publish_at, content_type = @content_type, updated_at = @now WHERE id = @id`
  ).run(merged);
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  const post = parseJsonColumns(row, ['media', 'platform_fields']);
  return { post, summary: `Updated draft #${id}.`, link: `#/post/${id}` };
}

function toolCreateIdea(db, { brand_id = null, title, pillar = null, notes = null } = {}) {
  if (!title) {
    return { idea: null, summary: 'Cannot create idea: title is required.' };
  }
  const now = nowIso();
  const info = db
    .prepare(
      `
      INSERT INTO ideas (brand_id, title, pillar, notes, status, source, created_at, updated_at)
      VALUES (@brand_id, @title, @pillar, @notes, 'idea', 'agent', @now, @now)
    `
    )
    .run({ brand_id, title, pillar, notes, now });
  const idea = db.prepare('SELECT * FROM ideas WHERE id = ?').get(info.lastInsertRowid);
  return { idea, summary: `Added idea #${idea.id}: "${idea.title}".`, link: '#/ideas' };
}

async function toolDraftCopy(db, { idea_text, brand_id, tone_profile_id = null, platforms = [] } = {}) {
  const brand = brand_id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id) : null;
  if (!brand) {
    return { drafts: null, summary: 'Cannot draft copy: brand not found.' };
  }
  try {
    if (tone_profile_id) {
      const toneProfile = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(tone_profile_id);
      if (!toneProfile) {
        return { drafts: null, summary: 'Cannot draft copy: tone_profile not found.' };
      }
      // B12: merge global voice + global hard rules into the tone profile
      // before drafting — resolveVoice/withGlobalVoice is the single source
      // every generation path (draft/copy-assist/redistribute/agent) uses.
      const effectiveTone = withGlobalVoice(db, { brand_id, toneProfile });
      const result = await draftWithAi({ idea_text, brand, toneProfile: effectiveTone, platforms });
      return { drafts: result.drafts, scrub_applied: result.scrub_applied, summary: `Drafted copy for ${platforms.join(', ') || 'no platforms'}.` };
    }
    const effectiveTone = withGlobalVoice(db, { brand_id, toneProfile: null });
    const result = await copyAssist({ mode: 'all', idea_text, brand, toneProfile: effectiveTone, platforms });
    return { drafts: result.result, scrub_applied: result.scrub_applied, summary: `Drafted copy for ${platforms.join(', ') || 'no platforms'}.` };
  } catch (err) {
    return { drafts: null, summary: `AI drafting unavailable: ${err.message}` };
  }
}

function toolSuggestContentType(db, { brand_id, pillar, platform } = {}) {
  const result = recommendContentType(db, { brand_id, pillar, platform });
  return { ...result, summary: `Suggested content_type: ${result.suggestion} (${result.basis}).` };
}

function toolCreateImageRequest(db, { post_id = null, brand_id = null, platforms = [], content_type = null, copy = '' } = {}) {
  const brand = brand_id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id) : null;
  const brief = buildBrief({ platforms, content_type, copy, brand: brand ? brand.name : null });
  const row = createImageRequest(db, { post_id, brand_id, platforms, content_type, brief });
  recordUsage(db, { kind: 'image_request', brand_id });
  return { image_request: row, summary: `Requested images (#${row.id}) for ${platforms.join(', ') || 'no platforms'}.`, link: '#/images' };
}

function toolCreateResearchNote(db, { brand_id = null, source = 'manual', title, url = null, body, tags = [] } = {}) {
  if (!title && !body) {
    return { note: null, summary: 'Cannot create research note: title or body required.' };
  }
  const note = createResearchNote(db, { brand_id, source, title, url, body, tags });
  return { note, summary: `Saved research note #${note.id}.`, link: '#/research' };
}

/** DRAFT-ONLY: turns a blog URL into a batch of draft posts + an optional
 * image request. Never throws — a fetch/AI failure surfaces in `summary`. */
async function toolRedistributeBlog(db, { url, brand_id = null, platforms = [], make_images = true } = {}) {
  if (!url) {
    return { drafts: null, summary: 'Cannot redistribute: url is required.' };
  }
  try {
    const result = await redistributeFromUrl(db, { url, brand_id, platforms, make_images });
    const suffix = result.ai_unavailable ? ' (AI drafting was unavailable — copy left blank on some/all drafts)' : '';
    return {
      ...result,
      summary: `Created ${result.drafts.length} draft(s) from "${result.source.title || url}"${suffix}.`,
      link: '#/calendar',
    };
  } catch (err) {
    return { drafts: null, summary: `Could not redistribute "${url}": ${err.message}` };
  }
}

/** DRAFT-ONLY: saves an example post to ground future copy drafting. */
async function toolAddExample(db, { brand_id = null, platform = null, source = 'paste', text = null, image_path = null } = {}) {
  if (!text && !image_path) {
    return { example: null, summary: 'Cannot save example: text or image_path is required.' };
  }
  const row = await createExample(db, { brand_id, platform, source, text, image_path });
  return {
    example: row,
    summary: row.extraction_error
      ? `Saved example #${row.id}, but image extraction failed: ${row.extraction_error}`
      : `Saved example #${row.id}.`,
    link: '#/composer',
  };
}

/** DRAFT-ONLY: drafts a brand's platform profile fields for copy-paste. Never
 * publishes/posts — a human copies each field into the actual platform. */
async function toolGenerateProfile(db, { brand_id, platform } = {}) {
  if (!brand_id || !platform) {
    return { profile: null, summary: 'Cannot generate profile: brand_id and platform are required.' };
  }
  const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id);
  try {
    const profile = await generateProfile(db, { brand_id, platform });
    return {
      profile,
      summary: `Drafted ${platform} profile for ${brand ? brand.name : `brand #${brand_id}`}.`,
      link: '#/profiles',
    };
  } catch (err) {
    return { profile: null, summary: `Could not generate ${platform} profile: ${err.message}` };
  }
}

// ---------- B14: armed publish tools (agent_can_publish gate) ----------

const APPROVE_SOURCE_STATUSES = ['draft', 'scheduled_local'];

function agentCanPublish(db) {
  return getRawSetting(db, 'agent_can_publish') === '1';
}

const PUBLISH_OFF_MESSAGE = 'Approving/publishing is off — arm it in Settings.';

/** ARMED tool: moves a draft/scheduled_local post to approved (or
 * scheduled_local if it already carries a publish_at), reusing the same
 * TikTok-field validation the human Approve gate (PATCH /api/posts/:id in
 * server.js) enforces. Refuses outright when agent_can_publish isn't '1'. */
function toolApprovePost(db, { id } = {}) {
  if (!agentCanPublish(db)) {
    return { post: null, summary: PUBLISH_OFF_MESSAGE };
  }
  const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  if (!existing) {
    return { post: null, summary: `Post #${id} not found.` };
  }
  if (!APPROVE_SOURCE_STATUSES.includes(existing.status)) {
    return {
      post: parseJsonColumns(existing, ['media', 'platform_fields']),
      summary: `Post #${id} is status '${existing.status}' — can only approve from draft/scheduled_local.`,
      link: `#/post/${id}`,
    };
  }
  let platformFields = {};
  try {
    platformFields = JSON.parse(existing.platform_fields || '{}');
  } catch {
    platformFields = {};
  }
  if (existing.platform === 'tiktok') {
    const { ok, missing } = validateTiktokFields(platformFields);
    if (!ok) {
      return {
        post: null,
        summary: `Cannot approve post #${id}: TikTok post is missing required fields: ${missing.join(', ')}.`,
        link: `#/post/${id}`,
      };
    }
  }
  const nextStatus = existing.publish_at ? 'scheduled_local' : 'approved';
  const now = nowIso();
  db.prepare('UPDATE posts SET status = @status, updated_at = @now WHERE id = @id').run({ status: nextStatus, now, id });
  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
  const post = parseJsonColumns(row, ['media', 'platform_fields']);
  recordUsage(db, { kind: 'agent_publish', brand_id: post.brand_id, meta: { action: 'approve_post', post_id: id, status: nextStatus } });
  return { post, summary: `Approved post #${id} -> ${nextStatus}.`, link: `#/post/${id}` };
}

/** ARMED tool: submits an approved/scheduled post to Blotato via the exact
 * same worker.submitNow() path the "Submit now" button uses — honors
 * BLOTATO_DRY_RUN and the assisted-manual skip. Refuses outright when
 * agent_can_publish isn't '1'. */
async function toolPublishNow(db, { id } = {}) {
  if (!agentCanPublish(db)) {
    return { post: null, summary: PUBLISH_OFF_MESSAGE };
  }
  const result = await submitNow(id);
  if (result.error === 'not_found') {
    return { post: null, summary: `Post #${id} not found.` };
  }
  const brand_id = result.post ? result.post.brand_id : null;
  recordUsage(db, {
    kind: 'agent_publish',
    brand_id,
    meta: { action: 'publish_now', post_id: id, dry_run: isDryRun(), status: result.status },
  });
  if (!result.ok) {
    return { post: result.post || null, summary: `Could not publish post #${id}: ${result.error}`, link: `#/post/${id}` };
  }
  return { post: result.post, summary: `Submitted post #${id} for publishing (${result.status}).`, link: `#/post/${id}` };
}

/** Execute one {tool, args} action. Never throws — a failed/unsupported tool
 * just yields a summary describing why. Deliberately: there is no case for
 * approve/publish/submit/cancel/delete — anything not recognized falls to
 * the default branch and is treated as unsupported. */
async function executeAction(db, action = {}) {
  const tool = action?.tool;
  const args = action?.args || {};
  let outcome;
  switch (tool) {
    case 'query_posts':
      outcome = toolQueryPosts(db, args);
      break;
    case 'get_post':
      outcome = toolGetPost(db, args);
      break;
    case 'list_ideas':
      outcome = toolListIdeas(db, args);
      break;
    case 'list_brands_accounts':
      outcome = toolListBrandsAccounts(db);
      break;
    case 'get_usage':
      outcome = toolGetUsage(db);
      break;
    case 'get_analytics':
      outcome = toolGetAnalytics(db);
      break;
    case 'create_draft_post':
      outcome = toolCreateDraftPost(db, args);
      break;
    case 'update_draft_post':
      outcome = toolUpdateDraftPost(db, args);
      break;
    case 'create_idea':
      outcome = toolCreateIdea(db, args);
      break;
    case 'draft_copy':
      outcome = await toolDraftCopy(db, args);
      break;
    case 'suggest_content_type':
      outcome = toolSuggestContentType(db, args);
      break;
    case 'create_image_request':
      outcome = toolCreateImageRequest(db, args);
      break;
    case 'create_research_note':
      outcome = toolCreateResearchNote(db, args);
      break;
    case 'redistribute_blog':
      outcome = await toolRedistributeBlog(db, args);
      break;
    case 'add_example':
      outcome = await toolAddExample(db, args);
      break;
    case 'generate_profile':
      outcome = await toolGenerateProfile(db, args);
      break;
    case 'approve_post':
      outcome = toolApprovePost(db, args);
      break;
    case 'publish_now':
      outcome = await toolPublishNow(db, args);
      break;
    default:
      outcome = { summary: `Unsupported action "${tool}" — the agent has no such tool (no cancel/delete tools exist; that's a human action).` };
  }
  return { tool, args, summary: outcome.summary, link: outcome.link, data: outcome };
}

// ---------- main loop ----------

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{message: string, history?: Array<{role:string,content:string}>, brand_id?: number|null}} params
 * @returns {Promise<{reply: string, actions: Array<{tool:string,args:object,summary:string,link?:string}>, history: Array<{role:string,content:string}>}>}
 * @throws {Error & {statusCode?: number}} 503-flagged error if the CLI is unavailable/errors.
 */
async function runAgent(db = getDb(), { message, history = [], brand_id = null } = {}) {
  const brandsAccounts = listBrandsAccountsInternal(db);
  const context = { sticky_brand_id: brand_id, brands: brandsAccounts.brands, accounts: brandsAccounts.accounts };

  let round = 0;
  let reply = '';
  const actionsLog = [];
  let priorResults = [];

  while (round < MAX_ROUNDS) {
    round++;
    const prompt = buildAgentPrompt({ message, history, context, priorResults });

    let stdout;
    try {
      stdout = await runClaudeCli(prompt);
    } catch (err) {
      const wrapped = new Error(
        `Agent unavailable: could not run claude CLI (${err.code === 'ENOENT' ? 'not found on PATH' : err.message})`
      );
      wrapped.statusCode = 503;
      throw wrapped;
    }

    let parsed;
    try {
      parsed = parseAgentOutput(stdout);
    } catch (err) {
      const wrapped = new Error(`Agent unavailable: ${err.message}`);
      wrapped.statusCode = 503;
      throw wrapped;
    }

    reply = typeof parsed.reply === 'string' ? parsed.reply : '';
    const actions = Array.isArray(parsed.actions) ? parsed.actions : [];

    if (!actions.length) break;

    priorResults = [];
    for (const action of actions) {
      const result = await executeAction(db, action);
      actionsLog.push({ tool: result.tool, args: result.args, summary: result.summary, link: result.link });
      priorResults.push(result);
    }
  }

  recordUsage(db, { kind: 'agent', brand_id, meta: { rounds: round, actionCount: actionsLog.length } });

  const nextHistory = [...history, { role: 'user', content: message }, { role: 'assistant', content: reply }];

  return { reply, actions: actionsLog, history: nextHistory };
}

export { runAgent, buildAgentPrompt, parseAgentOutput, executeAction, TOOL_CATALOG };
