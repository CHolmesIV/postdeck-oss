// Integration test (Fastify .inject, no real listen/port) for the B13 Brand
// profiles backend wiring: GET/PATCH /api/profiles, and the generate 503
// contract. Mirrors test/server.b12.test.js's isolation style (in-memory DB,
// worker/sync disabled).
//
// Run with: node --test test/server.b13.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const imageReqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b13-imgreq-'));
process.env.POSTDECK_IMAGE_REQ_DIR = imageReqDir;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { upsertProfile } = await import('../src/profiles.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'B13 Test Brand', `b13-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

test('GET /api/profiles lists profiles, optionally filtered by brand_id', async () => {
  const app = buildServer();
  const db = getDb();
  const brandA = seedBrand(db, { name: 'Brand A' });
  const brandB = seedBrand(db, { name: 'Brand B' });
  upsertProfile(db, { brand_id: brandA, platform: 'linkedin_company', fields: { name: 'A' } });
  upsertProfile(db, { brand_id: brandB, platform: 'reddit', fields: { display_name: 'B' } });

  const all = await app.inject({ method: 'GET', url: '/api/profiles' });
  assert.equal(all.statusCode, 200);
  assert.equal(all.json().length, 2);

  const filtered = await app.inject({ method: 'GET', url: `/api/profiles?brand_id=${brandA}` });
  assert.equal(filtered.statusCode, 200);
  const filteredBody = filtered.json();
  assert.equal(filteredBody.length, 1);
  assert.equal(filteredBody[0].platform, 'linkedin_company');

  await app.close();
});

test('GET /api/profiles/:brand_id/:platform returns the row, 404 if missing', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  upsertProfile(db, { brand_id: brandId, platform: 'facebook_page', fields: { page_name: 'Acme' }, status: 'draft' });

  const found = await app.inject({ method: 'GET', url: `/api/profiles/${brandId}/facebook_page` });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().fields.page_name, 'Acme');

  const missing = await app.inject({ method: 'GET', url: `/api/profiles/${brandId}/tiktok` });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('PATCH /api/profiles/:id merges field edits and updates status', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const row = upsertProfile(db, {
    brand_id: brandId,
    platform: 'reddit',
    fields: { display_name: 'Acme', bio: 'Original bio.' },
    status: 'draft',
  });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/profiles/${row.id}`,
    payload: { fields: { bio: 'Edited bio.' }, status: 'current' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'current');
  assert.equal(body.fields.bio, 'Edited bio.');
  assert.equal(body.fields.display_name, 'Acme', 'unedited fields should be preserved by the merge');

  const missing = await app.inject({ method: 'PATCH', url: '/api/profiles/999999', payload: { status: 'stale' } });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('POST /api/profiles/generate is 503-safe when the claude CLI is unavailable', async () => {
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary';
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const res = await app.inject({
    method: 'POST',
    url: '/api/profiles/generate',
    payload: { brand_id: brandId, platform: 'linkedin_company' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'ai_unavailable');

  delete process.env.POSTDECK_CLAUDE_BIN;
  await app.close();
});

test('POST /api/profiles/generate 400s when brand_id or platform is missing', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'POST', url: '/api/profiles/generate', payload: { brand_id: 1 } });
  assert.equal(res.statusCode, 400);
  await app.close();
});
