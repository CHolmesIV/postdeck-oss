// Website analytics core: seeding, range math, overview/read/alerts, channels,
// pages tags, search, social attribution, health, blog stats, key endpoint,
// sync phase. Rows are inserted straight into web_* and providers are stubs,
// so nothing touches Google or SSH.
// Run: node --test test/web-api.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFakeRoot, setupEnv, POST } from './_blog-fixture.js';

setupEnv();
process.env.POSTDECK_WEB_SYNC = '0';
const fake = makeFakeRoot({
  posts: {
    'missed-call-cost': POST({ slug: 'missed-call-cost', title: 'Missed call cost', status: 'published', needs_cb_review: 'false', publish_date: '2020-01-01' }),
  },
});
process.env.POSTDECK_WEBSITES_ROOT = fake.root;

const { getDb, nowIso } = await import('../src/db.js');
const now0 = nowIso();
{
  const db0 = getDb();
  const ins = db0.prepare('INSERT OR IGNORE INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)');
  for (const [n, s] of [['CHolmesIV', 'cholmesiv'], ['Di-Hy', 'dihy'], ['Lunula', 'lunula'], ['IVision', 'ivision']]) ins.run(n, s, now0, now0);
}
const { buildServer } = await import('../src/server.js');
const web = await import('../src/web.js');
const { DEFAULT_TEMPLATE } = await import('../src/utm.js');
const app = buildServer();
const db = getDb();
const get = async (url) => {
  const r = await app.inject({ method: 'GET', url });
  assert.equal(r.statusCode, 200, r.body);
  return r.json();
};

const pad = (n) => String(n).padStart(2, '0');
const ld = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayOff = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return ld(d);
};
const siteId = (domain) => db.prepare('SELECT id FROM web_sites WHERE domain = ?').get(domain).id;
const DIHY = siteId('di-hy.com');
const CHOL = siteId('cholmesiv.com');
const LUN = siteId('lunulasupply.com');

