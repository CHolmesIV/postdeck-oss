// PostDeck dashboard - vanilla JS, hash routing, no build step, no CDN.

const API = '';
const BRAND_COLORS = ['#C8902A', '#3d7ab8', '#4c9a5b', '#c0392b', '#8e6fc4'];

// Fallback limits, used only until GET /api/platform-specs resolves (or if it
// ever fails) - config/platform-specs.json is the real single source of truth
// (SPEC.md "Platform lineup"). See textLimitFor()/platformSpec() below.
const FALLBACK_PLATFORM_LIMITS = {
  twitter: { text: 280 },
  linkedin: { text: 3000 },
  facebook: { text: 63206 },
  instagram: { text: 2200 },
  tiktok: { caption: 2200, title: 90 },
  reddit: { title: 300, body: 40000 },
  blog: { text: null },
};

const TIKTOK_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

function platformSpec(platform) {
  return (state.platformSpecs && state.platformSpecs[platform]) || null;
}

function textLimitFor(platform) {
  const spec = platformSpec(platform);
  if (spec) return spec.text?.max ?? null;
  return FALLBACK_PLATFORM_LIMITS[platform]?.text ?? null;
}

function tiktokRequiredFieldsFromSpec() {
  const spec = platformSpec('tiktok');
  return (
    spec?.required_fields || [
      'privacyLevel',
      'disabledComments',
      'disabledDuet',
      'disabledStitch',
      'isBrandedContent',
      'isYourBrand',
      'isAiGenerated',
    ]
  );
}

// Short "best-practice" hint line for the composer, built straight from
// platform-specs.json's hashtags_best/best_length_s fields (SPEC.md
// "Composer... hints show best-practice notes").
function platformHint(platform) {
  const spec = platformSpec(platform);
  if (!spec) return '';
  const parts = [];
  const hashtags = spec.text?.hashtags_best;
  if (Array.isArray(hashtags)) {
    parts.push(hashtags[0] === hashtags[1] ? `${hashtags[0]} hashtags` : `${hashtags[0]}-${hashtags[1]} hashtags`);
  }
  const videoLen = spec.video?.best_length_s;
  if (Array.isArray(videoLen)) parts.push(`best video length ${videoLen[0]}-${videoLen[1]}s`);
  if (spec.cadence) parts.push(`cadence: ${spec.cadence}`);
  return parts.join(' · ');
}

// Statuses whose publish_at can still be changed locally (drag-to-reschedule,
// manual edit). Mirrors RESCHEDULABLE_STATUSES in src/server.js - the server
// is the real enforcement point, this just disables the affordance in the UI.
const RESCHEDULABLE_STATUSES = ['draft', 'approved', 'scheduled_local'];

// ---------------- Assisted-manual (B11) ----------------
// Generalizes the Reddit-only "assisted-manual" concept: a platform whose
// platform-specs entry is blotato:false AND mode:'assisted_manual' (Reddit -
// compose/copy/paste, not blog's render_and_deploy which is also
// blotato:false but a different flow entirely), OR any account with its own
// accounts.manual=1 override (SPEC.md B11). Both paths skip Blotato submission
// and get the compose -> Copy -> Open platform -> Mark posted flow.
function isManualPlatform(platform) {
  const spec = platformSpec(platform);
  if (!spec) return platform === 'reddit'; // fallback before /api/platform-specs resolves
  if (spec.mode === 'assisted_manual') return true;
  return spec.blotato === false && spec.mode !== 'render_and_deploy';
}

function isManualAccount(acct) {
  if (!acct) return false;
  if (Number(acct.manual) === 1) return true;
  return isManualPlatform(acct.platform);
}

function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// Mutates `fields` in place as the user edits, so the same object reference
// can be read back at save time regardless of which tab is currently shown.
function tiktokFieldsEditor(fields) {
  // Required field set comes from config/platform-specs.json (tiktok.required_fields)
  // instead of a hardcoded list - see src/platforms.js / GET /api/platform-specs.
  const required = tiktokRequiredFieldsFromSpec();
  const boolDefault = (key) => (key === 'isYourBrand' ? true : false);
  if (required.includes('privacyLevel') && fields.privacyLevel === undefined) {
    fields.privacyLevel = 'PUBLIC_TO_EVERYONE';
  }
  for (const key of required) {
    if (key === 'privacyLevel') continue;
    if (fields[key] === undefined) fields[key] = boolDefault(key);
  }

  const privacy = el(
    'select',
    { onchange: (e) => { fields.privacyLevel = e.target.value; } },
    TIKTOK_PRIVACY_LEVELS.map((v) =>
      el('option', { value: v, selected: fields.privacyLevel === v ? 'selected' : undefined }, v)
    )
  );

  function flagRow(key, label) {
    const cb = el('input', { type: 'checkbox' });
    cb.checked = !!fields[key];
    cb.addEventListener('change', () => { fields[key] = cb.checked; });
    return el('label', { style: 'display:block;margin-bottom:2px;' }, [cb, ` ${label}`]);
  }

  const FLAG_LABELS = {
    disabledComments: 'Disable comments',
    disabledDuet: 'Disable duet',
    disabledStitch: 'Disable stitch',
    isBrandedContent: 'Branded content',
    isYourBrand: "This is your own brand's content",
    isAiGenerated: 'AI-generated content',
  };

  const rows = [];
  if (required.includes('privacyLevel')) {
    rows.push(el('div', {}, [el('label', {}, 'Privacy level'), privacy]));
  }
  for (const key of required) {
    if (key === 'privacyLevel') continue;
    rows.push(flagRow(key, FLAG_LABELS[key] || key));
  }

  return el('div', { class: 'field-row tiktok-fields' }, rows);
}

// Mutates `fields` in place (subreddit/title/body). Reddit is an
// assisted-manual channel (SPEC.md "Platform lineup") - no Blotato
// submission, so this is the only editor for it; the 90/10 self-promo note
// comes straight from platform-specs.json's reddit.rules.self_promo.
function redditFieldsEditor(fields) {
  fields.subreddit = fields.subreddit || '';
  const spec = platformSpec('reddit');
  const titleMax = spec?.text?.title_max ?? FALLBACK_PLATFORM_LIMITS.reddit.title;
  const bodyMax = spec?.text?.body_max ?? FALLBACK_PLATFORM_LIMITS.reddit.body;

  const subredditInput = el('input', { placeholder: 'subreddit (no r/)', value: fields.subreddit });
  subredditInput.addEventListener('input', () => { fields.subreddit = subredditInput.value; });

  const titleInput = el('input', { placeholder: 'Title', value: fields.title || '' });
  const titleCount = el('div', { class: 'char-count' });
  function updateTitleCount() {
    titleCount.textContent = `${titleInput.value.length} / ${titleMax}`;
    titleCount.classList.toggle('over', titleInput.value.length > titleMax);
  }
  titleInput.addEventListener('input', () => { fields.title = titleInput.value; updateTitleCount(); });
  updateTitleCount();

  const bodyArea = el('textarea', { rows: '8', placeholder: 'Body (self-post text)' });
  bodyArea.value = fields.body || '';
  const bodyCount = el('div', { class: 'char-count' });
  function updateBodyCount() {
    bodyCount.textContent = `${bodyArea.value.length} / ${bodyMax}`;
    bodyCount.classList.toggle('over', bodyArea.value.length > bodyMax);
  }
  bodyArea.addEventListener('input', () => { fields.body = bodyArea.value; updateBodyCount(); });
  updateBodyCount();

  const hint = spec?.rules?.self_promo
    ? el('div', { class: 'hint', style: 'color:var(--muted);font-size:12px;margin-top:4px;' }, `Reddit self-promo rule: ${spec.rules.self_promo}`)
    : null;

  return el('div', { class: 'field-row reddit-fields' }, [
    el('div', { class: 'field-row' }, [el('label', {}, 'Subreddit'), subredditInput]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Title'), titleInput, titleCount]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Body'), bodyArea, bodyCount]),
    hint,
  ]);
}

// Mutates `fields` in place (title/slug/hero). mediaFiles = /api/media list,
// used to populate the hero-image picker from the Library.
function blogFieldsEditor(fields, mediaFiles = []) {
  const titleInput = el('input', { placeholder: 'Title', value: fields.title || '' });
  let slugManuallyEdited = !!fields.slug;
  const slugInput = el('input', { placeholder: 'slug', value: fields.slug || slugify(fields.title || '') });
  fields.slug = slugInput.value;

  titleInput.addEventListener('input', () => {
    fields.title = titleInput.value;
    if (!slugManuallyEdited) {
      slugInput.value = slugify(titleInput.value);
      fields.slug = slugInput.value;
    }
  });
  slugInput.addEventListener('input', () => {
    slugManuallyEdited = true;
    fields.slug = slugInput.value;
  });

  fields.hero = fields.hero || null;
  const heroSelect = el(
    'select',
    { onchange: (e) => { fields.hero = e.target.value || null; } },
    [
      el('option', { value: '' }, '(no hero image)'),
      ...mediaFiles.map((f) =>
        el('option', { value: f.path, selected: fields.hero === f.path ? 'selected' : undefined }, f.filename)
      ),
    ]
  );

  return el('div', { class: 'blog-fields' }, [
    el('div', { class: 'field-row' }, [el('label', {}, 'Title'), titleInput]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Slug'), slugInput]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Hero image'), heroSelect]),
  ]);
}

const state = {
  brands: [],
  accounts: [],
  tonesByBrand: {}, // not exposed via API yet directly; fetched per-need
  platformSpecs: {}, // config/platform-specs.json, via GET /api/platform-specs
};

// ---------------- B15: AI provider switcher (Claude / Codex) ----------------
// The Settings draft_provider is the source of truth for the *default*; this
// module var just remembers the last choice for the rest of the session so
// switching brands/tabs in the composer doesn't reset it back to the setting.
let sessionDraftProvider = null;
const AI_PROVIDERS = [
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
];

// Small segmented control - two buttons, one active. Shared by the
// Draft-with-AI box and the copy-assist panel (they read the same
// currentProvider closure var in renderComposer).
function providerSwitch(initial, onChange) {
  const wrap = el('div', { class: 'provider-switch' });
  let value = initial;
  const buttons = AI_PROVIDERS.map((p) =>
    el('button', {
      type: 'button',
      class: p.value === value ? 'active' : '',
      onclick: () => {
        value = p.value;
        for (const [i, b] of buttons.entries()) b.classList.toggle('active', AI_PROVIDERS[i].value === value);
        onChange(value);
      },
    }, p.label)
  );
  wrap.append(...buttons);
  return wrap;
}

// ---------------- Sticky brand (B10) ----------------
// Persisted "current brand" so views default to it instead of resetting to
// "All brands" on every navigation. '' (All brands) is itself a valid
// remembered value - localStorage.getItem returning null (never set) also
// collapses to '', which is the same default the views already used.
const STICKY_BRAND_KEY = 'pd_current_brand';
function getStickyBrand() {
  return localStorage.getItem(STICKY_BRAND_KEY) || '';
}
function setStickyBrand(id) {
  localStorage.setItem(STICKY_BRAND_KEY, id || '');
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: opts.body && !(opts.body instanceof FormData)
      ? { 'Content-Type': 'application/json', ...(opts.headers || {}) }
      : opts.headers,
    body: opts.body && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body,
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function brandColor(brandId) {
  const idx = state.brands.findIndex((b) => b.id === brandId);
  return BRAND_COLORS[idx >= 0 ? idx % BRAND_COLORS.length : 0];
}

function brandName(brandId) {
  const b = state.brands.find((x) => x.id === brandId);
  return b ? b.name : `brand ${brandId}`;
}

function fmtDate(iso) {
  if (!iso) return '(unscheduled)';
  const d = new Date(iso);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------- Router ----------------

const routes = {
  '': renderHome,
  home: renderHome,
  calendar: renderCalendar,
  ideas: renderIdeas,
  library: renderLibrary,
  composer: renderComposer,
  post: renderPostDetail,
  analytics: renderAnalytics,
  ops: renderOps,
  research: renderResearch,
  inspiration: renderInspiration,
  images: renderImages,
  settings: renderSettings,
  profiles: renderProfiles,
};

function currentRoute() {
  const hash = location.hash.replace(/^#\//, '');
  const [name, ...rest] = hash.split('/');
  return { name: name || 'home', params: rest };
}

// Guards against a real (pre-existing) race: bootstrap() sets location.hash
// (firing an async 'hashchange') and then calls router() directly for the
// same navigation, so two router() runs can be in flight at once - and since
// each render*() handler does view.innerHTML = '' at the *start* of its own
// async work (not atomically with the rest of its rendering), two interleaved
// runs used to both append into the same live #view node and double-render
// the whole page. Fix: each run builds into a detached scratch node instead of
// the live DOM, and only the run that is still current when it finishes gets
// swapped in - a superseded run's output is silently discarded.
let routerToken = 0;

async function router() {
  const myToken = ++routerToken;
  const { name, params } = currentRoute();
  document.querySelectorAll('#sidebar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === name);
  });
  const liveView = document.getElementById('view');
  liveView.innerHTML = '<p style="color:var(--muted)">Loading…</p>';

  const scratch = document.createElement('main');
  scratch.id = 'view';
  const handler = routes[name] || renderHome;
  try {
    await handler(scratch, params);
  } catch (err) {
    scratch.innerHTML = '';
    scratch.appendChild(el('div', { class: 'msg-banner msg-error' }, `Error: ${err.message}`));
  }

  if (myToken !== routerToken) return; // a newer navigation superseded this run - discard it
  const current = document.getElementById('view');
  if (current) current.replaceWith(scratch);
}

window.addEventListener('hashchange', router);

async function bootstrap() {
  state.brands = await api('/api/brands');
  state.accounts = await api('/api/accounts');
  state.platformSpecs = await api('/api/platform-specs').catch(() => ({}));
  if (!location.hash) location.hash = '#/home';
  router();
}

bootstrap();

// ---------------- Calendar / Queue ----------------

async function renderCalendar(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Calendar / Queue'));
  const container = el('div');
  view.appendChild(container);
  await renderCalendarInto(container);
}

// Reusable calendar body (toolbar + grid + drag-reschedule) - used standalone
// at #/calendar and embedded (read: same live behavior, not a copy) at the
// bottom of the Home cockpit (renderHome, B9). `initialBrand` lets the Home
// brand filter scope the embedded calendar on first render.
async function renderCalendarInto(view, { initialBrand = getStickyBrand(), defaultMode = 'month' } = {}) {
  view.innerHTML = '';
  let refDate = new Date();
  refDate.setHours(0, 0, 0, 0);

  try {
    const ws = await api('/api/worker/status');
    const line = el('div', { class: 'worker-status-line' }, [
      `Worker - last run: ${fmtDate(ws.lastRunAt) || 'never'} · next run: ${fmtDate(ws.nextRunAt) || '-'}`,
      ws.dryRun ? el('span', { class: 'dry-run-banner' }, 'DRY RUN - no real Blotato calls will be made') : '',
      !ws.enabled ? el('span', { class: 'dry-run-banner' }, 'WORKER DISABLED') : '',
    ]);
    view.appendChild(line);
  } catch {
    // worker status is best-effort; don't block the calendar if it 404s
  }

  const toolbar = el('div', { class: 'toolbar' });
  const brandFilter = el('select', { id: 'cal-brand' }, [
    el('option', { value: '' }, 'All brands'),
    ...state.brands.map((b) => el('option', { value: b.id, selected: String(b.id) === String(initialBrand) ? 'selected' : undefined }, b.name)),
  ]);
  const platformFilter = el('select', { id: 'cal-platform' }, [
    el('option', { value: '' }, 'All platforms'),
    ...['twitter', 'linkedin', 'facebook', 'instagram', 'tiktok', 'reddit', 'blog'].map((p) =>
      el('option', { value: p }, p)
    ),
  ]);
  const viewToggle = el('select', { id: 'cal-view' }, [
    el('option', { value: 'week', selected: defaultMode === 'week' ? 'selected' : undefined }, 'Week'),
    el('option', { value: 'month', selected: defaultMode === 'month' ? 'selected' : undefined }, 'Month'),
  ]);
  // Period nav: prev / label / next / Today. Steps by month (month view) or
  // week (week view). Lets CB move between months without hunting.
  const prevBtn = el('button', { class: 'cal-nav-btn', title: 'Previous' }, '‹');
  const nextBtn = el('button', { class: 'cal-nav-btn', title: 'Next' }, '›');
  const todayBtn = el('button', { class: 'cal-nav-btn' }, 'Today');
  const periodLabel = el('span', { class: 'cal-period-label' }, '');
  toolbar.append(
    el('span', {}, 'Brand:'), brandFilter,
    el('span', {}, 'Platform:'), platformFilter,
    el('span', {}, 'View:'), viewToggle,
    prevBtn, todayBtn, nextBtn, periodLabel
  );
  view.appendChild(toolbar);

  const grid = el('div', { class: 'cal-grid', id: 'cal-grid' });
  view.appendChild(grid);

  function updateLabel(mode) {
    if (mode === 'month') {
      periodLabel.textContent = refDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    } else {
      periodLabel.textContent = 'Week of ' + refDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    }
  }

  async function reload() {
    const posts = await api('/api/posts');
    const brand = brandFilter.value;
    const platform = platformFilter.value;
    const mode = viewToggle.value;
    const filtered = posts.filter(
      (p) => (!brand || String(p.brand_id) === brand) && (!platform || p.platform === platform)
    );
    updateLabel(mode);
    drawGrid(grid, filtered, mode, refDate);
  }

  function step(dir) {
    const mode = viewToggle.value;
    if (mode === 'month') refDate.setMonth(refDate.getMonth() + dir, 1);
    else refDate.setDate(refDate.getDate() + dir * 7);
    reload();
  }
  prevBtn.onclick = () => step(-1);
  nextBtn.onclick = () => step(1);
  todayBtn.onclick = () => { refDate = new Date(); refDate.setHours(0, 0, 0, 0); reload(); };

  brandFilter.onchange = () => { setStickyBrand(brandFilter.value); reload(); };
  platformFilter.onchange = reload;
  viewToggle.onchange = reload;
  await reload();

  async function reschedulePost(postId, newDateKey, posts) {
    const post = posts.find((p) => String(p.id) === String(postId));
    if (!post) return;
    if (!RESCHEDULABLE_STATUSES.includes(post.status)) return; // UI-side guard
    const newPublishAt = rescheduleToDateKeepingTime(post.publish_at, newDateKey);
    try {
      await api(`/api/posts/${postId}`, { method: 'PATCH', body: { publish_at: newPublishAt } });
      await reload();
    } catch (err) {
      alert(err.message);
    }
  }

  grid.reschedulePost = reschedulePost;
}

// ---------------- Home command center (B9) ----------------
// Operator cockpit: quick-create bar, needs-attention triage, this-week
// strip, per-platform health chips, mini analytics, and the calendar
// embedded below. Becomes the default `#/` / `#/home` route (SPEC.md "B9 -
// Home command center"). Reuses B7/B8 endpoints only: /api/posts,
// /api/accounts, /api/analytics - no new server work.

// `getBrand` is a closure reading the Home view's current brand-filter value
// so the quick-create buttons can prefill the Composer with it. `onRedistribute`
// (B11) toggles the redistribute-from-blog form open/closed.
function homeQuickCreateBar(getBrand, onRedistribute) {
  function goCompose({ focusAI = false } = {}) {
    const brand = getBrand();
    if (brand) sessionStorage.setItem('pd_composer_prefill_brand', brand);
    else sessionStorage.removeItem('pd_composer_prefill_brand');
    if (focusAI) sessionStorage.setItem('pd_composer_focus_ai', '1');
    else sessionStorage.removeItem('pd_composer_focus_ai');
    location.hash = '#/composer';
  }

  return el('div', { class: 'home-quickbar' }, [
    el('button', { class: 'primary quickbar-primary', onclick: () => goCompose() }, '+ New Post'),
    el('button', { class: 'quickbar-secondary', onclick: () => goCompose({ focusAI: true }) }, 'Draft with AI'),
    el('button', { class: 'quickbar-secondary', onclick: () => { location.hash = '#/ideas'; } }, '+ Idea'),
    el('button', { class: 'quickbar-secondary', onclick: () => { location.hash = '#/images'; } }, 'Request image (Codex)'),
    el('button', { class: 'quickbar-secondary', onclick: onRedistribute }, 'Redistribute blog post'),
  ]);
}

// ---------------- Redistribute-from-blog (B11) ----------------
// Shared form used from both Home (quick-create bar) and the Composer: paste
// a blog URL, pick platforms (defaults to the brand's connected accounts'
// platforms, else falls back to platform-specs' full list), toggle "make
// images", submit -> POST /api/redistribute -> drafts land in the pipeline as
// status:'draft' (human still approves each one, same as every other path).
function redistributeForm(getBrandId) {
  const container = el('div', { class: 'card redistribute-form' });
  container.appendChild(el('h2', {}, 'Redistribute a blog post'));
  container.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:10px;' },
      'Paste a blog URL - drafts a copy for each platform picked below, plus an image request brief if "Make images" is on.')
  );

  const urlInput = el('input', { placeholder: 'https://example.com/blog/my-post', style: 'width:100%;' });
  container.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Blog URL'), urlInput]));

  const platformsHost = el('div', { class: 'field-row' });
  const checks = {};
  function renderPlatformChecks() {
    platformsHost.innerHTML = '';
    platformsHost.appendChild(el('label', {}, 'Platforms'));
    const brandId = getBrandId();
    const accounts = brandId ? state.accounts.filter((a) => String(a.brand_id) === String(brandId)) : state.accounts;
    const list = [...new Set(accounts.map((a) => a.platform))];
    const fallback = list.length ? list : Object.keys(state.platformSpecs || {});
    const row = el('div', { class: 'redistribute-platform-row' });
    for (const key of Object.keys(checks)) delete checks[key];
    if (!fallback.length) {
      row.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'No accounts/platforms available - pick a brand with connected accounts.'));
    }
    for (const p of fallback) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = true;
      checks[p] = cb;
      row.appendChild(el('label', { style: 'margin-right:12px;display:inline-flex;align-items:center;gap:5px;' }, [cb, ` ${p}`]));
    }
    platformsHost.appendChild(row);
  }
  renderPlatformChecks();
  container.appendChild(platformsHost);

  const makeImagesCb = el('input', { type: 'checkbox' });
  makeImagesCb.checked = true;
  container.appendChild(el('label', { style: 'display:block;margin-bottom:10px;' }, [makeImagesCb, ' Make images']));

  const msg = el('div');
  const submitBtn = el('button', {
    class: 'primary',
    onclick: async () => {
      msg.innerHTML = '';
      const brandId = getBrandId();
      const url = urlInput.value.trim();
      const platforms = Object.keys(checks).filter((p) => checks[p].checked);
      if (!url) { msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Enter a blog URL.')); return; }
      if (!brandId) { msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Select a brand first.')); return; }
      if (!platforms.length) { msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one platform.')); return; }
      submitBtn.disabled = true;
      msg.appendChild(
        el('div', { class: 'msg-banner', style: 'background:var(--ink-3);color:var(--muted);border:1px solid var(--border);' },
          'Drafting from the article for each platform - this can take a bit…')
      );
      try {
        const res = await api('/api/redistribute', {
          method: 'POST',
          body: { url, brand_id: Number(brandId), platforms, make_images: makeImagesCb.checked },
        });
        msg.innerHTML = '';
        const n = res.drafts?.length ?? 0;
        msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, `Created ${n} draft(s) from "${res.source?.title || url}". Opening the calendar…`));
        if (res.ai_unavailable) {
          msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'AI unavailable for one or more platforms - check the drafts before approving.'));
        }
        setTimeout(() => { location.hash = '#/calendar'; }, 900);
      } catch (err) {
        msg.innerHTML = '';
        if (err.status === 400 && err.data?.error === 'fetch_failed') {
          msg.appendChild(el('div', { class: 'msg-banner msg-error' }, "Could not fetch that URL - check it's reachable and try again."));
        } else if (err.status === 503 || err.data?.error === 'ai_unavailable') {
          msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'AI unavailable (claude CLI not found).'));
        } else if (err.status === 404) {
          msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Redistribute endpoint not available yet on this server.'));
        } else {
          msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
        }
      } finally {
        submitBtn.disabled = false;
      }
    },
  }, 'Redistribute');
  container.appendChild(el('div', { class: 'toolbar' }, [submitBtn]));
  container.appendChild(msg);

  return container;
}

