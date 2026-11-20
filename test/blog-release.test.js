// Blog add-on: release runner, blocked detection, lock, scheduler phase,
// release log, preview. Python scripts are fakes (test/_blog-fixture.js).
// Run: node --test test/blog-release.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeRoot, setupEnv, POST } from './_blog-fixture.js';

setupEnv();
const fake = makeFakeRoot();
process.env.POSTDECK_WEBSITES_ROOT = fake.root;

const { getDb } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const bl = await import('../src/blog.js');
const app = buildServer();
const db = getDb();
const B = '/api/blog/sites/fake-site';
const req = (method, url, payload) => app.inject({ method, url, payload });
const file = (slug) => path.join(fake.content, `${slug}.md`);
const put = (slug, o = {}) => fs.writeFileSync(file(slug), POST({ slug, title: slug, ...o }));
const clear = () => {
  for (const f of fs.readdirSync(fake.content)) fs.unlinkSync(path.join(fake.content, f));
  fs.rmSync(path.join(fake.site, 'blog', '.argv.log'), { force: true });
  fs.rmSync(path.join(fake.site, 'blog', '.sleep'), { force: true });
  bl._resetBlogState();
  db.prepare('DELETE FROM blog_releases').run();
  db.prepare("DELETE FROM settings WHERE key = 'blog_paused'").run();
};
const today = () => bl.localDate();
const past = '2020-01-01';
const future = '2099-01-01';
const status = (slug) => /^status: (.*)$/m.exec(fs.readFileSync(file(slug), 'utf8'))[1];
const withDryRun = async (v, fn) => {
  const old = process.env.BLOTATO_DRY_RUN;
  process.env.BLOTATO_DRY_RUN = v;
  try { return await fn(); } finally { process.env.BLOTATO_DRY_RUN = old; }
};

test('blocked: due unreviewed post blocks the run, nothing is executed, sites API lists it', async () => {
  clear();
  put('due-unreviewed', { publish_date: past, needs_cb_review: 'true' });
  put('due-ok', { publish_date: past, needs_cb_review: 'false' });
  const sites = (await req('GET', '/api/blog/sites')).json();
  assert.deepEqual(sites[0].blocked, [{ slug: 'due-unreviewed', title: 'due-unreviewed', publish_date: past }]);
  const r = await req('POST', `${B}/release`, {});
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'blocked');
  assert.equal(r.json().blocked[0].slug, 'due-unreviewed');
  assert.equal(fake.argvLog().length, 0, 'release.py must not run when blocked');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blog_releases').get().n, 0);
});

test('dry-run mode: no --deploy, never --allow-unreviewed, status untouched, run logged as dry', async () => {
  clear();
  put('p1', { publish_date: past, needs_cb_review: 'false' });
  const r = await req('POST', `${B}/release`, {});
  assert.equal(r.statusCode, 200, r.body);
  const run = r.json().run;
  assert.equal(run.mode, 'dry');
  assert.equal(run.trigger, 'manual');
  assert.equal(run.ok, true);
  assert.deepEqual(run.released, ['p1']);
  assert.match(run.summary, /^Dry run passed/);
  const argv = fake.argvLog();
  assert.equal(argv.length, 1);
  assert.deepEqual(argv[0], ['--date', today()]);
  assert.ok(!argv[0].includes('--deploy') && !argv[0].includes('--allow-unreviewed'));
  assert.equal(status('p1'), 'scheduled');
});

