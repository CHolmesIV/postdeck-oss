// Unit + integration tests for B16a queue slots (src/queue.js + server.js
// /api/queue-slots + /api/posts/:id/queue). In-memory DB, worker/sync
// disabled — mirrors test/server.b14.test.js's isolation style.
//
// Run with: node --test test/queue.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const {
  listQueueSlots,
  createQueueSlot,
  updateQueueSlot,
  deleteQueueSlot,
  nextOpenSlot,
} = await import('../src/queue.js');
const { updateSettings } = await import('../src/settings.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'Queue Test Brand', `queue-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, { brand_id, platform = 'facebook', status = 'draft', publish_at = null } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, '', '[]', '{}', ?, ?, ?, ?)`
    )
    .run(brand_id, platform, publish_at, status, now, now);
  return info.lastInsertRowid;
}

// Reset quiet hours to a fixed, known window before each test that depends
// on it — other test files in this suite may leave settings mutated in the
// shared in-memory DB/connection.
function resetQuietHours(db) {
  updateSettings(db, { quiet_start: '22:00', quiet_end: '07:00' });
}

test('queue slot CRUD', async () => {
  const db = getDb();
  const brandId = seedBrand(db);

  const { row: created, error: createErr } = createQueueSlot(db, {
    brand_id: brandId,
    platform: 'linkedin',
    day_of_week: 2,
    time_local: '12:00',
  });
  assert.equal(createErr, undefined);
  assert.equal(created.brand_id, brandId);
  assert.equal(created.platform, 'linkedin');
  assert.equal(created.day_of_week, 2);
  assert.equal(created.time_local, '12:00');
  assert.equal(created.active, 1);

  const listed = listQueueSlots(db, { brand_id: brandId });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, created.id);

  const { row: updated, error: updateErr } = updateQueueSlot(db, created.id, { active: 0, time_local: '13:30' });
  assert.equal(updateErr, undefined);
  assert.equal(updated.active, 0);
  assert.equal(updated.time_local, '13:30');

  const { error: badInput } = createQueueSlot(db, { brand_id: brandId, platform: 'linkedin', day_of_week: 9, time_local: '12:00' });
  assert.match(badInput, /day_of_week/);

  const { error: badTime } = createQueueSlot(db, { brand_id: brandId, platform: 'linkedin', day_of_week: 1, time_local: '25:99' });
  assert.match(badTime, /time_local/);

  const { ok, error: notFoundOnDelete } = deleteQueueSlot(db, created.id);
  assert.equal(ok, true);
  assert.equal(notFoundOnDelete, undefined);
  assert.equal(listQueueSlots(db, { brand_id: brandId }).length, 0);

  const missing = deleteQueueSlot(db, 999999);
  assert.equal(missing.error, 'not_found');
});

test('nextOpenSlot walks slots in weekly order and returns the first one at/after `from`', async () => {
  const db = getDb();
  resetQuietHours(db);
  const brandId = seedBrand(db);

  // Slots: Tue 12:00, Thu 09:00 (both active, LinkedIn).
  createQueueSlot(db, { brand_id: brandId, platform: 'linkedin', day_of_week: 2, time_local: '12:00' });
  createQueueSlot(db, { brand_id: brandId, platform: 'linkedin', day_of_week: 4, time_local: '09:00' });

  // `from` = a Sunday at noon -> next slot should be Tuesday 12:00 that week.
  const sunday = new Date('2026-07-19T12:00:00'); // 2026-07-19 is a Sunday
  const result = nextOpenSlot(db, brandId, 'linkedin', sunday);
  assert.ok(result);
  const d = new Date(result);
  assert.equal(d.getDay(), 2, 'should land on Tuesday');
  assert.equal(d.getHours(), 12);
  assert.equal(d.getMinutes(), 0);
});

test('nextOpenSlot skips a datetime already taken by an existing post for that brand+platform', async () => {
  const db = getDb();
  resetQuietHours(db);
  const brandId = seedBrand(db);

  createQueueSlot(db, { brand_id: brandId, platform: 'linkedin', day_of_week: 2, time_local: '12:00' });
  createQueueSlot(db, { brand_id: brandId, platform: 'linkedin', day_of_week: 4, time_local: '09:00' });

  const sunday = new Date('2026-07-19T00:00:00');
  const firstSlotIso = nextOpenSlot(db, brandId, 'linkedin', sunday);
  assert.ok(firstSlotIso);

  // Occupy the Tuesday slot with a scheduled post.
  seedPost(db, { brand_id: brandId, platform: 'linkedin', status: 'scheduled_local', publish_at: firstSlotIso });

  const secondResult = nextOpenSlot(db, brandId, 'linkedin', sunday);
  assert.ok(secondResult);
  assert.notEqual(secondResult, firstSlotIso, 'must skip the taken Tuesday slot');
  const d = new Date(secondResult);
  assert.equal(d.getDay(), 4, 'should fall through to Thursday');
});

test('nextOpenSlot skips datetimes inside quiet hours', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  // Quiet hours 08:00-18:00 (unusual but deterministic for the test) so a
  // 12:00 slot always falls inside it, and a 20:00 slot never does.
  updateSettings(db, { quiet_start: '08:00', quiet_end: '18:00' });

  createQueueSlot(db, { brand_id: brandId, platform: 'facebook', day_of_week: 3, time_local: '12:00' });
  createQueueSlot(db, { brand_id: brandId, platform: 'facebook', day_of_week: 3, time_local: '20:00' });

  const from = new Date('2026-07-19T00:00:00'); // Sunday
  const result = nextOpenSlot(db, brandId, 'facebook', from);
  assert.ok(result);
  const d = new Date(result);
  assert.equal(d.getHours(), 20, 'the 12:00 slot is inside quiet hours and must be skipped');

  resetQuietHours(db);
});