function reset() {
  for (const t of ['web_daily', 'web_channels_daily', 'web_pages_daily', 'web_search_daily', 'web_notfound_daily', 'web_forms_daily', 'web_sync_runs', 'web_self_ips']) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
  db.prepare('UPDATE web_sites SET last_sync_at = NULL, last_sync_error = NULL, ga4_property_id = NULL, gsc_property = NULL').run();
  web._resetWebState();
}
function daily(site, source, from, to, users, extra = {}) {
  const st = db.prepare(
    `INSERT OR REPLACE INTO web_daily (site_id, date, source, users, sessions, pageviews, leads, search_bot_hits, ai_bot_hits)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (let i = from; i <= to; i++) st.run(site, dayOff(i), source, users, users, users * 2, extra.leads || 0, extra.sb || 0, extra.ab || 0);
}
function chan(site, source, offset, channel, src, sessions, { leads = 0, content = '', campaign = '' } = {}) {
  db.prepare(
    `INSERT OR REPLACE INTO web_channels_daily (site_id, date, source, channel, src, medium, campaign, content, sessions, engaged_sessions, leads)
     VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, 0, ?)`
  ).run(site, dayOff(offset), source, channel, src, campaign, content, sessions, leads);
}
function page(site, source, offset, path, views, leads = 0) {
  db.prepare(
    `INSERT OR REPLACE INTO web_pages_daily (site_id, date, source, path, views, users, entrances, leads) VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(site, dayOff(offset), source, path, views, views, leads);
}
function search(site, offset, path, query, clicks, impressions, position) {
  db.prepare(
    `INSERT OR REPLACE INTO web_search_daily (site_id, date, path, query, clicks, impressions, position) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(site, dayOff(offset), path, query, clicks, impressions, position);
}

test('seeding: four sites, brands resolved by slug, idempotent', () => {
  web.ensureSites(db);
  web.ensureSites(db);
  const rows = db.prepare('SELECT s.domain, s.ga4_measurement_id, s.blog_site_id, b.slug FROM web_sites s LEFT JOIN brands b ON b.id = s.brand_id ORDER BY s.id').all();
  assert.equal(rows.length, 4);
  const m = Object.fromEntries(rows.map((r) => [r.domain, r]));
  assert.equal(m['di-hy.com'].slug, 'dihy');
  assert.equal(m['di-hy.com'].blog_site_id, 'di-hy');
  assert.equal(m['cholmesiv.com'].ga4_measurement_id, 'G-97XJH8721S');
  assert.equal(m['lunulasupply.com'].slug, 'lunula');
  assert.equal(m['ivisionbuild.com'].ga4_measurement_id, null);
});

test('range math: ga4 ends yesterday, logs ends today, prev period is the same length before', () => {
  const g = web.windowFor(7, true, '2026-10-07');
  assert.deepEqual(g, { days: 7, start: '2026-09-30', end: '2026-10-06', prev_start: '2026-09-23', prev_end: '2026-09-29' });
  const l = web.windowFor(28, false, '2026-10-07');
  assert.equal(l.end, '2026-10-07');
  assert.equal(l.start, '2026-09-10');
  assert.equal(l.prev_end, '2026-09-09');
});

test('overview: shapes, totals, prev period, source choice ga4 over logs, logs when no ga4', async () => {
  reset();
  daily(DIHY, 'ga4', -7, -1, 10, { leads: 1 });
  daily(DIHY, 'ga4', -14, -8, 5);
  daily(DIHY, 'logs', -6, 0, 99); // must be ignored: ga4 wins
  daily(CHOL, 'logs', -6, 0, 3);
  const ov = await get('/api/web/overview?range=7');
  assert.equal(ov.range.days, 7);
  assert.equal(ov.range.end, dayOff(-1));
  assert.equal(ov.range.prev_end, dayOff(-8));
  const di = ov.sites.find((s) => s.domain === 'di-hy.com');
  assert.equal(di.source, 'ga4');
  assert.equal(di.visitors, 70);
  assert.equal(di.visitors_prev, 35);
  assert.equal(di.leads, 7);
  assert.equal(di.lead_rate, 0.1);
  // spark starts where stored history starts (14 days of ga4 here), not with fake zeros
  assert.equal(di.spark.length, 14);
  assert.equal(di.spark[0].date, dayOff(-14));
  const ch = ov.sites.find((s) => s.domain === 'cholmesiv.com');
  assert.equal(ch.source, 'logs');
  assert.equal(ch.visitors, 21);
  assert.equal(ov.sites.find((s) => s.domain === 'lunulasupply.com').source, 'none');
  assert.equal(ov.totals.visitors, 91);
  // cholmesiv.com logs only go back 6 days, so there is no honest "before" for the total
  assert.equal(ch.prev_complete, false);
  assert.equal(ch.visitors_prev, null);
  assert.equal(di.prev_complete, true);
  assert.equal(ov.totals.visitors_prev, null);
  assert.ok(!ov.read.some((r) => /cholmesiv\.com.*(up|down) \d/.test(r.text)));
  assert.equal(ov.trend.days.length, 7);
  assert.equal(typeof ov.google_connected, 'boolean');
  const one = await get(`/api/web/overview?range=7&brand_id=${db.prepare("SELECT id FROM brands WHERE slug='dihy'").get().id}`);
  assert.equal(one.sites.length, 1);
});

test('the read: numbers first, plain, no long dashes, no exclamation marks', async () => {
  reset();
  daily(DIHY, 'ga4', -28, -1, 10, { leads: 0 });
  daily(DIHY, 'ga4', -56, -29, 8);
  chan(DIHY, 'ga4', -2, 'search', 'google', 61);
  chan(DIHY, 'ga4', -2, 'direct', '', 39);
  page(DIHY, 'ga4', -2, '/blog/missed-call-cost/', 5, 2);
  db.prepare('UPDATE web_daily SET leads = 3 WHERE site_id = ? AND date = ?').run(DIHY, dayOff(-2));
  const ov = await get('/api/web/overview?range=28');
  const texts = ov.read.map((r) => r.text);
  assert.ok(texts.some((t) => t === 'di-hy.com: 280 visitors in the last 28 days, up 25%. Google search brought 61% of them.'), texts.join(' | '));
  assert.ok(texts.some((t) => t === '3 leads, 2 from blog posts.'), texts.join(' | '));
  for (const t of texts) assert.ok(!/[\u2014\u2013!]/.test(t), t);
});

test('warnings come first and broken tracking rule needs ga4 and a real baseline', async () => {
  reset();
  daily(DIHY, 'ga4', -28, -1, 10);
  daily(LUN, 'ga4', -16, -3, 10);
  daily(LUN, 'ga4', -2, -1, 0);
  const ov = await get('/api/web/overview?range=28');
  assert.equal(ov.read[0].level, 'warn');
  assert.equal(ov.read[0].text, 'lunulasupply.com reported 0 visitors for 2 days. Tracking may be broken.');
  const firstNonWarn = ov.read.findIndex((r) => r.level !== 'warn');
  assert.ok(ov.read.slice(firstNonWarn).every((r) => r.level !== 'warn'));
  const home = await get('/api/web/home');
  assert.ok(home.alerts.some((a) => a.level === 'warn' && /lunulasupply\.com reported 0 visitors for 2 days/.test(a.text)));
  // low baseline: no alert
  reset();
  daily(LUN, 'ga4', -16, -3, 2);
  daily(LUN, 'ga4', -2, -1, 0);
  assert.ok(!(await get('/api/web/home')).alerts.some((a) => /Tracking may be broken/.test(a.text)));
  // logs source never triggers it
  reset();
  daily(LUN, 'logs', -16, -3, 10);
  daily(LUN, 'logs', -2, 0, 0);
  assert.ok(!(await get('/api/web/home')).alerts.some((a) => /Tracking may be broken/.test(a.text)));
});

test('home: week-over-week drop over 40 percent alerts, line, sync failing over a day, new leads', async () => {
  reset();
  daily(DIHY, 'ga4', -7, -1, 5, { leads: 0 }); // 35
  daily(DIHY, 'ga4', -14, -8, 20); // 140
  daily(CHOL, 'ga4', -7, -1, 10); // 70
  daily(CHOL, 'ga4', -14, -8, 8); // 56, up
  db.prepare('UPDATE web_daily SET leads = 2 WHERE site_id = ? AND date = ?').run(CHOL, dayOff(-1));
  db.prepare('UPDATE web_sites SET last_sync_error = ?, last_sync_at = ? WHERE id = ?').run('boom', new Date(Date.now() - 30 * 3600e3).toISOString(), LUN);
  const h = await get('/api/web/home');
  const t = h.alerts.map((a) => a.text);
  assert.ok(t.some((x) => /^di-hy\.com: visitors down 75% week over week/.test(x)), t.join(' | '));
  assert.ok(!t.some((x) => /^cholmesiv\.com: visitors down/.test(x)));
  assert.ok(t.some((x) => /lunulasupply\.com: the sync has been failing/.test(x)));
  assert.ok(t.some((x) => /^2 new leads since yesterday/.test(x)));
  assert.equal(h.line, 'This week: 105 visitors across your sites, 2 leads.');
  assert.equal(h.week.visitors, 105);
  assert.equal(h.week.visitors_prev, 196);
  for (const x of t) assert.ok(!/[\u2014\u2013]/.test(x));
  reset();
  assert.equal((await get('/api/web/home')).line, null);
});

test('channels: share sums to about 1, ai assistants and social breakdown, prev sessions', async () => {
  reset();
  daily(DIHY, 'ga4', -60, -1, 1); // history reaches back past the previous period
  chan(DIHY, 'ga4', -1, 'search', 'google', 50);
  chan(DIHY, 'ga4', -1, 'social', 'linkedin', 20, { leads: 1 });
  chan(DIHY, 'ga4', -2, 'social', 'facebook', 10);
  chan(DIHY, 'ga4', -1, 'ai', 'chatgpt.com', 5);
  chan(DIHY, 'ga4', -1, 'direct', '', 15);
  chan(DIHY, 'ga4', -10, 'search', 'google', 40);
  const r = await get(`/api/web/channels?site_id=${DIHY}&range=7`);
  assert.equal(r.source, 'ga4');
  const sum = r.rows.reduce((a, x) => a + x.share, 0);
  assert.ok(Math.abs(sum - 1) < 0.01, String(sum));
  const social = r.rows.find((x) => x.channel === 'social');
  assert.equal(social.sessions, 30);
  assert.equal(social.leads, 1);
  assert.equal(social.breakdown[0].label, 'LinkedIn');
  assert.equal(r.rows.find((x) => x.channel === 'ai').label, 'AI assistants');
  assert.equal(r.rows.find((x) => x.channel === 'search').sessions_prev, 40);
  assert.equal(r.rows[0].channel, 'search');
});

test('pages: rising, falling, refresh, no_leads tags and thresholds', async () => {
  reset();
  daily(DIHY, 'ga4', -60, -1, 1); // history reaches back past the previous period
  // 28 day range: minimum volume 20
  page(DIHY, 'ga4', -2, '/rising', 60);
  page(DIHY, 'ga4', -20, '/rising', 40); // prev window is -56..-29 for 28d, so use real prev dates below
  const prevDay = (n) => -28 - n;
  db.prepare('DELETE FROM web_pages_daily').run();
  page(DIHY, 'ga4', -2, '/rising', 60);
  page(DIHY, 'ga4', prevDay(1), '/rising', 40); // +50%
  page(DIHY, 'ga4', -2, '/falling', 30);
  page(DIHY, 'ga4', prevDay(1), '/falling', 60); // -50%
  page(DIHY, 'ga4', -2, '/steady', 52);
  page(DIHY, 'ga4', prevDay(1), '/steady', 50); // +4%
  page(DIHY, 'ga4', -2, '/tiny', 10);
  page(DIHY, 'ga4', prevDay(1), '/tiny', 2); // big change, low volume
  page(DIHY, 'ga4', -2, '/busy', 150, 0); // no leads
  page(DIHY, 'ga4', -2, '/busy-lead', 150, 2);
  page(DIHY, 'ga4', -2, '/privacy', 500, 0);
  page(DIHY, 'ga4', -2, '/blog/', 500, 0);
  page(DIHY, 'ga4', -2, '/blog/missed-call-cost/', 30, 0);
  search(DIHY, -3, '/steady', 'q1', 2, 80, 12); // refresh
  search(DIHY, -3, '/rising', 'q2', 2, 80, 4); // too high on the page
  search(DIHY, -3, '/falling', 'q3', 2, 20, 12); // too few impressions
  const r = await get(`/api/web/pages?site_id=${DIHY}&range=28`);
  const by = Object.fromEntries(r.rows.map((x) => [x.path, x]));
  assert.ok(by['/rising'].tags.includes('rising'));
  assert.ok(by['/falling'].tags.includes('falling'));
  assert.deepEqual(by['/steady'].tags, ['refresh']);
  assert.deepEqual(by['/tiny'].tags, []);
  assert.ok(by['/busy'].tags.includes('no_leads'));
  assert.ok(!by['/busy-lead'].tags.includes('no_leads'));
  assert.ok(!by['/privacy'].tags.includes('no_leads'));
  assert.ok(!by['/blog/'].tags.includes('no_leads'));
  assert.ok(!by['/rising'].tags.includes('refresh'));
  assert.ok(!by['/falling'].tags.includes('refresh'));
  assert.equal(by['/steady'].position, 12);
  assert.equal(by['/steady'].search_clicks, 2);
  assert.equal(by['/rising'].views_prev, 40);
  assert.equal(by['/steady'].url, 'https://di-hy.com/steady');
  assert.equal(by['/blog/missed-call-cost/'].blog.slug, 'missed-call-cost'); // /blog/<slug> fallback when the blog site is not discoverable
  assert.equal(r.rows[0].views >= r.rows[1].views, true);
});

test('pages: no_leads never applies to logs-only numbers', async () => {
  reset();
  daily(CHOL, 'logs', -3, 0, 5);
  page(CHOL, 'logs', -1, '/busy', 500, 0);
  const r = await get(`/api/web/pages?site_id=${CHOL}&range=28`);
  assert.equal(r.source, 'logs');
  assert.ok(!r.rows[0].tags.includes('no_leads'));
});

test('search: queries and striking distance filter (position 5..20, impressions scaled, blog link)', async () => {
  reset();
  search(DIHY, -3, '/blog/a/', 'good striker', 3, 100, 9);
  search(DIHY, -3, '/blog/a/', 'too high', 40, 500, 2);
  search(DIHY, -3, '/blog/a/', 'too deep', 0, 400, 35);
  search(DIHY, -3, '/blog/a/', 'low volume', 0, 10, 8);
  search(DIHY, -3, '/blog/b/', 'edge five', 1, 60, 5);
  search(DIHY, -3, '/blog/b/', 'edge twenty', 0, 90, 20);
  const r = await get(`/api/web/search?site_id=${DIHY}&range=28`);
  assert.equal(r.connected, true);
  assert.deepEqual(r.striking.map((x) => x.query), ['good striker', 'edge twenty', 'edge five']);
  assert.equal(r.queries[0].query, 'too high');
  assert.equal(r.queries[0].ctr, 0.08);
  const g = r.striking.find((x) => x.query === 'good striker');
  assert.equal(g.site_id, DIHY);
  assert.equal(g.blog.slug, 'a');
  // 7 day range scales the impression floor down (30 * 7/28 = 7.5)
  const r7 = await get(`/api/web/search?site_id=${DIHY}&range=7`);
  assert.ok(r7.striking.some((x) => x.query === 'low volume'));
});

test('social: content pd-<id> joined to posts, platform totals, utm flags', async () => {
  reset();
  const brandId = db.prepare("SELECT id FROM brands WHERE slug='dihy'").get().id;
  const ts = nowIso();
  const pid = db
    .prepare(`INSERT INTO posts (brand_id, platform, copy, media, platform_fields, status, created_at, updated_at) VALUES (?, 'linkedin', 'Hello world post about di-hy.com', '[]', '{}', 'published', ?, ?)`)
    .run(brandId, ts, ts).lastInsertRowid;
  daily(DIHY, 'ga4', -3, -1, 1);
  chan(DIHY, 'ga4', -1, 'social', 'linkedin', 12, { leads: 1, content: `pd-${pid}` });
  chan(DIHY, 'ga4', -2, 'social', 'linkedin', 8);
  chan(DIHY, 'ga4', -2, 'social', 'facebook', 4, { content: 'pd-99999' }); // unknown post: dropped from posts, kept in platforms
  const r = await get(`/api/web/social?range=28&brand_id=${brandId}`);
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].post_id, pid);
  assert.equal(r.posts[0].sessions, 12);
  assert.equal(r.posts[0].leads, 1);
  assert.equal(r.posts[0].platform, 'linkedin');
  assert.match(r.posts[0].snippet, /Hello world/);
  const li = r.platforms.find((p) => p.platform === 'linkedin');
  assert.equal(li.sessions, 20);
  assert.equal(r.platforms.find((p) => p.platform === 'facebook').sessions, 4);
  assert.deepEqual(r.utm.map((u) => [u.brand_id, u.enabled]), [[brandId, false]]);
  const one = await get(`/api/web/post/${pid}`);
  assert.deepEqual(one, { sessions: 12, leads: 1, source: 'ga4' });
  assert.deepEqual(await get('/api/web/post/424242'), { sessions: null });
});

test('health: 404 redirect_line format, bots, forms, lead_check', async () => {
  reset();
  daily(DIHY, 'logs', -3, 0, 4, { sb: 5, ab: 2 });
  const nf = db.prepare('INSERT INTO web_notfound_daily (site_id, date, path, hits) VALUES (?, ?, ?, ?)');
  nf.run(DIHY, dayOff(-1), '/old-page', 7);
  nf.run(DIHY, dayOff(-2), '/old-page', 3);
  nf.run(DIHY, dayOff(-1), '/x; rm -rf', 1);
  const fo = db.prepare('INSERT INTO web_forms_daily (site_id, date, outcome, count) VALUES (?, ?, ?, ?)');
  fo.run(DIHY, dayOff(-1), 'delivered', 6);
  fo.run(DIHY, dayOff(-1), 'honeypot', 2);
  daily(DIHY, 'ga4', -7, -1, 3, { leads: 0 });
  const r = await get(`/api/web/health?site_id=${DIHY}&range=28`);
  assert.equal(r.not_found[0].path, '/old-page');
  assert.equal(r.not_found[0].hits, 10);
  assert.equal(r.not_found[0].redirect_line, 'location = /old-page { return 301 /; }');
  assert.match(r.not_found.find((x) => x.path.includes('rm')).redirect_line, /^# unusual path/);
  assert.equal(r.bots[0].search_bot_hits, 20);
  assert.equal(r.bots[0].ai_bot_hits, 8);
  assert.equal(r.forms[0].delivered, 6);
  assert.equal(r.forms[0].honeypot, 2);
  assert.equal(r.lead_check[0].ga4_leads, 0);
  assert.equal(r.lead_check[0].relay_delivered, 6);
  assert.match(r.lead_check[0].text, /may be broken or blocked/);
  assert.ok(!/[\u2014\u2013]/.test(r.lead_check[0].text));
});

test('health and home: real relay outcome names fold into buckets; unsendable forms alert', async () => {
  reset();
  daily(DIHY, 'logs', -3, 0, 4);
  const fo = db.prepare('INSERT INTO web_forms_daily (site_id, date, outcome, count) VALUES (?, ?, ?, ?)');
  fo.run(DIHY, dayOff(-1), 'delivered', 2);
  fo.run(DIHY, dayOff(-1), 'delivered_tagged', 3);
  fo.run(DIHY, dayOff(-1), 'js_check', 4);
  fo.run(DIHY, dayOff(-1), 'ratelimited', 1);
  fo.run(DIHY, dayOff(0), 'smtp_error', 1);
  const r = await get(`/api/web/health?site_id=${DIHY}&range=28`);
  assert.equal(r.forms[0].delivered, 2);
  assert.equal(r.forms[0].tagged, 3);
  assert.equal(r.forms[0].blocked, 5);
  assert.equal(r.forms[0].failed, 1);
  const h = await get('/api/web/home');
  assert.ok(h.alerts.some((a) => a.level === 'warn' && /could not be emailed/.test(a.text)));
});

test('short history: no before numbers, no rising/falling tags, chart starts at the first recorded day', async () => {
  reset();
  daily(DIHY, 'logs', -5, 0, 40);
  chan(DIHY, 'logs', -1, 'search', 'google', 9);
  page(DIHY, 'logs', -1, '/new/', 50);
  const ch = await get(`/api/web/channels?site_id=${DIHY}&range=28`);
  assert.equal(ch.rows[0].sessions_prev, null);
  const pg = await get(`/api/web/pages?site_id=${DIHY}&range=28`);
  assert.equal(pg.rows[0].views_prev, null);
  assert.deepEqual(pg.rows[0].tags, []);
  const ov = await get(`/api/web/overview?site_id=${DIHY}&range=28`);
  assert.equal(ov.trend.days[0].date, dayOff(-5));
  assert.equal(ov.totals.visitors_prev, null);
});

test('markers: published blog posts and social posts that link the site', async () => {
  reset();
  db.prepare("UPDATE web_sites SET blog_site_id = 'fake-site' WHERE domain = 'di-hy.com'").run();
  const fs = await import('node:fs');
  const path = await import('node:path');
  fs.writeFileSync(
    path.join(fake.content, 'recent-post.md'),
    POST({ slug: 'recent-post', title: 'Recent Post', status: 'published', needs_cb_review: 'false', publish_date: dayOff(-3) })
  );
  const brandId = db.prepare("SELECT id FROM brands WHERE slug='dihy'").get().id;
  const ts = new Date(Date.now() - 2 * 86400e3).toISOString();
  const mk = (copy, status, brand) =>
    db.prepare(`INSERT INTO posts (brand_id, platform, copy, media, platform_fields, status, publish_at, created_at, updated_at) VALUES (?, 'linkedin', ?, '[]', '{}', ?, ?, ?, ?)`).run(brand, copy, status, ts, ts, ts).lastInsertRowid;
  const hit = mk('Read more at https://di-hy.com/blog/x', 'published', brandId);
  mk('No link here', 'published', brandId);
  mk('Draft at di-hy.com', 'draft', brandId);
  mk('Other brand di-hy.com', 'published', db.prepare("SELECT id FROM brands WHERE slug='lunula'").get().id);
  daily(DIHY, 'ga4', -10, -1, 4);
  const ov = await get(`/api/web/overview?range=28&brand_id=${brandId}`);
  const blog = ov.trend.markers.filter((m) => m.kind === 'blog');
  assert.equal(blog.length, 1);
  assert.equal(blog[0].title, 'Recent Post');
  assert.equal(blog[0].date, dayOff(-3));
  assert.equal(blog[0].href, '#/blog?site=fake-site&post=recent-post');
  const social = ov.trend.markers.filter((m) => m.kind === 'social');
  assert.equal(social.length, 1);
  assert.equal(social[0].href, `#/planner?post=${hit}`);
  assert.equal(social[0].platform, 'linkedin');
  // first-3-days line when page data exists
  page(DIHY, 'ga4', -3, '/blog/recent-post/', 40);
  page(DIHY, 'ga4', -2, '/blog/recent-post/', 30);
  page(DIHY, 'ga4', -1, '/blog/recent-post/', 99);
  page(DIHY, 'ga4', -4, '/blog/recent-post/', 500); // before publish: excluded
  const ov2 = await get(`/api/web/overview?range=28&brand_id=${brandId}`);
  const line = ov2.read.find((r) => /Recent Post/.test(r.text));
  assert.ok(line, JSON.stringify(ov2.read));
  assert.match(line.text, /got 169 visitors so far|got 169 visitors in its first 3 days/);
});

