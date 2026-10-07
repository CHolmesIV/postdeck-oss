// js/80-web.js - Website Analytics frontend (docs/WEB_ANALYTICS_SPEC.md, "Build contract").
// Owns: the Analytics hub (#/analytics: Websites + Social tabs), Settings > Websites, and the
// small hooks the other views call (webHomeRows, webBlogStats, webBlogMaybeOpen, webPostLine,
// webPlannerFilterButton, webPlannerTint). Classic script in a shared global scope: every
// top-level name here is prefixed web / WEB_. Dev fixtures: localStorage.pd_web_fixture = '1'
// serves canned /api/web/* responses from 81-web-fixtures.js (loaded on demand).

const WEB_RANGE_KEY = 'pd_web_range';
const WEB_BRAND_KEY = 'pd_web_brand';
const WEB_PLANNER_KEY = 'pd_planner_traffic';
const WEB_RANGES = [[7, '7 days'], [28, '28 days'], [90, '90 days'], [365, '12 months']];
const WEB_SVG_NS = 'http://www.w3.org/2000/svg';
const WEB_CHANNEL_LABELS = { search: 'Search', social: 'Social', ai: 'AI assistants', referral: 'Referral', direct: 'Direct', email: 'Email', paid: 'Paid', other: 'Other' };
const WEB_PLATFORM_LABELS = { linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', twitter: 'X', x: 'X', threads: 'Threads', tiktok: 'TikTok', youtube: 'YouTube', bluesky: 'Bluesky', pinterest: 'Pinterest', reddit: 'Reddit' };
const WEB_STATE = {
  sites: null, sitesAt: 0,
  home: null, homeAt: 0, tok: 0,
  planner: { brand: null, map: null, max: 0, loading: false, failed: false },
};

// ---------------- small helpers ----------------

function webSafeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function webSafeSet(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
function webFixtureOn() { return webSafeGet('pd_web_fixture') === '1'; }

let webFixturePromise = null;
function webLoadFixtures() {
  if (typeof webFixtureHandle === 'function') return Promise.resolve();
  if (!webFixturePromise) {
    webFixturePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/js/81-web-fixtures.js';
      s.onload = () => resolve();
      s.onerror = () => { webFixturePromise = null; reject(new Error('Sample data file is missing.')); };
      document.head.appendChild(s);
    });
  }
  return webFixturePromise;
}

// Every web call goes through here so the dev fixture mode can answer instead of the server.
async function webApi(path, opts = {}) {
  if (webFixtureOn()) {
    await webLoadFixtures();
    const res = await webFixtureHandle(path, opts);
    if (res !== undefined) return res;
  }
  return api(path, opts);
}

function webQS(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
}

function webErrText(err) {
  if (err && err.status === 404) return 'This server does not have website analytics yet.';
  return (err && err.message) || 'Something went wrong.';
}

function webSvg(tag, attrs = {}, kids = []) {
  const n = document.createElementNS(WEB_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) n.setAttribute(k, String(v));
  for (const c of [].concat(kids)) if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  return n;
}

