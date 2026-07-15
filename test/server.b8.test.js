// Integration test (Fastify .inject, no real listen/port) for the B8
// Content Studio wiring: copy-assist, research, inspiration, image-requests,
// recommend, usage, and posts.content_type. Mirrors the isolation style of
// test/server.approve-gate.test.js (in-memory DB, worker/sync disabled).
// Run with: node --test test/server.b8.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const imageReqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b8-imgreq-'));
process.env.POSTDECK_IMAGE_REQ_DIR = imageReqDir;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'B8 Test Brand', `b8-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, brandId, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (@brand_id, @platform, @copy, '[]', '{}', @publish_at, @status, @now, @now)`
    )
    .run({
      brand_id: brandId,
      platform: overrides.platform || 'instagram',
      copy: overrides.copy || 'test copy',
      publish_at: overrides.publish_at || null,
      status: overrides.status || 'draft',
      now,
    });
  return info.lastInsertRowid;
}

test('research notes: POST/GET/PATCH/DELETE round-trip', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const created = await app.inject({
    method: 'POST',
    url: '/api/research',
    payload: { brand_id: brandId, source: 'manual', title: 'Trend note', body: 'Carousels win', tags: ['ops'] },
  });
  assert.equal(created.statusCode, 201);
  const note = created.json();
  assert.equal(note.title, 'Trend note');
  assert.deepEqual(note.tags, ['ops']);

  const list = await app.inject({ method: 'GET', url: `/api/research?brand_id=${brandId}&tag=ops` });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().some((n) => n.id === note.id));

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/research/${note.id}`,
    payload: { title: 'Updated trend note' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().title, 'Updated trend note');

  const deleted = await app.inject({ method: 'DELETE', url: `/api/research/${note.id}` });
  assert.equal(deleted.statusCode, 204);

  const patchMissing = await app.inject({
    method: 'PATCH',
    url: `/api/research/${note.id}`,
    payload: { title: 'gone' },
  });
  assert.equal(patchMissing.statusCode, 404);

  await app.close();
});

test('research import: POST /api/research/import stores content', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const res = await app.inject({
    method: 'POST',
    url: '/api/research/import',
    payload: { brand_id: brandId, source: 'reddit', filename: 'thread.txt', content: 'Reddit finding\nBody text here.' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().title, 'Reddit finding');

  await app.close();
});

test('inspiration profiles: CRUD round-trip', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const created = await app.inject({
    method: 'POST',
    url: '/api/inspiration',
    payload: {
      brand_id: brandId,
      handle: '@example',
      platform: 'instagram',
      name: 'Example Creator',
      niche: 'gov contracting',
      tags: ['inspiration'],
    },
  });
  assert.equal(created.statusCode, 201);
  const profile = created.json();
  assert.equal(profile.handle, '@example');
  assert.equal(profile.source, 'manual');

  const list = await app.inject({ method: 'GET', url: `/api/inspiration?brand_id=${brandId}&platform=instagram` });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().some((p) => p.id === profile.id));

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/inspiration/${profile.id}`,
    payload: { why_relevant: 'Great question-hook style' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().why_relevant, 'Great question-hook style');

  const deleted = await app.inject({ method: 'DELETE', url: `/api/inspiration/${profile.id}` });
  assert.equal(deleted.statusCode, 204);

  await app.close();
});

test('inspiration suggest returns 503 when the claude CLI is unavailable', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const prevBin = process.env.POSTDECK_CLAUDE_BIN;
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent';

  const res = await app.inject({
    method: 'POST',
    url: '/api/inspiration/suggest',
    payload: { brand_id: brandId, niche: 'gov contracting', platforms: ['instagram'] },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'ai_unavailable');

  if (prevBin === undefined) delete process.env.POSTDECK_CLAUDE_BIN;
  else process.env.POSTDECK_CLAUDE_BIN = prevBin;
  await app.close();
});

test('copy-assist returns 503 when the claude CLI is unavailable', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const prevBin = process.env.POSTDECK_CLAUDE_BIN;
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent';

  const res = await app.inject({
    method: 'POST',
    url: '/api/copy-assist',
    payload: { mode: 'headlines', idea_text: 'Launch our new offering', brand_id: brandId, platforms: ['instagram'] },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'ai_unavailable');

  if (prevBin === undefined) delete process.env.POSTDECK_CLAUDE_BIN;
  else process.env.POSTDECK_CLAUDE_BIN = prevBin;
  await app.close();
});

