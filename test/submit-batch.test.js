// Tests for POST /api/posts/submit-batch, GET /api/posts/submit-batch/preview,
// POST /api/worker/run-now, and the computer-was-off catch-up behavior
// (startup sweep + missed_window flagging). In-memory DB, worker/sync
// disabled except where a test explicitly re-enables it — mirrors
// test/queue.test.js's isolation style.
//
// Run with: node --test test/submit-batch.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer by default
process.env.POSTDECK_SYNC_ENABLED = '0';
process.env.POSTDECK_WORKER_STARTUP_DELAY_MS = '20'; // fast startup sweep for the startup test

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const {
  resolveBatch,
  runSubmitBatch,
  runHandoffPhase,
  submitNow,
  isMissedWindow,
  MISSED_WINDOW_MSG,
  startWorker,
  stopWorker,
} = await import('../src/worker.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'Batch Test Brand', `batch-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedAccount(db, { brand_id, manual = 0 } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, blotato_account_id, manual, created_at, updated_at)
       VALUES (?, 'facebook', 'acct-1', ?, ?, ?)`
    )
    .run(brand_id, manual, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, { brand_id, account_id = null, platform = 'facebook', status = 'scheduled_local', publish_at, copy = 'hello' } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, '[]', '{}', ?, ?, ?, ?)`
    )
    .run(brand_id, account_id, platform, copy, publish_at, status, now, now);
  return info.lastInsertRowid;
}

function futureIso(hours) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}
function pastIso(hours) {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

test('resolveBatch: eligibility resolver — manual skip, wrong status, window filter', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const manualAcct = seedAccount(db, { brand_id: brandId, manual: 1 });
  const normalAcct = seedAccount(db, { brand_id: brandId, manual: 0 });

  const manualPost = seedPost(db, { brand_id: brandId, account_id: manualAcct, publish_at: futureIso(1) });
  const draftPost = seedPost(db, { brand_id: brandId, account_id: normalAcct, status: 'draft', publish_at: futureIso(1) });
  const outOfWindowPost = seedPost(db, { brand_id: brandId, account_id: normalAcct, publish_at: futureIso(48) });
  const eligiblePost = seedPost(db, { brand_id: brandId, account_id: normalAcct, publish_at: futureIso(2) });

  const from = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const to = futureIso(24);

  const { eligible, skipped } = resolveBatch(db, { scope: { from, to, brand_id: brandId } });

  assert.ok(eligible.some((p) => p.id === eligiblePost));
  assert.ok(!eligible.some((p) => p.id === manualPost));
  assert.ok(!eligible.some((p) => p.id === draftPost));
  assert.ok(!eligible.some((p) => p.id === outOfWindowPost));

  const reasonFor = (id) => (skipped.find((s) => s.id === id) || {}).reason;
  assert.equal(reasonFor(manualPost), 'manual');
  // draft/out-of-window posts aren't returned by the scope SQL at all (it
  // bounds status IN (...) and publish_at directly), so they just never
  // appear in either list — confirm absence rather than a mis-skip.
  assert.ok(!eligible.some((p) => p.id === draftPost) && !skipped.some((s) => s.id === draftPost));
  assert.ok(!eligible.some((p) => p.id === outOfWindowPost) && !skipped.some((s) => s.id === outOfWindowPost));
});

test('resolveBatch: wrong_status reason surfaces via post_ids mode (draft/submitted posts)', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const acct = seedAccount(db, { brand_id: brandId, manual: 0 });
  const draftPost = seedPost(db, { brand_id: brandId, account_id: acct, status: 'draft', publish_at: futureIso(1) });
  const submittedPost = seedPost(db, { brand_id: brandId, account_id: acct, status: 'submitted', publish_at: futureIso(1) });
  const noPublishAt = seedPost(db, { brand_id: brandId, account_id: acct, status: 'approved', publish_at: null });

  const { eligible, skipped } = resolveBatch(db, { post_ids: [draftPost, submittedPost, noPublishAt] });
  assert.equal(eligible.length, 0);
  const reasonFor = (id) => (skipped.find((s) => s.id === id) || {}).reason;
  assert.equal(reasonFor(draftPost), 'wrong_status');
  assert.equal(reasonFor(submittedPost), 'wrong_status');
  assert.equal(reasonFor(noPublishAt), 'no_publish_at');
});

