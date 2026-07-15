// Unit tests for src/recommend.js (B8 - SPEC.md "Content-type picker +
// recommender"). Follows the analytics.test.js isolation pattern: in-memory
// SQLite DB, POSTDECK_DB_PATH set before importing db.js.
// Run with: node --test test/recommend.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const { recommendContentType, CONTENT_TYPES } = await import('../src/recommend.js');

function makeBrand(db, name = 'Recommend Brand') {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES (?, ?, '{}', 1, ?, ?)`
    )
    .run(name, `${name.toLowerCase().replace(/\s+/g, '-')}-${Math.random()}`, now, now).lastInsertRowid;
}

function insertPostWithMetrics(db, { brand_id, platform, content_type, comments, shares, saves }) {
  const now = nowIso();
  const postId = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, content_type, copy, status, created_at, updated_at)
       VALUES (?, ?, ?, 'copy', 'published', ?, ?)`
    )
    .run(brand_id, platform, content_type, now, now).lastInsertRowid;
  db.prepare(
    `INSERT INTO metrics (post_id, captured_at, impressions, comments, shares, saves)
     VALUES (?, ?, 0, ?, ?, ?)`
  ).run(postId, now, comments, shares, saves);
  return postId;
}

test('recommendContentType uses own_metrics when the brand has published posts with metrics', () => {
  const db = getDb();
  const brand = makeBrand(db, 'Metrics Brand');

  // carousel: high engagement (2 posts, avg 30), image: low engagement (1 post, avg 5)
  insertPostWithMetrics(db, { brand_id: brand, platform: 'instagram', content_type: 'carousel', comments: 20, shares: 5, saves: 5 });
  insertPostWithMetrics(db, { brand_id: brand, platform: 'instagram', content_type: 'carousel', comments: 20, shares: 5, saves: 5 });
  insertPostWithMetrics(db, { brand_id: brand, platform: 'instagram', content_type: 'image', comments: 2, shares: 2, saves: 1 });

  const rec = recommendContentType(db, { brand_id: brand, platform: 'instagram' });
  assert.equal(rec.basis, 'own_metrics');
  assert.equal(rec.suggestion, 'carousel');
  assert.ok(rec.ranked.length >= 2);
  assert.equal(rec.ranked[0].content_type, 'carousel');
  assert.ok(rec.ranked[0].score > rec.ranked[1].score);
  assert.ok(rec.ranked[0].reason.length > 0);
});

test('recommendContentType falls back to best_practice when the brand has no metrics', () => {
  const db = getDb();
  const brand = makeBrand(db, 'No Metrics Brand');

  const rec = recommendContentType(db, { brand_id: brand, platform: 'tiktok' });
  assert.equal(rec.basis, 'best_practice');
  assert.equal(rec.suggestion, 'video', 'tiktok best-practice default should favor video first');
  assert.ok(rec.ranked.length === CONTENT_TYPES.length);
  assert.ok(rec.ranked[0].reason.length > 0);
});

test('recommendContentType falls back to best_practice for an unrecognized platform without crashing', () => {
  const db = getDb();
  const brand = makeBrand(db, 'Unknown Platform Brand');

  const rec = recommendContentType(db, { brand_id: brand, platform: 'some_future_platform' });
  assert.equal(rec.basis, 'best_practice');
  assert.ok(CONTENT_TYPES.includes(rec.suggestion));
});

test('recommendContentType best_practice ranking differs sensibly by platform (twitter favors text)', () => {
  const db = getDb();
  const brand = makeBrand(db, 'Twitter Brand');
  const rec = recommendContentType(db, { brand_id: brand, platform: 'twitter' });
  assert.equal(rec.basis, 'best_practice');
  assert.equal(rec.suggestion, 'text');
});

test('recommendContentType ignores metrics from other brands/platforms when scoping', () => {
  const db = getDb();
  const brandA = makeBrand(db, 'Brand A');
  const brandB = makeBrand(db, 'Brand B');

  insertPostWithMetrics(db, { brand_id: brandA, platform: 'instagram', content_type: 'video', comments: 50, shares: 50, saves: 50 });
  // Brand B has no metrics at all - should fall back to best_practice, not see Brand A's data.
  const rec = recommendContentType(db, { brand_id: brandB, platform: 'instagram' });
  assert.equal(rec.basis, 'best_practice');
});
