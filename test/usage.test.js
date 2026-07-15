// Unit tests for buildUsageStats()/recordUsage()/usageSummaryForExport() (B8
// — SPEC.md "Ops-stats tab"). Uses an in-memory SQLite DB seeded with a
// posts/usage_events fixture, following test/analytics.test.js's pattern.
//
// NOTE: getDb() is a module-level singleton, so (like analytics.test.js) all
// tests in this file share one growing in-memory DB. Global aggregates
// (posts_by_status, published_all_time, usage_counts, ...) are asserted as
// *deltas* against a baseline snapshot taken before each test seeds its own
// fixture, rather than as absolute counts — this keeps tests order-independent
// and immune to accumulation across tests.
// Run with: node --test test/usage.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const { recordUsage, buildUsageStats, usageSummaryForExport } = await import('../src/usage.js');

function seedFixture(db) {
  const now = nowIso();
  const brand = db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES ('Usage Brand', ?, '{}', 1, ?, ?)`
    )
    .run(`usage-brand-${Math.random()}`, now, now).lastInsertRowid;

  const insertPost = db.prepare(
    `INSERT INTO posts (brand_id, platform, copy, content_type, publish_at, status, created_at, updated_at)
     VALUES (@brand_id, @platform, @copy, @content_type, @publish_at, @status, @now, @now)`
  );

  const in3Days = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
  const in10Days = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString();
  const thisMonth = new Date().toISOString();

  // Two drafts, no content_type (unset).
  insertPost.run({
    brand_id: brand, platform: 'instagram', copy: 'Draft 1', content_type: null,
    publish_at: null, status: 'draft', now,
  });
  insertPost.run({
    brand_id: brand, platform: 'facebook', copy: 'Draft 2', content_type: null,
    publish_at: null, status: 'draft', now,
  });

  // Approved post scheduled within the next 7 days.
  insertPost.run({
    brand_id: brand, platform: 'linkedin', copy: 'Approved 1', content_type: 'carousel',
    publish_at: in3Days, status: 'approved', now,
  });

  // Scheduled_local post outside the 7-day window (10 days out).
  insertPost.run({
    brand_id: brand, platform: 'tiktok', copy: 'Scheduled far out', content_type: 'video',
    publish_at: in10Days, status: 'scheduled_local', now,
  });

  // Published this month.
  insertPost.run({
    brand_id: brand, platform: 'linkedin', copy: 'Published 1', content_type: 'static',
    publish_at: thisMonth, status: 'published', now,
  });
  insertPost.run({
    brand_id: brand, platform: 'twitter', copy: 'Published 2', content_type: 'static',
    publish_at: thisMonth, status: 'published', now,
  });

  // Failed post.
  insertPost.run({
    brand_id: brand, platform: 'reddit', copy: 'Failed 1', content_type: 'text',
    publish_at: null, status: 'failed', now,
  });

  return { brand };
}

test('buildUsageStats rolls up posts by status/brand/platform/content_type from the fixture', () => {
  const db = getDb();
  const before = buildUsageStats(db);
  const { brand } = seedFixture(db);
  const stats = buildUsageStats(db);

  assert.equal(stats.posts_by_status.draft - before.posts_by_status.draft, 2);
  assert.equal(stats.posts_by_status.approved - before.posts_by_status.approved, 1);
  assert.equal(stats.posts_by_status.scheduled_local - before.posts_by_status.scheduled_local, 1);
  assert.equal(stats.posts_by_status.published - before.posts_by_status.published, 2);
  assert.equal(stats.posts_by_status.failed - before.posts_by_status.failed, 1);
  assert.equal(stats.posts_by_status.submitted, 0);
  assert.equal(stats.posts_by_status.submitted_dry, 0);
  assert.equal(stats.posts_by_status.canceled, 0);

  // posts_by_brand is scoped per-brand, so this brand's row is exact.
  const brandRow = stats.posts_by_brand.find((r) => r.brand_id === brand);
  assert.ok(brandRow);
  assert.equal(brandRow.count, 7);
  assert.equal(brandRow.brand_name, 'Usage Brand');

  const linkedinBefore = before.posts_by_platform.find((r) => r.platform === 'linkedin')?.count || 0;
  const linkedinAfter = stats.posts_by_platform.find((r) => r.platform === 'linkedin')?.count || 0;
  assert.equal(linkedinAfter - linkedinBefore, 2);

  const unsetBefore = before.content_type_mix.find((r) => r.content_type === 'unset')?.count || 0;
  const unsetAfter = stats.content_type_mix.find((r) => r.content_type === 'unset')?.count || 0;
  assert.equal(unsetAfter - unsetBefore, 2);
  const carouselBefore = before.content_type_mix.find((r) => r.content_type === 'carousel')?.count || 0;
  const carouselAfter = stats.content_type_mix.find((r) => r.content_type === 'carousel')?.count || 0;
  assert.equal(carouselAfter - carouselBefore, 1);

  // Only the 'approved' post publishing in 3 days falls in the 7-day window;
  // the 'scheduled_local' post 10 days out does not.
  assert.equal(stats.scheduled_this_week - before.scheduled_this_week, 1);
  assert.equal(stats.drafts_awaiting - before.drafts_awaiting, 2);
  assert.equal(stats.published_this_month - before.published_this_month, 2);
  assert.equal(stats.published_all_time - before.published_all_time, 2);
  assert.ok(stats.generated_at);
});

test('recordUsage inserts a usage_events row and buildUsageStats counts it', () => {
  const db = getDb();
  const { brand } = seedFixture(db);
  const before = buildUsageStats(db);

  const row = recordUsage(db, { kind: 'ai_draft', brand_id: brand, meta: { foo: 'bar' } });
  assert.ok(row.id);
  assert.equal(row.kind, 'ai_draft');
  assert.equal(row.brand_id, brand);
  assert.deepEqual(JSON.parse(row.meta), { foo: 'bar' });
  assert.ok(row.created_at);

  recordUsage(db, { kind: 'copy_assist', brand_id: brand });
  recordUsage(db, { kind: 'copy_assist', brand_id: brand });

  const stats = buildUsageStats(db);
  assert.equal(stats.usage_counts.ai_draft - before.usage_counts.ai_draft, 1);
  assert.equal(stats.usage_counts.copy_assist - before.usage_counts.copy_assist, 2);
  assert.equal(stats.usage_counts.blotato_submit - before.usage_counts.blotato_submit, 0);

  assert.equal(stats.usage_last_7d.ai_draft - before.usage_last_7d.ai_draft, 1);
  assert.equal(stats.usage_last_7d.copy_assist - before.usage_last_7d.copy_assist, 2);
});

test('recordUsage defaults brand_id to null and meta to {}', () => {
  const db = getDb();
  const row = recordUsage(db, { kind: 'blotato_submit' });
  assert.equal(row.brand_id, null);
  assert.deepEqual(JSON.parse(row.meta), {});
});

test('usageSummaryForExport returns the compact subset used in social-state.json', () => {
  const db = getDb();
  const before = usageSummaryForExport(db);
  const { brand } = seedFixture(db);
  recordUsage(db, { kind: 'image_request', brand_id: brand });

  const summary = usageSummaryForExport(db);
  assert.equal(summary.drafts_awaiting - before.drafts_awaiting, 2);
  assert.equal(summary.scheduled_this_week - before.scheduled_this_week, 1);
  assert.equal(summary.published_this_month - before.published_this_month, 2);
  assert.equal(summary.usage_last_7d.image_request - before.usage_last_7d.image_request, 1);
});
