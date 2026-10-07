// Website Analytics Google layer: service-account JWT, token cache, key file,
// discovery, GA4 and Search Console sync. fetch is stubbed, no network.
// Run: node --test test/web-google.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';
process.env.POSTDECK_WEB_SYNC = '0';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-google-'));
const KEYFILE = path.join(tmp, 'sub', 'google-service-account.json');
process.env.POSTDECK_GOOGLE_SA = KEYFILE;

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const KEY_JSON = JSON.stringify({
  type: 'service_account',
  client_email: 'pd@proj.iam.gserviceaccount.com',
  private_key: privateKey,
});

const { getDb } = await import('../src/db.js');
const g = await import('../src/google.js');
const wg = await import('../src/web-google.js');
const db = getDb();

// ---------- fetch stub ----------

let calls = [];
let handler = () => json({});
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
g.setFetch(async (url, opts = {}) => {
  const body = opts.body && !String(opts.body).startsWith('grant_type') ? JSON.parse(opts.body) : opts.body;
  calls.push({ url: String(url), method: opts.method, headers: opts.headers, body });
  if (String(url) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'tok-1', expires_in: 3600 });
  return handler(String(url), body);
});
const apiCalls = () => calls.filter((c) => !c.url.includes('oauth2.googleapis.com'));
const reset = (h) => {
  calls = [];
  handler = h || (() => json({}));
};
const b64 = (s) => Buffer.from(s, 'base64url');

