// Audit 2026-10-07 T2: verify reads publicUrl, polls with backoff for 24h from
// the first poll (no early give-up), gives up with a real error_message, and
// POST /api/posts/:id/recheck resolves failed_verify posts by hand. Also the
// failed / failed_verify -> draft|canceled transitions. Local mock Blotato only.
//
// Run with: node --test test/verify-recheck.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.BLOTATO_DRY_RUN = '0';
process.env.BLOTATO_API_KEY = 'test-key';
process.env.POSTDECK_DB_PATH = ':memory:';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

// What GET /v2/posts/:id returns next.
const mock = { body: { status: 'in-progress' }, httpStatus: 200, polls: 0 };

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v2/posts/') && req.method === 'GET') {
    mock.polls += 1;
    res.writeHead(mock.httpStatus, { 'content-type': 'application/json' });
    res.end(JSON.stringify(mock.body));
    return;
  }
  res.writeHead(404);
  res.end('not found');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
process.env.BLOTATO_API_BASE = `http://127.0.0.1:${server.address().port}`;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { verifyOne, runVerifyPhase } = await import('../src/worker.js');

test.after(() => server.close());

function seedPost(db, o = {}) {
  const now = nowIso();
  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Verify Brand', `vb-${Math.random()}`, now, now);
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status,
         blotato_submission_id, verify_attempts, verify_started_at, updated_at, created_at)
       VALUES (@brand_id, 'linkedin', 'x', '[]', '{}', @publish_at, @status, @sub, @va, @vs, @updated_at, @now)`
    )
    .run({
      brand_id: brand.lastInsertRowid,
      publish_at: o.publish_at ?? new Date(Date.now() - 5 * 60 * 1000).toISOString(),
      status: o.status ?? 'submitted',
      sub: o.sub === undefined ? 'sub_1' : o.sub,
      va: o.va ?? 0,
      vs: o.vs ?? null,
      updated_at: o.updated_at ?? now,
      now,
    });
  return info.lastInsertRowid;
}
const getPost = (db, id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

test('verify reads publicUrl (camelCase) and stores last_remote_state', async () => {
  const db = getDb();
  const id = seedPost(db);
  mock.body = { status: 'published', publicUrl: 'https://www.linkedin.com/feed/update/urn:li:share:1' };
  await verifyOne(db, getPost(db, id));
  const row = getPost(db, id);
  assert.equal(row.status, 'published');
  assert.equal(row.public_url, 'https://www.linkedin.com/feed/update/urn:li:share:1');
  assert.equal(row.last_remote_state, 'published');
});

test('verify still accepts public_url / url fallbacks', async () => {
  const db = getDb();
  const a = seedPost(db);
  mock.body = { status: 'published', public_url: 'https://x.example/a' };
  await verifyOne(db, getPost(db, a));
  assert.equal(getPost(db, a).public_url, 'https://x.example/a');
  const b = seedPost(db);
  mock.body = { status: 'published', url: 'https://x.example/b' };
  await verifyOne(db, getPost(db, b));
  assert.equal(getPost(db, b).public_url, 'https://x.example/b');
});

test('verify: first poll stamps verify_started_at; no early give-up after 6 polls or when publish_at is hours old', async () => {
  const db = getDb();
  // publish_at 10h ago and 6 polls already done: the old code gave up here.
  const id = seedPost(db, { publish_at: hoursAgo(10), va: 6 });
  mock.body = { status: 'in-progress' };
  await verifyOne(db, getPost(db, id));
  const row = getPost(db, id);
  assert.equal(row.status, 'submitted');
  assert.equal(row.verify_attempts, 7);
  assert.ok(row.verify_started_at, 'verify_started_at set on first poll');
  assert.equal(row.last_remote_state, 'in-progress');
  // second poll keeps the original start time
  const started = row.verify_started_at;
  await verifyOne(db, getPost(db, id));
  assert.equal(getPost(db, id).verify_started_at, started);
});

test('verify: gives up 24h after the first poll with a real error_message and the last state', async () => {
  const db = getDb();
  const id = seedPost(db, { vs: hoursAgo(24.5), va: 40, updated_at: hoursAgo(1) });
  mock.body = { status: 'in-progress' };
  await verifyOne(db, getPost(db, id));
  const row = getPost(db, id);
  assert.equal(row.status, 'failed_verify');
  assert.equal(row.error_message, "Blotato still reported 'in-progress' after 24h. Check the account - it may be live.");
  assert.equal(row.last_remote_state, 'in-progress');
});

test('verify: a poll error before 24h is retried, not abandoned', async () => {
  const db = getDb();
  const id = seedPost(db, { vs: hoursAgo(2), va: 8, updated_at: hoursAgo(1) });
  mock.httpStatus = 404;
  mock.body = { message: 'nope' };
  try {
    await verifyOne(db, getPost(db, id));
  } finally {
    mock.httpStatus = 200;
  }
  const row = getPost(db, id);
  assert.equal(row.status, 'submitted');
  assert.ok(row.error_message);
});

test('verify backoff: every cycle in the first hour, then at most every 30 minutes', async () => {
  const db = getDb();
  mock.body = { status: 'in-progress' };

  // 30 min after the first poll, last polled 5 min ago: polls.
  const fast = seedPost(db, { vs: new Date(Date.now() - 30 * 60 * 1000).toISOString(), va: 6, updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
  mock.polls = 0;
  await verifyOne(db, getPost(db, fast));
  assert.equal(mock.polls, 1);

  // 3h in, last polled 5 min ago: skipped.
  const slowSkip = seedPost(db, { vs: hoursAgo(3), va: 20, updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString() });
  mock.polls = 0;
  await verifyOne(db, getPost(db, slowSkip));
  assert.equal(mock.polls, 0, 'no poll inside the 30 min slow interval');
  assert.equal(getPost(db, slowSkip).verify_attempts, 20);

  // 3h in, last polled 31 min ago: polls.
  const slowPoll = seedPost(db, { vs: hoursAgo(3), va: 20, updated_at: new Date(Date.now() - 31 * 60 * 1000).toISOString() });
  mock.polls = 0;
  await verifyOne(db, getPost(db, slowPoll));
  assert.equal(mock.polls, 1);
});

test('verify: a submitted post with no submission id goes to failed_verify without polling', async () => {
  const db = getDb();
  const id = seedPost(db, { sub: null });
  mock.polls = 0;
  await verifyOne(db, getPost(db, id));
  const row = getPost(db, id);
  assert.equal(row.status, 'failed_verify');
  assert.match(row.error_message, /no Blotato submission id/i);
  assert.equal(mock.polls, 0);
});

test('runVerifyPhase picks up legacy-format publish_at by date, not string order', async () => {
  const db = getDb();
  // 'YYYY-MM-DD HH:MM:SS' sorts before any 'T' timestamp on the same day as a
  // string, which made string comparison wrong; as a date it is 2h ago.
  const legacy = new Date(Date.now() - 2 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const id = seedPost(db, { publish_at: legacy });
  mock.body = { status: 'published', publicUrl: 'https://x.example/legacy' };
  await runVerifyPhase(db);
  assert.equal(getPost(db, id).status, 'published');
});

// ---------- recheck route ----------

test('recheck: failed_verify + Blotato published -> published with public_url', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, { status: 'failed_verify', va: 6 });
  mock.body = { status: 'published', publicUrl: 'https://www.linkedin.com/posts/live' };
  const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/recheck` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.blotato_state, 'published');
  assert.equal(body.post.status, 'published');
  assert.equal(body.post.public_url, 'https://www.linkedin.com/posts/live');
  await app.close();
});