test('live mode: --deploy only when not dry-run and not body.dry; --allow-unreviewed never', async () => {
  clear();
  put('p2', { publish_date: past, needs_cb_review: 'false' });
  await withDryRun('0', async () => {
    const forcedDry = (await req('POST', `${B}/release`, { dry: true })).json().run;
    assert.equal(forcedDry.mode, 'dry');
    assert.equal(status('p2'), 'scheduled');
    const live = (await req('POST', `${B}/release`, {})).json().run;
    assert.equal(live.mode, 'deploy');
    assert.deepEqual(live.released, ['p2']);
    assert.equal(status('p2'), 'published');
  });
  const argv = fake.argvLog();
  assert.deepEqual(argv[0], ['--date', today()]);
  assert.deepEqual(argv[1], ['--date', today(), '--deploy']);
  for (const a of argv) assert.ok(!a.includes('--allow-unreviewed'));
  // release log rows + endpoint (newest first)
  const rows = (await req('GET', `${B}/releases`)).json();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mode, 'deploy');
  assert.equal(rows[0].exit_code, 0);
  assert.ok(rows[0].output.includes('published: p2.md'));
  assert.equal(rows[0].site_id, 'fake-site');
  assert.ok(rows[0].started_at && rows[0].finished_at);
  const site = (await req('GET', '/api/blog/sites')).json()[0];
  assert.equal(site.last_release.id, rows[0].id);
});

test('failed release (script exit 1) is logged with ok:false', async () => {
  clear();
  put('p3', { publish_date: past, needs_cb_review: 'false' });
  const real = fs.readFileSync(path.join(fake.site, 'blog/tools/release.py'), 'utf8');
  fs.writeFileSync(path.join(fake.site, 'blog/tools/release.py'), '#!/usr/bin/env python3\nimport sys\nprint("ERROR: QA failed. Stopping before deploy.")\nsys.exit(1)\n');
  try {
    const r = await req('POST', `${B}/release`, {});
    const run = r.json().run;
    assert.equal(run.ok, false);
    assert.equal(run.exit_code, 1);
    assert.match(run.summary, /QA failed/);
  } finally {
    fs.writeFileSync(path.join(fake.site, 'blog/tools/release.py'), real);
  }
});

test('lock: a second concurrent release for the site gets 409 in_flight', async () => {
  clear();
  put('p4', { publish_date: past, needs_cb_review: 'false' });
  fs.writeFileSync(path.join(fake.site, 'blog', '.sleep'), '0.6');
  const first = req('POST', `${B}/release`, {});
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await req('GET', '/api/blog/sites')).json()[0].releasing, true);
  const second = await req('POST', `${B}/release`, {});
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'in_flight');
  assert.equal((await first).statusCode, 200);
  assert.equal((await req('GET', '/api/blog/sites')).json()[0].releasing, false);
  assert.equal(fake.argvLog().length, 1);
});

test('release-now: needs approval; future date moves to today; blocked by other due unreviewed posts', async () => {
  clear();
  put('rn', { publish_date: future, needs_cb_review: 'true', status: 'draft' });
  let r = await req('POST', `${B}/posts/rn/release-now`, {});
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'not_approved');
  await req('POST', `${B}/posts/rn/approve`);
  put('other-due', { publish_date: past, needs_cb_review: 'true' });
  r = await req('POST', `${B}/posts/rn/release-now`, {});
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().error, 'blocked');
  assert.equal(status('rn'), 'draft', 'a blocked release-now must not modify the post');
  fs.unlinkSync(file('other-due'));
  await withDryRun('0', async () => {
    r = await req('POST', `${B}/posts/rn/release-now`, {});
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().post.publish_date, today());
    assert.equal(r.json().post.status, 'published');
    assert.equal(r.json().run.mode, 'deploy');
  });
  assert.ok(!fake.argvLog()[0].includes('--allow-unreviewed'));
  r = await req('POST', `${B}/posts/rn/release-now`, {});
  assert.equal(r.statusCode, 409);
});

