// Brand profiles (B13 - SPEC.md "Brand profiles (source of truth + generate)").
// Canonical store of each brand's per-platform profile fields (heading,
// subheading, bio, platform-standard fields) so CB knows which profiles are
// stale and need updating. generateProfile() drafts each field in his voice
// for copy-paste - nothing here auto-posts; a human always copies the field
// into the actual platform. Same `claude -p` shell as draft.js/copy_assist.js
// (lazy env overrides, --output-format json envelope, 60s timeout, 503-flagged
// error contract) and the same mechanical scrub.js pass on every returned
// string.

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getDb, nowIso } from './db.js';
import { scrubText } from './scrub.js';
import { resolveVoice } from './voice.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPECS_PATH = path.join(ROOT, 'config', 'profile-specs.json');

// Tolerate a few natural shorthand keys the UI/agent might send in addition
// to the exact config/profile-specs.json keys.
const PLATFORM_ALIASES = {
  linkedin: 'linkedin_company',
  linkedin_company: 'linkedin_company',
  linkedin_personal: 'linkedin_personal',
  facebook: 'facebook_page',
  facebook_page: 'facebook_page',
  reddit: 'reddit',
};

/**
 * Load config/profile-specs.json and resolve a platform key (tolerating the
 * aliases above) to its field spec. Returns null if the platform has no spec.
 */
function loadProfileSpec(platform) {
  const raw = fs.readFileSync(SPECS_PATH, 'utf8');
  const specs = JSON.parse(raw);
  const key = PLATFORM_ALIASES[platform] || platform;
  return specs[key] || null;
}

function parseFields(row) {
  if (!row) return row;
  const out = { ...row };
  try {
    out.fields = JSON.parse(out.fields || '{}');
  } catch {
    out.fields = {};
  }
  return out;
}

/** @param {{brand_id?: number}} [params] */
function listProfiles(db = getDb(), { brand_id } = {}) {
  const clauses = [];
  const params = [];
  let sql = 'SELECT * FROM profiles WHERE 1=1';
  if (brand_id != null) {
    clauses.push('brand_id = ?');
    params.push(brand_id);
  }
  if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
  sql += ' ORDER BY brand_id, platform';
  return db.prepare(sql).all(...params).map(parseFields);
}

/** @param {{brand_id: number, platform: string}} params */
function getProfile(db = getDb(), { brand_id, platform } = {}) {
  const row = db.prepare('SELECT * FROM profiles WHERE brand_id = ? AND platform = ?').get(brand_id, platform);
  return parseFields(row);
}

function getProfileById(db, id) {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  return parseFields(row);
}

/**
 * Insert or update a profile row on the (brand_id, platform) unique key.
 * @param {{brand_id: number, platform: string, fields?: object, status?: string}} params
 */
function upsertProfile(db = getDb(), { brand_id, platform, fields = {}, status = 'draft' } = {}) {
  const now = nowIso();
  const fieldsJson = JSON.stringify(fields || {});
  db.prepare(
    `
    INSERT INTO profiles (brand_id, platform, fields, status, created_at, updated_at)
    VALUES (@brand_id, @platform, @fields, @status, @now, @now)
    ON CONFLICT(brand_id, platform) DO UPDATE SET
      fields = excluded.fields,
      status = excluded.status,
      updated_at = excluded.updated_at
  `
  ).run({ brand_id, platform, fields: fieldsJson, status, now });
  return getProfile(db, { brand_id, platform });
}

function setStatus(db = getDb(), id, status) {
  const now = nowIso();
  db.prepare('UPDATE profiles SET status = @status, updated_at = @now WHERE id = @id').run({ status, now, id });
  return getProfileById(db, id);
}

function markReviewed(db = getDb(), id) {
  const now = nowIso();
  db.prepare(
    "UPDATE profiles SET status = 'current', last_reviewed_at = @now, updated_at = @now WHERE id = @id"
  ).run({ now, id });
  return getProfileById(db, id);
}

function markStale(db = getDb(), id) {
  return setStatus(db, id, 'stale');
}

// ---------- claude CLI shell (mirrors copy_assist.js's lazy-env pattern) ----------

function claudeBin() {
  return process.env.POSTDECK_CLAUDE_BIN || 'claude';
}
function draftModel() {
  return process.env.POSTDECK_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
}
function maxBudgetUsd() {
  return process.env.POSTDECK_DRAFT_BUDGET || '0.05';
}

function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      ['-p', prompt, '--model', draftModel(), '--max-budget-usd', String(maxBudgetUsd()), '--output-format', 'json'],
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

/** Same envelope shape as draft.js/copy_assist.js's parseClaudeCliOutput. */
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