test('recheck: Blotato failed -> failed with message', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, { status: 'failed_verify' });
  mock.body = { status: 'failed', errorMessage: 'Page not connected' };
  const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/recheck` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().post.status, 'failed');
  assert.equal(res.json().post.error_message, 'Page not connected');
  await app.close();
});

test('recheck: still in progress -> back to submitted with counters reset', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, { status: 'failed_verify', va: 50, vs: hoursAgo(30) });
  db.prepare('UPDATE posts SET error_message = ? WHERE id = ?').run('old give-up', id);
  mock.body = { status: 'in-progress' };
  const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/recheck` });
  assert.equal(res.statusCode, 200);
  const { post, blotato_state } = res.json();
  assert.equal(blotato_state, 'in-progress');
  assert.equal(post.status, 'submitted');
  assert.equal(post.verify_attempts, 0);
  assert.equal(post.verify_started_at, null);
  assert.equal(post.error_message, null);
  assert.equal(post.last_remote_state, 'in-progress');
  await app.close();
});

test('recheck: 404, wrong status, and missing submission id', async () => {
  const app = buildServer();
  const db = getDb();
  assert.equal((await app.inject({ method: 'POST', url: '/api/posts/999999/recheck' })).statusCode, 404);

  const draft = seedPost(db, { status: 'draft' });
  const wrong = await app.inject({ method: 'POST', url: `/api/posts/${draft}/recheck` });
  assert.equal(wrong.statusCode, 409);
  assert.equal(wrong.json().error, 'wrong_status');

  const noId = seedPost(db, { status: 'failed_verify', sub: null });
  mock.polls = 0;
  const res = await app.inject({ method: 'POST', url: `/api/posts/${noId}/recheck` });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'no_submission_id');
  assert.equal(mock.polls, 0);
  await app.close();
});

