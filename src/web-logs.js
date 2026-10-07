// Website analytics: server-log source (docs/WEB_ANALYTICS_SPEC.md, build
// contract). Runs scripts/web/vps_log_summary.py on the VPS over read-only SSH
// (script piped on stdin, nothing written on the box) and upserts the daily
// aggregates into the web_* tables with source 'logs'.
//
// Exports: sshStatus, syncLogs, logsActiveNow, setRunner.
// Nothing here throws to the caller.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { nowIso } from './db.js';

const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'web', 'vps_log_summary.py');
const SSH_TTL_MS = 5 * 60 * 1000;
const ACTIVE_TTL_MS = 120 * 1000;
const SYNC_TIMEOUT_MS = 90 * 1000;
const MAX_BUFFER = 20 * 1024 * 1024;

function vpsHost() {
  return process.env.POSTDECK_VPS_HOST || 'my-vps';
}

function localTz() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function errMsg(e) {
  const s = String((e && (e.stderr || e.message)) || e || 'unknown error').trim();
  return s.split('\n').slice(-3).join(' ').slice(0, 400);
}

// ---------- ssh plumbing ----------

function runSsh(args, { input, timeout, maxBuffer = MAX_BUFFER } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile('ssh', args, { timeout, maxBuffer, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else resolve(stdout);
    });
    if (input != null) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}

// Default runner: ssh <host> python3 - <flags> with the script on stdin.
// ssh hands its arguments to the remote shell as one string, so every value is checked
// against a strict pattern first. Anything else is dropped, never quoted and sent.
const SAFE_DOMAIN = /^[a-z0-9][a-z0-9.-]{0,252}$/i;
const SAFE_IP = /^[0-9a-f:.]{2,45}$/i;
const SAFE_TZ = /^[A-Za-z0-9_+\/-]{1,64}$/;

export function buildSshArgs({ days, tz, domains, selfIps = [], activeWindow = 30 }) {
  const safeDomains = domains.filter((d) => SAFE_DOMAIN.test(d));
  if (!safeDomains.length) throw new Error('No valid site domains to read.');
  const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', vpsHost(), 'python3', '-',
    '--days', String(Math.max(1, Math.min(31, Number(days) || 1))), '--tz', SAFE_TZ.test(tz) ? tz : 'UTC',
    '--domains', safeDomains.join(','), '--active-window', String(Math.max(1, Math.min(240, Number(activeWindow) || 30)))];
  for (const ip of selfIps) if (SAFE_IP.test(ip)) args.push('--self-ip', ip);
  return args;
}

async function sshRunner(opts) {
  const script = fs.readFileSync(SCRIPT_PATH, 'utf8');
  const args = buildSshArgs(opts);
  const out = await runSsh(args, { input: script, timeout: SYNC_TIMEOUT_MS });
  return JSON.parse(out);
}

let runner = sshRunner;
// Tests replace the ssh call. fn({ days, tz, domains, selfIps, activeWindow }) -> object | JSON string.
export function setRunner(fn) {
  runner = fn || sshRunner;
  sshCache = null;
  activeCache = null;
}

async function callRunner(params) {
  const res = await runner(params);
  return typeof res === 'string' ? JSON.parse(res) : res;
}

// ---------- ssh status ----------

let sshCache = null;

