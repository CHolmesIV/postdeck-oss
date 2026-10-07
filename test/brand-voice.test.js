// Brand voice doc composition (voice.js): global voice + brand voice doc + tone rules. In-memory DB, temp-dir doc root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-voice-'));
process.env.POSTDECK_SOCIAL_ROOT = root;

const { getDb, nowIso } = await import('../src/db.js');
const { resolveVoice, withGlobalVoice, setGlobalVoice, readBrandVoiceDoc, isPlaceholderVoiceRules } =
  await import('../src/voice.js');

const db = getDb();
let n = 0;
function mk(docPath, rules) {
  const slug = `vb${++n}`;
  const now = nowIso();
  const b = db
    .prepare('INSERT INTO brands (name, slug, voice_doc_path, active, created_at, updated_at) VALUES (?,?,?,1,?,?)')
    .run(slug, slug, docPath, now, now).lastInsertRowid;
  db.prepare('INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(b, 'business', rules, '{}', now, now);
  return Number(b);
}
setGlobalVoice(db, 'GLOBAL-CB');

test('brand doc is included between global voice and tone rules', () => {
  const f = path.join(root, 'abs.md');
  fs.writeFileSync(f, 'BRAND-DOC-TEXT');
  const id = mk(f, 'TONE-RULES');
  const { voice } = resolveVoice(db, { brand_id: id, tone: 'business' });
  assert.ok(voice.indexOf('GLOBAL-CB') < voice.indexOf('BRAND-DOC-TEXT'));
  assert.ok(voice.indexOf('BRAND-DOC-TEXT') < voice.indexOf('TONE-RULES'));
  const tp = db.prepare('SELECT * FROM tone_profiles WHERE brand_id = ?').get(id);
  assert.match(withGlobalVoice(db, { brand_id: id, toneProfile: tp }).voice_rules, /BRAND-DOC-TEXT/);
});

test('relative path resolves against the Social Media root', () => {
  fs.mkdirSync(path.join(root, 'brands', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brands', 'x', 'voice.md'), 'REL-DOC');
  const id = mk('brands/x/voice.md', '');
  assert.match(resolveVoice(db, { brand_id: id, tone: 'business' }).voice, /REL-DOC/);
});

test('missing file is skipped silently', () => {
  const id = mk('brands/nope/voice.md', 'TONE-ONLY');
  const { voice } = resolveVoice(db, { brand_id: id, tone: 'business' });
  assert.equal(voice, 'GLOBAL-CB\n\nTONE-ONLY');
});

test('seed placeholder voice_rules are ignored', () => {
  const ph = 'Voice reference for X (business tone): see /a/b.md. Placeholder - populate...';
  assert.equal(isPlaceholderVoiceRules(ph), true);
  const id = mk('', ph);
  assert.equal(resolveVoice(db, { brand_id: id, tone: 'business' }).voice, 'GLOBAL-CB');
});

test('brand doc is capped at 4000 chars and re-read when mtime changes', () => {
  const f = path.join(root, 'big.md');
  fs.writeFileSync(f, 'a'.repeat(9000));
  const id = mk(f, '');
  assert.equal(readBrandVoiceDoc(db, id).length, 4000);
  fs.writeFileSync(f, 'short-now');
  const t = new Date(Date.now() + 5000);
  fs.utimesSync(f, t, t);
  assert.equal(readBrandVoiceDoc(db, id), 'short-now');
});
