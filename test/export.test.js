// Unit test for buildSocialState() (B5 export). Uses an in-memory SQLite DB
// seeded with a small fixture so the test never touches postdeck.db.
// Run with: node --test test/export.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const { buildSocialState } = await import('../src/export.js');

function seedFixture(db) {
  const now = nowIso();
  const insertBrand = db.prepare(
    `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
     VALUES (@name, @slug, '{}', 1, @now, @now)`
  );
  const brandA = insertBrand.run({ name: 'Brand A', slug: 'brand-a', now }).lastInsertRowid;
  const brandB = insertBrand.run({ name: 'Brand B', slug: 'brand-b', now }).lastInsertRowid;

  const insertPost = db.prepare(
    `INSERT INTO posts (
       brand_id, platform, copy, publish_at, status, error_message, created_at, updated_at
     ) VALUES (@brand_id, @platform, @copy, @publish_at, @status, @error_message, @now, @now)`
  );

  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const in20Days = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

  const longCopy = 'x'.repeat(120);

  // brandA: one upcoming (within 14d, long hook to test truncation), one
  // outside the 14-day window (should be excluded), one draft, one failed.
  insertPost.run({
    brand_id: brandA, platform: 'linkedin', copy: longCopy,
    publish_at: in3Days, status: 'scheduled_local', error_message: null, now,
  });
  insertPost.run({
    brand_id: brandA, platform: 'x', copy: 'too far out',
    publish_at: in20Days, status: 'approved', error_message: null, now,
  });
  insertPost.run({
    brand_id: brandA, platform: 'facebook', copy: 'a draft',
    publish_at: null, status: 'draft', error_message: null, now,
  });
  insertPost.run({
    brand_id: brandA, platform: 'x', copy: 'oops',
    publish_at: twoDaysAgo, status: 'failed', error_message: 'blotato 422', now,
  });

  // brandB: published recently, nothing upcoming.
  insertPost.run({
    brand_id: brandB, platform: 'instagram', copy: 'went out',
    publish_at: twoDaysAgo, status: 'published', error_message: null, now,
  });

  return { brandA, brandB };
}

test('buildSocialState shapes the export correctly from a fixture DB', () => {
  const db = getDb();
  seedFixture(db);

  const state = buildSocialState(db);

  assert.equal(typeof state.generated_at, 'string');
  assert.equal(state.dry_run_mode, true);
  assert.equal(Array.isArray(state.brands), true);
  assert.equal(state.brands.length, 2);

  const brandA = state.brands.find((b) => b.slug === 'brand-a');
  const brandB = state.brands.find((b) => b.slug === 'brand-b');
  assert.ok(brandA);
  assert.ok(brandB);

  // next_14_days only includes the in-window post, not the 20-day-out one.
  assert.equal(brandA.next_14_days.length, 1);
  assert.equal(brandA.next_14_days[0].platform, 'linkedin');
  assert.equal(brandA.next_14_days[0].status, 'scheduled_local');
  assert.equal(brandA.next_14_days[0].hook.length, 80);

  assert.deepEqual(brandA.counts, {
    draft: 1,
    approved: 1,
    scheduled_local: 1,
    submitted: 0,
    published_last_7d: 0,
    failed: 1,
  });

  assert.equal(brandB.next_14_days.length, 0);
  assert.equal(brandB.counts.published_last_7d, 1);

  // B7: analytics_30d summary per brand (no metrics rows in this fixture,
  // so everything should come back zeroed rather than throwing).
  assert.deepEqual(brandA.analytics_30d, { posts_published: 0, impressions: 0, engagement: 0, leads: 0 });
  assert.deepEqual(brandB.analytics_30d, { posts_published: 1, impressions: 0, engagement: 0, leads: 0 });

  assert.equal(state.failures.length, 1);
  assert.equal(state.failures[0].platform, 'x');
  assert.equal(state.failures[0].error_message, 'blotato 422');
  assert.equal(typeof state.failures[0].post_id, 'number');

  assert.equal(state.last_worker_run, null);
});
