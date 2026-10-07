// Audit 2026-10-07 T9 (origin guard: Origin 'null', Sec-Fetch-Site) and T10
// (queue route + agent approve run the same approve gate as PATCH).
//
// Run with: node --test test/guards-t9-t10.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { createQueueSlot } = await import('../src/queue.js');
const { setBrandUtmSettings } = await import('../src/utm.js');
const { setRawSetting } = await import('../src/voice.js');
const { executeAction } = await import('../src/agent.js');
const { updateSettings } = await import('../src/settings.js');

const H = { host: '127.0.0.1:4520' };

test('T9: Origin "null" is refused on writes; GET unaffected', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'POST', url: '/api/ideas', headers: { ...H, origin: 'null' }, payload: { title: 'x' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'forbidden_origin');
  const get = await app.inject({ method: 'GET', url: '/api/health', headers: { ...H, origin: 'null' } });
  assert.equal(get.statusCode, 200);
  await app.close();
});

test('T9: Sec-Fetch-Site cross-site and same-site are refused; same-origin, none and absent pass', async () => {
  const app = buildServer();
  for (const site of ['cross-site', 'same-site', 'Cross-Site']) {
    const res = await app.inject({ method: 'POST', url: '/api/ideas', headers: { ...H, 'sec-fetch-site': site }, payload: { title: 'x' } });
    assert.equal(res.statusCode, 403, site);
    assert.equal(res.json().error, 'forbidden_origin');
  }
  // same-site even with a loopback Origin (another localhost port)
  const otherPort = await app.inject({
    method: 'POST', url: '/api/ideas',
    headers: { ...H, origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' }, payload: { title: 'x' },
  });
  assert.equal(otherPort.statusCode, 403);
  for (const site of ['same-origin', 'none']) {
    const ok = await app.inject({ method: 'POST', url: '/api/ideas', headers: { ...H, 'sec-fetch-site': site }, payload: { title: 'ok' } });
    assert.equal(ok.statusCode, 201, site);
  }
  const absent = await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'curl' } });
  assert.equal(absent.statusCode, 201);
  await app.close();
});

function seed(db, { platform = 'tiktok', status = 'draft', platform_fields = {}, copy = 'see https://example.com/x', publish_at = null, utm = false } = {}) {
  const now = nowIso();
  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Gate Brand', `gate-${Math.random()}`, now, now).lastInsertRowid;
  if (utm) setBrandUtmSettings(db, brand, { enabled: true });
  const id = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', ?, ?, ?, ?, ?)`
    )
    .run(brand, platform, copy, JSON.stringify(platform_fields), publish_at, status, now, now).lastInsertRowid;
  return { brand, id };
}
const row = (db, id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);

function withSlot(db, brand, platform) {
  updateSettings(db, { quiet_start: '00:00', quiet_end: '00:00' });
  createQueueSlot(db, { brand_id: brand, platform, day_of_week: new Date().getDay(), time_local: '23:59' });
  createQueueSlot(db, { brand_id: brand, platform, day_of_week: (new Date().getDay() + 1) % 7, time_local: '12:00' });
}

test('T10: queue route refuses a TikTok draft with missing fields (422) and leaves it a draft', async () => {
  const app = buildServer();
  const db = getDb();
  const { brand, id } = seed(db, { platform: 'tiktok', platform_fields: {} });
  withSlot(db, brand, 'tiktok');
  const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/queue`, payload: {} });
  assert.equal(res.statusCode, 422);
  assert.equal(res.json().error, 'tiktok_fields_missing');
  assert.equal(row(db, id).status, 'draft');
  assert.equal(row(db, id).publish_at, null);
  await app.close();
});

test('T10: queue route applies the UTM pass when a draft is scheduled, and only once', async () => {
  const app = buildServer();
  const db = getDb();
  const { brand, id } = seed(db, { platform: 'linkedin', utm: true });
  withSlot(db, brand, 'linkedin');
  const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/queue`, payload: {} });
  assert.equal(res.statusCode, 200);
  const after = row(db, id);
  assert.equal(after.status, 'scheduled_local');
  assert.match(after.copy, /utm_source=/);
  // re-queueing a scheduled post must not tag again
  const again = await app.inject({ method: 'POST', url: `/api/posts/${id}/queue`, payload: {} });
  assert.equal(again.statusCode, 200);
  assert.equal(row(db, id).copy.match(/utm_source=/g).length, 1);
  await app.close();
});

test('T10: agent approve_post runs the TikTok check and the UTM pass', async () => {
  const db = getDb();
  setRawSetting(db, 'agent_can_publish', '1');
  try {
    const bad = seed(db, { platform: 'tiktok', platform_fields: {}, publish_at: '2031-01-01T10:00:00.000Z' });
    const r1 = await executeAction(db, { tool: 'approve_post', args: { id: bad.id } });
    assert.match(r1.summary, /TikTok post is missing required fields/);
    assert.equal(row(db, bad.id).status, 'draft');

    const good = seed(db, { platform: 'linkedin', utm: true, publish_at: '2031-01-01T10:00:00.000Z' });
    const r2 = await executeAction(db, { tool: 'approve_post', args: { id: good.id } });
    assert.match(r2.summary, /Approved post/);
    const after = row(db, good.id);
    assert.equal(after.status, 'scheduled_local');
    assert.match(after.copy, /utm_source=/);
  } finally {
    setRawSetting(db, 'agent_can_publish', '0');
  }
});