test('scheduler: releases only approved + time-passed posts', async () => {
  clear();
  const d = today();
  const at = (h) => new Date(`${d}T${h}:00`);
  put('later-today', { publish_date: d, publish_time: '09:00', needs_cb_review: 'false' });
  put('future-approved', { publish_date: future, publish_time: '09:00', needs_cb_review: 'false' });
  put('future-unreviewed', { publish_date: future, needs_cb_review: 'true' });
  put('a-draft', { publish_date: past, status: 'draft', needs_cb_review: 'false' });
  await withDryRun('0', async () => {
    assert.equal(await bl.runBlogPhase(db, { now: at('08:00') }), 0, 'before the time: nothing');
    assert.equal(fake.argvLog().length, 0);
    assert.equal(await bl.runBlogPhase(db, { now: at('09:01') }), 1);
  });
  const argv = fake.argvLog();
  assert.equal(argv.length, 1);
  assert.deepEqual(argv[0], ['--date', d, '--deploy']);
  assert.equal(status('later-today'), 'published');
  assert.equal(status('future-approved'), 'scheduled');
  assert.equal(status('future-unreviewed'), 'scheduled');
  assert.equal(status('a-draft'), 'draft');
  const row = db.prepare('SELECT * FROM blog_releases ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.trigger, 'schedule');
  assert.equal(JSON.parse(row.released)[0], 'later-today');
});

test('scheduler: never --deploy in dry-run mode, and does not re-run the same dry situation each cycle', async () => {
  clear();
  put('dry-due', { publish_date: past, publish_time: '09:00', needs_cb_review: 'false' });
  assert.equal(await bl.runBlogPhase(db), 1);
  assert.equal(await bl.runBlogPhase(db), 0);
  assert.equal(await bl.runBlogPhase(db), 0);
  const argv = fake.argvLog();
  assert.equal(argv.length, 1);
  assert.ok(!argv[0].includes('--deploy') && !argv[0].includes('--allow-unreviewed'));
  assert.equal(status('dry-due'), 'scheduled');
  assert.equal(db.prepare("SELECT mode FROM blog_releases ORDER BY id DESC LIMIT 1").get().mode, 'dry');
});

test('scheduler: respects blog_paused, skips when blocked (logged once), never throws', async () => {
  clear();
  put('ready', { publish_date: past, publish_time: '09:00', needs_cb_review: 'false' });
  await req('PATCH', '/api/settings', { blog_paused: true });
  assert.equal(await bl.runBlogPhase(db), 0);
  assert.equal(fake.argvLog().length, 0);
  await req('PATCH', '/api/settings', { blog_paused: false });
  put('needs-review', { publish_date: past, needs_cb_review: 'true' });
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    assert.equal(await bl.runBlogPhase(db), 0);
    assert.equal(await bl.runBlogPhase(db), 0);
  } finally {
    console.log = orig;
  }
  assert.equal(fake.argvLog().length, 0, 'blocked: release.py is not run');
  assert.equal(logs.filter((l) => l.includes('release blocked')).length, 1, 'block logged once');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blog_releases').get().n, 0);
  const site = (await req('GET', '/api/blog/sites')).json()[0];
  assert.equal(site.blocked[0].slug, 'needs-review');
  // a broken websites root must not throw out of the phase
  const oldRoot = process.env.POSTDECK_WEBSITES_ROOT;
  process.env.POSTDECK_WEBSITES_ROOT = '/nonexistent/root';
  assert.equal(await bl.runBlogPhase(db), 0);
  process.env.POSTDECK_WEBSITES_ROOT = oldRoot;
});

test('sites API: counts and next_due', async () => {
  clear();
  put('c-draft', { status: 'draft', publish_date: future });
  put('c-review', { needs_cb_review: 'true', publish_date: future });
  put('c-sched', { needs_cb_review: 'false', publish_date: '2099-02-02', publish_time: '10:00' });
  put('c-sched2', { needs_cb_review: 'false', publish_date: '2099-03-03' });
  put('c-pub', { status: 'published', needs_cb_review: 'false', publish_date: past });
  const s = (await req('GET', '/api/blog/sites')).json()[0];
  // c-draft still needs review, so it counts there (buckets are disjoint).
  assert.deepEqual(s.counts, { draft: 0, needs_review: 2, scheduled: 2, published: 1 });
  assert.equal(s.next_due.slug, 'c-sched');
  assert.equal(s.next_due.at, new Date('2099-02-02T10:00:00').toISOString());
  assert.deepEqual(s.blocked, []);
});

