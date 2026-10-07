// Blog add-on: create/patch/approve/schedule/unschedule, conflicts, path
// confinement, dash normalization, settings, AI draft. Fake site tree only.
// Run: node --test test/blog-api.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFakeRoot, setupEnv, POST } from './_blog-fixture.js';

setupEnv();
const fake = makeFakeRoot({
  posts: {
    'existing-one': POST({ slug: 'existing-one', title: 'Existing One', publish_date: '2099-03-01' }),
    'live-one': POST({ slug: 'live-one', title: 'Live One', status: 'published', needs_cb_review: 'false', publish_date: '2020-01-01' }),
  },
});
process.env.POSTDECK_WEBSITES_ROOT = fake.root;

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const bl = await import('../src/blog.js');
const app = buildServer();
const db = getDb();
const B = '/api/blog/sites/fake-site';
const req = (method, url, payload) => app.inject({ method, url, payload });
const file = (slug) => path.join(fake.content, `${slug}.md`);

const NEW = {
  fields: {
    title: 'A Fresh Post — With Dash',
    headline: 'Fresh Headline',
    description: 'Fresh description – with an en dash.',
    cluster: 'Alpha',
    tier: 'cluster',
    primary_keyword: 'fresh keyword',
    secondary_keywords: ['k1', 'k2'],
  },
  body_md: 'Intro — with dash.\n\n## H2\n\ntext\n',
};

test('create: draft + needs review, next free date >= tomorrow skipping scheduled dates, all keys in order, dashes normalized', async () => {
  const res = await req('POST', `${B}/posts`, NEW);
  assert.equal(res.statusCode, 201, res.body);
  const post = res.json();
  assert.equal(post.slug, 'a-fresh-post-with-dash');
  assert.equal(post.status, 'draft');
  assert.equal(post.needs_review, true);
  assert.equal(post.title, 'A Fresh Post - With Dash');
  assert.equal(post.fields.description, 'Fresh description - with an en dash.');
  assert.equal(post.body_md, 'Intro - with dash.\n\n## H2\n\ntext\n');
  assert.equal(post.fields.updated_date, post.publish_date);
  assert.ok(post.publish_date > bl.localDate());
  const raw = fs.readFileSync(file(post.slug), 'utf8');
  assert.ok(!/[–—]/.test(raw));
  const keys = raw.split('\n---\n')[0].split('\n').map((l) => l.split(':')[0]);
  assert.deepEqual(keys.slice(0, 5), ['---', 'title', 'headline', 'description', 'slug'].slice(0, 5));
  assert.ok(raw.includes('secondary_keywords: [k1, k2]'));
  assert.ok(raw.includes('needs_cb_review: true'));
});

test('create: next free date skips a date used by a scheduled post', async () => {
  const tomorrow = (() => { const d = new Date(); d.setDate(d.getDate() + 1); return bl.localDate(d); })();
  fs.writeFileSync(file('taken-tomorrow'), POST({ slug: 'taken-tomorrow', title: 'Taken', publish_date: tomorrow, needs_cb_review: 'false' }));
  const res = await req('POST', `${B}/posts`, { ...NEW, fields: { ...NEW.fields, title: 'Date Skip' } });
  assert.equal(res.statusCode, 201);
  assert.ok(res.json().publish_date > tomorrow);
  fs.unlinkSync(file('taken-tomorrow'));
});