function attentionRow(label, href, kind = 'warn') {
  return el('a', { class: `attention-row attention-${kind}`, href }, [
    el('span', { class: 'attention-dot' }),
    el('span', { class: 'attention-label' }, label),
  ]);
}

// Handoff-window guard mirrors the composer's own TikTok required-fields
// check (tiktokRequiredFieldsFromSpec) so "missing platform fields" here
// means the same thing it means when actually submitting.
function postMissingHandoffRequirements(p) {
  const reasons = [];
  if (!p.media || !p.media.length) reasons.push('no media');
  if (p.platform === 'tiktok') {
    const required = tiktokRequiredFieldsFromSpec();
    const fields = p.platform_fields || {};
    if (required.some((k) => fields[k] === undefined)) reasons.push('missing TikTok fields');
  }
  return reasons;
}

function buildAttentionSection(container, posts, analyticsData, homeBrand, profiles = []) {
  container.innerHTML = '';
  const card = el('div', { class: 'card home-section' });
  card.appendChild(el('h2', {}, 'Needs attention'));
  const list = el('div', { class: 'attention-list' });

  const rows = [];

  // B13: profiles marked stale (manual mark-stale, or a future auto-detect)
  // surface here so a business-fact change doesn't quietly go unnoticed.
  for (const p of (profiles || []).filter((p) => p.status === 'stale')) {
    rows.push(
      attentionRow(
        `${brandName(p.brand_id)} ${humanizePlatformName(p.platform)} profile marked stale - review it`,
        '#/profiles',
        'warn'
      )
    );
  }

  for (const p of posts.filter((p) => p.status === 'failed')) {
    rows.push(
      attentionRow(
        `Failed - ${brandName(p.brand_id)} · ${p.platform}: ${(p.copy || '(no copy)').slice(0, 50)}`,
        `#/post/${p.id}`,
        'bad'
      )
    );
  }

  const drafts = posts.filter((p) => p.status === 'draft');
  if (drafts.length) {
    rows.push(attentionRow(`${drafts.length} draft(s) awaiting approval`, '#/calendar', 'warn'));
  }

  const now = Date.now();
  const handoffWindow = now + 48 * 3600 * 1000;
  const handoffGaps = posts.filter((p) => {
    if (!['draft', 'approved'].includes(p.status)) return false;
    if (!p.publish_at) return false;
    const t = new Date(p.publish_at).getTime();
    if (!(t <= handoffWindow)) return false;
    return postMissingHandoffRequirements(p).length > 0;
  });
  for (const p of handoffGaps) {
    rows.push(
      attentionRow(
        `Due ${fmtDate(p.publish_at)} - ${brandName(p.brand_id)} · ${p.platform}: ${postMissingHandoffRequirements(p).join(', ')}`,
        `#/post/${p.id}`,
        'warn'
      )
    );
  }

  const metricsDue = (analyticsData?.metrics_due || []).filter(
    (p) => !homeBrand || String(p.brand_id) === String(homeBrand)
  );
  if (metricsDue.length) {
    rows.push(attentionRow(`${metricsDue.length} post(s) need metrics entered (48h+ since publish)`, '#/analytics', 'info'));
  }

  if (!rows.length) {
    list.appendChild(el('div', { class: 'attention-empty' }, 'All clear.'));
  } else {
    rows.forEach((r) => list.appendChild(r));
  }
  card.appendChild(list);
  container.appendChild(card);
}

function weekChip(p) {
  return el('a', { href: `#/post/${p.id}`, class: 'week-chip', style: `border-left-color:${brandColor(p.brand_id)}` }, [
    el('span', { class: 'week-chip-dot', style: `background:${brandColor(p.brand_id)}` }),
    el('span', { class: 'week-chip-platform' }, p.platform),
    el('span', { class: 'week-chip-copy' }, (p.copy || '(no copy)').slice(0, 28)),
    el('span', { class: 'week-chip-date' }, fmtDate(p.publish_at)),
  ]);
}

function buildWeekSection(container, posts) {
  container.innerHTML = '';
  const card = el('div', { class: 'card home-section' });
  const now = Date.now();
  const weekEnd = now + 7 * 24 * 3600 * 1000;
  const upcoming = posts
    .filter((p) => p.publish_at && new Date(p.publish_at).getTime() >= now && new Date(p.publish_at).getTime() <= weekEnd)
    .sort((a, b) => new Date(a.publish_at) - new Date(b.publish_at));

  card.appendChild(el('h2', {}, `This week - ${upcoming.length} scheduled`));
  const strip = el('div', { class: 'week-strip' });
  if (!upcoming.length) {
    strip.appendChild(el('div', { class: 'week-strip-empty' }, 'Nothing scheduled in the next 7 days.'));
  } else {
    upcoming.slice(0, 6).forEach((p) => strip.appendChild(weekChip(p)));
  }
  card.appendChild(strip);
  container.appendChild(card);
}

function buildPlatformChipsSection(container, posts, homeBrand) {
  container.innerHTML = '';
  const card = el('div', { class: 'card home-section' });
  card.appendChild(el('h2', {}, 'Platform status'));
  const accounts = homeBrand ? state.accounts.filter((a) => String(a.brand_id) === String(homeBrand)) : state.accounts;
  const row = el('div', { class: 'platform-chips' });

  if (!accounts.length) {
    row.appendChild(el('div', { class: 'platform-chips-empty' }, 'No connected accounts.'));
  }
  for (const acct of accounts) {
    const acctPosts = posts.filter((p) => String(p.account_id) === String(acct.id));
    const scheduledCount = acctPosts.filter((p) => ['approved', 'scheduled_local', 'submitted'].includes(p.status)).length;
    const published = acctPosts.filter((p) => p.status === 'published' && p.publish_at);
    const lastPublished = published.length
      ? published.reduce((max, p) => (new Date(p.publish_at) > new Date(max.publish_at) ? p : max)).publish_at
      : null;
    const failed = acctPosts.some((p) => p.status === 'failed');
    row.appendChild(
      el('div', { class: 'platform-chip' }, [
        el('span', { class: `health-dot ${failed ? 'bad' : 'ok'}`, title: failed ? 'Recent failure' : 'Healthy' }),
        el('span', { class: 'platform-chip-name' }, `${acct.platform} · ${brandName(acct.brand_id)}`),
        el('span', { class: 'platform-chip-meta' }, `${scheduledCount} scheduled`),
        el('span', { class: 'platform-chip-meta' }, lastPublished ? `last: ${fmtDate(lastPublished)}` : 'never published'),
      ])
    );
  }
  card.appendChild(row);
  container.appendChild(card);
}

const ANALYTICS_PERIODS = ['7d', '30d', '90d', 'all_time'];

function buildMiniAnalyticsSection(container, analyticsData, homeBrand) {
  container.innerHTML = '';
  const card = el('div', { class: 'card home-section' });
  card.appendChild(el('h2', {}, 'Analytics - last 30 days'));

  if (!analyticsData || !analyticsData.brands || !analyticsData.brands.length) {
    card.appendChild(el('div', { class: 'mini-analytics-empty' }, 'No metrics yet - add some on published posts.'));
    card.appendChild(el('div', { style: 'margin-top:10px;' }, [el('a', { href: '#/analytics' }, 'View full analytics →')]));
    container.appendChild(card);
    return;
  }

  const brandsData = homeBrand ? analyticsData.brands.filter((b) => String(b.brand_id) === String(homeBrand)) : analyticsData.brands;
  const agg = {};
  for (const period of ANALYTICS_PERIODS) {
    agg[period] = { impressions: 0, engagement: 0, posts_published: 0 };
    for (const b of brandsData) {
      const t = b.totals?.[period];
      if (!t) continue;
      agg[period].impressions += t.impressions || 0;
      agg[period].engagement += t.engagement || 0;
      agg[period].posts_published += t.posts_published || 0;
    }
  }
  const totals30 = agg['30d'];

  if (!totals30.impressions && !totals30.engagement && !totals30.posts_published) {
    card.appendChild(el('div', { class: 'mini-analytics-empty' }, 'No metrics yet - add some on published posts.'));
  } else {
    card.appendChild(
      el(
        'div',
        { class: 'mini-analytics-stats' },
        [
          ['Posts', totals30.posts_published],
          ['Impressions', totals30.impressions],
          ['Engagement', totals30.engagement],
        ].map(([label, value]) =>
          el('div', { class: 'mini-analytics-tile' }, [
            el('div', { class: 'mini-analytics-value' }, String(value)),
            el('div', { class: 'mini-analytics-label' }, label),
          ])
        )
      )
    );
    card.appendChild(
      svgLineChart(
        ANALYTICS_PERIODS.map((p) => ({ label: p === 'all_time' ? 'all' : p, value: agg[p].impressions })),
        { height: 100 }
      )
    );
  }
  card.appendChild(el('div', { style: 'margin-top:10px;' }, [el('a', { href: '#/analytics' }, 'View full analytics →')]));
  container.appendChild(card);
}

async function renderHome(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Home'));

  let homeBrand = getStickyBrand();
  const brandSelect = el('select', {}, [
    el('option', { value: '', selected: homeBrand ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: String(b.id), selected: String(b.id) === String(homeBrand) ? 'selected' : undefined }, b.name)
    ),
  ]);
  const filterRow = el('div', { class: 'toolbar' }, [el('span', {}, 'Brand:'), brandSelect]);
  view.appendChild(filterRow);

  const redistributeHost = el('div');
  redistributeHost.hidden = true;
  let redistributeOpen = false;
  function toggleRedistribute() {
    redistributeOpen = !redistributeOpen;
    redistributeHost.hidden = !redistributeOpen;
    redistributeHost.innerHTML = '';
    if (redistributeOpen) redistributeHost.appendChild(redistributeForm(() => homeBrand));
  }
  view.appendChild(homeQuickCreateBar(() => homeBrand, toggleRedistribute));
  view.appendChild(redistributeHost);

  const attentionHost = el('div');
  const weekHost = el('div');
  const platformHost = el('div');
  const analyticsHost = el('div');
  const calendarCard = el('div', { class: 'home-section' });
  calendarCard.appendChild(el('h2', { style: 'margin:8px 0 12px;' }, 'Calendar'));
  const calendarHost = el('div');
  calendarCard.appendChild(calendarHost);
  view.append(attentionHost, weekHost, platformHost, analyticsHost, calendarCard);

  async function refresh() {
    const [posts, analyticsData, profiles] = await Promise.all([
      api('/api/posts'),
      api('/api/analytics').catch(() => null),
      api('/api/profiles').catch(() => []), // B13: best-effort - endpoint may not exist yet, or may require brand_id
    ]);
    const filteredPosts = homeBrand ? posts.filter((p) => String(p.brand_id) === String(homeBrand)) : posts;
    const filteredProfiles = homeBrand ? (profiles || []).filter((p) => String(p.brand_id) === String(homeBrand)) : (profiles || []);
    buildAttentionSection(attentionHost, filteredPosts, analyticsData, homeBrand, filteredProfiles);
    buildWeekSection(weekHost, filteredPosts);
    buildPlatformChipsSection(platformHost, filteredPosts, homeBrand);
    buildMiniAnalyticsSection(analyticsHost, analyticsData, homeBrand);
    await renderCalendarInto(calendarHost, { initialBrand: homeBrand, defaultMode: 'week' });
  }

  brandSelect.onchange = () => {
    homeBrand = brandSelect.value;
    setStickyBrand(homeBrand);
    refresh();
  };

  await refresh();
}

// Keeps the local time-of-day, swaps in the day the chip was dropped on.
function rescheduleToDateKeepingTime(originalIso, newDateKey) {
  const [y, m, d] = newDateKey.split('-').map(Number);
  const dt = originalIso ? new Date(originalIso) : new Date();
  dt.setFullYear(y, m - 1, d);
  return dt.toISOString();
}

// Jump to the composer with "Publish at" prefilled to the clicked day (09:00
// local), carrying the calendar's current brand filter. See renderComposer.
function composeOnDate(dateKey) {
  sessionStorage.setItem('pd_composer_prefill_date', `${dateKey}T09:00`);
  const brandSel = document.getElementById('cal-brand');
  if (brandSel && brandSel.value) sessionStorage.setItem('pd_composer_prefill_brand', brandSel.value);
  location.hash = '#/composer';
}