function webNum(n) { return n == null || Number.isNaN(Number(n)) ? '-' : Number(n).toLocaleString(); }
function webCompact(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${Math.round(v / 1000)}k`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.round(v));
}
function webPlural(n, one, many) { return `${webNum(n)} ${Number(n) === 1 ? one : (many || `${one}s`)}`; }
function webRate(leads, visitors) {
  if (!visitors) return null;
  const pct = (leads / visitors) * 100;
  return pct >= 10 ? `${Math.round(pct)}%` : `${pct.toFixed(1)}%`;
}
function webPct(part, total) { return total ? Math.round((part / total) * 100) : 0; }

function webAgo(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const h = Math.round(mins / 60);
  if (h < 36) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function webParseDay(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function webDayShort(key) { return webParseDay(key).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
function webDayLong(key) { return webParseDay(key).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); }

function webPlatformLabel(p) { return WEB_PLATFORM_LABELS[String(p || '').toLowerCase()] || (p ? String(p).charAt(0).toUpperCase() + String(p).slice(1) : 'Unknown'); }
function webPlatformIcon(p, size = 14) { const k = String(p || '').toLowerCase(); return platformIcon(k === 'x' ? 'twitter' : k, { size }); }

function webSourceLabel(source) {
  if (source === 'ga4') return 'Google Analytics';
  if (source === 'logs') return 'Server logs';
  return 'Not tracking yet';
}

function webEmpty(text, href, linkLabel) {
  return el('p', { class: 'web-empty' }, [text, href ? ' ' : null, href ? el('a', { class: 'web-link', href }, linkLabel) : null]);
}

function webSkeleton() {
  return el('div', { class: 'web-skel', 'aria-hidden': 'true' }, [el('div', { class: 'skeleton-bar' }), el('div', { class: 'skeleton-bar block' })]);
}

async function webSites(force = false) {
  if (!force && WEB_STATE.sites && Date.now() - WEB_STATE.sitesAt < 30000) return WEB_STATE.sites;
  const res = await webApi('/api/web/sites');
  WEB_STATE.sites = res;
  WEB_STATE.sitesAt = Date.now();
  return res;
}

function webCopyText(text, okMsg) {
  return navigator.clipboard.writeText(text).then(
    () => toast(okMsg || 'Copied.'),
    () => toast('Could not copy. Select the text and copy it by hand.', 'error')
  );
}

// Change versus the previous period: arrow + sign + number, so colour is never the only signal.
// A read line links somewhere only when that is not this page (it is already in view).
function webReadLink(href) {
  return Boolean(href) && !/^#\/analytics(\?|$)/.test(href);
}

function webDeltaNode(cur, prev) {
  if (prev == null || cur == null) return null;
  if (Number(prev) === 0 && Number(cur) === 0) return null;
  let cls = 'is-flat';
  let glyph = '';
  let text = 'flat';
  let words = 'no change';
  if (Number(prev) === 0) { cls = 'is-up'; glyph = '▲'; text = 'new'; words = 'new, none in the previous period'; }
  else {
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct > 0) { cls = 'is-up'; glyph = '▲'; text = `${pct}%`; words = `up ${pct}%`; }
    else if (pct < 0) { cls = 'is-down'; glyph = '▼'; text = `${Math.abs(pct)}%`; words = `down ${Math.abs(pct)}%`; }
  }
  return el('span', { class: `web-delta ${cls}`, title: `${words} compared with the previous period` }, [
    glyph ? el('span', { 'aria-hidden': 'true', class: 'web-delta-glyph' }, glyph) : null,
    el('span', {}, text),
    el('span', { class: 'web-sr' }, ` (${words} compared with the previous period)`),
  ]);
}

function webSparkline(points, label) {
  const W = 112;
  const H = 28;
  const vals = (points || []).map((p) => Number(p.visitors) || 0);
  const svg = webSvg('svg', { class: 'web-spark', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label });
  if (vals.length < 2) return svg;
  const max = Math.max(1, ...vals);
  const step = (W - 4) / (vals.length - 1);
  const pts = vals.map((v, i) => `${(2 + i * step).toFixed(1)},${(H - 3 - (v / max) * (H - 6)).toFixed(1)}`);
  svg.appendChild(webSvg('polyline', { points: pts.join(' '), class: 'web-spark-line', fill: 'none' }));
  const last = pts[pts.length - 1].split(',');
  svg.appendChild(webSvg('circle', { cx: last[0], cy: last[1], r: 2.4, class: 'web-spark-dot' }));
  return svg;
}

function webIcon(name, size = 14) {
  const paths = {
    doc: ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', 'M8 13h8M8 17h5'],
    warn: ['M12 3 2.5 20h19z', 'M12 10v4.5', 'M12 17.2v.1'],
    check: ['M5 12.5 10 17.5 19 7.5'],
    chevron: ['M6 9l6 6 6-6'],
    dot: [],
  };
  const svg = webSvg('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.9, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' });
  (paths[name] || []).forEach((d) => svg.appendChild(webSvg('path', { d })));
  if (name === 'dot') svg.appendChild(webSvg('circle', { cx: 12, cy: 12, r: 3.5, fill: 'currentColor', stroke: 'none' }));
  return svg;
}

function webSection(key, title, { srTitle = false } = {}) {
  const lead = el('p', { class: 'web-lead' });
  const body = el('div', { class: 'web-sec-body' });
  const root = el('section', { class: 'web-sec', 'aria-labelledby': `web-h-${key}` }, [
    el('h2', { class: `web-h2${srTitle ? ' web-sr' : ''}`, id: `web-h-${key}` }, title),
    lead,
    body,
  ]);
  return { key, root, lead, body, tok: 0 };
}

// ---------------- #/analytics ----------------

async function renderAnalyticsHub(view) {
  view.innerHTML = '';
  view.classList.add('view-default', 'web-view');
  const tab = routeQuery().tab === 'social' ? 'social' : 'websites';
  view.appendChild(pageHeader('Analytics'));
  view.appendChild(el('nav', { class: 'web-tabs', 'aria-label': 'Analytics sections' }, [
    el('a', { class: `web-tab${tab === 'websites' ? ' active' : ''}`, href: '#/analytics', 'aria-current': tab === 'websites' ? 'page' : null }, 'Websites'),
    el('a', { class: `web-tab${tab === 'social' ? ' active' : ''}`, href: '#/analytics?tab=social', 'aria-current': tab === 'social' ? 'page' : null }, 'Social'),
  ]));
  const panel = el('div', { class: `web-panel${tab === 'social' ? ' web-social-panel' : ''}` });
  view.appendChild(panel);
  try {
    if (tab === 'social') await renderAnalytics(panel);
    else await webRenderWebsites(panel);
  } catch (err) {
    panel.appendChild(inlineBanner(`This tab failed to load: ${err.message}`, 'error'));
  }
}

async function webRenderWebsites(panel) {
  const ws = {
    brand: webSafeGet(WEB_BRAND_KEY) || '',
    range: Number(webSafeGet(WEB_RANGE_KEY)) || 28,
    sites: [],
    overview: null,
    pollTimer: null,
    stampTimer: null,
    chartRo: null,
    refreshing: false,
  };
  if (!WEB_RANGES.some(([d]) => d === ws.range)) ws.range = 28;

  let sitesRes = null;
  let sitesErr = null;
  try { sitesRes = await webSites(true); } catch (err) { sitesErr = err; }
  if (sitesErr) {
    panel.appendChild(emptyState(`Website numbers are not available yet. ${webErrText(sitesErr)}`));
    return;
  }
  ws.sites = (sitesRes && sitesRes.sites) || [];
  if (!ws.sites.length) {
    panel.appendChild(webEmpty('No websites are set up yet. Add them in Settings, then come back.', '#/settings/websites', 'Open Website settings'));
    return;
  }

  // Brand picker: only brands that own a site.
  const brands = [];
  for (const s of ws.sites) if (s.brand_id != null && !brands.some((b) => String(b.id) === String(s.brand_id))) brands.push({ id: s.brand_id, name: s.brand_name || brandName(s.brand_id) });
  if (ws.brand && !brands.some((b) => String(b.id) === String(ws.brand))) ws.brand = '';

  // ---- controls ----
  const brandSelect = el('select', { class: 'sm', 'aria-label': 'Brand' }, [
    el('option', { value: '' }, 'All brands'),
    ...brands.map((b) => el('option', { value: String(b.id) }, b.name)),
  ]);
  brandSelect.value = ws.brand;
  const seg = el('div', { class: 'web-seg', role: 'group', 'aria-label': 'Time range' });
  const segBtns = {};
  for (const [days, label] of WEB_RANGES) {
    const b = el('button', { class: 'web-seg-btn', type: 'button', 'aria-pressed': 'false' }, label);
    b.addEventListener('click', () => { ws.range = days; webSafeSet(WEB_RANGE_KEY, String(days)); paintSeg(); loadAll(); });
    segBtns[days] = b;
    seg.appendChild(b);
  }
  function paintSeg() {
    for (const [days, b] of Object.entries(segBtns)) {
      const on = Number(days) === ws.range;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }
  paintSeg();
  const refreshBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Refresh');
  const stamp = el('span', { class: 'web-stamp', 'aria-live': 'polite' }, '');
  const note = el('p', { class: 'web-note' }, '');
  brandSelect.addEventListener('change', () => { ws.brand = brandSelect.value; webSafeSet(WEB_BRAND_KEY, ws.brand); loadAll(); });
  panel.appendChild(el('div', { class: 'web-controls' }, [
    el('div', { class: 'web-controls-main' }, [brandSelect, seg]),
    el('div', { class: 'web-controls-side' }, [stamp, refreshBtn]),
  ]));
  panel.appendChild(note);
  if (webFixtureOn()) panel.appendChild(inlineBanner('Showing sample data (dev fixture mode). Nothing here comes from your sites.', 'info'));

  // ---- sections ----
  const secRead = webSection('read', 'The read', { srTitle: true });
  const secNums = webSection('numbers', 'Your sites');
  const secTrend = webSection('trend', 'Visitors and leads, day by day');
  const secChan = webSection('channels', 'Where visitors came from');
  const secPages = webSection('pages', 'Pages');
  const secSearch = webSection('search', 'Search');
  const secSocial = webSection('social', 'Visits from your posts');
  const secHealth = webSection('health', 'Site health');
  const all = [secRead, secNums, secTrend, secChan, secPages, secSearch, secSocial, secHealth];
  all.forEach((s) => { s.body.appendChild(webSkeleton()); panel.appendChild(s.root); });

  const clearTimers = () => {
    clearInterval(ws.pollTimer);
    clearInterval(ws.stampTimer);
    if (ws.chartRo) ws.chartRo.disconnect();
  };
  onViewCleanup(clearTimers);

  async function fill(sec, path, render) {
    const my = ++sec.tok;
    sec.body.classList.add('is-stale');
    sec.body.setAttribute('aria-busy', 'true');
    let data;
    let failure = null;
    try { data = await webApi(path); } catch (err) { failure = err; }
    if (my !== sec.tok) return;
    sec.body.classList.remove('is-stale');
    sec.body.removeAttribute('aria-busy');
    sec.body.innerHTML = '';
    sec.lead.textContent = '';
    if (failure) { sec.body.appendChild(webEmpty(`Could not load this section. ${webErrText(failure)}`)); return; }
    try { render(data, sec); } catch (err) {
      console.warn('[web]', sec.key, err);
      sec.body.innerHTML = '';
      sec.body.appendChild(webEmpty('This section could not be drawn.'));
    }
  }

  function loadAll() {
    const q = webQS({ brand_id: ws.brand, range: ws.range });
    fill(secRead, `/api/web/overview${q}`, (data) => {
      ws.overview = data;
      paintStamp();
      paintNote();
      webPaintRead(secRead, data);
      webPaintNumbers(secNums, data, ws);
      webPaintTrend(secTrend, data, ws);
      pollRealtime();
    }).then(() => {
      // numbers and trend come from the same response; a failure there leaves their skeletons, so settle them.
      if (!ws.overview) { for (const s of [secNums, secTrend]) { s.body.innerHTML = ''; s.body.appendChild(webEmpty('Needs the numbers above to load first.')); } }
    });
    fill(secChan, `/api/web/channels${q}`, (d, s) => webPaintChannels(s, d));
    fill(secPages, `/api/web/pages${webQS({ brand_id: ws.brand, range: ws.range, limit: 50 })}`, (d, s) => webPaintPages(s, d, ws));
    fill(secSearch, `/api/web/search${q}`, (d, s) => webPaintSearch(s, d, ws));
    fill(secSocial, `/api/web/social${q}`, (d, s) => webPaintSocial(s, d));
    fill(secHealth, `/api/web/health${q}`, (d, s) => webPaintHealth(s, d));
  }

  function paintStamp() {
    const o = ws.overview;
    const ago = o && o.as_of ? webAgo(o.as_of) : null;
    stamp.textContent = ago ? `Updated ${ago}` : 'Not synced yet';
  }
  function paintNote() {
    const o = ws.overview;
    if (!o) { note.textContent = ''; return; }
    const sources = new Set((o.sites || []).filter((s) => s.source !== 'none').map((s) => s.source));
    note.textContent = '';
    if (sources.has('ga4') && sources.has('logs')) note.append('Some sites use Google Analytics and others use server logs. Google numbers lag by a day or two. ');
    else if (sources.has('ga4')) note.append('Google Analytics and Search Console. Recent days can change by a day or two. ');
    else if (sources.has('logs')) note.append('Server logs. ');
    else note.append('No site is reporting yet. ');
    if (!o.google_connected) {
      note.append('Connect Google for search and lead data. ', el('a', { class: 'web-link', href: '#/settings/websites' }, 'Open Website settings'));
    }
  }

  refreshBtn.addEventListener('click', async () => {
    if (ws.refreshing) return;
    ws.refreshing = true;
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Refreshing...';
    refreshBtn.setAttribute('aria-busy', 'true');
    try {
      const res = await webApi('/api/web/sync', { method: 'POST', body: {} });
      const bad = ((res && res.results) || []).filter((r) => r && r.ok === false);
      if (bad.length) toast(`Refreshed, but ${bad.length === 1 ? '1 source' : `${bad.length} sources`} failed: ${bad[0].error || 'unknown error'}`, 'warn');
      else toast('Numbers refreshed.');
    } catch (err) {
      toast(`Could not refresh: ${err.message}`, 'error');
    } finally {
      ws.refreshing = false;
      refreshBtn.disabled = false;
      refreshBtn.textContent = 'Refresh';
      refreshBtn.removeAttribute('aria-busy');
    }
    WEB_STATE.sites = null;
    loadAll();
  });

  // "Active now" polls once a minute, and only while this view is the one on screen.
  async function pollRealtime() {
    if (!panel.isConnected) { clearTimers(); return; }
    if (document.visibilityState !== 'visible') return;
    let res;
    try { res = await webApi(`/api/web/realtime${webQS({ brand_id: ws.brand })}`); } catch { return; }
    const map = new Map(((res && res.sites) || []).map((r) => [String(r.site_id), r]));
    panel.querySelectorAll('[data-live-site]').forEach((node) => {
      const r = map.get(node.getAttribute('data-live-site'));
      node.innerHTML = '';
      if (!r) return;
      const n = Number(r.active_now) || 0;
      node.appendChild(el('span', { class: `status-pill status-pill--${n > 0 ? 'ok' : 'neutral'}`, title: `Visitors on the site in the last ${r.window === '30m' ? '30 minutes' : 'few minutes'}` }, `${n} active now`));
    });
  }
  ws.pollTimer = setInterval(pollRealtime, 60000);
  ws.stampTimer = setInterval(() => { if (panel.isConnected) paintStamp(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && panel.isConnected) { pollRealtime(); paintStamp(); } });

  loadAll();
}

// ---------------- the read ----------------

function webPaintRead(sec, data) {
  const items = (data.read || []).slice().sort((a, b) => (a.level === 'warn' ? 0 : 1) - (b.level === 'warn' ? 0 : 1));
  if (!items.length) {
    sec.body.appendChild(webEmpty('Nothing to report yet. A short plain summary shows up here after the first sync.'));
    return;
  }
  const list = el('ul', { class: 'web-read' });
  for (const it of items) {
    const level = it.level === 'warn' ? 'warn' : it.level === 'good' ? 'good' : 'info';
    const icon = level === 'warn' ? webIcon('warn', 16) : level === 'good' ? webIcon('check', 16) : webIcon('dot', 16);
    const text = [level === 'warn' ? el('span', { class: 'web-sr' }, 'Warning: ') : null, it.text];
    list.appendChild(el('li', { class: `web-read-item is-${level}` }, [
      el('span', { class: 'web-read-icon' }, icon),
      el('span', { class: 'web-read-text' }, [...text, webReadLink(it.href) ? ' ' : null, webReadLink(it.href) ? el('a', { class: 'web-link', href: it.href }, it.href.startsWith('#/blog') ? 'Open post' : 'Open') : null]),
    ]));
  }
  sec.body.appendChild(list);
}

// ---------------- numbers row per site ----------------

function webPaintNumbers(sec, data, ws) {
  const sites = data.sites || [];
  sec.body.innerHTML = '';
  if (!sites.length) { sec.body.appendChild(webEmpty('No sites to show for this brand.')); return; }
  const head = el('tr', {}, [
    el('th', { scope: 'col' }, 'Site'),
    el('th', { scope: 'col', class: 'num' }, 'Visitors'),
    el('th', { scope: 'col', class: 'num' }, 'Leads'),
    el('th', { scope: 'col', class: 'num' }, 'Lead rate'),
    el('th', { scope: 'col', class: 'num' }, 'Search clicks'),
    el('th', { scope: 'col', class: 'web-col-spark' }, 'Last 28 days'),
    el('th', { scope: 'col', class: 'web-col-live' }, 'Right now'),
  ]);
  const rows = sites.map((s) => {
    const siteCell = el('th', { scope: 'row', class: 'web-site-cell' }, [
      el('a', { class: 'web-site-name', href: `https://${s.domain}`, target: '_blank', rel: 'noopener noreferrer' }, s.domain),
      el('span', { class: 'web-sub' }, `${s.brand_name || ''}${s.brand_name ? ', ' : ''}${webSourceLabel(s.source)}`),
      s.error ? el('span', { class: 'web-sub web-sub--bad' }, `Last sync failed: ${s.error}`) : null,
    ]);
    if (s.source === 'none') {
      return el('tr', { class: 'web-row web-row--none' }, [
        siteCell,
        el('td', { colspan: '6', class: 'web-none-cell' }, 'No visitor numbers yet. They show up after a sync finds server log rows or Google Analytics data for this site.'),
      ]);
    }
    const visitors = Number(s.visitors) || 0;
    const leads = Number(s.leads) || 0;
    return el('tr', { class: 'web-row' }, [
      siteCell,
      el('td', { class: 'num', 'data-label': 'Visitors' }, [el('span', { class: 'web-big' }, webNum(visitors)), webDeltaNode(s.visitors, s.visitors_prev)]),
      el('td', { class: 'num', 'data-label': 'Leads' }, [el('span', { class: 'web-big' }, webNum(leads)), webDeltaNode(s.leads, s.leads_prev)]),
      el('td', { class: 'num', 'data-label': 'Lead rate' }, [el('span', { class: 'web-big' }, webRate(leads, visitors) || '-')]),
      el('td', { class: 'num', 'data-label': 'Search clicks' }, s.search_clicks == null
        ? el('span', { class: 'web-muted', title: 'Needs Google Search Console' }, '-')
        : [el('span', { class: 'web-big' }, webNum(s.search_clicks)), webDeltaNode(s.search_clicks, s.search_clicks_prev)]),
      el('td', { class: 'web-col-spark', 'data-label': 'Last 28 days' }, webSparkline(s.spark, `${s.domain} visitors over the last 28 days`)),
      el('td', { class: 'web-col-live', 'data-label': 'Right now' }, el('span', { 'data-live-site': String(s.id) })),
    ]);
  });
  if (sites.length > 1 && data.totals && sites.some((x) => x.source !== 'none')) {
    const t = data.totals;
    rows.push(el('tr', { class: 'web-row web-row--total' }, [
      el('th', { scope: 'row', class: 'web-site-cell' }, el('span', { class: 'web-site-name' }, 'All of these')),
      el('td', { class: 'num', 'data-label': 'Visitors' }, [el('span', { class: 'web-big' }, webNum(t.visitors)), webDeltaNode(t.visitors, t.visitors_prev)]),
      el('td', { class: 'num', 'data-label': 'Leads' }, [el('span', { class: 'web-big' }, webNum(t.leads)), webDeltaNode(t.leads, t.leads_prev)]),
      el('td', { class: 'num', 'data-label': 'Lead rate' }, el('span', { class: 'web-big' }, webRate(t.leads, t.visitors) || '-')),
      el('td', { class: 'num', 'data-label': 'Search clicks' }, t.search_clicks == null ? el('span', { class: 'web-muted' }, '-') : [el('span', { class: 'web-big' }, webNum(t.search_clicks)), webDeltaNode(t.search_clicks, t.search_clicks_prev)]),
      el('td', { class: 'web-col-spark' }),
      el('td', { class: 'web-col-live' }),
    ]));
  }
  const days = data.range ? data.range.days : ws.range;
  const webSpan = days === 365 ? '12 months' : `${days} days`;
  const webAnyPrev = (data.sites || []).some((x) => x.visitors_prev != null);
  sec.lead.textContent = webAnyPrev
    ? `Each change arrow compares the last ${webSpan} with the ${webSpan} before.`
    : `Change arrows appear once PostDeck has recorded the ${webSpan} before this period. Server logs only keep 14 days, so PostDeck stores them as it goes.`;
  sec.body.appendChild(el('div', { class: 'web-table-wrap' }, el('table', { class: 'web-table web-numbers' }, [el('thead', {}, head), el('tbody', {}, rows)])));
}

