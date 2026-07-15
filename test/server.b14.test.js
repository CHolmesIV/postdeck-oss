// Integration test (Fastify .inject, no real listen/port) for the B14 Image
// studio v2 + branding + agent publish authority backend wiring: PATCH brand
// colors/logo_path, image-request variant_count + regenerate, settings
// round-trip of agent_can_publish, and the agent's approve_post/publish_now
// refusal when unarmed. Mirrors test/server.b13.test.js's isolation style
// (in-memory DB, worker/sync disabled).
//
// Run with: node --test test/server.b14.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const imageReqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b14-imgreq-'));
process.env.POSTDECK_IMAGE_REQ_DIR = imageReqDir;

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b14-media-'));
process.env.POSTDECK_MEDIA_DIR = mediaDir;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { executeAction } = await import('../src/agent.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, colors, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
    .run(
      overrides.name || 'B14 Test Brand',
      `b14-${Math.random()}`,
      overrides.colors ? JSON.stringify(overrides.colors) : null,
      now,
      now
    );
  return info.lastInsertRowid;
}

function seedPost(db, { brand_id = null, platform = 'facebook', status = 'draft', publish_at = null } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, '', '[]', '{}', ?, ?, ?, ?)`
    )
    .run(brand_id, platform, publish_at, status, now, now);
  return info.lastInsertRowid;
}

test('PATCH /api/brands/:id persists name/colors/logo_path/voice_doc_path', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/brands/${brandId}`,
    payload: {
      colors: { primary: '#0D0D0D', accent: '#C8902A' },
      logo_path: 'media/some-logo.png',
      voice_doc_path: 'docs/brand-voice.md',
    },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(body.colors, { primary: '#0D0D0D', accent: '#C8902A' });
  assert.equal(body.logo_path, 'media/some-logo.png');
  assert.equal(body.voice_doc_path, 'docs/brand-voice.md');

  const missing = await app.inject({ method: 'PATCH', url: '/api/brands/999999', payload: { name: 'x' } });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('POST /api/media/resize confines source_path to media/ (no path traversal / absolute read)', async () => {
  const app = buildServer();
  // A traversal or absolute path must NOT resolve to a file outside media/.
  // resolveMediaPath basename-flattens it, so it can only ever hit media/<name>
  // (here nonexistent) -> never a 200 with resized files of an off-disk file.
  for (const evil of ['../package.json', '/etc/hosts', '../../etc/passwd']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media/resize',
      payload: { source_path: evil, platforms: ['instagram'] },
    });
    assert.notEqual(res.statusCode, 200, `traversal ${evil} must not succeed`);
    assert.ok(!res.json().files, `traversal ${evil} must not return resized files`);
  }
  await app.close();
});

test('POST /api/image-requests accepts variant_count + hints and folds brand logo_path/colors into the brief', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db, { colors: { primary: '#111111' } });
  db.prepare('UPDATE brands SET logo_path = ? WHERE id = ?').run('media/brand-logo.png', brandId);

  const res = await app.inject({
    method: 'POST',
    url: '/api/image-requests',
    payload: {
      brand_id: brandId,
      platforms: ['instagram'],
      content_type: 'static',
      copy: 'Launch announcement',
      variant_count: 3,
      hints: [{ size: 'square', type: 'feed post' }],
    },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.brief.variant_count, 3);
  assert.deepEqual(body.brief.hints, [{ size: 'square', type: 'feed post' }]);
  assert.equal(body.brief.logo_path, 'media/brand-logo.png');
  assert.deepEqual(body.brief.colors, { primary: '#111111' });

  const specPath = path.join(imageReqDir, `req-${body.id}.json`);
  assert.ok(fs.existsSync(specPath));
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  assert.equal(spec.brief.variant_count, 3);
  assert.match(spec.instructions, /3 image variants/);

  await app.close();
});

