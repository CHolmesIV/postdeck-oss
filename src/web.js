// Website analytics core (docs/WEB_ANALYTICS_SPEC.md, "Build contract").
// Read endpoints over the web_* daily aggregates, the plain-language "read",
// alerts, trend markers, the worker phase and the Google / server-log sync
// orchestration. Google and log access live in other modules that are loaded
// through a small injectable registry so tests (and a missing file) never
// crash the server.

import { getRawSetting, normalizeDashes } from './voice.js';
import { runDraft as aiRunDraft } from './ai.js';
import { getBrandUtmSettings } from './utm.js';
import fs from 'node:fs';
import path from 'node:path';
import { discoverSites as discoverBlogSites, splitFile, entriesOf } from './blog.js';
import { nowIso } from './db.js';

// ---------- provider registry ----------

const providers = { google: null, logs: null, ai: { runDraft: aiRunDraft } };
let defaultsLoaded = false;

/** Replace providers (tests). Any key left out keeps its current value. */
function setWebProviders(p = {}) {
  if (p.google !== undefined) providers.google = p.google;
  if (p.logs !== undefined) providers.logs = p.logs;
  if (p.ai !== undefined) providers.ai = p.ai;
  defaultsLoaded = true; // an explicit set wins over lazy defaults
}

async function loadDefaults() {
  if (defaultsLoaded) return;
  defaultsLoaded = true;
  if (!providers.google) {
    let merged = {};
    for (const f of ['./google.js', './web-google.js']) {
      try {
        merged = { ...merged, ...(await import(f)) };
      } catch {
        // module not present yet: that capability reports "not available"
      }
    }
    if (Object.keys(merged).length) providers.google = merged;
  }
  if (!providers.logs) {
    try {
      providers.logs = await import('./web-logs.js');
    } catch {
      // not present
    }
  }
}

async function getProviders() {
  await loadDefaults();
  return providers;
}

async function safe(fn, fallback) {
  try {
    const v = await fn();
    return v === undefined ? fallback : v;
  } catch {
    return fallback;
  }
}

// ---------- dates ----------

const pad2 = (n) => String(n).padStart(2, '0');
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateList(start, end) {
  const out = [];
  for (let d = start, i = 0; d <= end && i < 800; d = addDays(d, 1), i++) out.push(d);
  return out;
}
function parseRange(v) {
  const n = Number(v);
  return [7, 28, 90, 365].includes(n) ? n : 28;
}
function windowFor(days, endsYesterday, today = localDate()) {
  const end = endsYesterday ? addDays(today, -1) : today;
  const start = addDays(end, -(days - 1));
  return { days, start, end, prev_start: addDays(start, -days), prev_end: addDays(start, -1) };
}

// ---------- sites ----------

const SEED_SITES = [
  { domain: 'cholmesiv.com', brand: 'cholmesiv', blog: 'cholmesiv', ga4: 'G-97XJH8721S' },
  { domain: 'di-hy.com', brand: 'dihy', blog: 'di-hy', ga4: 'G-957QEJY8VC' },
  { domain: 'lunulasupply.com', brand: 'lunula', blog: 'lunula-supply', ga4: 'G-5GVQC5FMF0' },
  { domain: 'ivisionbuild.com', brand: 'ivision', blog: null, ga4: null },
];

function ensureSites(db) {
  const has = db.prepare('SELECT 1 FROM web_sites WHERE domain = ?');
  const brand = db.prepare('SELECT id FROM brands WHERE slug = ?');
  const ins = db.prepare(
    `INSERT INTO web_sites (domain, brand_id, ga4_measurement_id, blog_site_id, active, created_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`
  );
  const now = nowIso();
  for (const s of SEED_SITES) {
    if (has.get(s.domain)) continue;
    const b = brand.get(s.brand);
    ins.run(s.domain, b ? b.id : null, s.ga4, s.blog, now, now);
  }
}

const SITE_SELECT = `SELECT s.*, b.name AS brand_name, b.slug AS brand_slug
  FROM web_sites s LEFT JOIN brands b ON b.id = s.brand_id`;

function selectSites(db, { site_id, brand_id, includeInactive = false } = {}) {
  const where = [];
  const args = [];
  if (!includeInactive) where.push('s.active = 1');
  if (site_id !== undefined && site_id !== null && site_id !== '') {
    where.push('s.id = ?');
    args.push(Number(site_id));
  }
  if (brand_id !== undefined && brand_id !== null && brand_id !== '') {
    where.push('s.brand_id = ?');
    args.push(Number(brand_id));
  }
  return db.prepare(`${SITE_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id`).all(...args);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const fmt = (n) => Math.round(num(n)).toLocaleString('en-US');
const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;

/** Which numbers a site uses for a range: ga4 (ends yesterday), logs (ends today) or none. */
function siteWindow(db, siteId, days, today = localDate()) {
  const g = windowFor(days, true, today);
  const gCount = db
    .prepare(`SELECT COUNT(*) n FROM web_daily WHERE site_id = ? AND source = 'ga4' AND date BETWEEN ? AND ?`)
    .get(siteId, g.start, g.end).n;
  if (gCount > 0) return { source: 'ga4', ...g };
  const l = windowFor(days, false, today);
  const lCount = db
    .prepare(`SELECT COUNT(*) n FROM web_daily WHERE site_id = ? AND source = 'logs' AND date BETWEEN ? AND ?`)
    .get(siteId, l.start, l.end).n;
  return { source: lCount > 0 ? 'logs' : 'none', ...l };
}

// ---------- aggregates ----------

function dailySums(db, siteId, source, start, end) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(users),0) users, COALESCE(SUM(sessions),0) sessions, COALESCE(SUM(pageviews),0) pageviews,
              COALESCE(SUM(leads),0) leads, COALESCE(SUM(search_bot_hits),0) search_bot_hits, COALESCE(SUM(ai_bot_hits),0) ai_bot_hits
       FROM web_daily WHERE site_id = ? AND source = ? AND date BETWEEN ? AND ?`
    )
    .get(siteId, source, start, end);
  return r;
}

function searchSums(db, siteId, start, end) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions,
              COALESCE(SUM(position * impressions),0) wpos
       FROM web_search_daily WHERE site_id = ? AND date BETWEEN ? AND ?`
    )
    .get(siteId, start, end);
  return { clicks: r.clicks, impressions: r.impressions, position: r.impressions > 0 ? r.wpos / r.impressions : null };
}

function dailySeries(db, siteId, source, start, end) {
  const rows = db
    .prepare(`SELECT date, users, leads FROM web_daily WHERE site_id = ? AND source = ? AND date BETWEEN ? AND ?`)
    .all(siteId, source, start, end);
  const m = new Map(rows.map((r) => [r.date, r]));
  return dateList(start, end).map((date) => ({ date, visitors: num(m.get(date)?.users), leads: num(m.get(date)?.leads) }));
}

const round1 = (n) => (n === null || n === undefined ? null : Math.round(n * 10) / 10);
const pctChange = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);

// ---------- blog helpers ----------

