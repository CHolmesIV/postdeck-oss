// Manual publication reconciliation must update PostDeck only. It never calls
// Blotato and is available when CB published a connected-account post by hand.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedPost(db, status = 'draft') {
  const now = nowIso();
  return db.prepare(
    `INSERT INTO posts (platform, copy, media, platform_fields, status, created_at, updated_at)
     VALUES ('linkedin', 'already posted by hand', '[]', '{}', ?, ?, ?)`
  ).run(status, now, now).lastInsertRowid;
}

test('a connected-platform draft can be marked posted without a Blotato submission', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, 'draft');

  const res = await app.inject({
    method: 'POST',
    url: `/api/posts/${id}/mark-posted`,
    payload: { public_url: 'https://www.linkedin.com/feed/update/test-post' },
  });

  assert.equal(res.statusCode, 200);
  const row = db.prepare('SELECT status, public_url, blotato_submission_id FROM posts WHERE id = ?').get(id);
  assert.equal(row.status, 'published');
  assert.equal(row.public_url, 'https://www.linkedin.com/feed/update/test-post');
  assert.equal(row.blotato_submission_id, null, 'manual reconciliation must not create a Blotato submission');
  const event = db.prepare("SELECT kind, meta FROM usage_events WHERE kind = 'manual_publish' ORDER BY id DESC LIMIT 1").get();
  assert.equal(event.kind, 'manual_publish');
  assert.equal(JSON.parse(event.meta).post_id, Number(id));
  await app.close();
});

test('manual reconciliation requires a live URL and leaves the draft unchanged on refusal', async () => {
  const app = buildServer();
  const db = getDb();
  const id = seedPost(db, 'draft');

  const res = await app.inject({ method: 'POST', url: `/api/posts/${id}/mark-posted`, payload: {} });
  assert.equal(res.statusCode, 400);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(id).status, 'draft');
  await app.close();
});