// ---------------- trend chart ----------------

function webNiceMax(v) {
  const cands = [];
  for (let j = 0; j <= 7; j += 1) for (const c of [4, 8, 12, 16, 20, 40, 80]) cands.push(c * Math.pow(10, j));
  cands.sort((a, b) => a - b);
  return cands.find((c) => c >= v) || v;
}

function webPaintTrend(sec, data, ws) {
  const trend = data.trend || { days: [], markers: [] };
  const days = trend.days || [];
  sec.body.innerHTML = '';
  const anyVisitors = days.some((d) => Number(d.visitors) > 0);
  if (!days.length || !anyVisitors) {
    sec.lead.textContent = 'This chart lines up your visitors with what you published.';
    sec.body.appendChild(webEmpty('No visitors recorded for this range yet. The chart fills in after the first sync of a site that has tracking.'));
    return;
  }
  const best = days.reduce((a, d) => (Number(d.visitors) > Number(a.visitors) ? d : a), days[0]);
  const leadDays = days.filter((d) => Number(d.leads) > 0).length;
  const markers = trend.markers || [];
  const blogN = markers.filter((m) => m.kind === 'blog').length;
  const socialN = markers.filter((m) => m.kind === 'social').length;
  const bits = [`Busiest day was ${webDayLong(best.date)} with ${webPlural(best.visitors, 'visitor')}.`];
  bits.push(leadDays ? `Leads came in on ${webPlural(leadDays, 'day')}.` : 'No leads in this range.');
  if (blogN || socialN) bits.push(`Markers show ${blogN ? webPlural(blogN, 'blog post') : ''}${blogN && socialN ? ' and ' : ''}${socialN ? webPlural(socialN, 'social post') : ''} you put out.`);
  sec.lead.textContent = bits.join(' ');

  const legend = el('ul', { class: 'web-legend' }, [
    el('li', {}, [webSvg('svg', { width: 22, height: 10, 'aria-hidden': 'true' }, webSvg('line', { x1: 1, y1: 5, x2: 21, y2: 5, class: 'web-lg-line' })), 'Visitors per day']),
    el('li', {}, [webSvg('svg', { width: 12, height: 12, 'aria-hidden': 'true' }, webSvg('circle', { cx: 6, cy: 6, r: 4.5, class: 'web-lg-dot' })), 'Days with leads']),
    el('li', {}, [el('span', { class: 'web-lg-blog' }, webIcon('doc', 12)), 'Blog post released']),
    el('li', {}, [el('span', { class: 'web-lg-tick' }), 'Social post linking here']),
  ]);
  const host = el('div', { class: 'web-chart' });
  sec.body.append(legend, host, webTrendTable(days, markers));

  let lastW = 0;
  const draw = () => {
    const w = Math.floor(host.clientWidth);
    if (!w || Math.abs(w - lastW) < 8) return;
    lastW = w;
    webDrawTrend(host, trend);
  };
  if (ws.chartRo) ws.chartRo.disconnect();
  if (typeof ResizeObserver === 'function') {
    ws.chartRo = new ResizeObserver(() => draw());
    ws.chartRo.observe(host);
  }
  draw();
}

// The same numbers as the chart, for screen readers.
function webTrendTable(days, markers) {
  const rows = days.map((d) => el('tr', {}, [el('th', { scope: 'row' }, webDayLong(d.date)), el('td', {}, String(d.visitors || 0)), el('td', {}, String(d.leads || 0))]));
  const list = markers.length
    ? el('ul', {}, markers.map((m) => el('li', {}, `${webDayLong(m.date)}: ${m.kind === 'blog' ? 'Blog post' : `Social post${m.platform ? ` on ${webPlatformLabel(m.platform)}` : ''}`}, ${m.title || ''}`)))
    : null;
  return el('div', { class: 'web-sr' }, [
    el('table', {}, [
      el('caption', {}, 'Visitors and leads for each day in this range'),
      el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, 'Day'), el('th', { scope: 'col' }, 'Visitors'), el('th', { scope: 'col' }, 'Leads')])),
      el('tbody', {}, rows),
    ]),
    list ? el('h3', {}, 'What you published') : null,
    list,
  ]);
}