function buildGeneratePrompt({ brand, spec, voice, hardRules }) {
  const fieldLines = spec.fields
    .map((f) => {
      const limit = f.char_limit ? `max ${f.char_limit} characters` : 'no strict character limit';
      const req = f.required ? 'required' : 'optional';
      return `- "${f.key}" (${f.label}): ${limit}, ${req}.`;
    })
    .join('\n');

  return [
    `You are writing platform profile copy for the brand "${brand?.name ?? '(unknown brand)'}".`,
    `Website: ${brand?.name ? '(see brand context)' : '(unknown)'}`,
    ``,
    `Voice (CB's own voice - write in it, first-person-plural or brand voice as natural for this field):`,
    voice || '(no voice guidance provided)',
    ``,
    `Hard rules (must also follow exactly, mechanically re-enforced after your output): ${JSON.stringify(hardRules || {})}`,
    ``,
    `SEO / platform best-practice guidance for this profile type: ${spec.seo_notes || '(none provided)'}`,
    ``,
    `Write copy for each of these fields, respecting its character limit:`,
    fieldLines,
    ``,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary - an object keyed`,
    `exactly by each field's key above (use empty string "" for any optional field you`,
    `have no useful content for; never fabricate specifics you cannot justify):`,
    `{${spec.fields.map((f) => `"${f.key}": "..."`).join(', ')}}`,
  ].join('\n');
}

/**
 * Run scrub.js hard-rules scrubbing over every string value the generated
 * fields object contains.
 */
function scrubFields(raw, hardRules) {
  const out = {};
  for (const [k, v] of Object.entries(raw || {})) {
    out[k] = typeof v === 'string' ? scrubText(v, hardRules).text : v;
  }
  return out;
}

/**
 * Generate (draft) a brand's platform profile fields via a cheap `claude -p`
 * call, grounded in resolveVoice's global+brand voice and the platform's
 * field spec/SEO notes. Scrubs every returned string, then upserts the
 * profile row with status 'draft' and last_generated_at set. Human
 * copy-pastes the fields into the actual platform - nothing here publishes.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{brand_id: number, platform: string}} params
 * @returns {Promise<object>} the saved profile row (fields parsed)
 * @throws {Error & {statusCode?: number}} 503-flagged error if the CLI is unavailable/errors,
 *   or if the platform has no known field spec (400-flagged).
 */
async function generateProfile(db = getDb(), { brand_id, platform } = {}) {
  const brand = brand_id != null ? db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id) : null;
  if (!brand) {
    const err = new Error(`generateProfile: brand ${brand_id} not found`);
    err.statusCode = 404;
    throw err;
  }

  const spec = loadProfileSpec(platform);
  if (!spec) {
    const err = new Error(`generateProfile: no profile field spec for platform "${platform}"`);
    err.statusCode = 400;
    throw err;
  }

  const { voice, hardRules } = resolveVoice(db, { brand_id, tone: 'business' });
  const prompt = buildGeneratePrompt({ brand, spec, voice, hardRules });

  let stdout;
  try {
    stdout = await runClaudeCli(prompt);
  } catch (err) {
    const wrapped = new Error(
      `Profile generation unavailable: could not run claude CLI (${err.code === 'ENOENT' ? 'not found on PATH' : err.message})`
    );
    wrapped.statusCode = 503;
    throw wrapped;
  }

  let raw;
  try {
    raw = parseClaudeCliOutput(stdout);
  } catch (err) {
    const wrapped = new Error(`Profile generation unavailable: ${err.message}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }

  const fields = scrubFields(raw, hardRules);
  const now = nowIso();

  db.prepare(
    `
    INSERT INTO profiles (brand_id, platform, fields, status, last_generated_at, created_at, updated_at)
    VALUES (@brand_id, @platform, @fields, 'draft', @now, @now, @now)
    ON CONFLICT(brand_id, platform) DO UPDATE SET
      fields = excluded.fields,
      status = 'draft',
      last_generated_at = excluded.last_generated_at,
      updated_at = excluded.updated_at
  `
  ).run({ brand_id, platform, fields: JSON.stringify(fields), now });

  return getProfile(db, { brand_id, platform });
}

/**
 * Seed profiles from a profile-seed JSON file (shape: { brand_slug, profiles:
 * [{platform, fields}] }), resolving the brand by slug. Idempotent - each
 * platform profile is upserted with status 'draft'. Returns the count of
 * profile rows written (inserted or updated).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} filePath
 * @returns {number}
 */
function seedProfilesFromFile(db = getDb(), filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const brand = db.prepare('SELECT * FROM brands WHERE slug = ?').get(data.brand_slug);
  if (!brand) return 0;

  let count = 0;
  for (const p of data.profiles || []) {
    upsertProfile(db, { brand_id: brand.id, platform: p.platform, fields: p.fields || {}, status: 'draft' });
    count++;
  }
  return count;
}

export {
  listProfiles,
  getProfile,
  getProfileById,
  upsertProfile,
  setStatus,
  markReviewed,
  markStale,
  generateProfile,
  seedProfilesFromFile,
  loadProfileSpec,
  buildGeneratePrompt,
  parseClaudeCliOutput,
  PLATFORM_ALIASES,
};