test('blog-stats: slug matching by trailing segment', async () => {
  reset();
  db.prepare("UPDATE web_sites SET blog_site_id = 'fake-site' WHERE domain = 'di-hy.com'").run();
  daily(DIHY, 'ga4', -3, -1, 1);
  page(DIHY, 'ga4', -2, '/blog/missed-call-cost/', 25);
  page(DIHY, 'ga4', -3, '/blog/missed-call-cost', 5);
  page(DIHY, 'ga4', -2, '/blog/not-a-post/', 99);
  search(DIHY, -2, '/blog/missed-call-cost/', 'missed calls', 4, 100, 7.5);
  const r = await get('/api/web/blog-stats?blog_site_id=fake-site&range=28');
  assert.deepEqual(Object.keys(r.posts), ['missed-call-cost']);
  assert.equal(r.posts['missed-call-cost'].views, 30);
  assert.equal(r.posts['missed-call-cost'].search_clicks, 4);
  assert.equal(r.posts['missed-call-cost'].position, 7.5);
  assert.deepEqual((await get('/api/web/blog-stats?blog_site_id=nope')).posts, {});
});

test('daily: per-day visitors for a brand', async () => {
  reset();
  daily(DIHY, 'ga4', -2, -1, 7);
  const r = await get(`/api/web/daily?brand_id=${db.prepare("SELECT id FROM brands WHERE slug='dihy'").get().id}&start=${dayOff(-3)}&end=${dayOff(-1)}`);
  assert.deepEqual(r.days.map((d) => d.visitors), [0, 7, 7]);
});

