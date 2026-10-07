// Audit 2026-10-07 T7: the missed-window flag only applies after a 15-minute
// grace, never overwrites a real handoff error, is exposed as a derived
// `missed_window` boolean on GET /api/posts, and approving a post due within
// 10 minutes hands it off immediately (only when the worker is enabled).
//
// Run with: node --test test/missed-window.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { isMissedWindow, runHandoffPhase, kickHandoffIfDue, MISSED_WINDOW_MSG } = await import('../src/worker.js');

function seed(db, { status = 'scheduled_local', publish_at, error_message = null } = {}) {
  const now = nowIso();
  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('MW Brand', `mw-${Math.random()}`, now, now);
  const acct = db
    .prepare(`INSERT INTO accounts (brand_id, platform, blotato_account_id, created_at, updated_at) VALUES (?, 'linkedin', 'a1', ?, ?)`)
    .run(brand.lastInsertRowid, now, now);
  return db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, error_message, created_at, updated_at)
       VALUES (?, ?, 'linkedin', 'hi', '[]', '{}', ?, ?, ?, ?, ?)`
    )
    .run(brand.lastInsertRowid, acct.lastInsertRowid, publish_at, status, error_message, now, now).lastInsertRowid;
}
const minFromNow = (m) => new Date(Date.now() + m * 60 * 1000).toISOString();
const row = (db, id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withWorkerEnabled(fn) {
  process.env.POSTDECK_WORKER = '1';
  try {
    return await fn();
  } finally {
    process.env.POSTDECK_WORKER = '0';
  }
}

test('isMissedWindow: 10 minutes late is inside the grace, 20 minutes late is missed', () => {
  assert.equal(isMissedWindow({ status: 'scheduled_local', publish_at: minFromNow(-10) }), false);
  assert.equal(isMissedWindow({ status: 'scheduled_local', publish_at: minFromNow(-20) }), true);
  assert.equal(isMissedWindow({ status: 'scheduled_local', publish_at: minFromNow(5) }), false);
  assert.equal(isMissedWindow({ status: 'draft', publish_at: minFromNow(-60) }), false);
  // legacy-format timestamps are compared as dates
  const legacy = new Date(Date.now() - 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  assert.equal(isMissedWindow({ status: 'scheduled_local', publish_at: legacy }), true);
});

test('sweep hands off a post that is a few minutes late instead of flagging it', async () => {
  const db = getDb();
  const id = seed(db, { publish_at: minFromNow(-3) });
  await runHandoffPhase(db);
  const after = row(db, id);
  assert.equal(after.status, 'submitted_dry');
  assert.equal(after.error_message, null);
});

test('missed-window flag never overwrites a real handoff error', async () => {
  const db = getDb();
  const withErr = seed(db, { publish_at: minFromNow(-120), error_message: 'Blotato returned 500' });
  const noErr = seed(db, { publish_at: minFromNow(-120) });
  await runHandoffPhase(db);
  assert.equal(row(db, withErr).error_message, 'Blotato returned 500');
  assert.equal(row(db, noErr).error_message, MISSED_WINDOW_MSG);
  assert.equal(row(db, withErr).status, 'scheduled_local', 'still not sent');
});

test('GET /api/posts and /api/posts/:id expose a derived missed_window boolean', async () => {
  const app = buildServer();
  const db = getDb();
  const missed = seed(db, { publish_at: minFromNow(-60), error_message: 'Blotato returned 500' });
  const onTime = seed(db, { publish_at: minFromNow(60) });
  const grace = seed(db, { publish_at: minFromNow(-5) });
  const list = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  const by = (id) => list.find((p) => p.id === id);
  assert.equal(by(missed).missed_window, true, 'derived from time even though error_message is not the flag');
  assert.equal(by(onTime).missed_window, false);
  assert.equal(by(grace).missed_window, false);
  const one = (await app.inject({ method: 'GET', url: `/api/posts/${missed}` })).json();
  assert.equal(one.missed_window, true);
  await app.close();
});

test('approving a post due in 3 minutes hands it off right away (worker enabled)', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seed(db, { status: 'draft', publish_at: minFromNow(3) });
  await withWorkerEnabled(async () => {
    const res = await app.inject({ method: 'PATCH', url: `/api/posts/${id}`, payload: { status: 'approved' } });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'scheduled_local', 'response is not blocked on the handoff');
    for (let i = 0; i < 40 && row(db, id).status === 'scheduled_local'; i++) await sleep(25);
  });
  assert.equal(row(db, id).status, 'submitted_dry');
  await app.close();
});

test('approve-batch also kicks off due posts, but not ones more than 10 minutes out', async () => {
  const app = buildServer();
  const db = getDb();
  const soon = seed(db, { status: 'draft', publish_at: minFromNow(4) });
  const later = seed(db, { status: 'draft', publish_at: minFromNow(120) });
  await withWorkerEnabled(async () => {
    const res = await app.inject({ method: 'POST', url: '/api/posts/approve-batch', payload: { post_ids: [soon, later] } });
    assert.equal(res.statusCode, 200);
    for (let i = 0; i < 40 && row(db, soon).status === 'scheduled_local'; i++) await sleep(25);
  });
  assert.equal(row(db, soon).status, 'submitted_dry');
  assert.equal(row(db, later).status, 'scheduled_local');
  await app.close();
});

test('no immediate handoff when the worker is disabled', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seed(db, { status: 'draft', publish_at: minFromNow(3) });
  const res = await app.inject({ method: 'PATCH', url: `/api/posts/${id}`, payload: { status: 'approved' } });
  assert.equal(res.statusCode, 200);
  await sleep(100);
  assert.equal(row(db, id).status, 'scheduled_local');
  assert.equal(kickHandoffIfDue(db, id), null);
  await app.close();
});

test('kickHandoffIfDue skips missed-window posts and logs (does not throw) on handoff errors', async () => {
  const db = getDb();
  const missed = seed(db, { publish_at: minFromNow(-60) });
  await withWorkerEnabled(async () => {
    assert.equal(kickHandoffIfDue(db, missed), null);
    const due = seed(db, { publish_at: minFromNow(2) });
    // Break the row out from under the handoff: delete it between kick and run.
    const p = kickHandoffIfDue(db, due);
    db.prepare('DELETE FROM posts WHERE id = ?').run(due);
    await assert.doesNotReject(p);
  });
});