// Local YYYY-MM-DD key (avoid toISOString's UTC shift moving posts a day).
function dateKeyLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function drawGrid(grid, posts, mode, refDate) {
  grid.innerHTML = '';
  const ref = refDate ? new Date(refDate) : new Date();
  ref.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayKey = dateKeyLocal(today);

  const byDay = {};
  for (const p of posts) {
    const key = p.publish_at ? p.publish_at.slice(0, 10) : 'unscheduled';
    (byDay[key] = byDay[key] || []).push(p);
  }

  function makeDropTarget(dayCell, dateKey) {
    dayCell.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      dayCell.classList.add('drop-target');
    });
    dayCell.addEventListener('dragleave', () => dayCell.classList.remove('drop-target'));
    dayCell.addEventListener('drop', (e) => {
      e.preventDefault();
      dayCell.classList.remove('drop-target');
      const postId = e.dataTransfer.getData('text/plain');
      if (postId && grid.reschedulePost) grid.reschedulePost(postId, dateKey, posts);
    });
  }

  function dayCellFor(d, { muted = false } = {}) {
    const key = dateKeyLocal(d);
    const dayPosts = byDay[key] || [];
    const cell = el('div', { class: 'cal-day' + (muted ? ' cal-muted' : '') + (key === todayKey ? ' cal-today' : '') }, [
      el('div', { class: 'day-label' }, mode === 'month'
        ? String(d.getDate())
        : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })),
      ...dayPosts.map((p) => postChip(p)),
    ]);
    makeDropTarget(cell, key);
    // Click an empty part of a day to schedule a new post on that date. Clicks
    // on a chip fall through to the chip's own link (open post detail).
    cell.classList.add('cal-clickable');
    cell.title = 'Click to schedule a post on this day';
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.chip')) return;
      composeOnDate(key);
    });
    return cell;
  }

  if (mode === 'month') {
    // Weekday header row, then a real month grid: leading blanks so the 1st
    // lands under its weekday, all days of the month, trailing days to fill
    // the last week. Cells from adjacent months are shown muted.
    const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    WD.forEach((w) => grid.appendChild(el('div', { class: 'cal-weekday' }, w)));
    const year = ref.getFullYear();
    const month = ref.getMonth();
    const first = new Date(year, month, 1);
    const startOffset = first.getDay(); // 0 = Sun
    const gridStart = new Date(year, month, 1 - startOffset);
    // 6 weeks (42 cells) covers every month layout; trim the last row if all-trailing.
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(gridStart);
      d.setDate(gridStart.getDate() + i);
      cells.push(d);
    }
    // Drop a trailing 6th row if it's entirely in the next month.
    const rows = cells[35].getMonth() === month || cells.slice(35).some((d) => d.getMonth() === month) ? 42 : 35;
    for (let i = 0; i < rows; i++) {
      const d = cells[i];
      grid.appendChild(dayCellFor(d, { muted: d.getMonth() !== month }));
    }
  } else {
    for (let i = 0; i < 7; i++) {
      const d = new Date(ref);
      d.setDate(ref.getDate() + i);
      grid.appendChild(dayCellFor(d));
    }
  }

  if (byDay.unscheduled?.length) {
    grid.appendChild(
      el('div', { class: 'cal-day cal-unscheduled' }, [
        el('div', { class: 'day-label' }, 'Unscheduled'),
        ...byDay.unscheduled.map((p) => postChip(p)),
      ])
    );
  }
}

function postChip(p) {
  const draggable = RESCHEDULABLE_STATUSES.includes(p.status);
  const chip = el(
    'a',
    {
      href: `#/post/${p.id}`,
      class: 'chip',
      style: `border-left-color:${brandColor(p.brand_id)}`,
      title: `${brandName(p.brand_id)} - ${p.platform} - ${p.status}${draggable ? ' (drag to reschedule)' : ''}`,
      draggable: draggable ? 'true' : 'false',
    },
    `${p.platform}: ${(p.copy || '(no copy)').slice(0, 24)}`
  );
  if (draggable) {
    chip.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(p.id));
      e.dataTransfer.effectAllowed = 'move';
    });
  } else {
    chip.addEventListener('dragstart', (e) => e.preventDefault());
  }
  const badge = el('span', { class: `pill status-${p.status}`, style: 'margin-left:4px;font-size:9px;' }, p.status);
  chip.appendChild(badge);
  return chip;
}

// ---------------- Post detail ----------------

async function renderPostDetail(view, params) {
  const id = params[0];
  const post = await api(`/api/posts/${id}`);
  view.innerHTML = '';
  view.appendChild(el('h1', {}, `Post #${post.id} - ${post.platform}`));
  view.appendChild(el('span', { class: `pill status-${post.status}` }, post.status));

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', {}, [el('strong', {}, 'Brand: '), brandName(post.brand_id)]));
  card.appendChild(el('div', {}, [el('strong', {}, 'Publish at: '), fmtDate(post.publish_at)]));
  card.appendChild(el('div', { style: 'margin-top:10px;white-space:pre-wrap;' }, post.copy || '(no copy)'));
  if (post.public_url) {
    card.appendChild(el('div', { style: 'margin-top:10px;' }, [el('a', { href: post.public_url, target: '_blank' }, post.public_url)]));
  }
  if (post.error_message) {
    card.appendChild(el('div', { class: 'msg-banner msg-error', style: 'margin-top:10px;' }, post.error_message));
  }
  if (post.media && post.media.length) {
    card.appendChild(el('div', { style: 'margin-top:10px;' }, `Media: ${post.media.map((m) => m.path).join(', ')}`));
  }
  view.appendChild(card);

  if (post.platform === 'blog') {
    const previewLink = el('a', { href: `/api/posts/${post.id}/preview`, target: '_blank' }, 'Open rendered preview →');
    view.appendChild(el('div', { class: 'card' }, previewLink));
  }

  // ---- Assisted-manual "Post now" panel (B7, generalized in B11) ----
  // Any account with manual===1, or whose platform is assisted-manual in
  // platform-specs (blotato:false, e.g. Reddit - not blog's separate
  // render_and_deploy flow), skips the worker/Blotato entirely. Once
  // scheduled_local and at/after publish_at, CB copies the copy (Reddit gets
  // its own title/body/subreddit treatment), opens the platform, posts by
  // hand, then marks it posted with the resulting URL (the only way it
  // reaches 'published').
  const postAccount = state.accounts.find((a) => String(a.id) === String(post.account_id));
  const isManualPost = postAccount ? isManualAccount(postAccount) : isManualPlatform(post.platform);
  if (isManualPost && post.status === 'scheduled_local') {
    const due = !post.publish_at || new Date(post.publish_at).getTime() <= Date.now();
    if (due) {
      const pf = post.platform_fields || {};
      const isReddit = post.platform === 'reddit';
      const panel = el('div', { class: 'card' });
      panel.appendChild(el('h2', {}, `Post now (${post.platform} - assisted-manual)`));
      if (isReddit) {
        panel.appendChild(el('div', {}, [el('strong', {}, 'Subreddit: '), `r/${pf.subreddit || '(none set)'}`]));
        panel.appendChild(el('div', { style: 'margin-top:6px;' }, [el('strong', {}, 'Title: '), pf.title || '(no title)']));
        panel.appendChild(el('div', { style: 'margin-top:6px;white-space:pre-wrap;' }, pf.body || post.copy || '(no body)'));
      } else {
        panel.appendChild(el('div', { style: 'margin-top:6px;white-space:pre-wrap;' }, post.copy || '(no copy)'));
      }

      const msg = el('div');
      const actions = el('div', { class: 'toolbar' });
      if (isReddit) {
        actions.appendChild(
          el('button', {
            onclick: async () => {
              await navigator.clipboard.writeText(pf.title || '');
              msg.innerHTML = '';
              msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Title copied.'));
            },
          }, 'Copy title')
        );
        actions.appendChild(
          el('button', {
            onclick: async () => {
              await navigator.clipboard.writeText(pf.body || post.copy || '');
              msg.innerHTML = '';
              msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Body copied.'));
            },
          }, 'Copy body')
        );
        if (pf.subreddit) {
          actions.appendChild(
            el('a', {
              class: 'button',
              href: `https://www.reddit.com/r/${encodeURIComponent(pf.subreddit)}/submit`,
              target: '_blank',
            }, 'Open subreddit →')
          );
        }
      } else {
        actions.appendChild(
          el('button', {
            onclick: async () => {
              await navigator.clipboard.writeText(post.copy || '');
              msg.innerHTML = '';
              msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Copy copied.'));
            },
          }, 'Copy')
        );
      }
      actions.appendChild(
        el('button', {
          class: 'primary',
          onclick: async () => {
            const url = prompt('Paste the published post URL:');
            if (!url) return;
            try {
              await api(`/api/posts/${post.id}/mark-posted`, { method: 'POST', body: { public_url: url } });
              router();
            } catch (err) {
              msg.innerHTML = '';
              msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
            }
          },
        }, 'Mark posted')
      );
      panel.appendChild(actions);
      panel.appendChild(msg);
      view.appendChild(panel);
    }
  }

  // status actions
  const actions = el('div', { class: 'toolbar' });
  if (post.status === 'draft') {
    actions.appendChild(
      el('button', {
        class: 'primary',
        onclick: async () => {
          // Soft quiet-hours warning (B6) - confirm, never a hard block.
          if (post.publish_at) {
            try {
              const check = await api(`/api/settings/quiet-hours-check?publish_at=${encodeURIComponent(post.publish_at)}`);
              if (check.within_quiet_hours) {
                const proceed = confirm(
                  `This post is scheduled for ${fmtDate(post.publish_at)}, inside quiet hours (${check.quiet_start}-${check.quiet_end}). Approve anyway?`
                );
                if (!proceed) return;
              }
            } catch {
              // quiet-hours check is best-effort; don't block Approve if it fails
            }
          }
          transition(post.id, 'approved');
        },
      }, 'Approve')
    );
    actions.appendChild(el('button', { class: 'danger', onclick: () => transition(post.id, 'canceled') }, 'Cancel'));
  } else if (post.status === 'approved' || post.status === 'scheduled_local') {
    actions.appendChild(el('button', { class: 'danger', onclick: () => transition(post.id, 'canceled') }, 'Cancel'));
  }
  if (['approved', 'scheduled_local'].includes(post.status)) {
    actions.appendChild(
      el('button', {
        class: 'primary',
        onclick: async () => {
          try {
            await api(`/api/posts/${post.id}/submit`, { method: 'POST' });
            router();
          } catch (err) {
            alert(err.message);
          }
        },
      }, 'Submit now')
    );
  }
  view.appendChild(actions);

  async function transition(postId, status) {
    try {
      await api(`/api/posts/${postId}`, { method: 'PATCH', body: { status } });
      router();
    } catch (err) {
      alert(err.message);
    }
  }

  // metrics
  view.appendChild(el('h2', {}, 'Metrics'));
  const metricsTable = el('div', {}, (post.metrics || []).map((m) =>
    el('div', { class: 'card' }, `${m.captured_at}: impressions ${m.impressions ?? '-'}, comments ${m.comments ?? '-'}, shares ${m.shares ?? '-'}, saves ${m.saves ?? '-'}, follows ${m.follows ?? '-'}, dms ${m.dms ?? '-'}, leads ${m.leads ?? '-'}`)
  ));
  view.appendChild(metricsTable);

  const form = el('div', { class: 'card' });
  const fields = ['impressions', 'comments', 'shares', 'saves', 'profile_visits', 'follows', 'dms', 'leads'];
  const inputs = {};
  const fieldGrid = el('div', { style: 'display:grid;grid-template-columns:repeat(4,1fr);gap:8px;' });
  for (const f of fields) {
    const input = el('input', { type: 'number', placeholder: f });
    inputs[f] = input;
    fieldGrid.appendChild(el('div', { class: 'field-row' }, [el('label', {}, f), input]));
  }
  form.appendChild(fieldGrid);
  const notes = el('textarea', { placeholder: 'notes', rows: '2' });
  form.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'notes'), notes]));
  form.appendChild(
    el('button', {
      class: 'primary',
      onclick: async () => {
        const body = { notes: notes.value };
        for (const f of fields) {
          const v = inputs[f].value;
          if (v !== '') body[f] = Number(v);
        }
        await api(`/api/posts/${post.id}/metrics`, { method: 'POST', body });
        router();
      },
    }, 'Save metrics')
  );
  view.appendChild(form);

  view.appendChild(el('h2', {}, 'Status history'));
  view.appendChild(
    el('ul', { class: 'history-list' }, [
      el('li', {}, `Created: ${post.created_at}`),
      el('li', {}, `Last updated: ${post.updated_at} - current status: ${post.status}`),
    ])
  );

  // ---- Edit (B6): copy + platform_fields (TikTok flags / blog title-slug-hero) ----
  // Only while the post hasn't been handed off to Blotato yet - matches the
  // drag-to-reschedule window (RESCHEDULABLE_STATUSES) enforced server-side.
  if (RESCHEDULABLE_STATUSES.includes(post.status)) {
    view.appendChild(el('h2', {}, 'Edit'));
    const editCard = el('div', { class: 'card' });

    const copyArea = el('textarea', { rows: '6' });
    copyArea.value = post.copy || '';
    editCard.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Copy'), copyArea]));

    const editableFields = { ...(post.platform_fields || {}) };
    if (post.platform === 'blog') {
      const mediaFiles = await api('/api/media').catch(() => []);
      editCard.appendChild(blogFieldsEditor(editableFields, mediaFiles));
    } else if (post.platform === 'tiktok') {
      editCard.appendChild(tiktokFieldsEditor(editableFields));
    } else if (post.platform === 'reddit') {
      editCard.appendChild(redditFieldsEditor(editableFields));
    }

    const publishAtEdit = el('input', { type: 'datetime-local' });
    if (post.publish_at) publishAtEdit.value = post.publish_at.slice(0, 16);
    editCard.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Publish at'), publishAtEdit]));

    const editMsg = el('div');
    editCard.appendChild(
      el('button', {
        class: 'primary',
        onclick: async () => {
          editMsg.innerHTML = '';
          try {
            await api(`/api/posts/${post.id}`, {
              method: 'PATCH',
              body: {
                copy: copyArea.value,
                platform_fields: editableFields,
                publish_at: publishAtEdit.value ? new Date(publishAtEdit.value).toISOString() : null,
              },
            });
            router();
          } catch (err) {
            editMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        },
      }, 'Save changes')
    );
    editCard.appendChild(editMsg);
    view.appendChild(editCard);
  }
}

// ---------------- Ideas board ----------------

const IDEA_STATUSES = ['idea', 'clustered', 'drafted', 'done'];