const KEY = '-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYMATERIAL\n-----END PRIVATE KEY-----\n';
function stubGoogle(calls) {
  return {
    googleStatus: () => ({ connected: true, key_present: true, client_email: 'pd@proj.iam.gserviceaccount.com', error: null }),
    saveServiceAccountKey: async (text) => {
      calls.saved = text;
      return { client_email: 'pd@proj.iam.gserviceaccount.com', private_key: KEY };
    },
    deleteServiceAccountKey: async () => { calls.deleted = true; },
    discoverGoogle: async () => { calls.discover = (calls.discover || 0) + 1; },
    syncGa4: async (_db, site, { days }) => { (calls.ga4 ||= []).push([site.id, days]); return { ok: true, rows: 3 }; },
    syncGsc: async (_db, site, { days }) => { (calls.gsc ||= []).push([site.id, days]); return { ok: true, rows: 2 }; },
    ga4ActiveNow: async () => { calls.rt = (calls.rt || 0) + 1; return 4; },
  };
}

test('google-key: never echoes the key, status and sites expose client email only', async () => {
  reset();
  const calls = {};
  web.setWebProviders({ google: stubGoogle(calls), logs: { sshStatus: () => ({ ok: true, host: 'my-vps', error: null, self_ip: '1.2.3.4' }) } });
  const res = await app.inject({ method: 'POST', url: '/api/web/google-key', payload: { json: KEY } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, client_email: 'pd@proj.iam.gserviceaccount.com' });
  assert.ok(!res.body.includes('TOPSECRET') && !res.body.includes('PRIVATE'));
  assert.equal(calls.saved, KEY);
  assert.equal((await app.inject({ method: 'POST', url: '/api/web/google-key', payload: {} })).statusCode, 400);
  const st = await get('/api/web/status');
  assert.equal(st.google.connected, true);
  assert.equal(st.ssh.ok, true);
  assert.ok(!JSON.stringify(st).includes('PRIVATE'));
  const sites = await get('/api/web/sites');
  assert.equal(sites.sites.length, 4);
  assert.ok(sites.sites[0].checklist.length >= 3);
  assert.ok(sites.sites.find((s) => s.domain === 'di-hy.com').checklist.some((c) => c.text.includes('pd@proj.iam.gserviceaccount.com')));
  assert.equal(sites.self.optout_links[0].on_url.endsWith('/?pd_internal=on'), true);
  assert.ok(!JSON.stringify(sites).includes('PRIVATE'));
  const del = await app.inject({ method: 'DELETE', url: '/api/web/google-key' });
  assert.deepEqual(del.json(), { ok: true });
  assert.equal(calls.deleted, true);
  // an error from the provider never carries key text
  web.setWebProviders({ google: { ...stubGoogle(calls), saveServiceAccountKey: async () => { throw new Error('bad private_key field'); } } });
  const bad = await app.inject({ method: 'POST', url: '/api/web/google-key', payload: { json: 'x' } });
  assert.equal(bad.statusCode, 400);
  assert.ok(!/private_key/.test(bad.body));
});

