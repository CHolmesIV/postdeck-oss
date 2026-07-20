// Tests for "Link in first comment" (per-post optional first_comment column,
// migration v10). Covers: column round-trips through POST/PATCH; worker
// payload attaches it as a Blotato additionalPost when set and omits it when
// null; UTM auto-append at the approve gate also runs over first_comment.
// Run with: node --test test/first-comment.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { setBrandUtmSettings } = await import('../src/utm.js');
const worker = await import('../src/worker.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'First Comment Brand', overrides.slug || `fc-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, { brand_id, platform = 'linkedin', status = 'draft', copy = 'body copy', first_comment = null } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, first_comment, publish_at, status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '{}', ?, NULL, ?, ?, ?)`
    )
    .run(brand_id, platform, copy, first_comment, status, now, now);
  return info.lastInsertRowid;
}

// ---------- migration ----------

test('posts table has a first_comment column defaulting to null', () => {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(posts)').all();
  const col = cols.find((c) => c.name === 'first_comment');
  assert.ok(col, 'first_comment column should exist');
  const id = seedPost(db, { brand_id: seedBrand(db) });
  const row = db.prepare('SELECT first_comment FROM posts WHERE id = ?').get(id);
  assert.equal(row.first_comment, null);
});

// ---------- POST/PATCH round-trip ----------

test('POST /api/posts accepts first_comment and it round-trips through GET', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const res = await app.inject({
    method: 'POST',
    url: '/api/posts',
    payload: {
      platform: 'linkedin',
      brand_id: brandId,
      copy: 'main body',
      first_comment: 'link goes here: https://example.com/land',
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.first_comment, 'link goes here: https://example.com/land');

  const get = await app.inject({ method: 'GET', url: `/api/posts/${body.id}` });
  assert.equal(get.json().first_comment, 'link goes here: https://example.com/land');
  await app.close();
});

test('POST /api/posts with no first_comment leaves it null', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const res = await app.inject({
    method: 'POST',
    url: '/api/posts',
    payload: { platform: 'linkedin', brand_id: brandId, copy: 'main body' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().first_comment, null);
  await app.close();
});

test('PATCH /api/posts/:id sets first_comment (plain additive merge)', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { first_comment: 'https://example.com/promo' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().first_comment, 'https://example.com/promo');

  // Other fields untouched by the merge.
  const row = db.prepare('SELECT copy FROM posts WHERE id = ?').get(postId);
  assert.equal(row.copy, 'body copy');
  await app.close();
});

test('PATCH /api/posts/:id without first_comment in the body leaves the existing value alone', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId, first_comment: 'https://example.com/keep-me' });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { copy: 'updated body' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().first_comment, 'https://example.com/keep-me');
  await app.close();
});

// ---------- worker payload: additionalPosts ----------

test('buildBlotatoPayload attaches first_comment as a flat additionalPost on threadable platforms', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, {
    brand_id: brandId,
    platform: 'twitter',
    copy: 'main body, no link',
    first_comment: 'link: https://example.com/thread',
  });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);

  const payload = await worker.buildBlotatoPayload(post, null);
  assert.equal(payload.content.text, 'main body, no link');
  assert.equal(payload.content.additionalPosts.length, 1);
  // Blotato additionalPosts entries are FLAT {text, mediaUrls} — verified
  // against help.blotato.com llms-full.txt 2026-07-19.
  assert.deepEqual(payload.content.additionalPosts[0], {
    text: 'link: https://example.com/thread',
    mediaUrls: [],
  });
});

test('buildBlotatoPayload does NOT attach additionalPosts on non-threadable platforms (linkedin)', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, {
    brand_id: brandId,
    platform: 'linkedin',
    copy: 'main body',
    first_comment: 'link: https://example.com/manual-comment',
  });
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);

  const payload = await worker.buildBlotatoPayload(post, null);
  // Blotato only auto-chains additionalPosts on twitter/bluesky/threads;
  // linkedin/facebook first comments stay stored for the manual reminder flow.
  assert.deepEqual(payload.content.additionalPosts, []);
  const stored = db.prepare('SELECT first_comment FROM posts WHERE id = ?').get(postId);
  assert.equal(stored.first_comment, 'link: https://example.com/manual-comment');
});

test('buildBlotatoPayload omits additionalPosts when first_comment is null/empty', async () => {
  const db = getDb();
  const brandId = seedBrand(db);

  const postNull = db.prepare('SELECT * FROM posts WHERE id = ?').get(seedPost(db, { brand_id: brandId }));
  const payloadNull = await worker.buildBlotatoPayload(postNull, null);
  assert.deepEqual(payloadNull.content.additionalPosts, []);

  const postEmpty = db
    .prepare('SELECT * FROM posts WHERE id = ?')
    .get(seedPost(db, { brand_id: brandId, first_comment: '   ' }));
  const payloadEmpty = await worker.buildBlotatoPayload(postEmpty, null);
  assert.deepEqual(payloadEmpty.content.additionalPosts, []);
});

// ---------- UTM interplay at the approve gate ----------

test('PATCH approve applies UTM to first_comment when the brand has utm_enabled', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  setBrandUtmSettings(db, brandId, { enabled: true });
  const postId = seedPost(db, {
    brand_id: brandId,
    platform: 'facebook',
    copy: 'body with no link',
    first_comment: 'Check it out: https://example.com/land',
  });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { status: 'approved' },
  });
  assert.equal(res.statusCode, 200);
  const fc = res.json().first_comment;
  assert.match(fc, /utm_source=facebook/);
  assert.match(fc, /utm_medium=social/);
  await app.close();
});

test('PATCH approve does not touch first_comment when utm_enabled is false', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const original = 'Check it out: https://example.com/land';
  const postId = seedPost(db, { brand_id: brandId, platform: 'facebook', first_comment: original });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { status: 'approved' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().first_comment, original);
  await app.close();
});

test('draft save (no status transition) never applies UTM to first_comment', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  setBrandUtmSettings(db, brandId, { enabled: true });
  const postId = seedPost(db, { brand_id: brandId, platform: 'facebook' });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { first_comment: 'https://example.com/land' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().first_comment, 'https://example.com/land');
  await app.close();
});