async function renderIdeas(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Ideas Board'));

  const quickAdd = el('div', { class: 'toolbar' });
  const titleInput = el('input', { placeholder: 'New idea title…', style: 'width:260px' });
  const brandSelect = el('select', {}, [
    el('option', { value: '' }, '(no brand)'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const pillarInput = el('input', { placeholder: 'pillar (optional)' });
  quickAdd.append(
    titleInput,
    brandSelect,
    pillarInput,
    el('button', {
      class: 'primary',
      onclick: async () => {
        if (!titleInput.value.trim()) return;
        await api('/api/ideas', {
          method: 'POST',
          body: { title: titleInput.value.trim(), brand_id: brandSelect.value || null, pillar: pillarInput.value || null },
        });
        renderIdeas(view);
      },
    }, '+ Add idea')
  );
  view.appendChild(quickAdd);

  const ideas = await api('/api/ideas');
  const board = el('div', { class: 'kanban' });
  for (const status of IDEA_STATUSES) {
    const col = el('div', { class: 'kanban-col' });
    col.appendChild(el('h3', {}, status));
    for (const idea of ideas.filter((i) => i.status === status)) {
      col.appendChild(ideaCard(idea));
    }
    board.appendChild(col);
  }
  view.appendChild(board);

  function ideaCard(idea) {
    const select = el(
      'select',
      {
        onchange: async (e) => {
          await api(`/api/ideas/${idea.id}`, { method: 'PATCH', body: { status: e.target.value } });
          renderIdeas(view);
        },
      },
      [...IDEA_STATUSES, 'killed'].map((s) => el('option', { value: s, selected: s === idea.status ? 'selected' : undefined }, s))
    );
    return el('div', { class: 'idea-card' }, [
      el('div', {}, idea.title),
      el('div', { class: 'meta' }, `${idea.brand_id ? brandName(idea.brand_id) : 'no brand'}${idea.pillar ? ' · ' + idea.pillar : ''}`),
      select,
    ]);
  }
}

// ---------------- Library ----------------

async function renderLibrary(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Media Library'));

  const uploadRow = el('div', { class: 'toolbar' });
  const fileInput = el('input', { type: 'file' });
  uploadRow.append(
    fileInput,
    el('button', {
      class: 'primary',
      onclick: async () => {
        if (!fileInput.files.length) return;
        const fd = new FormData();
        fd.append('file', fileInput.files[0]);
        await api('/api/media', { method: 'POST', body: fd });
        renderLibrary(view);
      },
    }, 'Upload')
  );
  view.appendChild(uploadRow);

  const files = await api('/api/media');
  const grid = el('div', { class: 'media-grid' });
  for (const f of files) {
    const isImage = /\.(png|jpe?g|gif|webp)$/i.test(f.filename);
    grid.appendChild(
      el('div', { class: 'media-card' }, [
        isImage ? el('img', { src: f.url, alt: f.filename }) : el('div', { style: 'height:100px;display:flex;align-items:center;justify-content:center;color:var(--muted);' }, 'file'),
        el('div', { class: 'meta' }, f.filename),
      ])
    );
  }
  view.appendChild(grid);
}

// ---------------- Composer ----------------

async function renderComposer(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Composer'));

  // One-off "Publish at" prefill when arriving from a calendar day click
  // (composeOnDate). Consumed once; applied to publishAtInput in loadForBrand.
  let prefillDate = sessionStorage.getItem('pd_composer_prefill_date');
  sessionStorage.removeItem('pd_composer_prefill_date');

  const brandSelect = el('select', {}, [
    el('option', { value: '' }, 'Select brand…'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const toolbar = el('div', { class: 'toolbar' }, [el('span', {}, 'Brand:'), brandSelect]);
  view.appendChild(toolbar);

  // ---- Redistribute-from-blog (B11) - collapsible, reuses the Home form ----
  const redistributeHost = el('div');
  redistributeHost.hidden = true;
  let redistributeOpen = false;
  const redistributeToggleBtn = el('button', {
    onclick: () => {
      redistributeOpen = !redistributeOpen;
      redistributeHost.hidden = !redistributeOpen;
      redistributeHost.innerHTML = '';
      if (redistributeOpen) redistributeHost.appendChild(redistributeForm(() => brandSelect.value));
    },
  }, 'Redistribute a blog post');
  view.appendChild(el('div', { class: 'toolbar' }, [redistributeToggleBtn]));
  view.appendChild(redistributeHost);

  const body = el('div', {});
  view.appendChild(body);

  let selectedAccounts = new Set();
  let ideaText = '';
  let currentTab = null;
  const draftsByPlatform = {};
  let contentType = '';
  let pillarText = '';
  let attachedImage = null; // { path, url, altText } - picked from the Library

  async function loadForBrand(brandId) {
    body.innerHTML = '';
    if (!brandId) return;
    const accounts = state.accounts.filter((a) => String(a.brand_id) === String(brandId));
    // B12: default the tone dropdown to the brand's saved default tone
    // (settings key brand_<id>_default_tone, set from #/settings) - falls
    // back to 'business' if unset or the settings call fails.
    let defaultTone = 'business';
    // B15: default the AI provider from the draft_provider setting, unless
    // the operator already picked one earlier this session (sessionDraftProvider).
    let currentProvider = sessionDraftProvider || 'claude';
    try {
      const settings = await api('/api/settings');
      const saved = settings?.[`brand_${brandId}_default_tone`];
      if (saved && ['business', 'personal', 'casual'].includes(saved)) defaultTone = saved;
      if (!sessionDraftProvider && settings?.draft_provider === 'codex') currentProvider = 'codex';
    } catch {
      // best-effort only - falls back to 'business' / 'claude'
    }
    const toneSelect = el(
      'select',
      {},
      ['business', 'personal', 'casual'].map((t) =>
        el('option', { value: t, selected: t === defaultTone ? 'selected' : undefined }, t)
      )
    );
    // Per-platform structured fields (TikTok flags, blog title/slug/hero),
    // mutated in place by tiktokFieldsEditor/blogFieldsEditor so they survive
    // switching tabs. Persisted into posts.platform_fields on Save draft.
    const platformFieldsByPlatform = {};
    const mediaFiles = await api('/api/media').catch(() => []);

    // ---- Distribute-to row (B11: + per-account "manual" toggle + badge) ----
    // Widening an account to manual=1 makes it assisted-manual (compose ->
    // copy -> open platform -> mark posted) even if its platform normally
    // auto-posts via Blotato; the worker skips it accordingly (SPEC.md B11).
    function accountRow(a) {
      const cb = el('input', { type: 'checkbox' });
      cb.addEventListener('change', () => {
        if (cb.checked) selectedAccounts.add(a.id);
        else selectedAccounts.delete(a.id);
        renderPlatformTabs();
        updateContentTypeSuggestion();
        renderImagePreview();
      });
      const limit = textLimitFor(a.platform);
      const limitStr = limit == null ? 'no char limit' : `${limit} char limit`;

      const badgeHost = el('span', { style: 'margin-left:8px;' });
      function renderBadge() {
        badgeHost.innerHTML = '';
        if (isManualAccount(a)) {
          badgeHost.appendChild(el('span', { class: 'pill manual-pill' }, 'manual - copy & paste'));
        }
      }
      renderBadge();

      const platformForced = isManualPlatform(a.platform);
      const manualToggle = el('input', { type: 'checkbox' });
      manualToggle.checked = Number(a.manual) === 1;
      if (platformForced) manualToggle.disabled = true; // already assisted-manual by platform, nothing to toggle
      manualToggle.addEventListener('change', async () => {
        const next = manualToggle.checked ? 1 : 0;
        try {
          const updated = await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { manual: next } });
          a.manual = updated?.manual ?? next;
          renderBadge();
          renderPlatformTabs(); // re-render in case the current tab's copy/mark-posted affordance changed
        } catch (err) {
          manualToggle.checked = !manualToggle.checked; // revert on failure
          alert(`Could not update manual flag: ${err.message}`);
        }
      });
      const manualLabel = el(
        'label',
        { class: 'manual-toggle-label', title: platformForced ? 'Already assisted-manual for this platform' : 'Mark as assisted-manual (copy & paste instead of auto-post)' },
        [manualToggle, ' manual']
      );

      return el('div', { class: 'account-row', style: 'display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:6px;' }, [
        el('label', {}, [cb, ` ${a.platform} (account #${a.id}) - ${limitStr}`]),
        manualLabel,
        badgeHost,
      ]);
    }

    const accountsBox = el('div', { class: 'card' }, [
      el('h2', {}, 'Distribute to (accounts, auto-filtered by brand)'),
      ...accounts.map(accountRow),
    ]);
    body.appendChild(accountsBox);

    // ---- Content-type picker + recommender (B8) ----
    const contentTypeBox = el('div', { class: 'card' });
    contentTypeBox.appendChild(el('h2', {}, 'Content type'));
    const contentTypeSelect = el(
      'select',
      { onchange: (e) => { contentType = e.target.value; renderImagePreview(); } },
      [el('option', { value: '' }, '(unset)'), ...['static', 'carousel', 'image', 'text', 'video'].map((t) => el('option', { value: t }, t))]
    );
    const pillarInput = el('input', { placeholder: 'pillar (optional, for recommender)' });
    pillarInput.oninput = () => { pillarText = pillarInput.value; updateContentTypeSuggestion(); };
    const suggestionLine = el('div', { style: 'color:var(--muted);font-size:12px;margin-top:6px;' });
    contentTypeBox.append(
      el('div', { class: 'field-row' }, [el('label', {}, 'Content type'), contentTypeSelect]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Pillar'), pillarInput]),
      suggestionLine
    );
    body.appendChild(contentTypeBox);

    async function updateContentTypeSuggestion() {
      suggestionLine.textContent = '';
      if (!currentTab) return;
      try {
        const qs = new URLSearchParams({ brand_id: brandId, platform: currentTab });
        if (pillarText) qs.set('pillar', pillarText);
        const rec = await api(`/api/recommend/content-type?${qs.toString()}`);
        suggestionLine.textContent = `Suggested: ${rec.suggestion}${rec.ranked?.[0]?.reason ? ` - ${rec.ranked[0].reason}` : ''}`;
      } catch {
        // best-effort only - recommender is a convenience, never blocks the composer
      }
    }

    // ---- Attached image (B8 - feeds alt-text/preview/Codex handoff) ----
    const imageBox = el('div', { class: 'card' });
    imageBox.appendChild(el('h2', {}, 'Attached image'));
    const imageSelect = el(
      'select',
      {},
      [
        el('option', { value: '' }, '(no image)'),
        ...mediaFiles
          .filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.filename))
          .map((f) => el('option', { value: f.path }, f.filename)),
      ]
    );
    imageSelect.onchange = () => {
      const f = mediaFiles.find((x) => x.path === imageSelect.value);
      attachedImage = f ? { path: f.path, url: f.url, altText: attachedImage?.path === f.path ? attachedImage.altText : '' } : null;
      renderImagePreview();
    };
    imageBox.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'From Library'), imageSelect]));
    const previewHost = el('div');
    imageBox.appendChild(previewHost);
    body.appendChild(imageBox);

    function renderImagePreview() {
      previewHost.innerHTML = '';
      if (!attachedImage) return;
      previewHost.appendChild(
        el('div', { style: 'margin-top:8px;' }, [
          el('img', { src: attachedImage.url, style: 'max-width:160px;max-height:160px;border-radius:6px;border:1px solid var(--border);display:block;' }),
        ])
      );
      const altInput = el('input', { placeholder: 'Alt text', value: attachedImage.altText || '' });
      altInput.oninput = () => { attachedImage.altText = altInput.value; };
      previewHost.appendChild(el('div', { class: 'field-row', style: 'margin-top:6px;' }, [el('label', {}, 'Alt text'), altInput]));
      previewHost.appendChild(multiSizePreviewPanel());
    }

    // ---- Multi-size preview (B8 - frontend-only, canvas-native crop preview) ----
    function multiSizePreviewPanel() {
      const platforms = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean);
      if (!attachedImage || !platforms.length) return el('div');
      const panel = el('div', { class: 'preview-sizes' });
      panel.appendChild(el('h3', { style: 'margin-top:10px;' }, 'Preview sizes'));
      const row = el('div', { class: 'preview-sizes-row' });
      for (const platform of [...new Set(platforms)]) {
        const rawDims = platformImageDimsRaw(platform, contentType);
        const dims = parseDimsClient(rawDims);
        const frame = el('div', { class: 'preview-frame' });
        const label = el('div', { style: 'font-size:11px;color:var(--muted);margin-bottom:4px;' }, `${platform} - ${dims.raw || 'no spec'}`);
        const box = el('div', { class: 'preview-box' });
        if (dims.w && dims.h) {
          box.style.aspectRatio = `${dims.w} / ${dims.h}`;
        } else {
          box.style.aspectRatio = '1 / 1';
        }
        const img = el('img', { src: attachedImage.url, style: 'width:100%;height:100%;object-fit:cover;' });
        box.appendChild(img);
        frame.append(label, box);
        if (!dims.w) frame.appendChild(el('div', { style: 'font-size:10px;color:var(--red);margin-top:2px;' }, 'no dims spec - verify manually'));
        row.appendChild(frame);
      }
      panel.appendChild(row);
      return panel;
    }

    const aiBox = el('div', { class: 'card' });
    aiBox.appendChild(el('h2', {}, 'Draft with AI'));
    const ideaInput = el('textarea', { rows: '3', placeholder: 'Idea text…', id: 'ai-idea-input' });
    ideaInput.oninput = () => (ideaText = ideaInput.value);
    aiBox.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Idea'), ideaInput]));
    aiBox.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Tone'), toneSelect]));
    // B15: provider switch - shared with the copy-assist panel below via the
    // currentProvider closure var, defaults from the draft_provider setting.
    const providerSwitchEl = providerSwitch(currentProvider, (v) => {
      currentProvider = v;
      sessionDraftProvider = v;
    });
    aiBox.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Model'), providerSwitchEl]));
    const aiMsg = el('div');
    aiBox.appendChild(aiMsg);
    const draftButtonsRow = el('div', { class: 'toolbar', style: 'margin-top:4px;' });
    draftButtonsRow.appendChild(
      el('button', {
        class: 'primary',
        onclick: async () => {
          aiMsg.innerHTML = '';
          compareHost.innerHTML = '';
          const platforms = [...selectedAccounts]
            .map((id) => accounts.find((a) => a.id === id)?.platform)
            .filter(Boolean);
          if (!ideaText.trim() || !platforms.length) {
            aiMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one account and enter an idea first.'));
            return;
          }
          try {
            const tp = await findToneProfileId(brandId, toneSelect.value);
            const result = await api('/api/draft', {
              method: 'POST',
              body: { idea_text: ideaText, brand_id: Number(brandId), tone_profile_id: tp, platforms, provider: currentProvider },
            });
            Object.assign(draftsByPlatform, result.drafts);
            renderPlatformTabs();
            aiMsg.appendChild(
              el('div', { class: 'msg-banner msg-ok' }, `Drafts populated. Scrub applied: ${result.scrub_applied.join(', ') || 'none'}`)
            );
          } catch (err) {
            aiMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, `AI drafting unavailable: ${err.message}`));
          }
        },
      }, 'Draft with AI')
    );
    const compareHost = el('div');
    draftButtonsRow.appendChild(
      el('button', {
        onclick: async () => {
          aiMsg.innerHTML = '';
          compareHost.innerHTML = '';
          const platforms = [...selectedAccounts]
            .map((id) => accounts.find((a) => a.id === id)?.platform)
            .filter(Boolean);
          if (!ideaText.trim() || !platforms.length) {
            aiMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one account and enter an idea first.'));
            return;
          }
          compareHost.appendChild(el('div', { class: 'msg-banner', style: 'color:var(--muted);' }, 'Running Claude and Codex - this can take a moment…'));
          try {
            const tp = await findToneProfileId(brandId, toneSelect.value);
            const cmp = await api('/api/draft/compare', {
              method: 'POST',
              body: { idea_text: ideaText, brand_id: Number(brandId), tone_profile_id: tp, platforms },
            });
            compareHost.innerHTML = '';
            const grid = el('div', { class: 'compare-grid' });
            for (const p of AI_PROVIDERS) {
              grid.appendChild(compareColumn(p.label, p.value, cmp?.[p.value]));
            }
            compareHost.appendChild(grid);
          } catch (err) {
            compareHost.innerHTML = '';
            compareHost.appendChild(
              el('div', { class: 'msg-banner msg-error' }, `Compare unavailable: ${err.message}`)
            );
          }
        },
      }, 'Compare both')
    );
    aiBox.appendChild(draftButtonsRow);
    aiBox.appendChild(compareHost);

    // ---- Compare-both column (B15) - one side of the Claude vs Codex
    // side-by-side. `side` is `{result: {drafts, scrub_applied}} | {error}`.
    function compareColumn(label, providerValue, side) {
      const col = el('div', { class: 'compare-col' });
      col.appendChild(el('h3', {}, label));
      if (!side || side.error) {
        const errText = side?.error || 'unavailable';
        const friendly = providerValue === 'codex'
          ? `Codex unavailable - sign into the Codex CLI (codex login). (${errText})`
          : `Claude unavailable - sign into the Claude CLI (claude /login). (${errText})`;
        col.appendChild(el('div', { class: 'msg-banner msg-error compare-col-error' }, friendly));
        return col;
      }
      const drafts = side.result?.drafts || side.drafts;
      if (!drafts || !Object.keys(drafts).length) {
        col.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'No drafts returned.'));
        return col;
      }
      for (const [platform, text] of Object.entries(drafts)) {
        col.appendChild(el('div', { style: 'font-size:11px;color:var(--muted);margin-top:8px;' }, platform));
        col.appendChild(el('div', { class: 'compare-draft-text' }, text));
      }
      col.appendChild(
        el('button', {
          class: 'primary',
          style: 'margin-top:8px;',
          onclick: () => {
            Object.assign(draftsByPlatform, drafts);
            renderPlatformTabs();
            aiMsg.innerHTML = '';
            aiMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, `Filled composer fields from ${label}.`));
          },
        }, 'Use this')
      );
      return col;
    }
    body.appendChild(aiBox);

    const composerBox = el('div', { class: 'card' });
    composerBox.appendChild(el('h2', {}, 'Platform variants'));
    const tabsRow = el('div', { class: 'tabs' });
    const editorHost = el('div');
    composerBox.appendChild(tabsRow);
    composerBox.appendChild(editorHost);
    body.appendChild(composerBox);

    const publishAtInput = el('input', { type: 'datetime-local' });
    if (prefillDate) { publishAtInput.value = prefillDate; prefillDate = null; } // from a calendar day click, applied once
    body.appendChild(el('div', { class: 'card' }, [el('div', { class: 'field-row' }, [el('label', {}, 'Publish at'), publishAtInput])]));

    const saveRow = el('div', { class: 'toolbar' });
    const savedMsg = el('div');
    saveRow.appendChild(
      el('button', {
        class: 'primary',
        onclick: async () => {
          const platforms = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
          if (!platforms.length) return;
          savedMsg.innerHTML = '';
          const media = attachedImage ? [{ path: attachedImage.path, altText: attachedImage.altText || '' }] : [];
          for (const acct of platforms) {
            const fields = platformFieldsByPlatform[acct.platform] || {};
            // Reddit has no free-text "copy" tab of its own - its body IS the
            // copy (mirrored so calendar chips/exports show something useful).
            const copy = acct.platform === 'reddit' ? (fields.body || '') : (draftsByPlatform[acct.platform] || '');
            await api('/api/posts', {
              method: 'POST',
              body: {
                brand_id: Number(brandId),
                account_id: acct.id,
                platform: acct.platform,
                copy,
                platform_fields: fields,
                content_type: contentType || null,
                media,
                publish_at: publishAtInput.value ? new Date(publishAtInput.value).toISOString() : null,
              },
            });
          }
          savedMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Draft(s) saved. Go to Calendar to approve.'));
        },
      }, 'Save draft')
    );
    // ---- Image request options (B14) - CB picks how many variants Codex
    // drops + optional size/type hints, seeded per platform-specs.json but
    // never hardcoded to a fixed count.
    const imageOptsCard = el('div', { class: 'card' });
    imageOptsCard.appendChild(el('h2', {}, 'Image request options'));
    const variantCountSelect = el(
      'select',
      {},
      [1, 2, 3, 4, 5, 6].map((n) => el('option', { value: String(n), selected: n === 1 ? 'selected' : undefined }, `${n} variant${n > 1 ? 's' : ''}`))
    );
    const sizeHintSelect = el('select', {}, [
      el('option', { value: '' }, '(no size hint)'),
      el('option', { value: 'vertical' }, 'Vertical 9:16'),
      el('option', { value: 'square' }, 'Square 1:1'),
      el('option', { value: 'portrait' }, 'Portrait 4:5'),
      el('option', { value: 'landscape' }, 'Landscape 16:9'),
    ]);
    const typeHintSelect = el('select', {}, [
      el('option', { value: '' }, '(no type hint)'),
      el('option', { value: 'thumbnail' }, 'Thumbnail'),
      el('option', { value: 'feed' }, 'Feed post'),
      el('option', { value: 'story' }, 'Story'),
    ]);
    imageOptsCard.appendChild(
      el('div', { class: 'composer-grid' }, [
        el('div', { class: 'field-row' }, [el('label', {}, 'Variant count'), variantCountSelect]),
        el('div', { class: 'field-row' }, [el('label', {}, 'Size / orientation'), sizeHintSelect]),
        el('div', { class: 'field-row' }, [el('label', {}, 'Type'), typeHintSelect]),
      ])
    );
    body.appendChild(imageOptsCard);

    const imageReqMsg = el('div');
    saveRow.appendChild(
      el('button', {
        onclick: async () => {
          imageReqMsg.innerHTML = '';
          const platforms = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean);
          if (!platforms.length) {
            imageReqMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one account first.'));
            return;
          }
          const copy = currentTab === 'reddit' ? (platformFieldsByPlatform.reddit?.body || '') : (draftsByPlatform[currentTab] || '');
          const hints = {};
          if (sizeHintSelect.value) hints.size = sizeHintSelect.value;
          if (typeHintSelect.value) hints.type = typeHintSelect.value;
          try {
            const res = await api('/api/image-requests', {
              method: 'POST',
              body: {
                brand_id: Number(brandId),
                platforms,
                content_type: contentType || null,
                copy,
                variant_count: Number(variantCountSelect.value) || 1,
                hints,
              },
            });
            imageReqMsg.appendChild(
              el('div', { class: 'msg-banner msg-ok' }, `Request #${res.id} written - Codex will drop variants into the Images view.`)
            );
          } catch (err) {
            imageReqMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        },
      }, 'Request image (Codex)')
    );
    body.appendChild(saveRow);
    body.appendChild(savedMsg);
    body.appendChild(imageReqMsg);

    // ---- Copy-assist panel (B8) - Headlines / Hashtags / Alt text buttons,
    // shared across platform editors. Results insert into the copy field the
    // caller passes via getCopy/setCopy; alt text writes to attachedImage.
    function copyAssistPanel({ getCopy, setCopy, platform }) {
      const box = el('div', { class: 'copy-assist-box' });
      const switchRow = el('div', { class: 'field-row', style: 'max-width:220px;' }, [
        el('label', {}, 'Model'),
        providerSwitch(currentProvider, (v) => { currentProvider = v; sessionDraftProvider = v; }),
      ]);
      const btnRow = el('div', { class: 'toolbar', style: 'margin-top:8px;margin-bottom:4px;' });
      const msg = el('div');
      const resultHost = el('div');

      async function runAssist(mode) {
        msg.innerHTML = '';
        resultHost.innerHTML = '';
        try {
          const tp = await findToneProfileId(brandId, toneSelect.value).catch(() => null);
          const platforms = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean);
          const res = await api('/api/copy-assist', {
            method: 'POST',
            body: {
              mode,
              idea_text: ideaText,
              copy: getCopy(),
              brand_id: Number(brandId),
              tone_profile_id: tp,
              platforms,
              image_path: attachedImage?.path,
              provider: currentProvider,
            },
          });
          if (res.result?.headlines?.length) {
            const chipRow = el('div', { class: 'chip-row' });
            for (const h of res.result.headlines) {
              chipRow.appendChild(el('button', { class: 'chip-btn', onclick: () => setCopy(h) }, h));
            }
            resultHost.appendChild(
              el('div', { style: 'margin-top:6px;' }, [el('div', { style: 'font-size:11px;color:var(--muted);' }, 'Headlines (click to insert):'), chipRow])
            );
          }
          if (res.result?.hashtags) {
            const tags = res.result.hashtags[platform] || Object.values(res.result.hashtags).flat();
            if (tags?.length) {
              const chipRow = el('div', { class: 'chip-row' });
              for (const t of tags) {
                chipRow.appendChild(
                  el('button', { class: 'chip-btn', onclick: () => { const cur = getCopy(); setCopy(cur + (cur && !cur.endsWith(' ') ? ' ' : '') + t); } }, t)
                );
              }
              resultHost.appendChild(
                el('div', { style: 'margin-top:6px;' }, [el('div', { style: 'font-size:11px;color:var(--muted);' }, 'Hashtags (click to append):'), chipRow])
              );
            }
          }
          if (res.result?.alt_text) {
            resultHost.appendChild(
              el('div', { style: 'margin-top:6px;' }, [
                el('div', { style: 'font-size:11px;color:var(--muted);' }, 'Alt text:'),
                el('div', { style: 'font-size:12px;' }, res.result.alt_text),
                el('button', {
                  onclick: () => {
                    if (attachedImage) {
                      attachedImage.altText = res.result.alt_text;
                      renderImagePreview();
                    }
                  },
                }, 'Use as alt text'),
              ])
            );
          }
          if (res.scrub_applied?.length) {
            msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, `Scrub applied: ${res.scrub_applied.join(', ')}`));
          }
        } catch (err) {
          if (err.status === 503) {
            const cliName = currentProvider === 'codex' ? 'codex CLI (codex login)' : 'claude CLI';
            msg.appendChild(el('div', { class: 'msg-banner msg-error' }, `AI unavailable (${cliName} not found or not signed in).`));
          } else {
            msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        }
      }

      btnRow.append(
        el('button', { onclick: () => runAssist('headlines') }, 'Headlines'),
        el('button', { onclick: () => runAssist('hashtags') }, 'Hashtags'),
        el('button', { onclick: () => runAssist('alt_text') }, 'Alt text')
      );
      box.append(switchRow, btnRow, msg, resultHost);
      return box;
    }

    function renderPlatformTabs() {
      tabsRow.innerHTML = '';
      editorHost.innerHTML = '';
      const platforms = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean);
      if (!platforms.length) {
        editorHost.appendChild(el('div', { style: 'color:var(--muted)' }, 'Select at least one account above.'));
        return;
      }
      if (!currentTab || !platforms.includes(currentTab)) currentTab = platforms[0];
      for (const p of platforms) {
        tabsRow.appendChild(
          el('button', { class: p === currentTab ? 'active' : '', onclick: () => { currentTab = p; renderPlatformTabs(); updateContentTypeSuggestion(); } }, p)
        );
      }
      editorHost.appendChild(platformEditor(currentTab));
      updateContentTypeSuggestion();
    }

    // ---- Examples panel (B11) - collapsible, per active platform. Paste text
    // or upload a screenshot (extract-once preview -> save); saved examples
    // show as chips and automatically ground /api/copy-assist for this
    // brand+platform (server-side; nothing more to wire here).
    function examplesPanel(platform) {
      const container = el('div', { class: 'card examples-panel' });
      const collapseBody = el('div', { class: 'examples-body' });
      let open = false;
      const caret = el('span', { class: 'examples-caret' }, '▸');
      const header = el(
        'div',
        { class: 'examples-header', onclick: () => { open = !open; collapseBody.hidden = !open; caret.textContent = open ? '▾' : '▸'; } },
        [caret, el('h3', { style: 'margin:0;display:inline;' }, ' Examples to match')]
      );
      collapseBody.hidden = true;
      container.append(header, collapseBody);

      collapseBody.appendChild(
        el('div', { style: 'color:var(--muted);font-size:11px;margin:8px 0 10px;' },
          'Saved examples ground the Headlines/Hashtags copy-assist buttons above for this brand + platform.')
      );

      const chipsHost = el('div', { class: 'examples-chip-row' });
      collapseBody.appendChild(chipsHost);

      async function reloadExamples() {
        chipsHost.innerHTML = '';
        if (!brandId) return;
        try {
          const qs = new URLSearchParams({ brand_id: brandId, platform });
          const list = await api(`/api/examples?${qs.toString()}`);
          if (!list.length) {
            chipsHost.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'No saved examples yet.'));
            return;
          }
          for (const ex of list) {
            const text = ex.text || '';
            const chip = el('span', { class: 'example-chip' }, [
              el('span', { class: 'example-chip-text' }, text.length > 60 ? `${text.slice(0, 60)}…` : text || '(empty)'),
              el('button', {
                class: 'example-chip-x',
                title: 'Delete example',
                onclick: async () => {
                  try {
                    await api(`/api/examples/${ex.id}`, { method: 'DELETE' });
                    reloadExamples();
                  } catch (err) {
                    alert(err.message);
                  }
                },
              }, '×'),
            ]);
            chipsHost.appendChild(chip);
          }
        } catch (err) {
          chipsHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load examples: ${err.message}`));
        }
      }
      reloadExamples();

      // ---- Paste text ----
      const pasteArea = el('textarea', { rows: '3', placeholder: 'Paste an example post that nails the style/format…' });
      const pasteMsg = el('div');
      collapseBody.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Paste example text'), pasteArea]));
      collapseBody.appendChild(
        el('div', { class: 'toolbar' }, [
          el('button', {
            class: 'primary',
            onclick: async () => {
              pasteMsg.innerHTML = '';
              if (!pasteArea.value.trim()) return;
              if (!brandId) { pasteMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Select a brand first.')); return; }
              try {
                await api('/api/examples', { method: 'POST', body: { brand_id: Number(brandId), platform, source: 'paste', text: pasteArea.value } });
                pasteArea.value = '';
                pasteMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Example saved.'));
                reloadExamples();
              } catch (err) {
                pasteMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
              }
            },
          }, 'Save example'),
        ])
      );
      collapseBody.appendChild(pasteMsg);

      // ---- Upload screenshot (extract-once preview -> save) ----
      const fileInput = el('input', { type: 'file', accept: 'image/*' });
      const uploadMsg = el('div');
      const previewBox = el('div');
      collapseBody.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Upload screenshot'), fileInput]));
      collapseBody.appendChild(
        el('div', { class: 'toolbar' }, [
          el('button', {
            onclick: async () => {
              uploadMsg.innerHTML = '';
              previewBox.innerHTML = '';
              if (!fileInput.files.length) {
                uploadMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Choose a screenshot first.'));
                return;
              }
              const fd = new FormData();
              fd.append('image', fileInput.files[0]);
              try {
                const res = await api('/api/examples/extract-image', { method: 'POST', body: fd });
                const extracted = { text: res.text || '', image_path: res.image_path || null };
                previewBox.appendChild(
                  el('div', { class: 'examples-preview-box' }, [
                    el('div', { style: 'font-size:11px;color:var(--muted);margin-bottom:4px;' }, 'Extracted text:'),
                    el('div', { style: 'white-space:pre-wrap;font-size:12px;' }, extracted.text || '(empty)'),
                  ])
                );
                previewBox.appendChild(
                  el('button', {
                    class: 'primary',
                    style: 'margin-top:8px;',
                    onclick: async () => {
                      if (!brandId) { uploadMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Select a brand first.')); return; }
                      try {
                        await api('/api/examples', {
                          method: 'POST',
                          body: { brand_id: Number(brandId), platform, source: 'screenshot', text: extracted.text, image_path: extracted.image_path },
                        });
                        uploadMsg.innerHTML = '';
                        uploadMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Example saved.'));
                        previewBox.innerHTML = '';
                        fileInput.value = '';
                        reloadExamples();
                      } catch (err) {
                        uploadMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
                      }
                    },
                  }, 'Save this')
                );
              } catch (err) {
                if (err.status === 503 || err.data?.error === 'ai_unavailable') {
                  uploadMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Vision unavailable - paste the text manually above instead.'));
                } else {
                  uploadMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
                }
              }
            },
          }, 'Extract text from screenshot'),
        ])
      );
      collapseBody.appendChild(uploadMsg);
      collapseBody.appendChild(previewBox);

      return container;
    }

    function platformEditor(platform) {
      const fields = platformFieldsByPlatform[platform] || (platformFieldsByPlatform[platform] = {});
      const hintText = platformHint(platform);
      const hint = hintText
        ? el('div', { class: 'hint', style: 'color:var(--muted);font-size:12px;margin-bottom:6px;' }, hintText)
        : null;

      if (platform === 'reddit') {
        const assist = copyAssistPanel({
          getCopy: () => fields.body || '',
          setCopy: (v) => { fields.body = v; renderPlatformTabs(); },
          platform,
        });
        return el('div', {}, [hint, redditFieldsEditor(fields), assist, examplesPanel(platform)]);
      }

      if (platform === 'blog') {
        const bodyArea = el('textarea', { rows: '10', placeholder: 'Body (markdown)' });
        bodyArea.value = draftsByPlatform.blog || '';
        bodyArea.oninput = () => (draftsByPlatform.blog = bodyArea.value);
        const assist = copyAssistPanel({
          getCopy: () => draftsByPlatform.blog || '',
          setCopy: (v) => { draftsByPlatform.blog = v; renderPlatformTabs(); },
          platform,
        });
        return el('div', {}, [
          hint,
          blogFieldsEditor(fields, mediaFiles),
          el('div', { class: 'field-row' }, [el('label', {}, 'Body (markdown)'), bodyArea]),
          assist,
          examplesPanel(platform),
        ]);
      }
      const area = el('textarea', { rows: '8' });
      area.value = draftsByPlatform[platform] || '';
      const counter = el('div', { class: 'char-count' });
      function updateCounter() {
        const limit = textLimitFor(platform);
        const len = area.value.length;
        counter.textContent = limit == null ? `${len} chars (no limit)` : `${len} / ${limit}`;
        counter.classList.toggle('over', limit != null && len > limit);
      }
      area.oninput = () => {
        draftsByPlatform[platform] = area.value;
        updateCounter();
      };
      updateCounter();
      const assist = copyAssistPanel({
        getCopy: () => draftsByPlatform[platform] || '',
        setCopy: (v) => { draftsByPlatform[platform] = v; renderPlatformTabs(); },
        platform,
      });
      const wrap = el('div', {}, [hint, area, counter, assist]);
      if (platform === 'tiktok') {
        wrap.appendChild(tiktokFieldsEditor(fields));
      }
      wrap.appendChild(examplesPanel(platform));
      return wrap;
    }

    renderPlatformTabs();
  }

  brandSelect.onchange = () => {
    setStickyBrand(brandSelect.value);
    selectedAccounts = new Set();
    currentTab = null;
    loadForBrand(brandSelect.value);
  };

  // ---- Home cockpit hand-off (B9) ----
  // renderHome's quick-create bar stashes the current brand filter (and
  // whether "Draft with AI" was clicked) in sessionStorage before navigating
  // here, since hash params on this route are otherwise unused. Consumed
  // once so a later manual composer visit doesn't get auto-prefilled again.
  // Falls back to the sticky brand (B10) when there's no one-off prefill -
  // e.g. arriving via the FAB or a fresh tab.
  const prefillBrand = sessionStorage.getItem('pd_composer_prefill_brand');
  const focusAI = sessionStorage.getItem('pd_composer_focus_ai');
  sessionStorage.removeItem('pd_composer_prefill_brand');
  sessionStorage.removeItem('pd_composer_focus_ai');
  const effectiveBrand = prefillBrand || getStickyBrand();
  if (effectiveBrand && state.brands.some((b) => String(b.id) === String(effectiveBrand))) {
    brandSelect.value = effectiveBrand;
    setStickyBrand(effectiveBrand);
    await loadForBrand(effectiveBrand);
    if (focusAI) {
      setTimeout(() => {
        const ta = document.getElementById('ai-idea-input');
        if (ta) {
          ta.scrollIntoView({ block: 'center' });
          ta.focus();
        }
      }, 0);
    }
  }
}

async function findToneProfileId(brandId, toneName) {
  const tp = await api(`/api/tone-profiles?brand_id=${brandId}&name=${toneName}`);
  return tp.id;
}

// ---------------- Analytics (B7) ----------------

const ARROW_GLYPH = { up: '▲', down: '▼', flat: '▬' };
const ARROW_COLOR = { up: '#4c9a5b', down: '#c0392b', flat: 'var(--muted)' };

function deltaBadge(direction) {
  return el('span', { style: `color:${ARROW_COLOR[direction] || 'var(--muted)'};font-weight:bold;` }, ` ${ARROW_GLYPH[direction] || ''}`);
}

// Hand-rolled inline SVG bar chart - no chart library (SPEC.md "Analytics
// portal" keeps the no-dependency rule). `bars` = [{label, value}].
function svgBarChart(bars, { width = 420, height = 140, color = '#C8902A' } = {}) {
  const pad = 24;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const barWidth = bars.length ? (width - pad * 2) / bars.length : 0;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  bars.forEach((b, i) => {
    const barH = ((height - pad * 2) * b.value) / max;
    const x = pad + i * barWidth + barWidth * 0.15;
    const w = barWidth * 0.7;
    const y = height - pad - barH;

    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', x);
    rect.setAttribute('y', y);
    rect.setAttribute('width', Math.max(1, w));
    rect.setAttribute('height', Math.max(0, barH));
    rect.setAttribute('fill', color);
    rect.setAttribute('rx', '2');
    svg.appendChild(rect);

    const valueLabel = document.createElementNS(ns, 'text');
    valueLabel.setAttribute('x', x + w / 2);
    valueLabel.setAttribute('y', y - 4);
    valueLabel.setAttribute('text-anchor', 'middle');
    valueLabel.setAttribute('font-size', '10');
    valueLabel.setAttribute('fill', 'var(--text, #ccc)');
    valueLabel.textContent = String(b.value);
    svg.appendChild(valueLabel);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', x + w / 2);
    label.setAttribute('y', height - pad + 12);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', 'var(--muted, #888)');
    label.textContent = b.label;
    svg.appendChild(label);
  });

  return svg;
}

// Hand-rolled inline SVG line chart. `points` = [{label, value}], drawn in order.
function svgLineChart(points, { width = 420, height = 140, color = '#3d7ab8' } = {}) {
  const pad = 24;
  const max = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? (width - pad * 2) / (points.length - 1) : 0;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height);

  const coords = points.map((p, i) => {
    const x = pad + i * stepX;
    const y = height - pad - ((height - pad * 2) * p.value) / max;
    return [x, y];
  });

  const path = document.createElementNS(ns, 'polyline');
  path.setAttribute('points', coords.map(([x, y]) => `${x},${y}`).join(' '));
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', color);
  path.setAttribute('stroke-width', '2');
  svg.appendChild(path);

  coords.forEach(([x, y], i) => {
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', x);
    dot.setAttribute('cy', y);
    dot.setAttribute('r', '3');
    dot.setAttribute('fill', color);
    svg.appendChild(dot);

    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', x);
    label.setAttribute('y', height - pad + 12);
    label.setAttribute('text-anchor', 'middle');
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', 'var(--muted, #888)');
    label.textContent = points[i].label;
    svg.appendChild(label);
  });

  return svg;
}

function statRow(totals) {
  return el('div', { style: 'display:grid;grid-template-columns:repeat(6,1fr);gap:8px;text-align:center;' }, [
    ['Posts', totals.posts_published],
    ['Impressions', totals.impressions],
    ['Engagement', totals.engagement],
    ['Follows', totals.follows],
    ['DMs', totals.dms],
    ['Leads', totals.leads],
  ].map(([label, value]) =>
    el('div', {}, [
      el('div', { style: 'font-size:20px;font-weight:bold;' }, String(value)),
      el('div', { style: 'font-size:11px;color:var(--muted);' }, label),
    ])
  ));
}

async function renderAnalytics(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Analytics'));

  const data = await api('/api/analytics');

  if (data.metrics_due.length) {
    const due = el('div', { class: 'card' });
    due.appendChild(el('h2', {}, `Metrics due (${data.metrics_due.length})`));
    due.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:6px;' },
      'Published posts older than 48h with no metrics entered yet.'));
    for (const p of data.metrics_due) {
      due.appendChild(
        el('div', { class: 'card' }, [
          el('a', { href: `#/post/${p.id}` }, `#${p.id} - ${brandName(p.brand_id)} - ${p.platform}`),
          el('span', { style: 'color:var(--muted);margin-left:8px;' }, `published ${fmtDate(p.updated_at)}`),
        ])
      );
    }
    view.appendChild(due);
  }

  for (const brand of data.brands) {
    const card = el('div', { class: 'card' });
    const header = el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
      el('h2', { style: `border-left:4px solid ${brandColor(brand.brand_id)};padding-left:8px;` }, brand.name),
    ]);
    card.appendChild(header);

    const tabs = ['7d', '30d', '90d', 'all_time'];
    const tabsRow = el('div', { class: 'tabs' });
    const bodyHost = el('div');
    card.appendChild(tabsRow);
    card.appendChild(bodyHost);

    let activeTab = '7d';
    function renderTab() {
      tabsRow.innerHTML = '';
      bodyHost.innerHTML = '';
      for (const t of tabs) {
        tabsRow.appendChild(
          el('button', { class: t === activeTab ? 'active' : '', onclick: () => { activeTab = t; renderTab(); } },
            t === 'all_time' ? 'All-time' : t)
        );
      }
      bodyHost.appendChild(statRow(brand.totals[activeTab]));

      const wow = brand.week_over_week;
      bodyHost.appendChild(
        el('div', { style: 'margin-top:10px;' }, [
          el('strong', {}, 'Week over week: '),
          'Impressions', deltaBadge(wow.impressions),
          '  Engagement', deltaBadge(wow.engagement),
          '  Leads', deltaBadge(wow.leads),
        ])
      );

      const platforms = Object.entries(brand.by_platform).filter(([, v]) => v.impressions > 0 || v.engagement > 0);
      if (platforms.length) {
        bodyHost.appendChild(el('h3', { style: 'margin-top:16px;' }, 'Impressions by platform (30d)'));
        bodyHost.appendChild(svgBarChart(platforms.map(([p, v]) => ({ label: p, value: v.impressions }))));
      }

      bodyHost.appendChild(el('h3', { style: 'margin-top:16px;' }, 'Impressions trend (7d / 30d / 90d / all-time)'));
      bodyHost.appendChild(
        svgLineChart(
          ['7d', '30d', '90d', 'all_time'].map((t) => ({
            label: t === 'all_time' ? 'all' : t,
            value: brand.totals[t].impressions,
          }))
        )
      );

      const top10 = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px;' });
      const impCol = el('div', {}, [el('h3', {}, 'Top 10 by impressions')]);
      for (const p of brand.top10_by_impressions) {
        impCol.appendChild(
          el('div', {}, [el('a', { href: `#/post/${p.id}` }, `#${p.id} ${p.platform}`), ` - ${p.total_impressions} impressions`])
        );
      }
      const leadCol = el('div', {}, [el('h3', {}, 'Top 10 by leads')]);
      for (const p of brand.top10_by_leads) {
        leadCol.appendChild(
          el('div', {}, [el('a', { href: `#/post/${p.id}` }, `#${p.id} ${p.platform}`), ` - ${p.total_leads} leads`])
        );
      }
      top10.append(impCol, leadCol);
      bodyHost.appendChild(top10);
    }
    renderTab();

    view.appendChild(card);
  }
}