test('PATCH site validates and returns the site', async () => {
  const bad = await app.inject({ method: 'PATCH', url: `/api/web/sites/${DIHY}`, payload: { ga4_property_id: 'G-957QEJY8VC' } });
  assert.equal(bad.statusCode, 400);
  const ok = await app.inject({ method: 'PATCH', url: `/api/web/sites/${DIHY}`, payload: { ga4_property_id: '123456789', gsc_property: 'sc-domain:di-hy.com', active: true } });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().ga4_property_id, '123456789');
  assert.equal(ok.json().gsc_property, 'sc-domain:di-hy.com');
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/web/sites/9999', payload: {} })).statusCode, 404);
  db.prepare('UPDATE web_sites SET ga4_property_id = NULL, gsc_property = NULL').run();
});

test('realtime: ga4 first, logs fallback, cached', async () => {
  reset();
  const calls = {};
  let logsCalls = 0;
  web.setWebProviders({
    google: stubGoogle(calls),
    logs: { logsActiveNow: async (_db, sites) => { logsCalls++; return Object.fromEntries(sites.map((s) => [s.id, 2])); } },
  });
  db.prepare("UPDATE web_sites SET ga4_property_id = '555' WHERE domain = 'di-hy.com'").run();
  const a = await get('/api/web/realtime');
  const di = a.sites.find((s) => s.domain === 'di-hy.com');
  assert.deepEqual([di.active_now, di.source, di.window], [4, 'ga4', '30m']);
  const ch = a.sites.find((s) => s.domain === 'cholmesiv.com');
  assert.deepEqual([ch.active_now, ch.source], [2, 'logs']);
  await get('/api/web/realtime');
  assert.equal(calls.rt, 1);
  assert.equal(logsCalls, 1);
  db.prepare('UPDATE web_sites SET ga4_property_id = NULL').run();
});

