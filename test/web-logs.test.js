// Tests for the server-log source of Website Analytics (scripts/web/vps_log_summary.py
// and src/web-logs.js). The Python script runs locally against fixture logs;
// syncLogs runs against a stubbed runner. No network, no ssh.
// Run with: node --test test/web-logs.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';
process.env.POSTDECK_WEB_SYNC = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { syncLogs, logsActiveNow, setRunner, sshStatus } = await import('../src/web-logs.js');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, '..', 'scripts', 'web', 'vps_log_summary.py');
const FIX = path.join(HERE, 'fixtures', 'web-logs');

// Fixture dir with the older file gzipped, like real rotated logs.
const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-weblogs-'));
fs.copyFileSync(path.join(FIX, 'access.log'), path.join(logDir, 'access.log'));
fs.writeFileSync(path.join(logDir, 'access.log.2.gz'), zlib.gzipSync(fs.readFileSync(path.join(FIX, 'access.log.1'))));

function runScript(extra = []) {
  const out = execFileSync('python3', [
    SCRIPT, '--days', '3', '--tz', 'America/New_York', '--domains', 'di-hy.com,lunulasupply.com',
    '--self-ip', '9.9.9.9', '--log-dir', logDir, '--journal-file', path.join(FIX, 'journal.jsonl'),
    '--now', '2026-10-07T16:00:00Z', ...extra,
  ], { encoding: 'utf8', env: { ...process.env, SSH_CLIENT: '13.13.13.13 5555 22' } });
  return JSON.parse(out);
}

const summary = runScript();
const dihy = summary.sites['di-hy.com'].days;

test('script: visitors, pageviews and day buckets in the given tz', () => {
  assert.deepEqual(Object.keys(dihy), ['2026-10-06', '2026-10-07']);
  // 23:30 EDT on the 6th is 03:30Z on the 7th; 00:30 EDT on the 7th is 04:30Z.
  assert.equal(dihy['2026-10-06'].visitors, 5);
  assert.equal(dihy['2026-10-06'].pageviews, 6);
  assert.equal(dihy['2026-10-07'].visitors, 3);
  assert.equal(dihy['2026-10-06'].sessions, 5);
});

test('script: bots, scanners, assets, non-GET and other hosts are filtered', () => {
  const d = dihy['2026-10-06'];
  assert.equal(d.search_bot_hits, 1);
  assert.equal(d.ai_bot_hits, 2);
  // 7.7.7.7 probed wp-login.php so its later page hit is not human; style.css is an asset.
  assert.equal(d.pages['/'].views, 2);
  assert.ok(!('/style.css' in d.pages));
  assert.ok(!('/submit' in d.pages));
  assert.equal(summary.sites['lunulasupply.com'].days['2026-10-06'].visitors, 1);
  assert.deepEqual(Object.keys(summary.sites).sort(), ['di-hy.com', 'lunulasupply.com']);
});

test('script: session channel attribution', () => {
  const ch = dihy['2026-10-06'].channels;
  const find = (f) => ch.find(f);
  // UTM beats a google referrer.
  const utm = find((c) => c.content === 'pd-12');
  assert.equal(utm.channel, 'social');
  assert.equal(utm.src, 'linkedin');
  assert.equal(utm.campaign, 'launch');
  // chatgpt.com referrer is ai.
  assert.equal(find((c) => c.src === 'chatgpt.com').channel, 'ai');
  // linkedin.com referrer is social/linkedin.
  const li = find((c) => c.channel === 'social' && !c.content);
  assert.equal(li.src, 'linkedin');
  // Same-site referrer and empty referrer are direct (2 sessions).
  assert.equal(find((c) => c.channel === 'direct').sessions, 2);
  // Only the landing hit counts: visitor 3.3.3.3 had a second pageview.
  assert.equal(ch.reduce((n, c) => n + c.sessions, 0), 5);
  const d7 = dihy['2026-10-07'].channels;
  assert.equal(d7.find((c) => c.src === 'duckduckgo').channel, 'search');
  assert.equal(d7.find((c) => c.medium === 'email').channel, 'email');
  assert.equal(summary.sites['lunulasupply.com'].days['2026-10-06'].channels[0].channel, 'referral');
  // Referral spam ("link building" sites) is a bot, not a visit.
  assert.ok(!d7.some((c) => c.src === 'premiumlinkbuilding.site'));
});

test('script: pages count entrances only on landing hits', () => {
  assert.equal(dihy['2026-10-06'].pages['/about/'].views, 2);
  assert.equal(dihy['2026-10-06'].pages['/about/'].entrances, 1);
});