function webDrawTrend(host, trend) {
  host.innerHTML = '';
  const days = trend.days || [];
  const n = days.length;
  const W = Math.max(280, Math.floor(host.clientWidth));
  const narrow = W < 520;
  const H = narrow ? 210 : 270;
  const lane = 30;
  const m = { l: narrow ? 36 : 44, r: 12, t: lane + 8, b: 26 };
  const pw = W - m.l - m.r;
  const ph = H - m.t - m.b;
  const maxRaw = Math.max(1, ...days.map((d) => Number(d.visitors) || 0));
  const maxV = webNiceMax(maxRaw);
  const x = (i) => m.l + (n <= 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v) => m.t + ph - (v / maxV) * ph;

  const total = days.reduce((a, d) => a + (Number(d.visitors) || 0), 0);
  const svg = webSvg('svg', {
    class: 'web-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img',
    'aria-label': `Line chart of visitors per day, ${webDayShort(days[0].date)} to ${webDayShort(days[n - 1].date)}. ${webNum(total)} visitors in total, busiest day ${webNum(maxRaw)}. A table with every day follows.`,
  });
  for (let t = 0; t <= 4; t += 1) {
    const yy = m.t + ph - (t / 4) * ph;
    svg.appendChild(webSvg('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy, class: t === 0 ? 'web-axis' : 'web-grid' }));
    svg.appendChild(webSvg('text', { x: m.l - 6, y: yy + 4, class: 'web-tick', 'text-anchor': 'end' }, webCompact((maxV * t) / 4)));
  }
  const labelCount = narrow ? 3 : 6;
  for (let k = 0; k < Math.min(labelCount, n); k += 1) {
    const i = n === 1 ? 0 : Math.round((k * (n - 1)) / (Math.min(labelCount, n) - 1 || 1));
    const anchor = k === 0 ? 'start' : k === Math.min(labelCount, n) - 1 ? 'end' : 'middle';
    svg.appendChild(webSvg('text', { x: x(i), y: H - 6, class: 'web-tick', 'text-anchor': anchor }, webDayShort(days[i].date)));
  }
  const d = days.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(Number(p.visitors) || 0).toFixed(1)}`).join(' ');
  svg.appendChild(webSvg('path', { d, class: 'web-line', fill: 'none' }));
  days.forEach((p, i) => {
    const leads = Number(p.leads) || 0;
    if (leads > 0) svg.appendChild(webSvg('circle', { cx: x(i), cy: y(Number(p.visitors) || 0), r: Math.min(8, 4 + leads), class: 'web-lead-dot' }));
  });
  const guide = webSvg('line', { class: 'web-guide', y1: m.t, y2: m.t + ph, x1: 0, x2: 0, visibility: 'hidden' });
  const cross = webSvg('line', { class: 'web-cross', y1: m.t, y2: m.t + ph, x1: 0, x2: 0, visibility: 'hidden' });
  const focusDot = webSvg('circle', { class: 'web-focus-dot', r: 4.5, cx: 0, cy: 0, visibility: 'hidden' });
  const overlay = webSvg('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent', class: 'web-overlay' });
  svg.append(guide, cross, focusDot, overlay);

  const lanes = el('div', { class: 'web-markers', style: `height:${lane}px` });
  const tip = el('div', { class: 'web-tip', hidden: 'hidden', 'aria-hidden': 'true' });
  const card = el('div', { class: 'web-card', hidden: 'hidden' });
  host.append(lanes, svg, tip, card);

  // Day tooltip on pointer move.
  const showDay = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / pw) * (n - 1))));
    const p = days[i];
    const cx = x(i);
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    focusDot.setAttribute('cx', cx); focusDot.setAttribute('cy', y(Number(p.visitors) || 0)); focusDot.setAttribute('visibility', 'visible');
    tip.innerHTML = '';
    tip.append(el('strong', {}, webDayLong(p.date)), el('span', {}, `${webPlural(p.visitors || 0, 'visitor')}${Number(p.leads) ? `, ${webPlural(p.leads, 'lead')}` : ''}`));
    tip.hidden = false;
    const tw = tip.offsetWidth || 120;
    const left = Math.max(4, Math.min(W - tw - 4, cx - tw / 2));
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(lane + 2, y(Number(p.visitors) || 0) - 52)}px`;
  };
  const hideDay = () => { cross.setAttribute('visibility', 'hidden'); focusDot.setAttribute('visibility', 'hidden'); tip.hidden = true; };
  overlay.addEventListener('pointermove', showDay);
  overlay.addEventListener('pointerdown', showDay);
  overlay.addEventListener('pointerleave', hideDay);

  // Markers: real buttons in a lane above the plot, so they are keyboard reachable.
  const indexByDate = new Map(days.map((p, i) => [p.date, i]));
  const groups = new Map();
  for (const mk of trend.markers || []) {
    if (!indexByDate.has(mk.date)) continue;
    const key = `${mk.date}|${mk.kind}`;
    if (!groups.has(key)) groups.set(key, { date: mk.date, kind: mk.kind, items: [] });
    groups.get(key).items.push(mk);
  }
  let hideTimer = null;
  let pinned = null;
  const closeCard = () => { card.hidden = true; guide.setAttribute('visibility', 'hidden'); pinned = null; };
  const openCard = (g, btn, pin) => {
    clearTimeout(hideTimer);
    hideDay();
    card.innerHTML = '';
    card.appendChild(el('div', { class: 'web-card-date' }, webDayLong(g.date)));
    for (const it of g.items) {
      card.appendChild(el('a', { class: 'web-card-link', href: it.href || '#/analytics' }, [
        g.kind === 'blog' ? el('span', { class: 'web-card-ico' }, webIcon('doc', 13)) : el('span', { class: 'web-card-ico' }, webPlatformIcon(it.platform, 13)),
        el('span', {}, [el('span', { class: 'web-card-kind' }, g.kind === 'blog' ? 'Blog post released' : `Social post${it.platform ? ` on ${webPlatformLabel(it.platform)}` : ''}`), el('span', { class: 'web-card-title' }, it.title || 'Untitled')]),
      ]));
    }
    card.hidden = false;
    const cw = card.offsetWidth || 240;
    const bx = btn.offsetLeft + btn.offsetWidth / 2;
    card.style.left = `${Math.max(4, Math.min(W - cw - 4, bx - cw / 2))}px`;
    card.style.top = `${lane + 2}px`;
    const gx = x(indexByDate.get(g.date));
    guide.setAttribute('x1', gx); guide.setAttribute('x2', gx); guide.setAttribute('visibility', 'visible');
    if (pin) pinned = g;
  };
  const scheduleHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (!pinned) closeCard(); }, 180); };
  card.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  card.addEventListener('mouseleave', scheduleHide);
  card.addEventListener('focusout', () => { setTimeout(() => { if (!card.contains(document.activeElement) && !lanes.contains(document.activeElement)) closeCard(); }, 0); });
  host.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !card.hidden) { closeCard(); } });

  const bothSameDay = (g) => groups.has(`${g.date}|${g.kind === 'blog' ? 'social' : 'blog'}`);
  for (const g of groups.values()) {
    const base = x(indexByDate.get(g.date));
    const off = bothSameDay(g) ? (g.kind === 'blog' ? -11 : 11) : 0;
    const label = g.kind === 'blog'
      ? `Blog post released ${webDayLong(g.date)}: ${g.items.map((i) => i.title).join('; ')}`
      : `${webPlural(g.items.length, 'social post')} on ${webDayLong(g.date)}: ${g.items.map((i) => i.title).join('; ')}`;
    const btn = el('button', { class: `web-marker web-marker--${g.kind}`, type: 'button', 'aria-label': label, style: `left:${(base + off).toFixed(1)}px` },
      g.kind === 'blog' ? webIcon('doc', 13) : el('span', { class: 'web-marker-tick' }, g.items.length > 1 ? el('span', { class: 'web-marker-count' }, String(g.items.length)) : null));
    btn.addEventListener('mouseenter', () => openCard(g, btn, false));
    btn.addEventListener('mouseleave', scheduleHide);
    btn.addEventListener('focus', () => openCard(g, btn, false));
    btn.addEventListener('click', () => {
      if (g.items.length === 1 && g.items[0].href) { webGo(g.items[0].href); return; }
      if (pinned === g) closeCard(); else openCard(g, btn, true);
    });
    lanes.appendChild(btn);
  }
}

function webGo(href) {
  if (!href) return;
  if (href.startsWith('#')) location.hash = href;
  else window.open(href, '_blank', 'noopener');
}

// ---------------- channels ----------------

function webPaintChannels(sec, data) {
  const rows = (data.rows || []).filter((r) => Number(r.sessions) > 0).sort((a, b) => b.sessions - a.sessions);
  if (!rows.length) {
    sec.lead.textContent = 'This shows how people found you: search, social, direct links and more.';
    sec.body.appendChild(webEmpty('No visit sources yet. They appear after the first sync of a site that has traffic.'));
    return;
  }
  const total = rows.reduce((a, r) => a + r.sessions, 0);
  const top = rows[0];
  const ai = rows.find((r) => r.channel === 'ai');
  const topLabel = top.label || WEB_CHANNEL_LABELS[top.channel] || top.channel;
  sec.lead.textContent = `${topLabel} brought the most visits, ${webPct(top.sessions, total)}% of the total.${ai ? ` AI assistants sent ${webPlural(ai.sessions, 'visit')}.` : ''}`;
  const hasLeads = data.source === 'ga4';
  const maxS = Math.max(...rows.map((r) => r.sessions));
  const list = el('ul', { class: 'web-ch' });
  list.appendChild(el('li', { class: 'web-ch-head', 'aria-hidden': 'true' }, [
    el('span', {}, 'Source'), el('span', { class: 'web-ch-barcol' }, ''), el('span', { class: 'num' }, 'Visits'), el('span', { class: 'num' }, 'Share'), el('span', { class: 'num' }, 'Leads'), el('span', {}, ''),
  ]));
  for (const r of rows) {
    const label = r.label || WEB_CHANNEL_LABELS[r.channel] || r.channel;
    const share = r.share != null ? Math.round(r.share * (r.share <= 1 ? 100 : 1)) : webPct(r.sessions, total);
    const bd = (r.breakdown || []).filter((b) => Number(b.sessions) > 0);
    const rowInner = [
      el('span', { class: 'web-ch-name' }, label),
      el('span', { class: 'web-ch-barcol' }, el('span', { class: 'web-ch-bar' }, el('span', { class: 'web-ch-fill', style: `width:${Math.max(2, (r.sessions / maxS) * 100).toFixed(1)}%` }))),
      el('span', { class: 'num' }, [webNum(r.sessions), webDeltaNode(r.sessions, r.sessions_prev)]),
      el('span', { class: 'num' }, `${share}%`),
      el('span', { class: 'num' }, hasLeads ? webNum(r.leads) : el('span', { class: 'web-muted', title: 'Leads by source need Google Analytics' }, '-')),
      el('span', { class: 'web-ch-chev' }, bd.length ? webIcon('chevron', 14) : null),
    ];
    const li = el('li', { class: `web-ch-item${r.channel === 'ai' ? ' is-ai' : ''}` });
    if (bd.length) {
      const more = el('ul', { class: 'web-ch-more', hidden: 'hidden' }, bd.map((b) => el('li', { class: 'web-ch-sub' }, [
        el('span', { class: 'web-ch-subname' }, [r.channel === 'social' ? webPlatformIcon(b.src, 13) : null, r.channel === 'social' ? ` Visits from ${b.label || webPlatformLabel(b.src)}` : (b.label || b.src)]),
        el('span', { class: 'num' }, webNum(b.sessions)),
        el('span', { class: 'num' }, `${webPct(b.sessions, r.sessions)}%`),
        el('span', { class: 'num' }, hasLeads ? webNum(b.leads) : ''),
        el('span', {}, ''),
      ])));
      const btn = el('button', { class: 'web-ch-row', type: 'button', 'aria-expanded': 'false', 'aria-label': `${label}, ${webPlural(r.sessions, 'visit')}. Show breakdown` }, rowInner);
      btn.addEventListener('click', () => {
        const open = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        more.hidden = !open;
        li.classList.toggle('is-open', open);
      });
      li.append(btn, more);
    } else {
      li.appendChild(el('div', { class: 'web-ch-row is-static' }, rowInner));
    }
    list.appendChild(li);
  }
  sec.body.appendChild(list);
  if (!hasLeads) sec.body.appendChild(el('p', { class: 'web-foot' }, ['Leads by source need Google Analytics. ', el('a', { class: 'web-link', href: '#/settings/websites' }, 'Connect it in Website settings')]));
}

