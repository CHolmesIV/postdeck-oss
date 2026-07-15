// Unit tests for src/profiles.js (B13 - SPEC.md "Brand profiles (source of
// truth + generate)"). In-memory SQLite DB via POSTDECK_DB_PATH=':memory:'
// (examples.test.js's pattern). Generation is stubbed via
// POSTDECK_CLAUDE_BIN pointing at a temp-file stub CLI - no real network/CLI.
//
// Run with: node --test test/profiles.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const {
  listProfiles,
  getProfile,
  upsertProfile,
  markReviewed,
  markStale,
  setStatus,
  generateProfile,
  seedProfilesFromFile,
} = await import('../src/profiles.js');

function seedBrand(db, slug, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES (?, ?, '{}', 1, ?, ?)`
    )
    .run(overrides.name || `Profiles Brand ${slug}`, slug, now, now);
  return info.lastInsertRowid;
}

function writeStubClaudeBin(fieldsObj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-profiles-'));
  const binPath = path.join(dir, 'claude-stub.js');
  const envelope = JSON.stringify({ result: JSON.stringify(fieldsObj) });
  fs.writeFileSync(binPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`, { mode: 0o755 });
  return { dir, binPath };
}

test('v6 migration: profiles table exists with expected columns', () => {
  const db = getDb();
  const tableInfo = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='profiles'").get();
  assert.ok(tableInfo, 'profiles table should exist after migration v6');
  const cols = db.prepare('PRAGMA table_info(profiles)').all().map((c) => c.name);
  for (const expected of [
    'id',
    'brand_id',
    'platform',
    'fields',
    'status',
    'last_generated_at',
    'last_reviewed_at',
    'created_at',
    'updated_at',
  ]) {
    assert.ok(cols.includes(expected), `profiles.${expected} should exist`);
  }
});

test('upsertProfile inserts then updates on (brand_id, platform), fields JSON round-trips', () => {
  const db = getDb();
  const brandId = seedBrand(db, `upsert-${Math.random()}`);

  const inserted = upsertProfile(db, {
    brand_id: brandId,
    platform: 'linkedin_company',
    fields: { name: 'Acme', tagline: 'Widgets, done right.' },
    status: 'draft',
  });
  assert.equal(inserted.status, 'draft');
  assert.deepEqual(inserted.fields, { name: 'Acme', tagline: 'Widgets, done right.' });

  const updated = upsertProfile(db, {
    brand_id: brandId,
    platform: 'linkedin_company',
    fields: { name: 'Acme', tagline: 'Widgets, better than ever.' },
    status: 'current',
  });
  assert.equal(updated.id, inserted.id, 'upsert should update the same row, not insert a new one');
  assert.equal(updated.status, 'current');
  assert.equal(updated.fields.tagline, 'Widgets, better than ever.');

  const all = listProfiles(db, { brand_id: brandId });
  assert.equal(all.length, 1);
});

test('getProfile / listProfiles', () => {
  const db = getDb();
  const brandId = seedBrand(db, `list-${Math.random()}`);
  upsertProfile(db, { brand_id: brandId, platform: 'facebook_page', fields: { page_name: 'Acme' } });
  upsertProfile(db, { brand_id: brandId, platform: 'reddit', fields: { display_name: 'Acme' } });

  const one = getProfile(db, { brand_id: brandId, platform: 'reddit' });
  assert.equal(one.platform, 'reddit');
  assert.equal(one.fields.display_name, 'Acme');

  const missing = getProfile(db, { brand_id: brandId, platform: 'nope' });
  assert.equal(missing, undefined);

  const all = listProfiles(db, { brand_id: brandId });
  assert.equal(all.length, 2);
});