test('nextOpenSlot skips a same-day slot whose time has already passed', async () => {
  const db = getDb();
  resetQuietHours(db);
  const brandId = seedBrand(db);

  // Both slots on Wednesday: 09:00 (past by the time `from` is 14:00) and 16:00.
  createQueueSlot(db, { brand_id: brandId, platform: 'twitter', day_of_week: 3, time_local: '09:00' });
  createQueueSlot(db, { brand_id: brandId, platform: 'twitter', day_of_week: 3, time_local: '16:00' });

  const wednesdayAfternoon = new Date('2026-07-22T14:00:00'); // 2026-07-22 is a Wednesday
  const result = nextOpenSlot(db, brandId, 'twitter', wednesdayAfternoon);
  assert.ok(result);
  const d = new Date(result);
  assert.equal(d.getDay(), 3);
  assert.equal(d.getHours(), 16, 'the 09:00 slot already passed today and must roll to the 16:00 slot');
});

test('nextOpenSlot handles week rollover when every slot for the week is in the past or taken', async () => {
  const db = getDb();
  resetQuietHours(db);
  const brandId = seedBrand(db);

  // Single Monday 09:00 slot; ask starting Monday 10:00 (already past) ->
  // must roll all the way to next Monday.
  createQueueSlot(db, { brand_id: brandId, platform: 'instagram', day_of_week: 1, time_local: '09:00' });

  const mondayLate = new Date('2026-07-20T10:00:00'); // 2026-07-20 is a Monday
  const result = nextOpenSlot(db, brandId, 'instagram', mondayLate);
  assert.ok(result);
  const d = new Date(result);
  assert.equal(d.getDay(), 1);
  assert.equal(d.getHours(), 9);
  assert.ok(d.getTime() > mondayLate.getTime());
  const daysAhead = Math.round((d.getTime() - mondayLate.getTime()) / (24 * 60 * 60 * 1000));
  assert.equal(daysAhead, 7, 'should roll to the following Monday (7 days later at 09:00 vs 10:00 `from`)');
});

test('nextOpenSlot returns null when the brand/platform has no active slots', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const result = nextOpenSlot(db, brandId, 'youtube', new Date());
  assert.equal(result, null);
});

test('GET/POST/PATCH/DELETE /api/queue-slots contract', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const created = await app.inject({
    method: 'POST',
    url: '/api/queue-slots',
    payload: { brand_id: brandId, platform: 'facebook', day_of_week: 5, time_local: '10:00' },
  });
  assert.equal(created.statusCode, 201);
  const slot = created.json();
  assert.equal(slot.platform, 'facebook');

  const badCreate = await app.inject({
    method: 'POST',
    url: '/api/queue-slots',
    payload: { brand_id: brandId, platform: 'facebook', day_of_week: 8, time_local: '10:00' },
  });
  assert.equal(badCreate.statusCode, 400);

  const list = await app.inject({ method: 'GET', url: `/api/queue-slots?brand_id=${brandId}` });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/queue-slots/${slot.id}`,
    payload: { active: 0 },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().active, 0);

  const patchMissing = await app.inject({ method: 'PATCH', url: '/api/queue-slots/999999', payload: { active: 1 } });
  assert.equal(patchMissing.statusCode, 404);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/queue-slots/${slot.id}` });
  assert.equal(deleted.statusCode, 204);

  const deleteMissing = await app.inject({ method: 'DELETE', url: `/api/queue-slots/${slot.id}` });
  assert.equal(deleteMissing.statusCode, 404);

  await app.close();
});

test('POST /api/posts/:id/queue computes+sets publish_at and transitions draft -> scheduled_local', async () => {
  const app = buildServer();
  const db = getDb();
  resetQuietHours(db);
  const brandId = seedBrand(db);

  await app.inject({
    method: 'POST',
    url: '/api/queue-slots',
    payload: { brand_id: brandId, platform: 'linkedin', day_of_week: 2, time_local: '12:00' },
  });

  const postId = seedPost(db, { brand_id: brandId, platform: 'linkedin', status: 'draft' });

  const res = await app.inject({
    method: 'POST',
    url: `/api/posts/${postId}/queue`,
    payload: { from: '2026-07-19T00:00:00' }, // Sunday
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.publish_at);
  const d = new Date(body.publish_at);
  assert.equal(d.getDay(), 2);
  assert.equal(d.getHours(), 12);

  const updatedPost = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(updatedPost.publish_at, body.publish_at);
  assert.equal(updatedPost.status, 'scheduled_local');

  const missing = await app.inject({ method: 'POST', url: '/api/posts/999999/queue', payload: {} });
  assert.equal(missing.statusCode, 404);

  const noSlotsBrandId = seedBrand(db);
  const noSlotsPostId = seedPost(db, { brand_id: noSlotsBrandId, platform: 'linkedin', status: 'draft' });
  const noSlotsRes = await app.inject({ method: 'POST', url: `/api/posts/${noSlotsPostId}/queue`, payload: {} });
  assert.equal(noSlotsRes.statusCode, 422);
  assert.equal(noSlotsRes.json().error, 'no_open_slot');

  const submittedPostId = seedPost(db, { brand_id: brandId, platform: 'linkedin', status: 'submitted' });
  const notReschedulable = await app.inject({ method: 'POST', url: `/api/posts/${submittedPostId}/queue`, payload: {} });
  assert.equal(notReschedulable.statusCode, 409);

  await app.close();
});
