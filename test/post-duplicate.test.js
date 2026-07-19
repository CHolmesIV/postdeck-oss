// Integration test (Fastify .inject, no real listen/port) for F4's
// POST /api/posts/:id/duplicate — same-brand duplicate, cross-brand copy
// (campaign tag dropped, account resolution), and 404.
// Run with: node --test test/post-duplicate.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedBrand(db, name = 'Dup Brand') {
  const now = nowIso();
  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(name, `${name.toLowerCase().replace(/\s+/g, '-')}-${Math.random()}`, now, now);
  return brand.lastInsertRowid;
}

function seedAccount(db, brandId, platform, { active = 1 } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, target_fields, active, created_at, updated_at)
       VALUES (?, ?, '{}', ?, ?, ?)`
    )
    .run(brandId, platform, active, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, brandId, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (@brand_id, @account_id, @platform, @copy, @media, @platform_fields, @publish_at, @status, @now, @now)`
    )
    .run({
      brand_id: brandId,
      account_id: overrides.account_id || null,
      platform: overrides.platform || 'twitter',
      copy: overrides.copy !== undefined ? overrides.copy : 'test copy',
      media: overrides.media || '[]',
      platform_fields: overrides.platform_fields || '{}',
      publish_at: overrides.publish_at || null,
      status: overrides.status || 'draft',
      now,
    });
  return info.lastInsertRowid;
}

function seedTag(db, { name, kind = 'tag', brand_id = null }) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO tags (name, kind, brand_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(name, kind, brand_id, now);
  return info.lastInsertRowid;
}

test('duplicate within the same brand copies fields, clears publish_at/status, and keeps tags (incl. campaign)', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const acctId = seedAccount(db, brandId, 'twitter');
  const postId = seedPost(db, brandId, {
    account_id: acctId,
    copy: 'original copy',
    status: 'scheduled_local',
    publish_at: nowIso(),
    media: JSON.stringify([{ path: 'x.png', altText: 'x' }]),
    platform_fields: JSON.stringify({ hook: 'hi' }),
  });
  const tagId = seedTag(db, { name: 'evergreen', brand_id: brandId });
  const campaignId = seedTag(db, { name: 'summer-push', kind: 'campaign', brand_id: brandId });
  db.prepare('INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)').run(postId, tagId);
  db.prepare('INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)').run(postId, campaignId);

  const res = await app.inject({ method: 'POST', url: `/api/posts/${postId}/duplicate`, payload: {} });
  assert.equal(res.statusCode, 201);
  const body = res.json();

  assert.notEqual(body.id, postId);
  assert.equal(body.brand_id, brandId);
  assert.equal(body.account_id, acctId);
  assert.equal(body.platform, 'twitter');
  assert.equal(body.copy, 'original copy');
  assert.equal(body.status, 'draft');
  assert.equal(body.publish_at, null);
  assert.deepEqual(body.media, [{ path: 'x.png', altText: 'x' }]);
  assert.deepEqual(body.platform_fields, { hook: 'hi' });
  assert.ok(!body.account_unresolved);

  const tagNames = body.tags.map((t) => t.name).sort();
  assert.deepEqual(tagNames, ['evergreen', 'summer-push']);

  await app.close();
});

test('duplicate to a different brand drops the campaign tag and resolves an active account of that platform', async () => {
  const app = buildServer();
  const db = getDb();
  const brandA = seedBrand(db, 'Brand A');
  const brandB = seedBrand(db, 'Brand B');
  const acctA = seedAccount(db, brandA, 'linkedin');
  const acctB = seedAccount(db, brandB, 'linkedin');
  const postId = seedPost(db, brandA, { account_id: acctA, platform: 'linkedin', copy: 'cross brand copy' });
  const plainTag = seedTag(db, { name: 'shared-tag', brand_id: brandA });
  const campaignTag = seedTag(db, { name: 'brand-a-campaign', kind: 'campaign', brand_id: brandA });
  db.prepare('INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)').run(postId, plainTag);
  db.prepare('INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)').run(postId, campaignTag);

  const res = await app.inject({
    method: 'POST',
    url: `/api/posts/${postId}/duplicate`,
    payload: { brand_id: brandB },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();

  assert.equal(body.brand_id, brandB);
  assert.equal(body.account_id, acctB); // resolved to brand B's linkedin account
  assert.ok(!body.account_unresolved);
  assert.equal(body.status, 'draft');
  const tagNames = body.tags.map((t) => t.name);
  assert.ok(!tagNames.includes('brand-a-campaign')); // campaign dropped
  assert.ok(tagNames.includes('shared-tag')); // plain tag kept

  await app.close();
});

test('duplicate to a different brand with no matching account flags account_unresolved', async () => {
  const app = buildServer();
  const db = getDb();
  const brandA = seedBrand(db, 'Brand A2');
  const brandB = seedBrand(db, 'Brand B2'); // no accounts at all
  const acctA = seedAccount(db, brandA, 'tiktok');
  const postId = seedPost(db, brandA, { account_id: acctA, platform: 'tiktok' });

  const res = await app.inject({
    method: 'POST',
    url: `/api/posts/${postId}/duplicate`,
    payload: { brand_id: brandB },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();

  assert.equal(body.brand_id, brandB);
  assert.equal(body.account_id, null);
  assert.equal(body.account_unresolved, true);

  await app.close();
});

test('duplicate honors an explicit account_id override even cross-brand', async () => {
  const app = buildServer();
  const db = getDb();
  const brandA = seedBrand(db, 'Brand A3');
  const brandB = seedBrand(db, 'Brand B3');
  const acctA = seedAccount(db, brandA, 'facebook');
  const acctB1 = seedAccount(db, brandB, 'facebook');
  seedAccount(db, brandB, 'facebook'); // a second one, to prove the explicit id wins over auto-resolution
  const postId = seedPost(db, brandA, { account_id: acctA, platform: 'facebook' });

  const res = await app.inject({
    method: 'POST',
    url: `/api/posts/${postId}/duplicate`,
    payload: { brand_id: brandB, account_id: acctB1 },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().account_id, acctB1);

  await app.close();
});

test('duplicate of a missing post returns 404', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'POST', url: '/api/posts/999999/duplicate', payload: {} });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
  await app.close();
});
