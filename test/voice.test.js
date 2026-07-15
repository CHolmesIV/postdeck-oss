// Unit tests for src/voice.js (B12 — SPEC.md "Settings & personalization").
// In-memory DB via POSTDECK_DB_PATH=':memory:'. No CLI/model calls involved —
// this module is pure DB read/write + merge logic.
//
// Run with: node --test test/voice.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';

const { getDb, nowIso } = await import('../src/db.js');
const {
  getGlobalVoice,
  setGlobalVoice,
  getGlobalHardRules,
  setGlobalHardRules,
  mergeHardRules,
  resolveVoice,
  withGlobalVoice,
  seedGlobalVoiceIfMissing,
  GLOBAL_HARD_RULES_DEFAULT,
} = await import('../src/voice.js');

function seedBrand(db, label) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(`Voice Test ${label}`, `voice-${label}-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedTone(db, brand_id, { name = 'business', voice_rules = '', hard_rules = {} } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(brand_id, name, voice_rules, JSON.stringify(hard_rules), now, now);
  return info.lastInsertRowid;
}

test('getGlobalVoice defaults to empty string when unset', () => {
  const db = getDb();
  assert.equal(getGlobalVoice(db), '');
});

test('getGlobalHardRules defaults to { no_em_dash: true } when unset', () => {
  const db = getDb();
  assert.deepEqual(getGlobalHardRules(db), { no_em_dash: true });
  assert.deepEqual(GLOBAL_HARD_RULES_DEFAULT, { no_em_dash: true });
});

test('setGlobalVoice/getGlobalVoice round-trip', () => {
  const db = getDb();
  setGlobalVoice(db, 'Direct, no fluff. No trading disclaimers.');
  assert.equal(getGlobalVoice(db), 'Direct, no fluff. No trading disclaimers.');
  setGlobalVoice(db, ''); // reset for other tests
});

test('setGlobalHardRules/getGlobalHardRules round-trip', () => {
  const db = getDb();
  setGlobalHardRules(db, { no_em_dash: true, banned_words: ['synergy'] });
  const got = getGlobalHardRules(db);
  assert.equal(got.no_em_dash, true);
  assert.deepEqual(got.banned_words, ['synergy']);
  setGlobalHardRules(db, { no_em_dash: true }); // reset
});

test('setGlobalHardRules accepts a JSON string (API sends a string) without exploding it', () => {
  const db = getDb();
  // Regression: a raw JSON string must be parsed, not spread char-by-char.
  setGlobalHardRules(db, '{"no_em_dash":true,"banned_words":["synergy"]}');
  const got = getGlobalHardRules(db);
  assert.equal(got.no_em_dash, true);
  assert.deepEqual(got.banned_words, ['synergy']);
  assert.equal(got['0'], undefined); // no character-indexed keys
  setGlobalHardRules(db, { no_em_dash: true }); // reset
});

test('mergeHardRules: no_em_dash true whenever either side has it', () => {
  assert.equal(mergeHardRules({ no_em_dash: true }, {}).no_em_dash, true);
  assert.equal(mergeHardRules({ no_em_dash: false }, { no_em_dash: true }).no_em_dash, true);
  assert.equal(mergeHardRules({}, { no_em_dash: true }).no_em_dash, true);
  assert.equal(mergeHardRules({ no_em_dash: false }, {}).no_em_dash, false);
});

test('mergeHardRules: arrays concatenate and dedupe', () => {
  const merged = mergeHardRules(
    { no_emoji_platforms: ['linkedin'], banned_words: ['synergy', 'circle back'] },
    { no_emoji_platforms: ['linkedin', 'twitter'], banned_words: ['synergy'] }
  );
  assert.deepEqual(merged.no_emoji_platforms.sort(), ['linkedin', 'twitter']);
  assert.deepEqual(merged.banned_words.sort(), ['circle back', 'synergy']);
});

test('mergeHardRules: defaults present even when both sides are empty', () => {
  const merged = mergeHardRules({}, {});
  assert.equal(merged.no_em_dash, false); // no default injected by mergeHardRules itself
  assert.deepEqual(merged.no_emoji_platforms, []);
  assert.deepEqual(merged.banned_words, []);
});

test('resolveVoice: merges global voice + tone voice_rules', () => {
  const db = getDb();
  setGlobalVoice(db, 'This is me: direct, no fluff.');
  const brandId = seedBrand(db, 'resolve-voice');
  seedTone(db, brandId, { name: 'business', voice_rules: 'Keep it formal for LinkedIn.' });

  const { voice } = resolveVoice(db, { brand_id: brandId, tone: 'business' });
  assert.match(voice, /This is me: direct, no fluff\./);
  assert.match(voice, /Keep it formal for LinkedIn\./);

  setGlobalVoice(db, ''); // reset
});

test('resolveVoice: no_em_dash present even when tone hard_rules is {}', () => {
  const db = getDb();
  setGlobalHardRules(db, { no_em_dash: true });
  const brandId = seedBrand(db, 'resolve-hardrules-empty');
  seedTone(db, brandId, { name: 'casual', voice_rules: '', hard_rules: {} });

  const { hardRules } = resolveVoice(db, { brand_id: brandId, tone: 'casual' });
  assert.equal(hardRules.no_em_dash, true);
});

test('resolveVoice: banned_words/no_emoji_platforms concat + dedupe across global and tone', () => {
  const db = getDb();
  setGlobalHardRules(db, { no_em_dash: true, no_emoji_platforms: ['linkedin'], banned_words: ['synergy'] });
  const brandId = seedBrand(db, 'resolve-hardrules-merge');
  seedTone(db, brandId, {
    name: 'personal',
    hard_rules: { no_emoji_platforms: ['linkedin', 'twitter'], banned_words: ['synergy', 'leverage'] },
  });

  const { hardRules } = resolveVoice(db, { brand_id: brandId, tone: 'personal' });
  assert.deepEqual(hardRules.no_emoji_platforms.sort(), ['linkedin', 'twitter']);
  assert.deepEqual(hardRules.banned_words.sort(), ['leverage', 'synergy']);

  setGlobalHardRules(db, { no_em_dash: true }); // reset
});

test('resolveVoice: tolerates missing tone profile, falls back to global-only', () => {
  const db = getDb();
  setGlobalVoice(db, 'Global fallback voice.');
  const brandId = seedBrand(db, 'resolve-missing-tone');
  // No tone_profiles row inserted for this brand/tone combo.
  const { voice, hardRules } = resolveVoice(db, { brand_id: brandId, tone: 'nonexistent' });
  assert.equal(voice, 'Global fallback voice.');
  assert.equal(hardRules.no_em_dash, true);

  setGlobalVoice(db, ''); // reset
});

test('resolveVoice: tolerates null brand_id/tone entirely (global-only defaults)', () => {
  const db = getDb();
  setGlobalVoice(db, '');
  setGlobalHardRules(db, {});
  const { voice, hardRules } = resolveVoice(db, {});
  assert.equal(voice, '');
  assert.equal(hardRules.no_em_dash, true); // default still applies

  setGlobalHardRules(db, { no_em_dash: true }); // reset
});

test('withGlobalVoice: builds a toneProfile-shaped object with merged voice_rules/hard_rules', () => {
  const db = getDb();
  setGlobalVoice(db, 'CB voice.');
  setGlobalHardRules(db, { no_em_dash: true });
  const brandId = seedBrand(db, 'with-global-voice');
  const toneId = seedTone(db, brandId, { name: 'business', voice_rules: 'Formal for gov clients.', hard_rules: { banned_words: ['circle back'] } });
  const toneProfile = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(toneId);

  const effective = withGlobalVoice(db, { brand_id: brandId, toneProfile });
  assert.match(effective.voice_rules, /CB voice\./);
  assert.match(effective.voice_rules, /Formal for gov clients\./);
  const parsedRules = JSON.parse(effective.hard_rules);
  assert.equal(parsedRules.no_em_dash, true);
  assert.deepEqual(parsedRules.banned_words, ['circle back']);
  // Original id/name preserved so callers (draft.js prompts) still see them.
  assert.equal(effective.id, toneId);
  assert.equal(effective.name, 'business');

  setGlobalVoice(db, '');
  setGlobalHardRules(db, { no_em_dash: true });
});

test('withGlobalVoice: works with a null toneProfile (global-only)', () => {
  const db = getDb();
  setGlobalVoice(db, 'Global only.');
  const effective = withGlobalVoice(db, { brand_id: null, toneProfile: null });
  assert.equal(effective.voice_rules, 'Global only.');
  const parsedRules = JSON.parse(effective.hard_rules);
  assert.equal(parsedRules.no_em_dash, true);

  setGlobalVoice(db, '');
});

test('seedGlobalVoiceIfMissing: seeds from a reference file exactly once, never overwrites', () => {
  const db = getDb();
  // Clear any prior seed so this test starts from "unset".
  db.prepare("DELETE FROM settings WHERE key IN ('global_voice', 'global_hard_rules')").run();

  const refPath = writeTempVoiceRef('CB Holmes voice reference: direct, operator tone.');
  seedGlobalVoiceIfMissing(db, { voiceRefPath: refPath });
  assert.equal(getGlobalVoice(db), 'CB Holmes voice reference: direct, operator tone.');
  assert.deepEqual(getGlobalHardRules(db), { no_em_dash: true });

  // Second call must NOT overwrite an edited value.
  setGlobalVoice(db, 'CB edited this by hand.');
  seedGlobalVoiceIfMissing(db, { voiceRefPath: refPath });
  assert.equal(getGlobalVoice(db), 'CB edited this by hand.');

  setGlobalVoice(db, ''); // reset
});

test('seedGlobalVoiceIfMissing: leaves global_voice empty when the reference file is absent', () => {
  const db = getDb();
  db.prepare("DELETE FROM settings WHERE key IN ('global_voice', 'global_hard_rules')").run();

  seedGlobalVoiceIfMissing(db, { voiceRefPath: '/nonexistent/path/does-not-exist.md' });
  assert.equal(getGlobalVoice(db), '');
  assert.deepEqual(getGlobalHardRules(db), { no_em_dash: true });
});

// ---- helpers ----
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function writeTempVoiceRef(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-voice-ref-'));
  const p = path.join(dir, 'charles-voice-reference.md');
  fs.writeFileSync(p, contents);
  return p;
}
