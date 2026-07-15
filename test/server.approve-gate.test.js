// Integration test (Fastify .inject, no real listen/port) for the B6 Approve
// gate: TikTok posts missing required platform_fields get 422 on approve,
// and publish_at can't be changed once a post is submitted/published.
// Run with: node --test test/server.approve-gate.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedPost(db, overrides = {}) {
  const now = nowIso();
  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Approve Gate Brand', `agb-${Math.random()}`, now, now);
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (@brand_id, @platform, @copy, '[]', @platform_fields, @publish_at, @status, @now, @now)`
    )
    .run({
      brand_id: brand.lastInsertRowid,
      platform: overrides.platform || 'tiktok',
      copy: 'test copy',
      platform_fields: JSON.stringify(overrides.platform_fields || {}),
      publish_at: overrides.publish_at || null,
      status: overrides.status || 'draft',
      now,
    });
  return info.lastInsertRowid;
}

test('PATCH approve on a tiktok post missing required fields returns 422', async () => {
  const app = buildServer();
  const db = getDb();
  const postId = seedPost(db, { platform: 'tiktok', platform_fields: {} });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { status: 'approved' },
  });

  assert.equal(res.statusCode, 422);
  const body = res.json();
  assert.equal(body.error, 'tiktok_fields_missing');
  assert.ok(body.missing.includes('privacyLevel'));
  await app.close();
});

test('PATCH approve on a tiktok post with all required fields succeeds', async () => {
  const app = buildServer();
  const db = getDb();
  const postId = seedPost(db, {
    platform: 'tiktok',
    platform_fields: {
      privacyLevel: 'PUBLIC_TO_EVERYONE',
      disabledComments: false,
      disabledDuet: false,
      disabledStitch: false,
      isBrandedContent: false,
      isYourBrand: true,
      isAiGenerated: false,
    },
  });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { status: 'approved' },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'approved');
  await app.close();
});

test('PATCH publish_at is rejected once a post is submitted', async () => {
  const app = buildServer();
  const db = getDb();
  const postId = seedPost(db, { platform: 'twitter', status: 'submitted', publish_at: nowIso() });

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { publish_at: new Date(Date.now() + 86400000).toISOString() },
  });

  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'not_reschedulable');
  await app.close();
});

test('PATCH publish_at (drag-to-reschedule) succeeds while a post is still scheduled_local', async () => {
  const app = buildServer();
  const db = getDb();
  const postId = seedPost(db, { platform: 'twitter', status: 'scheduled_local', publish_at: nowIso() });

  const newDate = new Date(Date.now() + 86400000).toISOString();
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { publish_at: newDate },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().publish_at, newDate);
  await app.close();
});

test('GET /api/settings returns quiet-hours defaults and PATCH updates them', async () => {
  const app = buildServer();

  const before = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(before.json().quiet_start, '22:00');
  assert.equal(before.json().quiet_end, '07:00');

  const patched = await app.inject({
    method: 'PATCH',
    url: '/api/settings',
    payload: { quiet_start: '23:00' },
  });
  assert.equal(patched.json().quiet_start, '23:00');
  await app.close();
});

test('quiet-hours-check flags a post scheduled at 2am as within quiet hours', async () => {
  const app = buildServer();
  const twoAmIso = (() => {
    const d = new Date();
    d.setHours(2, 0, 0, 0);
    return d.toISOString();
  })();

  const res = await app.inject({
    method: 'GET',
    url: `/api/settings/quiet-hours-check?publish_at=${encodeURIComponent(twoAmIso)}`,
  });
  assert.equal(res.json().within_quiet_hours, true);
  await app.close();
});
