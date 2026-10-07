// Brand voice editor API + dash normalization (2026-10-07). CB pastes a brand
// voice in Settings; it is saved to the brand's voice doc, which drafting
// reads. No em/en dashes survive into stored voice text or draft prompts.
// Run with: node --test test/brand-voice-editor.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-voice-editor-'));
process.env.POSTDECK_SOCIAL_ROOT = root;
const globalCard = path.join(root, 'docs', 'charles-voice-reference.md');
fs.mkdirSync(path.dirname(globalCard), { recursive: true });
fs.writeFileSync(globalCard, '# CB voice\nDirect.\n');
process.env.POSTDECK_VOICE_REF = globalCard;

const { getDb, nowIso } = await import('../src/db.js');
const { normalizeDashes, resolveVoice, setGlobalVoice, getGlobalVoice } = await import('../src/voice.js');
const { buildServer } = await import('../src/server.js');
const db = getDb();

function brand(slug, voiceDocPath = '') {
  const now = nowIso();
  const id = db
    .prepare('INSERT INTO brands (name, slug, voice_doc_path, active, created_at, updated_at) VALUES (?,?,?,1,?,?)')
    .run(slug, slug, voiceDocPath, now, now).lastInsertRowid;
  db.prepare('INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at) VALUES (?,?,?,?,?,?)')
    .run(id, 'business', '', '{}', now, now);
  return Number(id);
}

test('normalizeDashes: em/en dashes become hyphens, ranges stay tight, a named rule keeps its meaning', () => {
  assert.equal(normalizeDashes('trust — it just pushes'), 'trust - it just pushes');
  assert.equal(normalizeDashes('trust—it'), 'trust - it');
  assert.equal(normalizeDashes('Tue–Thu 9–11am'), 'Tue - Thu 9-11am');
  assert.equal(normalizeDashes('No em dashes (—). Ever.'), 'No em dashes (the long dash). Ever.');
  assert.equal(normalizeDashes('plain - hyphen stays'), 'plain - hyphen stays');
  assert.doesNotMatch(normalizeDashes('a — b – c'), /[—–]/);
});

test('PUT /api/brands/:id/voice creates brands/<slug>/voice.md for a brand with no doc and points the brand at it', async () => {
  const app = buildServer();
  const id = brand('newbrand');
  const res = await app.inject({ method: 'PUT', url: `/api/brands/${id}/voice`, payload: { text: 'Plain voice — no fluff.' } });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.path, path.join('brands', 'newbrand', 'voice.md'));
  assert.equal(body.exists, true);
  assert.equal(body.text, 'Plain voice - no fluff.\n');
  assert.equal(fs.readFileSync(path.join(root, 'brands', 'newbrand', 'voice.md'), 'utf8'), 'Plain voice - no fluff.\n');
  assert.equal(db.prepare('SELECT voice_doc_path FROM brands WHERE id = ?').get(id).voice_doc_path, body.path);

  const got = await app.inject({ method: 'GET', url: `/api/brands/${id}/voice` });
  assert.equal(got.json().text, 'Plain voice - no fluff.\n');
  await app.close();
});

test('PUT overwrites an existing doc and drafting picks up the new text immediately', async () => {
  const app = buildServer();
  fs.mkdirSync(path.join(root, 'brands', 'existing'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brands', 'existing', 'voice.md'), 'old voice\n');
  const id = brand('existing', 'brands/existing/voice.md');
  assert.match(resolveVoice(db, { brand_id: id, tone: 'business' }).voice, /old voice/);

  const res = await app.inject({ method: 'PUT', url: `/api/brands/${id}/voice`, payload: { text: 'NEW pasted voice' } });
  assert.equal(res.statusCode, 200);
  const voice = resolveVoice(db, { brand_id: id, tone: 'business' }).voice;
  assert.match(voice, /NEW pasted voice/);
  assert.doesNotMatch(voice, /old voice/);
  await app.close();
});

test('a brand whose doc is the global voice card is edited as the global voice, not here (409)', async () => {
  const app = buildServer();
  const id = brand('cbself', 'docs/charles-voice-reference.md');
  const info = await app.inject({ method: 'GET', url: `/api/brands/${id}/voice` });
  assert.equal(info.json().is_global_voice, true);
  const res = await app.inject({ method: 'PUT', url: `/api/brands/${id}/voice`, payload: { text: 'x' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'global_voice');
  assert.equal(fs.readFileSync(globalCard, 'utf8'), '# CB voice\nDirect.\n');
  await app.close();
});

test('writes are confined to .md files inside the Social Media folder', async () => {
  const app = buildServer();
  const outside = brand('outside', '/etc/passwd.md');
  const notMd = brand('notmd', 'brands/notmd/voice.txt');
  const traversal = brand('trav', '../../escape.md');
  for (const id of [outside, notMd, traversal]) {
    const res = await app.inject({ method: 'PUT', url: `/api/brands/${id}/voice`, payload: { text: 'x' } });
    assert.equal(res.statusCode, 400, `brand ${id}`);
    assert.equal(res.json().error, 'bad_path');
  }
  const missing = await app.inject({ method: 'PUT', url: '/api/brands/99999/voice', payload: { text: 'x' } });
  assert.equal(missing.statusCode, 404);
  const noText = await app.inject({ method: 'PUT', url: `/api/brands/${outside}/voice`, payload: {} });
  assert.equal(noText.statusCode, 400);
  await app.close();
});

test('no dashes reach a draft prompt: global voice, brand doc and tone rules are all normalized', async () => {
  const app = buildServer();
  setGlobalVoice(db, 'Global — voice');
  assert.equal(getGlobalVoice(db), 'Global - voice');

  fs.mkdirSync(path.join(root, 'brands', 'dashy'), { recursive: true });
  fs.writeFileSync(path.join(root, 'brands', 'dashy', 'voice.md'), 'Doc written by hand — with a dash\n');
  const id = brand('dashy', 'brands/dashy/voice.md');
  const tone = db.prepare('SELECT id FROM tone_profiles WHERE brand_id = ?').get(id);
  const patched = await app.inject({ method: 'PATCH', url: `/api/tone-profiles/${tone.id}`, payload: { voice_rules: 'Tone – tweak' } });
  assert.equal(patched.json().voice_rules, 'Tone - tweak');

  const voice = resolveVoice(db, { brand_id: id, tone: 'business' }).voice;
  assert.doesNotMatch(voice, /[—–]/);
  assert.match(voice, /Doc written by hand - with a dash/);
  setGlobalVoice(db, '');
  await app.close();
});

test('a brand voice doc in a sibling project folder (website branding docs) can be read and saved', async () => {
  const app = buildServer();
  // Projects root defaults to the parent of the Social Media folder.
  const siteDir = path.join(path.dirname(root), `site-${path.basename(root)}`, 'brand');
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'brand-voice.md'), 'old\n');
  const rel = path.relative(root, path.join(siteDir, 'brand-voice.md'));
  const id = brand('sitebrand', rel);
  const res = await app.inject({ method: 'PUT', url: `/api/brands/${id}/voice`, payload: { text: 'Website voice — direct' } });
  assert.equal(res.statusCode, 200);
  assert.equal(fs.readFileSync(path.join(siteDir, 'brand-voice.md'), 'utf8'), 'Website voice - direct\n');
  assert.match(resolveVoice(db, { brand_id: id, tone: 'business' }).voice, /Website voice - direct/);
  fs.rmSync(path.dirname(siteDir), { recursive: true, force: true });
  await app.close();
});