// ---------------- B8 shared helpers (image dims, usage recording is server-side) ----------------

// Client-side mirror of src/imagespec.js's parseDims - no import across the
// server/browser boundary, so this is intentionally duplicated in the same
// shape (SPEC.md B8 "Multi-size preview... reuse/add a small parser").
function parseDimsClient(raw) {
  if (typeof raw !== 'string') return { raw: raw ?? null };
  const m = raw.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!m) return { raw };
  const w = Number(m[1]);
  const h = Number(m[2]);
  const aspectMatch = raw.match(/\((\d+):(\d+)\)/);
  let aspect;
  if (aspectMatch) {
    aspect = `${aspectMatch[1]}:${aspectMatch[2]}`;
  } else {
    const gcd = (a, b) => { a = Math.abs(a); b = Math.abs(b); while (b) { [a, b] = [b, a % b]; } return a || 1; };
    const d = gcd(w, h) || 1;
    aspect = `${w / d}:${h / d}`;
  }
  return { w, h, aspect, raw };
}

// Mirrors src/imagespec.js's pickImageDimsRaw - picks the most relevant raw
// dims string out of a platform's `image` spec (varies a lot per platform).
function platformImageDimsRaw(platform, contentType) {
  const spec = platformSpec(platform);
  const image = spec?.image;
  if (!image) return null;
  if (contentType === 'carousel' && typeof image.carousel === 'string') return image.carousel;
  if (typeof image.feed === 'string') return image.feed;
  if (typeof image.portrait === 'string') return image.portrait;
  if (typeof image.square === 'string') return image.square;
  if (typeof image.story === 'string') return image.story;
  if (Array.isArray(image.dims) && image.dims.length) return image.dims[0];
  if (typeof image.dims === 'string') return image.dims;
  return null;
}

