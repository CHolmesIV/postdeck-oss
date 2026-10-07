// GA4 and Search Console sync for Website Analytics. Every function here
// returns a result object and never throws: failures are written to
// web_sync_runs and handed back as plain sentences. Each sync fetches
// everything first and only then replaces rows in one transaction, so a
// failed run leaves the old numbers alone.

import { nowIso } from './db.js';
import {
  googleStatus,
  ga4RunReport,
  ga4Realtime,
  listGa4Properties,
  listGscSites,
  gscQuery,
} from './google.js';

const PAGE_LIMIT = 100000;
const GSC_PAGE = 25000;
const GSC_KEEP_PER_DAY = 1000;
const PAGES_KEEP_PER_DAY = 200;
const MAX_PAGES = 40;

// ---------- helpers ----------

const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// `days` back, ending yesterday (local dates).
function rangeFor(days) {
  const n = Math.max(1, Math.min(Number(days) || 1, 500));
  const end = new Date();
  end.setDate(end.getDate() - 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (n - 1));
  return { start: ymd(start), end: ymd(end) };
}

const ga4Date = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s);
const num = (v) => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};

function errText(e) {
  return String((e && e.message) || e || 'Unknown error').slice(0, 300);
}

function startRun(db, siteId, source) {
  const r = db
    .prepare('INSERT INTO web_sync_runs (site_id, source, started_at) VALUES (?, ?, ?)')
    .run(siteId, source, nowIso());
  return Number(r.lastInsertRowid);
}

function finishRun(db, id, ok, rows, error) {
  db.prepare('UPDATE web_sync_runs SET finished_at = ?, ok = ?, rows = ?, error = ? WHERE id = ?').run(
    nowIso(),
    ok ? 1 : 0,
    rows,
    error || null,
    id,
  );
}

// ---------- channel mapping ----------

const AI_SOURCES = [
  'chatgpt.com', 'chat.openai.com', 'openai.com', 'perplexity.ai', 'perplexity', 'gemini.google.com',
  'copilot.microsoft.com', 'claude.ai', 'you.com', 'poe.com', 'phind.com', 'meta.ai',
];
const SOCIAL = [
  ['linkedin', ['linkedin', 'lnkd.in']],
  ['facebook', ['facebook', 'fb', 'l.facebook.com', 'm.facebook.com']],
  ['instagram', ['instagram', 'ig', 'l.instagram.com']],
  ['x', ['x.com', 't.co', 'twitter', 'x']],
  ['threads', ['threads']],
  ['tiktok', ['tiktok']],
  ['youtube', ['youtube', 'youtu.be', 'm.youtube.com']],
  ['bluesky', ['bsky', 'bluesky']],
  ['pinterest', ['pinterest']],
  ['reddit', ['reddit']],
];

function isAiSource(source) {
  const s = String(source || '').toLowerCase();
  return AI_SOURCES.some((a) => s === a || s.endsWith(`.${a}`) || (a === 'perplexity' && s.startsWith('perplexity')));
}

function socialPlatform(source) {
  const s = String(source || '').toLowerCase().replace(/^www\./, '');
  for (const [name, keys] of SOCIAL) {
    if (keys.some((k) => s === k || s.startsWith(`${k}.`) || s.endsWith(`.${k}`) || (k.length > 3 && s.includes(k)))) {
      return name;
    }
  }
  return '';
}

// -> { channel, src }. See "Channel names" in the build contract.
export function mapChannel(group, source, medium) {
  const g = String(group || '').toLowerCase();
  const src = String(source || '').toLowerCase();
  const med = String(medium || '').toLowerCase();
  const clean = src === '(not set)' ? '' : src;
  if (g.startsWith('paid') && !g.includes('social')) return { channel: 'paid', src: clean };
  if (isAiSource(src)) return { channel: 'ai', src: clean };
  if (g.includes('social') || (med === 'social' && !g.startsWith('paid'))) {
    return { channel: 'social', src: socialPlatform(src) || clean };
  }
  if (g.startsWith('paid')) return { channel: 'paid', src: clean };
  if (g === 'organic search') return { channel: 'search', src: clean };
  if (g === 'referral') return { channel: 'referral', src: clean };
  if (g === 'direct') return { channel: 'direct', src: clean };
  if (g === 'email') return { channel: 'email', src: clean };
  return { channel: 'other', src: clean };
}

// ---------- GA4 ----------

async function ga4Rows(propertyId, body) {
  const out = [];
  let offset = 0;
  for (let i = 0; i < MAX_PAGES; i++) {
    const j = await ga4RunReport(propertyId, { ...body, limit: PAGE_LIMIT, offset });
    const rows = j.rows || [];
    for (const r of rows) {
      out.push({
        d: (r.dimensionValues || []).map((x) => x.value),
        m: (r.metricValues || []).map((x) => x.value),
      });
    }
    if (rows.length < PAGE_LIMIT || out.length >= num(j.rowCount)) break;
    offset += PAGE_LIMIT;
  }
  return out;
}