// ---------------- pages ----------------

const WEB_TAG_INFO = {
  rising: ['Rising', 'ok', 'Visits are up 30% or more on the previous period.'],
  falling: ['Falling', 'bad', 'Visits are down 30% or more on the previous period.'],
  refresh: ['Refresh candidate', 'warn', 'Ranks 8 to 20 on Google. A rewrite pays back fastest here.'],
  no_leads: ['No leads', 'neutral', 'Plenty of visits but no form submissions. Check the form and the offer.'],
};

function webOpenBlogPost(blog, siteBlogId) {
  const id = (blog && blog.site_id) || siteBlogId;
  if (!id || !blog || !blog.slug) return;
  location.hash = `#/blog?site=${encodeURIComponent(id)}&open=${encodeURIComponent(blog.slug)}`;
}

function webPaintPages(sec, data, ws) {
  const rows = data.rows || [];
  if (!rows.length) {
    sec.lead.textContent = 'This shows which pages people read, and which ones to improve.';
    sec.body.appendChild(webEmpty('No page numbers yet. They appear after the first sync of a site that has traffic.'));
    return;
  }
  const hasLeads = data.source === 'ga4';
  const multi = new Set(rows.map((r) => r.site_id)).size > 1;
  const tagged = rows.filter((r) => (r.tags || []).includes('refresh')).length;
  sec.lead.textContent = tagged
    ? `${webPlural(tagged, 'page')} could use a refresh. They sit on page 2 of Google, where a rewrite pays back fastest.`
    : 'Your most visited pages, with what changed since the previous period.';
  const LIMIT = 10;
  const tbody = el('tbody');
  const build = (count) => {
    tbody.innerHTML = '';
    for (const r of rows.slice(0, count)) {
      const title = r.blog && r.blog.title ? r.blog.title : r.path;
      const actions = [];
      if (r.blog && (r.tags || []).includes('refresh')) {
        actions.push(el('button', { class: 'button secondary sm', type: 'button', onclick: () => webOpenBlogPost(r.blog) }, 'Refresh post'));
      } else if (r.blog) {
        actions.push(el('button', { class: 'button ghost sm', type: 'button', onclick: () => webOpenBlogPost(r.blog) }, 'Open in Blog'));
      }
      tbody.appendChild(el('tr', { class: 'web-row' }, [
        el('th', { scope: 'row', class: 'web-page-cell' }, [
          el('a', { class: 'web-page-title', href: r.url || `https://${r.domain}${r.path}`, target: '_blank', rel: 'noopener noreferrer', title: r.path }, title),
          el('span', { class: 'web-sub' }, `${multi ? `${r.domain}` : ''}${multi && r.blog ? ', ' : ''}${r.blog ? r.path : ''}`),
          (r.tags || []).length ? el('span', { class: 'web-tags' }, r.tags.filter((t) => WEB_TAG_INFO[t]).map((t) => el('span', { class: `web-tag web-tag--${WEB_TAG_INFO[t][1]}`, title: WEB_TAG_INFO[t][2] }, WEB_TAG_INFO[t][0]))) : null,
        ]),
        el('td', { class: 'num', 'data-label': 'Views' }, [webNum(r.views), webDeltaNode(r.views, r.views_prev)]),
        el('td', { class: 'num', 'data-label': 'Search clicks' }, r.search_clicks == null ? el('span', { class: 'web-muted' }, '-') : webNum(r.search_clicks)),
        el('td', { class: 'num', 'data-label': 'Position' }, r.position == null ? el('span', { class: 'web-muted' }, '-') : Number(r.position).toFixed(1)),
        el('td', { class: 'num', 'data-label': 'Leads' }, hasLeads ? webNum(r.leads) : el('span', { class: 'web-muted', title: 'Needs Google Analytics' }, '-')),
        el('td', { class: 'web-actions-cell' }, actions),
      ]));
    }
  };
  build(LIMIT);
  const table = el('table', { class: 'web-table web-pages' }, [
    el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col' }, 'Page'), el('th', { scope: 'col', class: 'num' }, 'Views'), el('th', { scope: 'col', class: 'num' }, 'Search clicks'),
      el('th', { scope: 'col', class: 'num' }, 'Position'), el('th', { scope: 'col', class: 'num' }, 'Leads'), el('th', { scope: 'col' }, el('span', { class: 'web-sr' }, 'Actions')),
    ])),
    tbody,
  ]);
  sec.body.appendChild(el('div', { class: 'web-table-wrap' }, table));
  if (rows.length > LIMIT) {
    let open = false;
    const more = el('button', { class: 'button ghost sm', type: 'button' }, `Show all ${rows.length} pages`);
    more.onclick = () => { open = !open; build(open ? rows.length : LIMIT); more.textContent = open ? 'Show fewer pages' : `Show all ${rows.length} pages`; };
    sec.body.appendChild(more);
  }
  sec.body.appendChild(el('p', { class: 'web-foot' }, `Rising and falling compare with the previous period. Refresh candidate means the page ranks 8 to 20 on Google.${hasLeads ? ' No leads means plenty of views but no form submissions.' : ' Lead counts per page need Google Analytics.'}`));
}

// ---------------- search ----------------

function webBlogIdForSite(ws, siteId) {
  const s = (ws.sites || []).find((x) => String(x.id) === String(siteId));
  return s ? s.blog_site_id : null;
}

function webWritePost(blogSiteId, query) {
  location.hash = `#/blog?site=${encodeURIComponent(blogSiteId)}&new=1&keyword=${encodeURIComponent(query)}`;
}

function webPaintSearch(sec, data, ws) {
  if (!data || data.connected === false) {
    sec.lead.textContent = 'This shows the Google searches that find you, and the ones where a better post could win.';
    sec.body.appendChild(webEmpty('Connect Google in Settings > Websites to see search queries.', '#/settings/websites', 'Open Website settings'));
    return;
  }
  const striking = data.striking || [];
  const queries = data.queries || [];
  if (!striking.length && !queries.length) {
    sec.lead.textContent = 'This shows the Google searches that find you, and the ones where a better post could win.';
    sec.body.appendChild(webEmpty('Google is connected, but Search Console has no queries for this range yet. It reports a few days late, so check back soon.'));
    return;
  }
  sec.lead.textContent = striking.length
    ? `${webPlural(striking.length, 'search')} where you show up on page 1 or 2 of Google but get few clicks. A new or better post can move them up.`
    : 'No searches are close to page one right now. Here is what already brings clicks.';
  if (striking.length) {
    sec.body.appendChild(el('h3', { class: 'web-h3' }, 'Close to page one'));
    const strikingRow = (r) => {
      const blogId = r.blog && r.blog.site_id ? r.blog.site_id : webBlogIdForSite(ws, r.site_id);
      let action;
      if (r.blog) action = el('button', { class: 'button secondary sm', type: 'button', onclick: () => webOpenBlogPost(r.blog, blogId) }, 'Refresh post');
      else if (blogId) action = el('button', { class: 'button secondary sm', type: 'button', onclick: () => webWritePost(blogId, r.query) }, 'Write a post');
      else action = el('span', { class: 'web-muted' }, 'No blog on this site');
      return el('tr', { class: 'web-row' }, [
        el('th', { scope: 'row', class: 'web-page-cell' }, [el('span', { class: 'web-page-title' }, r.query), r.path ? el('span', { class: 'web-sub' }, r.path) : null]),
        el('td', { class: 'num', 'data-label': 'Position' }, Number(r.position).toFixed(1)),
        el('td', { class: 'num', 'data-label': 'Shown' }, webNum(r.impressions)),
        el('td', { class: 'num', 'data-label': 'Clicks' }, webNum(r.clicks)),
        el('td', { class: 'web-actions-cell' }, action),
      ]);
    };
    const SLIM = 8;
    const tbody = el('tbody');
    const buildStriking = (count) => { tbody.innerHTML = ''; striking.slice(0, count).forEach((r) => tbody.appendChild(strikingRow(r))); };
    buildStriking(SLIM);
    sec.body.appendChild(el('div', { class: 'web-table-wrap' }, el('table', { class: 'web-table web-search' }, [
      el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, 'Search'), el('th', { scope: 'col', class: 'num' }, 'Position'), el('th', { scope: 'col', class: 'num' }, 'Shown'), el('th', { scope: 'col', class: 'num' }, 'Clicks'), el('th', { scope: 'col' }, el('span', { class: 'web-sr' }, 'Action'))])),
      tbody,
    ])));
    if (striking.length > SLIM) {
      let open = false;
      const more = el('button', { class: 'button ghost sm', type: 'button' }, `Show all ${striking.length}`);
      more.onclick = () => { open = !open; buildStriking(open ? striking.length : SLIM); more.textContent = open ? 'Show fewer' : `Show all ${striking.length}`; };
      sec.body.appendChild(more);
    }
  }
  if (queries.length) {
    const wrap = el('details', { class: 'web-details' }, [
      el('summary', {}, `Top searches (${queries.length})`),
      el('div', { class: 'web-table-wrap' }, el('table', { class: 'web-table web-search' }, [
        el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, 'Search'), el('th', { scope: 'col', class: 'num' }, 'Clicks'), el('th', { scope: 'col', class: 'num' }, 'Shown'), el('th', { scope: 'col', class: 'num' }, 'Click rate'), el('th', { scope: 'col', class: 'num' }, 'Position')])),
        el('tbody', {}, queries.slice(0, 25).map((q) => el('tr', { class: 'web-row' }, [
          el('th', { scope: 'row', class: 'web-page-cell' }, el('span', { class: 'web-page-title' }, q.query)),
          el('td', { class: 'num', 'data-label': 'Clicks' }, webNum(q.clicks)),
          el('td', { class: 'num', 'data-label': 'Shown' }, webNum(q.impressions)),
          el('td', { class: 'num', 'data-label': 'Click rate' }, q.ctr == null ? '-' : `${(q.ctr <= 1 ? q.ctr * 100 : q.ctr).toFixed(1)}%`),
          el('td', { class: 'num', 'data-label': 'Position' }, q.position == null ? '-' : Number(q.position).toFixed(1)),
        ]))),
      ])),
    ]);
    if (!striking.length) wrap.open = true;
    sec.body.appendChild(wrap);
  }
}