// ---------------- Ops Stats (B8) ----------------

async function renderOps(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Ops Stats'));

  let data;
  try {
    data = await api('/api/usage');
  } catch (err) {
    view.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load usage stats: ${err.message}`));
    return;
  }

  view.appendChild(
    el('div', { class: 'ops-tiles' }, [
      ['Drafts awaiting', data.drafts_awaiting],
      ['Scheduled this week', data.scheduled_this_week],
      ['Published this month', data.published_this_month],
      ['Published all-time', data.published_all_time],
    ].map(([label, value]) =>
      el('div', { class: 'ops-tile' }, [
        el('div', { class: 'ops-tile-value' }, String(value ?? 0)),
        el('div', { class: 'ops-tile-label' }, label),
      ])
    ))
  );

  view.appendChild(
    el('div', { class: 'card' }, [
      el('h2', {}, 'Posts by status'),
      svgBarChart(Object.entries(data.posts_by_status || {}).map(([label, value]) => ({ label, value }))),
    ])
  );

  view.appendChild(
    el('div', { class: 'card' }, [
      el('h2', {}, 'Posts by brand'),
      svgBarChart((data.posts_by_brand || []).map((b) => ({ label: b.brand_name || `brand ${b.brand_id}`, value: b.count }))),
    ])
  );

  view.appendChild(
    el('div', { class: 'card' }, [
      el('h2', {}, 'Posts by platform'),
      svgBarChart((data.posts_by_platform || []).map((p) => ({ label: p.platform, value: p.count }))),
    ])
  );

  view.appendChild(
    el('div', { class: 'card' }, [
      el('h2', {}, 'Content-type mix'),
      svgBarChart((data.content_type_mix || []).map((c) => ({ label: c.content_type, value: c.count }))),
    ])
  );

  const usageCard = el('div', { class: 'card' });
  usageCard.appendChild(el('h2', {}, 'Usage - all-time vs last 7 days'));
  const kinds = Object.keys(data.usage_counts || {});
  const usageTable = el('div', { class: 'usage-table' });
  usageTable.appendChild(
    el('div', { class: 'usage-row usage-head' }, [el('div', {}, 'Kind'), el('div', {}, 'All-time'), el('div', {}, 'Last 7d')])
  );
  for (const kind of kinds) {
    usageTable.appendChild(
      el('div', { class: 'usage-row' }, [
        el('div', {}, kind),
        el('div', {}, String(data.usage_counts[kind] ?? 0)),
        el('div', {}, String((data.usage_last_7d || {})[kind] ?? 0)),
      ])
    );
  }
  usageCard.appendChild(usageTable);
  view.appendChild(usageCard);
}

// ---------------- Settings & personalization (B12) ----------------
// #/settings - inheritance model (SPEC.md "B12"): one global voice + global
// hard-rule toggles live in `settings` (GET/PATCH /api/settings), and each
// brand's 3 tone profiles (business/personal/casual) hold only a light tweak
// layered on top (GET /api/tone-profiles?brand_id=, PATCH
// /api/tone-profiles/:id, POST /api/tone-profiles/:id/reset). The effective
// voice preview hits GET /api/voice/resolve?brand_id=&tone=.

const TONE_NAMES = ['business', 'personal', 'casual'];

function parseGlobalHardRules(raw) {
  let parsed = {};
  if (raw) {
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = {}; }
  }
  return {
    no_em_dash: parsed.no_em_dash !== false, // default ON - CB's flagship global rule
    no_emoji_platforms: Array.isArray(parsed.no_emoji_platforms) ? parsed.no_emoji_platforms : [],
    banned_words: Array.isArray(parsed.banned_words) ? parsed.banned_words : [],
  };
}

// Renders a checkbox as a clear on/off toggle row (SPEC.md: "rules as visible
// checkmark toggles" - the ON/OFF pill makes the active state obvious at a
// glance, not just a bare checkbox).
function settingsToggleRow(checked, label) {
  const cb = el('input', { type: 'checkbox' });
  cb.checked = checked;
  const stateEl = el('span', { class: `settings-toggle-state ${checked ? 'on' : 'off'}` }, checked ? 'ON' : 'OFF');
  const row = el('label', { class: 'settings-toggle-row' }, [
    cb,
    el('span', { class: 'settings-toggle-label' }, label),
    stateEl,
  ]);
  cb.addEventListener('change', () => {
    stateEl.textContent = cb.checked ? 'ON' : 'OFF';
    stateEl.classList.toggle('on', cb.checked);
    stateEl.classList.toggle('off', !cb.checked);
  });
  return { row, cb };
}

async function renderSettings(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Settings'));

  let settings = {};
  try {
    settings = await api('/api/settings');
  } catch (err) {
    view.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load settings: ${err.message}`));
    return;
  }

  // ---- Personality ----
  const personalityCard = el('div', { class: 'card settings-section' });
  personalityCard.appendChild(el('h2', {}, 'Personality'));
  personalityCard.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:10px;' },
      'This is your voice - inherited by every brand, which then layers on its own light per-tone tweak below.')
  );
  const voiceArea = el('textarea', { rows: '8', placeholder: 'Describe your voice - tone, phrasing habits, things you always/never say…' });
  voiceArea.value = settings.global_voice || '';
  personalityCard.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Global voice'), voiceArea]));
  const voiceMsg = el('div');
  personalityCard.appendChild(
    el('button', {
      class: 'primary',
      onclick: async () => {
        voiceMsg.innerHTML = '';
        try {
          await api('/api/settings', { method: 'PATCH', body: { global_voice: voiceArea.value } });
          voiceMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved.'));
        } catch (err) {
          voiceMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
        }
      },
    }, 'Save voice')
  );
  personalityCard.appendChild(voiceMsg);
  view.appendChild(personalityCard);

  // ---- Global rules (visible on/off toggles) ----
  const rules = parseGlobalHardRules(settings.global_hard_rules);
  const rulesCard = el('div', { class: 'card settings-section' });
  rulesCard.appendChild(el('h2', {}, 'Global rules'));
  rulesCard.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:10px;' },
      'Enforced everywhere, mechanically, on top of any brand/tone tweak.')
  );

  const emDashToggle = settingsToggleRow(rules.no_em_dash, 'No em-dashes (-)');
  rulesCard.appendChild(emDashToggle.row);
  const emojiToggle = settingsToggleRow(rules.no_emoji_platforms.includes('linkedin'), 'No emojis on LinkedIn');
  rulesCard.appendChild(emojiToggle.row);

  const bannedInput = el('input', { placeholder: 'banned words, comma-separated', value: rules.banned_words.join(', ') });
  rulesCard.appendChild(el('div', { class: 'field-row', style: 'margin-top:12px;' }, [el('label', {}, 'Banned words'), bannedInput]));

  const rulesMsg = el('div');
  rulesCard.appendChild(
    el('button', {
      class: 'primary',
      onclick: async () => {
        rulesMsg.innerHTML = '';
        const body = {
          no_em_dash: emDashToggle.cb.checked,
          no_emoji_platforms: emojiToggle.cb.checked ? ['linkedin'] : [],
          banned_words: bannedInput.value.split(',').map((w) => w.trim()).filter(Boolean),
        };
        try {
          await api('/api/settings', { method: 'PATCH', body: { global_hard_rules: JSON.stringify(body) } });
          rulesMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved.'));
        } catch (err) {
          rulesMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
        }
      },
    }, 'Save rules')
  );
  rulesCard.appendChild(rulesMsg);
  view.appendChild(rulesCard);

  // ---- Agent publish authority (B14) - armed, default OFF. When off the
  // assistant can only draft; when on it can approve/publish live (dry-run
  // still applies server-side). ----
  const publishCard = el('div', { class: 'card settings-section' });
  publishCard.appendChild(el('h2', {}, 'Assistant authority'));
  const publishToggle = settingsToggleRow(settings.agent_can_publish === '1', 'Allow assistant to approve & publish');
  publishCard.appendChild(publishToggle.row);
  publishCard.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin-top:6px;' },
      'When off, the assistant can only draft. When on, it can approve and publish live (dry-run still applies).')
  );
  const publishMsg = el('div', { style: 'margin-top:10px;' });
  publishToggle.cb.addEventListener('change', async () => {
    publishMsg.innerHTML = '';
    try {
      await api('/api/settings', { method: 'PATCH', body: { agent_can_publish: publishToggle.cb.checked ? '1' : '0' } });
      publishMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved.'));
    } catch (err) {
      publishMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
    }
  });
  publishCard.appendChild(publishMsg);
  view.appendChild(publishCard);

  // ---- Default drafting model (B15) ----
  const providerCard = el('div', { class: 'card settings-section' });
  providerCard.appendChild(el('h2', {}, 'Default drafting model'));
  const providerSelect = el(
    'select',
    {},
    AI_PROVIDERS.map((p) =>
      el('option', { value: p.value, selected: (settings.draft_provider || 'claude') === p.value ? 'selected' : undefined }, p.label)
    )
  );
  providerCard.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Draft with'), providerSelect]));
  providerCard.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin-top:2px;' },
      'Codex needs the codex CLI signed in (subscription, no API key). Claude uses the claude CLI login.')
  );
  const providerMsg = el('div', { style: 'margin-top:10px;' });
  providerSelect.onchange = async () => {
    providerMsg.innerHTML = '';
    try {
      await api('/api/settings', { method: 'PATCH', body: { draft_provider: providerSelect.value } });
      sessionDraftProvider = providerSelect.value;
      providerMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved.'));
    } catch (err) {
      providerMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
    }
  };
  providerCard.appendChild(providerMsg);
  view.appendChild(providerCard);

  // ---- Per-brand tone tweaks ----
  const brandCard = el('div', { class: 'card settings-section' });
  brandCard.appendChild(el('h2', {}, 'Per-brand'));

  if (!state.brands.length) {
    brandCard.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'No brands yet.'));
    view.appendChild(brandCard);
    return;
  }

  let brandId = getStickyBrand() && state.brands.some((b) => String(b.id) === getStickyBrand())
    ? getStickyBrand()
    : String(state.brands[0].id);
  const brandSelect = el('select', {}, state.brands.map((b) =>
    el('option', { value: String(b.id), selected: String(b.id) === brandId ? 'selected' : undefined }, b.name)
  ));
  brandCard.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Brand'), brandSelect]));

  const defaultToneSelect = el('select', {}, TONE_NAMES.map((t) => el('option', { value: t }, t)));
  brandCard.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Default tone (composer)'), defaultToneSelect]));
  const defaultToneMsg = el('div');
  brandCard.appendChild(
    el('button', {
      onclick: async () => {
        defaultToneMsg.innerHTML = '';
        try {
          await api('/api/settings', {
            method: 'PATCH',
            body: { [`brand_${brandId}_default_tone`]: defaultToneSelect.value },
          });
          defaultToneMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Default tone saved.'));
        } catch (err) {
          defaultToneMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
        }
      },
    }, 'Save default tone')
  );
  brandCard.appendChild(defaultToneMsg);

  const tonesHost = el('div');
  brandCard.appendChild(tonesHost);
  view.appendChild(brandCard);

  // ---- Branding (B14) - logo upload/preview, color pickers, voice-doc
  // path, per selected brand. Feeds the image brief (logo + colors) so
  // Codex can brand the generated asset.
  const brandingCard = el('div', { class: 'card settings-section' });
  brandingCard.appendChild(el('h2', {}, 'Branding'));
  brandingCard.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:10px;' },
      "The logo and colors feed this brand's image brief so Codex can brand generated assets.")
  );
  const brandingHost = el('div');
  brandingCard.appendChild(brandingHost);
  view.appendChild(brandingCard);

  function parseBrandColors(raw) {
    let parsed = {};
    if (raw) {
      try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = {}; }
    }
    return { primary: parsed.primary || '#c9a227', accent: parsed.accent || '#2f6fed' };
  }

  async function loadBranding() {
    brandingHost.innerHTML = '<p style="color:var(--muted);">Loading branding…</p>';
    let brand;
    try {
      const fresh = await api('/api/brands');
      brand = fresh.find((b) => String(b.id) === String(brandId));
    } catch (err) {
      brandingHost.innerHTML = '';
      brandingHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load brand: ${err.message}`));
      return;
    }
    if (!brand) {
      brandingHost.innerHTML = '';
      brandingHost.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'Brand not found.'));
      return;
    }
    brandingHost.innerHTML = '';

    // Logo upload + preview
    const logoMsg = el('div');
    const logoPreview = el('div', { class: 'brand-logo-preview' });
    function renderLogoPreview() {
      logoPreview.innerHTML = '';
      if (brand.logo_path) {
        logoPreview.appendChild(el('img', { src: brand.logo_path, alt: `${brand.name} logo` }));
      } else {
        logoPreview.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;' }, 'No logo uploaded yet.'));
      }
    }
    renderLogoPreview();
    const logoFileInput = el('input', { type: 'file', accept: 'image/*' });
    brandingHost.appendChild(
      el('div', { class: 'field-row' }, [el('label', {}, 'Logo'), logoPreview, logoFileInput])
    );
    brandingHost.appendChild(
      el('div', { class: 'toolbar', style: 'margin-top:-6px;margin-bottom:10px;' }, [
        el('button', {
          class: 'primary',
          onclick: async () => {
            logoMsg.innerHTML = '';
            if (!logoFileInput.files.length) {
              logoMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Choose a logo file first.'));
              return;
            }
            const fd = new FormData();
            fd.append('logo', logoFileInput.files[0]);
            try {
              const updated = await api(`/api/brands/${brandId}/logo`, { method: 'POST', body: fd });
              brand.logo_path = updated?.logo_path || brand.logo_path;
              renderLogoPreview();
              logoFileInput.value = '';
              logoMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Logo uploaded.'));
            } catch (err) {
              logoMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
            }
          },
        }, 'Upload logo'),
      ])
    );
    brandingHost.appendChild(logoMsg);

    // Color pickers (primary/accent) - auto-save on change
    const colors = parseBrandColors(brand.colors);
    const primaryColorInput = el('input', { type: 'color', value: colors.primary });
    const accentColorInput = el('input', { type: 'color', value: colors.accent });
    const colorsMsg = el('div');
    async function saveColors() {
      colorsMsg.innerHTML = '';
      try {
        await api(`/api/brands/${brandId}`, {
          method: 'PATCH',
          body: { colors: JSON.stringify({ primary: primaryColorInput.value, accent: accentColorInput.value }) },
        });
        colorsMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Colors saved.'));
      } catch (err) {
        colorsMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
      }
    }
    primaryColorInput.addEventListener('change', saveColors);
    accentColorInput.addEventListener('change', saveColors);
    brandingHost.appendChild(
      el('div', { class: 'field-row brand-color-row' }, [
        el('label', {}, 'Colors'),
        el('div', { class: 'brand-color-pickers' }, [
          el('span', { class: 'brand-color-swatch' }, ['Primary ', primaryColorInput]),
          el('span', { class: 'brand-color-swatch' }, ['Accent ', accentColorInput]),
        ]),
      ])
    );
    brandingHost.appendChild(colorsMsg);

    // Voice-doc path
    const voiceDocInput = el('input', { placeholder: '/path/to/voice-doc.md', value: brand.voice_doc_path || '' });
    const voiceDocMsg = el('div');
    brandingHost.appendChild(
      el('div', { class: 'field-row' }, [el('label', {}, 'Voice-doc path'), voiceDocInput])
    );
    brandingHost.appendChild(
      el('button', {
        onclick: async () => {
          voiceDocMsg.innerHTML = '';
          try {
            await api(`/api/brands/${brandId}`, { method: 'PATCH', body: { voice_doc_path: voiceDocInput.value } });
            voiceDocMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved.'));
          } catch (err) {
            voiceDocMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        },
      }, 'Save voice-doc path')
    );
    brandingHost.appendChild(voiceDocMsg);
  }

  // Per-tone editor: voice_rules textarea + Save + Reset-to-global, plus a
  // best-effort "effective voice" preview from the resolver.
  function toneEditor(profile) {
    const box = el('div', { class: 'card tone-profile-card' });
    box.appendChild(el('h3', { style: 'margin:0 0 8px;text-transform:capitalize;' }, profile.name));
    const area = el('textarea', { rows: '4', placeholder: '(inherits the global voice - add a light brand tweak here)' });
    area.value = profile.voice_rules || '';
    box.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Voice rules'), area]));

    const previewHost = el('div', { class: 'tone-preview' });
    async function loadPreview() {
      previewHost.textContent = '';
      try {
        const resolved = await api(`/api/voice/resolve?brand_id=${brandId}&tone=${profile.name}`);
        previewHost.textContent = `Effective voice: ${resolved.voice || '(empty)'}`;
      } catch {
        // preview is best-effort only - resolver may not be live yet
      }
    }
    loadPreview();

    const msg = el('div');
    const actions = el('div', { class: 'toolbar', style: 'margin-top:6px;' }, [
      el('button', {
        class: 'primary',
        onclick: async () => {
          msg.innerHTML = '';
          try {
            await api(`/api/tone-profiles/${profile.id}`, { method: 'PATCH', body: { voice_rules: area.value } });
            msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved.'));
            loadPreview();
          } catch (err) {
            msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        },
      }, 'Save'),
      el('button', {
        onclick: async () => {
          msg.innerHTML = '';
          try {
            const reset = await api(`/api/tone-profiles/${profile.id}/reset`, { method: 'POST' });
            area.value = reset?.voice_rules || '';
            msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Reset to global.'));
            loadPreview();
          } catch (err) {
            msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        },
      }, 'Reset to global'),
    ]);
    box.appendChild(previewHost);
    box.appendChild(actions);
    box.appendChild(msg);
    return box;
  }

  async function loadBrand() {
    tonesHost.innerHTML = '<p style="color:var(--muted);">Loading tone profiles…</p>';
    try {
      const [profiles, freshSettings] = await Promise.all([
        api(`/api/tone-profiles?brand_id=${brandId}`),
        api('/api/settings'),
      ]);
      const saved = freshSettings?.[`brand_${brandId}_default_tone`];
      defaultToneSelect.value = TONE_NAMES.includes(saved) ? saved : 'business';
      tonesHost.innerHTML = '';
      const grid = el('div', { class: 'tone-profile-grid' });
      for (const name of TONE_NAMES) {
        const profile = profiles.find((p) => p.name === name);
        grid.appendChild(
          profile ? toneEditor(profile) : el('div', { class: 'card tone-profile-card' }, `No "${name}" tone profile for this brand yet.`)
        );
      }
      tonesHost.appendChild(grid);
    } catch (err) {
      tonesHost.innerHTML = '';
      tonesHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load tone profiles: ${err.message}`));
    }
  }

  brandSelect.onchange = () => {
    brandId = brandSelect.value;
    setStickyBrand(brandId);
    loadBrand();
    loadBranding();
  };
  await Promise.all([loadBrand(), loadBranding()]);
}

