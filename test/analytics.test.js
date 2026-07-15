// Unit tests for buildAnalytics()/build30dSummary() (B7 - SPEC.md "Analytics
// portal"). Uses an in-memory SQLite DB seeded with a metrics fixture.
// Run with: node --test test/analytics.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const { buildAnalytics, build30dSummary, isoDaysAgo } = await import('../src/analytics.js');

function seedFixture(db) {
  const now = nowIso();
  const brand = db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES ('Analytics Brand', ?, '{}', 1, ?, ?)`
    )
    .run(`analytics-brand-${Math.random()}`, now, now).lastInsertRowid;

  const insertPost = db.prepare(
    `INSERT INTO posts (brand_id, platform, copy, publish_at, status, created_at, updated_at)
     VALUES (@brand_id, @platform, @copy, @publish_at, @status, @now, @now)`
  );
  const insertMetric = db.prepare(
    `INSERT INTO metrics (post_id, captured_at, impressions, comments, shares, saves, follows, dms, leads, call_booked)
     VALUES (@post_id, @captured_at, @impressions, @comments, @shares, @saves, @follows, @dms, @leads, @call_booked)`
  );

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const fiftyHoursAgo = new Date(Date.now() - 50 * 60 * 60 * 1000).toISOString();
  const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  // Post A: published 3 days ago, high impressions + leads, metrics entered
  // recently (within last 7d window).
  const postA = insertPost.run({
    brand_id: brand, platform: 'linkedin', copy: 'Post A',
    publish_at: threeDaysAgo, status: 'published', now: threeDaysAgo,
  }).lastInsertRowid;
  insertMetric.run({
    post_id: postA, captured_at: now, impressions: 1000, comments: 10, shares: 5, saves: 5,
    follows: 3, dms: 1, leads: 4, call_booked: 1,
  });

  // Post B: published 10 days ago, metrics from 10 days ago (outside 7d
  // window, inside 30d) - used to test window scoping + WoW delta.
  const postB = insertPost.run({
    brand_id: brand, platform: 'twitter', copy: 'Post B',
    publish_at: tenDaysAgo, status: 'published', now: tenDaysAgo,
  }).lastInsertRowid;
  insertMetric.run({
    post_id: postB, captured_at: tenDaysAgo, impressions: 200, comments: 2, shares: 1, saves: 1,
    follows: 0, dms: 0, leads: 1, call_booked: 0,
  });

  // Post C: published >48h ago, NO metrics rows - should show up in metrics_due.
  const postC = insertPost.run({
    brand_id: brand, platform: 'facebook', copy: 'Post C (needs metrics)',
    publish_at: fiftyHoursAgo, status: 'published', now: fiftyHoursAgo,
  }).lastInsertRowid;

  return { brand, postA, postB, postC };
}

test('buildAnalytics rolls up totals, top posts, and metrics_due from the fixture', () => {
  const db = getDb();
  const { brand, postA, postC } = seedFixture(db);

  const analytics = buildAnalytics(db);
  const brandState = analytics.brands.find((b) => b.brand_id === brand);
  assert.ok(brandState);

  // 30d totals should include both post A and post B's metrics.
  assert.equal(brandState.totals['30d'].impressions, 1200);
  assert.equal(brandState.totals['30d'].engagement, 10 + 5 + 5 + (2 + 1 + 1)); // comments+shares+saves
  assert.equal(brandState.totals['30d'].leads, 5);
  assert.equal(brandState.totals['30d'].posts_published, 3);

  // all_time should match 30d here (no metrics older than 30d in the fixture).
  assert.equal(brandState.totals.all_time.impressions, 1200);

  assert.equal(brandState.top10_by_impressions[0].id, postA);
  assert.equal(brandState.top10_by_leads[0].id, postA);

  assert.ok(['up', 'down', 'flat'].includes(brandState.week_over_week.impressions));

  const dueIds = analytics.metrics_due.map((p) => p.id);
  assert.ok(dueIds.includes(postC), 'post older than 48h with zero metrics rows must appear in metrics_due');
  assert.ok(!dueIds.includes(postA), 'post with metrics rows must not appear in metrics_due');
});

test('build30dSummary matches the per-brand 30d totals used in export', () => {
  const db = getDb();
  const { brand } = seedFixture(db);
  const summary = build30dSummary(db, brand);
  assert.equal(summary.impressions, 1200);
  assert.equal(summary.leads, 5);
  assert.equal(summary.posts_published, 3);
});

test('isoDaysAgo returns an ISO string roughly N days in the past', () => {
  const iso = isoDaysAgo(1);
  const deltaMs = Date.now() - Date.parse(iso);
  assert.ok(deltaMs > 23 * 60 * 60 * 1000 && deltaMs < 25 * 60 * 60 * 1000);
});