test('script: own traffic excluded (self-ip, ssh client, optout)', () => {
  assert.deepEqual(summary.optout_ips, ['10.10.10.10']);
  assert.equal(summary.ssh_client_ip, '13.13.13.13');
  // 9.9.9.9 (self), 13.13.13.13 (ssh), 10.10.10.10 (optout) never reach the counts.
  assert.equal(dihy['2026-10-06'].pages['/'].views, 2);
  assert.equal(dihy['2026-10-06'].pages['/blog/a/'].views, 2);
  // Without --self-ip the 9.9.9.9 visit counts.
  const noSelf = JSON.parse(execFileSync('python3', [
    SCRIPT, '--days', '3', '--tz', 'America/New_York', '--domains', 'di-hy.com', '--log-dir', logDir,
    '--now', '2026-10-07T16:00:00Z',
  ], { encoding: 'utf8', env: { ...process.env, SSH_CLIENT: '13.13.13.13 5555 22' } }));
  assert.equal(noSelf.sites['di-hy.com'].days['2026-10-06'].visitors, 6);
});

test('script: forms counted per outcome and day, www mapped, other sites ignored', () => {
  assert.deepEqual(dihy['2026-10-06'].forms, { delivered: 2, blocked: 1, honeypot: 1 });
  assert.deepEqual(dihy['2026-10-07'].forms, { delivered: 1 });
});

test('script: 404 list is human, non-asset, non-scanner', () => {
  assert.deepEqual(dihy['2026-10-06'].not_found, { '/old-page/': 1 });
});

test('script: active_now counts distinct humans in the window', () => {
  assert.equal(summary.sites['di-hy.com'].active_now, 2);
  const wide = runScript(['--active-window', '700']);
  assert.equal(wide.sites['di-hy.com'].active_now, 3);
});

// ---------- syncLogs with a stubbed runner ----------

function seedSite(db, domain) {
  const now = nowIso();
  return db.prepare('INSERT INTO web_sites (domain, active, created_at, updated_at) VALUES (?, 1, ?, ?)')
    .run(domain, now, now).lastInsertRowid;
}

function canned(over = {}) {
  return {
    generated_at: '2026-10-07T16:00:00+00:00', tz: 'America/New_York', ssh_client_ip: '13.13.13.13',
    optout_ips: ['10.10.10.10'],
    sites: {
      'di-hy.com': {
        active_now: 1,
        days: {
          '2026-10-06': {
            pageviews: 6, visitors: 5, sessions: 5, search_bot_hits: 1, ai_bot_hits: 2,
            pages: { '/': { views: 2, visitors: 2, entrances: 2 }, '/about/': { views: 4, visitors: 3, entrances: 3 } },
            channels: [
              { channel: 'direct', src: '', medium: '', campaign: '', content: '', sessions: 2 },
              { channel: 'direct', src: '', medium: '', campaign: '', content: '', sessions: 1 },
              { channel: 'social', src: 'linkedin', medium: 'social', campaign: 'x', content: 'pd-12', sessions: 2 },
            ],
            not_found: { '/old/': 3 },
            forms: { delivered: 2, blocked: 1 },
          },
        },
        ...over,
      },
    },
  };
}

test('syncLogs upserts, records self ips, logs one run per site', async () => {
  const db = getDb();
  const id = seedSite(db, 'di-hy.com');
  const calls = [];
  setRunner(async (p) => { calls.push(p); return canned(); });
  const res = await syncLogs(db, [{ id, domain: 'di-hy.com' }], { days: 2 });
  assert.equal(res.length, 1);
  assert.equal(res[0].ok, true);
  assert.ok(res[0].rows > 0);
  assert.equal(calls[0].days, 2);
  assert.deepEqual(calls[0].domains, ['di-hy.com']);

  const daily = db.prepare(`SELECT * FROM web_daily WHERE site_id = ? AND source = 'logs'`).get(id);
  assert.equal(daily.users, 5);
  assert.equal(daily.sessions, 5);
  assert.equal(daily.pageviews, 6);
  assert.equal(daily.leads, 2);
  assert.equal(daily.search_bot_hits, 1);
  assert.equal(daily.ai_bot_hits, 2);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_pages_daily WHERE site_id = ?').get(id).n, 2);
  const chans = db.prepare('SELECT * FROM web_channels_daily WHERE site_id = ? ORDER BY channel').all(id);
  assert.equal(chans.length, 2);
  assert.equal(chans.find((c) => c.channel === 'direct').sessions, 3);
  assert.equal(db.prepare('SELECT hits FROM web_notfound_daily WHERE site_id = ?').get(id).hits, 3);
  assert.equal(db.prepare(`SELECT count FROM web_forms_daily WHERE site_id = ? AND outcome = 'blocked'`).get(id).count, 1);
  const ips = Object.fromEntries(db.prepare('SELECT ip, how FROM web_self_ips').all().map((r) => [r.ip, r.how]));
  assert.equal(ips['13.13.13.13'], 'ssh');
  assert.equal(ips['10.10.10.10'], 'optout');
  const runs = db.prepare(`SELECT * FROM web_sync_runs WHERE site_id = ?`).all(id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, 'logs');
  assert.equal(runs[0].ok, 1);

  // Known self IPs are passed to the next run.
  await syncLogs(db, [{ id, domain: 'di-hy.com' }], { days: 2 });
  assert.deepEqual(calls[1].selfIps.sort(), ['10.10.10.10', '13.13.13.13']);
});

