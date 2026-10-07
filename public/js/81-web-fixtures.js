// js/81-web-fixtures.js - DEV ONLY. Canned /api/web/* responses for visual QA.
// Not listed in index.html. 80-web.js loads it on demand when localStorage.pd_web_fixture === '1'.
// Everything lives inside one function scope; the only global it adds is webFixtureHandle.
(function webFixtureModule() {
  const DAY = 86400000;
  const pad = (n) => String(n).padStart(2, '0');
  const dk = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const TODAY = startOfDay(new Date());
  const daysAgo = (n) => new Date(TODAY.getTime() - n * DAY);
  const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

  function rng(seed) {
    let s = seed >>> 0;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }
  function hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

  // ---- brands and sites ----
  const brandDefs = [
    { key: 'cholmesiv', name: 'CHolmesIV', re: /cholmes/i, fallback: 9001 },
    { key: 'dihy', name: 'Di-Hy', re: /di-?hy/i, fallback: 9002 },
    { key: 'lunula', name: 'Lunula', re: /lunula/i, fallback: 9003 },
    { key: 'ivision', name: 'IVision', re: /ivision/i, fallback: 9004 },
  ];
  const brands = brandDefs.map((b) => {
    const real = (typeof state !== 'undefined' && state.brands || []).find((x) => b.re.test(x.name));
    return { id: real ? real.id : b.fallback, name: real ? real.name : b.name, utm_enabled: b.key === 'cholmesiv' || b.key === 'dihy' };
  });
  const sites = [
    { id: 1, domain: 'cholmesiv.com', brand: 0, blog_site_id: 'cholmesiv', ga4_measurement_id: 'G-97XJH8721S', ga4_property_id: '412345678', gsc_property: 'sc-domain:cholmesiv.com', source: 'ga4', base: 62, growth: 0.9, lead: 0.022, active: true },
    { id: 2, domain: 'di-hy.com', brand: 1, blog_site_id: 'di-hy', ga4_measurement_id: 'G-957QEJY8VC', ga4_property_id: '498765432', gsc_property: 'sc-domain:di-hy.com', source: 'ga4', base: 175, growth: 0.5, lead: 0.018, active: true },
    { id: 3, domain: 'lunulasupply.com', brand: 2, blog_site_id: 'lunula-supply', ga4_measurement_id: 'G-5GVQC5FMF0', ga4_property_id: null, gsc_property: null, source: 'logs', base: 34, growth: -0.2, lead: 0.01, active: true },
    { id: 4, domain: 'ivisionbuild.com', brand: 3, blog_site_id: null, ga4_measurement_id: null, ga4_property_id: null, gsc_property: null, source: 'none', base: 0, growth: 0, lead: 0, active: true },
  ];
  const fx = { googleConnected: true, clientEmail: 'postdeck-reader@postdeck-analytics.iam.gserviceaccount.com', keyPresent: true, utm: {} };
  brands.forEach((b) => { fx.utm[b.id] = b.utm_enabled; });

  // ---- 800 days of daily numbers per site ----
  const blogDays = { 1: [2, 9, 16, 23, 31, 44, 60], 2: [4, 11, 25, 39, 53], 3: [14, 48] };
  const socialDays = { 1: [1, 3, 5, 8, 12, 15, 19, 22, 26], 2: [2, 6, 10, 13, 20, 27], 3: [7, 21] };
  const DAYS = {};
  for (const s of sites) {
    const r = rng(hash(s.domain));
    const arr = [];
    for (let i = 799; i >= 0; i -= 1) {
      const d = daysAgo(i === 0 ? 0 : i);
      if (s.source === 'none') { arr.push({ date: dk(d), visitors: 0, leads: 0, pageviews: 0 }); continue; }
      const dow = d.getDay();
      const weekly = dow === 0 || dow === 6 ? 0.62 : 1;
      const trend = 1 + (s.growth * (800 - i)) / 800;
      let v = s.base * weekly * trend * (0.8 + r() * 0.4);
      for (const b of blogDays[s.id] || []) { const age = b - i; if (age >= 0 && age < 6) v += s.base * 0.7 * Math.pow(0.6, age); }
      for (const so of socialDays[s.id] || []) { if (i === so) v += s.base * 0.25; }
      v = Math.max(0, Math.round(v));
      const leads = r() < Math.min(0.9, v * s.lead * 0.04) ? 1 + (r() < 0.2 ? 1 : 0) : 0;
      arr.push({ date: dk(d), visitors: i === 0 && s.source === 'ga4' ? 0 : v, leads: i === 0 && s.source === 'ga4' ? 0 : leads, pageviews: Math.round(v * (1.6 + r() * 0.5)) });
    }
    DAYS[s.id] = arr;
  }
  const lastDay = (s) => (s.source === 'ga4' ? 1 : 0);
  function windowOf(range) {
    // GA4 sites end yesterday, logs sites end today; the fixture uses yesterday for all, like the contract's common case.
    return { days: range, start: dk(daysAgo(range)), end: dk(daysAgo(1)), prev_start: dk(daysAgo(range * 2)), prev_end: dk(daysAgo(range + 1)) };
  }
  function sumRange(siteId, fromAgo, toAgo, key) {
    // inclusive, days-ago indexes (fromAgo >= toAgo)
    const arr = DAYS[siteId];
    let t = 0;
    for (let a = fromAgo; a >= toAgo; a -= 1) t += arr[799 - a][key] || 0;
    return t;
  }
  function includedSites(q) {
    const bid = q.get('brand_id');
    const sid = q.get('site_id');
    return sites.filter((s) => (!sid || String(s.id) === sid) && (!bid || String(brands[s.brand].id) === bid));
  }
  function brandOf(s) { return brands[s.brand]; }

  // ---- overview ----
  function overview(q) {
    const range = Number(q.get('range')) || 28;
    const inc = includedSites(q);
    const win = windowOf(range);
    const out = inc.map((s) => {
      const has = s.source !== 'none';
      const vis = has ? sumRange(s.id, range, 1, 'visitors') : 0;
      const visP = has ? sumRange(s.id, range * 2 - 0, range + 1, 'visitors') : 0;
      const leads = has ? sumRange(s.id, range, 1, 'leads') : 0;
      const leadsP = has ? sumRange(s.id, range * 2, range + 1, 'leads') : 0;
      const gsc = s.source === 'ga4';
      const clicks = gsc ? Math.round(vis * 0.31) : null;
      const clicksP = gsc ? Math.round(visP * 0.27) : null;
      return {
        id: s.id, domain: s.domain, brand_id: brandOf(s).id, brand_name: brandOf(s).name, source: s.source,
        visitors: vis, visitors_prev: visP, pageviews: has ? sumRange(s.id, range, 1, 'pageviews') : 0, leads, leads_prev: leadsP,
        lead_rate: vis ? leads / vis : 0, search_clicks: clicks, search_clicks_prev: clicksP, avg_position: gsc ? 11.4 : null,
        spark: has ? DAYS[s.id].slice(-29, -1).map((d) => ({ date: d.date, visitors: d.visitors })) : [],
        last_sync_at: iso(s.source === 'ga4' ? 190 : 22), error: null,
      };
    });
    const sum = (k) => out.reduce((a, s) => a + (s[k] || 0), 0);
    const trendDays = [];
    for (let a = range; a >= 1; a -= 1) {
      let v = 0; let l = 0;
      for (const s of inc) { if (s.source === 'none') continue; v += DAYS[s.id][799 - a].visitors; l += DAYS[s.id][799 - a].leads; }
      trendDays.push({ date: dk(daysAgo(a)), visitors: v, leads: l });
    }
    const markers = [];
    for (const s of inc) {
      for (const b of blogDays[s.id] || []) if (b >= 1 && b <= range) markers.push({ date: dk(daysAgo(b)), kind: 'blog', title: blogTitle(s, b), href: `#/blog/${s.blog_site_id}` });
      for (const so of socialDays[s.id] || []) if (so >= 1 && so <= range) {
        const platform = ['linkedin', 'facebook', 'instagram'][(so + s.id) % 3];
        markers.push({ date: dk(daysAgo(so)), kind: 'social', platform, title: socialSnippet(s, so), href: `#/post/${100 + so + s.id}` });
      }
      // a second social post on the same day as a blog post, to exercise grouped markers
      const first = (blogDays[s.id] || [])[0];
      if (first && first <= range) markers.push({ date: dk(daysAgo(first)), kind: 'social', platform: 'linkedin', title: `Shared: ${blogTitle(s, first)}`, href: `#/post/${200 + s.id}` });
    }
    markers.sort((a, b) => a.date.localeCompare(b.date));
    const read = [
      { level: 'warn', text: 'ivisionbuild.com has no tracking, so PostDeck cannot count its visitors yet.', site_id: 4 },
      { level: 'warn', text: 'lunulasupply.com reported 0 visits for 2 days. Tracking may be broken.', site_id: 3 },
      { level: 'good', text: `Di-Hy: ${out.find((s) => s.id === 2) ? out.find((s) => s.id === 2).visitors.toLocaleString() : 0} visitors in this range. Google search brought 41% of them.` },
      { level: 'info', text: '3 leads this week: 2 from blog posts, 1 from the contact page.' },
      { level: 'info', text: 'Your Tuesday blog post "Missed call cost" got 140 visits in its first 3 days.', href: '#/blog/di-hy' },
    ];
    return {
      range: win, as_of: iso(22), google_connected: fx.googleConnected,
      read: inc.length === 1 ? read.filter((r) => !r.site_id || r.site_id === inc[0].id) : read,
      totals: {
        visitors: sum('visitors'), visitors_prev: sum('visitors_prev'), leads: sum('leads'), leads_prev: sum('leads_prev'),
        search_clicks: sum('search_clicks'), search_clicks_prev: sum('search_clicks_prev'),
      },
      sites: out, trend: { days: trendDays, markers },
    };
  }
  function blogTitle(s, b) {
    const titles = { 1: ['Why I stopped chasing every lead', 'What a $4M exit taught me about systems', 'Operators need fewer tools', 'Writing the book in public', 'The 6 a.m. rule', 'Hiring your first operator', 'Notes from the Tampa move'], 2: ['Missed call cost for HVAC shops', 'How trades owners use AI for estimates', 'The after-hours answering gap', 'Dispatch without a dispatcher', 'Review requests that actually work'], 3: ['SAM registration, step by step', 'How to read a solicitation in 10 minutes'] };
    const list = titles[s.id] || ['A post'];
    return list[(blogDays[s.id] || []).indexOf(b) % list.length] || list[0];
  }
  function socialSnippet(s, d) {
    const lines = ['Most small shops lose the job on the first missed call.', 'Three numbers I check every Monday.', 'The new post is up. Short version in the thread.', 'A tool is not a system. Here is the difference.', 'Quick story from a client call this week.'];
    return lines[(d + s.id) % lines.length];
  }

  // ---- channels ----
  function channels(q) {
    const range = Number(q.get('range')) || 28;
    const inc = includedSites(q).filter((s) => s.source !== 'none');
    const anyGa4 = inc.some((s) => s.source === 'ga4');
    const total = inc.reduce((a, s) => a + sumRange(s.id, range, 1, 'visitors'), 0);
    const totalP = inc.reduce((a, s) => a + sumRange(s.id, range * 2, range + 1, 'visitors'), 0);
    const leadsT = inc.reduce((a, s) => a + sumRange(s.id, range, 1, 'leads'), 0);
    const mix = [
      ['search', 'Search', 0.38, 0.40, null],
      ['social', 'Social', 0.22, 0.30, [['linkedin', 'LinkedIn', 0.58], ['facebook', 'Facebook', 0.27], ['instagram', 'Instagram', 0.15]]],
      ['direct', 'Direct', 0.2, 0.12, null],
      ['referral', 'Referral', 0.08, 0.06, [['news.ycombinator.com', 'news.ycombinator.com', 0.5], ['indiehackers.com', 'indiehackers.com', 0.5]]],
      ['ai', 'AI assistants', 0.06, 0.08, [['chatgpt.com', 'ChatGPT', 0.62], ['perplexity.ai', 'Perplexity', 0.28], ['claude.ai', 'Claude', 0.1]]],
      ['email', 'Email', 0.04, 0.04, null],
      ['other', 'Other', 0.02, 0, null],
    ];
    return {
      source: anyGa4 ? 'ga4' : 'logs',
      rows: mix.map(([channel, label, share, leadShare, bd]) => {
        const sessions = Math.round(total * share);
        return {
          channel, label, sessions, sessions_prev: Math.round(totalP * share * (channel === 'ai' ? 0.5 : channel === 'direct' ? 1.15 : 0.95)), share,
          leads: anyGa4 ? Math.round(leadsT * leadShare) : 0,
          breakdown: (bd || []).map(([src, l, f]) => ({ src, label: l, sessions: Math.round(sessions * f), leads: anyGa4 ? Math.round(leadsT * leadShare * f) : 0 })),
        };
      }),
    };
  }

  // ---- pages ----
  const pageDefs = {
    1: [['/', 0.3], ['/blog/why-i-stopped-chasing-every-lead/', 0.14], ['/about/', 0.1], ['/blog/the-6-am-rule/', 0.09], ['/book/', 0.08], ['/contact/', 0.06], ['/blog/operators-need-fewer-tools/', 0.05], ['/blog/notes-from-the-tampa-move/', 0.03]],
    2: [['/', 0.28], ['/blog/missed-call-cost-for-hvac-shops/', 0.16], ['/services/', 0.09], ['/contact/', 0.07], ['/blog/the-after-hours-answering-gap/', 0.07], ['/blog/how-trades-owners-use-ai-for-estimates/', 0.06], ['/pricing/', 0.04], ['/blog/review-requests-that-actually-work/', 0.04], ['/about/', 0.03]],
    3: [['/', 0.4], ['/capabilities/', 0.15], ['/blog/sam-registration-step-by-step/', 0.12], ['/contact/', 0.06], ['/blog/how-to-read-a-solicitation/', 0.05]],
  };
  function pages(q) {
    const range = Number(q.get('range')) || 28;
    const inc = includedSites(q).filter((s) => s.source !== 'none');
    const rows = [];
    for (const s of inc) {
      const total = sumRange(s.id, range, 1, 'pageviews');
      const r = rng(hash(s.domain + 'pages'));
      for (const [path, share] of pageDefs[s.id] || []) {
        const views = Math.round(total * share);
        const prev = Math.round(views * (0.55 + r() * 0.9));
        const isBlog = path.startsWith('/blog/');
        const gsc = s.source === 'ga4' && isBlog;
        const impressions = gsc ? Math.round(views * (6 + r() * 14)) : null;
        const position = gsc ? Number((4 + r() * 18).toFixed(1)) : null;
        const clicks = gsc ? Math.round(views * (0.25 + r() * 0.3)) : (s.source === 'ga4' ? Math.round(views * 0.1) : null);
        const leads = s.source === 'ga4' ? (path === '/contact/' ? Math.round(views * 0.012) : (isBlog ? Math.round(views * 0.015) : 0)) : 0;
        const tags = [];
        if (Math.max(views, prev) >= 20 && Math.abs(views - prev) / Math.max(prev, 1) >= 0.3) tags.push(views > prev ? 'rising' : 'falling');
        if (gsc && position >= 8 && position <= 20 && impressions >= 50) tags.push('refresh');
        if (s.source === 'ga4' && views >= 100 && leads === 0 && !isBlog && path !== '/') tags.push('no_leads');
        if (s.source === 'ga4' && views >= 100 && leads === 0 && path === '/book/') tags.push('no_leads');
        rows.push({
          site_id: s.id, domain: s.domain, path, url: `https://${s.domain}${path}`, views, views_prev: prev, search_clicks: clicks, impressions, position, leads, tags,
          blog: isBlog ? { site_id: s.blog_site_id, slug: path.split('/').filter(Boolean).pop(), title: path.split('/').filter(Boolean).pop().replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()) } : null,
        });
      }
    }
    rows.sort((a, b) => b.views - a.views);
    return { source: inc.some((s) => s.source === 'ga4') ? 'ga4' : 'logs', rows };
  }

  // ---- search ----
  const queryDefs = {
    1: [['write a business book while running a company', '/blog/notes-from-the-tampa-move/'], ['operator mindset', '/blog/operators-need-fewer-tools/'], ['how to hire first operator', '/blog/hiring-your-first-operator/'], ['cb holmes', '/'], ['entrepreneur morning routine', '/blog/the-6-am-rule/'], ['stop chasing leads', '/blog/why-i-stopped-chasing-every-lead/']],
    2: [['missed call cost hvac', '/blog/missed-call-cost-for-hvac-shops/'], ['ai for hvac companies', '/'], ['after hours answering service for contractors', '/blog/the-after-hours-answering-gap/'], ['ai estimates for plumbers', '/blog/how-trades-owners-use-ai-for-estimates/'], ['how to ask for google reviews contractor', '/blog/review-requests-that-actually-work/'], ['di-hy ai consulting', '/'], ['trades business automation', '/services/'], ['hvac lead response time', null], ['plumber dispatch software cost', null]],
  };
  function search(q) {
    const range = Number(q.get('range')) || 28;
    const inc = includedSites(q).filter((s) => s.source === 'ga4');
    if (!fx.googleConnected || !inc.length) return { connected: fx.googleConnected, queries: [], striking: [] };
    const queries = [];
    const striking = [];
    for (const s of inc) {
      const r = rng(hash(s.domain + 'q'));
      for (const [query, path] of queryDefs[s.id] || []) {
        const impressions = Math.round((120 + r() * 1800) * (range / 28));
        const position = Number((2 + r() * 20).toFixed(1));
        const ctr = position <= 3 ? 0.18 : position <= 6 ? 0.07 : position <= 10 ? 0.03 : 0.008;
        const clicks = Math.round(impressions * ctr);
        queries.push({ query, clicks, impressions, ctr, position, path });
        if (position >= 5 && position <= 20 && impressions >= 30) {
          striking.push({
            query, impressions, clicks, position, path, site_id: s.id,
            blog: path && path.startsWith('/blog/') && r() > 0.45 ? { site_id: s.blog_site_id, slug: path.split('/').filter(Boolean).pop(), title: path.split('/').filter(Boolean).pop().replace(/-/g, ' ') } : null,
          });
        }
      }
    }
    queries.sort((a, b) => b.clicks - a.clicks);
    striking.sort((a, b) => b.impressions - a.impressions);
    return { connected: true, queries, striking };
  }

  // ---- social to site ----
  function social(q) {
    const bid = q.get('brand_id');
    const utm = brands.filter((b) => !bid || String(b.id) === bid).map((b) => ({ brand_id: b.id, brand_name: b.name, enabled: !!fx.utm[b.id] }));
    const on = utm.some((u) => u.enabled);
    if (!on) return { utm, platforms: [], posts: [] };
    const range = Number(q.get('range')) || 28;
    const k = range / 28;
    return {
      utm,
      platforms: [
        { platform: 'linkedin', sessions: Math.round(96 * k), leads: Math.round(2 * k) },
        { platform: 'facebook', sessions: Math.round(41 * k), leads: Math.round(1 * k) },
        { platform: 'instagram', sessions: Math.round(18 * k), leads: 0 },
      ],
      posts: [
        { post_id: 301, platform: 'linkedin', brand_id: brands[1].id, brand_name: brands[1].name, snippet: 'Most small shops lose the job on the first missed call.', published_at: iso(60 * 24 * 3), sessions: 58, leads: 1 },
        { post_id: 302, platform: 'linkedin', brand_id: brands[0].id, brand_name: brands[0].name, snippet: 'A tool is not a system. Here is the difference.', published_at: iso(60 * 24 * 6), sessions: 31, leads: 1 },
        { post_id: 303, platform: 'facebook', brand_id: brands[1].id, brand_name: brands[1].name, snippet: 'The new post is up. Short version in the thread.', published_at: iso(60 * 24 * 9), sessions: 27, leads: 1 },
        { post_id: 304, platform: 'instagram', brand_id: brands[0].id, brand_name: brands[0].name, snippet: 'Quick story from a client call this week.', published_at: iso(60 * 24 * 12), sessions: 18, leads: 0 },
        { post_id: 305, platform: 'linkedin', brand_id: brands[1].id, brand_name: brands[1].name, snippet: 'Three numbers I check every Monday.', published_at: iso(60 * 24 * 15), sessions: 7, leads: 0 },
      ],
    };
  }

  function health(q) {
    const inc = includedSites(q).filter((s) => s.source !== 'none');
    const nfAll = [
      ['/wp-content/uploads/2023/old-brochure.pdf', 34], ['/blog/feed/', 21], ['/services/hvac/', 17], ['/about-us/', 12], ['/2024/05/ai-for-contractors/', 9], ['/lunula-capabilities.pdf', 6],
    ];
    const not_found = [];
    inc.forEach((s, i) => nfAll.forEach(([p, h], j) => { if ((i + j) % 2 === 0) not_found.push({ site_id: s.id, domain: s.domain, path: p, hits: h + i * 3, redirect_line: `location = ${p} { return 301 /; }` }); }));
    not_found.sort((a, b) => b.hits - a.hits);
    return {
      not_found,
      bots: inc.map((s) => ({ site_id: s.id, domain: s.domain, search_bot_hits: 420 + s.id * 37, ai_bot_hits: 96 + s.id * 11 })),
      forms: inc.filter((s) => s.id !== 3).map((s) => ({ site_id: s.id, domain: s.domain, delivered: 9 + s.id, tagged: 2, blocked: 31, honeypot: 44, invalid: 5 })),
      lead_check: inc.filter((s) => s.id === 2).map((s) => ({ site_id: s.id, domain: s.domain, ga4_leads: 7, relay_delivered: 11, text: 'The form relay delivered 11 leads but Google Analytics counted 7. The lead event may be blocked for some visitors.' })),
    };
  }

  function realtime(q) {
    const r = rng(Math.floor(Date.now() / 60000));
    return { sites: includedSites(q).filter((s) => s.source !== 'none').map((s) => ({ site_id: s.id, domain: s.domain, active_now: s.id === 3 ? 0 : Math.floor(r() * 6) + (s.id === 2 ? 2 : 0), window: '30m', source: s.source })) };
  }

  function home() {
    return {
      line: 'This week: 1,180 visitors across your sites, 5 leads.',
      alerts: [
        { level: 'warn', text: 'lunulasupply.com reported 0 visits for 2 days. Tracking may be broken.', href: '#/analytics' },
        { level: 'info', text: '2 new leads since yesterday, both from di-hy.com.', href: '#/analytics' },
      ],
      week: { visitors: 1180, visitors_prev: 1004, leads: 5, leads_prev: 3, top_post: { title: 'Missed call cost for HVAC shops', href: '#/blog/di-hy', visitors: 140 } },
    };
  }

  function status() {
    return {
      google: { connected: fx.googleConnected, key_present: fx.keyPresent, client_email: fx.keyPresent ? fx.clientEmail : null, error: null },
      ssh: { ok: true, host: 'my-vps', error: null, self_ip: '203.0.113.7' },
      last_sync: { logs: iso(22), ga4: fx.googleConnected ? iso(190) : null, gsc: fx.googleConnected ? iso(250) : null },
      syncing: false,
    };
  }

  function siteRow(s) {
    const b = brandOf(s);
    const email = fx.clientEmail;
    const checklist = [];
    if (s.source === 'none') {
      checklist.push({ id: 'tag', done: false, text: `Create a Google Analytics property for ${s.domain} and add its tag to the site.` });
    } else {
      checklist.push({ id: 'tag', done: !!s.ga4_measurement_id, text: s.ga4_measurement_id ? `The Google tag ${s.ga4_measurement_id} is on ${s.domain}.` : `Add the Google tag to ${s.domain}.` });
      checklist.push({ id: 'viewer', done: !!s.ga4_property_id, text: s.ga4_property_id ? 'PostDeck can read the Google Analytics property.' : `Add ${email} as a Viewer on the Google Analytics property for ${s.domain}.` });
      checklist.push({ id: 'gsc', done: !!s.gsc_property, text: s.gsc_property ? 'PostDeck can read Search Console.' : `Add ${email} as a Restricted user on the Search Console property for ${s.domain}.` });
      checklist.push({ id: 'lead', done: s.id !== 3, text: s.id !== 3 ? 'A lead event fires when a form is sent.' : `Confirm ${s.domain} fires a generate_lead event on its forms.` });
    }
    return {
      id: s.id, domain: s.domain, brand_id: b.id, brand_name: b.name, brand_slug: brandDefs[s.brand].key, blog_site_id: s.blog_site_id,
      ga4_measurement_id: s.ga4_measurement_id, ga4_property_id: s.ga4_property_id, gsc_property: s.gsc_property, active: s.active,
      last_sync_at: s.source === 'none' ? null : iso(s.source === 'ga4' ? 190 : 22), last_sync_error: s.id === 3 ? 'Search Console: the service account has no access to this property.' : null, checklist,
    };
  }

  function sitesRes() {
    return {
      sites: sites.map(siteRow),
      self: {
        ips: [{ ip: '203.0.113.7', how: 'ssh', last_seen: iso(30) }, { ip: '198.51.100.24', how: 'optout', last_seen: iso(60 * 26) }],
        optout_links: sites.map((s) => ({ domain: s.domain, on_url: `https://${s.domain}/?pd_internal=on`, off_url: `https://${s.domain}/?pd_internal=off` })),
      },
    };
  }

  function blogStats() {
    const posts = new Proxy({}, {
      get(_t, slug) {
        if (typeof slug !== 'string' || slug === 'then') return undefined;
        const h = hash(slug);
        if (h % 5 === 0) return undefined;
        return { views: 20 + (h % 380), search_clicks: h % 60, position: h % 7 === 0 ? null : Number((3 + (h % 170) / 10).toFixed(1)) };
      },
    });
    return { posts };
  }

  function daily(q) {
    const start = q.get('start') || dk(daysAgo(60));
    const end = q.get('end') || dk(TODAY);
    const inc = includedSites(q).filter((s) => s.source !== 'none');
    const map = new Map();
    for (const s of inc) for (const d of DAYS[s.id]) if (d.date >= start && d.date <= end) map.set(d.date, (map.get(d.date) || 0) + d.visitors);
    return { days: [...map.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, visitors]) => ({ date, visitors })) };
  }

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  window.webFixtureHandle = async function webFixtureHandle(path, opts) {
    const method = String((opts && opts.method) || 'GET').toUpperCase();
    const [pathname, query = ''] = path.split('?');
    const q = new URLSearchParams(query);
    const body = (opts && opts.body) || {};
    await wait(60 + (hash(pathname) % 140));

    if (pathname === '/api/brands' && method === 'GET') return brands.map((b) => ({ id: b.id, name: b.name, utm_enabled: !!fx.utm[b.id] }));
    const brandMatch = pathname.match(/^\/api\/brands\/(\d+)$/);
    if (brandMatch && method === 'PATCH') {
      if (!brands.some((b) => String(b.id) === brandMatch[1])) return undefined;
      if (body.utm_enabled !== undefined) fx.utm[brandMatch[1]] = !!body.utm_enabled;
      return { id: Number(brandMatch[1]), utm_enabled: !!fx.utm[brandMatch[1]] };
    }
    if (!pathname.startsWith('/api/web/')) return undefined;
    const route = pathname.slice('/api/web/'.length);

    if (route === 'status') return status();
    if (route === 'sites' && method === 'GET') return sitesRes();
    const sm = route.match(/^sites\/(\d+)$/);
    if (sm && method === 'PATCH') {
      const s = sites.find((x) => String(x.id) === sm[1]);
      if (!s) { const e = new Error('Site not found'); e.status = 404; throw e; }
      if ('brand_id' in body) { const i = brands.findIndex((b) => b.id === body.brand_id); if (i >= 0) s.brand = i; }
      if ('ga4_property_id' in body) s.ga4_property_id = body.ga4_property_id;
      if ('gsc_property' in body) s.gsc_property = body.gsc_property;
      if ('active' in body) s.active = !!body.active;
      return siteRow(s);
    }
    if (route === 'google-key' && method === 'POST') {
      try { JSON.parse(body.json); } catch { const e = new Error('That is not a valid JSON key file.'); e.status = 400; throw e; }
      fx.googleConnected = true; fx.keyPresent = true;
      return { ok: true, client_email: fx.clientEmail };
    }
    if (route === 'google-key' && method === 'DELETE') { fx.googleConnected = false; fx.keyPresent = false; return { ok: true }; }
    if (route === 'sync') { await wait(900); return { ok: true, results: [{ site_id: 1, source: 'logs', ok: true, rows: 14 }, { site_id: 3, source: 'gsc', ok: false, rows: 0, error: 'Search Console: the service account has no access to this property.' }] }; }
    if (route === 'overview') return overview(q);
    if (route === 'channels') return channels(q);
    if (route === 'pages') return pages(q);
    if (route === 'search') return search(q);
    if (route === 'social') return social(q);
    if (route === 'health') return health(q);
    if (route === 'realtime') return realtime(q);
    if (route === 'home') return home();
    if (route === 'blog-stats') return blogStats();
    if (route === 'daily') return daily(q);
    if (route === 'digest') return { text: 'Visitors are up on both content sites.' };
    const pm = route.match(/^post\/(\d+)$/);
    if (pm) return Number(pm[1]) % 2 === 0 ? { sessions: 18, leads: 1, source: 'ga4' } : { sessions: null };
    const e = new Error(`No fixture for ${pathname}`);
    e.status = 404;
    throw e;
  };
}());