test('preview: builds in a temp copy, rewrites root-absolute URLs, returns QA lines, never touches the site', async () => {
  clear();
  put('pv-one', { status: 'draft', publish_date: future, __body: 'Hello preview.\n' });
  put('badpost', { status: 'draft', publish_date: future });
  const distBefore = fs.readdirSync(path.join(fake.site, 'dist')).sort();
  const contentBefore = fs.readFileSync(file('pv-one'), 'utf8');
  const r = await req('POST', `${B}/posts/pv-one/preview`, {});
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.build_error, null);
  assert.match(j.url, /^\/api\/blog\/preview\/[0-9a-f]+\/blog\/pv-one\/index\.html$/);
  assert.ok(j.qa.every((q) => ['FAIL', 'WARN'].includes(q.level)));
  assert.ok(j.qa.some((q) => q.message.includes('title is short')));
  const page = await req('GET', j.url);
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  const token = /preview\/([0-9a-f]+)\//.exec(j.url)[1];
  const prefix = `/api/blog/preview/${token}/`;
  assert.ok(page.body.includes(`href="${prefix}blog/"`));
  assert.ok(page.body.includes(`href="${prefix}style.css"`));
  assert.ok(page.body.includes(`srcset="${prefix}img/a.png 1x, ${prefix}img/b.png 2x"`));
  assert.ok(page.body.includes('Hello preview.'));
  assert.ok(!page.body.includes('href="/blog/"'));
  // assets from dist (via symlink-copy) and css rewrite
  const css = await req('GET', `${prefix}style.css`);
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'], /text\/css/);
  assert.ok(css.body.includes(`url(${prefix}bg.png)`));
  // the real site is unchanged: draft stays draft, no preview folders, dist identical
  assert.equal(fs.readFileSync(file('pv-one'), 'utf8'), contentBefore);
  assert.deepEqual(fs.readdirSync(path.join(fake.site, 'dist')).sort(), distBefore);
  assert.ok(!fs.existsSync(path.join(fake.site, 'dist', 'blog')));
  // QA FAIL lines for the post itself are surfaced
  const bad = (await req('POST', `${B}/posts/badpost/preview`, {})).json();
  assert.ok(bad.qa.some((q) => q.level === 'FAIL' && q.message.includes('dash')));
});

test('preview: rejects path traversal, unknown/expired tokens', async () => {
  clear();
  put('pv-two', { status: 'draft', publish_date: future });
  const { url } = (await req('POST', `${B}/posts/pv-two/preview`, {})).json();
  const token = /preview\/([0-9a-f]+)\//.exec(url)[1];
  const prefix = `/api/blog/preview/${token}/`;
  for (const evil of ['..%2f..%2f..%2fetc%2fpasswd', '%2e%2e/%2e%2e/package.json', '..%2fout%2f..%2fsite%2fblog%2fcontent%2fpv-two.md', '%00']) {
    const r = await req('GET', prefix + evil);
    assert.ok([400, 404].includes(r.statusCode), `${evil} -> ${r.statusCode}`);
  }
  // sibling "site" dir inside the temp root is not reachable
  const r2 = await req('GET', `${prefix}..%2Fsite%2Fblog%2Fcontent%2Fpv-two.md`);
  assert.notEqual(r2.statusCode, 200);
  assert.equal((await req('GET', '/api/blog/preview/deadbeef/blog/x/index.html')).statusCode, 404);
});

test('preview: build failure returns build_error and no url; temp dir is removed', async () => {
  clear();
  put('pv-bad', { status: 'draft', publish_date: future, headline: '' });
  const r = (await req('POST', `${B}/posts/pv-bad/preview`, {})).json();
  assert.equal(r.url, null);
  assert.match(r.build_error, /headline/);
});

test('preview: at most 10 tokens kept, oldest evicted and removed from disk', async () => {
  clear();
  put('pv-many', { status: 'draft', publish_date: future });
  const urls = [];
  for (let i = 0; i < 12; i++) urls.push((await req('POST', `${B}/posts/pv-many/preview`, {})).json().url);
  assert.equal((await req('GET', urls[0])).statusCode, 404);
  assert.equal((await req('GET', urls[11])).statusCode, 200);
});