function connect() {
  g.saveServiceAccountKey(KEY_JSON);
}
function mkSite(domain, extra = {}) {
  const now = new Date().toISOString();
  const r = db
    .prepare('INSERT INTO web_sites (domain, ga4_measurement_id, ga4_property_id, gsc_property, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(domain, extra.mid || null, extra.pid || null, extra.gsc || null, now, now);
  return db.prepare('SELECT * FROM web_sites WHERE id = ?').get(Number(r.lastInsertRowid));
}
const count = (t, id) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE site_id = ?`).get(id).n;
const yesterdayKey = () => {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const dashed = (s) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

// ---------- key file and status ----------

test('status without a key: not connected, no network', () => {
  reset();
  assert.deepEqual(g.googleStatus(), { connected: false, key_present: false, client_email: null, error: null });
  assert.equal(calls.length, 0);
});

test('saveServiceAccountKey: rejects bad input, writes 0600 and creates parents', () => {
  assert.throws(() => g.saveServiceAccountKey('not json'), /not valid JSON/);
  assert.throws(() => g.saveServiceAccountKey(JSON.stringify({ type: 'authorized_user' })), /service account/);
  assert.throws(() => g.saveServiceAccountKey(JSON.stringify({ type: 'service_account', private_key: privateKey })), /client_email/);
  assert.throws(() => g.saveServiceAccountKey(JSON.stringify({ type: 'service_account', client_email: 'a@b' })), /private_key/);
  assert.equal(fs.existsSync(KEYFILE), false);

  const out = g.saveServiceAccountKey(KEY_JSON);
  assert.deepEqual(out, { client_email: 'pd@proj.iam.gserviceaccount.com' });
  assert.equal(fs.statSync(KEYFILE).mode & 0o777, 0o600);
  assert.deepEqual(g.googleStatus(), { connected: true, key_present: true, client_email: 'pd@proj.iam.gserviceaccount.com', error: null });
  assert.equal(JSON.stringify(out).includes('PRIVATE KEY'), false);
  assert.equal(JSON.stringify(g.googleStatus()).includes('PRIVATE KEY'), false);
});

test('status with a broken key file reports an error, not connected', () => {
  fs.writeFileSync(KEYFILE, '{ nope');
  const s = g.googleStatus();
  assert.equal(s.connected, false);
  assert.equal(s.key_present, true);
  assert.match(s.error, /not valid JSON/);
  connect();
});

// ---------- token ----------

test('JWT is valid RS256 with the right claims, and tokens are cached per scope set', async () => {
  reset();
  const tok = await g.getAccessToken([g.SCOPE_GA4]);
  assert.equal(tok, 'tok-1');
  const c = calls[0];
  assert.equal(c.url, 'https://oauth2.googleapis.com/token');
  assert.equal(c.method, 'POST');
  const form = new URLSearchParams(c.body);
  assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, p, s] = form.get('assertion').split('.');
  assert.deepEqual(JSON.parse(b64(h)), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(b64(p));
  assert.equal(claims.iss, 'pd@proj.iam.gserviceaccount.com');
  assert.equal(claims.scope, g.SCOPE_GA4);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.equal(claims.exp - claims.iat, 3600);
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 10);
  assert.ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), publicKey, b64(s)), 'signature verifies');

  await g.getAccessToken([g.SCOPE_GA4]);
  assert.equal(calls.length, 1, 'second call served from cache');
  await g.getAccessToken([g.SCOPE_GSC]);
  assert.equal(calls.length, 2, 'a different scope set is a separate token');
  const two = [g.SCOPE_GA4, g.SCOPE_GSC];
  await g.getAccessToken(two);
  await g.getAccessToken([...two].reverse());
  assert.equal(calls.length, 3, 'scope order does not matter');
});

test('token is refreshed once it is inside the 60 s expiry margin', async () => {
  reset();
  let now = Date.now();
  const realNow = Date.now;
  Date.now = () => now;
  try {
    g.setFetch(async (url) => {
      calls.push({ url: String(url) });
      return json({ access_token: `t${calls.length}`, expires_in: 3600 });
    });
    await g.getAccessToken([g.SCOPE_GA4]);
    now += 3500 * 1000;
    await g.getAccessToken([g.SCOPE_GA4]);
    assert.equal(calls.length, 1);
    now += 50 * 1000; // 3550 s elapsed, 50 s left
    await g.getAccessToken([g.SCOPE_GA4]);
    assert.equal(calls.length, 2);
  } finally {
    Date.now = realNow;
  }
});

test('token failure becomes a plain error without the key', async () => {
  g.setFetch(async () => json({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }, 400));
  await assert.rejects(g.getAccessToken([g.SCOPE_GA4]), (e) => {
    assert.match(e.message, /refused the service account sign-in/);
    assert.equal(e.message.includes('PRIVATE KEY'), false);
    return true;
  });
  restoreStub();
});

function restoreStub() {
  g.setFetch(async (url, opts = {}) => {
    const body = opts.body && !String(opts.body).startsWith('grant_type') ? JSON.parse(opts.body) : opts.body;
    calls.push({ url: String(url), method: opts.method, headers: opts.headers, body });
    if (String(url) === 'https://oauth2.googleapis.com/token') return json({ access_token: 'tok-1', expires_in: 3600 });
    return handler(String(url), body);
  });
}
restoreStub();

// ---------- API helpers ----------

test('403 from GA4 becomes a plain Viewer sentence', async () => {
  reset(() => json({ error: { code: 403, message: 'User does not have sufficient permissions' } }, 403));
  await assert.rejects(g.ga4RunReport('123', {}), /Google refused access to GA4 property 123: add the service account as a Viewer/);
  assert.equal(apiCalls()[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/123:runReport');
  assert.equal(apiCalls()[0].headers.authorization, 'Bearer tok-1');
});

test('ga4Realtime asks for activeUsers; gscQuery encodes the site url', async () => {
  reset(() => json({ rows: [{ metricValues: [{ value: '7' }] }] }));
  await g.ga4Realtime('55');
  assert.equal(apiCalls()[0].url, 'https://analyticsdata.googleapis.com/v1beta/properties/55:runRealtimeReport');
  assert.deepEqual(apiCalls()[0].body, { metrics: [{ name: 'activeUsers' }] });
  reset(() => json({ rows: [] }));
  await g.gscQuery('sc-domain:di-hy.com', { startDate: 'a' });
  assert.equal(apiCalls()[0].url, 'https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Adi-hy.com/searchAnalytics/query');
});

// ---------- discovery ----------

function discoveryHandler(url) {
  if (url.includes('/accountSummaries')) {
    if (!url.includes('pageToken')) {
      return json({
        accountSummaries: [{ propertySummaries: [{ property: 'properties/111', displayName: 'Di-Hy' }] }],
        nextPageToken: 'p2',
      });
    }
    return json({ accountSummaries: [{ propertySummaries: [{ property: 'properties/222', displayName: 'CH' }] }] });
  }
  if (url.includes('/properties/111/dataStreams')) return json({ dataStreams: [{ webStreamData: { measurementId: 'G-DIHY' } }] });
  if (url.includes('/properties/222/dataStreams')) return json({ dataStreams: [{ webStreamData: { measurementId: 'G-CH' } }, {}] });
  if (url.endsWith('/webmasters/v3/sites')) {
    return json({
      siteEntry: [
        { siteUrl: 'sc-domain:di-hy.com', permissionLevel: 'siteFullUser' },
        { siteUrl: 'https://www.cholmesiv.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'https://lunulasupply.com/', permissionLevel: 'siteOwner' },
        { siteUrl: 'sc-domain:lunulasupply.com', permissionLevel: 'siteOwner' },
      ],
    });
  }
  return json({}, 404);
}

test('discovery matches by measurement id and sc-domain first; only fills empty fields', async () => {
  const a = mkSite('di-hy.com', { mid: 'G-DIHY' });
  const b = mkSite('cholmesiv.com', { mid: 'G-CH' });
  const c = mkSite('lunulasupply.com', { mid: 'G-NONE' });
  const d = mkSite('ivisionbuild.com');
  const e = mkSite('keep.com', { mid: 'G-DIHY', pid: '999', gsc: 'https://keep.com/' });
  reset(discoveryHandler);
  const out = await wg.discoverGoogle(db);
  assert.equal(out.ok, true, out.error);
  const row = (id) => db.prepare('SELECT * FROM web_sites WHERE id = ?').get(id);
  assert.equal(row(a.id).ga4_property_id, '111');
  assert.equal(row(a.id).gsc_property, 'sc-domain:di-hy.com');
  assert.equal(row(b.id).ga4_property_id, '222');
  assert.equal(row(b.id).gsc_property, 'https://www.cholmesiv.com/');
  assert.equal(row(c.id).ga4_property_id, null);
  assert.equal(row(c.id).gsc_property, 'sc-domain:lunulasupply.com', 'sc-domain wins over https');
  assert.equal(row(e.id).ga4_property_id, '999');
  assert.equal(row(e.id).gsc_property, 'https://keep.com/');
  assert.deepEqual(out.matched.map((m) => m.domain).sort(), ['cholmesiv.com', 'di-hy.com', 'lunulasupply.com']);
  const un = Object.fromEntries(out.unmatched.map((u) => [u.domain, u.missing]));
  assert.deepEqual(un['lunulasupply.com'], ['ga4']);
  assert.deepEqual(un['ivisionbuild.com'], ['ga4', 'gsc']);
  assert.equal(un['keep.com'], undefined);
  assert.equal(JSON.stringify(out).includes('PRIVATE KEY'), false);
  void d;
});

test('discovery without a key returns an error and makes no calls', async () => {
  const saved = fs.readFileSync(KEYFILE, 'utf8');
  g.deleteServiceAccountKey();
  reset();
  const out = await wg.discoverGoogle(db);
  assert.equal(out.ok, false);
  assert.match(out.error, /not connected/);
  assert.equal(calls.length, 0);
  fs.writeFileSync(KEYFILE, saved, { mode: 0o600 });
});

// ---------- GA4 sync ----------

function ga4Handler(opts = {}) {
  const y = yesterdayKey();
  return (url, body) => {
    const dims = (body.dimensions || []).map((x) => x.name).join(',');
    const lead = !!body.dimensionFilter;
    if (opts.fail) return json({ error: { message: 'boom' } }, 500);
    if (dims === 'date') {
      if (lead) return json({ rows: [{ dimensionValues: [{ value: y }], metricValues: [{ value: '2' }] }] });
      return json({ rows: [{ dimensionValues: [{ value: y }], metricValues: ['10', '4', '12', '9', '30', '600'].map((value) => ({ value })) }] });
    }
    if (dims.startsWith('date,sessionDefaultChannelGroup')) {
      const mk = (g, s, m, camp, content, vals) => ({
        dimensionValues: [y, g, s, m, camp, content].map((value) => ({ value })),
        metricValues: vals.map((value) => ({ value })),
      });
      if (lead) return json({ rows: [mk('Organic Social', 'LinkedIn', 'social', 'spring', 'pd-42', ['1'])] });
      return json({
        rows: [
          mk('Referral', 'chatgpt.com', 'referral', '(not set)', '(not set)', ['3', '2']),
          mk('Organic Social', 'LinkedIn', 'social', 'spring', 'pd-42', ['5', '4']),
          mk('Organic Search', 'google', 'organic', '(not set)', '(not set)', ['6', '5']),
          mk('Direct', '(direct)', '(none)', '(not set)', '(not set)', ['2', '1']),
        ],
      });
    }
    if (dims === 'date,pagePath') {
      const mk = (p, vals) => ({ dimensionValues: [y, p].map((value) => ({ value })), metricValues: vals.map((value) => ({ value })) });
      if (lead) return json({ rows: [mk('/blog/a/', ['2'])] });
      return json({ rows: [mk('/blog/a/', ['20', '15']), mk('/', ['10', '8'])] });
    }
    if (dims === 'date,landingPage') {
      return json({ rows: [{ dimensionValues: [y, '/blog/a/'].map((value) => ({ value })), metricValues: [{ value: '6' }] }] });
    }
    return json({ rows: [] });
  };
}

test('syncGa4 without key or property makes no network calls', async () => {
  const site = mkSite('noprop.com');
  reset();
  const noProp = await wg.syncGa4(db, site, { days: 3 });
  assert.deepEqual(noProp, { ok: false, rows: 0, error: 'No GA4 property is set for noprop.com.' });
  assert.equal(calls.length, 0);
  const saved = fs.readFileSync(KEYFILE, 'utf8');
  g.deleteServiceAccountKey();
  const noKey = await wg.syncGa4(db, { id: site.id, domain: 'noprop.com', ga4_property_id: '1' }, { days: 3 });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /not connected/);
  assert.equal(calls.length, 0);
  fs.writeFileSync(KEYFILE, saved, { mode: 0o600 });
  assert.equal(count('web_sync_runs', site.id), 0);
});

test('syncGa4 upserts daily, channels and pages; re-running does not duplicate', async () => {
  const site = mkSite('ga.example', { pid: '111' });
  const y = dashed(yesterdayKey());
  reset(ga4Handler());
  const r1 = await wg.syncGa4(db, site, { days: 2 });
  assert.equal(r1.ok, true, r1.error);
  assert.equal(r1.error, null);
  assert.ok(r1.rows > 0);

  const d = db.prepare("SELECT * FROM web_daily WHERE site_id = ? AND source = 'ga4'").all(site.id);
  assert.equal(d.length, 1);
  assert.equal(d[0].date, y);
  assert.deepEqual(
    [d[0].users, d[0].new_users, d[0].sessions, d[0].engaged_sessions, d[0].pageviews, d[0].avg_engagement_s, d[0].leads],
    [10, 4, 12, 9, 30, 60, 2],
  );
  // date range ends yesterday, 2 days
  const rep = apiCalls()[0].body;
  assert.equal(rep.dateRanges[0].endDate, y);
  const startD = new Date(`${rep.dateRanges[0].startDate}T00:00:00`);
  const endD = new Date(`${y}T00:00:00`);
  assert.equal(Math.round((endD - startD) / 86400000), 1);

  const pg = db.prepare("SELECT * FROM web_pages_daily WHERE site_id = ? ORDER BY views DESC").all(site.id);
  assert.deepEqual(pg.map((p) => [p.path, p.views, p.users, p.entrances, p.leads]), [
    ['/blog/a/', 20, 15, 6, 2],
    ['/', 10, 8, 0, 0],
  ]);

  const before = [count('web_daily', site.id), count('web_channels_daily', site.id), count('web_pages_daily', site.id)];
  const r2 = await wg.syncGa4(db, site, { days: 2 });
  assert.equal(r2.ok, true);
  assert.deepEqual([count('web_daily', site.id), count('web_channels_daily', site.id), count('web_pages_daily', site.id)], before);

  const runs = db.prepare('SELECT * FROM web_sync_runs WHERE site_id = ? ORDER BY id').all(site.id);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].source, 'ga4');
  assert.equal(runs[0].ok, 1);
  assert.equal(runs[0].rows, r1.rows);
  assert.ok(runs[0].started_at && runs[0].finished_at);
});

test('channel mapping: chatgpt.com is ai, LinkedIn is social with src linkedin, leads attach', async () => {
  const site = db.prepare("SELECT * FROM web_sites WHERE domain = 'ga.example'").get();
  const rows = db.prepare('SELECT * FROM web_channels_daily WHERE site_id = ?').all(site.id);
  const by = (ch) => rows.find((r) => r.channel === ch);
  assert.equal(by('ai').src, 'chatgpt.com');
  assert.equal(by('ai').sessions, 3);
  const soc = by('social');
  assert.equal(soc.src, 'linkedin');
  assert.equal(soc.campaign, 'spring');
  assert.equal(soc.content, 'pd-42');
  assert.equal(soc.leads, 1);
  assert.equal(soc.engaged_sessions, 4);
  assert.equal(by('search').src, 'google');
  assert.equal(by('search').campaign, '');
  assert.equal(by('direct').medium, '', '(none) medium is stored empty');
  assert.equal(rows.every((r) => r.source === 'ga4'), true);

  assert.deepEqual(wg.mapChannel('Paid Social', 'facebook', 'paid_social'), { channel: 'social', src: 'facebook' });
  assert.deepEqual(wg.mapChannel('Paid Search', 'google', 'cpc'), { channel: 'paid', src: 'google' });
  assert.deepEqual(wg.mapChannel('Email', 'newsletter', 'email'), { channel: 'email', src: 'newsletter' });
  assert.deepEqual(wg.mapChannel('Referral', 'perplexity.ai', 'referral'), { channel: 'ai', src: 'perplexity.ai' });
  assert.deepEqual(wg.mapChannel('Referral', 'example.org', 'referral'), { channel: 'referral', src: 'example.org' });
  assert.deepEqual(wg.mapChannel('Unassigned', '(not set)', '(not set)'), { channel: 'other', src: '' });
  assert.equal(wg.mapChannel('Organic Social', 't.co', 'social').src, 'x');
});

test('a failed GA4 sync keeps old rows and records the error', async () => {
  const site = db.prepare("SELECT * FROM web_sites WHERE domain = 'ga.example'").get();
  const before = [count('web_daily', site.id), count('web_channels_daily', site.id), count('web_pages_daily', site.id)];
  reset(ga4Handler({ fail: true }));
  const r = await wg.syncGa4(db, site, { days: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.rows, 0);
  assert.match(r.error, /boom/);
  assert.deepEqual([count('web_daily', site.id), count('web_channels_daily', site.id), count('web_pages_daily', site.id)], before);
  const run = db.prepare('SELECT * FROM web_sync_runs WHERE site_id = ? ORDER BY id DESC').get(site.id);
  assert.equal(run.ok, 0);
  assert.match(run.error, /boom/);
  assert.ok(run.finished_at);
});

test('ga4ActiveNow returns a number, 0 for no rows, null on failure or no property', async () => {
  const site = { id: 1, domain: 'x', ga4_property_id: '5' };
  reset(() => json({ rows: [{ metricValues: [{ value: '4' }] }] }));
  assert.equal(await wg.ga4ActiveNow(db, site), 4);
  reset(() => json({}));
  assert.equal(await wg.ga4ActiveNow(db, site), 0);
  reset(() => json({ error: { message: 'x' } }, 500));
  assert.equal(await wg.ga4ActiveNow(db, site), null);
  assert.equal(await wg.ga4ActiveNow(db, { id: 1, domain: 'x' }), null);
});

// ---------- Search Console sync ----------

test('syncGsc pages with startRow, keeps the top 1,000 per day by impressions, stores paths', async () => {
  const site = mkSite('gsc.example', { gsc: 'sc-domain:gsc.example' });
  const y = dashed(yesterdayKey());
  const mkRow = (i) => ({
    keys: [y, `https://gsc.example/blog/p${i % 7}/?utm=1`, `query ${i}`],
    clicks: i % 3,
    impressions: 100000 - i, // earlier rows have more impressions
    position: 4.5 + (i % 10),
  });
  const total = 25000 + 1200;
  reset((url, body) => {
    const start = body.startRow;
    const rows = [];
    for (let i = start; i < Math.min(start + 25000, total); i++) rows.push(mkRow(i));
    return json({ rows });
  });
  const r = await wg.syncGsc(db, site, { days: 3 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.rows, 1000);
  const gscCalls = apiCalls();
  assert.equal(gscCalls.length, 2, 'two pages fetched');
  assert.deepEqual(gscCalls.map((c) => c.body.startRow), [0, 25000]);
  assert.equal(gscCalls[0].body.rowLimit, 25000);
  assert.deepEqual(gscCalls[0].body.dimensions, ['date', 'page', 'query']);
  assert.equal(count('web_search_daily', site.id), 1000);
  const worst = db.prepare('SELECT MIN(impressions) m FROM web_search_daily WHERE site_id = ?').get(site.id).m;
  assert.equal(worst, 100000 - 999, 'only the 1,000 highest-impression rows survive');
  const one = db.prepare("SELECT * FROM web_search_daily WHERE site_id = ? AND query = 'query 2'").get(site.id);
  assert.equal(one.path, '/blog/p2/');
  assert.equal(one.position, 6.5);
  assert.equal(typeof one.position, 'number');
  assert.equal(one.date, y);

  const again = await wg.syncGsc(db, site, { days: 3 });
  assert.equal(again.ok, true);
  assert.equal(count('web_search_daily', site.id), 1000, 're-run does not duplicate');
});