test('runWebPhase: skipped when POSTDECK_WEB_SYNC=0; otherwise follows the schedule', async () => {
  reset();
  const calls = {};
  const logCalls = [];
  web.setWebProviders({
    google: stubGoogle(calls),
    logs: { syncLogs: async (_db, sites, { days }) => { logCalls.push(days); return sites.map((s) => ({ site_id: s.id, ok: true, rows: 1 })); } },
  });
  db.prepare("UPDATE web_sites SET ga4_property_id = '555', gsc_property = 'sc-domain:di-hy.com' WHERE domain = 'di-hy.com'").run();

  assert.equal(process.env.POSTDECK_WEB_SYNC, '0');
  assert.equal(await web.runWebPhase(db, { now: Date.now() }), 0);
  assert.equal(logCalls.length, 0);
  assert.equal(calls.ga4, undefined);

  process.env.POSTDECK_WEB_SYNC = '1';
  try {
    const t0 = Date.now();
    await web.runWebPhase(db, { now: t0 });
    assert.deepEqual(logCalls, [14]); // first run
    assert.deepEqual(calls.ga4, [[DIHY, 90]]); // only the site with a property id, first run backfill
    assert.deepEqual(calls.gsc, [[DIHY, 90]]);
    const row = db.prepare('SELECT last_sync_at, last_sync_error FROM web_sites WHERE id = ?').get(DIHY);
    assert.ok(row.last_sync_at);
    assert.equal(row.last_sync_error, null);

    // 10 minutes later: nothing is due
    await web.runWebPhase(db, { now: t0 + 10 * 60e3 });
    assert.equal(logCalls.length, 1);
    assert.equal(calls.ga4.length, 1);

    // 61 minutes: logs only, and now it is not the first run
    daily(DIHY, 'logs', -1, -1, 1);
    await web.runWebPhase(db, { now: t0 + 61 * 60e3 });
    assert.deepEqual(logCalls, [14, 2]);
    assert.equal(calls.ga4.length, 1);

    // 7 hours: ga4 again (4 days), gsc not yet (12 h)
    daily(DIHY, 'ga4', -1, -1, 1);
    await web.runWebPhase(db, { now: t0 + 7 * 3600e3 });
    assert.deepEqual(calls.ga4[1], [DIHY, 4]);
    assert.equal(calls.gsc.length, 1);

    // 13 hours: gsc again (5 days, rows exist after we add one)
    search(DIHY, -1, '/', 'q', 1, 1, 1);
    await web.runWebPhase(db, { now: t0 + 13 * 3600e3 });
    assert.deepEqual(calls.gsc[1], [DIHY, 5]);

    // a failing source writes the error and keeps the old last_sync_at
    web.setWebProviders({ logs: { syncLogs: async (_db, sites) => sites.map((s) => ({ site_id: s.id, ok: false, rows: 0, error: 'ssh refused' })) } });
    const before = db.prepare('SELECT last_sync_at FROM web_sites WHERE id = ?').get(CHOL).last_sync_at;
    await web.runWebPhase(db, { now: t0 + 20 * 3600e3 });
    const after = db.prepare('SELECT last_sync_at, last_sync_error FROM web_sites WHERE id = ?').get(CHOL);
    assert.equal(after.last_sync_error, 'ssh refused');
    assert.equal(after.last_sync_at, before);
  } finally {
    process.env.POSTDECK_WEB_SYNC = '0';
  }
  db.prepare('UPDATE web_sites SET ga4_property_id = NULL, gsc_property = NULL').run();
});

