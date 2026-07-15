// Integration test (Fastify .inject, no real listen/port) for the B11
// "Assisted-manual upgrade + blog redistribution" API surface: examples
// CRUD, /api/examples/extract-image, /api/redistribute, and PATCH
// /api/accounts/:id. Mirrors the isolation style of test/server.b8.test.js
// (in-memory DB, worker/sync disabled).
//
// draft.js/server.js read POSTDECK_CLAUDE_BIN and POSTDECK_MEDIA_DIR into
// module-level consts at IMPORT time (unlike copy_assist.js/extract.js,
// which read per-call) - so both must be set before the top-level
// `await import('../src/server.js')` below. The CLI stub is a small
// dispatcher that re-reads a response file path from
// POSTDECK_TEST_RESPONSE_FILE on every spawn (read fresh per child process,
// so per-test canned responses still work even though the *binary path*
// itself is frozen at import time). See test/redistribute.test.js for the
// same pattern.
//
// Run with: node --test test/server.b11.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const imageReqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b11-imgreq-'));
process.env.POSTDECK_IMAGE_REQ_DIR = imageReqDir;

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b11-media-'));
process.env.POSTDECK_MEDIA_DIR = mediaDir;

const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b11-cli-'));
const dispatcherPath = path.join(cliDir, 'claude-dispatcher.js');
fs.writeFileSync(
  dispatcherPath,
  `#!/usr/bin/env node
const fs = require('fs');
const respPath = process.env.POSTDECK_TEST_RESPONSE_FILE;
if (!respPath || !fs.existsSync(respPath)) {
  process.stderr.write('no stub response configured');
  process.exit(1);
}
const inner = fs.readFileSync(respPath, 'utf8');
process.stdout.write(JSON.stringify({ result: inner }));
`,
  { mode: 0o755 }
);
// Set BEFORE importing server.js (draft.js freezes this at import time).
process.env.POSTDECK_CLAUDE_BIN = dispatcherPath;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function setStubResponse(obj) {
  const respPath = path.join(cliDir, `resp-${Math.random()}.json`);
  fs.writeFileSync(respPath, JSON.stringify(obj));
  process.env.POSTDECK_TEST_RESPONSE_FILE = respPath;
}

function clearStubResponse() {
  delete process.env.POSTDECK_TEST_RESPONSE_FILE;
}

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'B11 Test Brand', `b11-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedAccount(db, brandId, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, blotato_account_id, target_fields, active, manual, created_at, updated_at)
       VALUES (?, ?, ?, '{}', 1, ?, ?, ?)`
    )
    .run(brandId, overrides.platform || 'instagram', overrides.blotato_account_id || 'acct_1', overrides.manual ? 1 : 0, now, now);
  return info.lastInsertRowid;
}

function seedToneProfile(db, brandId) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at)
       VALUES (?, 'business', 'Direct, no fluff.', '{}', ?, ?)`
    )
    .run(brandId, now, now).lastInsertRowid;
}

const ARTICLE_HTML = `
  <html>
    <head><title>Blog Title Here</title></head>
    <body><article><p>Article body content.</p></article></body>
  </html>
