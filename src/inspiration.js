// Like-minded profiles board (B8 - SPEC.md "Research + inspiration
// ingestion"). Manual add of creators/accounts worth studying, plus an
// OPTIONAL AI convenience (`suggestProfiles`) that proposes candidates via
// the same `claude -p` shell pattern as src/draft.js. Suggest-only: it never
// writes to the DB or follows anyone - the caller decides whether to persist
// a suggestion via createInspiration({ source: 'ai_suggested' }).

import { execFile } from 'node:child_process';
import { nowIso } from './db.js';

// ---------- row helpers ----------

function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseInspirationRow(row) {
  if (!row) return row;
  return { ...row, tags: parseTags(row.tags) };
}

function getInspirationProfile(db, id) {
  const row = db.prepare('SELECT * FROM inspiration_profiles WHERE id = ?').get(id);
  return parseInspirationRow(row);
}

// ---------- CRUD ----------

function listInspiration(db, opts = {}) {
  const { platform } = opts;
  const hasBrandFilter = Object.prototype.hasOwnProperty.call(opts, 'brand_id');

  const conditions = [];
  const params = [];
  if (hasBrandFilter) {
    conditions.push('brand_id IS ?');
    params.push(opts.brand_id === undefined ? null : opts.brand_id);
  }
  if (platform) {
    conditions.push('platform = ?');
    params.push(platform);
  }

  let query = 'SELECT * FROM inspiration_profiles';
  if (conditions.length) query += ' WHERE ' + conditions.join(' AND ');
  query += ' ORDER BY created_at DESC, id DESC';

  return db.prepare(query).all(...params).map(parseInspirationRow);
}

function createInspiration(
  db,
  {
    brand_id = null,
    handle = null,
    platform = null,
    name = null,
    url = null,
    niche = null,
    why_relevant = null,
    tags = [],
    source = 'manual',
  } = {}
) {
  const now = nowIso();
  const info = db
    .prepare(
      `
    INSERT INTO inspiration_profiles (brand_id, handle, platform, name, url, niche, why_relevant, tags, source, created_at)
    VALUES (@brand_id, @handle, @platform, @name, @url, @niche, @why_relevant, @tags, @source, @now)
  `
    )
    .run({
      brand_id: brand_id ?? null,
      handle,
      platform,
      name,
      url,
      niche,
      why_relevant,
      tags: JSON.stringify(Array.isArray(tags) ? tags : []),
      source: source || 'manual',
      now,
    });
  return getInspirationProfile(db, info.lastInsertRowid);
}

const UPDATABLE_FIELDS = ['brand_id', 'handle', 'platform', 'name', 'url', 'niche', 'why_relevant', 'tags', 'source'];

function updateInspiration(db, id, patch = {}) {
  const existing = getInspirationProfile(db, id);
  if (!existing) return null;

  const sets = [];
  const params = { id };
  for (const field of UPDATABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    sets.push(`${field} = @${field}`);
    params[field] = field === 'tags' ? JSON.stringify(Array.isArray(patch.tags) ? patch.tags : []) : patch[field];
  }
  if (!sets.length) return existing;

  db.prepare(`UPDATE inspiration_profiles SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getInspirationProfile(db, id);
}

function deleteInspiration(db, id) {
  const info = db.prepare('DELETE FROM inspiration_profiles WHERE id = ?').run(id);
  return info.changes > 0;
}

// ---------- AI suggest (optional convenience, suggest-only) ----------

// Read at call time (not module load) so tests can point
// POSTDECK_CLAUDE_BIN at a stub/nonexistent binary after importing this
// module, without ever shelling out to a real `claude` on PATH.
function getClaudeBin() {
  return process.env.POSTDECK_CLAUDE_BIN || 'claude';
}
function getModel() {
  return process.env.POSTDECK_SUGGEST_MODEL || process.env.POSTDECK_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
}
function getMaxBudgetUsd() {
  return process.env.POSTDECK_SUGGEST_BUDGET || process.env.POSTDECK_DRAFT_BUDGET || '0.05';
}

function buildSuggestPrompt({ brand, niche, platforms = [] } = {}) {
  const platformsLine = platforms.length ? platforms.join(', ') : 'any relevant platform';
  return [
    `You help find like-minded creators/accounts for competitive and inspiration research.`,
    `Brand: ${brand || '(unspecified)'}`,
    `Niche/field: ${niche || '(unspecified)'}`,
    `Preferred platforms: ${platformsLine}`,
    ``,
    `Propose 3 to 6 real, currently active creators or accounts in this niche whose`,
    `content style, positioning, or audience is worth studying for inspiration.`,
    `This is a suggest-only research task: nothing is followed, messaged, or`,
    `persisted automatically - a human reviews the list and decides.`,
    ``,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary - an object`,
    `shaped like:`,
    `{"suggestions": [{"name": "...", "handle": "...", "platform": "...", "url": "...", "why_relevant": "..."}]}`,
  ].join('\n');
}

/**
 * Extract a JSON object from a claude CLI --output-format json response.
 * The outer wrapper is CLI metadata; `result` holds the model's raw text,
 * which itself should be the strict JSON we asked for. Same contract as
 * src/draft.js's parseClaudeCliOutput.
 */
function parseClaudeCliOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude CLI did not return valid JSON envelope: ${err.message}`);
  }
  const resultText = typeof outer.result === 'string' ? outer.result : stdout;
  const cleaned = resultText.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let inner;
  try {
    inner = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`claude CLI result was not strict JSON: ${err.message}`);
  }
  return inner;
}

function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      getClaudeBin(),
      ['-p', prompt, '--model', getModel(), '--max-budget-usd', String(getMaxBudgetUsd()), '--output-format', 'json'],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(new Error(stderr || err.message), { cause: err }));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * Suggest 3-6 like-minded creators/accounts in a niche. Suggest-only: never
 * writes to the DB, never follows anyone. Caller persists via
 * createInspiration({ ..., source: 'ai_suggested' }) if they want to keep one.
 * @returns {Promise<{suggestions: object[]}>}
 * @throws {Error & {statusCode?: number}} 503-flagged error if the CLI is unavailable/errors.
 */
async function suggestProfiles({ brand, niche, platforms = [] } = {}) {
  const prompt = buildSuggestPrompt({ brand, niche, platforms });

  let stdout;
  try {
    stdout = await runClaudeCli(prompt);
  } catch (err) {
    const wrapped = new Error(
      `Profile suggestions unavailable: could not run claude CLI (${err.code === 'ENOENT' ? 'not found on PATH' : err.message})`
    );
    wrapped.statusCode = 503;
    throw wrapped;
  }

  let parsed;
  try {
    parsed = parseClaudeCliOutput(stdout);
  } catch (err) {
    const wrapped = new Error(`Profile suggestions unavailable: ${err.message}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }

  const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];
  return { suggestions };
}

export {
  listInspiration,
  createInspiration,
  updateInspiration,
  deleteInspiration,
  suggestProfiles,
  buildSuggestPrompt,
  parseClaudeCliOutput,
};