test('recheck: Blotato unreachable -> 502 and the post is left untouched', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, { status: 'failed_verify', va: 6 });
  mock.httpStatus = 404;
  mock.body = { message: 'gone' };
  try {
    const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/recheck` });
    assert.equal(res.statusCode, 502);
  } finally {
    mock.httpStatus = 200;
  }
  assert.equal(getPost(db, id).status, 'failed_verify');
  await app.close();
});

test('recheck in dry-run polls nothing and returns the post unchanged', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, { status: 'failed_verify' });
  process.env.BLOTATO_DRY_RUN = '1';
  mock.polls = 0;
  try {
    const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/recheck` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().blotato_state, 'dry_run');
    assert.equal(res.json().post.status, 'failed_verify');
    assert.equal(mock.polls, 0);
  } finally {
    process.env.BLOTATO_DRY_RUN = '0';
  }
  await app.close();
});

// ---------- transitions ----------

test('failed and failed_verify can move to draft or canceled (publish_at may be cleared); not to approved', async () => {
  const app = buildServer();
  const db = getDb();
  for (const from of ['failed', 'failed_verify']) {
    const toDraft = seedPost(db, { status: from });
    const r1 = await app.inject({ method: 'PATCH', url: `/api/posts/${toDraft}`, payload: { status: 'draft', publish_at: null } });
    assert.equal(r1.statusCode, 200, from);
    assert.equal(r1.json().status, 'draft');
    assert.equal(r1.json().publish_at, null);

    const toCancel = seedPost(db, { status: from });
    const r2 = await app.inject({ method: 'PATCH', url: `/api/posts/${toCancel}`, payload: { status: 'canceled' } });
    assert.equal(r2.statusCode, 200);

    const bad = seedPost(db, { status: from });
    const r3 = await app.inject({ method: 'PATCH', url: `/api/posts/${bad}`, payload: { status: 'approved' } });
    assert.equal(r3.statusCode, 409);
  }
  await app.close();
});

test('GET /api/posts rows carry last_remote_state', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, { status: 'failed_verify' });
  db.prepare('UPDATE posts SET last_remote_state = ? WHERE id = ?').run('in-progress', id);
  const list = (await app.inject({ method: 'GET', url: '/api/posts' })).json();
  assert.equal(list.find((p) => p.id === id).last_remote_state, 'in-progress');
  const one = (await app.inject({ method: 'GET', url: `/api/posts/${id}` })).json();
  assert.equal(one.last_remote_state, 'in-progress');
  await app.close();
});