test('create validation: missing required, bad cluster, slug taken, unknown field, bad slug', async () => {
  let r = await req('POST', `${B}/posts`, { fields: { title: 'No Desc', cluster: 'Alpha', tier: 'cluster' }, body_md: '' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'missing_required');
  assert.ok(r.json().missing.includes('description'));
  r = await req('POST', `${B}/posts`, { fields: { ...NEW.fields, title: 'Bad Cluster', cluster: 'Nope' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'bad_cluster');
  r = await req('POST', `${B}/posts`, { fields: { ...NEW.fields, title: 'Existing One' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'slug_taken');
  r = await req('POST', `${B}/posts`, { fields: { ...NEW.fields, title: 'Unk', bogus: 'x' } });
  assert.equal(r.statusCode, 400);
  r = await req('POST', `${B}/posts`, { fields: { ...NEW.fields, slug: '../evil' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'bad_slug');
});

test('path/slug confinement', async () => {
  for (const s of ['..%2Fetc', '.hidden', 'UPPER', 'a_b', '-x']) {
    const r = await req('GET', `${B}/posts/${s}`);
    assert.ok([400, 404].includes(r.statusCode), `${s} -> ${r.statusCode}`);
    assert.notEqual(r.statusCode, 200);
  }
  assert.equal((await req('GET', `${B}/posts/nope-missing`)).statusCode, 404);
  assert.equal((await req('GET', '/api/blog/sites/ghost/schema')).statusCode, 404);
  // a symlink inside content/ that points outside is refused
  const outside = path.join(fake.root, 'outside.md');
  fs.writeFileSync(outside, POST({ slug: 'link-out' }));
  fs.symlinkSync(outside, file('link-out'));
  const r = await req('GET', `${B}/posts/link-out`);
  assert.equal(r.statusCode, 400);
  fs.unlinkSync(file('link-out'));
});

test('patch: edits only the changed line, requires mtime, 409 changed_on_disk, slug locked when published', async () => {
  const before = fs.readFileSync(file('existing-one'), 'utf8');
  const cur = (await req('GET', `${B}/posts/existing-one`)).json();
  let r = await req('PATCH', `${B}/posts/existing-one`, { fields: { title: 'x' } });
  assert.equal(r.statusCode, 400);
  r = await req('PATCH', `${B}/posts/existing-one`, {
    mtime: cur.mtime,
    fields: { description: 'Edited — desc', related: ['x', 'y'], status: 'scheduled' },
    body_md: 'New body — here.\n',
  });
  assert.equal(r.statusCode, 200, r.body);
  const after = fs.readFileSync(file('existing-one'), 'utf8');
  const a = before.split('\n');
  const b = after.split('\n');
  const changed = a.map((l, i) => (l === b[i] ? null : l.split(':')[0])).filter(Boolean);
  assert.ok(changed.includes('description') && changed.includes('related'));
  assert.ok(after.includes('title: Existing One'));
  assert.ok(after.endsWith('---\nNew body - here.\n'));
  assert.ok(!/[–—]/.test(after));
  // stale mtime
  const stale = await req('PATCH', `${B}/posts/existing-one`, { mtime: cur.mtime, fields: { description: 'again' } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error, 'changed_on_disk');
  // changing status through PATCH is refused
  const fresh = r.json();
  r = await req('PATCH', `${B}/posts/existing-one`, { mtime: fresh.mtime, fields: { status: 'published' } });
  assert.equal(r.statusCode, 400);
  // published: slug locked
  const live = (await req('GET', `${B}/posts/live-one`)).json();
  r = await req('PATCH', `${B}/posts/live-one`, { mtime: live.mtime, fields: { slug: 'renamed' } });
  assert.equal(r.statusCode, 400);
  assert.equal(r.json().error, 'slug_locked');
  // unknown field
  r = await req('PATCH', `${B}/posts/existing-one`, { mtime: fresh.mtime, fields: { nonsense: 'x' } });
  assert.equal(r.statusCode, 400);
});

test('patch: a no-op save leaves the file byte-identical; draft slug rename moves the file', async () => {
  const cur = (await req('GET', `${B}/posts/existing-one`)).json();
  const before = fs.readFileSync(file('existing-one'));
  const r = await req('PATCH', `${B}/posts/existing-one`, { mtime: cur.mtime, fields: { title: cur.title }, body_md: cur.body_md });
  assert.equal(r.statusCode, 200);
  assert.ok(before.equals(fs.readFileSync(file('existing-one'))));
  const d = await req('POST', `${B}/posts`, { ...NEW, fields: { ...NEW.fields, title: 'Rename Me' } });
  const post = d.json();
  const rn = await req('PATCH', `${B}/posts/${post.slug}`, { mtime: post.mtime, fields: { slug: 'renamed-post' } });
  assert.equal(rn.statusCode, 200, rn.body);
  assert.equal(rn.json().slug, 'renamed-post');
  assert.ok(fs.existsSync(file('renamed-post')) && !fs.existsSync(file(post.slug)));
  assert.match(fs.readFileSync(file('renamed-post'), 'utf8'), /\nslug: renamed-post\n/);
});

test('approve / schedule / unschedule', async () => {
  let r = await req('POST', `${B}/posts/existing-one/approve`);
  assert.equal(r.json().needs_review, false);
  assert.ok(fs.readFileSync(file('existing-one'), 'utf8').includes('needs_cb_review: false'));
  r = await req('POST', `${B}/posts/existing-one/unschedule`);
  assert.equal(r.json().status, 'draft');
  r = await req('POST', `${B}/posts/existing-one/schedule`, { publish_date: '2099-05-05' });
  const p = r.json();
  assert.equal(p.status, 'scheduled');
  assert.equal(p.publish_date, '2099-05-05');
  assert.equal(p.publish_time, '09:00');
  assert.equal(p.fields.updated_date, '2099-05-05');
  r = await req('POST', `${B}/posts/existing-one/schedule`, { publish_date: '2099-05-06', publish_time: '14:30' });
  assert.equal(r.json().publish_time, '14:30');
  r = await req('POST', `${B}/posts/existing-one/schedule`, { publish_date: 'soon' });
  assert.equal(r.statusCode, 400);
  r = await req('POST', `${B}/posts/existing-one/schedule`, { publish_date: '2099-05-06', publish_time: '25:00' });
  assert.equal(r.statusCode, 400);
  // published posts can't be unscheduled or rescheduled; updated_date untouched
  r = await req('POST', `${B}/posts/live-one/unschedule`);
  assert.equal(r.statusCode, 409);
  r = await req('POST', `${B}/posts/live-one/schedule`, { publish_date: '2099-01-01' });
  assert.equal(r.statusCode, 409);
});

test('settings: blog_paused, blog_default_time, blog_site_brand round trip through /api/settings', async () => {
  const now = nowIso();
  const brand = db.prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES ('Fake Site', 'fakesite', 1, ?, ?)`).run(now, now).lastInsertRowid;
  let s = (await req('GET', '/api/settings')).json();
  assert.equal(s.blog_paused, false);
  assert.equal(s.blog_default_time, '09:00');
  assert.equal(s['blog_site_brand:fake-site'], Number(brand)); // default name match
  let sites = (await req('GET', '/api/blog/sites')).json();
  assert.equal(sites[0].brand_id, Number(brand));
  s = (await req('PATCH', '/api/settings', { blog_paused: true, blog_default_time: '07:15', 'blog_site_brand:fake-site': null })).json();
  assert.equal(s.blog_paused, true);
  assert.equal(s.blog_default_time, '07:15');
  assert.equal(s['blog_site_brand:fake-site'], null);
  sites = (await req('GET', '/api/blog/sites')).json();
  assert.equal(sites[0].brand_id, null);
  assert.equal(sites[0].paused, true);
  await req('PATCH', '/api/settings', { blog_paused: false, blog_default_time: '09:00', 'blog_site_brand:fake-site': Number(brand) });
  assert.equal((await req('GET', '/api/settings')).json()['blog_site_brand:fake-site'], Number(brand));
  // invalid time ignored
  await req('PATCH', '/api/settings', { blog_default_time: 'noon' });
  assert.equal((await req('GET', '/api/settings')).json().blog_default_time, '09:00');
});

function fakeClaude(resultObj, promptFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-fake-claude-'));
  const out = path.join(dir, 'out.json');
  fs.writeFileSync(out, JSON.stringify({ result: typeof resultObj === 'string' ? resultObj : JSON.stringify(resultObj) }));
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$2" > '${promptFile}'\ncat '${out}'\n`, { mode: 0o755 });
  return bin;
}

test('AI draft: voice + rules + examples in prompt, schema-mapped, scrubbed; 503 on provider failure', async () => {
  const promptFile = path.join(fake.root, 'prompt.txt');
  const long = Array.from({ length: 120 }, (_, i) => `word${i}`).join(' ');
  fs.writeFileSync(file('live-two'), POST({ slug: 'live-two', title: 'Live Two', status: 'published', needs_cb_review: 'false', publish_date: '2020-02-01', __body: long + '\n' }));
  process.env.POSTDECK_CLAUDE_BIN = fakeClaude(
    { title: 'Drafted — Title', description: 'Desc — here', primary_keyword: 'kw', body_md: 'Para — one.\n\n## Two\n\nx' },
    promptFile
  );
  try {
    const r = await req('POST', '/api/blog/draft', { site: 'fake-site', title: 'Idea title', primary_keyword: 'kw', notes: 'outline notes' });
    assert.equal(r.statusCode, 200, r.body);
    const j = r.json();
    assert.equal(j.fields.title, 'Drafted, Title'); // hard-rules scrub (no_em_dash)
    assert.ok(!/[–—]/.test(JSON.stringify(j)));
    assert.equal(j.fields.headline, j.fields.title); // schema has headline, fell back to title
    assert.equal(j.fields.primary_keyword, 'kw');
    assert.ok(j.body_md.includes('## Two'));
    assert.equal(j.provider, 'claude');
    const prompt = fs.readFileSync(promptFile, 'utf8');
    assert.match(prompt, /Style example 1/);
    assert.match(prompt, /outline notes/);
    assert.match(prompt, /Target length about \d+ words/);
    assert.match(prompt, /No em dashes/);
    assert.equal((await req('POST', '/api/blog/draft', { site: 'fake-site' })).statusCode, 400);
    assert.equal((await req('POST', '/api/blog/draft', { site: 'ghost', title: 'x' })).statusCode, 404);
  } finally {
    process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-postdeck-blog-test';
  }
  const bad = await req('POST', '/api/blog/draft', { site: 'fake-site', title: 'x' });
  assert.equal(bad.statusCode, 503);
  assert.equal(bad.json().error, 'ai_unavailable');
  delete process.env.POSTDECK_CLAUDE_BIN;
});