const leadFilter = {
  filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'generate_lead' } },
};
const clearNotSet = (v) => (v === '(not set)' ? '' : v || '');

export async function syncGa4(db, site, { days = 4 } = {}) {
  if (!googleStatus().connected) {
    return { ok: false, rows: 0, error: 'Google is not connected. Add a service account key in Settings > Websites.' };
  }
  if (!site || !site.ga4_property_id) {
    return { ok: false, rows: 0, error: `No GA4 property is set for ${(site && site.domain) || 'this site'}.` };
  }
  const runId = startRun(db, site.id, 'ga4');
  try {
    const pid = site.ga4_property_id;
    const { start, end } = rangeFor(days);
    const dateRanges = [{ startDate: start, endDate: end }];

    const dailyRows = await ga4Rows(pid, {
      dateRanges,
      dimensions: [{ name: 'date' }],
      metrics: ['users', 'newUsers', 'sessions', 'engagedSessions', 'screenPageViews', 'userEngagementDuration'].map((name) => ({ name })),
    });
    const dailyLeads = await ga4Rows(pid, {
      dateRanges,
      dimensions: [{ name: 'date' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: leadFilter,
    });
    const chDims = ['date', 'sessionDefaultChannelGroup', 'sessionSource', 'sessionMedium', 'sessionCampaignName', 'sessionManualAdContent'];
    const chRows = await ga4Rows(pid, {
      dateRanges,
      dimensions: chDims.map((name) => ({ name })),
      metrics: [{ name: 'sessions' }, { name: 'engagedSessions' }],
    });
    const chLeads = await ga4Rows(pid, {
      dateRanges,
      dimensions: chDims.map((name) => ({ name })),
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: leadFilter,
    });
    const pageRows = await ga4Rows(pid, {
      dateRanges,
      dimensions: [{ name: 'date' }, { name: 'pagePath' }],
      metrics: [{ name: 'screenPageViews' }, { name: 'totalUsers' }],
    });
    let entranceRows = [];
    try {
      entranceRows = await ga4Rows(pid, {
        dateRanges,
        dimensions: [{ name: 'date' }, { name: 'landingPage' }],
        metrics: [{ name: 'sessions' }],
      });
    } catch {
      entranceRows = []; // entrances are a nice-to-have; 0 when unavailable
    }
    const pageLeads = await ga4Rows(pid, {
      dateRanges,
      dimensions: [{ name: 'date' }, { name: 'pagePath' }],
      metrics: [{ name: 'eventCount' }],
      dimensionFilter: leadFilter,
    });

    // daily
    const daily = new Map();
    for (const r of dailyRows) {
      const date = ga4Date(r.d[0]);
      const users = num(r.m[0]);
      daily.set(date, {
        date,
        users,
        new_users: num(r.m[1]),
        sessions: num(r.m[2]),
        engaged: num(r.m[3]),
        views: num(r.m[4]),
        avg: users > 0 ? num(r.m[5]) / users : 0,
        leads: 0,
      });
    }
    for (const r of dailyLeads) {
      const date = ga4Date(r.d[0]);
      const row = daily.get(date);
      if (row) row.leads += num(r.m[0]);
    }

    // channels (map, then merge rows that collapse onto the same key)
    const chan = new Map();
    const chanKey = (date, g, s, m, c, ct) => {
      const { channel, src } = mapChannel(g, s, m);
      const medium = m === '(none)' ? '' : clearNotSet(m);
      const key = [date, channel, src, medium, clearNotSet(c), clearNotSet(ct)];
      return { key: key.join('\u0001'), parts: { date, channel, src, medium, campaign: key[4], content: key[5] } };
    };
    for (const r of chRows) {
      const { key, parts } = chanKey(ga4Date(r.d[0]), r.d[1], r.d[2], r.d[3], r.d[4], r.d[5]);
      const cur = chan.get(key) || { ...parts, sessions: 0, engaged: 0, leads: 0 };
      cur.sessions += num(r.m[0]);
      cur.engaged += num(r.m[1]);
      chan.set(key, cur);
    }
    for (const r of chLeads) {
      const { key, parts } = chanKey(ga4Date(r.d[0]), r.d[1], r.d[2], r.d[3], r.d[4], r.d[5]);
      const cur = chan.get(key) || { ...parts, sessions: 0, engaged: 0, leads: 0 };
      cur.leads += num(r.m[0]);
      chan.set(key, cur);
    }

    // pages
    const pages = new Map();
    const pkey = (date, p) => `${date}\u0001${p}`;
    const pageOf = (date, p) => {
      const k = pkey(date, p);
      if (!pages.has(k)) pages.set(k, { date, path: p, views: 0, users: 0, entrances: 0, leads: 0 });
      return pages.get(k);
    };
    for (const r of pageRows) {
      const e = pageOf(ga4Date(r.d[0]), r.d[1] || '/');
      e.views += num(r.m[0]);
      e.users += num(r.m[1]);
    }
    for (const r of entranceRows) {
      const k = pkey(ga4Date(r.d[0]), r.d[1] || '/');
      if (pages.has(k)) pages.get(k).entrances += num(r.m[0]);
    }
    for (const r of pageLeads) {
      pageOf(ga4Date(r.d[0]), r.d[1] || '/').leads += num(r.m[0]);
    }
    const byDay = new Map();
    for (const e of pages.values()) {
      if (!byDay.has(e.date)) byDay.set(e.date, []);
      byDay.get(e.date).push(e);
    }
    const pagesKept = [];
    for (const list of byDay.values()) {
      list.sort((a, b) => b.views - a.views || b.leads - a.leads);
      pagesKept.push(...list.slice(0, PAGES_KEEP_PER_DAY));
    }

    // write (all or nothing)
    const total = daily.size + chan.size + pagesKept.length;
    const upDaily = db.prepare(
      `INSERT INTO web_daily (site_id, date, source, users, new_users, sessions, engaged_sessions, pageviews, avg_engagement_s, leads)
       VALUES (?, ?, 'ga4', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, date, source) DO UPDATE SET users = excluded.users, new_users = excluded.new_users,
         sessions = excluded.sessions, engaged_sessions = excluded.engaged_sessions, pageviews = excluded.pageviews,
         avg_engagement_s = excluded.avg_engagement_s, leads = excluded.leads`,
    );
    const upChan = db.prepare(
      `INSERT INTO web_channels_daily (site_id, date, source, channel, src, medium, campaign, content, sessions, engaged_sessions, leads)
       VALUES (?, ?, 'ga4', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, date, source, channel, src, medium, campaign, content) DO UPDATE SET
         sessions = excluded.sessions, engaged_sessions = excluded.engaged_sessions, leads = excluded.leads`,
    );
    const upPage = db.prepare(
      `INSERT INTO web_pages_daily (site_id, date, source, path, views, users, entrances, leads)
       VALUES (?, ?, 'ga4', ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, date, source, path) DO UPDATE SET
         views = excluded.views, users = excluded.users, entrances = excluded.entrances, leads = excluded.leads`,
    );
    db.exec('BEGIN');
    try {
      db.prepare("DELETE FROM web_channels_daily WHERE site_id = ? AND source = 'ga4' AND date BETWEEN ? AND ?").run(site.id, start, end);
      db.prepare("DELETE FROM web_pages_daily WHERE site_id = ? AND source = 'ga4' AND date BETWEEN ? AND ?").run(site.id, start, end);
      for (const d of daily.values()) {
        upDaily.run(site.id, d.date, d.users, d.new_users, d.sessions, d.engaged, d.views, d.avg, d.leads);
      }
      for (const c of chan.values()) {
        upChan.run(site.id, c.date, c.channel, c.src, c.medium, c.campaign, c.content, c.sessions, c.engaged, c.leads);
      }
      for (const p of pagesKept) {
        upPage.run(site.id, p.date, p.path, p.views, p.users, p.entrances, p.leads);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    finishRun(db, runId, true, total, null);
    return { ok: true, rows: total, error: null };
  } catch (e) {
    const error = errText(e);
    try {
      finishRun(db, runId, false, 0, error);
    } catch {
      /* the run log is best effort */
    }
    return { ok: false, rows: 0, error };
  }
}

// ---------- Search Console ----------

function pathOf(page) {
  try {
    return new URL(page).pathname || '/';
  } catch {
    return String(page || '/');
  }
}

export async function syncGsc(db, site, { days = 5 } = {}) {
  if (!googleStatus().connected) {
    return { ok: false, rows: 0, error: 'Google is not connected. Add a service account key in Settings > Websites.' };
  }
  if (!site || !site.gsc_property) {
    return { ok: false, rows: 0, error: `No Search Console property is set for ${(site && site.domain) || 'this site'}.` };
  }
  const runId = startRun(db, site.id, 'gsc');
  try {
    const { start, end } = rangeFor(days);
    const merged = new Map(); // date|path|query -> { clicks, impressions, posSum }
    for (let i = 0, startRow = 0; i < MAX_PAGES; i++, startRow += GSC_PAGE) {
      const j = await gscQuery(site.gsc_property, {
        startDate: start,
        endDate: end,
        dimensions: ['date', 'page', 'query'],
        rowLimit: GSC_PAGE,
        startRow,
      });
      const rows = j.rows || [];
      for (const r of rows) {
        const [date, page, query] = r.keys || [];
        if (!date || !query) continue;
        const k = `${date}\u0001${pathOf(page)}\u0001${query}`;
        const cur = merged.get(k) || { date, path: pathOf(page), query, clicks: 0, impressions: 0, posSum: 0 };
        const imp = num(r.impressions);
        cur.clicks += num(r.clicks);
        cur.impressions += imp;
        cur.posSum += num(r.position) * (imp || 1);
        cur.w = (cur.w || 0) + (imp || 1);
        merged.set(k, cur);
      }
      if (rows.length < GSC_PAGE) break;
    }
    const byDay = new Map();
    for (const e of merged.values()) {
      if (!byDay.has(e.date)) byDay.set(e.date, []);
      byDay.get(e.date).push(e);
    }
    const kept = [];
    for (const list of byDay.values()) {
      list.sort((a, b) => b.impressions - a.impressions || b.clicks - a.clicks);
      kept.push(...list.slice(0, GSC_KEEP_PER_DAY));
    }
    const up = db.prepare(
      `INSERT INTO web_search_daily (site_id, date, path, query, clicks, impressions, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(site_id, date, path, query) DO UPDATE SET
         clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position`,
    );
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM web_search_daily WHERE site_id = ? AND date BETWEEN ? AND ?').run(site.id, start, end);
      for (const e of kept) {
        up.run(site.id, e.date, e.path, e.query, e.clicks, e.impressions, e.w ? e.posSum / e.w : 0);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    finishRun(db, runId, true, kept.length, null);
    return { ok: true, rows: kept.length, error: null };
  } catch (e) {
    const error = errText(e);
    try {
      finishRun(db, runId, false, 0, error);
    } catch {
      /* best effort */
    }
    return { ok: false, rows: 0, error };
  }
}

// ---------- realtime ----------

export async function ga4ActiveNow(db, site) {
  try {
    if (!googleStatus().connected || !site || !site.ga4_property_id) return null;
    const j = await ga4Realtime(site.ga4_property_id);
    const rows = j.rows || [];
    if (!rows.length) return 0;
    return rows.reduce((n, r) => n + num(r.metricValues && r.metricValues[0] && r.metricValues[0].value), 0);
  } catch {
    return null;
  }
}

// ---------- discovery ----------

const blank = (v) => v == null || String(v).trim() === '';

export async function discoverGoogle(db) {
  const status = googleStatus();
  if (!status.connected) {
    return { ok: false, matched: [], unmatched: [], error: 'Google is not connected. Add a service account key in Settings > Websites.' };
  }
  const sites = db.prepare('SELECT * FROM web_sites ORDER BY id').all();
  const errors = [];
  let props = null;
  let gsc = null;
  try {
    props = await listGa4Properties();
  } catch (e) {
    errors.push(errText(e));
  }
  try {
    gsc = await listGscSites();
  } catch (e) {
    errors.push(errText(e));
  }
  const gscUrls = new Set((gsc || []).map((s) => s.site_url));
  const matched = [];
  const unmatched = [];
  const upd = db.prepare('UPDATE web_sites SET ga4_property_id = ?, gsc_property = ?, updated_at = ? WHERE id = ?');
  for (const s of sites) {
    let ga4 = s.ga4_property_id;
    let gp = s.gsc_property;
    const found = {};
    if (blank(ga4) && props && !blank(s.ga4_measurement_id)) {
      const hit = props.find((p) => p.measurement_ids.includes(s.ga4_measurement_id));
      if (hit) {
        ga4 = hit.property_id;
        found.ga4_property_id = ga4;
      }
    }
    if (blank(gp) && gsc) {
      const bare = String(s.domain).replace(/^www\./, '');
      const cands = [`sc-domain:${bare}`, `https://${bare}/`, `https://www.${bare}/`];
      const hit = cands.find((c) => gscUrls.has(c));
      if (hit) {
        gp = hit;
        found.gsc_property = hit;
      }
    }
    if (Object.keys(found).length) {
      upd.run(ga4 || null, gp || null, nowIso(), s.id);
      matched.push({ site_id: s.id, domain: s.domain, ...found });
    }
    const missing = [];
    if (blank(ga4)) missing.push('ga4');
    if (blank(gp)) missing.push('gsc');
    if (missing.length) unmatched.push({ site_id: s.id, domain: s.domain, missing });
  }
  return { ok: errors.length === 0, matched, unmatched, error: errors.length ? errors.join(' ') : null };
}
