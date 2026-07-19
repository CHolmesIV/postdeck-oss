// Integration test (Fastify .inject, no real listen/port) for F2's hard
// delete: DELETE /api/posts/:id, guarded to draft/canceled only.
// Run with: node --test test/post-delete.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedBrand(db) {
  const now = nowIso();
  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Post Delete Brand', `pdb-${Math.random()}`, now, now);
  return brand.lastInsertRowid;
}

function seedPost(db, brandId, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (@brand_id, @platform, @copy, '[]', '{}', @publish_at, @status, @now, @now)`
    )
    .run({
      brand_id: brandId,
      platform: overrides.platform || 'twitter',
      copy: 'test copy',
      publish_at: overrides.publish_at || null,
      status: overrides.status || 'draft',
      now,
    });
  return info.lastInsertRowid;
}

test('DELETE a draft post succeeds and returns 204', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, brandId, { status: 'draft' });

  const res = await app.inject({ method: 'DELETE', url: `/api/posts/${postId}` });
  assert.equal(res.statusCode, 204);

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(row, undefined);
  await app.close();
});

test('DELETE a canceled post succeeds', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, brandId, { status: 'canceled' });

  const res = await app.inject({ method: 'DELETE', url: `/api/posts/${postId}` });
  assert.equal(res.statusCode, 204);
  await app.close();
});

test('DELETE a scheduled post is rejected with 409', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, brandId, { status: 'scheduled_local', publish_at: nowIso() });

  const res = await app.inject({ method: 'DELETE', url: `/api/posts/${postId}` });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'not_deletable');

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.ok(row); // still there - not deleted
  await app.close();
});

test('DELETE a submitted post is rejected with 409', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, brandId, { status: 'submitted' });

  const res = await app.inject({ method: 'DELETE', url: `/api/posts/${postId}` });
  assert.equal(res.statusCode, 409);
  await app.close();
});

test('DELETE a missing post returns 404', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'DELETE', url: '/api/posts/999999' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
  await app.close();
});

test('DELETE cleans up post_tags rows for the deleted post', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, brandId, { status: 'draft' });

  const now = nowIso();
  const tag = db
    .prepare(`INSERT INTO tags (name, kind, brand_id, created_at) VALUES (?, 'tag', ?, ?)`)
    .run('test-tag', brandId, now);
  db.prepare('INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)').run(postId, tag.lastInsertRowid);

  const before = db.prepare('SELECT COUNT(*) AS n FROM post_tags WHERE post_id = ?').get(postId);
  assert.equal(before.n, 1);

  const res = await app.inject({ method: 'DELETE', url: `/api/posts/${postId}` });
  assert.equal(res.statusCode, 204);

  const after = db.prepare('SELECT COUNT(*) AS n FROM post_tags WHERE post_id = ?').get(postId);
  assert.equal(after.n, 0);
  await app.close();
});