test('a failed GSC sync keeps old rows and records the error; no property means no calls', async () => {
  const site = db.prepare("SELECT * FROM web_sites WHERE domain = 'gsc.example'").get();
  reset(() => json({ error: { message: 'nope' } }, 403));
  const r = await wg.syncGsc(db, site, { days: 3 });
  assert.equal(r.ok, false);
  assert.match(r.error, /Google refused access to Search Console site sc-domain:gsc.example/);
  assert.equal(count('web_search_daily', site.id), 1000);
  const run = db.prepare("SELECT * FROM web_sync_runs WHERE site_id = ? AND source = 'gsc' ORDER BY id DESC").get(site.id);
  assert.equal(run.ok, 0);
  assert.match(run.error, /refused access/);

  reset();
  const none = await wg.syncGsc(db, { id: site.id, domain: 'gsc.example' }, { days: 3 });
  assert.equal(none.ok, false);
  assert.equal(calls.length, 0);
});

// ---------- secrets ----------

test('the private key never appears in any returned object or thrown error', async () => {
  const needle = privateKey.split('\n')[1];
  const seen = [];
  seen.push(g.googleStatus());
  seen.push(g.saveServiceAccountKey(KEY_JSON));
  reset(ga4Handler());
  seen.push(await wg.syncGa4(db, db.prepare("SELECT * FROM web_sites WHERE domain = 'ga.example'").get(), { days: 1 }));
  reset(discoveryHandler);
  seen.push(await wg.discoverGoogle(db));
  seen.push(await g.listGa4Properties());
  seen.push(await g.listGscSites());
  g.setFetch(async () => json({ error: 'invalid_grant' }, 400));
  try {
    await g.getAccessToken(['x']);
  } catch (e) {
    seen.push(e.message);
  }
  restoreStub();
  for (const s of seen) assert.equal(JSON.stringify(s).includes(needle), false);
  const runs = db.prepare('SELECT error FROM web_sync_runs').all();
  assert.equal(JSON.stringify(runs).includes(needle), false);
  const props = await g.listGa4Properties();
  assert.deepEqual(props.map((p) => p.property_id), ['111', '222']);
  assert.deepEqual(props[1].measurement_ids, ['G-CH']);
});

test('deleteServiceAccountKey removes the file and is safe to repeat', () => {
  g.deleteServiceAccountKey();
  assert.equal(fs.existsSync(KEYFILE), false);
  g.deleteServiceAccountKey();
  assert.equal(g.googleStatus().connected, false);
});