export async function sshStatus() {
  const now = Date.now();
  if (sshCache && now - sshCache.at < SSH_TTL_MS) return sshCache.value;
  const host = vpsHost();
  let value;
  try {
    const out = await runSsh(['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host, 'echo "$SSH_CLIENT"'], { timeout: 15000, maxBuffer: 65536 });
    const ip = String(out || '').trim().split(/\s+/)[0] || null;
    value = { ok: true, host, error: null, self_ip: ip };
  } catch (e) {
    value = { ok: false, host, error: errMsg(e), self_ip: null };
  }
  sshCache = { at: now, value };
  return value;
}

// ---------- sync ----------

function recentSelfIps(db) {
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString();
  return db.prepare('SELECT ip FROM web_self_ips WHERE last_seen >= ?').all(cutoff).map((r) => r.ip);
}

function recordSelfIp(db, ip, how) {
  if (!ip) return;
  const now = nowIso();
  db.prepare(
    `INSERT INTO web_self_ips (ip, how, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET last_seen = excluded.last_seen`
  ).run(ip, how, now, now);
}

function num(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0;
}

function writeSite(db, siteId, siteData) {
  const days = (siteData && siteData.days) || {};
  let rows = 0;
  const delPages = db.prepare(`DELETE FROM web_pages_daily WHERE site_id = ? AND date = ? AND source = 'logs'`);
  const delChan = db.prepare(`DELETE FROM web_channels_daily WHERE site_id = ? AND date = ? AND source = 'logs'`);
  const delNf = db.prepare(`DELETE FROM web_notfound_daily WHERE site_id = ? AND date = ?`);
  const delForms = db.prepare(`DELETE FROM web_forms_daily WHERE site_id = ? AND date = ?`);
  const upDaily = db.prepare(
    `INSERT INTO web_daily (site_id, date, source, users, sessions, pageviews, leads, search_bot_hits, ai_bot_hits)
     VALUES (?, ?, 'logs', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, date, source) DO UPDATE SET users = excluded.users, sessions = excluded.sessions,
       pageviews = excluded.pageviews, leads = excluded.leads,
       search_bot_hits = excluded.search_bot_hits, ai_bot_hits = excluded.ai_bot_hits`
  );
  const upPage = db.prepare(
    `INSERT INTO web_pages_daily (site_id, date, source, path, views, users, entrances)
     VALUES (?, ?, 'logs', ?, ?, ?, ?)
     ON CONFLICT(site_id, date, source, path) DO UPDATE SET views = excluded.views, users = excluded.users, entrances = excluded.entrances`
  );
  const upChan = db.prepare(
    `INSERT INTO web_channels_daily (site_id, date, source, channel, src, medium, campaign, content, sessions)
     VALUES (?, ?, 'logs', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(site_id, date, source, channel, src, medium, campaign, content) DO UPDATE SET sessions = excluded.sessions`
  );
  const upNf = db.prepare(
    `INSERT INTO web_notfound_daily (site_id, date, path, hits) VALUES (?, ?, ?, ?)
     ON CONFLICT(site_id, date, path) DO UPDATE SET hits = excluded.hits`
  );
  const upForm = db.prepare(
    `INSERT INTO web_forms_daily (site_id, date, outcome, count) VALUES (?, ?, ?, ?)
     ON CONFLICT(site_id, date, outcome) DO UPDATE SET count = excluded.count`
  );

  const tx = db.transaction(() => {
    for (const [date, d] of Object.entries(days)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      delPages.run(siteId, date);
      delChan.run(siteId, date);
      delNf.run(siteId, date);
      delForms.run(siteId, date);
      const forms = d.forms || {};
      upDaily.run(siteId, date, num(d.visitors), num(d.sessions), num(d.pageviews), num(forms.delivered), num(d.search_bot_hits), num(d.ai_bot_hits));
      rows++;
      for (const [p, v] of Object.entries(d.pages || {})) {
        upPage.run(siteId, date, p, num(v.views), num(v.visitors), num(v.entrances));
        rows++;
      }
      // Aggregate duplicate keys before writing.
      const agg = new Map();
      for (const c of d.channels || []) {
        const key = [c.channel || 'other', c.src || '', c.medium || '', c.campaign || '', c.content || ''];
        const k = key.join('\u0001');
        const cur = agg.get(k) || { key, sessions: 0 };
        cur.sessions += num(c.sessions);
        agg.set(k, cur);
      }
      for (const { key, sessions } of agg.values()) {
        upChan.run(siteId, date, key[0], key[1], key[2], key[3], key[4], sessions);
        rows++;
      }
      for (const [p, hits] of Object.entries(d.not_found || {})) {
        upNf.run(siteId, date, p, num(hits));
        rows++;
      }
      for (const [outcome, count] of Object.entries(forms)) {
        upForm.run(siteId, date, outcome, num(count));
        rows++;
      }
    }
  });
  tx();
  return rows;
}

function logRun(db, siteId, startedAt, ok, rows, error) {
  try {
    db.prepare(
      `INSERT INTO web_sync_runs (site_id, source, started_at, finished_at, ok, rows, error) VALUES (?, 'logs', ?, ?, ?, ?, ?)`
    ).run(siteId, startedAt, nowIso(), ok ? 1 : 0, rows, error || null);
  } catch {
    /* never throw */
  }
}

export async function syncLogs(db, sites, { days = 2 } = {}) {
  const list = (sites || []).filter((s) => s && s.domain);
  if (!list.length) return [];
  const startedAt = nowIso();
  let data;
  try {
    data = await callRunner({
      days,
      tz: localTz(),
      domains: list.map((s) => s.domain),
      selfIps: recentSelfIps(db),
      activeWindow: 30,
    });
    if (!data || typeof data !== 'object' || !data.sites) throw new Error('log summary returned no sites');
  } catch (e) {
    const error = errMsg(e);
    return list.map((s) => {
      logRun(db, s.id, startedAt, false, 0, error);
      return { site_id: s.id, ok: false, rows: 0, error };
    });
  }

  try {
    recordSelfIp(db, data.ssh_client_ip, 'ssh');
    for (const ip of data.optout_ips || []) recordSelfIp(db, ip, 'optout');
  } catch {
    /* non-fatal */
  }

  return list.map((s) => {
    try {
      const rows = writeSite(db, s.id, data.sites[s.domain] || data.sites[String(s.domain).replace(/^www\./, '')]);
      logRun(db, s.id, startedAt, true, rows, null);
      return { site_id: s.id, ok: true, rows, error: null };
    } catch (e) {
      const error = errMsg(e);
      logRun(db, s.id, startedAt, false, 0, error);
      return { site_id: s.id, ok: false, rows: 0, error };
    }
  });
}

// ---------- active now ----------

let activeCache = null;

export async function logsActiveNow(db, sites) {
  const list = (sites || []).filter((s) => s && s.domain);
  if (!list.length) return {};
  const cacheKey = list.map((s) => `${s.id}:${s.domain}`).join('|');
  const now = Date.now();
  if (activeCache && activeCache.key === cacheKey && now - activeCache.at < ACTIVE_TTL_MS) return activeCache.value;
  try {
    const data = await callRunner({
      days: 1,
      tz: localTz(),
      domains: list.map((s) => s.domain),
      selfIps: recentSelfIps(db),
      activeWindow: 30,
    });
    const value = {};
    for (const s of list) value[s.id] = num(data && data.sites && data.sites[s.domain] && data.sites[s.domain].active_now);
    activeCache = { key: cacheKey, at: now, value };
    return value;
  } catch {
    return activeCache && activeCache.key === cacheKey ? activeCache.value : {};
  }
}