// ---------------- Brand profiles (B13) ----------------
// Canonical source of truth for each platform profile (heading/subheading/bio
// + the platform-standard fields) so CB can tell which ones are stale and
// copy-paste updated fields straight into LinkedIn/Facebook/Reddit. Generate
// drafts each field in his voice (cheap model, SPEC.md "B13 - Brand
// profiles"); nothing here posts anything - copy-paste is the whole point.

function humanizeKey(key) {
  return String(key || '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizePlatformName(platform) {
  return humanizeKey(platform);
}

const PROFILE_LONGFIELD_HINTS = ['bio', 'about', 'overview', 'description', 'story', 'specialties'];

function isLongProfileField(key, value) {
  if (PROFILE_LONGFIELD_HINTS.some((h) => key.toLowerCase().includes(h))) return true;
  return String(value || '').length > 80;
}

async function copyToClipboardWithConfirm(btn, text) {
  try {
    await navigator.clipboard.writeText(text || '');
    const original = btn.textContent;
    btn.textContent = 'Copied';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = original; btn.disabled = false; }, 1200);
  } catch {
    alert("Could not copy - clipboard access wasn't available.");
  }
}

// One platform's card: editable fields (mutated in `fields`, saved on
// demand), per-field Copy, Save, Generate, Mark reviewed / Mark stale.
// `onChanged` reloads the whole card list (used after any server write so
// status chips/timestamps stay in sync without a full page reload).
function profileCard(row, onChanged) {
  const fields = { ...(row.fields || {}) };
  const card = el('div', { class: 'card profile-card' });

  let header = el('div', { class: 'profile-card-header' }, [
    el('h3', {}, humanizePlatformName(row.platform)),
    el('span', { class: `pill status-${row.status}` }, row.status),
  ]);
  card.appendChild(header);

  function refreshHeader() {
    const next = el('div', { class: 'profile-card-header' }, [
      el('h3', {}, humanizePlatformName(row.platform)),
      el('span', { class: `pill status-${row.status}` }, row.status),
    ]);
    header.replaceWith(next);
    header = next;
  }

  const meta = el('div', { class: 'profile-card-meta' },
    `${row.last_generated_at ? `Generated ${fmtDate(row.last_generated_at)}` : 'Never generated'} · ${row.last_reviewed_at ? `Reviewed ${fmtDate(row.last_reviewed_at)}` : 'Not reviewed'}`
  );
  card.appendChild(meta);

  const fieldsHost = el('div', { class: 'profile-fields' });
  card.appendChild(fieldsHost);

  function renderFields() {
    fieldsHost.innerHTML = '';
    const keys = Object.keys(fields);
    if (!keys.length) {
      fieldsHost.appendChild(
        el('div', { style: 'color:var(--muted);font-size:12px;' }, 'No fields yet - hit Generate to draft them.')
      );
      return;
    }
    for (const key of keys) {
      const value = fields[key] == null ? '' : String(fields[key]);
      const long = isLongProfileField(key, value);
      const input = long ? el('textarea', { rows: '4' }) : el('input', {});
      input.value = value;
      input.addEventListener('input', () => { fields[key] = input.value; });

      const copyBtn = el('button', { class: 'profile-copy-btn' }, 'Copy');
      copyBtn.addEventListener('click', () => copyToClipboardWithConfirm(copyBtn, fields[key]));

      fieldsHost.appendChild(
        el('div', { class: 'profile-field-row' }, [
          el('div', { class: 'profile-field-label-row' }, [el('label', {}, humanizeKey(key)), copyBtn]),
          input,
        ])
      );
    }
  }
  renderFields();

  const msg = el('div');
  card.appendChild(msg);

  const generateBtn = el('button', {}, 'Generate');
  generateBtn.addEventListener('click', async () => {
    msg.innerHTML = '';
    generateBtn.disabled = true;
    const originalText = generateBtn.textContent;
    generateBtn.textContent = 'Generating…';
    try {
      const updated = await api('/api/profiles/generate', {
        method: 'POST',
        body: { brand_id: row.brand_id, platform: row.platform },
      });
      Object.keys(fields).forEach((k) => delete fields[k]);
      Object.assign(fields, updated.fields || {});
      row.status = updated.status || row.status;
      row.last_generated_at = updated.last_generated_at || row.last_generated_at;
      refreshHeader();
      renderFields();
      msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Drafted - review before you copy-paste it anywhere.'));
    } catch (err) {
      if (err.status === 503 || err.data?.error === 'ai_unavailable') {
        msg.appendChild(el('div', { class: 'msg-banner msg-error' }, "AI unavailable - the claude CLI isn't reachable."));
      } else if (err.status === 404) {
        msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Generate endpoint not available yet on this server.'));
      } else {
        msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
      }
    } finally {
      generateBtn.disabled = false;
      generateBtn.textContent = originalText;
    }
  });

  const saveBtn = el('button', { class: 'primary' }, 'Save');
  saveBtn.addEventListener('click', async () => {
    msg.innerHTML = '';
    try {
      await api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { fields } });
      msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved.'));
      onChanged();
    } catch (err) {
      msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
    }
  });

  const reviewedBtn = el('button', {}, 'Mark reviewed');
  reviewedBtn.addEventListener('click', async () => {
    msg.innerHTML = '';
    try {
      await api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { status: 'current' } });
      msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Marked current.'));
      onChanged();
    } catch (err) {
      msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
    }
  });

  const staleBtn = el('button', { class: 'danger' }, 'Mark stale');
  staleBtn.addEventListener('click', async () => {
    msg.innerHTML = '';
    try {
      await api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { status: 'stale' } });
      msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Marked stale.'));
      onChanged();
    } catch (err) {
      msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
    }
  });

  const actions = el('div', { class: 'toolbar profile-card-actions' }, [generateBtn, saveBtn, reviewedBtn, staleBtn]);
  card.appendChild(actions);

  return card;
}

async function renderProfiles(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Brand profiles'));
  view.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin:-6px 0 14px;' },
      "The source of truth for each platform's profile - heading, bio, and the platform-standard fields. Generate drafts them in your voice; copy-paste is the whole point, nothing here posts anything.")
  );

  if (!state.brands.length) {
    view.appendChild(el('div', { style: 'color:var(--muted);' }, 'No brands yet.'));
    return;
  }

  let brandId = getStickyBrand() && state.brands.some((b) => String(b.id) === getStickyBrand())
    ? getStickyBrand()
    : String(state.brands[0].id);
  const brandSelect = el('select', {}, state.brands.map((b) =>
    el('option', { value: String(b.id), selected: String(b.id) === brandId ? 'selected' : undefined }, b.name)
  ));
  view.appendChild(el('div', { class: 'toolbar' }, [el('span', {}, 'Brand:'), brandSelect]));

  const cardsHost = el('div', { class: 'profile-cards' });
  view.appendChild(cardsHost);

  async function reload() {
    cardsHost.innerHTML = '';
    cardsHost.appendChild(el('p', { style: 'color:var(--muted);' }, 'Loading…'));
    let rows;
    try {
      rows = await api(`/api/profiles?brand_id=${encodeURIComponent(brandId)}`);
    } catch (err) {
      cardsHost.innerHTML = '';
      if (err.status === 404) {
        cardsHost.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Profiles endpoint not available yet on this server.'));
      } else {
        cardsHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load profiles: ${err.message}`));
      }
      return;
    }
    cardsHost.innerHTML = '';
    if (!rows.length) {
      cardsHost.appendChild(
        el('div', { class: 'card' }, [
          el('div', {}, 'No profiles yet for this brand.'),
          el('div', { style: 'color:var(--muted);font-size:12px;margin-top:6px;' },
            'Generate creates one per platform once it has an account/platform to draft for - check back after the first run, or ask the agent to draft one.'),
        ])
      );
      return;
    }
    for (const row of rows) {
      cardsHost.appendChild(profileCard(row, reload));
    }
  }

  brandSelect.onchange = () => {
    brandId = brandSelect.value;
    setStickyBrand(brandId);
    reload();
  };

  await reload();
}

// ---------------- Research (B8) ----------------

const RESEARCH_SOURCES = ['google_trends', 'reddit', 'best_practice', 'web', 'manual'];

async function renderResearch(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Research'));

  const stickyBrandInit = getStickyBrand();
  const brandFilter = el('select', {}, [
    el('option', { value: '', selected: stickyBrandInit ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: b.id, selected: String(b.id) === String(stickyBrandInit) ? 'selected' : undefined }, b.name)
    ),
  ]);
  view.appendChild(el('div', { class: 'toolbar' }, [el('span', {}, 'Brand:'), brandFilter]));

  const listHost = el('div');
  view.appendChild(listHost);

  async function reload() {
    listHost.innerHTML = '';
    const qs = brandFilter.value ? `?brand_id=${encodeURIComponent(brandFilter.value)}` : '';
    let notes;
    try {
      notes = await api(`/api/research${qs}`);
    } catch (err) {
      listHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load research notes: ${err.message}`));
      return;
    }
    if (!notes.length) {
      listHost.appendChild(el('div', { style: 'color:var(--muted);' }, 'No research notes yet.'));
      return;
    }
    for (const n of notes) {
      const card = el('div', { class: 'card' });
      card.appendChild(
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, [
          el('strong', {}, n.title || '(untitled)'),
          el('span', { class: 'pill source-pill' }, n.source),
          n.brand_id ? el('span', { style: 'color:var(--muted);font-size:12px;' }, brandName(n.brand_id)) : el('span', { style: 'color:var(--muted);font-size:12px;' }, 'no brand'),
        ])
      );
      if (n.tags && n.tags.length) {
        card.appendChild(
          el('div', { style: 'margin-top:4px;' }, n.tags.map((t) => el('span', { class: 'pill tag-pill' }, t)))
        );
      }
      if (n.body) {
        const truncated = n.body.length > 300 ? `${n.body.slice(0, 300)}…` : n.body;
        card.appendChild(el('div', { style: 'margin-top:6px;color:var(--muted);font-size:12px;white-space:pre-wrap;' }, truncated));
      }
      if (n.url) {
        card.appendChild(el('div', { style: 'margin-top:6px;' }, [el('a', { href: n.url, target: '_blank' }, n.url)]));
      }
      card.appendChild(
        el('div', { class: 'toolbar', style: 'margin-top:8px;' }, [
          el('button', {
            class: 'danger',
            onclick: async () => {
              try {
                await api(`/api/research/${n.id}`, { method: 'DELETE' });
                reload();
              } catch (err) {
                alert(err.message);
              }
            },
          }, 'Delete'),
        ])
      );
      listHost.appendChild(card);
    }
  }
  brandFilter.onchange = () => { setStickyBrand(brandFilter.value); reload(); };
  await reload();

  const addCard = el('div', { class: 'card' });
  addCard.appendChild(el('h2', {}, 'Add note'));
  const addBrand = el('select', {}, [
    el('option', { value: '' }, '(no brand)'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const addSource = el('select', {}, RESEARCH_SOURCES.map((s) => el('option', { value: s }, s)));
  const addTitle = el('input', { placeholder: 'Title' });
  const addUrl = el('input', { placeholder: 'URL (optional)' });
  const addTags = el('input', { placeholder: 'tags, comma, separated' });
  const addBody = el('textarea', { rows: '5', placeholder: 'Body / notes' });
  addCard.append(
    el('div', { class: 'field-row' }, [el('label', {}, 'Brand'), addBrand]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Source'), addSource]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Title'), addTitle]),
    el('div', { class: 'field-row' }, [el('label', {}, 'URL'), addUrl]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Tags'), addTags]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Body'), addBody])
  );
  const addMsg = el('div');
  addCard.appendChild(addMsg);
  addCard.appendChild(
    el('button', {
      class: 'primary',
      onclick: async () => {
        addMsg.innerHTML = '';
        try {
          await api('/api/research', {
            method: 'POST',
            body: {
              brand_id: addBrand.value || null,
              source: addSource.value,
              title: addTitle.value || null,
              url: addUrl.value || null,
              tags: addTags.value.split(',').map((t) => t.trim()).filter(Boolean),
              body: addBody.value || null,
            },
          });
          addTitle.value = '';
          addUrl.value = '';
          addTags.value = '';
          addBody.value = '';
          reload();
        } catch (err) {
          addMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
        }
      },
    }, '+ Add note')
  );
  view.appendChild(addCard);

  const importCard = el('div', { class: 'card' });
  importCard.appendChild(el('h2', {}, 'Paste / import'));
  const importSource = el('select', {}, RESEARCH_SOURCES.map((s) => el('option', { value: s }, s)));
  const importFilename = el('input', { placeholder: 'filename (optional)' });
  const importContent = el('textarea', { rows: '6', placeholder: 'Paste CSV/text content here…' });
  importCard.append(
    el('div', { class: 'field-row' }, [el('label', {}, 'Source'), importSource]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Filename'), importFilename]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Content'), importContent])
  );
  const importMsg = el('div');
  importCard.appendChild(importMsg);
  importCard.appendChild(
    el('button', {
      class: 'primary',
      onclick: async () => {
        importMsg.innerHTML = '';
        if (!importContent.value.trim()) return;
        try {
          await api('/api/research/import', {
            method: 'POST',
            body: {
              brand_id: brandFilter.value || null,
              source: importSource.value,
              filename: importFilename.value || null,
              content: importContent.value,
            },
          });
          importContent.value = '';
          importFilename.value = '';
          reload();
        } catch (err) {
          importMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
        }
      },
    }, 'Import')
  );
  view.appendChild(importCard);
}

// ---------------- Inspiration board (B8) ----------------