test('resolveBatch: post_ids mode overrides the window filter but not manual/status', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const acct = seedAccount(db, { brand_id: brandId, manual: 0 });
  const farFuturePost = seedPost(db, { brand_id: brandId, account_id: acct, publish_at: futureIso(200) });

  const { eligible, skipped } = resolveBatch(db, { post_ids: [farFuturePost] });
  assert.equal(eligible.length, 1);
  assert.equal(eligible[0].id, farFuturePost);
  assert.equal(skipped.length, 0);
});

test('runSubmitBatch: batch response shape (dry-run)', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const acct = seedAccount(db, { brand_id: brandId, manual: 0 });
  const manualAcct = seedAccount(db, { brand_id: brandId, manual: 1 });

  const okPost = seedPost(db, { brand_id: brandId, account_id: acct, publish_at: futureIso(1) });
  const manualPost = seedPost(db, { brand_id: brandId, account_id: manualAcct, publish_at: futureIso(1) });

  const result = await runSubmitBatch(db, { post_ids: [okPost, manualPost] });

  assert.equal(result.attempted, 1);
  assert.equal(result.dry_run, true);
  assert.equal(result.submitted.length, 1);
  assert.equal(result.submitted[0].id, okPost);
  assert.equal(result.failed.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, 'manual');

  const row = db.prepare('SELECT status FROM posts WHERE id = ?').get(okPost);
  assert.equal(row.status, 'submitted_dry');
});

test('POST /api/posts/submit-batch and GET preview routes', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const acct = seedAccount(db, { brand_id: brandId, manual: 0 });
  const postA = seedPost(db, { brand_id: brandId, account_id: acct, publish_at: futureIso(1) });
  const postB = seedPost(db, { brand_id: brandId, account_id: acct, status: 'draft', publish_at: futureIso(1) });

  // invalid body: neither post_ids nor scope
  const badBody = await app.inject({ method: 'POST', url: '/api/posts/submit-batch', payload: {} });
  assert.equal(badBody.statusCode, 400);

  // invalid body: both provided
  const bothBody = await app.inject({
    method: 'POST',
    url: '/api/posts/submit-batch',
    payload: { post_ids: [postA], scope: { from: pastIso(1), to: futureIso(1) } },
  });
  assert.equal(bothBody.statusCode, 400);

  const from = pastIso(1);
  const to = futureIso(24);

  const preview = await app.inject({
    method: 'GET',
    url: `/api/posts/submit-batch/preview?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&brand_id=${brandId}`,
  });
  assert.equal(preview.statusCode, 200);
  const previewBody = preview.json();
  assert.ok(previewBody.eligible.some((p) => p.id === postA));
  // postB is a draft — excluded by the scope SQL's status filter directly,
  // so it's simply absent (not surfaced as a 'wrong_status' skip here; that
  // reason only fires in post_ids mode, covered above).
  assert.ok(!previewBody.eligible.some((p) => p.id === postB));
  assert.ok(!previewBody.skipped.some((s) => s.id === postB));
  assert.equal(previewBody.dry_run, true);

  const submit = await app.inject({
    method: 'POST',
    url: '/api/posts/submit-batch',
    payload: { scope: { from, to, brand_id: brandId } },
  });
  assert.equal(submit.statusCode, 200);
  const submitBody = submit.json();
  assert.equal(submitBody.attempted, 1);
  assert.equal(submitBody.submitted[0].id, postA);
  assert.equal(submitBody.dry_run, true);

  await app.close();
});