test('syncLogs is idempotent and clears stale rows for re-pulled days', async () => {
  const db = getDb();
  const id = db.prepare(`SELECT id FROM web_sites WHERE domain = 'di-hy.com'`).get().id;
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE site_id = ?`).get(id).n;
  setRunner(async () => canned());
  await syncLogs(db, [{ id, domain: 'di-hy.com' }], { days: 2 });
  const before = [count('web_daily'), count('web_pages_daily'), count('web_channels_daily'), count('web_notfound_daily'), count('web_forms_daily')];
  await syncLogs(db, [{ id, domain: 'di-hy.com' }], { days: 2 });
  const after = [count('web_daily'), count('web_pages_daily'), count('web_channels_daily'), count('web_notfound_daily'), count('web_forms_daily')];
  assert.deepEqual(after, before);

  // Shrunken day: one page, no 404s, no social channel, no blocked forms.
  const shrunk = canned();
  shrunk.sites['di-hy.com'].days['2026-10-06'] = {
    pageviews: 1, visitors: 1, sessions: 1, search_bot_hits: 0, ai_bot_hits: 0,
    pages: { '/': { views: 1, visitors: 1, entrances: 1 } },
    channels: [{ channel: 'direct', src: '', medium: '', campaign: '', content: '', sessions: 1 }],
    not_found: {}, forms: { delivered: 1 },
  };
  setRunner(async () => shrunk);
  await syncLogs(db, [{ id, domain: 'di-hy.com' }], { days: 2 });
  assert.equal(count('web_pages_daily'), 1);
  assert.equal(count('web_channels_daily'), 1);
  assert.equal(count('web_notfound_daily'), 0);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM web_forms_daily WHERE site_id = ? AND outcome = 'blocked'`).get(id).n, 0);
  assert.equal(db.prepare(`SELECT users FROM web_daily WHERE site_id = ? AND source = 'logs'`).get(id).users, 1);
});

test('syncLogs records a failure without throwing and keeps old rows', async () => {
  const db = getDb();
  const id = db.prepare(`SELECT id FROM web_sites WHERE domain = 'di-hy.com'`).get().id;
  const rowsBefore = db.prepare('SELECT COUNT(*) n FROM web_daily WHERE site_id = ?').get(id).n;
  setRunner(async () => { throw new Error('ssh: connect to host my-vps port 22: Operation timed out'); });
  const res = await syncLogs(db, [{ id, domain: 'di-hy.com' }], { days: 2 });
  assert.equal(res[0].ok, false);
  assert.match(res[0].error, /timed out/);
  const last = db.prepare(`SELECT * FROM web_sync_runs WHERE site_id = ? ORDER BY id DESC LIMIT 1`).get(id);
  assert.equal(last.ok, 0);
  assert.match(last.error, /timed out/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM web_daily WHERE site_id = ?').get(id).n, rowsBefore);

  setRunner(async () => 'not json');
  const bad = await syncLogs(db, [{ id, domain: 'di-hy.com' }], { days: 2 });
  assert.equal(bad[0].ok, false);
});

test('logsActiveNow maps by site id and caches', async () => {
  const db = getDb();
  const id = db.prepare(`SELECT id FROM web_sites WHERE domain = 'di-hy.com'`).get().id;
  let n = 0;
  setRunner(async (p) => { n++; assert.equal(p.days, 1); return canned({ active_now: 4 }); });
  const a = await logsActiveNow(db, [{ id, domain: 'di-hy.com' }]);
  const b = await logsActiveNow(db, [{ id, domain: 'di-hy.com' }]);
  assert.deepEqual(a, { [id]: 4 });
  assert.deepEqual(b, a);
  assert.equal(n, 1);
});

test('sshStatus never throws', async () => {
  setRunner(null);
  process.env.POSTDECK_VPS_HOST = '127.0.0.1:invalid-host-for-test';
  const s = await sshStatus();
  assert.equal(typeof s.ok, 'boolean');
  assert.ok('error' in s && 'self_ip' in s && 'host' in s);
  delete process.env.POSTDECK_VPS_HOST;
});

test('ssh arguments: only strict domains, IPs and time zones reach the remote shell', async () => {
  const { buildSshArgs } = await import('../src/web-logs.js');
  const args = buildSshArgs({
    days: 999,
    tz: 'America/New_York; rm -rf /',
    domains: ['di-hy.com', 'evil.com;touch /tmp/x', '$(id)'],
    selfIps: ['1.2.3.4', '2001:db8::1', '1.2.3.4 && reboot'],
    activeWindow: 30,
  });
  const joined = args.join(' ');
  assert.ok(!/[;$&|`]/.test(joined), joined);
  assert.equal(args[args.indexOf('--domains') + 1], 'di-hy.com');
  assert.equal(args[args.indexOf('--tz') + 1], 'UTC');
  assert.equal(args[args.indexOf('--days') + 1], '31');
  assert.deepEqual(args.filter((_, i) => args[i - 1] === '--self-ip'), ['1.2.3.4', '2001:db8::1']);
  assert.throws(() => buildSshArgs({ days: 2, tz: 'UTC', domains: ['a b'] }), /No valid site domains/);
});