test('POST /api/image-requests/:id/regenerate creates a new request for the same post/brand/platforms', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId });

  const first = await app.inject({
    method: 'POST',
    url: '/api/image-requests',
    payload: { post_id: postId, brand_id: brandId, platforms: ['facebook'], content_type: 'static', variant_count: 1 },
  });
  assert.equal(first.statusCode, 201);
  const firstBody = first.json();

  const regen = await app.inject({
    method: 'POST',
    url: `/api/image-requests/${firstBody.id}/regenerate`,
    payload: { variant_count: 4 },
  });
  assert.equal(regen.statusCode, 201);
  const regenBody = regen.json();
  assert.notEqual(regenBody.id, firstBody.id);
  assert.equal(regenBody.post_id, postId);
  assert.equal(regenBody.brand_id, brandId);
  assert.deepEqual(regenBody.platforms, ['facebook']);
  assert.equal(regenBody.brief.variant_count, 4);
  assert.equal(regenBody.brief.regenerated_from, firstBody.id);

  const missing = await app.inject({ method: 'POST', url: '/api/image-requests/999999/regenerate', payload: {} });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('GET/PATCH /api/settings round-trips agent_can_publish, default "0"', async () => {
  const app = buildServer();

  const initial = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().agent_can_publish, '0');

  const armed = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_can_publish: '1' } });
  assert.equal(armed.statusCode, 200);
  assert.equal(armed.json().agent_can_publish, '1');

  const stillArmed = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(stillArmed.json().agent_can_publish, '1');

  const disarmed = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_can_publish: '0' } });
  assert.equal(disarmed.json().agent_can_publish, '0');

  await app.close();
});

test('agent approve_post refuses when agent_can_publish is off (default)', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId, status: 'draft' });

  // Make sure it's off (defaults to unset -> '0' semantics in agentCanPublish()).
  const settingsRes = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(settingsRes.json().agent_can_publish, '0');

  const result = await executeAction(db, { tool: 'approve_post', args: { id: postId } });
  assert.match(result.summary, /off — arm it in Settings/);

  const stillDraft = db.prepare('SELECT status FROM posts WHERE id = ?').get(postId);
  assert.equal(stillDraft.status, 'draft', 'post must stay draft when the agent is unarmed');

  await app.close();
});

test('agent approve_post works once armed, honors TikTok validation, and records agent_publish usage', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_can_publish: '1' } });

  const postId = seedPost(db, { brand_id: brandId, platform: 'facebook', status: 'draft' });
  const result = await executeAction(db, { tool: 'approve_post', args: { id: postId } });
  assert.match(result.summary, /Approved post/);
  const approved = db.prepare('SELECT status FROM posts WHERE id = ?').get(postId);
  assert.equal(approved.status, 'approved');

  const usageRow = db
    .prepare(`SELECT * FROM usage_events WHERE kind = 'agent_publish' ORDER BY id DESC LIMIT 1`)
    .get();
  assert.ok(usageRow, 'an agent_publish usage_events row should be recorded');

  // TikTok post missing required fields should refuse even when armed.
  const tiktokPostId = seedPost(db, { brand_id: brandId, platform: 'tiktok', status: 'draft' });
  const tiktokResult = await executeAction(db, { tool: 'approve_post', args: { id: tiktokPostId } });
  assert.match(tiktokResult.summary, /missing required fields/);
  const stillDraft = db.prepare('SELECT status FROM posts WHERE id = ?').get(tiktokPostId);
  assert.equal(stillDraft.status, 'draft');

  await app.close();
});

test('agent publish_now refuses when unarmed and honors dry-run (submitted_dry) when armed', async () => {
  const app = buildServer();
  const db = getDb();
  // Earlier tests in this file may have left agent_can_publish armed (shared
  // in-memory DB/connection across tests in one process) — start disarmed.
  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_can_publish: '0' } });
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId, platform: 'facebook', status: 'approved' });

  const refused = await executeAction(db, { tool: 'publish_now', args: { id: postId } });
  assert.match(refused.summary, /off — arm it in Settings/);
  const stillApproved = db.prepare('SELECT status FROM posts WHERE id = ?').get(postId);
  assert.equal(stillApproved.status, 'approved');

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_can_publish: '1' } });
  const published = await executeAction(db, { tool: 'publish_now', args: { id: postId } });
  assert.match(published.summary, /Submitted post/);
  const afterSubmit = db.prepare('SELECT status FROM posts WHERE id = ?').get(postId);
  // BLOTATO_DRY_RUN=1 in this test env — never a real network call.
  assert.equal(afterSubmit.status, 'submitted_dry');

  await app.close();
});