test('markReviewed sets status current + last_reviewed_at; markStale/setStatus work', () => {
  const db = getDb();
  const brandId = seedBrand(db, `status-${Math.random()}`);
  const row = upsertProfile(db, { brand_id: brandId, platform: 'reddit', fields: {}, status: 'draft' });

  const reviewed = markReviewed(db, row.id);
  assert.equal(reviewed.status, 'current');
  assert.ok(reviewed.last_reviewed_at);

  const staled = markStale(db, row.id);
  assert.equal(staled.status, 'stale');

  const custom = setStatus(db, row.id, 'draft');
  assert.equal(custom.status, 'draft');
});

test('seedProfilesFromFile creates rows from a fixture, idempotent on re-run', () => {
  const db = getDb();
  const slug = `seedfixture-${Math.random()}`;
  seedBrand(db, slug);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-profile-seed-'));
  const fixturePath = path.join(dir, 'profile-seed.fixture.json');
  fs.writeFileSync(
    fixturePath,
    JSON.stringify({
      brand_slug: slug,
      profiles: [
        { platform: 'linkedin_company', fields: { name: 'Fixture Co', tagline: 'Testing, well.' } },
        { platform: 'reddit', fields: { display_name: 'FixtureCo', bio: 'Building things.' } },
      ],
    })
  );

  const count = seedProfilesFromFile(db, fixturePath);
  assert.equal(count, 2);

  const brand = db.prepare('SELECT * FROM brands WHERE slug = ?').get(slug);
  const rows = listProfiles(db, { brand_id: brand.id });
  assert.equal(rows.length, 2);
  assert.ok(rows.some((r) => r.platform === 'linkedin_company' && r.fields.name === 'Fixture Co'));

  // Idempotent: re-running upserts rather than duplicating rows.
  const count2 = seedProfilesFromFile(db, fixturePath);
  assert.equal(count2, 2);
  const rows2 = listProfiles(db, { brand_id: brand.id });
  assert.equal(rows2.length, 2);
});

test('seedProfilesFromFile is a no-op (returns 0) for a missing file or unknown brand_slug', () => {
  const db = getDb();
  assert.equal(seedProfilesFromFile(db, '/nonexistent/path/profile-seed.json'), 0);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-profile-seed-nobrand-'));
  const fixturePath = path.join(dir, 'profile-seed.json');
  fs.writeFileSync(fixturePath, JSON.stringify({ brand_slug: 'does-not-exist', profiles: [{ platform: 'reddit', fields: {} }] }));
  assert.equal(seedProfilesFromFile(db, fixturePath), 0);
});

test('generateProfile drafts fields, scrubs em-dashes, and upserts status draft + last_generated_at', async () => {
  const db = getDb();
  const brandId = seedBrand(db, `gen-${Math.random()}`);

  const { dir, binPath } = writeStubClaudeBin({
    name: 'Acme',
    tagline: 'Widgets - done right.', // em dash should get scrubbed
    about: 'We make widgets.',
    website: 'https://acme.test',
    industry: 'Manufacturing',
    company_size: '',
    specialties: 'widgets',
    location: 'USA',
  });
  process.env.POSTDECK_CLAUDE_BIN = binPath;

  try {
    const row = await generateProfile(db, { brand_id: brandId, platform: 'linkedin_company' });
    assert.equal(row.status, 'draft');
    assert.ok(row.last_generated_at);
    assert.equal(row.fields.name, 'Acme');
    assert.doesNotMatch(row.fields.tagline, /-/, 'em dash should be scrubbed by default global hard rule');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generateProfile is 503-safe when the claude CLI is unavailable', async () => {
  const db = getDb();
  const brandId = seedBrand(db, `gen503-${Math.random()}`);
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary';

  try {
    await assert.rejects(
      generateProfile(db, { brand_id: brandId, platform: 'linkedin_company' }),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});

test('generateProfile 400s for an unknown platform / spec', async () => {
  const db = getDb();
  const brandId = seedBrand(db, `gen400-${Math.random()}`);
  await assert.rejects(
    generateProfile(db, { brand_id: brandId, platform: 'myspace' }),
    (err) => {
      assert.equal(err.statusCode, 400);
      return true;
    }
  );
});