/** Read-only post list for a discovered blog site: { slug, title, status, publish_date }. */
function listBlogPosts(_db, bs) {
  let names = [];
  try {
    names = fs.readdirSync(bs.contentDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    try {
      const raw = fs.readFileSync(path.join(bs.contentDir, n), 'utf8');
      const f = {};
      for (const e of entriesOf(splitFile(raw))) f[e.key] = e.value;
      out.push({
        slug: n.slice(0, -3),
        title: String(f.title || n.slice(0, -3)),
        status: String(f.status || '').toLowerCase(),
        publish_date: String(f.publish_date || ''),
      });
    } catch {
      // malformed front matter: skipped
    }
  }
  return out.sort((a, b) => (a.publish_date < b.publish_date ? 1 : a.publish_date > b.publish_date ? -1 : 0));
}

function blogContext(db, site) {
  const out = { blogSite: null, posts: [], slugs: new Map() };
  if (!site.blog_site_id) return out;
  try {
    const bs = discoverBlogSites(db).find((s) => s.id === site.blog_site_id);
    if (!bs) return out;
    out.blogSite = bs;
    out.posts = listBlogPosts(db, bs);
    for (const p of out.posts) out.slugs.set(p.slug, p.title);
  } catch {
    // blog add-on unavailable: no markers, no blog tags
  }
  return out;
}

function matchBlog(ctx, site, path) {
  const segs = String(path || '').split('?')[0].split('/').filter(Boolean);
  if (!segs.length) return null;
  const last = segs[segs.length - 1];
  if (ctx.slugs.size) {
    if (ctx.slugs.has(last)) return { site_id: site.blog_site_id, slug: last, title: ctx.slugs.get(last) };
    return null;
  }
  if (segs.length >= 2 && segs[segs.length - 2] === 'blog') return { site_id: site.blog_site_id || null, slug: last, title: last };
  return null;
}

const blogHref = (siteId, slug) => `#/blog?site=${encodeURIComponent(siteId)}&post=${encodeURIComponent(slug)}`;

// ---------- trend markers ----------

function localDateOfIso(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : localDate(d);
}

function buildMarkers(db, sites, start, end, ctxs) {
  const markers = [];
  for (const site of sites) {
    const ctx = ctxs.get(site.id) || blogContext(db, site);
    for (const p of ctx.posts) {
      if (p.status !== 'published' || !p.publish_date) continue;
      if (p.publish_date < start || p.publish_date > end) continue;
      markers.push({ date: p.publish_date, kind: 'blog', title: p.title, href: blogHref(site.blog_site_id, p.slug) });
    }
    if (site.brand_id) {
      const rows = db
        .prepare(
          `SELECT id, platform, copy, first_comment, publish_at, updated_at FROM posts
           WHERE status = 'published' AND brand_id = ? AND (copy LIKE ? OR first_comment LIKE ?)`
        )
        .all(site.brand_id, `%${site.domain}%`, `%${site.domain}%`);
      for (const r of rows) {
        const date = localDateOfIso(r.publish_at || r.updated_at);
        if (!date || date < start || date > end) continue;
        const snippet = String(r.copy || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        markers.push({ date, kind: 'social', title: snippet || `${r.platform} post`, platform: r.platform, href: `#/planner?post=${r.id}` });
      }
    }
  }
  markers.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return markers;
}

// ---------- alerts ----------

/** ga4 site with 0 users for the last 2 complete days while the prior 14-day average is >= 5. */
function brokenTracking(db, site, today = localDate()) {
  const rows = db
    .prepare(`SELECT date, users FROM web_daily WHERE site_id = ? AND source = 'ga4' AND date BETWEEN ? AND ?`)
    .all(site.id, addDays(today, -16), addDays(today, -1));
  if (!rows.length) return false;
  const m = new Map(rows.map((r) => [r.date, num(r.users)]));
  const last2 = [addDays(today, -1), addDays(today, -2)].map((d) => m.get(d) || 0);
  if (last2.some((n) => n > 0)) return false;
  let sum = 0;
  for (let i = 3; i <= 16; i++) sum += m.get(addDays(today, -i)) || 0;
  return sum / 14 >= 5;
}

const brokenText = (domain) => `${domain} reported 0 visitors for 2 days. Tracking may be broken.`;

function syncFailingLong(site, now = new Date()) {
  if (!site.last_sync_error) return false;
  const ref = site.last_sync_at || site.created_at;
  const t = new Date(ref).getTime();
  return Number.isFinite(t) && now.getTime() - t > 24 * 3600 * 1000;
}

/** True when stored history for this site and source reaches back to `prevStart`, so a
 * "before" number is real and not just the edge of what PostDeck has recorded. */
function hasHistoryFrom(db, siteId, source, prevStart) {
  if (!source || source === 'none') return false;
  const first = db.prepare('SELECT MIN(date) d FROM web_daily WHERE site_id = ? AND source = ?').get(siteId, source).d;
  return Boolean(first && first <= prevStart);
}

/** Earliest stored date for any of these sites in its chosen source, or null. */
function firstDataDate(db, windows) {
  let first = null;
  for (const { siteId, source } of windows) {
    if (source === 'none') continue;
    const d = db.prepare('SELECT MIN(date) d FROM web_daily WHERE site_id = ? AND source = ?').get(siteId, source).d;
    if (d && (!first || d < first)) first = d;
  }
  return first;
}

// ---------- overview ----------

function siteNumbers(db, site, days, today) {
  const w = siteWindow(db, site.id, days, today);
  let cur = { users: 0, pageviews: 0, leads: 0 };
  let prev = { users: 0, leads: 0 };
  if (w.source !== 'none') {
    cur = dailySums(db, site.id, w.source, w.start, w.end);
    prev = dailySums(db, site.id, w.source, w.prev_start, w.prev_end);
  }
  // Compare only against a fully recorded previous period. Server logs keep 14
  // days, so a 28-day view has no honest "before" until PostDeck has stored it.
  const prevComplete = hasHistoryFrom(db, site.id, w.source, w.prev_start);
  const sc = searchSums(db, site.id, w.start, w.end);
  const scPrev = searchSums(db, site.id, w.prev_start, w.prev_end);
  const sparkEnd = w.end;
  const sparkFirst = firstDataDate(db, [{ siteId: site.id, source: w.source === 'none' ? 'logs' : w.source }]);
  const sparkStart = sparkFirst && sparkFirst > addDays(sparkEnd, -27) ? sparkFirst : addDays(sparkEnd, -27);
  const spark = dailySeries(db, site.id, w.source === 'none' ? 'logs' : w.source, sparkStart, sparkEnd).map((d) => ({
    date: d.date,
    visitors: d.visitors,
  }));
  return {
    w,
    entry: {
      id: site.id,
      domain: site.domain,
      brand_id: site.brand_id,
      brand_name: site.brand_name || null,
      source: w.source,
      visitors: num(cur.users),
      visitors_prev: prevComplete ? num(prev.users) : null,
      prev_complete: prevComplete,
      pageviews: num(cur.pageviews),
      leads: num(cur.leads),
      leads_prev: prevComplete ? num(prev.leads) : null,
      lead_rate: num(cur.users) > 0 ? Math.round((num(cur.leads) / num(cur.users)) * 10000) / 10000 : 0,
      search_clicks: num(sc.clicks),
      search_clicks_prev: num(scPrev.clicks),
      avg_position: round1(sc.position),
      spark,
      last_sync_at: site.last_sync_at || null,
      error: site.last_sync_error || null,
    },
  };
}

function channelRows(db, site, source, start, end) {
  return db
    .prepare(
      `SELECT channel, src, SUM(sessions) sessions, SUM(leads) leads FROM web_channels_daily
       WHERE site_id = ? AND source = ? AND date BETWEEN ? AND ? GROUP BY channel, src`
    )
    .all(site.id, source, start, end);
}

const CHANNEL_LABELS = {
  search: 'Search',
  social: 'Social',
  ai: 'AI assistants',
  referral: 'Referral',
  direct: 'Direct',
  email: 'Email',
  paid: 'Paid',
  other: 'Other',
};
const CHANNEL_ORDER = ['search', 'social', 'ai', 'referral', 'direct', 'email', 'paid', 'other'];
const SRC_LABELS = {
  linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', x: 'X', threads: 'Threads', tiktok: 'TikTok',
  youtube: 'YouTube', bluesky: 'Bluesky', pinterest: 'Pinterest', reddit: 'Reddit',
};
const srcLabel = (s) => (s ? SRC_LABELS[s] || s : '(none)');

function rangeLabel(days) {
  if (days === 7) return 'last 7 days';
  if (days === 28) return 'last 28 days';
  if (days === 90) return 'last 90 days';
  return 'last 12 months';
}

function changePhrase(cur, prev) {
  const p = pctChange(cur, prev);
  if (p === null) return '.';
  if (p === 0) return ', no change.';
  return p > 0 ? `, up ${p}%.` : `, down ${Math.abs(p)}%.`;
}

function blogLeadCount(db, site, source, start, end, ctx) {
  if (source !== 'ga4') return null;
  const rows = db
    .prepare(
      `SELECT path, SUM(leads) leads FROM web_pages_daily WHERE site_id = ? AND source = 'ga4' AND date BETWEEN ? AND ? AND leads > 0 GROUP BY path`
    )
    .all(site.id, start, end);
  let n = 0;
  for (const r of rows) if (matchBlog(ctx, site, r.path) || /\/blog\//.test(r.path)) n += num(r.leads);
  return n;
}

function firstDaysLines(db, site, ctx, w, today) {
  const lines = [];
  if (w.source === 'none') return lines;
  for (const p of ctx.posts) {
    if (p.status !== 'published' || !p.publish_date || p.publish_date < w.start || p.publish_date > w.end) continue;
    const d0 = p.publish_date;
    const d2 = addDays(d0, 2);
    const slugPaths = db
      .prepare(`SELECT DISTINCT path FROM web_pages_daily WHERE site_id = ? AND source = ? AND date BETWEEN ? AND ?`)
      .all(site.id, w.source === 'ga4' ? 'ga4' : 'logs', d0, d2)
      .filter((r) => {
        const segs = r.path.split('?')[0].split('/').filter(Boolean);
        return segs[segs.length - 1] === p.slug;
      })
      .map((r) => r.path);
    if (!slugPaths.length) continue;
    let visitors = 0;
    for (const path of slugPaths) {
      visitors += num(
        db
          .prepare(`SELECT COALESCE(SUM(users),0) n FROM web_pages_daily WHERE site_id = ? AND source = ? AND path = ? AND date BETWEEN ? AND ?`)
          .get(site.id, w.source, path, d0, d2).n
      );
    }
    const done = d2 < today;
    lines.push({
      level: 'info',
      text: `Your blog post "${p.title}" got ${fmt(visitors)} ${visitors === 1 ? 'visitor' : 'visitors'} ${done ? 'in its first 3 days' : 'so far'}.`,
      site_id: site.id,
      href: blogHref(site.blog_site_id, p.slug),
    });
  }
  return lines;
}

async function googleStatusSafe() {
  const p = await getProviders();
  if (!p.google || typeof p.google.googleStatus !== 'function') {
    return { connected: false, key_present: false, client_email: null, error: null };
  }
  const s = await safe(() => p.google.googleStatus(), {});
  return {
    connected: Boolean(s.connected),
    key_present: Boolean(s.key_present),
    client_email: s.client_email || null,
    error: s.error || null,
  };
}

async function buildOverview(db, { brand_id, range }) {
  ensureSites(db);
  const days = parseRange(range);
  const today = localDate();
  const sites = selectSites(db, { brand_id });
  const nums = sites.map((s) => ({ site: s, ...siteNumbers(db, s, days, today) }));
  const anyGa4 = nums.some((n) => n.w.source === 'ga4');
  const top = windowFor(days, anyGa4, today);
  const ctxs = new Map(sites.map((s) => [s.id, blogContext(db, s)]));

  const sum = (k) => nums.reduce((a, n) => a + num(n.entry[k]), 0);
  const prevOk = nums.every((n) => n.entry.source === 'none' || n.entry.prev_complete);
  const totals = {
    visitors: sum('visitors'),
    visitors_prev: prevOk ? sum('visitors_prev') : null,
    leads: sum('leads'),
    leads_prev: prevOk ? sum('leads_prev') : null,
    search_clicks: sum('search_clicks'),
    search_clicks_prev: sum('search_clicks_prev'),
  };

  // trend
  // Start the chart where recorded history starts, so the days before PostDeck had any
  // data don't draw as a fake drop to zero.
  const firstData = firstDataDate(db, nums.map((n) => ({ siteId: n.site.id, source: n.w.source })));
  const trendStart = firstData && firstData > top.start && firstData <= top.end ? firstData : top.start;
  const dayMap = new Map(dateList(trendStart, top.end).map((d) => [d, { date: d, visitors: 0, leads: 0 }]));
  for (const n of nums) {
    if (n.w.source === 'none') continue;
    for (const r of dailySeries(db, n.site.id, n.w.source, top.start, top.end)) {
      const t = dayMap.get(r.date);
      if (t) {
        t.visitors += r.visitors;
        t.leads += r.leads;
      }
    }
  }
  const trend = { days: [...dayMap.values()], markers: buildMarkers(db, sites, top.start, top.end, ctxs) };

  // the read
  const warns = [];
  const rest = [];
  for (const n of nums) {
    const s = n.site;
    if (brokenTracking(db, s, today)) {
      warns.push({ level: 'warn', text: brokenText(s.domain), site_id: s.id, href: '#/analytics' });
    }
    if (syncFailingLong(s)) {
      warns.push({ level: 'warn', text: `${s.domain}: the last sync failed. ${String(s.last_sync_error).slice(0, 160)}`, site_id: s.id, href: '#/settings' });
    }
    const e = n.entry;
    if (e.source !== 'none' && e.visitors_prev >= 50 && e.visitors < e.visitors_prev * 0.6) {
      warns.push({
        level: 'warn',
        text: `${s.domain}: visitors down ${Math.round(((e.visitors_prev - e.visitors) / e.visitors_prev) * 100)}% against the previous ${days} days.`,
        site_id: s.id,
        href: '#/analytics',
      });
    }
  }
  const withData = nums.filter((n) => n.entry.source !== 'none' && (n.entry.visitors > 0 || n.entry.visitors_prev > 0));
  for (const n of withData) {
    const e = n.entry;
    const p = pctChange(e.visitors, e.visitors_prev);
    const rows = channelRows(db, n.site, n.w.source, n.w.start, n.w.end);
    const total = rows.reduce((a, r) => a + num(r.sessions), 0);
    const search = rows.filter((r) => r.channel === 'search').reduce((a, r) => a + num(r.sessions), 0);
    const share = total > 0 ? Math.round((search / total) * 100) : 0;
    rest.push({
      level: p !== null && p > 0 ? 'good' : 'info',
      text:
        `${e.domain}: ${plural(e.visitors, 'visitor', 'visitors')} in the ${rangeLabel(days)}${changePhrase(e.visitors, e.visitors_prev)}` +
        (share >= 1 ? ` Google search brought ${share}% of them.` : ''),
      site_id: e.id,
      href: '#/analytics',
    });
  }
  if (totals.leads > 0) {
    let blogLeads = 0;
    let known = false;
    for (const n of nums) {
      const b = blogLeadCount(db, n.site, n.w.source, n.w.start, n.w.end, ctxs.get(n.site.id));
      if (b !== null) {
        known = true;
        blogLeads += b;
      }
    }
    rest.push({
      level: 'good',
      text:
        known && blogLeads > 0
          ? `${plural(totals.leads, 'lead', 'leads')}, ${fmt(blogLeads)} from blog posts.`
          : `${plural(totals.leads, 'lead', 'leads')} in the ${rangeLabel(days)}.`,
      href: '#/analytics',
    });
  }
  for (const n of nums) rest.push(...firstDaysLines(db, n.site, ctxs.get(n.site.id), n.w, today));
  if (!withData.length && !warns.length) {
    rest.push({
      level: 'info',
      text: 'No traffic numbers yet. Run a sync, or connect Google in Settings to see more.',
    });
  }
  const read = [...warns, ...rest].map((r) => ({ ...r, text: cleanText(r.text) }));

  const stamps = sites.map((s) => s.last_sync_at).filter(Boolean).sort();
  const g = await googleStatusSafe();
  return {
    range: { days, start: top.start, end: top.end, prev_start: top.prev_start, prev_end: top.prev_end },
    as_of: stamps.length ? stamps[stamps.length - 1] : null,
    google_connected: g.connected,
    read,
    totals,
    sites: nums.map((n) => n.entry),
    trend,
  };
}

function cleanText(s) {
  return normalizeDashes(String(s ?? '')).replace(/!/g, '.');
}

// ---------- channels ----------

function buildChannels(db, { site_id, brand_id, range }) {
  ensureSites(db);
  const days = parseRange(range);
  const sites = selectSites(db, { site_id, brand_id });
  const agg = new Map();
  const sources = new Set();
  let prevOk = true;
  for (const s of sites) {
    const w = siteWindow(db, s.id, days);
    if (w.source === 'none') continue;
    sources.add(w.source);
    if (!hasHistoryFrom(db, s.id, w.source, w.prev_start)) prevOk = false;
    for (const [key, a, b, into] of [['cur', w.start, w.end, 'sessions'], ['prev', w.prev_start, w.prev_end, 'sessions_prev']]) {
      for (const r of channelRows(db, s, w.source, a, b)) {
        const ch = agg.get(r.channel) || { channel: r.channel, sessions: 0, sessions_prev: 0, leads: 0, bd: new Map() };
        ch[into] += num(r.sessions);
        if (key === 'cur') {
          ch.leads += num(r.leads);
          const x = ch.bd.get(r.src) || { src: r.src, sessions: 0, leads: 0 };
          x.sessions += num(r.sessions);
          x.leads += num(r.leads);
          ch.bd.set(r.src, x);
        }
        agg.set(r.channel, ch);
      }
    }
  }
  const total = [...agg.values()].reduce((a, c) => a + c.sessions, 0);
  const rows = [...agg.values()]
    .map((c) => ({
      channel: c.channel,
      label: CHANNEL_LABELS[c.channel] || c.channel,
      sessions: c.sessions,
      sessions_prev: prevOk ? c.sessions_prev : null,
      share: total > 0 ? Math.round((c.sessions / total) * 10000) / 10000 : 0,
      leads: c.leads,
      breakdown: [...c.bd.values()]
        .filter((b) => b.sessions > 0 || b.leads > 0)
        .sort((a, b) => b.sessions - a.sessions)
        .map((b) => ({ src: b.src, label: srcLabel(b.src), sessions: b.sessions, leads: b.leads })),
    }))
    .filter((c) => c.sessions > 0 || c.sessions_prev > 0 || c.leads > 0)
    .sort((a, b) => b.sessions - a.sessions || CHANNEL_ORDER.indexOf(a.channel) - CHANNEL_ORDER.indexOf(b.channel));
  return { source: sources.has('ga4') ? 'ga4' : sources.has('logs') ? 'logs' : 'none', rows };
}

// ---------- pages ----------

const LEGAL_RE = /^\/(privacy|terms|cookie|cookies|legal|disclaimer|imprint)/i;
function pageData(db, site, w, ctx) {
  const days = w.days;
  const scale = days / 28;
  const minVol = 20 * scale;
  const cur = db
    .prepare(
      `SELECT path, SUM(views) views, SUM(users) users, SUM(leads) leads FROM web_pages_daily
       WHERE site_id = ? AND source = ? AND date BETWEEN ? AND ? GROUP BY path`
    )
    .all(site.id, w.source, w.start, w.end);
  const prev = new Map(
    db
      .prepare(
        `SELECT path, SUM(views) views FROM web_pages_daily WHERE site_id = ? AND source = ? AND date BETWEEN ? AND ? GROUP BY path`
      )
      .all(site.id, w.source, w.prev_start, w.prev_end)
      .map((r) => [r.path, num(r.views)])
  );
  const sc = new Map(
    db
      .prepare(
        `SELECT path, SUM(clicks) clicks, SUM(impressions) imps, SUM(position * impressions) wpos FROM web_search_daily
         WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY path`
      )
      .all(site.id, w.start, w.end)
      .map((r) => [r.path, r])
  );
  const prevOk = hasHistoryFrom(db, site.id, w.source, w.prev_start);
  const paths = new Set(cur.map((r) => r.path));
  const curMap = new Map(cur.map((r) => [r.path, r]));
  const rows = [];
  for (const path of paths) {
    const c = curMap.get(path);
    const views = num(c.views);
    const viewsPrev = prev.get(path) || 0;
    const s = sc.get(path);
    const imps = s ? num(s.imps) : 0;
    const position = s && imps > 0 ? round1(num(s.wpos) / imps) : null;
    const tags = [];
    if (prevOk && Math.max(views, viewsPrev) >= minVol) {
      if (viewsPrev === 0 && views >= minVol) tags.push('rising');
      else if (viewsPrev > 0) {
        const ch = (views - viewsPrev) / viewsPrev;
        if (ch >= 0.3) tags.push('rising');
        else if (ch <= -0.3) tags.push('falling');
      }
    }
    if (position !== null && position >= 8 && position <= 20 && imps >= 50) tags.push('refresh');
    const bare = String(path).split('?')[0];
    if (w.source === 'ga4' && views >= 100 && num(c.leads) === 0 && !/^\/blog\/?$/.test(bare) && !LEGAL_RE.test(bare)) tags.push('no_leads');
    rows.push({
      site_id: site.id,
      domain: site.domain,
      path,
      url: `https://${site.domain}${path}`,
      views,
      views_prev: prevOk ? viewsPrev : null,
      search_clicks: s ? num(s.clicks) : 0,
      impressions: imps,
      position,
      leads: num(c.leads),
      tags,
      blog: matchBlog(ctx, site, path),
    });
  }
  return rows;
}

function buildPages(db, { site_id, brand_id, range, limit }) {
  ensureSites(db);
  const days = parseRange(range);
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const sites = selectSites(db, { site_id, brand_id });
  const out = [];
  const sources = new Set();
  for (const s of sites) {
    const w = siteWindow(db, s.id, days);
    if (w.source === 'none') continue;
    sources.add(w.source);
    out.push(...pageData(db, s, w, blogContext(db, s)));
  }
  out.sort((a, b) => b.views - a.views);
  return { source: sources.has('ga4') ? 'ga4' : sources.has('logs') ? 'logs' : 'none', rows: out.slice(0, lim) };
}

// ---------- search ----------

async function buildSearch(db, { site_id, brand_id, range }) {
  ensureSites(db);
  const days = parseRange(range);
  const scale = days / 28;
  const sites = selectSites(db, { site_id, brand_id });
  const queries = [];
  const striking = [];
  let any = false;
  for (const s of sites) {
    const w = windowFor(days, true);
    const rows = db
      .prepare(
        `SELECT query, path, SUM(clicks) clicks, SUM(impressions) imps, SUM(position * impressions) wpos
         FROM web_search_daily WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query, path`
      )
      .all(s.id, w.start, w.end);
    if (rows.length) any = true;
    const ctx = blogContext(db, s);
    const byQuery = new Map();
    for (const r of rows) {
      const q = byQuery.get(r.query) || { query: r.query, clicks: 0, imps: 0, wpos: 0, path: r.path, best: -1, site_id: s.id };
      q.clicks += num(r.clicks);
      q.imps += num(r.imps);
      q.wpos += num(r.wpos);
      if (num(r.imps) > q.best) {
        q.best = num(r.imps);
        q.path = r.path;
      }
      byQuery.set(r.query, q);
    }
    for (const q of byQuery.values()) {
      const position = q.imps > 0 ? round1(q.wpos / q.imps) : null;
      const item = {
        query: q.query,
        clicks: q.clicks,
        impressions: q.imps,
        ctr: q.imps > 0 ? Math.round((q.clicks / q.imps) * 10000) / 10000 : 0,
        position,
        path: q.path,
      };
      queries.push({ ...item, site_id: s.id });
      if (position !== null && position >= 5 && position <= 20 && q.imps >= 30 * scale) {
        striking.push({
          query: q.query,
          impressions: q.imps,
          clicks: q.clicks,
          position,
          path: q.path,
          site_id: s.id,
          blog: matchBlog(ctx, s, q.path),
        });
      }
    }
  }
  queries.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
  striking.sort((a, b) => b.impressions - a.impressions);
  const g = await googleStatusSafe();
  return { connected: g.connected || any, queries: queries.slice(0, 100), striking: striking.slice(0, 100) };
}

// ---------- social ----------

function buildSocial(db, { brand_id, range }) {
  ensureSites(db);
  const days = parseRange(range);
  const sites = selectSites(db, { brand_id });
  const brandIds = [...new Set(sites.map((s) => s.brand_id).filter(Boolean))];
  const utm = brandIds.map((id) => {
    const b = db.prepare('SELECT id, name FROM brands WHERE id = ?').get(id);
    return { brand_id: id, brand_name: b ? b.name : null, enabled: getBrandUtmSettings(db, id).enabled };
  });
  const platforms = new Map();
  const posts = new Map();
  for (const s of sites) {
    const w = siteWindow(db, s.id, days);
    if (w.source === 'none') continue;
    const rows = db
      .prepare(
        `SELECT channel, src, content, SUM(sessions) sessions, SUM(leads) leads FROM web_channels_daily
         WHERE site_id = ? AND source = ? AND date BETWEEN ? AND ? AND (channel = 'social' OR content LIKE 'pd-%')
         GROUP BY channel, src, content`
      )
      .all(s.id, w.source, w.start, w.end);
    for (const r of rows) {
      if (r.channel === 'social') {
        const p = platforms.get(r.src) || { platform: r.src, sessions: 0, leads: 0 };
        p.sessions += num(r.sessions);
        p.leads += num(r.leads);
        platforms.set(r.src, p);
      }
      const m = /^pd-(\d+)$/.exec(r.content || '');
      if (m) {
        const id = Number(m[1]);
        const p = posts.get(id) || { post_id: id, sessions: 0, leads: 0 };
        p.sessions += num(r.sessions);
        p.leads += num(r.leads);
        posts.set(id, p);
      }
    }
  }
  const postRows = [];
  for (const p of posts.values()) {
    const row = db.prepare('SELECT id, platform, brand_id, copy, publish_at FROM posts WHERE id = ?').get(p.post_id);
    if (!row) continue;
    if (brand_id !== undefined && brand_id !== null && brand_id !== '' && row.brand_id !== Number(brand_id)) continue;
    postRows.push({
      post_id: p.post_id,
      platform: row.platform,
      brand_id: row.brand_id,
      snippet: String(row.copy || '').replace(/\s+/g, ' ').trim().slice(0, 100),
      published_at: row.publish_at || null,
      sessions: p.sessions,
      leads: p.leads,
    });
  }
  postRows.sort((a, b) => b.sessions - a.sessions);
  return {
    utm,
    platforms: [...platforms.values()].sort((a, b) => b.sessions - a.sessions),
    posts: postRows,
  };
}

// ---------- health ----------

function redirectLine(path) {
  const p = String(path || '').split('?')[0];
  if (!/^\/[A-Za-z0-9/_.~%+@:-]*$/.test(p)) return `# unusual path, add by hand: ${p.replace(/[^\x20-\x7E]/g, '?').slice(0, 120)}`;
  return `location = ${p} { return 301 /; }`;
}

function buildHealth(db, { site_id, brand_id, range }) {
  ensureSites(db);
  const days = parseRange(range);
  const sites = selectSites(db, { site_id, brand_id });
  const not_found = [];
  const bots = [];
  const forms = [];
  const lead_check = [];
  for (const s of sites) {
    const w = windowFor(days, false);
    for (const r of db
      .prepare(`SELECT path, SUM(hits) hits FROM web_notfound_daily WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY path ORDER BY hits DESC LIMIT 50`)
      .all(s.id, w.start, w.end)) {
      not_found.push({ site_id: s.id, domain: s.domain, path: r.path, hits: num(r.hits), redirect_line: redirectLine(r.path) });
    }
    const d = dailySums(db, s.id, 'logs', w.start, w.end);
    const hasLogs = db.prepare(`SELECT 1 FROM web_daily WHERE site_id = ? AND source = 'logs' AND date BETWEEN ? AND ? LIMIT 1`).get(s.id, w.start, w.end);
    if (hasLogs) bots.push({ site_id: s.id, domain: s.domain, search_bot_hits: num(d.search_bot_hits), ai_bot_hits: num(d.ai_bot_hits) });
    // Relay outcome names (wp-to-static/infra/form-relay/server.js) folded into the
    // contract's buckets. failed = the relay accepted it but email delivery broke.
    const OUTCOME_BUCKET = { delivered: 'delivered', delivered_tagged: 'tagged', tagged: 'tagged', js_check: 'blocked', ratelimited: 'blocked', blocked: 'blocked', honeypot: 'honeypot', invalid: 'invalid', unknown_site: 'invalid', smtp_error: 'failed', smtp_unconfigured: 'failed' };
    const f = { delivered: 0, tagged: 0, blocked: 0, honeypot: 0, invalid: 0, failed: 0 };
    let hasForms = false;
    for (const r of db
      .prepare(`SELECT outcome, SUM(count) n FROM web_forms_daily WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY outcome`)
      .all(s.id, w.start, w.end)) {
      hasForms = true;
      const bucket = OUTCOME_BUCKET[r.outcome];
      if (bucket) f[bucket] += num(r.n);
    }
    if (hasForms) forms.push({ site_id: s.id, domain: s.domain, ...f });
    const gw = windowFor(days, true);
    const hasGa4 = db.prepare(`SELECT 1 FROM web_daily WHERE site_id = ? AND source = 'ga4' AND date BETWEEN ? AND ? LIMIT 1`).get(s.id, gw.start, gw.end);
    if (hasGa4 || hasForms) {
      const ga4Leads = hasGa4 ? num(dailySums(db, s.id, 'ga4', gw.start, gw.end).leads) : null;
      const relay = f.delivered;
      let text;
      if (ga4Leads === null) text = `No GA4 numbers yet. The form relay delivered ${plural(relay, 'lead', 'leads')}.`;
      else if (relay > 0 && ga4Leads < relay * 0.5) {
        text = `${s.domain}: GA4 counted ${ga4Leads} but the form relay delivered ${relay}. The lead event may be broken or blocked.`;
      } else if (relay === 0 && ga4Leads === 0) text = `${s.domain}: no leads from either source in this range.`;
      else text = `${s.domain}: GA4 counted ${ga4Leads} and the form relay delivered ${relay}. They line up.`;
      lead_check.push({ site_id: s.id, domain: s.domain, ga4_leads: ga4Leads, relay_delivered: relay, text: cleanText(text) });
    }
  }
  not_found.sort((a, b) => b.hits - a.hits);
  return { not_found, bots, forms, lead_check };
}

// ---------- realtime ----------

const rtCache = new Map();
const RT_TTL = { ga4: 60_000, logs: 120_000 };

async function buildRealtime(db, { brand_id }) {
  ensureSites(db);
  const p = await getProviders();
  const sites = selectSites(db, { brand_id });
  const out = [];
  const needLogs = [];
  const results = new Map();
  for (const s of sites) {
    const hit = rtCache.get(`ga4:${s.id}`);
    if (hit && Date.now() - hit.at < RT_TTL.ga4) {
      results.set(s.id, { active_now: hit.n, source: 'ga4' });
      continue;
    }
    let n = null;
    if (p.google && typeof p.google.ga4ActiveNow === 'function' && s.ga4_property_id) {
      n = await safe(() => p.google.ga4ActiveNow(db, s), null);
    }
    if (typeof n === 'number') {
      rtCache.set(`ga4:${s.id}`, { at: Date.now(), n });
      results.set(s.id, { active_now: n, source: 'ga4' });
    } else needLogs.push(s);
  }
  const fresh = [];
  for (const s of needLogs) {
    const hit = rtCache.get(`logs:${s.id}`);
    if (hit && Date.now() - hit.at < RT_TTL.logs) results.set(s.id, { active_now: hit.n, source: 'logs' });
    else fresh.push(s);
  }
  if (fresh.length) {
    let map = null;
    if (p.logs && typeof p.logs.logsActiveNow === 'function') map = await safe(() => p.logs.logsActiveNow(db, fresh), null);
    for (const s of fresh) {
      const n = map && typeof map[s.id] === 'number' ? map[s.id] : null;
      if (n !== null) rtCache.set(`logs:${s.id}`, { at: Date.now(), n });
      results.set(s.id, { active_now: n, source: 'logs' });
    }
  }
  for (const s of sites) {
    const r = results.get(s.id) || { active_now: null, source: 'logs' };
    out.push({ site_id: s.id, domain: s.domain, active_now: r.active_now, window: '30m', source: r.source });
  }
  return { sites: out };
}

// ---------- home ----------

function buildHome(db) {
  ensureSites(db);
  const today = localDate();
  const sites = selectSites(db, {});
  const alerts = [];
  let visitors = 0;
  let visitorsPrev = 0;
  let leads = 0;
  let leadsPrev = 0;
  let anyData = false;
  let topPost = null;
  const yesterday = addDays(today, -1);
  const newLeads = [];
  for (const s of sites) {
    const n = siteNumbers(db, s, 7, today);
    const e = n.entry;
    if (e.source !== 'none') anyData = true;
    visitors += e.visitors;
    visitorsPrev += e.visitors_prev;
    leads += e.leads;
    leadsPrev += e.leads_prev;
    if (brokenTracking(db, s, today)) alerts.push({ level: 'warn', text: brokenText(s.domain), href: '#/analytics' });
    if (e.source !== 'none' && e.visitors_prev >= 50 && e.visitors < e.visitors_prev * 0.6) {
      alerts.push({
        level: 'warn',
        text: `${s.domain}: visitors down ${Math.round(((e.visitors_prev - e.visitors) / e.visitors_prev) * 100)}% week over week (${fmt(e.visitors)} against ${fmt(e.visitors_prev)}).`,
        href: '#/analytics',
      });
    }
    if (syncFailingLong(s)) {
      alerts.push({ level: 'warn', text: `${s.domain}: the sync has been failing for over a day. ${String(s.last_sync_error).slice(0, 160)}`, href: '#/settings' });
    }
    if (e.source !== 'none') {
      const l = num(dailySums(db, s.id, e.source, yesterday, today).leads);
      if (l > 0) newLeads.push({ domain: s.domain, n: l });
    }
    // The relay accepted a form but could not email it: a lead that never arrived.
    const lost = num(
      db
        .prepare(`SELECT COALESCE(SUM(count),0) n FROM web_forms_daily WHERE site_id = ? AND date BETWEEN ? AND ? AND outcome IN ('smtp_error','smtp_unconfigured')`)
        .get(s.id, yesterday, today).n
    );
    if (lost > 0) {
      alerts.push({ level: 'warn', text: `${s.domain}: ${plural(lost, 'form submission', 'form submissions')} could not be emailed to you. Check the form relay.`, href: '#/analytics' });
    }
    // top blog post of the week
    if (n.w.source !== 'none') {
      const ctx = blogContext(db, s);
      for (const r of pageData(db, s, { ...n.w, days: 7 }, ctx)) {
        if (!r.blog) continue;
        const users = num(
          db
            .prepare(`SELECT COALESCE(SUM(users),0) n FROM web_pages_daily WHERE site_id = ? AND source = ? AND path = ? AND date BETWEEN ? AND ?`)
            .get(s.id, n.w.source, r.path, n.w.start, n.w.end).n
        );
        if (users > 0 && (!topPost || users > topPost.visitors)) {
          topPost = { title: r.blog.title, href: blogHref(r.blog.site_id, r.blog.slug), visitors: users };
        }
      }
    }
  }
  const total = newLeads.reduce((a, x) => a + x.n, 0);
  if (total > 0) {
    alerts.push({
      level: 'info',
      text: `${plural(total, 'new lead', 'new leads')} since yesterday (${newLeads.map((x) => x.domain).join(', ')}).`,
      href: '#/analytics',
    });
  }
  const line = anyData
    ? cleanText(`This week: ${fmt(visitors)} ${visitors === 1 ? 'visitor' : 'visitors'} across your sites, ${plural(leads, 'lead', 'leads')}.`)
    : null;
  return {
    line,
    alerts: alerts.map((a) => ({ ...a, text: cleanText(a.text) })),
    week: { visitors, visitors_prev: visitorsPrev, leads, leads_prev: leadsPrev, top_post: topPost },
  };
}

// ---------- blog stats, per-post, daily ----------

function buildBlogStats(db, { blog_site_id, range }) {
  ensureSites(db);
  const days = parseRange(range);
  const posts = {};
  const sites = db.prepare(`${SITE_SELECT} WHERE s.blog_site_id = ?`).all(String(blog_site_id || ''));
  for (const s of sites) {
    const w = siteWindow(db, s.id, days);
    const ctx = blogContext(db, s);
    if (w.source !== 'none') {
      for (const r of pageData(db, s, w, ctx)) {
        const b = matchBlog(ctx, s, r.path);
        if (!b) continue;
        const cur = posts[b.slug] || { views: 0, search_clicks: 0, position: null, _imps: 0, _wpos: 0 };
        cur.views += r.views;
        cur.search_clicks += r.search_clicks;
        if (r.position !== null && r.impressions > 0) {
          cur._imps += r.impressions;
          cur._wpos += r.position * r.impressions;
        }
        posts[b.slug] = cur;
      }
    }
  }
  for (const k of Object.keys(posts)) {
    const p = posts[k];
    p.position = p._imps > 0 ? round1(p._wpos / p._imps) : null;
    delete p._imps;
    delete p._wpos;
  }
  return { posts };
}

function buildPost(db, id) {
  const pat = `pd-${Number(id)}`;
  const rows = db
    .prepare(`SELECT source, SUM(sessions) sessions, SUM(leads) leads, COUNT(*) n FROM web_channels_daily WHERE content = ? GROUP BY source`)
    .all(pat);
  if (!rows.length) return { sessions: null };
  const pick = rows.find((r) => r.source === 'ga4') || rows[0];
  return { sessions: num(pick.sessions), leads: num(pick.leads), source: pick.source };
}

function buildDaily(db, { brand_id, start, end }) {
  ensureSites(db);
  const e = DATE_RE.test(String(end || '')) ? end : localDate();
  const st = DATE_RE.test(String(start || '')) ? start : addDays(e, -30);
  const map = new Map(dateList(st, e).map((d) => [d, 0]));
  for (const s of selectSites(db, { brand_id })) {
    const hasGa4 = db.prepare(`SELECT 1 FROM web_daily WHERE site_id = ? AND source = 'ga4' AND date BETWEEN ? AND ? LIMIT 1`).get(s.id, st, e);
    const source = hasGa4 ? 'ga4' : 'logs';
    for (const r of dailySeries(db, s.id, source, st, e)) map.set(r.date, (map.get(r.date) || 0) + r.visitors);
  }
  return { days: [...map.entries()].map(([date, visitors]) => ({ date, visitors })) };
}

// ---------- sites endpoint ----------

function siteChecklist(site, g, ssh) {
  const who = g.client_email || 'the service account';
  const items = [];
  items.push({ id: 'google_key', done: g.key_present, text: 'Add the Google service account key in Settings > Websites' });
  if (site.ga4_measurement_id || site.ga4_property_id) {
    items.push({ id: 'ga4_viewer', done: Boolean(site.ga4_property_id), text: `Add ${who} as Viewer on the GA4 property for ${site.domain}` });
  } else {
    items.push({ id: 'ga4_property', done: false, text: `Create a GA4 property for ${site.domain} and add its tag to the site` });
  }
  items.push({ id: 'gsc_user', done: Boolean(site.gsc_property), text: `Add ${who} as a Restricted user on the Search Console property for ${site.domain}` });
  items.push({ id: 'logs', done: Boolean(ssh && ssh.ok), text: 'Server logs need read-only SSH access to the VPS' });
  return items;
}

async function sshStatusSafe() {
  const p = await getProviders();
  if (!p.logs || typeof p.logs.sshStatus !== 'function') return { ok: false, host: null, error: 'Server log access is not set up.', self_ip: null };
  const s = await safe(() => p.logs.sshStatus(), null);
  if (!s) return { ok: false, host: null, error: 'Could not check SSH.', self_ip: null };
  return { ok: Boolean(s.ok), host: s.host || null, error: s.error || null, self_ip: s.self_ip || null };
}

function siteShape(site, g, ssh) {
  return {
    id: site.id,
    domain: site.domain,
    brand_id: site.brand_id,
    brand_name: site.brand_name || null,
    brand_slug: site.brand_slug || null,
    blog_site_id: site.blog_site_id || null,
    ga4_measurement_id: site.ga4_measurement_id || null,
    ga4_property_id: site.ga4_property_id || null,
    gsc_property: site.gsc_property || null,
    active: Boolean(site.active),
    last_sync_at: site.last_sync_at || null,
    last_sync_error: site.last_sync_error || null,
    checklist: siteChecklist(site, g, ssh),
  };
}

// ---------- sync ----------

let syncing = false;
const lastAttempt = new Map(); // `${source}:${siteId|all}` -> ms
let lastDiscovery = 0;

function lastSyncOf(db, source, siteId) {
  const r = siteId
    ? db.prepare(`SELECT MAX(finished_at) t FROM web_sync_runs WHERE source = ? AND site_id = ?`).get(source, siteId)
    : db.prepare(`SELECT MAX(finished_at) t FROM web_sync_runs WHERE source = ?`).get(source);
  const db_t = r && r.t ? new Date(r.t).getTime() : 0;
  const mem = lastAttempt.get(`${source}:${siteId || 'all'}`) || 0;
  return Math.max(Number.isFinite(db_t) ? db_t : 0, mem);
}

function hasRows(db, table, siteId, source) {
  const q = source
    ? db.prepare(`SELECT 1 FROM ${table} WHERE site_id = ? AND source = ? LIMIT 1`).get(siteId, source)
    : db.prepare(`SELECT 1 FROM ${table} WHERE site_id = ? LIMIT 1`).get(siteId);
  return Boolean(q);
}

function recordResults(db, results, now = nowIso()) {
  const bySite = new Map();
  for (const r of results) {
    if (!r.site_id) continue;
    const e = bySite.get(r.site_id) || { ok: false, errors: [] };
    if (r.ok) e.ok = true;
    else if (r.error) e.errors.push(String(r.error));
    bySite.set(r.site_id, e);
  }
  for (const [id, e] of bySite) {
    if (e.errors.length) {
      db.prepare('UPDATE web_sites SET last_sync_error = ?, updated_at = ? WHERE id = ?').run(cleanText(e.errors[0]).slice(0, 400), now, id);
      if (e.ok) db.prepare('UPDATE web_sites SET last_sync_at = ? WHERE id = ?').run(now, id);
    } else if (e.ok) {
      db.prepare('UPDATE web_sites SET last_sync_at = ?, last_sync_error = NULL, updated_at = ? WHERE id = ?').run(now, now, id);
    }
  }
}

/**
 * Run the requested syncs. `force` ignores the schedule. Each source and site
 * is isolated; nothing here throws.
 */
async function runSyncs(db, { sites, sources, force = false, now = Date.now() }) {
  const p = await getProviders();
  const results = [];
  const g = p.google && typeof p.google.googleStatus === 'function' ? await safe(() => p.google.googleStatus(), {}) : {};
  const connected = Boolean(g && g.connected);
  const want = (s) => sources.includes(s);

  if (want('logs')) {
    try {
      const due = force || now - lastSyncOf(db, 'logs', null) > 60 * 60 * 1000;
      if (due) {
        if (!p.logs || typeof p.logs.syncLogs !== 'function') {
          for (const s of sites) results.push({ site_id: s.id, source: 'logs', ok: false, rows: 0, error: 'Server log sync is not available.' });
        } else {
          const first = !sites.some((s) => hasRows(db, 'web_daily', s.id, 'logs'));
          lastAttempt.set('logs:all', now);
          const res = await p.logs.syncLogs(db, sites, { days: first ? 14 : 2 });
          for (const r of Array.isArray(res) ? res : []) {
            results.push({ site_id: r.site_id, source: 'logs', ok: Boolean(r.ok), rows: num(r.rows), error: r.error || null });
          }
        }
      }
    } catch (err) {
      for (const s of sites) results.push({ site_id: s.id, source: 'logs', ok: false, rows: 0, error: String(err.message || err) });
    }
  }

  const googleWanted = want('ga4') || want('gsc');
  if (googleWanted) {
    if (!connected) {
      if (force) {
        for (const s of sites) {
          for (const src of ['ga4', 'gsc']) {
            if (want(src)) results.push({ site_id: s.id, source: src, ok: false, rows: 0, error: 'Google is not connected.' });
          }
        }
      }
    } else {
      try {
        const missing = sites.some((s) => !s.ga4_property_id || !s.gsc_property);
        if (p.google && typeof p.google.discoverGoogle === 'function' && missing && (force || now - lastDiscovery > 3600 * 1000)) {
          lastDiscovery = now;
          await safe(() => p.google.discoverGoogle(db), null);
        }
      } catch {
        // discovery is best effort
      }
      for (const s0 of sites) {
        const s = db.prepare('SELECT * FROM web_sites WHERE id = ?').get(s0.id) || s0;
        if (want('ga4') && p.google && typeof p.google.syncGa4 === 'function' && s.ga4_property_id) {
          if (force || now - lastSyncOf(db, 'ga4', s.id) > 6 * 3600 * 1000) {
            lastAttempt.set(`ga4:${s.id}`, now);
            const first = !hasRows(db, 'web_daily', s.id, 'ga4');
            try {
              const r = await p.google.syncGa4(db, s, { days: first ? 90 : 4 });
              results.push({ site_id: s.id, source: 'ga4', ok: Boolean(r && r.ok), rows: num(r && r.rows), error: (r && r.error) || null });
            } catch (err) {
              results.push({ site_id: s.id, source: 'ga4', ok: false, rows: 0, error: String(err.message || err) });
            }
          }
        }
        if (want('gsc') && p.google && typeof p.google.syncGsc === 'function' && s.gsc_property) {
          if (force || now - lastSyncOf(db, 'gsc', s.id) > 12 * 3600 * 1000) {
            lastAttempt.set(`gsc:${s.id}`, now);
            const first = !hasRows(db, 'web_search_daily', s.id, null);
            try {
              const r = await p.google.syncGsc(db, s, { days: first ? 90 : 5 });
              results.push({ site_id: s.id, source: 'gsc', ok: Boolean(r && r.ok), rows: num(r && r.rows), error: (r && r.error) || null });
            } catch (err) {
              results.push({ site_id: s.id, source: 'gsc', ok: false, rows: 0, error: String(err.message || err) });
            }
          }
        }
      }
    }
  }
  recordResults(db, results);
  return results;
}

/** Worker phase. Never throws. Returns the number of source runs it made. */
async function runWebPhase(db, { now = Date.now() } = {}) {
  if (process.env.POSTDECK_WEB_SYNC === '0') return 0;
  if (syncing) return 0;
  syncing = true;
  try {
    ensureSites(db);
    const sites = selectSites(db, {});
    if (!sites.length) return 0;
    const results = await runSyncs(db, { sites, sources: ['logs', 'ga4', 'gsc'], force: false, now });
    return results.length;
  } catch (err) {
    console.error('[web] sync phase error', err);
    return 0;
  } finally {
    syncing = false;
  }
}

function _resetWebState() {
  syncing = false;
  lastAttempt.clear();
  lastDiscovery = 0;
  rtCache.clear();
}

// ---------- digest ----------

async function buildDigest(db, { brand_id }) {
  const ov = await buildOverview(db, { brand_id, range: 28 });
  const lines = [
    `Window: ${ov.range.start} to ${ov.range.end} (28 days), compared with ${ov.range.prev_start} to ${ov.range.prev_end}.`,
    `Totals: visitors ${ov.totals.visitors} (before ${ov.totals.visitors_prev}), leads ${ov.totals.leads} (before ${ov.totals.leads_prev}), search clicks ${ov.totals.search_clicks} (before ${ov.totals.search_clicks_prev}).`,
    ...ov.sites.map((s) => `${s.domain}: source ${s.source}, visitors ${s.visitors} (before ${s.visitors_prev}), leads ${s.leads}, search clicks ${s.search_clicks}, avg position ${s.avg_position ?? 'n/a'}.`),
    ...ov.read.map((r) => `Note (${r.level}): ${r.text}`),
    ...ov.trend.markers.slice(0, 20).map((m) => `Work on ${m.date}: ${m.kind} "${m.title}".`),
  ];
  const prompt = [
    'You write a short website traffic summary for the owner of several small business sites.',
    'Write 4 to 6 short plain sentences. Numbers first. Say what moved and what it might connect to (posts published, search). Name one thing to do next.',
    'No long dashes, no exclamation marks, no hype, no markdown, no bullet symbols. Plain text only.',
    '',
    'Data:',
    ...lines,
  ].join('\n');
  const p = await getProviders();
  const provider = getRawSetting(db, 'draft_provider') || 'claude';
  const model = process.env.POSTDECK_BLOG_DRAFT_MODEL || process.env.POSTDECK_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
  const text = await p.ai.runDraft(provider, { prompt, model, budget: '0.10', timeoutMs: 120_000 });
  return { text: cleanText(String(text || '').trim()) };
}

// ---------- routes ----------

function registerWebRoutes(app, db) {
  ensureSites(db);
  const q = (req) => req.query || {};

  app.get('/api/web/status', async () => {
    const g = await googleStatusSafe();
    const ssh = await sshStatusSafe();
    const last = (source) => {
      const r = db.prepare(`SELECT MAX(finished_at) t FROM web_sync_runs WHERE source = ? AND ok = 1`).get(source);
      return r && r.t ? r.t : null;
    };
    return { google: g, ssh, last_sync: { logs: last('logs'), ga4: last('ga4'), gsc: last('gsc') }, syncing };
  });

  app.get('/api/web/sites', async () => {
    ensureSites(db);
    const g = await googleStatusSafe();
    const ssh = await sshStatusSafe();
    const sites = selectSites(db, { includeInactive: true }).map((s) => siteShape(s, g, ssh));
    const ips = db.prepare('SELECT ip, how, last_seen FROM web_self_ips ORDER BY last_seen DESC').all();
    const optout_links = sites
      .filter((s) => s.active)
      .map((s) => ({ domain: s.domain, on_url: `https://${s.domain}/?pd_internal=on`, off_url: `https://${s.domain}/?pd_internal=off` }));
    return { sites, self: { ips, optout_links } };
  });

  app.patch('/api/web/sites/:id', async (req, reply) => {
    ensureSites(db);
    const id = Number(req.params.id);
    const row = db.prepare('SELECT * FROM web_sites WHERE id = ?').get(id);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const sets = [];
    const args = [];
    if (b.brand_id !== undefined) {
      if (b.brand_id !== null && !db.prepare('SELECT 1 FROM brands WHERE id = ?').get(Number(b.brand_id))) {
        reply.code(400);
        return { error: 'bad_request', message: 'Unknown brand.' };
      }
      sets.push('brand_id = ?');
      args.push(b.brand_id === null ? null : Number(b.brand_id));
    }
    if (b.ga4_property_id !== undefined) {
      const v = b.ga4_property_id === null || b.ga4_property_id === '' ? null : String(b.ga4_property_id).trim();
      if (v !== null && !/^\d{3,20}$/.test(v)) {
        reply.code(400);
        return { error: 'bad_request', message: 'The GA4 property id is the numeric id, not the G- measurement id.' };
      }
      sets.push('ga4_property_id = ?');
      args.push(v);
    }
    if (b.gsc_property !== undefined) {
      const v = b.gsc_property === null || b.gsc_property === '' ? null : String(b.gsc_property).trim();
      if (v !== null && !/^(sc-domain:[A-Za-z0-9.-]+|https?:\/\/\S+)$/.test(v)) {
        reply.code(400);
        return { error: 'bad_request', message: 'Use sc-domain:example.com or a full https URL.' };
      }
      sets.push('gsc_property = ?');
      args.push(v);
    }
    if (b.active !== undefined) {
      sets.push('active = ?');
      args.push(b.active === true || b.active === 1 || b.active === '1' ? 1 : 0);
    }
    if (sets.length) {
      sets.push('updated_at = ?');
      args.push(nowIso());
      db.prepare(`UPDATE web_sites SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
    }
    const g = await googleStatusSafe();
    const ssh = await sshStatusSafe();
    return siteShape(db.prepare(`${SITE_SELECT} WHERE s.id = ?`).get(id), g, ssh);
  });

  app.post('/api/web/google-key', async (req, reply) => {
    const text = req.body && typeof req.body.json === 'string' ? req.body.json : null;
    if (!text || !text.trim()) {
      reply.code(400);
      return { error: 'bad_request', message: 'Paste the key file text.' };
    }
    const p = await getProviders();
    if (!p.google || typeof p.google.saveServiceAccountKey !== 'function') {
      reply.code(503);
      return { error: 'unavailable', message: 'Google support is not available.' };
    }
    try {
      const res = await p.google.saveServiceAccountKey(text);
      const g = await googleStatusSafe();
      return { ok: true, client_email: (res && res.client_email) || g.client_email || null };
    } catch (err) {
      reply.code(400);
      const msg = String(err.message || 'That key could not be saved.');
      return { error: 'bad_key', message: /PRIVATE KEY|private_key/i.test(msg) ? 'That key could not be read.' : msg.slice(0, 300) };
    }
  });

  app.delete('/api/web/google-key', async (req, reply) => {
    const p = await getProviders();
    if (!p.google || typeof p.google.deleteServiceAccountKey !== 'function') {
      reply.code(503);
      return { error: 'unavailable', message: 'Google support is not available.' };
    }
    try {
      await p.google.deleteServiceAccountKey();
      return { ok: true };
    } catch (err) {
      reply.code(500);
      return { error: 'failed', message: String(err.message || 'Could not remove the key.').slice(0, 300) };
    }
  });

  app.post('/api/web/sync', async (req, reply) => {
    ensureSites(db);
    const b = req.body || {};
    const source = ['logs', 'ga4', 'gsc', 'all'].includes(b.source) ? b.source : 'all';
    const sources = source === 'all' ? ['logs', 'ga4', 'gsc'] : [source];
    const sites = selectSites(db, { site_id: b.site_id });
    if (b.site_id !== undefined && b.site_id !== null && !sites.length) {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (syncing) {
      reply.code(409);
      return { ok: false, results: [], error: 'A sync is already running.' };
    }
    syncing = true;
    try {
      const results = await runSyncs(db, { sites, sources, force: true });
      return { ok: results.length > 0 ? results.every((r) => r.ok) : true, results };
    } catch (err) {
      reply.code(500);
      return { ok: false, results: [], error: String(err.message || err) };
    } finally {
      syncing = false;
    }
  });

  app.get('/api/web/overview', async (req) => buildOverview(db, q(req)));
  app.get('/api/web/channels', async (req) => buildChannels(db, q(req)));
  app.get('/api/web/pages', async (req) => buildPages(db, q(req)));
  app.get('/api/web/search', async (req) => buildSearch(db, q(req)));
  app.get('/api/web/social', async (req) => buildSocial(db, q(req)));
  app.get('/api/web/health', async (req) => buildHealth(db, q(req)));
  app.get('/api/web/realtime', async (req) => buildRealtime(db, q(req)));
  app.get('/api/web/home', async () => buildHome(db));
  app.get('/api/web/blog-stats', async (req) => buildBlogStats(db, q(req)));
  app.get('/api/web/post/:id', async (req) => buildPost(db, req.params.id));
  app.get('/api/web/daily', async (req) => buildDaily(db, q(req)));

  app.post('/api/web/digest', async (req, reply) => {
    try {
      return await buildDigest(db, req.body || {});
    } catch (err) {
      reply.code(err.statusCode || 503);
      return { error: 'ai_unavailable', message: String(err.message || 'AI summary unavailable').slice(0, 300) };
    }
  });
}

export {
  registerWebRoutes,
  runWebPhase,
  ensureSites,
  setWebProviders,
  siteWindow,
  windowFor,
  _resetWebState,
};