test('POST /api/worker/run-now: contract + overlap guard', async () => {
  const app = buildServer();
  const first = await app.inject({ method: 'POST', url: '/api/worker/run-now' });
  assert.equal(first.statusCode, 200);
  const body = first.json();
  assert.ok('handoffCount' in body);
  assert.ok('verifyCount' in body);
  assert.ok('imagesImported' in body);

  // Fire two concurrently — one should win, the other should see 409 busy
  // (or both succeed sequentially; assert we never see an unhandled crash
  // and that a 409 is a valid possible outcome).
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/worker/run-now' }),
    app.inject({ method: 'POST', url: '/api/worker/run-now' }),
  ]);
  const codes = [a.statusCode, b.statusCode].sort();
  assert.ok(codes.every((c) => c === 200 || c === 409));

  await app.close();
});

test('missed_window: past-due scheduled_local post gets flagged, not submitted, by the handoff sweep', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const acct = seedAccount(db, { brand_id: brandId, manual: 0 });
  const missedPost = seedPost(db, { brand_id: brandId, account_id: acct, publish_at: pastIso(2) });
  const onTimePost = seedPost(db, { brand_id: brandId, account_id: acct, publish_at: futureIso(1) });

  const before = db.prepare('SELECT * FROM posts WHERE id = ?').get(missedPost);
  assert.equal(isMissedWindow(before), true);

  const handoffCount = await runHandoffPhase(db);

  const after = db.prepare('SELECT * FROM posts WHERE id = ?').get(missedPost);
  assert.equal(after.status, 'scheduled_local');
  assert.equal(after.error_message, MISSED_WINDOW_MSG);

  const onTimeAfter = db.prepare('SELECT * FROM posts WHERE id = ?').get(onTimePost);
  assert.equal(onTimeAfter.status, 'submitted_dry');
  assert.equal(handoffCount, 1); // only the on-time post was actually handed off

  // submit-batch preview/submit should also skip it as missed_window, not manual/wrong_status
  const { eligible, skipped } = resolveBatch(db, { post_ids: [missedPost] });
  assert.equal(eligible.length, 0);
  assert.equal(skipped[0].reason, 'missed_window');
});

test('missed_window: explicit submitNow still works on a flagged post and clears the flag', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const acct = seedAccount(db, { brand_id: brandId, manual: 0 });
  const missedPost = seedPost(db, { brand_id: brandId, account_id: acct, publish_at: pastIso(3) });

  await runHandoffPhase(db); // flags it
  const flagged = db.prepare('SELECT * FROM posts WHERE id = ?').get(missedPost);
  assert.equal(flagged.error_message, MISSED_WINDOW_MSG);

  const result = await submitNow(missedPost);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'submitted_dry');

  const after = db.prepare('SELECT * FROM posts WHERE id = ?').get(missedPost);
  assert.equal(after.status, 'submitted_dry');
  assert.equal(after.error_message, null);
});

test('startup sweep: startWorker runs one cycle shortly after boot (once), guarded from overlap', async () => {
  const originalEnv = process.env.POSTDECK_WORKER;
  process.env.POSTDECK_WORKER = '1';
  try {
    const handle = startWorker();
    assert.ok(handle, 'startWorker should return an interval handle when enabled');

    const db = getDb();
    const brandId = seedBrand(db);
    const acct = seedAccount(db, { brand_id: brandId, manual: 0 });
    // seed a post before the sweep fires, so we can observe it got picked up.
    const postId = seedPost(db, { brand_id: brandId, account_id: acct, publish_at: futureIso(1) });

    // startup delay is 20ms in this test env; wait comfortably past it.
    await new Promise((resolve) => setTimeout(resolve, 250));

    const row = db.prepare('SELECT status FROM posts WHERE id = ?').get(postId);
    assert.equal(row.status, 'submitted_dry', 'startup sweep should have handed the post off');
  } finally {
    stopWorker();
    process.env.POSTDECK_WORKER = originalEnv;
  }
});
