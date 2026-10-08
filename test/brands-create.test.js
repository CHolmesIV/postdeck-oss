// POST /api/brands: slug generation and uniqueness, the tone profile rows, validation.
// Run: node --test test/brands-create.test.js

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';
process.env.POSTDECK_WEB_SYNC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';

const { getDb } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const app = buildServer();
const db = getDb();
const post = (payload) => app.inject({ method: 'POST', url: '/api/brands', payload });

test('create brand: 201, slug from the name, three tone profiles', async () => {
  const r = await post({ name: '  Client Four  ' });
  assert.equal(r.statusCode, 201, r.body);
  const b = r.json();
  assert.equal(b.name, 'Client Four');
  assert.equal(b.slug, 'client-four');
  assert.equal(b.active, 1);
  assert.equal(typeof b.colors, 'object');
  const tones = db.prepare('SELECT name, hard_rules FROM tone_profiles WHERE brand_id = ? ORDER BY name').all(b.id);
  assert.deepEqual(tones.map((t) => t.name), ['business', 'casual', 'personal']);
  assert.ok(tones.every((t) => JSON.parse(t.hard_rules).no_em_dash === true));
  const list = (await app.inject({ method: 'GET', url: '/api/brands' })).json();
  assert.ok(list.some((x) => x.id === b.id));
});

test('create brand: slug stays unique and clean', async () => {
  const a = (await post({ name: 'Acme & Sons!' })).json();
  const b = (await post({ name: 'Acme & Sons!' })).json();
  const c = (await post({ name: 'acme sons' })).json();
  assert.equal(a.slug, 'acme-sons');
  assert.equal(b.slug, 'acme-sons-2');
  assert.equal(c.slug, 'acme-sons-3');
  const explicit = (await post({ name: 'Other', slug: 'My Custom Slug' })).json();
  assert.equal(explicit.slug, 'my-custom-slug');
  const symbols = (await post({ name: '!!!' })).json();
  assert.equal(symbols.slug, 'brand');
  assert.equal(db.prepare('SELECT COUNT(DISTINCT slug) n FROM brands').get().n, db.prepare('SELECT COUNT(*) n FROM brands').get().n);
});

test('create brand: color is stored, bad input is 400', async () => {
  const ok = await post({ name: 'Colorful', color: '#1a2b3c' });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().colors.primary, '#1a2b3c');
  assert.equal((await post({ name: 'Bad color', color: 'red' })).statusCode, 400);
  for (const payload of [{}, { name: '' }, { name: '   ' }, { name: 42 }]) {
    const r = await post(payload);
    assert.equal(r.statusCode, 400, JSON.stringify(payload));
    assert.equal(r.json().error, 'bad_request');
  }
});
