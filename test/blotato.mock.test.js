// Blotato worker integration test against a local mock server that imitates
// the real API shape (media upload, create-post with root-level
// scheduledTime, status polling). BLOTATO_DRY_RUN is forced to '0' here so
// the real code path in src/blotato.js + src/worker.js is exercised against
// this LOCAL mock only - never the real Blotato API.
//
// Run with: node --test test/blotato.mock.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

process.env.BLOTATO_DRY_RUN = '0';
process.env.BLOTATO_API_KEY = 'test-key';
process.env.POSTDECK_DB_PATH = ':memory:';

let statusCallCount = 0;

function startMockServer() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const url = req.url;

      if (url === '/v2/media' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'media_123', url: 'https://cdn.example.com/media_123.png' }));
        return;
      }

      if (url === '/v2/posts' && req.method === 'POST') {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end('bad json');
          return;
        }
        // Assert scheduledTime is root-level, NOT nested inside `post`.
        if (!parsed.scheduledTime || parsed.post?.scheduledTime) {
          res.writeHead(422, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'scheduledTime must be root-level, not nested in post' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ postSubmissionId: 'sub_abc123' }));
        return;
      }

      if (url.startsWith('/v2/posts/') && req.method === 'GET') {
        statusCallCount += 1;
        if (statusCallCount < 2) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'in-progress' }));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ status: 'published', public_url: 'https://twitter.com/x/status/999' })
          );
        }
        return;
      }

      res.writeHead(404);
      res.end('not found');
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('worker HANDOFF then VERIFY against a mock Blotato server', async (t) => {
  const server = await startMockServer();
  const { address, port } = server.address();
  process.env.BLOTATO_API_BASE = `http://${address}:${port}`;

  t.after(() => {
    server.close();
  });

  // Import AFTER env vars are set - modules read env at call-time here (not
  // at import time) so this ordering isn't strictly required, but keep it
  // for clarity and to avoid any accidental module-level caching surprises.
  const { getDb, nowIso } = await import('../src/db.js');
  const worker = await import('../src/worker.js');

  const db = getDb();
  const now = nowIso();

  const brand = db
    .prepare(
      `INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`
    )
    .run('Test Brand', 'test-brand', now, now);

  const account = db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, blotato_account_id, target_fields, active, created_at, updated_at)
       VALUES (?, 'twitter', 'acct_123', '{"targetType":"twitter"}', 1, ?, ?)`
    )
    .run(brand.lastInsertRowid, now, now);

  const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1h from now, inside default 48h window

  const postInfo = db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, 'twitter', 'Hello world', '[]', '{}', ?, 'scheduled_local', ?, ?)`
    )
    .run(brand.lastInsertRowid, account.lastInsertRowid, publishAt, now, now);
  const postId = postInfo.lastInsertRowid;

  // --- HANDOFF ---
  const handoffCount = await worker.runHandoffPhase(db);
  assert.equal(handoffCount, 1, 'expected exactly one post in the handoff window');

  let row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(row.status, 'submitted', 'post should be submitted after handoff');
  assert.equal(row.blotato_submission_id, 'sub_abc123');

  // --- VERIFY (simulate publish_at already passed) ---
  db.prepare(`UPDATE posts SET publish_at = ? WHERE id = ?`).run(
    new Date(Date.now() - 5000).toISOString(),
    postId
  );

  await worker.runVerifyPhase(db);
  row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(row.status, 'submitted', 'first verify poll should still be in-progress');

  await worker.runVerifyPhase(db);
  row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(row.status, 'published', 'second verify poll should resolve to published');
  assert.equal(row.public_url, 'https://twitter.com/x/status/999');
});

test('worker HANDOFF skips reddit posts - never submitted to Blotato', async (t) => {
  const server = await startMockServer();
  const { address, port } = server.address();
  process.env.BLOTATO_API_BASE = `http://${address}:${port}`;
  let postsCallCount = 0;
  server.on('request', (req) => {
    if (req.url === '/v2/posts' && req.method === 'POST') postsCallCount += 1;
  });

  t.after(() => {
    server.close();
  });

  const { getDb, nowIso } = await import('../src/db.js');
  const worker = await import('../src/worker.js');

  const db = getDb();
  const now = nowIso();

  const brand = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Reddit Test Brand', `reddit-brand-${Math.random()}`, now, now);

  // Reddit account: no Blotato connection (blotato_account_id NULL) - see
  // SPEC.md "Platform lineup" (assisted-manual, not a Blotato target).
  const account = db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, blotato_account_id, target_fields, active, created_at, updated_at)
       VALUES (?, 'reddit', NULL, '{"username":"testuser"}', 1, ?, ?)`
    )
    .run(brand.lastInsertRowid, now, now);

  const publishAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const postInfo = db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, 'reddit', 'body text', '[]', '{"subreddit":"test","title":"hello"}', ?, 'scheduled_local', ?, ?)`
    )
    .run(brand.lastInsertRowid, account.lastInsertRowid, publishAt, now, now);
  const postId = postInfo.lastInsertRowid;

  const handoffCount = await worker.runHandoffPhase(db);
  assert.equal(handoffCount, 0, 'reddit post must not be picked up by the handoff sweep');
  assert.equal(postsCallCount, 0, 'Blotato /v2/posts must never be called for a reddit post');

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(row.status, 'scheduled_local', 'reddit post stays scheduled_local - worker never touches it');

  const submitResult = await worker.submitNow(postId);
  assert.equal(submitResult.ok, false, '"submit now" must also refuse reddit posts');
  assert.equal(postsCallCount, 0, 'Blotato /v2/posts must still never be called for a reddit post');
});
