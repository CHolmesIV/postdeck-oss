// Integration tests (Fastify .inject) for B21's POST /api/posts/:id/publish-now.
// Runs with BLOTATO_DRY_RUN=1 so nothing real is posted - the contract under
// test is the gate order and that a REFUSED publish-now leaves the post exactly
// as it was found (no half-approved rows).
// See docs/B21_COMPOSER_FIXES_SPEC.md.
// Run with: node --test test/publish-now.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { setBrandUtmSettings } = await import('../src/utm.js');

function seedBrand(db, slug) {
  const now = nowIso();
  return db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(`PN ${slug}`, `pn-${slug}-${Math.random()}`, now, now).lastInsertRowid;
}

function seedAccount(db, brandId, { platform = 'linkedin', manual = 0 } = {}) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, blotato_account_id, target_fields, active, manual, created_at, updated_at)
       VALUES (?, ?, '12345', '{}', 1, ?, ?, ?)`
    )
    .run(brandId, platform, manual, now, now).lastInsertRowid;
}

function seedPost(db, brandId, overrides = {}) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, first_comment, created_at, updated_at)
       VALUES (@brand_id, @account_id, @platform, @copy, '[]', @platform_fields, @publish_at, @status, @first_comment, @now, @now)`
    )
    .run({
      brand_id: brandId,
      account_id: overrides.account_id ?? null,
      platform: overrides.platform || 'linkedin',
      copy: overrides.copy !== undefined ? overrides.copy : 'publish now copy',
      platform_fields: JSON.stringify(overrides.platform_fields || {}),
      publish_at: overrides.publish_at || null,
      status: overrides.status || 'draft',
      first_comment: overrides.first_comment || null,
      now,
    }).lastInsertRowid;
}

const publishNow = (app, id) => app.inject({ method: 'POST', url: `/api/posts/${id}/publish-now` });

test('a draft with no publish_at publishes and gets a publish_at set', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'happy');
  const acct = seedAccount(db, brand);
  const id = seedPost(db, brand, { account_id: acct });

  const res = await publishNow(app, id);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.ok, true);
  assert.equal(body.dry_run, true);

  const row = db.prepare('SELECT status, publish_at FROM posts WHERE id = ?').get(id);
  assert.ok(['submitted', 'submitted_dry'].includes(row.status), `unexpected status ${row.status}`);
  assert.ok(row.publish_at, 'publish_at should have been set to now');
  await app.close();
});

test('an assisted-manual account is refused and the post is left untouched', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'manual');
  const acct = seedAccount(db, brand, { manual: 1 });
  const id = seedPost(db, brand, { account_id: acct });

  const res = await publishNow(app, id);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'assisted_manual');

  const row = db.prepare('SELECT status, publish_at FROM posts WHERE id = ?').get(id);
  assert.equal(row.status, 'draft');
  assert.equal(row.publish_at, null, 'a refused publish-now must not write publish_at');
  await app.close();
});

test('a published post is refused as wrong_status', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'done');
  const id = seedPost(db, brand, { account_id: seedAccount(db, brand), status: 'published' });

  const res = await publishNow(app, id);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'wrong_status');
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(id).status, 'published');
  await app.close();
});

test('a tiktok draft missing required fields is 422 and stays a draft', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'tiktok');
  const acct = seedAccount(db, brand, { platform: 'tiktok' });
  const id = seedPost(db, brand, { account_id: acct, platform: 'tiktok', platform_fields: {} });

  const res = await publishNow(app, id);
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'tiktok_fields_missing');
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(id).status, 'draft');
  await app.close();
});

test('an unknown id is a 404', async () => {
  const app = buildServer();
  const res = await publishNow(app, 987654);
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
  await app.close();
});

test('UTM is applied once on the draft crossing, and not doubled on a second call', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'utm');
  setBrandUtmSettings(db, brand, { enabled: true });
  const acct = seedAccount(db, brand);
  const id = seedPost(db, brand, { account_id: acct, copy: 'see https://di-hy.com/ai-audit' });

  await publishNow(app, id);
  const afterFirst = db.prepare('SELECT copy FROM posts WHERE id = ?').get(id).copy;
  assert.match(afterFirst, /utm_source=linkedin/);
  assert.equal(afterFirst.match(/utm_source/g).length, 1, 'tagged exactly once');

  // second call is refused (already submitted) so the copy must be unchanged
  const second = await publishNow(app, id);
  assert.equal(second.statusCode, 409);
  assert.equal(db.prepare('SELECT copy FROM posts WHERE id = ?').get(id).copy, afterFirst);
  await app.close();
});
