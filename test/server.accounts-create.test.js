// Integration test (Fastify .inject) for POST /api/accounts — the route that
// lets a brand seeded without a Blotato connection (PrimeWright, Lunula,
// IVision) get a platform to draft for. Defaults to manual=1 (assisted copy &
// paste) with no blotato_account_id. Mirrors the isolation style of
// test/server.b11.test.js (in-memory DB, worker/sync disabled).
//
// Run with: node --test test/server.accounts-create.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedBrand(db, name = 'Acct Test Brand') {
  const now = nowIso();
  return db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(name, `acct-${Math.random()}`, now, now).lastInsertRowid;
}

test('POST /api/accounts creates a manual copy-&-paste account by default', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: { brand_id: brandId, platform: 'LinkedIn' } });
  assert.equal(res.statusCode, 201);
  const acct = res.json();
  assert.equal(acct.brand_id, brandId);
  assert.equal(acct.platform, 'linkedin'); // normalized lower-case
  assert.equal(acct.blotato_account_id, null);
  assert.equal(acct.manual, 1);
  assert.equal(acct.active, 1);
  assert.deepEqual(acct.target_fields, {});
});

test('POST /api/accounts rejects missing brand_id/platform with 400', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: { brand_id: brandId } });
  assert.equal(res.statusCode, 400);
});

test('POST /api/accounts 404s for an unknown brand', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'POST', url: '/api/accounts', payload: { brand_id: 999999, platform: 'twitter' } });
  assert.equal(res.statusCode, 404);
});

test('POST /api/accounts is idempotent-guarded: dupe platform for a brand 409s', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const first = await app.inject({ method: 'POST', url: '/api/accounts', payload: { brand_id: brandId, platform: 'reddit' } });
  assert.equal(first.statusCode, 201);
  const dupe = await app.inject({ method: 'POST', url: '/api/accounts', payload: { brand_id: brandId, platform: 'reddit' } });
  assert.equal(dupe.statusCode, 409);
  assert.equal(dupe.json().error, 'account_exists');
  assert.equal(dupe.json().id, first.json().id);
});

test('POST /api/accounts honors an explicit live (manual=0) account', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const res = await app.inject({
    method: 'POST',
    url: '/api/accounts',
    payload: { brand_id: brandId, platform: 'facebook', manual: 0, blotato_account_id: '12345', target_fields: { pageId: '987' } },
  });
  assert.equal(res.statusCode, 201);
  const acct = res.json();
  assert.equal(acct.manual, 0);
  assert.equal(acct.blotato_account_id, '12345');
  assert.deepEqual(acct.target_fields, { pageId: '987' });
});

test('DELETE /api/accounts/:id removes an account', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const created = (await app.inject({ method: 'POST', url: '/api/accounts', payload: { brand_id: brandId, platform: 'twitter' } })).json();
  const del = await app.inject({ method: 'DELETE', url: `/api/accounts/${created.id}` });
  assert.equal(del.statusCode, 200);
  assert.equal(del.json().ok, true);
  const list = (await app.inject({ method: 'GET', url: '/api/accounts' })).json();
  assert.equal(list.find((a) => a.id === created.id), undefined);
});

test('DELETE /api/accounts/:id 404s for an unknown id', async () => {
  const app = buildServer();
  const del = await app.inject({ method: 'DELETE', url: '/api/accounts/999999' });
  assert.equal(del.statusCode, 404);
});
