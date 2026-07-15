// Unit tests for src/research.js (B8 - SPEC.md "Research + inspiration
// ingestion"). Uses an in-memory SQLite DB, following test/analytics.test.js's
// pattern (module-level getDb() singleton shared across tests in this file).
// The inbox importer test points POSTDECK_RESEARCH_DIR at a scratch tmp dir
// so it never touches the real research-inbox/ folder.
//
// Run with: node --test test/research.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const {
  listResearch,
  createResearchNote,
  updateResearchNote,
  deleteResearchNote,
  importResearchText,
  groundingForBrand,
  importResearchInbox,
} = await import('../src/research.js');

function seedBrand(db, label) {
  const now = nowIso();
  return db
    .prepare(
      `INSERT INTO brands (name, slug, colors, active, created_at, updated_at)
       VALUES (?, ?, '{}', 1, ?, ?)`
    )
    .run(`Research Brand ${label}`, `research-brand-${label}-${Math.random()}`, now, now).lastInsertRowid;
}

test('createResearchNote inserts a row, parses tags back to an array, defaults captured_at', () => {
  const db = getDb();
  const brand = seedBrand(db, 'create');

  const row = createResearchNote(db, {
    brand_id: brand,
    source: 'best_practice',
    title: 'Carousels outperform',
    url: 'https://example.com/post',
    body: 'Carousels get 2x the saves of single images in this niche.',
    tags: ['carousel', 'format'],
  });

  assert.equal(row.brand_id, brand);
  assert.equal(row.source, 'best_practice');
  assert.equal(row.title, 'Carousels outperform');
  assert.deepEqual(row.tags, ['carousel', 'format']);
  assert.ok(row.created_at);
  assert.ok(row.captured_at, 'captured_at should default to now when not given');
});

test('listResearch returns newest first and filters by brand_id and tag', () => {
  const db = getDb();
  const brand = seedBrand(db, 'list');
  const otherBrand = seedBrand(db, 'list-other');

  const noteA = createResearchNote(db, { brand_id: brand, title: 'A', body: 'first', tags: ['hooks'] });
  const noteB = createResearchNote(db, { brand_id: brand, title: 'B', body: 'second', tags: ['carousel'] });
  createResearchNote(db, { brand_id: otherBrand, title: 'C (other brand)', body: 'third', tags: ['hooks'] });

  const forBrand = listResearch(db, { brand_id: brand });
  const ids = forBrand.map((r) => r.id);
  assert.ok(ids.includes(noteA.id) && ids.includes(noteB.id));
  assert.ok(!ids.includes(0), 'sanity');
  assert.ok(forBrand.every((r) => r.brand_id === brand), 'brand_id filter must scope to the brand');

  // newest first
  assert.equal(forBrand[0].id, noteB.id);

  const tagged = listResearch(db, { brand_id: brand, tag: 'hooks' });
  assert.equal(tagged.length, 1);
  assert.equal(tagged[0].id, noteA.id);
});

test('updateResearchNote patches fields (including tags) and deleteResearchNote removes the row', () => {
  const db = getDb();
  const brand = seedBrand(db, 'update');
  const note = createResearchNote(db, { brand_id: brand, title: 'Original', body: 'body', tags: ['x'] });

  const updated = updateResearchNote(db, note.id, { title: 'Updated title', tags: ['y', 'z'] });
  assert.equal(updated.title, 'Updated title');
  assert.deepEqual(updated.tags, ['y', 'z']);
  assert.equal(updated.body, 'body', 'unpatched fields stay intact');

  assert.equal(updateResearchNote(db, 999999, { title: 'nope' }), null);

  const deleted = deleteResearchNote(db, note.id);
  assert.equal(deleted, true);
  assert.equal(deleteResearchNote(db, note.id), false, 'second delete is a no-op');
  assert.equal(listResearch(db, { brand_id: brand }).find((r) => r.id === note.id), undefined);
});

