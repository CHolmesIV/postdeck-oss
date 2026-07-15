// Integration test (Fastify .inject, no real listen/port) for the B15 AI
// provider switcher backend wiring: draft_provider setting round-trip,
// /api/draft + /api/copy-assist accepting an optional `provider`, and
// /api/draft/compare running both providers independently. Mirrors
// test/server.b14.test.js's isolation style (in-memory DB, worker/sync
// disabled). Neither `claude` nor `codex` CLIs are assumed to be
// logged-in/available in CI — assertions check response SHAPE (and,
// where a stub is wired, its content), not that the real CLIs succeed.
//
// Run with: node --test test/server.b15.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const imageReqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b15-imgreq-'));
process.env.POSTDECK_IMAGE_REQ_DIR = imageReqDir;

const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b15-media-'));
process.env.POSTDECK_MEDIA_DIR = mediaDir;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, colors, active, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`)
    .run(overrides.name || 'B15 Test Brand', `b15-${Math.random()}`, null, now, now);
  return info.lastInsertRowid;
}

function seedToneProfile(db, brandId, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      brandId,
      overrides.name || 'default',
      overrides.voice_rules || 'Direct, no fluff.',
      overrides.hard_rules || JSON.stringify({ no_em_dash: true }),
      now,
      now
    );
  return info.lastInsertRowid;
}

/** Write a stub CLI script and return its path (caller sets the env var). */
function writeStubClaudeBin(innerJsonString) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-b15-claude-'));
  const binPath = path.join(dir, 'claude-stub.js');
  const envelope = JSON.stringify({ result: innerJsonString });
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`,
    { mode: 0o755 }
  );
  return { dir, binPath };
}

test('GET/PATCH /api/settings round-trips draft_provider, default "claude"', async () => {
  const app = buildServer();

  const initial = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(initial.statusCode, 200);
  assert.equal(initial.json().draft_provider, 'claude');

  const switched = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { draft_provider: 'codex' } });
  assert.equal(switched.statusCode, 200);
  assert.equal(switched.json().draft_provider, 'codex');

  const stillSwitched = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(stillSwitched.json().draft_provider, 'codex');

  const back = await app.inject({ method: 'PATCH', url: '/api/settings', payload: { draft_provider: 'claude' } });
  assert.equal(back.json().draft_provider, 'claude');

  await app.close();
});

test('POST /api/draft accepts a provider and uses a stubbed claude CLI end-to-end', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const toneId = seedToneProfile(db, brandId);

  const { dir, binPath } = writeStubClaudeBin(JSON.stringify({ twitter: 'Hello world — check this out' }));
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/draft',
      payload: {
        idea_text: 'Launch announcement',
        brand_id: brandId,
        tone_profile_id: toneId,
        platforms: ['twitter'],
        provider: 'claude',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(typeof body.drafts.twitter, 'string');
    assert.ok(!/—/.test(body.drafts.twitter), 'em-dash must be scrubbed');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await app.close();
});

test('POST /api/draft returns the ai_unavailable shape (with provider) when the CLI is unavailable', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const toneId = seedToneProfile(db, brandId);

  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/draft',
      payload: {
        idea_text: 'Launch announcement',
        brand_id: brandId,
        tone_profile_id: toneId,
        platforms: ['twitter'],
        provider: 'claude',
      },
    });
    assert.equal(res.statusCode, 503);
    const body = res.json();
    assert.equal(body.error, 'ai_unavailable');
    assert.equal(body.provider, 'claude');
    assert.equal(typeof body.message, 'string');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }

  await app.close();
});

test('POST /api/draft/compare returns a {claude, codex} shape, each independently succeeding or 503ing', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const toneId = seedToneProfile(db, brandId);

  // Neither CLI is assumed available/logged-in in CI — point both bins at
  // nonexistent paths so this is deterministic, and assert the SHAPE: both
  // providers attempted independently, one failing must not affect the other.
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  process.env.POSTDECK_CODEX_BIN = '/nonexistent/codex-binary-postdeck-test';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/draft/compare',
      payload: {
        idea_text: 'Launch announcement',
        brand_id: brandId,
        tone_profile_id: toneId,
        platforms: ['twitter'],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok('claude' in body);
    assert.ok('codex' in body);
    assert.equal(body.claude.error, 'ai_unavailable');
    assert.equal(body.codex.error, 'ai_unavailable');
    assert.equal(typeof body.claude.message, 'string');
    assert.equal(typeof body.codex.message, 'string');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    delete process.env.POSTDECK_CODEX_BIN;
  }

  await app.close();
});

test('POST /api/draft/compare: one provider succeeding does not block the other from also being attempted', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const toneId = seedToneProfile(db, brandId);

  const { dir, binPath } = writeStubClaudeBin(JSON.stringify({ twitter: 'Clean draft, no issues' }));
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  process.env.POSTDECK_CODEX_BIN = '/nonexistent/codex-binary-postdeck-test';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/draft/compare',
      payload: {
        idea_text: 'Launch announcement',
        brand_id: brandId,
        tone_profile_id: toneId,
        platforms: ['twitter'],
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.claude.result.drafts.twitter, 'Clean draft, no issues');
    assert.equal(body.codex.error, 'ai_unavailable');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    delete process.env.POSTDECK_CODEX_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await app.close();
});

test('POST /api/copy-assist accepts a provider and uses a stubbed claude CLI end-to-end', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const { dir, binPath } = writeStubClaudeBin(JSON.stringify({ headlines: ['Clean headline', 'Another one'] }));
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copy-assist',
      payload: {
        mode: 'headlines',
        idea_text: 'Launch post',
        brand_id: brandId,
        provider: 'claude',
      },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.result.headlines.length, 2);
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  await app.close();
});

test('POST /api/copy-assist falls back to the draft_provider setting when no provider is given', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  await app.inject({ method: 'PATCH', url: '/api/settings', payload: { draft_provider: 'codex' } });
  process.env.POSTDECK_CODEX_BIN = '/nonexistent/codex-binary-postdeck-test';
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/api/copy-assist',
      payload: { mode: 'headlines', idea_text: 'Launch post', brand_id: brandId },
    });
    // No provider passed -> should have used the 'codex' setting, and since
    // that bin is missing, come back 503 naming codex (not claude).
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().provider, 'codex');
  } finally {
    delete process.env.POSTDECK_CODEX_BIN;
    await app.inject({ method: 'PATCH', url: '/api/settings', payload: { draft_provider: 'claude' } });
  }

  await app.close();
});
