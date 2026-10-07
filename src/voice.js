// Voice/rules resolver (B12 — SPEC.md "Settings & personalization").
// Inheritance model: one global voice ("CB") + global hard rules, inherited
// by every brand; per-brand tone_profiles hold only light tweaks on top.
// resolveVoice() is the single source consumed by draft.js/copy_assist.js/
// redistribute.js/agent.js so global voice + global hard rules are always
// applied, regardless of which tone (if any) is in play.
//
// Settings are read/written directly on the `settings` key/value table
// (mirrors src/settings.js's getSetting/setSetting shape) rather than going
// through settings.js's getAllSettings/updateSettings, which enforce a fixed
// DEFAULTS whitelist that this module doesn't need to extend.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db.js';

const GLOBAL_HARD_RULES_DEFAULT = Object.freeze({ no_em_dash: true });

function getRawSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : undefined;
}

function setRawSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = @value`
  ).run({ key, value });
}

/** The global voice string ("this is me"). Default '' if unset. */
function getGlobalVoice(db = getDb()) {
  const raw = getRawSetting(db, 'global_voice');
  if (raw === undefined || raw === null) return '';
  // Stored as a JSON string (mirrors settings.js's JSON.stringify convention)
  // but tolerate a bare string too, in case it was ever written raw.
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'string' ? parsed : String(parsed ?? '');
  } catch {
    return raw;
  }
}

/**
 * CB's rule: no em or en dashes anywhere near generated copy. Models imitate
 * the voice text they're given, so every voice source is normalized before
 * it is stored or put in a prompt. A rule that names the character, like
 * "No em dashes (—)", keeps its meaning as "(the long dash)".
 */
function normalizeDashes(text) {
  return String(text ?? '')
    .replace(/\(\s*[\u2014\u2013]\s*\)/g, '(the long dash)')
    .replace(/(\d)\s*\u2013\s*(\d)/g, '$1-$2')
    .replace(/[ \t]*[\u2014\u2013][ \t]*/g, ' - ');
}

function setGlobalVoice(db = getDb(), voice = '') {
  setRawSetting(db, 'global_voice', JSON.stringify(normalizeDashes(voice || '')));
}

/** Parsed global_hard_rules JSON. Default { no_em_dash: true } if unset. */
function getGlobalHardRules(db = getDb()) {
  const raw = getRawSetting(db, 'global_hard_rules');
  if (raw === undefined || raw === null) return { ...GLOBAL_HARD_RULES_DEFAULT };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return { ...GLOBAL_HARD_RULES_DEFAULT };
  } catch {
    return { ...GLOBAL_HARD_RULES_DEFAULT };
  }
}

function setGlobalHardRules(db = getDb(), rules = {}) {
  // The API layer may hand us a JSON string (the settings PATCH sends it as a
  // string) or an already-parsed object. Normalize before merging — spreading a
  // raw string would explode it into character-indexed keys.
  let obj = rules;
  if (typeof rules === 'string') {
    try {
      obj = JSON.parse(rules);
    } catch {
      obj = {};
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  const merged = { ...GLOBAL_HARD_RULES_DEFAULT, ...obj };
  setRawSetting(db, 'global_hard_rules', JSON.stringify(merged));
}

const BRAND_DOC_CAP = 4000;
const brandDocCache = new Map(); // abs path -> { mtimeMs, size, text }

// The folder holding every business project (Social Media, Website Projects,
// PrimeWright...). POSTDECK_PROJECTS_ROOT overrides (tests).
function projectsRoot() {
  if (process.env.POSTDECK_PROJECTS_ROOT) return path.resolve(process.env.POSTDECK_PROJECTS_ROOT);
  return path.resolve(socialRoot(), '..');
}

function socialRoot() {
  if (process.env.POSTDECK_SOCIAL_ROOT) return process.env.POSTDECK_SOCIAL_ROOT;
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
}

/** Seed placeholders ("Voice reference for X ... Placeholder ...") are not real rules. */
function isPlaceholderVoiceRules(text) {
  const t = String(text || '').trim();
  return t.startsWith('Voice reference for') && /placeholder/i.test(t);
}

function cleanToneVoice(text) {
  return isPlaceholderVoiceRules(text) ? '' : String(text || '').trim();
}

/**
 * Read a brand's voice doc (brands.voice_doc_path; absolute, or relative to the
 * Social Media project root). Capped at ~4000 chars, mtime-cached. Missing or
 * unreadable file = '' (silent). Skips the doc when it is the same file that
 * seeds the global voice, so CB's card is not injected twice.
 */
function readBrandVoiceDoc(db, brand_id) {
  if (brand_id == null) return '';
  try {
    const row = db.prepare('SELECT voice_doc_path FROM brands WHERE id = ?').get(brand_id);
    const p = String(row?.voice_doc_path || '').trim();
    if (!p) return '';
    const abs = path.isAbsolute(p) ? p : path.resolve(socialRoot(), p);
    const globalRefs = voiceRefCandidates().map((c) => path.resolve(c));
    if (globalRefs.includes(path.resolve(abs))) return '';
    const st = fs.statSync(abs);
    if (!st.isFile()) return '';
    const hit = brandDocCache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text;
    const text = fs.readFileSync(abs, 'utf8').trim().slice(0, BRAND_DOC_CAP);
    brandDocCache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, text });
    return text;
  } catch {
    return '';
  }
}

/**
 * The brand voice doc as the Settings editor sees it: full text (not the
 * prompt cap), where it lives, and whether it is the global voice card (that
 * one is edited as the global voice, in Settings > AI).
 */
function brandVoiceDocInfo(db, brand_id) {
  const row = db.prepare('SELECT id, slug, voice_doc_path FROM brands WHERE id = ?').get(brand_id);
  if (!row) return null;
  const rel = String(row.voice_doc_path || '').trim();
  const abs = rel ? (path.isAbsolute(rel) ? rel : path.resolve(socialRoot(), rel)) : '';
  const isGlobal = !!abs && voiceRefCandidates().map((c) => path.resolve(c)).includes(path.resolve(abs));
  let text = '';
  let exists = false;
  try {
    if (abs && fs.statSync(abs).isFile()) {
      exists = true;
      text = fs.readFileSync(abs, 'utf8');
    }
  } catch {
    exists = false;
  }
  return { brand_id: row.id, path: rel, exists, is_global_voice: isGlobal, text, prompt_cap: BRAND_DOC_CAP };
}

/**
 * Save pasted brand voice text to the brand's voice doc. A brand with no doc
 * gets `brands/<slug>/voice.md` under the Social Media folder. Writes are
 * confined to .md files inside that folder. Dashes are normalized.
 * @throws {Error} with .code 'not_found' | 'global_voice' | 'bad_path'
 */
function writeBrandVoiceDoc(db, brand_id, text) {
  const row = db.prepare('SELECT id, slug, voice_doc_path FROM brands WHERE id = ?').get(brand_id);
  const fail = (code, message) => Object.assign(new Error(message), { code });
  if (!row) throw fail('not_found', 'Brand not found.');
  let rel = String(row.voice_doc_path || '').trim();
  if (!rel) rel = path.join('brands', row.slug || `brand-${row.id}`, 'voice.md');
  const root = path.resolve(socialRoot());
  const abs = path.resolve(path.isAbsolute(rel) ? rel : path.join(root, rel));
  if (voiceRefCandidates().map((c) => path.resolve(c)).includes(abs)) {
    throw fail('global_voice', 'This brand uses your global voice. Edit it in Settings > AI.');
  }
  // Brand voices live with each brand's website branding docs
  // (Website Projects/<Site>/..., PrimeWright/brand-package/...), so writes
  // are allowed anywhere under the Projects folder, .md files only.
  const projects = projectsRoot();
  const inside = (dir) => abs.startsWith(dir + path.sep);
  if (!(inside(root) || inside(projects)) || path.extname(abs).toLowerCase() !== '.md') {
    throw fail('bad_path', 'Brand voice docs must be .md files inside your Projects folder.');
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, normalizeDashes(text).replace(/\s+$/, '') + '\n', 'utf8');
  if (!row.voice_doc_path) {
    db.prepare('UPDATE brands SET voice_doc_path = ?, updated_at = ? WHERE id = ?').run(path.relative(root, abs), new Date().toISOString(), row.id);
  }
  brandDocCache.delete(abs);
  return brandVoiceDocInfo(db, brand_id);
}

function composeVoice(db, brand_id, toneVoiceRules) {
  const doc = readBrandVoiceDoc(db, brand_id);
  const voice = [getGlobalVoice(db), doc ? `Brand voice guide:\n${doc}` : '', cleanToneVoice(toneVoiceRules)]
    .filter(Boolean)
    .join('\n\n');
  return normalizeDashes(voice);
}

function dedupeArray(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

/**
 * Union-merge global hard_rules with a tone's hard_rules. Booleans OR'd,
 * arrays concatenated + deduped. no_em_dash defaults ON and stays truthy
 * whenever either side sets it — this is CB's flagship global rule and must
 * never be silently dropped by an empty/missing tone override.
 */
function mergeHardRules(globalRules = {}, toneRules = {}) {
  const g = globalRules || {};
  const t = toneRules || {};
  const out = { ...g, ...t };

  out.no_em_dash = Boolean(g.no_em_dash) || Boolean(t.no_em_dash);

  out.no_emoji_platforms = dedupeArray([...(g.no_emoji_platforms || []), ...(t.no_emoji_platforms || [])]);
  out.banned_words = dedupeArray([...(g.banned_words || []), ...(t.banned_words || [])]);

  return out;
}

/**
 * Resolve the effective voice + hard_rules for a (brand_id, tone) pair.
 * `voice` = global voice + tone's voice_rules (both optional, joined with a
 * blank line). `hardRules` = global hard rules merged with the tone's.
 * Tolerates a missing/unfound tone profile — falls back to global-only.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{brand_id?: number|null, tone?: string|null}} params
 * @returns {{voice: string, hardRules: object}}
 */
function resolveVoice(db = getDb(), { brand_id = null, tone = null } = {}) {
  const globalHardRules = getGlobalHardRules(db);

  let toneProfile = null;
  if (brand_id != null && tone) {
    toneProfile = db.prepare('SELECT * FROM tone_profiles WHERE brand_id = ? AND name = ?').get(brand_id, tone) || null;
  }

  const voice = composeVoice(db, brand_id, toneProfile?.voice_rules);

  let toneHardRules = {};
  if (toneProfile?.hard_rules) {
    try {
      toneHardRules = JSON.parse(toneProfile.hard_rules);
    } catch {
      toneHardRules = {};
    }
  }

  const hardRules = mergeHardRules(globalHardRules, toneHardRules);
  return { voice, hardRules };
}

/**
 * Build an effective tone-profile-shaped object for a given toneProfile row
 * (or null) by merging in the global voice/hard rules. Used at every
 * generation call site so draftWithAi/copyAssist's existing
 * `toneProfile.voice_rules` / `toneProfile.hard_rules` reads (and scrub.js,
 * which consumes hard_rules) always see the merged, global-inclusive set —
 * without changing draft.js/copy_assist.js's function signatures.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{brand_id?: number|null, toneProfile?: object|null}} params
 * @returns {object} a toneProfile-shaped object safe to pass to draftWithAi/copyAssist
 */
function withGlobalVoice(db, { brand_id = null, toneProfile = null } = {}) {
  const globalHardRules = getGlobalHardRules(db);

  let toneHardRules = {};
  if (toneProfile?.hard_rules) {
    try {
      toneHardRules = JSON.parse(toneProfile.hard_rules);
    } catch {
      toneHardRules = {};
    }
  }
  const hardRules = mergeHardRules(globalHardRules, toneHardRules);
  const voice = composeVoice(db, brand_id ?? toneProfile?.brand_id ?? null, toneProfile?.voice_rules);

  return {
    ...(toneProfile || { id: null, brand_id, name: toneProfile?.name || null }),
    voice_rules: voice,
    hard_rules: JSON.stringify(hardRules),
  };
}

/**
 * Marks global_voice as deliberately set by the operator (Settings > Save
 * voice), so an intentionally cleared voice is never re-seeded.
 */
function markGlobalVoiceUserSet(db = getDb()) {
  setRawSetting(db, 'global_voice_user_set', 'true');
}

/**
 * Candidate locations for the voice reference doc. It lives in the Social
 * Media project's docs/ (one level above the repo); repo-local docs/ is kept
 * as a fallback. POSTDECK_VOICE_REF overrides both.
 */
function voiceRefCandidates() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [
    process.env.POSTDECK_VOICE_REF,
    path.resolve(here, '..', '..', 'docs', 'charles-voice-reference.md'),
    path.resolve(here, '..', 'docs', 'charles-voice-reference.md'),
  ].filter(Boolean);
}

/**
 * Idempotent seed: if global_voice is unset, or empty and never saved by the
 * operator, seed it from charles-voice-reference.md (capped ~4000 chars).
 * NEVER overwrites a non-empty or operator-saved global_voice. When no
 * reference file is found, global_voice is left untouched so a later boot
 * can still seed it (writing '' here used to block seeding forever). Also
 * defaults global_hard_rules to { no_em_dash: true } if unset. Guarded
 * against missing fs access / missing file so it never breaks tests/boot.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{voiceRefPath?: string}} [opts] override the reference doc path (tests)
 */
function seedGlobalVoiceIfMissing(db = getDb(), opts = {}) {
  const existingVoice = getRawSetting(db, 'global_voice');
  const unset = existingVoice === undefined || existingVoice === null;
  const emptyAndUnsaved =
    !unset && !getGlobalVoice(db).trim() && getRawSetting(db, 'global_voice_user_set') !== 'true';
  if (unset || emptyAndUnsaved) {
    let seeded = '';
    try {
      // Guarded: a missing file (or any fs error) never throws — seeding is
      // best-effort and must never break server boot or tests.
      const candidates = opts.voiceRefPath ? [opts.voiceRefPath] : voiceRefCandidates();
      const refPath = candidates.find((p) => fs.existsSync(p));
      if (refPath) seeded = normalizeDashes(fs.readFileSync(refPath, 'utf8')).slice(0, 4000);
    } catch {
      seeded = '';
    }
    if (seeded.trim()) setGlobalVoice(db, seeded);
  }

  const existingRules = getRawSetting(db, 'global_hard_rules');
  if (existingRules === undefined || existingRules === null) {
    setGlobalHardRules(db, { ...GLOBAL_HARD_RULES_DEFAULT });
  }
}

export {
  getRawSetting,
  setRawSetting,
  getGlobalVoice,
  setGlobalVoice,
  getGlobalHardRules,
  setGlobalHardRules,
  mergeHardRules,
  resolveVoice,
  withGlobalVoice,
  seedGlobalVoiceIfMissing,
  readBrandVoiceDoc,
  brandVoiceDocInfo,
  writeBrandVoiceDoc,
  normalizeDashes,
  isPlaceholderVoiceRules,
  markGlobalVoiceUserSet,
  GLOBAL_HARD_RULES_DEFAULT,
};
