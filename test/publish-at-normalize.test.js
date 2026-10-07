// Audit 2026-10-07 T6: publish_at is normalized to UTC ISO (ms + Z) on every
// write path, existing rows are migrated, and timestamps are compared as
// dates. Zone-less strings ('2026-08-19 22:17:34', SQLite datetime('now')
// style) are UTC.
//
// Run with: node --test test/publish-at-normalize.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso, MIGRATIONS, applyMigrations } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { normalizeIso } = await import('../src/time.js');
const { nextOpenSlot, createQueueSlot } = await import('../src/queue.js');
const { runHandoffPhase, resolveBatch } = await import('../src/worker.js');
const { executeAction } = await import('../src/agent.js');
const { updateSettings } = await import('../src/settings.js');

function seedBrand(db) {
  const now = nowIso();
  return db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Norm Brand', `norm-${Math.random()}`, now, now).lastInsertRowid;
}
function seedPost(db, { brand_id, status = 'draft', publish_at = null, platform = 'linkedin', account_id = null } = {}) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, ?, 'hi', '[]', '{}', ?, ?, ?, ?)`
    )
    .run(brand_id, account_id, platform, publish_at, status, now, now).lastInsertRowid;
}

test('normalizeIso: formats, zone-less = UTC, null, and garbage', () => {
  assert.equal(normalizeIso('2026-08-19T22:17:34Z'), '2026-08-19T22:17:34.000Z');
  assert.equal(normalizeIso('2026-08-19T22:17:34.689Z'), '2026-08-19T22:17:34.689Z');
  assert.equal(normalizeIso('2026-08-19 22:17:34'), '2026-08-19T22:17:34.000Z');
  assert.equal(normalizeIso('2026-08-19T22:17:34'), '2026-08-19T22:17:34.000Z');
  assert.equal(normalizeIso('2026-08-19T17:17:34-05:00'), '2026-08-19T22:17:34.000Z');
  assert.equal(normalizeIso('2026-08-19 22:17'), '2026-08-19T22:17:00.000Z');
  assert.equal(normalizeIso(new Date('2026-08-19T22:17:34Z')), '2026-08-19T22:17:34.000Z');
  assert.equal(normalizeIso(null), null);
  assert.equal(normalizeIso(undefined), null);
  assert.equal(normalizeIso(''), null);
  assert.equal(normalizeIso('   '), null);
  for (const bad of ['tomorrow-ish', '2026-13-45T00:00:00Z', {}, NaN]) {
    assert.throws(() => normalizeIso(bad), (e) => e.statusCode === 400 && e.code === 'invalid_publish_at', String(bad));
  }
});

test('migration v12 normalizes existing publish_at rows and adds verify columns', () => {
  const raw = new Database(':memory:');
  MIGRATIONS.slice(0, 11).forEach((m) => raw.exec(m));
  raw.pragma('user_version = 11');
  raw.exec(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES ('b','b',1,'x','x')`);
  const ins = raw.prepare(
    `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
     VALUES (1, 'linkedin', '', '[]', '{}', ?, 'draft', 'x', 'x')`
  );
  const ids = ['2026-08-19T22:17:34Z', '2026-08-19 22:17:34', '2026-08-19T22:17:34.689Z', 'garbage', null].map(
    (v) => ins.run(v).lastInsertRowid
  );
  applyMigrations(raw);
  const at = (id) => raw.prepare('SELECT publish_at FROM posts WHERE id = ?').get(id).publish_at;
  assert.equal(at(ids[0]), '2026-08-19T22:17:34.000Z');
  assert.equal(at(ids[1]), '2026-08-19T22:17:34.000Z');
  assert.equal(at(ids[2]), '2026-08-19T22:17:34.689Z');
  assert.equal(at(ids[3]), 'garbage', 'unparseable values are left for a human, not destroyed');
  assert.equal(at(ids[4]), null);
  const cols = raw.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
  assert.ok(cols.includes('verify_started_at') && cols.includes('last_remote_state'));
  assert.equal(raw.pragma('user_version', { simple: true }), MIGRATIONS.length);
  raw.close();
});

