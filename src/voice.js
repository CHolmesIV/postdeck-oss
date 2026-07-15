// Voice/rules resolver (B12 - SPEC.md "Settings & personalization").
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

function setGlobalVoice(db = getDb(), voice = '') {
  setRawSetting(db, 'global_voice', JSON.stringify(voice || ''));
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
  // string) or an already-parsed object. Normalize before merging - spreading a
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

function dedupeArray(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

/**
 * Union-merge global hard_rules with a tone's hard_rules. Booleans OR'd,
 * arrays concatenated + deduped. no_em_dash defaults ON and stays truthy
 * whenever either side sets it - this is CB's flagship global rule and must
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
 * Tolerates a missing/unfound tone profile - falls back to global-only.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{brand_id?: number|null, tone?: string|null}} params
 * @returns {{voice: string, hardRules: object}}
 */
function resolveVoice(db = getDb(), { brand_id = null, tone = null } = {}) {
  const globalVoice = getGlobalVoice(db);
  const globalHardRules = getGlobalHardRules(db);

  let toneProfile = null;
  if (brand_id != null && tone) {
    toneProfile = db.prepare('SELECT * FROM tone_profiles WHERE brand_id = ? AND name = ?').get(brand_id, tone) || null;
  }

  const toneVoice = toneProfile?.voice_rules || '';
  const voice = [globalVoice, toneVoice].filter(Boolean).join('\n\n');

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
 * which consumes hard_rules) always see the merged, global-inclusive set -
 * without changing draft.js/copy_assist.js's function signatures.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{brand_id?: number|null, toneProfile?: object|null}} params
 * @returns {object} a toneProfile-shaped object safe to pass to draftWithAi/copyAssist
 */
function withGlobalVoice(db, { brand_id = null, toneProfile = null } = {}) {
  const globalVoice = getGlobalVoice(db);
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
  const voice = [globalVoice, toneProfile?.voice_rules || ''].filter(Boolean).join('\n\n');

  return {
    ...(toneProfile || { id: null, brand_id, name: toneProfile?.name || null }),
    voice_rules: voice,
    hard_rules: JSON.stringify(hardRules),
  };
}

/**
 * Idempotent first-run seed: if global_voice is unset, seed it from
 * docs/charles-voice-reference.md (capped ~4000 chars) if that file exists,
 * else leave it empty. NEVER overwrites an existing global_voice. Also
 * defaults global_hard_rules to { no_em_dash: true } if unset. Guarded
 * against missing fs access / missing file so it never breaks tests/boot.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{voiceRefPath?: string}} [opts] override the reference doc path (tests)
 */
function seedGlobalVoiceIfMissing(db = getDb(), opts = {}) {
  const existingVoice = getRawSetting(db, 'global_voice');
  if (existingVoice === undefined || existingVoice === null) {
    let seeded = '';
    try {
      // Guarded: a missing file (or any fs error) never throws - seeding is
      // best-effort and must never break server boot or tests.
      const here = path.dirname(fileURLToPath(import.meta.url));
      const refPath = opts.voiceRefPath || path.resolve(here, '..', 'docs', 'charles-voice-reference.md');
      if (fs.existsSync(refPath)) {
        const contents = fs.readFileSync(refPath, 'utf8');
        seeded = contents.slice(0, 4000);
      }
    } catch {
      seeded = '';
    }
    setGlobalVoice(db, seeded);
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
  GLOBAL_HARD_RULES_DEFAULT,
};