// ---------------- social to site ----------------

function webPaintSocial(sec, data) {
  const utm = data.utm || [];
  const platforms = (data.platforms || []).filter((p) => Number(p.sessions) > 0 || Number(p.leads) > 0).sort((a, b) => b.sessions - a.sessions);
  const posts = data.posts || [];
  const off = utm.filter((u) => !u.enabled);
  const offNote = off.length
    ? el('p', { class: 'web-foot' }, [`Link tagging is off for ${off.map((u) => u.brand_name).join(', ')}. Without it, visits from those posts show up as Direct. `, el('a', { class: 'web-link', href: '#/settings/websites' }, 'Turn it on in Website settings')])
    : null;
  if (!platforms.length && !posts.length) {
    sec.lead.textContent = 'This shows how many visits and leads each social post sent to your sites.';
    if (utm.length && utm.every((u) => !u.enabled)) sec.body.appendChild(webEmpty('Link tagging is off, so visits from your posts cannot be counted. Turn it on and PostDeck tags each link when you approve a post.', '#/settings/websites', 'Open Website settings'));
    else sec.body.appendChild(webEmpty('No visits from tagged post links in this range yet. Links are tagged when you approve a post that links to one of your sites.'));
    if (offNote && utm.some((u) => u.enabled)) sec.body.appendChild(offNote);
    return;
  }
  const best = platforms[0];
  sec.lead.textContent = best ? `${webPlatformLabel(best.platform)} sent ${webPlural(best.sessions, 'visit')} and ${webPlural(best.leads, 'lead')} in this range.` : '';
  if (platforms.length) {
    sec.body.appendChild(el('ul', { class: 'web-plat' }, platforms.map((p) => el('li', { class: 'web-plat-item' }, [
      el('span', { class: 'web-plat-name' }, [webPlatformIcon(p.platform, 15), ` ${webPlatformLabel(p.platform)}`]),
      el('span', { class: 'web-plat-num' }, `${webPlural(p.sessions, 'visit')}, ${webPlural(p.leads, 'lead')}`),
    ]))));
  }
  if (posts.length) {
    sec.body.appendChild(el('h3', { class: 'web-h3' }, 'Posts that sent visitors'));
    sec.body.appendChild(el('ul', { class: 'web-posts' }, posts.slice(0, 15).map((p) => {
      const btn = el('button', { class: 'web-post-row', type: 'button', 'aria-label': `Open post: ${p.snippet || 'Untitled'}` }, [
        el('span', { class: 'web-post-ico' }, webPlatformIcon(p.platform, 15)),
        el('span', { class: 'web-post-main' }, [
          el('span', { class: 'web-post-snippet' }, p.snippet || '(no copy)'),
          el('span', { class: 'web-sub' }, `${p.brand_name || brandName(p.brand_id)}${p.published_at ? `, ${fmtDate(p.published_at)}` : ''}`),
        ]),
        el('span', { class: 'num web-post-num' }, webPlural(p.sessions, 'visit')),
        el('span', { class: 'num web-post-num' }, webPlural(p.leads, 'lead')),
      ]);
      btn.addEventListener('click', () => { if (typeof openPostById === 'function') openPostById(p.post_id); });
      return el('li', {}, btn);
    })));
  }
  if (offNote) sec.body.appendChild(offNote);
}

// ---------------- site health ----------------

function webPaintHealth(sec, data) {
  const nf = data.not_found || [];
  const bots = data.bots || [];
  const forms = data.forms || [];
  const checks = data.lead_check || [];
  if (!nf.length && !bots.length && !forms.length && !checks.length) {
    sec.lead.textContent = 'This watches for broken links, bots and forms that stopped working.';
    sec.body.appendChild(webEmpty('Nothing to show yet. Missing pages, bots and form results come from the server logs after the first log sync.', '#/settings/websites', 'Check the server connection'));
    return;
  }
  sec.lead.textContent = nf.length
    ? `${webPlural(nf.length, 'page')} that visitors asked for but your site could not find. A redirect keeps those visitors.`
    : 'No missing pages found in this range.';
  const blocks = [];
  if (nf.length) {
    blocks.push(el('div', {}, [
      el('h3', { class: 'web-h3' }, 'Pages that were not found'),
      el('div', { class: 'web-table-wrap' }, el('table', { class: 'web-table web-health' }, [
        el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, 'Page'), el('th', { scope: 'col', class: 'num' }, 'Tries'), el('th', { scope: 'col' }, el('span', { class: 'web-sr' }, 'Action'))])),
        el('tbody', {}, nf.slice(0, 12).map((r) => el('tr', { class: 'web-row' }, [
          el('th', { scope: 'row', class: 'web-page-cell' }, [el('span', { class: 'web-page-title' }, r.path), el('span', { class: 'web-sub' }, r.domain)]),
          el('td', { class: 'num', 'data-label': 'Tries' }, webNum(r.hits)),
          el('td', { class: 'web-actions-cell' }, r.redirect_line ? el('button', { class: 'button secondary sm', type: 'button', onclick: () => webCopyText(r.redirect_line, 'Redirect line copied. Change the target, then add it to the site redirect file.') }, 'Copy redirect line') : null),
        ]))),
      ])),
    ]));
  }
  if (bots.length) {
    const sb = bots.reduce((a, b) => a + (Number(b.search_bot_hits) || 0), 0);
    const ab = bots.reduce((a, b) => a + (Number(b.ai_bot_hits) || 0), 0);
    blocks.push(el('div', {}, [
      el('h3', { class: 'web-h3' }, 'Bots'),
      el('p', { class: 'web-p' }, `Search engine bots visited ${webPlural(sb, 'time')} and AI bots ${webPlural(ab, 'time')}. They are left out of your visitor counts.`),
      el('ul', { class: 'web-kv' }, bots.map((b) => el('li', {}, [el('span', {}, b.domain), el('span', { class: 'num' }, `${webNum(b.search_bot_hits)} search, ${webNum(b.ai_bot_hits)} AI`)]))),
    ]));
  }
  if (forms.length) {
    blocks.push(el('div', {}, [
      el('h3', { class: 'web-h3' }, 'Form submissions'),
      el('div', { class: 'web-table-wrap' }, el('table', { class: 'web-table web-health' }, [
        el('thead', {}, el('tr', {}, [el('th', { scope: 'col' }, 'Site'), ...['Delivered', 'Tagged', 'Blocked', 'Spam trap', 'Invalid'].map((h) => el('th', { scope: 'col', class: 'num' }, h))])),
        el('tbody', {}, forms.map((f) => el('tr', { class: 'web-row' }, [
          el('th', { scope: 'row', class: 'web-page-cell' }, el('span', { class: 'web-page-title' }, f.domain)),
          ...[['Delivered', f.delivered], ['Tagged', f.tagged], ['Blocked', f.blocked], ['Spam trap', f.honeypot], ['Invalid', f.invalid]].map(([l, v]) => el('td', { class: 'num', 'data-label': l }, webNum(v))),
        ]))),
      ])),
    ]));
  }
  if (checks.length) {
    blocks.push(el('div', {}, [
      el('h3', { class: 'web-h3' }, 'Do the lead counts agree?'),
      el('ul', { class: 'web-checks' }, checks.map((c) => el('li', {}, [el('strong', {}, c.domain), ` ${c.text || `Google Analytics counted ${webNum(c.ga4_leads)} leads and the form relay delivered ${webNum(c.relay_delivered)}.`}`]))),
    ]));
  }
  blocks.forEach((b) => sec.body.appendChild(b));
}

// ================= Settings > Websites =================

