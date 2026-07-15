// Unit tests for src/inspiration.js (B8 - SPEC.md "Research + inspiration
// ingestion"). Uses an in-memory SQLite DB, following test/analytics.test.js's
// pattern. suggestProfiles is tested against the 503 contract (CLI missing)
// and a stub `claude` binary that echoes a canned JSON envelope - never a
// real network call or CLI.
//
// Run with: node --test test/inspiration.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const {
  listInspiration,
  createInspiration,
  updateInspiration,
  deleteInspiration,
  suggestProfiles,
  buildSuggestPrompt,
} = await import('../src/inspiration.js');

function seedBrand(db, label) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES (?, ?, '{}', 1, ?, ?)`
    )
    .run(`Inspiration Brand ${label}`, `inspiration-brand-${label}-${Math.random()}`, now, now).lastInsertRowid;
}

test('createInspiration inserts a row and parses tags back to an array', () => {
  const db = getDb();
  const brand = seedBrand(db, 'create');

  const row = createInspiration(db, {
    brand_id: brand,
    handle: '@example_creator',
    platform: 'instagram',
    name: 'Example Creator',
    url: 'https://instagram.com/example_creator',
    niche: 'gov contracting',
    why_relevant: 'Great carousel breakdowns of SAM.gov opportunities.',
    tags: ['carousel', 'gov'],
  });

  assert.equal(row.brand_id, brand);
  assert.equal(row.handle, '@example_creator');
  assert.equal(row.source, 'manual', 'defaults to manual');
  assert.deepEqual(row.tags, ['carousel', 'gov']);
  assert.ok(row.created_at);
});

test('listInspiration filters by brand_id and platform', () => {
  const db = getDb();
  const brand = seedBrand(db, 'list');
  const otherBrand = seedBrand(db, 'list-other');

  const ig = createInspiration(db, { brand_id: brand, handle: '@ig_one', platform: 'instagram', tags: [] });
  const tt = createInspiration(db, { brand_id: brand, handle: '@tt_one', platform: 'tiktok', tags: [] });
  createInspiration(db, { brand_id: otherBrand, handle: '@other', platform: 'instagram', tags: [] });

  const forBrand = listInspiration(db, { brand_id: brand });
  assert.ok(forBrand.every((r) => r.brand_id === brand));
  assert.ok(forBrand.some((r) => r.id === ig.id) && forBrand.some((r) => r.id === tt.id));

  const igOnly = listInspiration(db, { brand_id: brand, platform: 'instagram' });
  assert.equal(igOnly.length, 1);
  assert.equal(igOnly[0].id, ig.id);
});

test('updateInspiration patches fields (including tags round-trip) and deleteInspiration removes the row', () => {
  const db = getDb();
  const brand = seedBrand(db, 'update');
  const profile = createInspiration(db, {
    brand_id: brand,
    handle: '@before',
    platform: 'x',
    tags: ['a'],
  });

  const updated = updateInspiration(db, profile.id, { handle: '@after', tags: ['b', 'c'] });
  assert.equal(updated.handle, '@after');
  assert.deepEqual(updated.tags, ['b', 'c']);
  assert.equal(updated.platform, 'x', 'unpatched fields stay intact');

  assert.equal(updateInspiration(db, 999999, { handle: 'nope' }), null);

  assert.equal(deleteInspiration(db, profile.id), true);
  assert.equal(deleteInspiration(db, profile.id), false, 'second delete is a no-op');
  assert.equal(listInspiration(db, { brand_id: brand }).find((r) => r.id === profile.id), undefined);
});

test('buildSuggestPrompt includes brand, niche, and platforms, and states it is suggest-only', () => {
  const prompt = buildSuggestPrompt({ brand: 'Lunula Supply', niche: 'gov contracting', platforms: ['linkedin', 'x'] });
  assert.match(prompt, /Lunula Supply/);
  assert.match(prompt, /gov contracting/);
  assert.match(prompt, /linkedin, x/);
  assert.match(prompt, /suggest-only/i);
  assert.match(prompt, /STRICT JSON ONLY/);
});

test('suggestProfiles rejects with a 503-flagged error when the claude CLI binary is missing', async () => {
  const prevBin = process.env.POSTDECK_CLAUDE_BIN;
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    await assert.rejects(
      () => suggestProfiles({ brand: 'Lunula Supply', niche: 'gov contracting', platforms: ['linkedin'] }),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  } finally {
    process.env.POSTDECK_CLAUDE_BIN = prevBin;
  }
});

test('suggestProfiles never touches the DB (suggest-only contract)', async () => {
  const db = getDb();
  const before = db.prepare('SELECT COUNT(*) AS n FROM inspiration_profiles').get().n;

  const prevBin = process.env.POSTDECK_CLAUDE_BIN;
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    await assert.rejects(() => suggestProfiles({ brand: 'x', niche: 'y', platforms: [] }));
  } finally {
    process.env.POSTDECK_CLAUDE_BIN = prevBin;
  }

  const after = db.prepare('SELECT COUNT(*) AS n FROM inspiration_profiles').get().n;
  assert.equal(after, before, 'suggestProfiles must not write rows even when it runs');
});

test('suggestProfiles happy path: parses a stub CLI JSON envelope into { suggestions }', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-suggest-stub-'));
  const stubPath = path.join(tmpDir, 'claude-stub.js');

  const canned = {
    suggestions: [
      {
        name: 'Jordan Rivera',
        handle: '@jordanbuilds',
        platform: 'linkedin',
        url: 'https://linkedin.com/in/jordanbuilds',
        why_relevant: 'Writes weekly gov-contracting breakdowns with strong hooks.',
      },
      {
        name: 'Sam Okafor',
        handle: '@samo_govcon',
        platform: 'x',
        url: 'https://x.com/samo_govcon',
        why_relevant: 'Threads on SAM.gov opportunity hunting.',
      },
    ],
  };
  const envelope = { result: JSON.stringify(canned) };

  // A tiny Node "CLI" that ignores its args and prints the canned envelope,
  // standing in for `claude -p ... --output-format json`.
  fs.writeFileSync(
    stubPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(envelope))});\n`
  );
  fs.chmodSync(stubPath, 0o755);

  const prevBin = process.env.POSTDECK_CLAUDE_BIN;
  // suggestProfiles execFile's whatever binary POSTDECK_CLAUDE_BIN points at
  // with its fixed arg list (-p <prompt> --model ... --output-format json)
  // and just reads stdout - so a stub script with a shebang stands in fine
  // for the real `claude` CLI here, no network/CLI involved.
  process.env.POSTDECK_CLAUDE_BIN = stubPath;
  try {
    const result = await suggestProfiles({ brand: 'Lunula Supply', niche: 'gov contracting', platforms: ['linkedin', 'x'] });
    assert.equal(result.suggestions.length, 2);
    assert.equal(result.suggestions[0].handle, '@jordanbuilds');
    assert.equal(result.suggestions[1].platform, 'x');
  } finally {
    process.env.POSTDECK_CLAUDE_BIN = prevBin;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
