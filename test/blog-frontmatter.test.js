// Blog add-on: front matter round trip, schema derivation, discovery.
// Fake site tree only (test/_blog-fixture.js). Run: node --test test/blog-frontmatter.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeRoot, setupEnv, POST } from './_blog-fixture.js';

setupEnv();
const fake = makeFakeRoot({
  posts: {
    'old-post': POST({ slug: 'old-post', title: 'Old', publish_date: '2098-01-01', cluster: 'Beta Topic', tier: 'pillar' }),
    'sample-post': POST(),
    'quoted-post': POST({ slug: 'quoted-post', title: '"Quoted: Title | Site"', publish_date: '2098-06-01' }),
  },
});
process.env.POSTDECK_WEBSITES_ROOT = fake.root;

const bl = await import('../src/blog.js');
const { buildServer } = await import('../src/server.js');
const app = buildServer();
const get = async (url) => app.inject({ method: 'GET', url });

test('discovery finds only real sites, id slugified, live_url parsed from SITE', async () => {
  const res = await get('/api/blog/sites');
  assert.equal(res.statusCode, 200);
  const sites = res.json();
  assert.equal(sites.length, 1);
  assert.equal(sites[0].id, 'fake-site');
  assert.equal(sites[0].name, 'Fake Site');
  assert.equal(sites[0].live_url, 'https://fake.example');
  assert.equal(sites[0].default_time, '09:00');
  assert.deepEqual(sites[0].counts, { draft: 0, needs_review: 3, scheduled: 0, published: 0 });
});

test('setKeys: untouched lines stay byte-identical, only the changed key line differs', () => {
  const raw = fs.readFileSync(path.join(fake.content, 'quoted-post.md'), 'utf8');
  const out = bl.setKeys(raw, { description: 'New description', needs_cb_review: false });
  const a = raw.split('\n');
  const b = out.split('\n');
  assert.equal(a.length, b.length);
  const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((x) => x !== null);
  assert.equal(diff.length, 2);
  assert.equal(b[a.findIndex((l) => l.startsWith('description:'))], 'description: New description');
  assert.ok(out.includes('needs_cb_review: false'));
  // the quoted title line is untouched
  assert.ok(out.includes('title: "Quoted: Title | Site"'));
  // body untouched
  assert.equal(out.split('\n---\n')[1], raw.split('\n---\n')[1]);
});

test('setKeys: no-op when values equal, new keys land before the closing ---, lists as [a, b]', () => {
  const raw = fs.readFileSync(path.join(fake.content, 'sample-post.md'), 'utf8');
  assert.equal(bl.setKeys(raw, { title: 'Sample Post', related: ['a-post', 'b-post'] }), raw);
  const out = bl.setKeys(raw, { publish_time: '09:30', secondary_keywords: ['x', 'y z'] });
  assert.ok(out.includes('secondary_keywords: [x, y z]'));
  assert.match(out, /publish_time: 09:30\n---\nBody text here/);
});

test('formatValue quotes only when needed; booleans and dashes', () => {
  assert.equal(bl.formatValue('plain text'), 'plain text');
  assert.equal(bl.formatValue('has: colon'), '"has: colon"');
  assert.equal(bl.formatValue('[bracket'), '"[bracket"');
  assert.equal(bl.formatValue(true), 'true');
  assert.equal(bl.formatValue(false), 'false');
  assert.equal(bl.formatValue('a — b'), 'a - b');
  assert.equal(bl.formatValue(['a', 'b']), '[a, b]');
  // keeps a file's existing quoting style
  assert.equal(bl.formatValue('Plain', '"Old"'), '"Plain"');
  // comma-list style files stay comma lists
  assert.equal(bl.formatValue(['a', 'b'], 'x, y'), 'a, b');
});

test('setKeys preserves CRLF files and comment lines', () => {
  const raw = '---\r\n# a comment\r\ntitle: T\r\nstatus: draft\r\n---\r\nbody\r\n';
  const out = bl.setKeys(raw, { status: 'scheduled' });
  assert.equal(out, '---\r\n# a comment\r\ntitle: T\r\nstatus: scheduled\r\n---\r\nbody\r\n');
});

test('schema: key order from most recent post, kinds, options from CLUSTERS/TIERS, required from read_post', async () => {
  const res = await get('/api/blog/sites/fake-site/schema');
  assert.equal(res.statusCode, 200);
  const { fields } = res.json();
  const keys = fields.map((f) => f.key);
  assert.deepEqual(keys.slice(0, 5), ['title', 'headline', 'description', 'slug', 'cluster']);
  assert.equal(keys[keys.length - 1], 'publish_time');
  const by = Object.fromEntries(fields.map((f) => [f.key, f]));
  assert.equal(by.description.kind, 'long');
  assert.equal(by.publish_date.kind, 'date');
  assert.equal(by.needs_cb_review.kind, 'bool');
  assert.equal(by.secondary_keywords.kind, 'list');
  assert.equal(by.related.kind, 'list');
  assert.equal(by.cluster.kind, 'select');
  assert.deepEqual(by.cluster.options, ['Alpha', 'Beta Topic']);
  assert.deepEqual(by.tier.options, ['cluster', 'pillar']);
  assert.equal(by.headline.required, true);
  assert.equal(by.title.required, true);
  assert.equal(by.updated_date.required, false);
  assert.equal(by.secondary_keywords.required, false);
});

test('post list: shape, mtime, due_at, quoted title parsed, lists as arrays', async () => {
  const res = await get('/api/blog/sites/fake-site/posts');
  const posts = res.json();
  assert.equal(posts.length, 3);
  const q = posts.find((p) => p.slug === 'quoted-post');
  assert.equal(q.title, '"Quoted: Title | Site"'.slice(1, -1));
  assert.equal(typeof q.mtime, 'number');
  assert.equal(q.status, 'scheduled');
  assert.equal(q.needs_review, true);
  assert.deepEqual(q.fields.secondary_keywords, ['one', 'two']);
  assert.equal(q.publish_time, null);
  assert.ok(q.due_at.startsWith('2098-06-01') || q.due_at.startsWith('2098-05-31') || q.due_at.startsWith('2098-06-02'));
  assert.equal(q.released, false);
  assert.equal(q.live_url, null);
  assert.equal(q.body_md, undefined);
  const one = (await get('/api/blog/sites/fake-site/posts/sample-post')).json();
  assert.match(one.body_md, /^Body text here/);
});
