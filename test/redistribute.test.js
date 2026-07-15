// Unit tests for src/redistribute.js (B11 - SPEC.md "Assisted-manual upgrade
// + blog redistribution"). extractFromUrl's network call is stubbed via
// monkey-patched global.fetch (test/extract.test.js's pattern).
//
// The drafting CLI is stubbed via POSTDECK_CLAUDE_BIN - but draft.js (unlike
// copy_assist.js/extract.js) reads that env var into a MODULE-LEVEL const at
// import time, so it must be set before src/redistribute.js (which imports
// draft.js) is ever imported. To still vary the canned response per test, the
// stub binary itself is a small dispatcher that re-reads a *response file*
// path from POSTDECK_TEST_RESPONSE_FILE on every invocation (that env var IS
// read fresh per spawned child process, since execFile inherits the parent's
// current process.env at call time, not at import time). Missing/absent
// response file => the stub exits non-zero, exercising the 503 contract.
//
// In-memory DB via POSTDECK_DB_PATH=':memory:'. Hermetic - no real network or
// CLI/model calls.
//
// Run with: node --test test/redistribute.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const imageReqDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-redistribute-imgreq-'));
process.env.POSTDECK_IMAGE_REQ_DIR = imageReqDir;

const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-redistribute-cli-'));
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
// Set BEFORE importing anything that transitively imports draft.js.
process.env.POSTDECK_CLAUDE_BIN = dispatcherPath;

const { getDb, nowIso } = await import('../src/db.js');
const { redistributeFromUrl } = await import('../src/redistribute.js');

function setStubResponse(obj) {
  const respPath = path.join(cliDir, `resp-${Math.random()}.json`);
  fs.writeFileSync(respPath, JSON.stringify(obj));
  process.env.POSTDECK_TEST_RESPONSE_FILE = respPath;
}

function clearStubResponse() {
  delete process.env.POSTDECK_TEST_RESPONSE_FILE;
}

const ARTICLE_HTML = `
  <html>
    <head><title>How to Win Gov Contracts</title></head>
    <body>
      <article>
        <h1>How to Win Gov Contracts</h1>
        <p>Register in SAM first. Then find your NAICS codes.</p>
      </article>
    </body>
  </html>
`;

function stubFetch() {
  const prevFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => ARTICLE_HTML,
  });
  return () => {
    global.fetch = prevFetch;
  };
}

function seedBrand(db, label) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES (?, ?, '{}', 1, ?, ?)`
    )
    .run(`Redistribute Brand ${label}`, `redistribute-brand-${label}-${Math.random()}`, now, now).lastInsertRowid;
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

test('redistributeFromUrl (brand has a tone profile): creates N draft posts via draftWithAi + one image request', async () => {
  const db = getDb();
  const brandId = seedBrand(db, 'tone');
  seedToneProfile(db, brandId);
  const restoreFetch = stubFetch();
  setStubResponse({
    twitter: 'SAM registration is step one. #govcon',
    linkedin: 'A full breakdown of winning your first gov contract.',
  });

  try {
    const result = await redistributeFromUrl(db, {
      url: 'https://example.com/blog/win-gov-contracts',
      brand_id: brandId,
      platforms: ['twitter', 'linkedin'],
      make_images: true,
    });

    assert.equal(result.source.title, 'How to Win Gov Contracts');
    assert.equal(result.source.url, 'https://example.com/blog/win-gov-contracts');
    assert.equal(result.drafts.length, 2);
    assert.ok(!result.ai_unavailable);

    for (const draft of result.drafts) {
      assert.equal(draft.status, 'draft');
      assert.equal(draft.brand_id, brandId);
      assert.equal(draft.platform_fields.source_url, 'https://example.com/blog/win-gov-contracts');
    }
    const twitterDraft = result.drafts.find((d) => d.platform === 'twitter');
    assert.match(twitterDraft.copy, /SAM registration/);

    assert.equal(result.image_requests.length, 1);
    assert.equal(result.image_requests[0].status, 'requested');

    // Rows really landed in the DB, not just in the return value.
    const dbRows = db.prepare('SELECT * FROM posts WHERE brand_id = ?').all(brandId);
    assert.equal(dbRows.length, 2);
    assert.ok(dbRows.every((r) => r.status === 'draft'));
  } finally {
    clearStubResponse();
    restoreFetch();
  }
});

test('redistributeFromUrl (no tone profile): falls back to copy_assist headlines mode', async () => {
  const db = getDb();
  const brandId = seedBrand(db, 'no-tone');
  const restoreFetch = stubFetch();
  setStubResponse({ headlines: ['SAM registration is step one', 'Win your first gov contract'] });

  try {
    const result = await redistributeFromUrl(db, {
      url: 'https://example.com/blog/win-gov-contracts',
      brand_id: brandId,
      platforms: ['instagram'],
      make_images: false,
    });

    assert.equal(result.drafts.length, 1);
    assert.match(result.drafts[0].copy, /SAM registration is step one/);
    assert.equal(result.image_requests.length, 0, 'make_images:false must not create an image request');
  } finally {
    clearStubResponse();
    restoreFetch();
  }
});

test('redistributeFromUrl: AI drafting 503 still creates drafts (empty copy) + image request, flags ai_unavailable', async () => {
  const db = getDb();
  const brandId = seedBrand(db, 'ai-down');
  const restoreFetch = stubFetch();
  clearStubResponse(); // dispatcher will exit non-zero => 503 contract

  try {
    const result = await redistributeFromUrl(db, {
      url: 'https://example.com/blog/win-gov-contracts',
      brand_id: brandId,
      platforms: ['twitter', 'facebook'],
      make_images: true,
    });

    assert.equal(result.ai_unavailable, true);
    assert.equal(result.drafts.length, 2);
    assert.ok(result.drafts.every((d) => d.status === 'draft' && d.copy === ''));
    assert.equal(result.image_requests.length, 1, 'image brief is pure/no AI - should still be created');
  } finally {
    restoreFetch();
  }
});

test('redistributeFromUrl: extractFromUrl fetch failure propagates (caller maps to 400)', async () => {
  const db = getDb();
  const brandId = seedBrand(db, 'fetch-fail');
  const prevFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('getaddrinfo ENOTFOUND example.invalid');
  };

  try {
    await assert.rejects(() =>
      redistributeFromUrl(db, { url: 'https://example.invalid/nope', brand_id: brandId, platforms: ['twitter'] })
    );
  } finally {
    global.fetch = prevFetch;
  }
});