async function webSettingsTab(body) {
  const [status, sitesRes, brands] = await Promise.all([
    webApi('/api/web/status'),
    webApi('/api/web/sites'),
    webApi('/api/brands').catch(() => state.brands),
  ]);
  const sites = (sitesRes && sitesRes.sites) || [];
  const self = (sitesRes && sitesRes.self) || { ips: [], optout_links: [] };
  const g = (status && status.google) || {};
  const ssh = (status && status.ssh) || {};
  const last = (status && status.last_sync) || {};
  const reload = () => { WEB_STATE.sites = null; refreshView(); };

  // ---- Google connection ----
  const pillTone = g.connected ? 'ok' : g.key_present ? 'bad' : 'neutral';
  const pillText = g.connected ? 'Connected' : g.key_present ? 'Key saved, not working' : 'Not connected';
  const keyArea = el('textarea', { rows: '6', 'aria-label': 'Service account key (JSON)', placeholder: 'Paste the contents of the key file here', spellcheck: 'false', autocomplete: 'off' });
  const fileInput = el('input', { type: 'file', accept: 'application/json,.json', 'aria-label': 'Choose the key file' });
  fileInput.addEventListener('change', () => {
    const f = fileInput.files && fileInput.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => { keyArea.value = String(reader.result || ''); };
    reader.onerror = () => toast('Could not read that file.', 'error');
    reader.readAsText(f);
  });
  const saveKey = el('button', { class: 'button primary md', type: 'button' }, g.key_present ? 'Replace key' : 'Save key');
  saveKey.onclick = async () => {
    const text = keyArea.value.trim();
    if (!text) { toast('Paste the key or choose the file first.', 'error'); keyArea.focus(); return; }
    saveKey.disabled = true;
    try {
      const res = await webApi('/api/web/google-key', { method: 'POST', body: { json: text } });
      keyArea.value = '';
      toast(`Key saved${res && res.client_email ? ` for ${res.client_email}` : ''}.`);
      reload();
    } catch (err) {
      toast(`Key not saved: ${err.message}`, 'error');
    } finally { saveKey.disabled = false; }
  };
  const googleKids = [
    el('div', { class: 'web-google-state' }, [el('span', { class: `status-pill status-pill--${pillTone}` }, pillText)]),
  ];
  if (g.error) googleKids.push(inlineBanner(g.error, 'warn'));
  if (g.client_email) {
    const emailInput = el('input', { type: 'text', readonly: 'readonly', value: g.client_email, 'aria-label': 'Service account email' });
    googleKids.push(stField('Service account email', el('div', { class: 'st-inline' }, [emailInput, el('button', { class: 'button secondary md', type: 'button', onclick: () => webCopyText(g.client_email, 'Email copied.') }, 'Copy')]),
      'Add this email as a Viewer on each Google Analytics property, and as a Restricted user on each Search Console property.'));
  }
  const keyForm = [stField(g.key_present ? 'Replace the key' : 'Service account key', keyArea, 'Download the JSON key from Google Cloud and paste it here, or choose the file. PostDeck stores it on this computer and never shows it again.'), el('div', { class: 'st-inline' }, [fileInput]), el('div', { class: 'st-actions' }, [saveKey])];
  if (g.key_present) {
    const disc = el('button', { class: 'button destructive md', type: 'button' }, 'Disconnect Google');
    disc.onclick = async () => {
      if (!(await confirmDialog({ title: 'Disconnect Google?', body: 'PostDeck deletes the stored key. Numbers already pulled stay, but search and Google Analytics stop updating until you add a key again.', confirmLabel: 'Disconnect', tone: 'destructive' }))) return;
      disc.disabled = true;
      try { await webApi('/api/web/google-key', { method: 'DELETE' }); toast('Google disconnected.'); reload(); } catch (err) { toast(`Could not disconnect: ${err.message}`, 'error'); disc.disabled = false; }
    };
    googleKids.push(el('details', { class: 'web-details' }, [el('summary', {}, 'Use a different key'), ...keyForm]), el('div', { class: 'st-actions' }, [disc]));
  } else {
    const steps = [
      'Go to console.cloud.google.com and create a project (any name, for example PostDeck).',
      'In APIs and services, enable "Google Analytics Data API", "Google Analytics Admin API" and "Google Search Console API".',
      'In IAM and admin > Service accounts, create a service account. It needs no roles.',
      'Open it, go to Keys > Add key > Create new key > JSON. A file downloads.',
      'Copy the service account email (it ends in iam.gserviceaccount.com).',
      'In Google Analytics, for each site: Admin > Property access management > add that email as Viewer.',
      'In Search Console, for each site: Settings > Users and permissions > add that email with Restricted access.',
      'Choose the downloaded file below and press Save key. PostDeck finds the right properties by itself.',
    ];
    googleKids.push(
      el('details', { class: 'web-details' }, [
        el('summary', {}, 'How to get the key (about 10 minutes, once)'),
        el('ol', { class: 'web-steps' }, steps.map((t) => el('li', {}, t))),
        el('p', { class: 'web-muted' }, 'The key can only read numbers. It cannot change your sites or your Google settings.'),
      ]),
      ...keyForm,
    );
  }
  body.appendChild(stSection('Google connection', 'Google Analytics and Search Console give PostDeck leads, search queries and exact visitor counts. Without them it counts visitors from your server logs.', googleKids));

  // ---- sync ----
  const syncAll = el('button', { class: 'button secondary md', type: 'button' }, 'Sync now');
  syncAll.onclick = () => webSyncNow(syncAll, {}, reload);
  const sshText = ssh.ok ? `Reading server logs from ${ssh.host || 'your server'}.` : `PostDeck cannot read the server logs. ${ssh.error || 'Check the SSH connection.'}`;
  const ago = (iso) => (iso ? webAgo(iso) : 'never');
  body.appendChild(stSection('Syncing', 'PostDeck pulls numbers on its own while it is open. Sync now forces it.', [
    el('p', { class: `web-p${ssh.ok ? '' : ' web-bad'}` }, sshText),
    el('p', { class: 'web-p web-muted' }, `Server logs ${ago(last.logs)}. Google Analytics ${ago(last.ga4)}. Search Console ${ago(last.gsc)}.`),
    el('div', { class: 'st-actions' }, [syncAll]),
  ]));

  // ---- sites ----
  const siteBlocks = sites.map((s) => webSiteSettingsBlock(s, brands, reload));
  body.appendChild(stSection('Sites', 'One row per website. Fill in the Google ids once and the checklist ticks itself off.', siteBlocks.length ? siteBlocks : [webEmpty('No sites found.')]));

  // ---- link tagging per brand ----
  const brandIds = [...new Set(sites.map((s) => s.brand_id).filter((v) => v != null))];
  const tagRows = [];
  for (const id of brandIds) {
    const b = (brands || []).find((x) => String(x.id) === String(id));
    if (!b) continue;
    const t = settingsToggleRow(Boolean(b.utm_enabled), `Tag links for ${b.name}`);
    t.cb.addEventListener('change', async () => {
      try {
        await webApi(`/api/brands/${b.id}`, { method: 'PATCH', body: { utm_enabled: t.cb.checked } });
        b.utm_enabled = t.cb.checked;
        toast(t.cb.checked ? `Links for ${b.name} are tagged when you approve a post.` : `Link tagging is off for ${b.name}.`);
      } catch (err) {
        t.cb.checked = !t.cb.checked;
        t.cb.dispatchEvent(new Event('change'));
        toast(`Not saved: ${err.message}`, 'error');
      }
    });
    tagRows.push(t.row);
  }
  body.appendChild(stSection('Tag links from posts', 'This is what lets the Analytics page say which post sent which visitors. Tags are added when you approve a post, so drafts stay clean. With it off, visits from social show up as Direct.',
    tagRows.length ? tagRows : [webEmpty('No brand has a site yet.')]));

  // ---- mark this browser ----
  const links = (self.optout_links || []).map((l) => el('li', { class: 'web-opt-row' }, [
    el('span', { class: 'web-opt-domain' }, l.domain),
    el('span', { class: 'web-opt-links' }, [
      el('a', { class: 'web-link', href: l.on_url, target: '_blank', rel: 'noopener noreferrer' }, 'Mark this browser as you'),
      el('a', { class: 'web-link web-link--quiet', href: l.off_url, target: '_blank', rel: 'noopener noreferrer' }, 'Undo'),
    ]),
  ]));
  const ipRows = (self.ips || []).map((p) => el('li', { class: 'web-opt-row' }, [
    el('span', {}, p.ip),
    el('span', { class: 'web-muted' }, `${webIpHow(p.how)}${p.last_seen ? `, last seen ${webAgo(p.last_seen) || p.last_seen}` : ''}`),
  ]));
  body.appendChild(stSection('Keep your own visits out', 'Open each link once in every browser and phone you use. The site then stops counting that browser. In the server logs, PostDeck also skips the addresses listed below.', [
    links.length ? el('ul', { class: 'web-opt' }, links) : webEmpty('No links yet. They appear once your sites are set up.'),
    el('h3', { class: 'st-h3 web-ip-h' }, 'Addresses PostDeck skips'),
    ipRows.length ? el('ul', { class: 'web-opt' }, ipRows) : el('p', { class: 'web-p web-muted' }, 'None recorded yet. PostDeck skips the address it connects from, and any address that opens the links above.'),
  ]));
}

function webIpHow(how) {
  if (how === 'ssh') return 'This computer';
  if (how === 'optout') return 'Opened a mark-as-you link';
  return how || 'Recorded';
}