`;

function stubFetch() {
  const prevFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 200, statusText: 'OK', text: async () => ARTICLE_HTML });
  return () => {
    global.fetch = prevFetch;
  };
}

test('examples: POST/GET/DELETE round-trip', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const created = await app.inject({
    method: 'POST',
    url: '/api/examples',
    payload: { brand_id: brandId, platform: 'reddit', source: 'paste', text: 'A great example post.', tags: ['ops'] },
  });
  assert.equal(created.statusCode, 201);
  const example = created.json();
  assert.equal(example.text, 'A great example post.');
  assert.deepEqual(example.tags, ['ops']);

  const list = await app.inject({ method: 'GET', url: `/api/examples?brand_id=${brandId}&platform=reddit` });
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().some((e) => e.id === example.id));

  const deleted = await app.inject({ method: 'DELETE', url: `/api/examples/${example.id}` });
  assert.equal(deleted.statusCode, 204);

  const listAfter = await app.inject({ method: 'GET', url: `/api/examples?brand_id=${brandId}&platform=reddit` });
  assert.ok(!listAfter.json().some((e) => e.id === example.id));

  await app.close();
});

test('PATCH /api/accounts/:id toggles manual', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const accountId = seedAccount(db, brandId, { platform: 'reddit', manual: false });

  const before = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  assert.equal(before.manual, 0);

  const res = await app.inject({ method: 'PATCH', url: `/api/accounts/${accountId}`, payload: { manual: true } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().manual, 1);

  const after = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  assert.equal(after.manual, 1);

  const missing = await app.inject({ method: 'PATCH', url: '/api/accounts/999999', payload: { manual: true } });
  assert.equal(missing.statusCode, 404);

  await app.close();
});

test('POST /api/redistribute creates platform drafts (+ image request) from a blog URL', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  seedToneProfile(db, brandId);
  const restoreFetch = stubFetch();
  setStubResponse({ twitter: 'Read about our new offering.', instagram: 'Check out our latest post!' });

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/redistribute',
      payload: { url: 'https://example.com/blog/post', brand_id: brandId, platforms: ['twitter', 'instagram'], make_images: true },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.source.url, 'https://example.com/blog/post');
    assert.equal(body.drafts.length, 2);
    assert.ok(body.drafts.every((d) => d.status === 'draft'));
    assert.equal(body.image_requests.length, 1);
  } finally {
    clearStubResponse();
    restoreFetch();
  }

  await app.close();
});

test('POST /api/redistribute returns 400 fetch_failed when the URL fetch fails', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const prevFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND example.invalid');
  };

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/redistribute',
      payload: { url: 'https://example.invalid/nope', brand_id: brandId, platforms: ['twitter'] },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json().error, 'fetch_failed');
  } finally {
    global.fetch = prevFetch;
  }

  await app.close();
});

test('POST /api/redistribute requires a url', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'POST', url: '/api/redistribute', payload: { platforms: ['twitter'] } });
  assert.equal(res.statusCode, 400);
  await app.close();
});

test('POST /api/examples/extract-image returns 503 (ai_unavailable) when the claude CLI is unavailable', async () => {
  const app = buildServer();
  const dummyImagePath = path.join(mediaDir, 'screenshot.png');
  fs.writeFileSync(dummyImagePath, 'not-really-a-png');

  const prevBin = process.env.POSTDECK_CLAUDE_BIN;
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/examples/extract-image',
      payload: { image_path: 'media/screenshot.png' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'ai_unavailable');
  } finally {
    if (prevBin === undefined) delete process.env.POSTDECK_CLAUDE_BIN;
    else process.env.POSTDECK_CLAUDE_BIN = prevBin;
  }

  await app.close();
});

test('POST /api/examples/extract-image does not save an example row (preview only)', async () => {
  const app = buildServer();
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) c FROM examples').get().c;

  const prevBin = process.env.POSTDECK_CLAUDE_BIN;
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent';
  try {
    await app.inject({
      method: 'POST',
      url: '/api/examples/extract-image',
      payload: { image_path: 'media/does-not-matter.png' },
    });
  } finally {
    if (prevBin === undefined) delete process.env.POSTDECK_CLAUDE_BIN;
    else process.env.POSTDECK_CLAUDE_BIN = prevBin;
  }

  const after = db.prepare('SELECT COUNT(*) c FROM examples').get().c;
  assert.equal(after, before, 'extract-image preview must never create an examples row');

  await app.close();
});

test('copy-assist folds examplesGrounding into the prompt (graceful when none exist) and still works', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  // Seed an example for this brand/platform so examplesGrounding() has
  // something to append.
  await app.inject({
    method: 'POST',
    url: '/api/examples',
    payload: { brand_id: brandId, platform: 'instagram', source: 'paste', text: 'Example post body for grounding.' },
  });

  setStubResponse({ headlines: ['A grounded headline'] });
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copy-assist',
      payload: { mode: 'headlines', idea_text: 'Launch our new offering', brand_id: brandId, platforms: ['instagram'] },
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().result.headlines, ['A grounded headline']);
  } finally {
    clearStubResponse();
  }

  await app.close();
});

test('worker handoff never submits an assisted-manual account (accounts.manual=1) to Blotato', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  // instagram is blotato:true in platform-specs, but this account is
  // individually flagged manual=1 - the worker must still skip it.
  const accountId = seedAccount(db, brandId, { platform: 'instagram', manual: true });
  const now = nowIso();
  const publishAt = new Date(Date.now() - 60 * 1000).toISOString(); // already due
  const postInfo = db
    .prepare(
      `INSERT INTO posts (brand_id, account_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, 'instagram', 'body', '[]', '{}', ?, 'scheduled_local', ?, ?)`
    )
    .run(brandId, accountId, publishAt, now, now);
  const postId = postInfo.lastInsertRowid;

  const worker = await import('../src/worker.js');
  const handoffCount = await worker.runHandoffPhase(db);
  assert.equal(handoffCount, 0, 'manual account post must not be picked up by the handoff sweep');

  const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(row.status, 'scheduled_local', 'manual account post stays scheduled_local - worker never touches it');
});
