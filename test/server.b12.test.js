// Integration test (Fastify .inject, no real listen/port) for the B12
// Settings & personalization backend wiring: tone-profile PATCH/reset,
// settings round-trip of global_voice/global_hard_rules, and the
// GET /api/voice/resolve preview endpoint. Mirrors test/server.b8.test.js's
// isolation style (in-memory DB, worker/sync disabled).
//
// Run with: node --test test/server.b12.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const imageReqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b12-imgreq-'));
process.env.POSTDECK_IMAGE_REQ_DIR = imageReqDir;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'B12 Test Brand', `b12-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedTone(db, brand_id, { name = 'business', voice_rules = 'Formal.', hard_rules = {} } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(brand_id, name, voice_rules, JSON.stringify(hard_rules), now, now);
  return info.lastInsertRowid;
}

test('PATCH /api/tone-profiles/:id persists voice_rules and hard_rules', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const toneId = seedTone(db, brandId, { name: 'business', voice_rules: 'Original.', hard_rules: {} });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/tone-profiles/${toneId}`,
    payload: { voice_rules: 'Punchier for LinkedIn.', hard_rules: { banned_words: ['synergy'] } },
  });
  assert.equal(res.statusCode, 200);
  const row = res.json();
  assert.equal(row.voice_rules, 'Punchier for LinkedIn.');
  assert.deepEqual(JSON.parse(row.hard_rules), { banned_words: ['synergy'] });

  const fromDb = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(toneId);
  assert.equal(fromDb.voice_rules, 'Punchier for LinkedIn.');

  await app.close();
});

test('PATCH /api/tone-profiles/:id 404s for a missing tone profile', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'PATCH', url: '/api/tone-profiles/999999', payload: { voice_rules: 'x' } });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /api/tone-profiles/:id/reset clears the brand tweak so it inherits global', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const toneId = seedTone(db, brandId, { name: 'casual', voice_rules: 'Some tweak.', hard_rules: { banned_words: ['leverage'] } });

  const res = await app.inject({ method: 'POST', url: `/api/tone-profiles/${toneId}/reset` });
  assert.equal(res.statusCode, 200);
  const row = res.json();
  assert.equal(row.voice_rules, '');
  assert.deepEqual(JSON.parse(row.hard_rules), {});

  await app.close();
});

test('GET/PATCH /api/settings round-trips global_voice and global_hard_rules', async () => {
  const app = buildServer();

  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: {
      global_voice: 'Direct, no fluff. No trading disclaimers.',
      global_hard_rules: { no_em_dash: true, banned_words: ['circle back'] },
      quiet_start: '23:00',
    },
  });
  assert.equal(patched.statusCode, 200);
  const patchedBody = patched.json();
  assert.equal(patchedBody.global_voice, 'Direct, no fluff. No trading disclaimers.');
  assert.deepEqual(patchedBody.global_hard_rules, { no_em_dash: true, banned_words: ['circle back'] });
  assert.equal(patchedBody.quiet_start, '23:00'); // existing settings keys still work

  const got = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(got.statusCode, 200);
  const gotBody = got.json();
  assert.equal(gotBody.global_voice, 'Direct, no fluff. No trading disclaimers.');
  assert.deepEqual(gotBody.global_hard_rules, { no_em_dash: true, banned_words: ['circle back'] });

  await app.close();
});

test('GET /api/voice/resolve returns the merged { voice, hardRules } shape', async () => {
  const app = buildServer();
  const db = getDb();

  await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { global_voice: 'CB global voice.', global_hard_rules: { no_em_dash: true } },
  });

  const brandId = seedBrand(db);
  seedTone(db, brandId, { name: 'business', voice_rules: 'Formal for gov clients.', hard_rules: { banned_words: ['leverage'] } });

  const res = await app.inject({ method: 'GET', url: `/api/voice/resolve?brand_id=${brandId}&tone=business` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.match(body.voice, /CB global voice\./);
  assert.match(body.voice, /Formal for gov clients\./);
  assert.equal(body.hardRules.no_em_dash, true);
  assert.deepEqual(body.hardRules.banned_words, ['leverage']);

  await app.close();
});

test('GET /api/voice/resolve tolerates no brand_id/tone (global-only defaults)', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/api/voice/resolve' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(typeof body.voice, 'string');
  assert.equal(body.hardRules.no_em_dash, true);
  await app.close();
});