test('importResearchText parses plain text (title = first line, rest = body)', () => {
  const db = getDb();
  const brand = seedBrand(db, 'import-text');

  const row = importResearchText(db, {
    brand_id: brand,
    source: 'reddit',
    filename: 'reddit-thread.txt',
    content: '# Question-style hooks win\n\nSaw this across three subs this week.\nWorth testing.',
  });

  assert.equal(row.title, 'Question-style hooks win');
  assert.equal(row.source, 'reddit');
  assert.match(row.body, /Saw this across three subs/);
});

test('importResearchText treats CSV content as a raw blob titled from the filename', () => {
  const db = getDb();
  const brand = seedBrand(db, 'import-csv');

  const csvContent = 'keyword,interest\n"content studio",87\n"social scheduler",42\n';
  const row = importResearchText(db, {
    brand_id: brand,
    source: 'google_trends',
    filename: 'trends_export.csv',
    content: csvContent,
  });

  assert.equal(row.source, 'google_trends');
  assert.equal(row.title, 'trends export');
  assert.equal(row.body, csvContent);

  // Also detect a .csv filename even when source wasn't pre-labeled.
  const row2 = importResearchText(db, {
    brand_id: brand,
    filename: 'another-export.csv',
    content: 'a,b\n1,2\n',
  });
  assert.equal(row2.source, 'google_trends');
  assert.equal(row2.title, 'another export');
});

test('groundingForBrand returns a truncated plain-text digest of recent notes', () => {
  const db = getDb();
  const brand = seedBrand(db, 'grounding');

  const longBody = 'x'.repeat(500);
  createResearchNote(db, { brand_id: brand, source: 'best_practice', title: 'Old note', body: 'short body', tags: ['carousel'] });
  createResearchNote(db, { brand_id: brand, source: 'web', title: 'Long note', body: longBody, tags: ['carousel'] });

  const digest = groundingForBrand(db, { brand_id: brand, tag: 'carousel', limit: 5 });
  assert.equal(typeof digest, 'string');
  assert.match(digest, /Long note/);
  assert.match(digest, /Old note/);
  // body should be truncated to ~300 chars per note, not the full 500.
  assert.ok(!digest.includes(longBody), 'long bodies must be truncated in the digest');
  assert.match(digest, /…/);

  const empty = groundingForBrand(db, { brand_id: brand, tag: 'no-such-tag' });
  assert.equal(empty, '');

  // `pillar` alias should behave the same as `tag`.
  const viaPillar = groundingForBrand(db, { brand_id: brand, pillar: 'carousel', limit: 5 });
  assert.equal(viaPillar, digest);
});

test('importResearchInbox scans research-inbox/ for md/txt/csv files, creates rows, and moves files to processed/', async () => {
  const db = getDb();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-research-inbox-'));
  const prevDir = process.env.POSTDECK_RESEARCH_DIR;
  process.env.POSTDECK_RESEARCH_DIR = tmpDir;

  try {
    fs.writeFileSync(path.join(tmpDir, 'note-one.md'), '# Reels beat static posts\n\nSeen across 3 accounts this month.');
    fs.writeFileSync(path.join(tmpDir, 'trend-export.csv'), 'keyword,interest\n"ai tools",90\n');

    const created = importResearchInbox(db);
    assert.equal(created.length, 2);

    const mdNote = created.find((r) => r.title === 'Reels beat static posts');
    assert.ok(mdNote, 'markdown note should be created');
    assert.equal(mdNote.source, 'best_practice');

    const csvNote = created.find((r) => r.source === 'google_trends');
    assert.ok(csvNote, 'csv note should be created with google_trends source');
    assert.match(csvNote.body, /keyword,interest/);

    // files moved to processed/, inbox itself is now empty of source files
    const processedDir = path.join(tmpDir, 'processed');
    const processedFiles = fs.readdirSync(processedDir).sort();
    assert.deepEqual(processedFiles, ['note-one.md', 'trend-export.csv']);

    const remainingInInbox = fs
      .readdirSync(tmpDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(md|txt|csv)$/i.test(e.name));
    assert.equal(remainingInInbox.length, 0);

    // second call is a no-op (nothing left to import)
    const secondPass = importResearchInbox(db);
    assert.equal(secondPass.length, 0);
  } finally {
    process.env.POSTDECK_RESEARCH_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