test('POST /api/web/sync forces a run and reports results; unknown site is 404', async () => {
  reset();
  const calls = {};
  const logCalls = [];
  web.setWebProviders({
    google: stubGoogle(calls),
    logs: { syncLogs: async (_db, sites, { days }) => { logCalls.push([sites.map((s) => s.id), days]); return sites.map((s) => ({ site_id: s.id, ok: true, rows: 5 })); } },
  });
  const r = await app.inject({ method: 'POST', url: '/api/web/sync', payload: { site_id: CHOL, source: 'logs' } });
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json(), { ok: true, results: [{ site_id: CHOL, source: 'logs', ok: true, rows: 5, error: null }] });
  assert.deepEqual(logCalls[0][0], [CHOL]);
  assert.equal((await app.inject({ method: 'POST', url: '/api/web/sync', payload: { site_id: 9999 } })).statusCode, 404);
  web.setWebProviders({ google: { googleStatus: () => ({ connected: false, key_present: false }) } });
  const g = await app.inject({ method: 'POST', url: '/api/web/sync', payload: { source: 'ga4' } });
  assert.equal(g.json().ok, false);
  assert.match(g.json().results[0].error, /not connected/);
});

test('digest: uses the AI layer and strips long dashes', async () => {
  reset();
  daily(DIHY, 'ga4', -7, -1, 10);
  let prompt = '';
  web.setWebProviders({ ai: { runDraft: async (_p, { prompt: p }) => { prompt = p; return 'Visitors rose \u2014 nice! Next, refresh one post \u2013 soon.'; } } });
  const r = await app.inject({ method: 'POST', url: '/api/web/digest', payload: {} });
  assert.equal(r.statusCode, 200);
  assert.ok(!/[\u2014\u2013!]/.test(r.json().text), r.json().text);
  assert.match(prompt, /di-hy\.com: source ga4, visitors 70/);
  web.setWebProviders({ ai: { runDraft: async () => { throw Object.assign(new Error('AI drafting unavailable'), { statusCode: 503 }); } } });
  assert.equal((await app.inject({ method: 'POST', url: '/api/web/digest', payload: {} })).statusCode, 503);
});

test('UTM default template tags links with utm_content=pd-<id>', () => {
  assert.ok(DEFAULT_TEMPLATE.includes('utm_content=pd-{post_id}'));
});
