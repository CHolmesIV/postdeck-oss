#!/usr/bin/env node
// Set brands.voice_doc_path per slug (idempotent). Default is --dry-run.
// Refuses to run unless POSTDECK_DB_PATH is explicitly set, so it can never
// silently hit the live DB. Usage:
//   POSTDECK_DB_PATH=/path/to/scratch.db node scripts/apply-brand-voices.js [--dry-run|--apply]

import { fileURLToPath } from 'node:url';

// Paths are relative to the brand-docs root (voice.js resolves them).
const VOICE_DOCS = {
  // Relative paths resolve against the brand-docs folder. Edit to match your layout.
  personal: '../sites/personal/brand/brand-voice.md',
  acme: '../sites/acme/brand-voice.md',
  northwind: '../sites/northwind/brand-voice.md',
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
if (apply && args.includes('--dry-run')) {
  console.error('Pick one of --dry-run or --apply.');
  process.exit(2);
}
if (!process.env.POSTDECK_DB_PATH) {
  console.error(
    'Refusing to run: POSTDECK_DB_PATH is not set. This script writes brands.voice_doc_path and must never default to the live DB. Set POSTDECK_DB_PATH explicitly (":memory:" or a scratch copy).'
  );
  process.exit(1);
}

const { getDb, DB_PATH } = await import('../src/db.js');
const db = getDb();
const rows = [];
const upd = db.prepare('UPDATE brands SET voice_doc_path = ?, updated_at = ? WHERE slug = ?');
for (const [slug, next] of Object.entries(VOICE_DOCS)) {
  const b = db.prepare('SELECT voice_doc_path FROM brands WHERE slug = ?').get(slug);
  if (!b) {
    rows.push({ slug, before: '(no such brand)', after: '-', change: 'skip' });
    continue;
  }
  const before = b.voice_doc_path || '';
  const change = before === next ? 'same' : apply ? 'updated' : 'would update';
  if (apply && before !== next) upd.run(next, new Date().toISOString(), slug);
  rows.push({ slug, before: before || '(empty)', after: next, change });
}
console.log(`DB: ${DB_PATH}  mode: ${apply ? 'APPLY' : 'dry-run'}`);
console.table(rows);
if (!apply) console.log('No changes written. Re-run with --apply to write.');
