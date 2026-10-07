// Integration tests (Fastify .inject) for B20's bulk approve:
// POST /api/posts/approve-batch. The contract that matters is that a bulk
// approve is byte-for-byte N single approves - same scheduled_local promotion,
// same TikTok gate, same approve-gate UTM pass - and that one bad post in the
// batch never blocks its siblings.
// See docs/B20_BULK_APPROVE_SPEC.md.
// Run with: node --test test/bulk-approve.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { setBrandUtmSettings } = await import('../src/utm.js');

function seedBrand(db, slug) {
  const now = nowIso();
  return db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(`Bulk ${slug}`, `${slug}-${Math.random()}`, now, now).lastInsertRowid;
}

function seedPost(db, brandId, overrides = {}) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, first_comment, created_at, updated_at)
       VALUES (@brand_id, @platform, @copy, '[]', @platform_fields, @publish_at, @status, @first_comment, @now, @now)`
    )
    .run({
      brand_id: brandId,
      platform: overrides.platform || 'linkedin',
      copy: overrides.copy !== undefined ? overrides.copy : 'bulk test copy',
      platform_fields: JSON.stringify(overrides.platform_fields || {}),
      publish_at: overrides.publish_at || null,
      status: overrides.status || 'draft',
      first_comment: overrides.first_comment || null,
      now,
    }).lastInsertRowid;
}

async function approveBatch(app, post_ids) {
  return app.inject({ method: 'POST', url: '/api/posts/approve-batch', payload: { post_ids } });
}

test('approves a batch of drafts in one call', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'happy');
  const ids = [seedPost(db, brand), seedPost(db, brand), seedPost(db, brand)];

  const res = await approveBatch(app, ids);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.approved.length, 3);
  assert.equal(body.skipped.length, 0);
  for (const id of ids) {
    assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(id).status, 'approved');
  }
  await app.close();
});

test('a draft with publish_at becomes scheduled_local; without, plain approved', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'sched');
  const scheduled = seedPost(db, brand, { publish_at: '2026-09-01T14:00:00Z' });
  const unscheduled = seedPost(db, brand);

  const body = (await approveBatch(app, [scheduled, unscheduled])).json();
  const byId = Object.fromEntries(body.approved.map((p) => [p.id, p.status]));
  assert.equal(byId[scheduled], 'scheduled_local');
  assert.equal(byId[unscheduled], 'approved');
  await app.close();
});

test('non-draft posts are skipped as wrong_status without blocking siblings', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'mixed');
  const draft = seedPost(db, brand);
  const published = seedPost(db, brand, { status: 'published' });
  const submitted = seedPost(db, brand, { status: 'submitted' });

  const body = (await approveBatch(app, [published, draft, submitted])).json();
  assert.deepEqual(body.approved.map((p) => p.id), [draft]);
  assert.deepEqual(
    body.skipped.map((s) => [s.id, s.reason]).sort((a, b) => a[0] - b[0]),
    [[published, 'wrong_status'], [submitted, 'wrong_status']].sort((a, b) => a[0] - b[0])
  );
  // the untouched ones really are untouched
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(published).status, 'published');
  await app.close();
});

test('a tiktok draft missing required fields is skipped, never approved', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'tiktok');
  const bad = seedPost(db, brand, { platform: 'tiktok', platform_fields: {} });
  const good = seedPost(db, brand);

  const body = (await approveBatch(app, [bad, good])).json();
  assert.deepEqual(body.approved.map((p) => p.id), [good]);
  assert.equal(body.skipped.length, 1);
  assert.equal(body.skipped[0].reason, 'tiktok_fields_missing');
  assert.match(body.skipped[0].message, /privacyLevel/);
  assert.equal(db.prepare('SELECT status FROM posts WHERE id = ?').get(bad).status, 'draft');
  await app.close();
});

test('empty or missing post_ids is a 400', async () => {
  const app = buildServer();
  for (const payload of [{ post_ids: [] }, {}, { post_ids: 'nope' }]) {
    const res = await app.inject({ method: 'POST', url: '/api/posts/approve-batch', payload });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'invalid_body');
  }
  await app.close();
});

test('an unknown id comes back as not_found and siblings still approve', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'missing');
  const real = seedPost(db, brand);

  const body = (await approveBatch(app, [999999, real])).json();
  assert.deepEqual(body.approved.map((p) => p.id), [real]);
  assert.deepEqual(body.skipped, [{ id: 999999, reason: 'not_found' }]);
  await app.close();
});

test('bulk approve runs the approve-gate UTM pass, matching a single PATCH approve', async () => {
  const app = buildServer();
  const db = getDb();
  const brand = seedBrand(db, 'utm');
  setBrandUtmSettings(db, brand, { enabled: true });

  const viaBulk = seedPost(db, brand, {
    copy: 'read it here https://di-hy.com/ai-audit',
    first_comment: 'link: https://di-hy.com/contact',
  });
  const viaPatch = seedPost(db, brand, {
    copy: 'read it here https://di-hy.com/ai-audit',
    first_comment: 'link: https://di-hy.com/contact',
  });

  await approveBatch(app, [viaBulk]);
  await app.inject({ method: 'PATCH', url: `/api/posts/${viaPatch}`, payload: { status: 'approved' } });

  const a = db.prepare('SELECT copy, first_comment FROM posts WHERE id = ?').get(viaBulk);
  const b = db.prepare('SELECT copy, first_comment FROM posts WHERE id = ?').get(viaPatch);
  assert.match(a.copy, /utm_source=linkedin/);
  assert.match(a.first_comment, /utm_source=linkedin/);
  // utm_content carries each post's own id (pd-<id>); everything else must match.
  assert.ok(a.copy.includes(`utm_content=pd-${viaBulk}`));
  assert.ok(b.copy.includes(`utm_content=pd-${viaPatch}`));
  const norm = (t) => t.replace(/utm_content=pd-\d+/g, 'utm_content=pd-N');
  assert.equal(norm(a.copy), norm(b.copy));
  assert.equal(norm(a.first_comment), norm(b.first_comment));
  await app.close();
});