async function renderInspiration(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Inspiration'));

  const stickyBrandInit = getStickyBrand();
  const brandFilter = el('select', {}, [
    el('option', { value: '', selected: stickyBrandInit ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: b.id, selected: String(b.id) === String(stickyBrandInit) ? 'selected' : undefined }, b.name)
    ),
  ]);
  view.appendChild(el('div', { class: 'toolbar' }, [el('span', {}, 'Brand:'), brandFilter]));

  const gridHost = el('div');
  view.appendChild(gridHost);

  function profileCard(p, { onDelete, onAdd } = {}) {
    const card = el('div', { class: 'inspiration-card' });
    card.appendChild(
      el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
        el('strong', {}, p.name || p.handle || '(unnamed)'),
        el('span', { class: 'pill' }, p.platform || '?'),
      ])
    );
    if (p.handle) card.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;margin-top:2px;' }, `@${p.handle}`));
    if (p.niche) card.appendChild(el('div', { style: 'margin-top:6px;font-size:12px;' }, [el('strong', {}, 'Niche: '), p.niche]));
    if (p.why_relevant) card.appendChild(el('div', { style: 'margin-top:4px;font-size:12px;color:var(--muted);' }, p.why_relevant));
    if (p.url) card.appendChild(el('div', { style: 'margin-top:6px;' }, [el('a', { href: p.url, target: '_blank' }, p.url)]));
    card.appendChild(el('div', { style: 'margin-top:6px;' }, [el('span', { class: 'pill source-pill' }, p.source || 'manual')]));
    const actions = el('div', { class: 'toolbar', style: 'margin-top:8px;' });
    if (onAdd) actions.appendChild(el('button', { class: 'primary', onclick: onAdd }, '+ Add to board'));
    if (onDelete) actions.appendChild(el('button', { class: 'danger', onclick: onDelete }, 'Delete'));
    card.appendChild(actions);
    return card;
  }

  async function reload() {
    gridHost.innerHTML = '';
    const qs = brandFilter.value ? `?brand_id=${encodeURIComponent(brandFilter.value)}` : '';
    let profiles;
    try {
      profiles = await api(`/api/inspiration${qs}`);
    } catch (err) {
      gridHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load inspiration board: ${err.message}`));
      return;
    }
    if (!profiles.length) {
      gridHost.appendChild(el('div', { style: 'color:var(--muted);' }, 'No profiles yet - add one below, or ask AI to suggest some.'));
      return;
    }
    const grid = el('div', { class: 'inspiration-grid' });
    for (const p of profiles) {
      grid.appendChild(
        profileCard(p, {
          onDelete: async () => {
            try {
              await api(`/api/inspiration/${p.id}`, { method: 'DELETE' });
              reload();
            } catch (err) {
              alert(err.message);
            }
          },
        })
      );
    }
    gridHost.appendChild(grid);
  }
  brandFilter.onchange = () => { setStickyBrand(brandFilter.value); reload(); };
  await reload();

  const addCard = el('div', { class: 'card' });
  addCard.appendChild(el('h2', {}, 'Add profile'));
  const addBrand = el('select', {}, [
    el('option', { value: '' }, '(no brand)'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const addPlatform = el('select', {}, ['twitter', 'linkedin', 'facebook', 'instagram', 'tiktok', 'reddit', 'blog', 'other'].map((p) => el('option', { value: p }, p)));
  const addName = el('input', { placeholder: 'Name' });
  const addHandle = el('input', { placeholder: 'Handle (no @)' });
  const addUrl = el('input', { placeholder: 'URL' });
  const addNiche = el('input', { placeholder: 'Niche' });
  const addWhy = el('textarea', { rows: '2', placeholder: 'Why relevant' });
  const addTags = el('input', { placeholder: 'tags, comma, separated' });
  addCard.append(
    el('div', { class: 'field-row' }, [el('label', {}, 'Brand'), addBrand]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Platform'), addPlatform]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Name'), addName]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Handle'), addHandle]),
    el('div', { class: 'field-row' }, [el('label', {}, 'URL'), addUrl]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Niche'), addNiche]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Why relevant'), addWhy]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Tags'), addTags])
  );
  const addMsg = el('div');
  addCard.appendChild(addMsg);
  addCard.appendChild(
    el('button', {
      class: 'primary',
      onclick: async () => {
        addMsg.innerHTML = '';
        try {
          await api('/api/inspiration', {
            method: 'POST',
            body: {
              brand_id: addBrand.value || null,
              platform: addPlatform.value,
              name: addName.value || null,
              handle: addHandle.value || null,
              url: addUrl.value || null,
              niche: addNiche.value || null,
              why_relevant: addWhy.value || null,
              tags: addTags.value.split(',').map((t) => t.trim()).filter(Boolean),
              source: 'manual',
            },
          });
          addName.value = '';
          addHandle.value = '';
          addUrl.value = '';
          addNiche.value = '';
          addWhy.value = '';
          addTags.value = '';
          reload();
        } catch (err) {
          addMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
        }
      },
    }, '+ Add profile')
  );
  view.appendChild(addCard);

  const suggestCard = el('div', { class: 'card' });
  suggestCard.appendChild(el('h2', {}, 'Suggest profiles (AI)'));
  const suggestBrand = el('select', {}, [
    el('option', { value: '' }, '(no brand)'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const suggestNiche = el('input', { placeholder: 'Niche (optional)' });
  const suggestPlatforms = el('input', { placeholder: 'Platforms, comma separated (optional)' });
  suggestCard.append(
    el('div', { class: 'field-row' }, [el('label', {}, 'Brand'), suggestBrand]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Niche'), suggestNiche]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Platforms'), suggestPlatforms])
  );
  const suggestResults = el('div');
  const suggestMsg = el('div');
  suggestCard.appendChild(suggestMsg);
  suggestCard.appendChild(
    el('button', {
      class: 'primary',
      onclick: async () => {
        suggestMsg.innerHTML = '';
        suggestResults.innerHTML = '';
        try {
          const brand = suggestBrand.value ? brandName(Number(suggestBrand.value)) : undefined;
          const platforms = suggestPlatforms.value.split(',').map((p) => p.trim()).filter(Boolean);
          const res = await api('/api/inspiration/suggest', {
            method: 'POST',
            body: { brand_id: suggestBrand.value || null, brand, niche: suggestNiche.value || undefined, platforms },
          });
          if (!res.suggestions || !res.suggestions.length) {
            suggestResults.appendChild(el('div', { style: 'color:var(--muted);' }, 'No suggestions returned.'));
            return;
          }
          const grid = el('div', { class: 'inspiration-grid' });
          for (const s of res.suggestions) {
            grid.appendChild(
              profileCard(
                { ...s, source: 'ai_suggested' },
                {
                  onAdd: async () => {
                    try {
                      await api('/api/inspiration', {
                        method: 'POST',
                        body: {
                          brand_id: suggestBrand.value || null,
                          platform: s.platform || null,
                          name: s.name || null,
                          handle: s.handle || null,
                          url: s.url || null,
                          niche: suggestNiche.value || null,
                          why_relevant: s.why_relevant || null,
                          source: 'ai_suggested',
                        },
                      });
                      reload();
                    } catch (err) {
                      alert(err.message);
                    }
                  },
                }
              )
            );
          }
          suggestResults.appendChild(grid);
        } catch (err) {
          if (err.status === 503) {
            suggestMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'AI unavailable (claude CLI not found). Add profiles manually below.'));
          } else {
            suggestMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        }
      },
    }, 'Suggest profiles')
  );
  suggestCard.appendChild(suggestResults);
  view.appendChild(suggestCard);
}

// ---------------- Images / Codex handoff (B8) ----------------

// ---------------- Resize-for-platforms control (B14) ----------------
// Per generated variant: pick platform(s) -> POST /api/media/resize -> show
// the produced files, or a friendly note if sips (macOS-only, no dep) isn't
// available on this machine.
function imagePlatformsWithSpecs() {
  const specs = state.platformSpecs || {};
  return Object.keys(specs).filter((k) => specs[k] && specs[k].image);
}

function resizeControl(variant, request) {
  const wrap = el('div', { class: 'resize-box' });
  const toggleBtn = el('button', { style: 'margin-top:6px;width:100%;' }, 'Resize for platforms');
  const panel = el('div', { class: 'resize-panel', hidden: true });
  wrap.appendChild(toggleBtn);
  wrap.appendChild(panel);

  const platforms = imagePlatformsWithSpecs();
  const checks = platforms.map((p) => {
    const cb = el('input', { type: 'checkbox', value: p });
    return { platform: p, cb, row: el('label', { class: 'resize-platform-check' }, [cb, ` ${p}`]) };
  });
  if (checks.length) {
    panel.appendChild(el('div', { class: 'resize-platform-list' }, checks.map((c) => c.row)));
  } else {
    panel.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;' }, 'No platform image specs loaded.'));
  }

  const msg = el('div');
  const resultHost = el('div');
  panel.appendChild(
    el('button', {
      class: 'primary',
      style: 'margin-top:6px;width:100%;',
      onclick: async () => {
        msg.innerHTML = '';
        resultHost.innerHTML = '';
        const chosen = checks.filter((c) => c.cb.checked).map((c) => c.platform);
        if (!chosen.length) {
          msg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one platform.'));
          return;
        }
        try {
          const res = await api('/api/media/resize', {
            method: 'POST',
            body: { source_path: variant.path, platforms: chosen, post_id: request.post_id || undefined },
          });
          const files = res.files || res.produced || [];
          if (files.length) {
            const list = el('ul', { class: 'history-list' });
            for (const f of files) {
              list.appendChild(el('li', {}, `${f.platform || ''}: ${f.path || f.url || ''}`));
            }
            resultHost.appendChild(list);
          } else {
            resultHost.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;' }, 'Resize ran - no files returned.'));
          }
        } catch (err) {
          if (err.data?.error === 'resize_unavailable') {
            resultHost.appendChild(
              el('div', { class: 'msg-banner', style: 'background:var(--ink-3);color:var(--muted);border:1px solid var(--border);' },
                'Resize needs macOS sips - not available here.')
            );
          } else {
            msg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
          }
        }
      },
    }, 'Resize')
  );
  panel.appendChild(msg);
  panel.appendChild(resultHost);

  toggleBtn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  return wrap;
}

async function renderImages(view) {
  view.innerHTML = '';
  view.appendChild(el('h1', {}, 'Images'));
  view.appendChild(
    el('div', { class: 'msg-banner', style: 'background:var(--ink-3);color:var(--muted);border:1px solid var(--border);' },
      'Codex drops generated variants into image-requests/generated/ - see docs/CODEX_IMAGE_HANDOFF.md for the handoff contract.')
  );

  const statusFilter = el('select', {}, [
    el('option', { value: '' }, 'All statuses'),
    ...['requested', 'generated', 'picked', 'canceled'].map((s) => el('option', { value: s }, s)),
  ]);
  view.appendChild(el('div', { class: 'toolbar' }, [el('span', {}, 'Status:'), statusFilter]));

  const listHost = el('div');
  view.appendChild(listHost);

  async function reload() {
    listHost.innerHTML = '';
    const qs = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : '';
    let reqs;
    try {
      reqs = await api(`/api/image-requests${qs}`);
    } catch (err) {
      listHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load image requests: ${err.message}`));
      return;
    }
    if (!reqs.length) {
      listHost.appendChild(el('div', { style: 'color:var(--muted);' }, 'No image requests yet. Use "Request image (Codex)" in the Composer.'));
      return;
    }
    for (const r of reqs) {
      const card = el('div', { class: 'card' });
      card.appendChild(
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, [
          el('strong', {}, `Request #${r.id}`),
          el('span', { class: `pill status-${r.status}` }, r.status),
          el('span', { style: 'color:var(--muted);font-size:12px;' }, (r.platforms || []).join(', ')),
          r.content_type ? el('span', { style: 'color:var(--muted);font-size:12px;' }, r.content_type) : null,
          r.post_id ? el('a', { href: `#/post/${r.post_id}`, style: 'font-size:12px;' }, `→ post #${r.post_id}`) : null,
        ])
      );
      card.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;margin-top:4px;' }, `Created: ${fmtDate(r.created_at)}`));

      const brief = r.brief && typeof r.brief === 'object' ? r.brief : null;
      if (brief?.platforms?.length) {
        const briefList = el('ul', { class: 'history-list', style: 'margin-top:8px;' });
        for (const pb of brief.platforms) {
          const dimsStr = pb.dims?.raw || (pb.dims?.w ? `${pb.dims.w}x${pb.dims.h}` : '?');
          briefList.appendChild(el('li', {}, `${pb.platform}: ${dimsStr} (${pb.format || 'jpg'})${pb.max_mb ? `, max ${pb.max_mb}MB` : ''}`));
        }
        card.appendChild(briefList);
      }

      if (r.status === 'generated' && r.variants && r.variants.length) {
        const variantRow = el('div', { class: 'image-variant-row' });
        for (const v of r.variants) {
          const vCard = el('div', { class: 'image-variant' }, [
            el('img', { src: v.url, alt: v.notes || v.platform || 'variant' }),
            el('div', { style: 'font-size:11px;color:var(--muted);margin-top:4px;' }, `${v.platform || ''} ${v.dims || ''}`),
            el('button', {
              class: 'primary',
              style: 'margin-top:6px;width:100%;',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/pick`, { method: 'POST', body: { chosen_path: v.path } });
                  reload();
                } catch (err) {
                  alert(err.message);
                }
              },
            }, 'Pick'),
            resizeControl(v, r),
          ]);
          variantRow.appendChild(vCard);
        }
        card.appendChild(variantRow);
      }

      if (['generated', 'picked'].includes(r.status)) {
        card.appendChild(
          el('div', { class: 'toolbar', style: 'margin-top:8px;' }, [
            el('button', {
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/regenerate`, { method: 'POST' });
                  reload();
                } catch (err) {
                  alert(err.message);
                }
              },
            }, 'Regenerate / more variants'),
          ])
        );
      }

      if (r.status === 'picked' && r.chosen_path) {
        card.appendChild(el('div', { style: 'margin-top:8px;color:var(--green);font-size:12px;' }, `Chosen: ${r.chosen_path}`));
      }

      if (['requested', 'generated'].includes(r.status)) {
        card.appendChild(
          el('div', { class: 'toolbar', style: 'margin-top:8px;' }, [
            el('button', {
              class: 'danger',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/cancel`, { method: 'POST' });
                  reload();
                } catch (err) {
                  alert(err.message);
                }
              },
            }, 'Cancel'),
          ])
        );
      }

      listHost.appendChild(card);
    }
  }
  statusFilter.onchange = reload;
  await reload();
}

// ---------------- Global chrome: FAB + chat agent drawer (B10) ----------------
// FAB + chat toggle + drawer live outside #view in index.html (see comment
// there), so they're wired exactly once here - never per-render - and they
// survive every router() view-swap untouched.

let chatHistory = []; // [{role:'user'|'assistant', content}] - sent back each turn per POST /api/agent contract
let chatSending = false;

function chatEls() {
  return {
    toggle: document.getElementById('chat-toggle'),
    drawer: document.getElementById('chat-drawer'),
    close: document.getElementById('chat-close'),
    messages: document.getElementById('chat-messages'),
    input: document.getElementById('chat-input'),
    send: document.getElementById('chat-send'),
    fab: document.getElementById('fab-new-post'),
  };
}

function openChatDrawer() {
  const { drawer, toggle, input } = chatEls();
  drawer.hidden = false;
  drawer.setAttribute('aria-hidden', 'false');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.classList.add('active');
  setTimeout(() => input && input.focus(), 0);
}

function closeChatDrawer() {
  const { drawer, toggle } = chatEls();
  drawer.hidden = true;
  drawer.setAttribute('aria-hidden', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.classList.remove('active');
}

function toggleChatDrawer() {
  const { drawer } = chatEls();
  if (drawer.hidden) openChatDrawer();
  else closeChatDrawer();
}

function appendChatBubble({ role, text, actions, isError = false }) {
  const { messages } = chatEls();
  const bubble = el('div', { class: `chat-msg chat-msg-${role}${isError ? ' chat-msg-error' : ''}` }, text);
  messages.appendChild(bubble);
  if (actions && actions.length) {
    const chipRow = el(
      'div',
      { class: 'chat-action-chips' },
      actions.map((a) => {
        const label = a.summary || a.tool || 'action';
        if (a.link) {
          const chip = el('a', { class: 'chat-action-chip', href: a.link }, label);
          chip.addEventListener('click', () => {
            // Navigation happens via the href hash change (router() picks it
            // up); keep the drawer open so the reply/actions stay visible.
          });
          return chip;
        }
        return el('span', { class: 'chat-action-chip' }, label);
      })
    );
    messages.appendChild(chipRow);
  }
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function appendTypingIndicator() {
  const { messages } = chatEls();
  const bubble = el('div', { class: 'chat-msg chat-msg-assistant chat-msg-typing' }, [
    el('span', { class: 'chat-typing-dot' }),
    el('span', { class: 'chat-typing-dot' }),
    el('span', { class: 'chat-typing-dot' }),
  ]);
  messages.appendChild(bubble);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function setChatSending(sending) {
  chatSending = sending;
  const { send, input } = chatEls();
  send.disabled = sending;
  input.disabled = sending;
}

async function sendChatMessage() {
  if (chatSending) return;
  const { input } = chatEls();
  const message = input.value.trim();
  if (!message) return;

  appendChatBubble({ role: 'user', text: message });
  chatHistory.push({ role: 'user', content: message });
  input.value = '';
  autosizeChatInput();

  setChatSending(true);
  const typing = appendTypingIndicator();

  try {
    const res = await api('/api/agent', {
      method: 'POST',
      body: { message, history: chatHistory, brand_id: getStickyBrand() || undefined },
    });
    typing.remove();
    appendChatBubble({ role: 'assistant', text: res.reply || '(no reply)', actions: res.actions });
    chatHistory = res.history || chatHistory.concat([{ role: 'assistant', content: res.reply || '' }]);
    if (res.actions && res.actions.length) {
      // An action may have changed underlying data (new draft, edited copy,
      // new idea, …) - re-run the router so the current view picks it up.
      // router() only swaps #view, so the drawer (outside #view) stays put.
      router();
    }
  } catch (err) {
    typing.remove();
    if (err.status === 503 || err.data?.error === 'ai_unavailable') {
      appendChatBubble({
        role: 'assistant',
        text: err.data?.message || 'AI agent unavailable - claude CLI not found.',
        isError: true,
      });
    } else {
      appendChatBubble({ role: 'assistant', text: `Error: ${err.message}`, isError: true });
    }
  } finally {
    setChatSending(false);
    input.focus();
  }
}

function autosizeChatInput() {
  const { input } = chatEls();
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
}

// ---------------- Action-center popover (B12) ----------------
// Third corner button, a shell sibling like the FAB/chat toggle (see
// index.html comment) - read-only quick stats reachable from every view.
// Reuses /api/usage + /api/analytics (no new endpoints); refreshes each time
// it's opened.

function actionCenterEls() {
  return {
    toggle: document.getElementById('action-center-toggle'),
    popover: document.getElementById('action-center-popover'),
    close: document.getElementById('action-center-close'),
    body: document.getElementById('action-center-body'),
  };
}

async function refreshActionCenter() {
  const { body } = actionCenterEls();
  if (!body) return;
  body.innerHTML = '';
  body.appendChild(el('p', { style: 'color:var(--muted);font-size:12px;' }, 'Loading…'));
  try {
    const [usage, analyticsData] = await Promise.all([
      api('/api/usage'),
      api('/api/analytics').catch(() => null),
    ]);
    let engagement30 = 0;
    for (const b of analyticsData?.brands || []) engagement30 += b.totals?.['30d']?.engagement || 0;

    body.innerHTML = '';
    body.appendChild(
      el(
        'div',
        { class: 'action-center-stats' },
        [
          ['Drafts awaiting', usage.drafts_awaiting],
          ['Scheduled this week', usage.scheduled_this_week],
          ['Published this month', usage.published_this_month],
          ['30-day engagement', engagement30],
        ].map(([label, value]) =>
          el('div', { class: 'action-center-stat' }, [
            el('div', { class: 'action-center-stat-value' }, String(value ?? 0)),
            el('div', { class: 'action-center-stat-label' }, label),
          ])
        )
      )
    );
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load stats: ${err.message}`));
  }
}

function openActionCenter() {
  const { popover, toggle } = actionCenterEls();
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  toggle.setAttribute('aria-expanded', 'true');
  toggle.classList.add('active');
  refreshActionCenter();
}

function closeActionCenter() {
  const { popover, toggle } = actionCenterEls();
  popover.hidden = true;
  popover.setAttribute('aria-hidden', 'true');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.classList.remove('active');
}

function toggleActionCenter() {
  const { popover } = actionCenterEls();
  if (popover.hidden) openActionCenter();
  else closeActionCenter();
}

function wireGlobalChrome() {
  const { toggle, close, send, input, fab } = chatEls();
  if (!toggle) return; // defensive - shouldn't happen, index.html always has these

  fab.addEventListener('click', () => { location.hash = '#/composer'; });
  toggle.addEventListener('click', toggleChatDrawer);
  close.addEventListener('click', closeChatDrawer);
  send.addEventListener('click', sendChatMessage);
  input.addEventListener('input', autosizeChatInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChatMessage();
    }
  });

  const ac = actionCenterEls();
  if (ac.toggle) {
    ac.toggle.addEventListener('click', toggleActionCenter);
    ac.close.addEventListener('click', closeActionCenter);
    ac.popover.querySelectorAll('.action-center-links a').forEach((a) => {
      a.addEventListener('click', () => closeActionCenter());
    });
  }
}

wireGlobalChrome();