test('POST /api/image-requests creates a row and writes the spec file', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, brandId, { platform: 'instagram' });

  const res = await app.inject({
    method: 'POST',
    url: '/api/image-requests',
    payload: {
      post_id: postId,
      brand_id: brandId,
      platforms: ['instagram'],
      content_type: 'static',
      copy: 'test copy',
    },
  });
  assert.equal(res.statusCode, 201);
  const row = res.json();
  assert.equal(row.status, 'requested');
  assert.equal(row.post_id, postId);
  assert.ok(Array.isArray(row.platforms));
  assert.ok(row.brief && Array.isArray(row.brief.platforms));

  const specPath = path.join(imageReqDir, `req-${row.id}.json`);
  assert.ok(fs.existsSync(specPath), `expected spec file at ${specPath}`);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  assert.equal(spec.request_id, row.id);

  const fetched = await app.inject({ method: 'GET', url: `/api/image-requests/${row.id}` });
  assert.equal(fetched.statusCode, 200);
  assert.equal(fetched.json().id, row.id);

  const missing = await app.inject({ method: 'GET', url: '/api/image-requests/999999' });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('POST /api/image-requests/:id/pick attaches chosen image to the post media', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, brandId, { platform: 'instagram' });

  const created = await app.inject({
    method: 'POST',
    url: '/api/image-requests',
    payload: { post_id: postId, brand_id: brandId, platforms: ['instagram'], content_type: 'static', copy: 'x' },
  });
  const requestId = created.json().id;

  // Simulate the worker's importGeneratedImages landing a variant (pick only
  // accepts a path that is actually one of the request's generated variants).
  db.prepare('UPDATE image_requests SET status = ?, variants = ? WHERE id = ?').run(
    'generated',
    JSON.stringify([{ path: 'media/chosen.png', url: '/media/chosen.png', platform: 'instagram', dims: '1080x1350', notes: '' }]),
    requestId
  );

  const picked = await app.inject({
    method: 'POST',
    url: `/api/image-requests/${requestId}/pick`,
    payload: { chosen_path: 'media/chosen.png' },
  });
  assert.equal(picked.statusCode, 200);
  assert.equal(picked.json().status, 'picked');
  assert.equal(picked.json().chosen_path, 'media/chosen.png');

  const post = await app.inject({ method: 'GET', url: `/api/posts/${postId}` });
  const media = post.json().media;
  assert.ok(Array.isArray(media));
  assert.ok(media.some((m) => m.path === 'media/chosen.png' && m.altText === ''));

  await app.close();
});

test('POST /api/image-requests/:id/cancel marks the request canceled', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const created = await app.inject({
    method: 'POST',
    url: '/api/image-requests',
    payload: { brand_id: brandId, platforms: ['instagram'], content_type: 'static', copy: 'x' },
  });
  const requestId = created.json().id;

  const canceled = await app.inject({ method: 'POST', url: `/api/image-requests/${requestId}/cancel` });
  assert.equal(canceled.statusCode, 200);
  assert.equal(canceled.json().status, 'canceled');

  await app.close();
});

test('GET /api/recommend/content-type returns a ranked suggestion', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const res = await app.inject({
    method: 'GET',
    url: `/api/recommend/content-type?brand_id=${brandId}&platform=tiktok`,
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.suggestion);
  assert.ok(Array.isArray(body.ranked));
  assert.ok(['own_metrics', 'best_practice'].includes(body.basis));

  await app.close();
});

test('POST /api/posts with content_type persists it, and PATCH can change it', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const created = await app.inject({
    method: 'POST',
    url: '/api/posts',
    payload: { brand_id: brandId, platform: 'instagram', copy: 'hello', content_type: 'carousel' },
  });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().content_type, 'carousel');

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${created.json().id}`,
    payload: { content_type: 'video' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().content_type, 'video');

  await app.close();
});

test('GET /api/usage returns the ops-stats shape', async () => {
  const app = buildServer();

  const res = await app.inject({ method: 'GET', url: '/api/usage' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.posts_by_status);
  assert.ok(Array.isArray(body.posts_by_brand));
  assert.ok(Array.isArray(body.posts_by_platform));
  assert.ok(Array.isArray(body.content_type_mix));
  assert.ok(body.usage_counts);
  assert.ok(body.usage_last_7d);

  await app.close();
});

// Note: draft.js reads POSTDECK_CLAUDE_BIN once at module-load time (unlike
// copy_assist.js/inspiration.js, which read it lazily per-call), so it can't
// be redirected mid-test-run from here without risking a real shell-out to
// whatever `claude` binary is on PATH. recordUsage-on-success for /api/draft
// is exercised implicitly by the existing draft.js/scrub.js unit tests plus
// the server wiring above (usage.js's own unit tests cover recordUsage
// itself); this file limits its /api/draft coverage to the endpoints new to
// B8 to avoid an unmocked external CLI call.
