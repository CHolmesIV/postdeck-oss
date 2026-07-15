// Unit tests for src/examples.js (B11 — SPEC.md "Assisted-manual upgrade +
// blog redistribution"). In-memory SQLite DB via POSTDECK_DB_PATH=':memory:'
// (research.test.js's pattern). Screenshot extraction is stubbed via
// POSTDECK_CLAUDE_BIN pointing at a temp-file stub CLI — no real network/CLI.
//
// Run with: node --test test/examples.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const { listExamples, createExample, deleteExample, examplesGrounding } = await import('../src/examples.js');

function seedBrand(db, label) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES (?, ?, '{}', 1, ?, ?)`
    )
    .run(`Examples Brand ${label}`, `examples-brand-${label}-${Math.random()}`, now, now).lastInsertRowid;
}

function writeStubClaudeBin(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-examples-'));
  const binPath = path.join(dir, 'claude-stub.js');
  const envelope = JSON.stringify({ result: JSON.stringify({ text }) });
  fs.writeFileSync(binPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`, { mode: 0o755 });
  return { dir, binPath };
}

test('v5 migration: accounts.manual defaults to 0 and examples table exists', () => {
  const db = getDb();
  const brand = seedBrand(db, 'migration');
  const now = nowIso();
  const accountId = db
    .prepare(
      `INSERT INTO accounts (brand_id, platform, target_fields, active, created_at, updated_at)
       VALUES (?, 'reddit', '{}', 1, ?, ?)`
    )
    .run(brand, now, now).lastInsertRowid;

  const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  assert.equal(account.manual, 0);

  // examples table + index exist and are usable.
  const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='examples'").get();
  assert.ok(tableInfo, 'examples table should exist after migration v5');
});

test('createExample (source: paste) inserts a row with tags parsed back to an array', async () => {
  const db = getDb();
  const brand = seedBrand(db, 'paste');

  const row = await createExample(db, {
    brand_id: brand,
    platform: 'reddit',
    source: 'paste',
    text: 'Here is an example Reddit post about our product.',
    tags: ['reddit', 'launch'],
  });

  assert.equal(row.brand_id, brand);
  assert.equal(row.platform, 'reddit');
  assert.equal(row.source, 'paste');
  assert.equal(row.text, 'Here is an example Reddit post about our product.');
  assert.deepEqual(row.tags, ['reddit', 'launch']);
  assert.ok(row.created_at);
});

test('listExamples returns newest first and filters by brand_id and platform', async () => {
  const db = getDb();
  const brand = seedBrand(db, 'list');
  const otherBrand = seedBrand(db, 'list-other');

  const exA = await createExample(db, { brand_id: brand, platform: 'reddit', text: 'A' });
  const exB = await createExample(db, { brand_id: brand, platform: 'twitter', text: 'B' });
  await createExample(db, { brand_id: otherBrand, platform: 'reddit', text: 'C (other brand)' });

  const forBrand = listExamples(db, { brand_id: brand });
  const ids = forBrand.map((r) => r.id);
  assert.ok(ids.includes(exA.id) && ids.includes(exB.id));
  assert.ok(forBrand.every((r) => r.brand_id === brand));

  // newest first
  assert.equal(forBrand[0].id, exB.id);

  const redditOnly = listExamples(db, { brand_id: brand, platform: 'reddit' });
  assert.equal(redditOnly.length, 1);
  assert.equal(redditOnly[0].id, exA.id);
});

test('deleteExample removes the row and is a no-op the second time', async () => {
  const db = getDb();
  const brand = seedBrand(db, 'delete');
  const row = await createExample(db, { brand_id: brand, platform: 'reddit', text: 'to be deleted' });

  assert.equal(deleteExample(db, row.id), true);
  assert.equal(deleteExample(db, row.id), false);
  assert.equal(listExamples(db, { brand_id: brand }).find((r) => r.id === row.id), undefined);
});

test('createExample with source "screenshot" caches the extracted text (not the image) via a stubbed vision bin', async () => {
  const db = getDb();
  const brand = seedBrand(db, 'screenshot');
  const { dir, binPath } = writeStubClaudeBin('Extracted post copy from the screenshot.');

  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const row = await createExample(db, {
      brand_id: brand,
      platform: 'instagram',
      source: 'screenshot',
      image_path: '/tmp/fake-screenshot.png',
    });

    assert.equal(row.source, 'screenshot');
    assert.equal(row.image_path, '/tmp/fake-screenshot.png');
    assert.equal(row.text, 'Extracted post copy from the screenshot.');
    assert.notEqual(row.text, row.image_path, 'the image path itself must never be stored as the text');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('createExample with source "screenshot" does not call the vision CLI when text is already provided', async () => {
  const db = getDb();
  const brand = seedBrand(db, 'screenshot-preset');

  // Point at a nonexistent binary — if createExample tried to call it, this
  // would 503/throw. Since text is already provided, it must not be called.
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    const row = await createExample(db, {
      brand_id: brand,
      platform: 'instagram',
      source: 'screenshot',
      text: 'Already-known text, no extraction needed.',
      image_path: '/tmp/fake-screenshot.png',
    });
    assert.equal(row.text, 'Already-known text, no extraction needed.');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});

test('createExample still creates the row (text: null, extraction_error set) when the vision CLI 503s', async () => {
  const db = getDb();
  const brand = seedBrand(db, 'screenshot-fail');

  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    const row = await createExample(db, {
      brand_id: brand,
      platform: 'instagram',
      source: 'screenshot',
      image_path: '/tmp/fake-screenshot.png',
    });
    assert.equal(row.text, null);
    assert.ok(row.extraction_error, 'row should carry an extraction_error note for the UI to retry');

    // The row was actually persisted (not just returned in-memory).
    const persisted = listExamples(db, { brand_id: brand }).find((r) => r.id === row.id);
    assert.ok(persisted);
    assert.equal(persisted.text, null);
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});

test('examplesGrounding returns a prefixed, truncated digest and empty string when there is nothing to ground on', async () => {
  const db = getDb();
  const brand = seedBrand(db, 'grounding');

  const longText = 'y'.repeat(500);
  await createExample(db, { brand_id: brand, platform: 'reddit', source: 'paste', text: 'Short example one.' });
  await createExample(db, { brand_id: brand, platform: 'reddit', source: 'paste', text: longText });

  const digest = examplesGrounding(db, { brand_id: brand, platform: 'reddit', limit: 3 });
  assert.equal(typeof digest, 'string');
  assert.match(digest, /match the style\/format of these example posts/i);
  assert.match(digest, /Short example one\./);
  assert.ok(!digest.includes(longText), 'long example text must be truncated in the digest');
  assert.match(digest, /…/);

  const empty = examplesGrounding(db, { brand_id: brand, platform: 'no-such-platform' });
  assert.equal(empty, '');
});
