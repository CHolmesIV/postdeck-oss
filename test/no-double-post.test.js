// Double-post guard (audit 2026-10-07 T1). Blotato cannot delete, so a post
// creation that may have gone through must never be resent automatically.
// Runs the real src/blotato.js + src/worker.js against a LOCAL mock only.
//
// Run with: node --test test/no-double-post.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.BLOTATO_DRY_RUN = '0';
process.env.BLOTATO_API_KEY = 'test-key';
process.env.POSTDECK_DB_PATH = ':memory:';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

// mode for POST /v2/posts: 'ok' | 'drop' | '500' | 'noid' | '429-then-ok'
// mediaMode for POST /v2/media: 'ok' | 'drop-once'
const mock = { mode: 'ok', mediaMode: 'ok', postCalls: 0, mediaCalls: 0 };

function resetMock(mode, mediaMode = 'ok') {
  Object.assign(mock, { mode, mediaMode, postCalls: 0, mediaCalls: 0 });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url === '/v2/media' && req.method === 'POST') {
      mock.mediaCalls += 1;
      if (mock.mediaMode === 'drop-once' && mock.mediaCalls === 1) {
        req.socket.destroy();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'm1', url: 'https://cdn.example.com/m1.png' }));
      return;
    }
    if (req.url === '/v2/posts' && req.method === 'POST') {
      mock.postCalls += 1;
      if (mock.mode === 'drop') {
        req.socket.destroy(); // Blotato may or may not have acted on it
        return;
      }
      if (mock.mode === '500') {
        res.writeHead(502, { 'content-type': 'text/plain' });
        res.end('bad gateway');
        return;
      }
      if (mock.mode === '429-then-ok' && mock.postCalls === 1) {
        res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '0' });
        res.end('slow down');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(mock.mode === 'noid' ? { ok: true } : { postSubmissionId: 'sub_1' }));
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.BLOTATO_API_BASE = `http://127.0.0.1:${server.address().port}`;
test.after(() => server.close());

const { getDb, nowIso } = await import('../src/db.js');
const worker = await import('../src/worker.js');
const { buildServer } = await import('../src/server.js');
const db = getDb();

function seedScheduledPost({ media = [] } = {}) {
  const now = nowIso();
  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Double Post Brand', `dp-${Math.random()}`, now, now);
  const account = db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, blotato_account_id, target_fields, active, created_at, updated_at)
       VALUES (?, 'linkedin', 'acct_1', '{"targetType":"linkedin"}', 1, ?, ?)`
    )
    .run(brand.lastInsertRowid, now, now);
  const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, 'linkedin', 'Hello', ?, '{}', ?, 'scheduled_local', ?, ?)`
    )
    .run(brand.lastInsertRowid, account.lastInsertRowid, JSON.stringify(media), publishAt, now, now);
  return info.lastInsertRowid;
}

const getPost = (id) => db.prepare('SELECT * FROM posts WHERE id = ?').get(id);

// Each test only cares about its own post; clear the rest out of the sweep.
function isolate(id) {
  db.prepare(`UPDATE posts SET status = 'canceled' WHERE id != ? AND status = 'scheduled_local'`).run(id);
}

test('dropped connection on create: one attempt, needs_check, never resent by later sweeps', async () => {
  resetMock('drop');
  const id = seedScheduledPost();
  isolate(id);

  await worker.runHandoffPhase(db);
  assert.equal(mock.postCalls, 1, 'post creation must not be retried');
  const row = getPost(id);
  assert.equal(row.status, 'needs_check');
  assert.match(row.error_message, /^needs_check: Blotato may have published this/);

  await worker.runHandoffPhase(db);
  await worker.runHandoffPhase(db);
  assert.equal(mock.postCalls, 1, 'later sweeps must leave needs_check alone');
});

test('5xx on create: one attempt, needs_check', async () => {
  resetMock('500');
  const id = seedScheduledPost();
  isolate(id);

  await worker.runHandoffPhase(db);
  assert.equal(mock.postCalls, 1);
  assert.equal(getPost(id).status, 'needs_check');
});

test('submitNow on a dropped create also lands in needs_check, single attempt', async () => {
  resetMock('drop');
  const id = seedScheduledPost();
  isolate(id);

  const result = await worker.submitNow(id);
  assert.equal(result.status, 'needs_check');
  assert.equal(mock.postCalls, 1);
});

test('2xx with no submission id: needs_check instead of submitted-with-null', async () => {
  resetMock('noid');
  const id = seedScheduledPost();
  isolate(id);

  await worker.runHandoffPhase(db);
  const row = getPost(id);
  assert.equal(row.status, 'needs_check');
  assert.equal(row.blotato_submission_id, null);
  assert.match(row.error_message, /no submission id/);
});

test('429 on create is still retried: the request was rejected, nothing was posted', async () => {
  resetMock('429-then-ok');
  const id = seedScheduledPost();
  isolate(id);

  await worker.runHandoffPhase(db);
  assert.equal(mock.postCalls, 2);
  const row = getPost(id);
  assert.equal(row.status, 'submitted');
  assert.equal(row.blotato_submission_id, 'sub_1');
});

test('media upload keeps its retry (a duplicate upload is invisible)', async () => {
  resetMock('ok', 'drop-once');
  const id = seedScheduledPost({ media: [{ url: 'https://example.com/a.png' }] });
  isolate(id);

  await worker.runHandoffPhase(db);
  assert.equal(mock.mediaCalls, 2, 'media upload retried once after the drop');
  assert.equal(mock.postCalls, 1);
  assert.equal(getPost(id).status, 'submitted');
});

test('needs_check can be walked back to draft (time cleared) and canceled, but not approved', async () => {
  const app = buildServer();
  const id = seedScheduledPost();
  db.prepare(`UPDATE posts SET status = 'needs_check' WHERE id = ?`).run(id);

  const approve = await app.inject({ method: 'PATCH', url: `/api/posts/${id}`, payload: { status: 'approved' } });
  assert.equal(approve.statusCode, 409, 'no straight resend path out of needs_check');

  const toDraft = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${id}`,
    payload: { status: 'draft', publish_at: null },
  });
  assert.equal(toDraft.statusCode, 200);
  assert.equal(toDraft.json().status, 'draft');
  assert.equal(toDraft.json().publish_at, null);
  await app.close();
});

test('needs_check can be resolved as posted with the live URL', async () => {
  const app = buildServer();
  const id = seedScheduledPost();
  db.prepare(`UPDATE posts SET status = 'needs_check' WHERE id = ?`).run(id);

  const res = await app.inject({
    method: 'POST',
    url: `/api/posts/${id}/mark-posted`,
    payload: { public_url: 'https://www.linkedin.com/feed/update/urn:li:activity:1' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'published');
  assert.equal(res.json().error_message, null);
  await app.close();
});