test('POST/PATCH /api/posts normalize publish_at and 400 on garbage', async () => {
  const app = buildServer();
  const db = getDb();
  const brand_id = seedBrand(db);

  const created = await app.inject({
    method: 'POST',
    url: '/api/posts',
    payload: { platform: 'linkedin', brand_id, publish_at: '2026-10-08 09:00:00' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().publish_at, '2026-10-08T09:00:00.000Z');

  const bad = await app.inject({ method: 'POST', url: '/api/posts', payload: { platform: 'linkedin', publish_at: 'next tuesday' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_publish_at');

  const id = created.json().id;
  const patched = await app.inject({ method: 'PATCH', url: `/api/posts/${id}`, payload: { publish_at: '2026-10-09T09:00:00' } });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().publish_at, '2026-10-09T09:00:00.000Z');

  const badPatch = await app.inject({ method: 'PATCH', url: `/api/posts/${id}`, payload: { publish_at: 'garbage' } });
  assert.equal(badPatch.statusCode, 400);
  assert.equal(db.prepare('SELECT publish_at FROM posts WHERE id = ?').get(id).publish_at, '2026-10-09T09:00:00.000Z');

  const cleared = await app.inject({ method: 'PATCH', url: `/api/posts/${id}`, payload: { publish_at: null } });
  assert.equal(cleared.json().publish_at, null);
  await app.close();
});

test('GET /api/posts from/to bounds are normalized (and bad ones 400)', async () => {
  const app = buildServer();
  const db = getDb();
  const brand_id = seedBrand(db);
  const id = seedPost(db, { brand_id, publish_at: '2031-03-01T10:00:00.000Z' });
  const hit = await app.inject({ method: 'GET', url: `/api/posts?brand=${brand_id}&from=2031-03-01 09:00:00&to=2031-03-01T11:00:00Z` });
  assert.deepEqual(hit.json().map((p) => p.id), [id]);
  const miss = await app.inject({ method: 'GET', url: `/api/posts?brand=${brand_id}&from=2031-03-01 10:30:00` });
  assert.deepEqual(miss.json(), []);
  assert.equal((await app.inject({ method: 'GET', url: '/api/posts?from=nope' })).statusCode, 400);
  await app.close();
});

test('queue: slot-taken check matches a post stored in any timestamp format', () => {
  const db = getDb();
  updateSettings(db, { quiet_start: '00:00', quiet_end: '00:00' });
  const brand_id = seedBrand(db);
  createQueueSlot(db, { brand_id, platform: 'linkedin', day_of_week: 1, time_local: '12:00' });
  createQueueSlot(db, { brand_id, platform: 'linkedin', day_of_week: 4, time_local: '12:00' });
  const first = nextOpenSlot(db, brand_id, 'linkedin');
  assert.ok(first);
  // Occupy that instant with a legacy-format row (no ms, then space-separated).
  for (const legacy of [first.replace('.000Z', 'Z'), first.slice(0, 19).replace('T', ' ')]) {
    const id = seedPost(db, { brand_id, status: 'scheduled_local', publish_at: legacy });
    const next = nextOpenSlot(db, brand_id, 'linkedin');
    assert.notEqual(next, first, `slot taken by '${legacy}' must be skipped`);
    db.prepare('DELETE FROM posts WHERE id = ?').run(id);
  }
  assert.equal(nextOpenSlot(db, brand_id, 'linkedin'), first);
});

test('worker handoff window compares dates: a legacy-format post inside 48h is handed off', async () => {
  const db = getDb();
  const brand_id = seedBrand(db);
  const now = nowIso();
  const acct = db
    .prepare(`INSERT INTO accounts (brand_id, platform, blotato_account_id, created_at, updated_at) VALUES (?, 'linkedin', 'a1', ?, ?)`)
    .run(brand_id, now, now).lastInsertRowid;
  const soon = new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const far = new Date(Date.now() + 100 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const a = seedPost(db, { brand_id, account_id: acct, status: 'scheduled_local', publish_at: soon });
  const b = seedPost(db, { brand_id, account_id: acct, status: 'scheduled_local', publish_at: far });
  await runHandoffPhase(db);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(a).status, 'submitted_dry');
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(b).status, 'scheduled_local');
  // batch scope window is numeric too
  const c = seedPost(db, { brand_id, account_id: acct, status: 'scheduled_local', publish_at: soon });
  const { eligible } = resolveBatch(db, {
    scope: { from: new Date(Date.now() - 3600e3).toISOString(), to: new Date(Date.now() + 5 * 3600e3).toISOString(), brand_id },
  });
  assert.ok(eligible.some((p) => p.id === c));
});

test('agent create/update draft normalize publish_at and reject garbage', async () => {
  const db = getDb();
  const brand_id = seedBrand(db);
  const created = await executeAction(db, {
    tool: 'create_draft_post',
    args: { brand_id, platform: 'linkedin', copy: 'x', publish_at: '2026-10-08T09:00:00' },
  });
  assert.equal(created.data.post.publish_at, '2026-10-08T09:00:00.000Z');

  const updated = await executeAction(db, { tool: 'update_draft_post', args: { id: created.data.post.id, publish_at: '2026-10-09 10:00:00' } });
  assert.equal(updated.data.post.publish_at, '2026-10-09T10:00:00.000Z');

  const bad = await executeAction(db, { tool: 'update_draft_post', args: { id: created.data.post.id, publish_at: 'whenever' } });
  assert.match(bad.summary, /Cannot update/);
  assert.equal(db.prepare('SELECT publish_at FROM posts WHERE id = ?').get(created.data.post.id).publish_at, '2026-10-09T10:00:00.000Z');

  const badCreate = await executeAction(db, { tool: 'create_draft_post', args: { brand_id, platform: 'linkedin', publish_at: 'whenever' } });
  assert.equal(badCreate.data.post, null);
});