async function webSyncNow(btn, body, onDone) {
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Syncing...';
  try {
    const res = await webApi('/api/web/sync', { method: 'POST', body });
    const bad = ((res && res.results) || []).filter((r) => r && r.ok === false);
    if (bad.length) toast(`Synced, but ${bad.length === 1 ? '1 source' : `${bad.length} sources`} failed: ${bad[0].error || 'unknown error'}`, 'warn');
    else toast('Synced.');
    if (onDone) onDone();
  } catch (err) {
    toast(`Could not sync: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function webSiteSettingsBlock(site, brands, reload) {
  const patch = (btn, body, msg) => stSave(btn, async () => {
    const updated = await webApi(`/api/web/sites/${site.id}`, { method: 'PATCH', body });
    if (updated && typeof updated === 'object') Object.assign(site, updated);
    WEB_STATE.sites = null;
  }, msg);

  const brandSel = el('select', { 'aria-label': `Brand for ${site.domain}` }, [
    el('option', { value: '' }, 'No brand'),
    ...(brands || []).map((b) => el('option', { value: String(b.id) }, b.name)),
  ]);
  brandSel.value = site.brand_id != null ? String(site.brand_id) : '';
  brandSel.addEventListener('change', () => patch(brandSel, { brand_id: brandSel.value ? Number(brandSel.value) : null }, `${site.domain} linked to ${brandSel.value ? brandName(brandSel.value) : 'no brand'}.`));

  const active = settingsToggleRow(site.active !== false && site.active !== 0, 'Count this site');
  active.cb.addEventListener('change', async () => {
    const ok = await patch(null, { active: active.cb.checked }, active.cb.checked ? `${site.domain} is counted again.` : `${site.domain} is left out.`);
    if (!ok) { active.cb.checked = !active.cb.checked; active.cb.dispatchEvent(new Event('change')); }
  });

  const ga4 = el('input', { type: 'text', inputmode: 'numeric', value: site.ga4_property_id || '', placeholder: 'Numbers only, for example 412345678', 'aria-label': `Google Analytics property for ${site.domain}` });
  const ga4Save = el('button', { class: 'button secondary md', type: 'button' }, 'Save');
  ga4Save.onclick = () => patch(ga4Save, { ga4_property_id: ga4.value.trim() || null }, 'Google Analytics property saved.').then((ok) => { if (ok) reload(); });
  const gsc = el('input', { type: 'text', value: site.gsc_property || '', placeholder: `sc-domain:${site.domain}`, 'aria-label': `Search Console property for ${site.domain}` });
  const gscSave = el('button', { class: 'button secondary md', type: 'button' }, 'Save');
  gscSave.onclick = () => patch(gscSave, { gsc_property: gsc.value.trim() || null }, 'Search Console property saved.').then((ok) => { if (ok) reload(); });

  const sync = el('button', { class: 'button ghost sm', type: 'button' }, 'Sync now');
  sync.onclick = () => webSyncNow(sync, { site_id: site.id }, reload);

  const checklist = (site.checklist || []).map((c) => el('li', { class: `web-check${c.done ? ' is-done' : ''}` }, [
    el('span', { class: 'web-check-mark', 'aria-hidden': 'true' }, c.done ? webIcon('check', 14) : webIcon('dot', 14)),
    el('span', {}, [el('span', { class: 'web-sr' }, c.done ? 'Done: ' : 'To do: '), c.text]),
  ]));
  const synced = site.last_sync_at ? `Last synced ${webAgo(site.last_sync_at)}.` : 'Not synced yet.';

  return el('div', { class: 'web-site-set' }, [
    el('div', { class: 'web-site-head' }, [
      el('h3', { class: 'st-h3' }, site.domain),
      el('span', { class: 'web-muted' }, site.ga4_measurement_id ? `Tag ${site.ga4_measurement_id}` : 'No Google tag on the site'),
    ]),
    el('div', { class: 'web-site-grid' }, [
      stField('Brand', brandSel),
      stField('Google Analytics property', el('div', { class: 'st-inline' }, [ga4, ga4Save]), 'The numeric property id, not the G- tag.'),
      stField('Search Console property', el('div', { class: 'st-inline' }, [gsc, gscSave])),
      el('div', {}, [active.row]),
    ]),
    site.last_sync_error ? inlineBanner(`The last sync failed: ${site.last_sync_error}`, 'warn') : null,
    checklist.length ? el('ul', { class: 'web-checklist', 'aria-label': `Setup steps for ${site.domain}` }, checklist) : null,
    el('div', { class: 'web-site-foot' }, [el('span', { class: 'web-muted' }, synced), sync]),
  ]);
}

// ================= hooks for other views =================

// ---- Home: "This week" line and alerts (50-home.js) ----
async function webHomeData() {
  if (WEB_STATE.home && Date.now() - WEB_STATE.homeAt < 30000) return WEB_STATE.home;
  const d = await webApi('/api/web/home');
  WEB_STATE.home = d;
  WEB_STATE.homeAt = Date.now();
  return d;
}

async function webHomeRows(needsHost, analyticsHost) {
  try {
    const tok = String(++WEB_STATE.tok);
    needsHost.dataset.webTok = tok;
    let data;
    try { data = await webHomeData(); } catch { return; }
    if (!data || needsHost.dataset.webTok !== tok || !needsHost.isConnected) return;
    needsHost.querySelectorAll('[data-web-rows]').forEach((n) => n.remove());
    analyticsHost.querySelectorAll('[data-web-rows]').forEach((n) => n.remove());
    if (data.line) {
      analyticsHost.insertBefore(el('a', { class: 'home-link web-home-line', 'data-web-rows': '1', href: '#/analytics' }, data.line), analyticsHost.firstChild);
    }
    const alerts = Array.isArray(data.alerts) ? data.alerts : [];
    if (!alerts.length) return;
    let list = needsHost.querySelector('.home-list');
    if (!list) {
      list = el('div', { class: 'home-list' });
      needsHost.appendChild(el('section', { class: 'home-section' }, [el('h2', { class: 'home-h2' }, 'Needs you'), list]));
    }
    alerts.forEach((a, i) => {
      const warn = a.level === 'warn';
      const row = el('div', { class: 'home-row home-row--attention', 'data-web-rows': '1' }, [
        el('div', { class: 'home-row-main' }, el('div', { class: 'home-row-reason' }, [
          el('span', { class: `status-pill ${warn ? 'web-pill--warn' : 'status-pill--info'}` }, 'Website'),
          el('span', {}, a.text),
        ])),
        el('a', { class: `button ${warn ? 'primary' : 'secondary'} sm`, href: a.href || '#/analytics' }, 'Open'),
      ]);
      list.insertBefore(row, list.children[i] || null);
    });
  } catch (err) {
    console.warn('[web home]', err);
  }
}

// ---- Blog: open the editor from a link, and show 28-day numbers on published rows (70-blog.js) ----
// #/blog?site=<id>&new=1&keyword=<q>  opens the new-post editor with the keyword filled in.
// #/blog?site=<id>&open=<slug>         opens that post.
function webBlogMaybeOpen(siteId, reload) {
  try {
    const q = routeQuery();
    if (q.new !== '1' && !q.open) return;
    history.replaceState(null, '', `#/blog/${encodeURIComponent(siteId)}`);
    setTimeout(() => {
      if (typeof openBlogEditor !== 'function') return;
      if (q.open) openBlogEditor(siteId, q.open, { onChange: reload });
      else openBlogEditor(siteId, null, { onChange: reload, prefill: q.keyword ? { primary_keyword: q.keyword } : null });
    }, 0);
  } catch (err) {
    console.warn('[web blog open]', err);
  }
}

async function webBlogStats(site, view) {
  try {
    const res = await webApi(`/api/web/blog-stats${webQS({ blog_site_id: site.id, range: 28 })}`);
    const posts = res && res.posts;
    if (!posts) return;
    const section = [...view.querySelectorAll('details.bl-section')].find((d) => d.querySelector('.bl-h2') && d.querySelector('.bl-h2').textContent === 'Published');
    if (!section) return;
    const list = section.querySelector('.bl-list');
    if (!list) return;
    const rows = [...list.querySelectorAll('.bl-row[data-slug]')];
    let any = false;
    rows.forEach((row, i) => {
      row.dataset.webOrder = String(i);
      const st = posts[row.getAttribute('data-slug')];
      if (!st) return;
      any = true;
      row.dataset.webViews = String(st.views || 0);
      row.dataset.webClicks = String(st.search_clicks || 0);
      row.dataset.webPos = st.position == null ? '999' : String(st.position);
      const meta = row.querySelector('.bl-row-meta');
      if (!meta) return;
      meta.appendChild(el('span', { class: 'web-bl-stat', title: 'Visits in the last 28 days' }, webPlural(st.views || 0, 'view')));
      meta.appendChild(el('span', { class: 'web-bl-stat', title: 'Clicks from Google in the last 28 days' }, webPlural(st.search_clicks || 0, 'search click')));
      if (st.position != null) meta.appendChild(el('span', { class: 'web-bl-stat', title: 'Average Google position' }, `position ${Number(st.position).toFixed(1)}`));
    });
    if (!any || rows.length < 2) return;
    const sel = el('select', { class: 'sm', 'aria-label': 'Sort published posts' }, [
      el('option', { value: 'new' }, 'Newest first'),
      el('option', { value: 'views' }, 'Most views, last 28 days'),
      el('option', { value: 'clicks' }, 'Most search clicks'),
      el('option', { value: 'pos' }, 'Best Google position'),
    ]);
    sel.addEventListener('change', () => {
      const v = sel.value;
      const key = (r) => (v === 'views' ? -Number(r.dataset.webViews || 0) : v === 'clicks' ? -Number(r.dataset.webClicks || 0) : v === 'pos' ? Number(r.dataset.webPos || 999) : Number(r.dataset.webOrder));
      [...rows].sort((a, b) => key(a) - key(b) || Number(a.dataset.webOrder) - Number(b.dataset.webOrder)).forEach((r) => list.appendChild(r));
    });
    list.parentNode.insertBefore(el('div', { class: 'web-bl-sort' }, [el('label', { class: 'web-muted' }, 'Sort '), sel]), list);
  } catch (err) {
    console.warn('[web blog stats]', err);
  }
}

// ---- Post drawer: "Sent N visits, M leads" for a published post (31-post-drawer.js) ----
function webPostLine(host, postId) {
  try {
    const line = el('div', { class: 'web-post-line', hidden: 'hidden' });
    host.appendChild(line);
    webApi(`/api/web/post/${postId}`).then((res) => {
      if (!res || res.sessions == null || !line.isConnected) return;
      line.hidden = false;
      line.textContent = `Sent ${webPlural(res.sessions, 'visit')} and ${webPlural(res.leads || 0, 'lead')} to your site.`;
    }).catch(() => {});
  } catch (err) {
    console.warn('[web post line]', err);
  }
}

// ---- Planner: "Traffic" toggle tints each day by visitors (30-planner.js) ----
function webPlannerEnabled() { return webSafeGet(WEB_PLANNER_KEY) === 'on'; }

function webPlannerLoad(brandId, redraw) {
  const pl = WEB_STATE.planner;
  if (pl.loading || pl.failed) return;
  if (pl.map && pl.brand === String(brandId || '')) return;
  pl.loading = true;
  const end = new Date();
  const start = new Date(Date.now() - 180 * 86400000);
  const key = (d) => (typeof dateKeyLocal === 'function' ? dateKeyLocal(d) : d.toISOString().slice(0, 10));
  webApi(`/api/web/daily${webQS({ brand_id: brandId, start: key(start), end: key(end) })}`).then((res) => {
    const map = new Map();
    let max = 0;
    for (const d of (res && res.days) || []) { map.set(d.date, Number(d.visitors) || 0); if (Number(d.visitors) > max) max = Number(d.visitors); }
    pl.map = map; pl.max = max; pl.brand = String(brandId || '');
  }).catch(() => { pl.failed = true; }).finally(() => { pl.loading = false; if (typeof redraw === 'function') redraw(); });
}

function webPlannerFilterButton(brandId, redraw) {
  try {
    const pl = WEB_STATE.planner;
    if (pl.failed) return null;
    const on = webPlannerEnabled();
    if (on) webPlannerLoad(brandId, redraw);
    return el('button', {
      class: `pl-filter${on ? ' is-active' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false',
      title: 'Tint each day by how many visitors your sites had',
      onclick: () => { webSafeSet(WEB_PLANNER_KEY, on ? 'off' : 'on'); redraw(); },
    }, 'Traffic');
  } catch { return null; }
}

function webPlannerTint(cell, dayKey, brandId, compact) {
  try {
    const pl = WEB_STATE.planner;
    if (!webPlannerEnabled() || !pl.map || pl.brand !== String(brandId || '') || !pl.map.has(dayKey)) return;
    const v = pl.map.get(dayKey);
    const pct = pl.max ? 6 + Math.round(30 * (v / pl.max)) : 6;
    cell.classList.add('web-tinted');
    cell.style.setProperty('--web-tint', `${pct}%`);
    const head = cell.querySelector('.pl-day-head');
    if (head) head.appendChild(el('span', { class: 'web-day-visits', title: `${webPlural(v, 'visitor')} on this day` }, compact ? webCompact(v) : webPlural(v, 'visitor')));
  } catch { /* the Planner must never break because of this layer */ }
}
