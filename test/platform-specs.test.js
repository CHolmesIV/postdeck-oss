// Tests for GET /api/platform-specs and the config-driven TikTok required
// fields (B7 — SPEC.md "Platform lineup"). Run with: node --test test/platform-specs.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SPECS_PATH = path.join(__dirname, '..', 'config', 'platform-specs.json');

const { buildServer } = await import('../src/server.js');
const { validateTiktokFields, tiktokRequiredFields } = await import('../src/validate.js');

test('GET /api/platform-specs returns the config/platform-specs.json contents', async () => {
  const app = buildServer();
  const res = await app.inject({ method: 'GET', url: '/api/platform-specs' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  const onDisk = JSON.parse(fs.readFileSync(SPECS_PATH, 'utf8'));
  assert.deepEqual(body, onDisk);
  assert.equal(body.reddit.blotato, false);
  assert.equal(body.tiktok.blotato, true);
  await app.close();
});

test('tiktokRequiredFields() reads the list from platform-specs.json', () => {
  const onDisk = JSON.parse(fs.readFileSync(SPECS_PATH, 'utf8'));
  assert.deepEqual(tiktokRequiredFields().sort(), onDisk.tiktok.required_fields.sort());
});

test('validateTiktokFields still flags every config-driven required field when empty', () => {
  const { ok, missing } = validateTiktokFields({});
  assert.equal(ok, false);
  assert.deepEqual(missing.sort(), tiktokRequiredFields().sort());
});
