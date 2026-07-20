// PostDeck dashboard - vanilla JS, hash routing, no build step, no CDN.

const API = '';
const BRAND_COLORS = ['#C8902A', '#3d7ab8', '#4c9a5b', '#c0392b', '#8e6fc4'];

// Per-platform dot color for the calendar's gap-finding indicators (B17b) -
// distinct from BRAND_COLORS (brand identity) since a day cell can show both.
const CAL_PLATFORM_COLORS = {
  twitter: '#3d7ab8',
  linkedin: '#2f6fa8',
  facebook: '#4267b2',
  instagram: '#c0392b',
  tiktok: '#e4b44e',
  reddit: '#c0722e',
  blog: '#6f8b63',
};
function platformDotColor(platform) {
  return CAL_PLATFORM_COLORS[platform] || '#a3a19a';
}

// ---------------- B17a: tags & campaigns ----------------
// Small fixed palette for auto-coloring newly created tags/campaigns (the
// operator never has to pick a color by hand). Cycled by creation order.
const TAG_COLOR_PALETTE = ['#3d7ab8', '#4c9a5b', '#c0392b', '#e4b44e', '#8e6fc4', '#c0722e', '#2f6fa8', '#6f8b63'];
let tagColorCursor = 0;
function nextTagColor() {
  const c = TAG_COLOR_PALETTE[tagColorCursor % TAG_COLOR_PALETTE.length];
  tagColorCursor++;
  return c;
}

// Module-level cache of all tags (globals + every brand's) - refreshed
// whenever the calendar or composer needs a current list. Kept simple (no
// invalidation beyond re-fetch) since tag/campaign volume is low.
let allTagsCache = [];
async function loadAllTags() {
  try {
    allTagsCache = await api('/api/tags');
  } catch {
    // best-effort; calendar/analytics tag features just no-op without it
  }
  return allTagsCache;
}
function tagById(id) {
  return allTagsCache.find((t) => String(t.id) === String(id));
}

// Read-only tag chip for display in the post modal / calendar tooltips.
function tagDisplayChip(tag) {
  return el(
    'span',
    { class: 'pill tag-pill' + (tag.kind === 'campaign' ? ' campaign-pill' : ''), style: `border-left:3px solid ${tag.color || '#a3a19a'};` },
    tag.name
  );
}

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

// F1: the "…see more" feed-fold point for a platform, from
// config/platform-specs.json's <platform>.preview.fold_chars (null = no fold,
// e.g. reddit is title-led and blog renders full-length on the site).
function foldCharsFor(platform) {
  const spec = platformSpec(platform);
  if (spec && spec.preview && spec.preview.fold_chars !== undefined) return spec.preview.fold_chars;
  const FALLBACK_FOLD = { linkedin: 210, facebook: 477, twitter: 280, instagram: 125, tiktok: 1000, reddit: null, blog: null };
  return FALLBACK_FOLD[platform] ?? null;
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

// ---------------- Send to Blotato now (2026-07-19 UI pass, item 1/2) ----------------
function accountForPost(post) {
  return state.accounts.find((a) => String(a.id) === String(post.account_id)) || null;
}
function isManualPost(post) {
  const acct = accountForPost(post);
  return acct ? isManualAccount(acct) : isManualPlatform(post.platform);
}
function isMissedWindowPost(post) {
  return typeof post.error_message === 'string' && post.error_message.startsWith('missed_window:');
}
// Per-post "Send to Blotato now" eligibility: scheduled_local/approved with a
// publish_at set, not a manual account/platform, not already submitted or
// published (those statuses are excluded by not being scheduled_local/approved).
function canSendToBlotatoNow(post) {
  if (!post || !['scheduled_local', 'approved'].includes(post.status)) return false;
  if (!post.publish_at) return false;
  if (isManualPost(post)) return false;
  return true;
}
async function sendToBlotatoNow(postId, { onDone } = {}) {
  try {
    const res = await api(`/api/posts/${postId}/submit`, { method: 'POST', body: {} });
    const dry = res.status === 'submitted_dry' || res.post?.status === 'submitted_dry';
    toast(dry ? 'Sent to Blotato (dry run) - no real Blotato call was made.' : 'Sent to Blotato.', 'ok');
    if (typeof onDone === 'function') onDone();
    else if (typeof currentCalendarReload === 'function') currentCalendarReload();
    return res;
  } catch (err) {
    toast(`Could not send: ${err.message}`, 'error');
    return null;
  }
}
// Shared button + sub-line, used by the popover/modal/review "send now" spot.
function sendNowControl(post, { onDone, size = 'sm' } = {}) {
  const btn = el('button', { class: `button secondary ${size}`, type: 'button' }, 'Send to Blotato now');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await sendToBlotatoNow(post.id, { onDone });
    btn.disabled = false;
  });
  return el('div', { class: 'send-now-wrap' }, [
    btn,
    el('div', { class: 'send-now-sub' }, 'hands off now - still publishes at the scheduled time'),
  ]);
}
// Manual-account inline banner (item 4) - shown wherever a manual-account
// scheduled/approved post is surfaced.
function manualAccountBanner() {
  return inlineBanner("This account is set to manual - the worker will never send this to Blotato. Fix in Settings → Brands, or use Mark posted.", 'info');
}
function missedWindowBanner(post, { onResolved } = {}) {
  const wrap = el('div', {}, [
    inlineBanner('⚠ missed window - review and resend', 'error'),
    sendNowControl(post, { onDone: onResolved }),
  ]);
  return wrap;
}

// Blotato only auto-chains first comments on twitter/bluesky/threads. For
// every other platform the stored first_comment is a manual step: once the
// post is out, remind the operator to paste it as the first comment.
const FIRST_COMMENT_AUTO_PLATFORMS = ['twitter', 'bluesky', 'threads'];
function firstCommentReminder(post) {
  if (!post.first_comment || !String(post.first_comment).trim()) return null;
  if (FIRST_COMMENT_AUTO_PLATFORMS.includes(post.platform)) return null;
  if (!['submitted', 'published'].includes(post.status)) return null;
  const copyBtn = el('button', { class: 'button sm secondary' }, 'Copy comment');
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(post.first_comment);
      toast('First comment copied - paste it on the live post.');
    } catch {
      toast('Could not copy - select the text manually.', 'error');
    }
  };
  return el('div', { class: 'first-comment-reminder' }, [
    inlineBanner(
      `💬 Paste as the FIRST COMMENT after this ${post.platform} post is live (auto-comment isn't supported there): "${post.first_comment}"`,
      'warn'
    ),
    copyBtn,
  ]);
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
// F8: persisted calendar view mode (month/week/upcoming) for the standalone
// #/calendar route - the Home-embedded calendar still forces 'week' (B9).
const STICKY_CAL_VIEW_KEY = 'pd_cal_view_mode';
function getStickyCalView() {
  return localStorage.getItem(STICKY_CAL_VIEW_KEY) || null;
}
function setStickyCalView(mode) {
  localStorage.setItem(STICKY_CAL_VIEW_KEY, mode);
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

// Turn a `.card` (whose first child is an <h2> title) into a collapsible
// section: the title becomes a clickable header with a chevron, the rest
// folds into a toggle-able body. Open/closed state persists in localStorage
// under `key` so the operator's layout preferences stick between sessions.
// Mutates the card in place and returns it.
// Autosizing textarea (item 3 - "when I make text, I should be able to edit
// it and make it easy"): grows with content instead of forcing a scrollbar
// inside a fixed-height box, on every input plus once immediately (so a
// prefilled value, e.g. an AI draft or Quick Compose handoff, is sized
// correctly without the operator having to type first). Safe to call more
// than once on the same textarea (re-renders re-set the same listener).
function autosizeTextarea(ta) {
  if (!ta || ta.dataset.autosize === '1') return ta;
  ta.dataset.autosize = '1';
  const resize = () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight + 2}px`;
  };
  ta.addEventListener('input', resize);
  requestAnimationFrame(resize);
  return ta;
}

function makeCollapsible(card, { open = true, key, draggable = false } = {}) {
  if (!card || card.dataset.collapsible === '1') return card;
  const storeKey = key ? `pd_collapse_${key}` : null;
  let isOpen = open;
  if (storeKey) {
    const saved = localStorage.getItem(storeKey);
    if (saved === '0') isOpen = false;
    else if (saved === '1') isOpen = true;
  }
  const kids = [...card.childNodes];
  const h2 = kids.find((n) => n.nodeType === 1 && n.tagName === 'H2');
  const title = h2 ? h2.textContent : '';
  const rest = kids.filter((n) => n !== h2);
  card.innerHTML = '';
  card.classList.add('collapsible');
  card.dataset.collapsible = '1';
  if (key) card.dataset.sectionKey = key;
  const chevron = el('span', { class: 'collapse-chevron' }, isOpen ? '▾' : '▸');
  const headerKids = [];
  if (draggable) {
    headerKids.push(
      el('span', {
        class: 'drag-handle',
        title: 'Drag to reorder',
        // Prevent the click-to-toggle handler on the header from also firing
        // when grabbing the handle - mousedown stopPropagation is enough
        // since HTML5 DnD itself starts on its own dragstart event.
        onmousedown: (e) => e.stopPropagation(),
      }, '⠿')
    );
  }
  headerKids.push(el('span', { class: 'collapsible-title' }, title), chevron);
  const header = el('div', { class: 'collapsible-header' }, headerKids);
  if (draggable) {
    header.draggable = true;
    header.classList.add('is-draggable');
  }
  const bodyWrap = el('div', { class: 'collapsible-body' });
  rest.forEach((n) => bodyWrap.appendChild(n));
  function apply() {
    card.classList.toggle('collapsed', !isOpen);
    chevron.textContent = isOpen ? '▾' : '▸';
  }
  header.addEventListener('click', (e) => {
    if (e.target.closest('.drag-handle')) return;
    isOpen = !isOpen;
    if (storeKey) localStorage.setItem(storeKey, isOpen ? '1' : '0');
    apply();
  });
  apply();
  card.append(header, bodyWrap);
  return card;
}

// L4 - drag-to-reorder for a set of makeCollapsible cards that share a
// parent container. `container` is the element the cards are appended into
// (order of DOM children == visual order); `storageKey` persists the chosen
// order (array of section keys) to localStorage so it applies on every
// future render. `sections` is the ordered list of {key, node} the caller
// built - reordering only ever re-appends existing nodes (no re-creation,
// same pattern as the pre-existing "D2 L3 assembly" reorder).
function makeSectionsReorderable(container, storageKey, sections) {
  const order = loadSectionOrder(storageKey, sections.map((s) => s.key));
  const byKey = Object.fromEntries(sections.map((s) => [s.key, s.node]));
  function applyOrder(keys) {
    for (const k of keys) {
      if (byKey[k]) container.appendChild(byKey[k]);
    }
  }
  applyOrder(order);

  let dragKey = null;
  for (const { key, node } of sections) {
    const header = node.querySelector(':scope > .collapsible-header');
    if (!header) continue;
    header.addEventListener('dragstart', (e) => {
      dragKey = key;
      node.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', key); } catch { /* some browsers require this call to not throw */ }
    });
    header.addEventListener('dragend', () => {
      node.classList.remove('is-dragging');
      dragKey = null;
    });
    node.addEventListener('dragover', (e) => {
      if (!dragKey || dragKey === key) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    node.addEventListener('drop', (e) => {
      if (!dragKey || dragKey === key) return;
      e.preventDefault();
      const current = [...container.children]
        .map((n) => n.dataset.sectionKey)
        .filter(Boolean);
      const from = current.indexOf(dragKey);
      const to = current.indexOf(key);
      if (from === -1 || to === -1) return;
      current.splice(from, 1);
      current.splice(to, 0, dragKey);
      saveSectionOrder(storageKey, current);
      applyOrder(current);
      dragKey = null;
    });
  }
}

function loadSectionOrder(storageKey, defaultKeys) {
  let saved = [];
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
  } catch {
    saved = [];
  }
  if (!Array.isArray(saved)) saved = [];
  const known = new Set(defaultKeys);
  const ordered = saved.filter((k) => known.has(k));
  for (const k of defaultKeys) {
    if (!ordered.includes(k)) ordered.push(k);
  }
  return ordered;
}

function saveSectionOrder(storageKey, keys) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(keys));
  } catch {
    // best-effort only - a failed persist just means order resets next load
  }
}

// =====================================================================
// D2 — Design consistency pass primitives (2026-07-18)
// See docs/D2_CONSISTENCY_PASS_SPEC.md. Small, dependency-free helpers in
// the same style as el()/makeCollapsible - views compose these instead of
// hand-rolling headers/forms/feedback per view.
// =====================================================================

// R1 - page header: title (h1) + a fixed-order action row. `actions` is a
// flat list of elements (buttons/selects/links); callers are responsible
// for passing them already in the fixed order (date-range left, share/export
// next, filters rightmost, overflow last) since the order varies per view.
function pageHeader(title, ...actions) {
  const flat = actions.flat().filter(Boolean);
  return el('div', { class: 'page-header' }, [
    el('h1', {}, title),
    el('div', { class: 'page-header-actions' }, flat),
  ]);
}

// R3 - a labeled group of form rows with an optional one-line hint. `rows`
// are elements (typically `.field-row`s or `.form-section-row`s); this just
// gives them a shared label/hint/spacing treatment instead of an ad-hoc div.
function formSection(label, hint, ...rows) {
  const flat = rows.flat().filter(Boolean);
  const kids = [];
  if (label) kids.push(el('div', { class: 'form-section-label' }, label));
  if (hint) kids.push(el('div', { class: 'form-section-hint' }, hint));
  kids.push(el('div', { class: 'form-section-body' }, flat));
  return el('div', { class: 'form-section' }, kids);
}

// R5 - toast: transient, one-off outcome (saved/queued/deleted). Only one
// shows at a time; auto-dismisses. Not for persistent/anchored conditions -
// use inlineBanner for those.
let toastHost = null;
let toastTimer = null;
function toast(msg, kind = 'ok') {
  if (typeof document === 'undefined') return;
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host' });
    document.body.appendChild(toastHost);
  }
  toastHost.innerHTML = '';
  toastHost.appendChild(el('div', { class: `toast toast-${kind}` }, msg));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastHost.innerHTML = ''; }, 3500);
}

// R5 - inline banner: persistent condition anchored to the object it
// describes ("AI not logged in", "no open slot"). Caller appends/removes it
// in place (same pattern the old ad-hoc `.msg-banner` divs used); this just
// gives them one shared visual class instead of inline styles per call site.
function inlineBanner(msg, kind = 'info') {
  return el('div', { class: `inline-banner inline-banner-${kind}` }, msg);
}

// R4 - empty state: one reassuring line + at most one clear CTA button.
function emptyState(msg, ctaLabel, ctaFn) {
  const kids = [el('div', { class: 'empty-state-msg' }, msg)];
  if (ctaLabel && ctaFn) kids.push(el('button', { class: 'button secondary sm', type: 'button', onclick: ctaFn }, ctaLabel));
  return el('div', { class: 'empty-state' }, kids);
}

// ---------------- F1: platform icons + feed preview ----------------
// Hand-rolled single-color SVGs (currentColor, 16px viewBox) - no external
// assets/deps. Exported on window.PostDeckIcons too so later agents (F7
// calendar chips/popover, coverage strip) can reuse the exact same set
// without re-implementing paths.
const PLATFORM_ICON_PATHS = {
  linkedin: '<path d="M3.5 5.5a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zM2 7h3v7H2V7zm5 0h2.9v1h.04c.4-.75 1.4-1.55 2.9-1.55C15.9 6.45 16 8.1 16 10v4h-3v-3.5c0-.85 0-1.95-1.2-1.95-1.2 0-1.4.93-1.4 1.9V14H7V7z"/>',
  facebook: '<path d="M10.9 16V9.2h2.3l.34-2.65h-2.64V4.86c0-.77.21-1.29 1.32-1.29h1.4V1.2C13 1.13 12.2 1 11.27 1 9.3 1 7.95 2.2 7.95 4.4v1.15H5.6V8.2h2.35V16h2.95z"/>',
  instagram: '<path d="M8 4.7A3.3 3.3 0 1 0 8 11.3 3.3 3.3 0 0 0 8 4.7zm0 5.45A2.15 2.15 0 1 1 8 5.85a2.15 2.15 0 0 1 0 4.3zM11.4 4.55a.77.77 0 1 1 0-1.54.77.77 0 0 1 0 1.54zM16 4.8c-.06-1.03-.29-1.94-1.06-2.7C14.18 1.34 13.27 1.1 12.24 1.05 11.18 1 4.82 1 3.76 1.05c-1.03.05-1.94.29-2.7 1.05C.3 2.86.06 3.77 1.05 4.8.5 5.87.5 12.13 1.05 13.2c.06 1.03.29 1.94 1.06 2.7.76.76 1.67 1 2.7 1.05 1.06.05 7.42.05 8.48 0 1.03-.05 1.94-.29 2.7-1.05.76-.76 1-1.67 1.05-2.7.06-1.06.06-7.32 0-8.4zM14.5 12.9a2.9 2.9 0 0 1-1.63 1.63c-1.13.45-3.8.34-5.04.34s-3.92.1-5.04-.34A2.9 2.9 0 0 1 1.16 12.9c-.45-1.13-.35-3.8-.35-5.04S.7 3.94 1.16 2.82A2.9 2.9 0 0 1 2.79 1.2c1.13-.45 3.8-.34 5.04-.34s3.92-.1 5.04.34a2.9 2.9 0 0 1 1.63 1.63c.45 1.13.34 3.8.34 5.04s.11 3.9-.34 5.03z"/>',
  twitter: '<path d="M9.53 6.9 15 1h-1.3l-4.75 5.13L5.15 1H1l5.74 8.15L1 15h1.3l5.02-5.42L11.5 15h4.15L9.53 6.9zm-1.78 1.92-.58-.8L2.6 1.9h2l3.72 5.17.58.8 4.85 6.74h-2L7.75 8.82z"/>',
  tiktok: '<path d="M11.4 1h-2.3v9.7a1.95 1.95 0 1 1-1.4-1.87V6.5a4.35 4.35 0 1 0 3.7 4.3V6.1a5.4 5.4 0 0 0 3.1.97V4.8a3 3 0 0 1-3.1-3.05V1z"/>',
  reddit: '<circle cx="8" cy="8.8" r="6" fill="none" stroke="currentColor" stroke-width="1.15"/><circle cx="5.6" cy="8.6" r=".85"/><circle cx="10.4" cy="8.6" r=".85"/><path d="M5.3 10.4c.7.55 1.6.85 2.7.85s2-.3 2.7-.85" fill="none" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/><path d="M8 5.6V2.8m0 0 2.1.55M8 2.8 6.4 3.9" fill="none" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/><circle cx="10.7" cy="3.6" r=".85"/>',
  youtube: '<path d="M15.4 4.9a2 2 0 0 0-1.4-1.4C12.7 3.2 8 3.2 8 3.2s-4.7 0-6 .3a2 2 0 0 0-1.4 1.4A21 21 0 0 0 .3 8c0 1 .1 2.1.3 3.1a2 2 0 0 0 1.4 1.4c1.3.3 6 .3 6 .3s4.7 0 6-.3a2 2 0 0 0 1.4-1.4c.2-1 .3-2 .3-3.1 0-1-.1-2.1-.3-3.1zM6.4 10.3V5.7L10.4 8l-4 2.3z"/>',
  blog: '<path d="M4 1.5h6.2L13 4.3V14.5H4v-13z" fill="none" stroke="currentColor" stroke-width="1"/><path d="M6 6h5M6 8.3h5M6 10.6h3.3" stroke="currentColor" stroke-width=".9" stroke-linecap="round"/>',
};
function platformIcon(name, { size = 16 } = {}) {
  const key = String(name || '').toLowerCase();
  const inner = PLATFORM_ICON_PATHS[key] || PLATFORM_ICON_PATHS.blog;
  const span = el('span', { class: 'platform-icon', 'data-platform': key, style: `display:inline-flex;width:${size}px;height:${size}px;vertical-align:middle;` });
  span.innerHTML = `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="currentColor" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
  return span;
}
if (typeof window !== 'undefined') window.PostDeckIcons = { platformIcon, PLATFORM_ICON_PATHS };

// "Fold in N chars" hint - amber under 30 remaining, red once past the fold.
// Returns { text, cls } for callers to plug into a `.fold-counter` node; null
// text when the platform has no fold point (reddit/blog).
function foldCounterState(text, foldChars) {
  if (foldChars == null) return { text: '', cls: '' };
  const len = (text || '').length;
  const remaining = foldChars - len;
  if (remaining < 0) return { text: `${Math.abs(remaining)} over the fold`, cls: 'fold-over' };
  if (remaining <= 30) return { text: `Fold in ${remaining} chars`, cls: 'fold-amber' };
  return { text: `Fold in ${remaining} chars`, cls: '' };
}

// F1 - feed-card mockup approximating how the post reads in-platform: header
// (avatar/logo, brand name, platform icon+label), copy with a dimmed
// "…see more" fold, optional image thumb. Deliberately a light card on the
// app's dark chrome (matches how Sprout/Blotato-style previews read) so it
// visually reads as "the platform" rather than more app chrome. Twitter is a
// hard limit (invalid over 280), not a soft fold, so overflow is reddened
// instead of dimmed.
function renderPostPreview(platform, { copy = '', mediaUrl = null, brand = null } = {}) {
  const foldChars = foldCharsFor(platform);
  const isHardLimit = platform === 'twitter';
  const text = copy || '';

  const header = el('div', { class: 'feed-preview-header' });
  if (brand && brand.logo_path) {
    header.appendChild(el('img', { class: 'feed-preview-avatar', src: brand.logo_path, alt: `${brand.name || 'Brand'} logo` }));
  } else {
    let initial = '?';
    if (brand && brand.name) initial = brand.name.trim().charAt(0).toUpperCase();
    header.appendChild(el('div', { class: 'feed-preview-avatar feed-preview-avatar-disc' }, initial));
  }
  const headerText = el('div', { class: 'feed-preview-header-text' }, [
    el('div', { class: 'feed-preview-brand' }, (brand && brand.name) || 'Brand'),
    el('div', { class: 'feed-preview-platform' }, [platformIcon(platform, { size: 13 }), el('span', {}, ` ${platform}`)]),
  ]);
  header.appendChild(headerText);

  const bodyEl = el('div', { class: 'feed-preview-body' });
  if (isHardLimit && foldChars != null) {
    if (text.length <= foldChars) {
      bodyEl.appendChild(el('span', {}, text || '(no copy yet)'));
    } else {
      bodyEl.append(
        el('span', {}, text.slice(0, foldChars)),
        el('span', { class: 'feed-preview-overflow' }, text.slice(foldChars))
      );
    }
  } else if (foldChars != null && text.length > foldChars) {
    bodyEl.append(
      el('span', {}, text.slice(0, foldChars)),
      el('div', { class: 'feed-preview-fold-line' }, '···· see more fold ····'),
      el('span', { class: 'feed-preview-dimmed' }, text.slice(foldChars))
    );
  } else {
    bodyEl.appendChild(el('span', {}, text || '(no copy yet)'));
  }

  const card = el('div', { class: `feed-preview-card feed-preview-${platform}` }, [header, bodyEl]);
  if (mediaUrl) {
    card.appendChild(el('div', { class: 'feed-preview-media' }, [el('img', { src: mediaUrl, alt: '' })]));
  }
  return card;
}

// Calendar auto-refresh singleton: the current calendar render assigns its
// guarded reload here; one global focus/visibility listener calls it so a tab
// left open re-fetches instead of showing stale data. See renderCalendarInto.
let currentCalendarReload = null;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && typeof currentCalendarReload === 'function') currentCalendarReload();
  });
  window.addEventListener('focus', () => {
    if (typeof currentCalendarReload === 'function') currentCalendarReload();
  });
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
  review: renderReview,
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
  view.classList.add('view-flush');
  const container = el('div');
  view.appendChild(container);
  await renderCalendarInto(container, { defaultMode: getStickyCalView() || 'month' });
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
    el('option', { value: 'upcoming', selected: defaultMode === 'upcoming' ? 'selected' : undefined }, 'Upcoming'),
  ]);
  // B17a: tag/campaign filter - populated from GET /api/tags, filtered
  // client-side against each post's tags[] (same pattern as brand/platform).
  await loadAllTags();
  const tagFilter = el('select', { id: 'cal-tag' }, [
    el('option', { value: '' }, 'All tags/campaigns'),
    ...allTagsCache.map((t) => el('option', { value: t.id }, `${t.kind === 'campaign' ? '🏷 ' : ''}${t.name}`)),
  ]);
  // Period nav: prev / label / next / Today. Steps by month (month view) or
  // week (week view). Lets CB move between months without hunting.
  const prevBtn = el('button', { class: 'cal-nav-btn', title: 'Previous' }, '‹');
  const nextBtn = el('button', { class: 'cal-nav-btn', title: 'Next' }, '›');
  const todayBtn = el('button', { class: 'cal-nav-btn' }, 'Today');
  const refreshBtn = el('button', { class: 'cal-nav-btn', title: 'Refresh from server' }, '↻');
  const bulkSendBtn = el('button', { class: 'button secondary sm', type: 'button', title: 'Send every eligible post in the current view to Blotato now' }, 'Send to Blotato');
  const periodLabel = el('span', { class: 'cal-period-label' }, '');

  // item 2: from/to bounds for whichever view is currently showing (month /
  // week / Upcoming's 14-day span), so "Send to Blotato" only ever touches
  // what's actually on screen.
  function currentScopeRange() {
    const mode = viewToggle.value;
    let from, to;
    if (mode === 'month') {
      const y = refDate.getFullYear();
      const m = refDate.getMonth();
      from = new Date(y, m, 1, 0, 0, 0);
      to = new Date(y, m + 1, 0, 23, 59, 59);
    } else if (mode === 'week') {
      from = new Date(refDate);
      from.setHours(0, 0, 0, 0);
      to = new Date(refDate);
      to.setDate(to.getDate() + 6);
      to.setHours(23, 59, 59, 999);
    } else {
      from = new Date();
      from.setHours(0, 0, 0, 0);
      to = new Date(from);
      to.setDate(to.getDate() + 13);
      to.setHours(23, 59, 59, 999);
    }
    return { from: from.toISOString(), to: to.toISOString() };
  }
  bulkSendBtn.addEventListener('click', async () => {
    const { from, to } = currentScopeRange();
    const scope = { from, to };
    if (brandFilter.value) scope.brand_id = Number(brandFilter.value);
    if (platformFilter.value) scope.platform = platformFilter.value;
    bulkSendBtn.disabled = true;
    try {
      const qs = new URLSearchParams({ from, to });
      if (scope.brand_id) qs.set('brand_id', scope.brand_id);
      if (scope.platform) qs.set('platform', scope.platform);
      const preview = await api(`/api/posts/submit-batch/preview?${qs.toString()}`);
      openBulkSendConfirm(preview, scope, () => reload());
    } catch (err) {
      toast(`Could not preview: ${err.message}`, 'error');
    } finally {
      bulkSendBtn.disabled = false;
    }
  });

  // L4: nav (view toggle + prev/today/next + period label) LEFT, refresh
  // middle-right, filters (brand/platform/tag) RIGHTMOST.
  const toolbar = el('div', { class: 'cal-toolbar' }, [
    el('div', { class: 'cal-toolbar-group' }, [viewToggle, prevBtn, todayBtn, nextBtn, periodLabel]),
    el('div', { class: 'cal-toolbar-group' }, [refreshBtn, bulkSendBtn]),
    el('div', { class: 'cal-toolbar-group cal-toolbar-filters' }, [
      el('span', {}, 'Brand:'), brandFilter,
      el('span', {}, 'Platform:'), platformFilter,
      el('span', {}, 'Tag:'), tagFilter,
    ]),
  ]);
  view.appendChild(pageHeader('Calendar / Queue'));
  view.appendChild(toolbar);

  const coverageStrip = el('div', { class: 'cal-coverage-strip' });
  view.appendChild(coverageStrip);

  const grid = el('div', { class: 'cal-grid', id: 'cal-grid' });
  view.appendChild(grid);
  // F8: Upcoming agenda view - swaps in for the grid when viewToggle === 'upcoming'.
  const agendaHost = el('div', { class: 'agenda-list', hidden: true });
  view.appendChild(agendaHost);

  function updateLabel(mode) {
    if (mode === 'month') {
      periodLabel.textContent = refDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    } else if (mode === 'week') {
      periodLabel.textContent = 'Week of ' + refDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } else {
      periodLabel.textContent = 'Next 14 days';
    }
  }

  async function reload() {
    const posts = await api('/api/posts');
    const brand = brandFilter.value;
    const platform = platformFilter.value;
    const tagId = tagFilter.value;
    const mode = viewToggle.value;
    const filtered = posts.filter(
      (p) =>
        (!brand || String(p.brand_id) === brand) &&
        (!platform || p.platform === platform) &&
        (!tagId || (p.tags || []).some((t) => String(t.id) === tagId))
    );
    updateLabel(mode);
    prevBtn.disabled = mode === 'upcoming';
    nextBtn.disabled = mode === 'upcoming';
    todayBtn.disabled = mode === 'upcoming';
    const allBrands = !brand;
    if (mode === 'upcoming') {
      coverageStrip.hidden = true;
      grid.hidden = true;
      agendaHost.hidden = false;
      drawAgenda(agendaHost, filtered, { allBrands });
    } else {
      coverageStrip.hidden = false;
      grid.hidden = false;
      agendaHost.hidden = true;
      renderCoverageStrip(coverageStrip, filtered, state.brands, mode, refDate);
      drawGrid(grid, filtered, mode, refDate, { allBrands });
    }
  }

  function step(dir) {
    const mode = viewToggle.value;
    if (mode === 'upcoming') return; // not paged by refDate
    if (mode === 'month') refDate.setMonth(refDate.getMonth() + dir, 1);
    else refDate.setDate(refDate.getDate() + dir * 7);
    reload();
  }
  prevBtn.onclick = () => step(-1);
  nextBtn.onclick = () => step(1);
  todayBtn.onclick = () => { refDate = new Date(); refDate.setHours(0, 0, 0, 0); reload(); };
  refreshBtn.onclick = reload;

  brandFilter.onchange = () => { setStickyBrand(brandFilter.value); reload(); };
  platformFilter.onchange = reload;
  tagFilter.onchange = reload;
  viewToggle.onchange = () => { setStickyCalView(viewToggle.value); reload(); };
  await reload();

  // Auto-refresh: the SPA doesn't live-update, so a tab left open goes stale
  // (posts publish, statuses change) and looks broken. Re-fetch whenever this
  // calendar's grid is the live one and the tab regains focus. A module-level
  // singleton (currentCalendarReload) means only the current render reloads -
  // stale listeners from old renders no-op, no accumulation, no leak.
  currentCalendarReload = () => { if (document.body.contains(grid)) reload(); };

  async function reschedulePost(postId, newDateKey, posts) {
    const post = posts.find((p) => String(p.id) === String(postId));
    if (!post) return;
    if (!RESCHEDULABLE_STATUSES.includes(post.status)) return; // UI-side guard
    const newPublishAt = rescheduleToDateKeepingTime(post.publish_at, newDateKey);
    try {
      await api(`/api/posts/${postId}`, { method: 'PATCH', body: { publish_at: newPublishAt } });
      await reload();
      toast('Post rescheduled.');
    } catch (err) {
      toast(`Could not reschedule: ${err.message}`, 'error');
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
  // Both quick-create buttons now open the Quick Compose modal (compact
  // brand/accounts/copy/schedule dialog) instead of navigating to the full
  // #/composer page - see openQuickCompose. "Open full composer" inside the
  // modal is still the escape hatch to the full page for anything more
  // involved (per-platform variants, TikTok/Reddit fields, tags, etc).
  function goCompose() {
    const brand = getBrand();
    openQuickCompose(brand ? { brandId: brand } : {});
  }

  return el('div', { class: 'home-quickbar' }, [
    el('button', { class: 'button primary md', onclick: () => goCompose() }, '+ New Post'),
    el('button', { class: 'button secondary md', onclick: () => goCompose() }, 'Draft with AI'),
    el('button', { class: 'button secondary md', onclick: () => { location.hash = '#/ideas'; } }, '+ Idea'),
    el('button', { class: 'button secondary md', onclick: () => { location.hash = '#/images'; } }, 'Request image (Codex)'),
    el('button', { class: 'button secondary md', onclick: onRedistribute }, 'Redistribute blog post'),
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
    rows.push(attentionRow(`Review drafts (${drafts.length})`, '#/review', 'warn'));
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
    list.appendChild(emptyState('All clear - nothing needs attention right now.'));
  } else {
    rows.forEach((r) => list.appendChild(r));
  }
  card.appendChild(list);
  container.appendChild(card);
}

// Small brand-initial disc for the "All brands" view (item 5) - reuses the
// same brandColor mapping the coverage strip already assigns per-brand.
function brandIdentityDisc(brandId) {
  const name = brandName(brandId) || '?';
  return el('span', { class: 'brand-identity-disc', style: `background:${brandColor(brandId)}`, title: brandName(brandId) }, name.trim().charAt(0).toUpperCase());
}
function manualWarnGlyph(post) {
  if (isMissedWindowPost(post)) return el('span', { class: 'manual-warn-glyph missed-window', title: 'missed window - review and resend' }, '⚠');
  if (['scheduled_local', 'approved'].includes(post.status) && isManualPost(post)) {
    return el('span', { class: 'manual-warn-glyph', title: "won't auto-post - this account is manual" }, '⚠');
  }
  return null;
}

function weekChip(p, { allBrands = true } = {}) {
  const chip = el('a', { href: `#/post/${p.id}`, class: 'week-chip', style: `border-left-color:${brandColor(p.brand_id)}`, title: `${brandName(p.brand_id)} - ${p.platform} - ${p.status}` }, [
    el('span', { class: 'week-chip-dot', style: `background:${brandColor(p.brand_id)}` }),
    allBrands ? brandIdentityDisc(p.brand_id) : null,
    platformIcon(p.platform, { size: 12 }),
    el('span', { class: 'week-chip-copy' }, (p.copy || '(no copy)').slice(0, 28)),
    manualWarnGlyph(p),
    el('span', { class: 'week-chip-date' }, fmtDate(p.publish_at)),
  ]);
  chip.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    openPostModal(p.id);
  });
  return chip;
}

function buildWeekSection(container, posts, allBrands = true) {
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
    upcoming.slice(0, 6).forEach((p) => strip.appendChild(weekChip(p, { allBrands })));
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
    row.appendChild(emptyState('No connected accounts yet.', 'Go to settings', () => { location.hash = '#/settings'; }));
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
        platformIcon(acct.platform, { size: 13 }),
        el('span', { class: 'platform-chip-name' }, ` ${acct.platform} · ${brandName(acct.brand_id)}`),
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

// ---- F6: brand setup completeness card ----
// One collapsible row per brand, checks over existing endpoints only (no
// backend changes): Blotato account connected, queue slots defined, link
// tracking (neutral off/on - never a warning, it's optional), brand profile
// current (no stale profiles + at least one exists), voice/tone set (a
// per-brand tone profile with rules, OR the shared global voice). Each item
// jumps to the relevant view/brand context. A brand at 100% collapses by
// default (via makeCollapsible's per-key localStorage persistence) so a
// fully-set-up roster doesn't clutter Home once it's done.
async function buildSetupCard(container) {
  container.innerHTML = '';
  const card = el('div', { class: 'card home-section' });
  card.appendChild(el('h2', {}, 'Setup'));
  const body = el('div', { class: 'setup-card-body' });
  body.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'Checking brand setup…'));
  card.appendChild(body);
  container.appendChild(card);

  if (!state.brands.length) {
    body.innerHTML = '';
    body.appendChild(emptyState('No brands yet.', 'Go to settings', () => { location.hash = '#/settings'; }));
    return;
  }

  let profiles = [];
  let globalVoiceSet = false;
  try {
    const settings = await api('/api/settings');
    globalVoiceSet = Boolean((settings.global_voice || '').trim());
  } catch { /* best-effort */ }
  try {
    profiles = await api('/api/profiles');
  } catch { /* best-effort - endpoint may not exist yet */ }

  const perBrand = await Promise.all(
    state.brands.map(async (b) => {
      const [slots, tones] = await Promise.all([
        api(`/api/queue-slots?brand_id=${b.id}`).catch(() => []),
        api(`/api/tone-profiles?brand_id=${b.id}`).catch(() => []),
      ]);
      const brandAccounts = state.accounts.filter((a) => String(a.brand_id) === String(b.id));
      const brandProfiles = (profiles || []).filter((p) => String(p.brand_id) === String(b.id));
      const hasToneRules = (tones || []).some((t) => (t.voice_rules || '').trim().length > 0);
      const jumpToBrand = (hash) => { setStickyBrand(String(b.id)); location.hash = hash; };

      const checks = [
        {
          label: 'Blotato account connected',
          done: brandAccounts.length > 0,
          jump: () => jumpToBrand('#/composer'),
        },
        {
          label: 'Queue slots defined',
          done: (slots || []).length > 0,
          jump: () => jumpToBrand('#/settings'),
        },
        {
          label: 'Link tracking',
          neutral: true,
          state: b.utm_enabled ? 'on' : 'off',
          jump: () => jumpToBrand('#/settings'),
        },
        {
          label: 'Brand profile current',
          done: brandProfiles.length > 0 && !brandProfiles.some((p) => p.status === 'stale'),
          jump: () => { location.hash = '#/profiles'; },
        },
        {
          label: 'Voice/tone set',
          done: hasToneRules || globalVoiceSet,
          jump: () => jumpToBrand('#/settings'),
        },
      ];
      const incomplete = checks.filter((c) => !c.neutral && !c.done);
      return { brand: b, checks, complete: incomplete.length === 0 };
    })
  );

  body.innerHTML = '';
  for (const { brand, checks, complete } of perBrand) {
    const rowCard = el('div', { class: 'card setup-brand-card' });
    rowCard.appendChild(el('h2', {}, complete ? `${brand.name} ✓` : brand.name));
    const list = el('div', { class: 'setup-check-list' });
    for (const c of checks) {
      const mark = c.neutral ? c.state : (c.done ? '✓' : '—');
      list.appendChild(
        el(
          'button',
          {
            type: 'button',
            class: 'setup-check-item' + (!c.neutral && !c.done ? ' setup-check-incomplete' : ''),
            onclick: c.jump,
          },
          [
            el('span', { class: 'setup-check-mark' }, mark),
            el('span', { class: 'setup-check-label' }, c.label),
          ]
        )
      );
    }
    rowCard.appendChild(list);
    makeCollapsible(rowCard, { open: !complete, key: `setup_${brand.id}` });
    body.appendChild(rowCard);
  }
}

async function renderHome(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  let homeBrand = getStickyBrand();
  const brandSelect = el('select', {}, [
    el('option', { value: '', selected: homeBrand ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: String(b.id), selected: String(b.id) === String(homeBrand) ? 'selected' : undefined }, b.name)
    ),
  ]);
  // R1: title -> primary context control (brand).
  view.appendChild(pageHeader('Home', brandSelect));

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
  const setupHost = el('div');
  const weekHost = el('div');
  const platformHost = el('div');
  const analyticsHost = el('div');
  const calendarCard = el('div', { class: 'home-section' });
  calendarCard.appendChild(el('h2', { style: 'margin:8px 0 12px;' }, 'Calendar'));
  const calendarHost = el('div');
  calendarCard.appendChild(calendarHost);
  view.append(attentionHost, setupHost, weekHost, platformHost, analyticsHost, calendarCard);

  async function refresh() {
    const [posts, analyticsData, profiles] = await Promise.all([
      api('/api/posts'),
      api('/api/analytics').catch(() => null),
      api('/api/profiles').catch(() => []), // B13: best-effort - endpoint may not exist yet, or may require brand_id
    ]);
    const filteredPosts = homeBrand ? posts.filter((p) => String(p.brand_id) === String(homeBrand)) : posts;
    const filteredProfiles = homeBrand ? (profiles || []).filter((p) => String(p.brand_id) === String(homeBrand)) : (profiles || []);
    buildAttentionSection(attentionHost, filteredPosts, analyticsData, homeBrand, filteredProfiles);
    buildWeekSection(weekHost, filteredPosts, !homeBrand);
    buildPlatformChipsSection(platformHost, filteredPosts, homeBrand);
    buildMiniAnalyticsSection(analyticsHost, analyticsData, homeBrand);
    await renderCalendarInto(calendarHost, { initialBrand: homeBrand, defaultMode: 'week' });
    buildSetupCard(setupHost); // F6: independent of the homeBrand filter (always all brands), fire-and-forget so it doesn't block first paint
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

// F3: drag mime type for an idea-card drop onto a calendar day cell - kept
// distinct from the plain 'text/plain' postId the existing chip-reschedule
// drag uses, so the two drag kinds never get confused in the drop handler.
const IDEA_DRAG_MIME = 'application/x-postdeck-idea';

// F3: idea -> Quick Compose prefill, shared by the calendar drag-drop and the
// idea card's "Use in post" button. `dateKey` (YYYY-MM-DD) is only present on
// a calendar drop - the button omits it and just seeds the copy/brand as
// usual (no date context to prefill). idea.id rides along so the Quick
// Compose save path can flip the idea to 'done' once the post is created.
function composeFromIdea(idea, dateKey) {
  const sticky = getStickyBrand();
  const brandId = idea.brand_id != null
    ? idea.brand_id
    : (sticky && state.brands.some((b) => String(b.id) === String(sticky)) ? sticky : null);
  openQuickCompose({
    brandId,
    copy: idea.title || '',
    publishAt: dateKey ? `${dateKey}T09:00` : undefined,
    ideaId: idea.id,
  });
}

// Jump to the composer with "Publish at" prefilled to the clicked day (09:00
// local), carrying the calendar's current brand filter. Still used by the
// day popover's "+ New post" button... no - Quick Compose is preferred there
// (see openDayPopover); kept for any other future full-page entry points.
function composeOnDate(dateKey) {
  sessionStorage.setItem('pd_composer_prefill_date', `${dateKey}T09:00`);
  const brandSel = document.getElementById('cal-brand');
  if (brandSel && brandSel.value) sessionStorage.setItem('pd_composer_prefill_brand', brandSel.value);
  location.hash = '#/composer';
}

// ---- Build B: day-click popover (replaces the old jump-straight-to-composer
// behavior). Small anchored popover: date title, that day's posts (click ->
// existing post popover), "+ New post on <date>" -> Quick Compose prefilled
// with 09:00 local (or the next open queue slot when that's trivially known
// from what's already loaded - see nextSlotHintFor). Esc/click-outside closes.
let currentDayPopover = null;
function closeDayPopover() {
  if (!currentDayPopover) return;
  const { overlay, onKey, onOutside } = currentDayPopover;
  overlay.remove();
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('mousedown', onOutside, true);
  currentDayPopover = null;
}

function openDayPopover(dateKey, anchorEl, dayPosts) {
  closeDayPopover();
  closePostPopover();
  const pop = el('div', { class: 'day-popover', role: 'dialog' });
  const dateObj = new Date(`${dateKey}T00:00:00`);
  const label = dateObj.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });

  pop.appendChild(
    el('div', { class: 'day-popover-header' }, [
      el('span', {}, label),
      el('button', { class: 'button ghost sm modal-close', type: 'button', title: 'Close', onclick: closeDayPopover }, '✕'),
    ])
  );

  const list = el('div', { class: 'day-popover-list' });
  if (!dayPosts.length) {
    list.appendChild(el('div', { class: 'day-popover-empty' }, 'Nothing scheduled.'));
  } else {
    for (const p of dayPosts) {
      const time = p.publish_at
        ? new Date(p.publish_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : '—';
      const row = el('button', { type: 'button', class: 'day-popover-row' }, [
        platformIcon(p.platform, { size: 13 }),
        el('span', { class: 'dp-time' }, time),
        el('span', {}, (p.copy || '(no copy)').slice(0, 40)),
      ]);
      row.addEventListener('click', () => { closeDayPopover(); openPostPopover(p.id, anchorEl); });
      list.appendChild(row);
    }
  }
  pop.appendChild(list);

  pop.appendChild(
    el('button', {
      class: 'button primary sm',
      type: 'button',
      style: 'width:100%;',
      onclick: () => {
        closeDayPopover();
        const brandSel = document.getElementById('cal-brand');
        openQuickCompose({
          brandId: brandSel && brandSel.value ? brandSel.value : undefined,
          publishAt: `${dateKey}T09:00`,
        });
      },
    }, `+ New post on ${dateObj.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`)
  );

  document.body.appendChild(pop);
  positionPostPopover(pop, anchorEl);

  function onKey(e) { if (e.key === 'Escape') closeDayPopover(); }
  function onOutside(e) { if (!pop.contains(e.target) && e.target !== anchorEl && !anchorEl.contains?.(e.target)) closeDayPopover(); }
  document.addEventListener('keydown', onKey);
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  currentDayPopover = { overlay: pop, onKey, onOutside };
}

// Local YYYY-MM-DD key (avoid toISOString's UTC shift moving posts a day).
function dateKeyLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------------- Calendar gap-finding (B17b) ----------------
// Pure, DOM-free helpers so the counting/coverage logic is easy to reason
// about on its own - see docs/B16_B18_COMPETITIVE_WAVE_SPEC.md "B17b". Kept
// as plain functions inside app.js rather than a separate test module: this
// file is a non-ESM browser script that runs `bootstrap()` (DOM/fetch calls)
// at load time, so it isn't import-safe under the node:test harness the way
// src/*.js modules are.

// posts -> { [YYYY-MM-DD]: { [platform]: count } }. Uses the same
// `publish_at.slice(0, 10)` key convention as the `byDay` grouping below so
// the dot counts always match what's actually rendered in the cell.
function computeDayPlatformCounts(posts) {
  const byDay = {};
  for (const p of posts) {
    if (!p.publish_at) continue;
    const key = p.publish_at.slice(0, 10);
    const day = (byDay[key] = byDay[key] || {});
    day[p.platform] = (day[p.platform] || 0) + 1;
  }
  return byDay;
}

// posts + brands, scoped to the inclusive [startKey, endKey] date-key range ->
// one row per brand: { brand_id, name, count, zero }. Used for the coverage
// strip above the grid - "PrimeWright · 5 this week" / zero-coverage warning.
function computeBrandCoverage(posts, brands, startKey, endKey) {
  return brands.map((b) => {
    const count = posts.filter((p) => {
      if (String(p.brand_id) !== String(b.id) || !p.publish_at) return false;
      const key = p.publish_at.slice(0, 10);
      return key >= startKey && key <= endKey;
    }).length;
    return { brand_id: b.id, name: b.name, count, zero: count === 0 };
  });
}

// Renders the coverage strip into `hostEl` for the given (already
// brand/platform-filtered) posts, one pill per brand in `brands`. Clicking a
// zero-coverage pill sticky-sets that brand and hands off to the composer.
function renderCoverageStrip(hostEl, posts, brands, mode, refDate) {
  hostEl.innerHTML = '';
  if (!brands.length) return;
  let startKey, endKey, label;
  if (mode === 'month') {
    const y = refDate.getFullYear();
    const m = refDate.getMonth();
    startKey = dateKeyLocal(new Date(y, m, 1));
    endKey = dateKeyLocal(new Date(y, m + 1, 0));
    label = 'this month';
  } else {
    startKey = dateKeyLocal(refDate);
    endKey = dateKeyLocal(new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate() + 6));
    label = 'this week';
  }
  const coverage = computeBrandCoverage(posts, brands, startKey, endKey);
  for (const c of coverage) {
    const pill = el(
      'span',
      {
        class: 'cal-coverage-pill' + (c.zero ? ' cal-coverage-zero' : ''),
        style: `border-left-color:${brandColor(c.brand_id)}`,
      },
      `${c.name} · ${c.count} ${label}${c.zero ? ' ⚠' : ''}`
    );
    if (c.zero) {
      pill.title = 'Nothing scheduled - click to compose one for this brand';
      pill.setAttribute('role', 'button');
      pill.setAttribute('tabindex', '0');
      const goCompose = () => {
        setStickyBrand(String(c.brand_id));
        location.hash = '#/composer';
      };
      pill.addEventListener('click', goCompose);
      pill.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goCompose(); }
      });
    }
    hostEl.appendChild(pill);
  }
}

function drawGrid(grid, posts, mode, refDate, { allBrands = true } = {}) {
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
  const dayPlatformCounts = computeDayPlatformCounts(posts);

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
      // F3: an idea-card drop carries its own mime type so it never collides
      // with the existing chip-reschedule drag (which only ever sets
      // text/plain) - check it first.
      const ideaRaw = e.dataTransfer.getData(IDEA_DRAG_MIME);
      if (ideaRaw) {
        let idea = null;
        try { idea = JSON.parse(ideaRaw); } catch { idea = null; }
        if (idea) composeFromIdea(idea, dateKey);
        return;
      }
      const postId = e.dataTransfer.getData('text/plain');
      if (postId && grid.reschedulePost) grid.reschedulePost(postId, dateKey, posts);
    });
  }

  function dayCellFor(d, { muted = false } = {}) {
    const key = dateKeyLocal(d);
    const dayPosts = byDay[key] || [];
    const counts = dayPlatformCounts[key] || {};
    // Empty-day treatment only for real (non-adjacent-month) days at or after
    // today - past-empty and out-of-month cells are normal/already muted.
    const isEmpty = !muted && key >= todayKey && dayPosts.length === 0;
    const countDots = mode === 'month' && Object.keys(counts).length
      ? el('div', { class: 'cal-day-counts' }, Object.entries(counts).map(([plat, n]) =>
          el('span', {
            class: 'cal-count-dot',
            style: `background:${platformDotColor(plat)}`,
            title: `${plat}: ${n}`,
          }, n > 1 ? String(n) : '')
        ))
      : '';
    const cell = el(
      'div',
      { class: 'cal-day' + (muted ? ' cal-muted' : '') + (key === todayKey ? ' cal-today' : '') + (isEmpty ? ' cal-day-empty' : '') },
      [
        el('div', { class: 'day-label' }, [
          mode === 'month'
            ? String(d.getDate())
            : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }),
          mode === 'week' ? el('span', { class: 'cal-week-daycount' }, ` · ${dayPosts.length}`) : '',
        ]),
        countDots,
        ...dayPosts.map((p) => postChip(p, { allBrands })),
      ]
    );
    makeDropTarget(cell, key);
    // Click an empty part of a day to schedule a new post on that date. Clicks
    // on a chip fall through to the chip's own link (open post detail).
    cell.classList.add('cal-clickable');
    cell.title = 'Click to schedule a post on this day';
    cell.addEventListener('click', (e) => {
      if (e.target.closest('.chip')) return;
      openDayPopover(key, cell, dayPosts);
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
        ...byDay.unscheduled.map((p) => postChip(p, { allBrands })),
      ])
    );
  }
}

// ---------------- F8: Upcoming agenda view ----------------
// Pure grouping helper (DOM-free, same style as computeDayPlatformCounts /
// computeBrandCoverage above): posts -> { unscheduled, days, todayKey }.
// `days` covers [today, today+13] (14 days), only dates that actually have
// a post (gap-days are the month view's job, not this one - per spec).
function computeAgendaGroups(posts, now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const todayKey = dateKeyLocal(today);
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 13);
  const endKey = dateKeyLocal(endDate);

  const unscheduled = posts
    .filter((p) => !p.publish_at && p.status === 'draft')
    .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

  const byDay = {};
  for (const p of posts) {
    if (!p.publish_at) continue;
    const key = p.publish_at.slice(0, 10);
    if (key < todayKey || key > endKey) continue;
    (byDay[key] = byDay[key] || []).push(p);
  }
  const days = Object.keys(byDay)
    .sort()
    .map((key) => ({
      key,
      posts: byDay[key].slice().sort((a, b) => new Date(a.publish_at) - new Date(b.publish_at)),
    }));

  return { unscheduled, days, todayKey };
}

function agendaDayLabel(key, todayKey) {
  if (key === todayKey) return 'Today';
  const [y, m, d] = key.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const tomorrow = new Date();
  tomorrow.setHours(0, 0, 0, 0);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (key === dateKeyLocal(tomorrow)) return 'Tomorrow';
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

function agendaRow(p, { allBrands = true } = {}) {
  const time = p.publish_at
    ? new Date(p.publish_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : '--:--';
  const row = el(
    'button',
    { type: 'button', class: 'agenda-row' + (allBrands ? ' agenda-row-allbrands' : ''), style: allBrands ? `border-left:3px solid ${brandColor(p.brand_id)}` : '', title: `${brandName(p.brand_id)} - ${p.platform} - ${p.status}` },
    [
      allBrands ? brandIdentityDisc(p.brand_id) : null,
      platformIcon(p.platform, { size: 14 }),
      el('span', { class: 'agenda-row-time' }, time),
      el('span', { class: 'pill', style: `border-left-color:${brandColor(p.brand_id)}` }, brandName(p.brand_id)),
      el('span', { class: 'agenda-row-copy' }, (p.copy || '(no copy)').split('\n')[0]),
      manualWarnGlyph(p),
      el('span', { class: `pill status-${p.status}` }, p.status),
    ]
  );
  row.addEventListener('click', () => openPostPopover(p.id, row, { onChange: () => { if (typeof currentCalendarReload === 'function') currentCalendarReload(); } }));
  return row;
}

// Renders the agenda list (respects the calendar's existing brand/platform/tag
// filters - `posts` is already filtered by the caller). Unscheduled drafts
// group is collapsed by default; day groups are always expanded.
function drawAgenda(host, posts, { allBrands = true } = {}) {
  host.innerHTML = '';
  const { unscheduled, days, todayKey } = computeAgendaGroups(posts);

  if (unscheduled.length) {
    const caret = el('span', {}, '▸');
    const unschedTitle = el(
      'div',
      { class: 'agenda-group-title agenda-unscheduled', role: 'button', tabindex: '0' },
      [caret, ` Unscheduled drafts (${unscheduled.length})`]
    );
    const unschedBody = el(
      'div',
      { class: 'agenda-group-body' },
      unscheduled.map((p) => agendaRow(p, { allBrands }))
    );
    unschedBody.hidden = true; // collapsed by default per spec
    function toggle() {
      unschedBody.hidden = !unschedBody.hidden;
      caret.textContent = unschedBody.hidden ? '▸' : '▾';
    }
    unschedTitle.addEventListener('click', toggle);
    unschedTitle.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    host.appendChild(el('div', {}, [unschedTitle, unschedBody]));
  }

  if (!days.length) {
    host.appendChild(el('div', { class: 'agenda-empty' }, 'Nothing scheduled in the next 14 days.'));
    return;
  }

  for (const day of days) {
    host.appendChild(
      el('div', {}, [
        el('div', { class: 'agenda-group-title' }, agendaDayLabel(day.key, todayKey)),
        el('div', { class: 'agenda-group-body' }, day.posts.map((p) => agendaRow(p, { allBrands }))),
      ])
    );
  }
}

function postChip(p, { allBrands = true } = {}) {
  const draggable = RESCHEDULABLE_STATUSES.includes(p.status);
  // B17a: a post carrying a campaign tag gets its chip's left border colored
  // by that campaign (falls back to the brand color otherwise), and tag
  // names join the hover tooltip.
  const tags = p.tags || [];
  const campaignTag = tags.find((t) => t.kind === 'campaign');
  const borderColor = campaignTag ? (campaignTag.color || brandColor(p.brand_id)) : brandColor(p.brand_id);
  const tagNames = tags.map((t) => t.name).join(', ');
  const chip = el(
    'a',
    {
      href: `#/post/${p.id}`,
      class: 'chip' + (campaignTag ? ' chip-campaign' : ''),
      style: `border-left-color:${borderColor}`,
      title: `${brandName(p.brand_id)} - ${p.platform} - ${p.status}${draggable ? ' (drag to reschedule)' : ''}${tagNames ? ` - tags: ${tagNames}` : ''}`,
      draggable: draggable ? 'true' : 'false',
    },
    (p.copy || '(no copy)').slice(0, 24)
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
  const warnGlyph = manualWarnGlyph(p);
  if (warnGlyph) chip.appendChild(warnGlyph);
  if (allBrands) chip.prepend(brandIdentityDisc(p.brand_id));
  chip.prepend(platformIcon(p.platform, { size: 12 }));
  // F7a: quick-action popover instead of a full-page navigation (keep href
  // for middle-click / accessibility, but a plain click opens the pop-out).
  // "See more" inside the popover reaches the full quick-view modal.
  chip.addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // let new-tab through
    e.preventDefault();
    openPostPopover(p.id, chip);
  });
  return chip;
}

// ---- F4: Duplicate / Copy to brand (shared by the popover and the modal) ----
// Renders an inline row of brand chip buttons (every brand except the post's
// current one) into `hostEl`; clicking one calls `onPick(brandId)`. Same
// "expand a row under the button" pattern the popover's Reschedule uses.
function renderBrandPickerRow(hostEl, currentBrandId, onPick) {
  hostEl.innerHTML = '';
  const targets = state.brands.filter((b) => String(b.id) !== String(currentBrandId));
  if (!targets.length) {
    hostEl.appendChild(el('span', { style: 'color:var(--muted);font-size:12px;' }, 'No other brands set up.'));
    return;
  }
  for (const b of targets) {
    hostEl.appendChild(
      el('button', { type: 'button', class: 'chip-btn', onclick: () => onPick(b.id) }, b.name)
    );
  }
}

// Duplicates `post` (same brand when brandId is omitted, otherwise a copy-
// to-brand). POST /api/posts/:id/duplicate already strips publish_at/status
// history and drops any campaign tag on a cross-brand copy (server-side, F4
// spec); this just handles the "what happens after": for a cross-brand copy,
// best-effort re-voice the copy through the target brand's 'business' tone
// via the existing /api/draft path (grounded on the original copy) - falls
// back silently to the verbatim copy the backend already carried over if no
// tone profile exists or AI drafting is unavailable. Then hands the new
// draft to the post modal so CB can adjust/save it in place - NOT to Quick
// Compose, which always creates a fresh post on save and would silently
// produce a third row on top of the original + the duplicate.
async function duplicatePostFlow(post, { brandId } = {}) {
  const crossBrand = brandId != null && String(brandId) !== String(post.brand_id);
  let created;
  try {
    created = await api(`/api/posts/${post.id}/duplicate`, {
      method: 'POST',
      body: crossBrand ? { brand_id: brandId } : {},
    });
  } catch (err) {
    toast(`Could not duplicate: ${err.message}`, 'error');
    return;
  }

  let revoiced = false;
  if (crossBrand) {
    try {
      const tp = await findToneProfileId(brandId, 'business');
      if (tp) {
        const draftRes = await api('/api/draft', {
          method: 'POST',
          body: {
            idea_text: post.copy || '',
            brand_id: Number(brandId),
            tone_profile_id: tp,
            platforms: [post.platform],
            provider: sessionDraftProvider || 'claude',
          },
        });
        const redraft = draftRes.drafts?.[post.platform];
        if (redraft) {
          await api(`/api/posts/${created.id}`, { method: 'PATCH', body: { copy: redraft } });
          created.copy = redraft;
          revoiced = true;
        }
      }
    } catch {
      // AI unavailable, no tone profile, or the draft call failed - the
      // duplicate already carries the verbatim original copy, so this is a
      // silent no-op rather than an error the operator needs to see.
    }
  }

  let msg = crossBrand ? `Copied to ${brandName(brandId)}.` : 'Post duplicated.';
  if (revoiced) msg = `Copied to ${brandName(brandId)} - re-voiced with AI.`;
  if (created.account_unresolved) msg += ' No matching account for that brand yet - pick one before approving.';
  toast(msg, created.account_unresolved ? 'error' : 'ok');
  if (typeof currentCalendarReload === 'function') currentCalendarReload();
  openPostModal(created.id);
}

// ---- F7: compact anchored popover opened from a calendar chip or agenda row ----
// Quick actions (reschedule / move to drafts / delete-or-cancel) without the
// full modal; "See more" hands off to openPostModal for the full view/edit.
// One popover open at a time; Esc/click-outside closes it.
let currentPostPopover = null;

function closePostPopover() {
  if (!currentPostPopover) return;
  const { overlay, onKey, onOutside } = currentPostPopover;
  overlay.remove();
  document.removeEventListener('keydown', onKey);
  document.removeEventListener('mousedown', onOutside, true);
  currentPostPopover = null;
}

// Anchors the popover near `anchorEl`, flipping above/left when it would
// overflow the viewport. Called once on open and again after the reschedule
// row expands (its height changes the ideal position).
function positionPostPopover(pop, anchorEl) {
  const rect = anchorEl.getBoundingClientRect();
  const margin = 8;
  const pw = pop.offsetWidth;
  const ph = pop.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + margin;
  if (top + ph > window.innerHeight - margin) {
    top = rect.top - ph - margin;
    if (top < margin) top = margin;
  }
  if (left + pw > window.innerWidth - margin) left = window.innerWidth - pw - margin;
  if (left < margin) left = margin;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function openPostPopover(postId, anchorEl, { onChange } = {}) {
  closePostPopover();

  const pop = el('div', { class: 'chip-popover', role: 'dialog' });
  pop.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'Loading…'));
  document.body.appendChild(pop);
  positionPostPopover(pop, anchorEl);

  function onKey(e) { if (e.key === 'Escape') closePostPopover(); }
  function onOutside(e) { if (!pop.contains(e.target) && e.target !== anchorEl && !anchorEl.contains?.(e.target)) closePostPopover(); }
  document.addEventListener('keydown', onKey);
  // Defer registration so the same click that opened the popover (which is
  // still bubbling) doesn't immediately close it via onOutside.
  setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  currentPostPopover = { overlay: pop, onKey, onOutside };

  function refresh() {
    if (typeof onChange === 'function') onChange();
    else if (typeof currentCalendarReload === 'function') currentCalendarReload();
  }

  api(`/api/posts/${postId}`)
    .then((post) => {
      pop.innerHTML = '';
      const brand = state.brands.find((b) => b.id === post.brand_id);
      const copyLines = (post.copy || '(no copy)').split('\n').slice(0, 3).join('\n');

      pop.appendChild(
        el('div', { class: 'chip-popover-header' }, [
          platformIcon(post.platform, { size: 15 }),
          el('span', { class: 'chip-popover-platform' }, ` ${post.platform}`),
          el('button', { class: 'button ghost sm modal-close', type: 'button', title: 'Close', onclick: closePostPopover }, '✕'),
        ])
      );
      pop.appendChild(
        el('div', { class: 'chip-popover-meta' }, [
          el('span', { class: 'pill', style: `border-left-color:${brandColor(post.brand_id)}` }, brand ? brand.name : brandName(post.brand_id)),
          el('span', { class: `pill status-${post.status}` }, post.status),
        ])
      );
      pop.appendChild(el('div', { class: 'chip-popover-date' }, fmtDate(post.publish_at)));
      pop.appendChild(el('div', { class: 'chip-popover-copy' }, copyLines));

      // item 4: manual-account / missed-window banners
      if (isMissedWindowPost(post)) {
        pop.appendChild(missedWindowBanner(post, { onResolved: () => { closePostPopover(); refresh(); } }));
      } else if (['scheduled_local', 'approved'].includes(post.status) && isManualPost(post)) {
        pop.appendChild(manualAccountBanner());
      }
      const fcReminder = firstCommentReminder(post);
      if (fcReminder) pop.appendChild(fcReminder);

      const actions = el('div', { class: 'chip-popover-actions' });

      // item 1: Send to Blotato now
      if (canSendToBlotatoNow(post)) {
        actions.appendChild(sendNowControl(post, { onDone: () => { closePostPopover(); refresh(); } }));
      }

      // Reschedule - hidden for submitted/published (mirrors RESCHEDULABLE_STATUSES).
      if (RESCHEDULABLE_STATUSES.includes(post.status)) {
        const rescheduleRow = el('div', { class: 'chip-popover-reschedule', hidden: true });
        const dtInput = el('input', { type: 'datetime-local', value: isoToLocalInput(post.publish_at) });
        const saveBtn = el('button', { class: 'button primary sm', type: 'button' }, 'Save');
        rescheduleRow.append(dtInput, saveBtn);
        const rescheduleBtn = el('button', {
          class: 'button ghost sm',
          type: 'button',
          onclick: () => { rescheduleRow.hidden = !rescheduleRow.hidden; positionPostPopover(pop, anchorEl); },
        }, 'Reschedule');
        saveBtn.onclick = async () => {
          try {
            const publish_at = dtInput.value ? new Date(dtInput.value).toISOString() : null;
            await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { publish_at } });
            toast('Post rescheduled.');
            closePostPopover();
            refresh();
          } catch (err) {
            toast(`Could not reschedule: ${err.message}`, 'error');
          }
        };
        actions.append(rescheduleBtn, rescheduleRow);
      }

      // Move to drafts - only for approved/scheduled_local.
      if (['approved', 'scheduled_local'].includes(post.status)) {
        actions.appendChild(
          el('button', {
            class: 'button ghost sm',
            type: 'button',
            onclick: async () => {
              try {
                await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'draft', publish_at: null } });
                toast('Moved to drafts.');
                closePostPopover();
                refresh();
              } catch (err) {
                toast(`Could not move to drafts: ${err.message}`, 'error');
              }
            },
          }, 'Move to drafts')
        );
      }

      // Delete (draft/canceled, hard delete) or Cancel post (scheduled/approved).
      if (['draft', 'canceled'].includes(post.status)) {
        actions.appendChild(
          el('button', {
            class: 'button destructive sm',
            type: 'button',
            onclick: async () => {
              if (!confirm('Permanently delete this post? This cannot be undone.')) return;
              try {
                await api(`/api/posts/${post.id}`, { method: 'DELETE' });
                toast('Post deleted.');
                closePostPopover();
                refresh();
              } catch (err) {
                toast(`Could not delete: ${err.message}`, 'error');
              }
            },
          }, 'Delete')
        );
      } else if (['approved', 'scheduled_local'].includes(post.status)) {
        actions.appendChild(
          el('button', {
            class: 'button destructive sm',
            type: 'button',
            onclick: async () => {
              if (!confirm('Cancel this post?')) return;
              try {
                await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'canceled' } });
                toast('Post canceled.');
                closePostPopover();
                refresh();
              } catch (err) {
                toast(`Could not cancel: ${err.message}`, 'error');
              }
            },
          }, 'Cancel post')
        );
      }

      // F4: Duplicate (same brand) + Copy to brand -> (expandable brand chip
      // row, mirrors the Reschedule row's expand pattern above).
      actions.appendChild(
        el('button', {
          class: 'button ghost sm',
          type: 'button',
          onclick: () => { closePostPopover(); duplicatePostFlow(post); },
        }, 'Duplicate')
      );
      const copyToBrandRow = el('div', { class: 'chip-row', hidden: true, style: 'margin-top:6px;' });
      actions.appendChild(
        el('button', {
          class: 'button ghost sm',
          type: 'button',
          onclick: () => {
            copyToBrandRow.hidden = !copyToBrandRow.hidden;
            if (!copyToBrandRow.hidden) {
              renderBrandPickerRow(copyToBrandRow, post.brand_id, (targetBrandId) => {
                closePostPopover();
                duplicatePostFlow(post, { brandId: targetBrandId });
              });
            }
            positionPostPopover(pop, anchorEl);
          },
        }, 'Copy to brand →')
      );
      actions.appendChild(copyToBrandRow);

      actions.appendChild(
        el('button', {
          class: 'button ghost sm',
          type: 'button',
          onclick: () => { closePostPopover(); openPostModal(post.id); },
        }, 'See more')
      );

      pop.appendChild(actions);
      positionPostPopover(pop, anchorEl);
    })
    .catch((err) => {
      pop.innerHTML = '';
      pop.appendChild(inlineBanner(`Could not load post: ${err.message}`, 'error'));
    });
}

// ---- item 2: bulk send confirm modal (Calendar toolbar "Send to Blotato") ----
const SKIP_REASON_LABELS = {
  manual: 'manual account',
  missed_window: 'missed window',
  no_publish_at: 'no publish time set',
  wrong_status: 'not scheduled/approved',
};
function openBulkSendConfirm(preview, scope, onSent) {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card' });
  overlay.appendChild(card);
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  const eligible = preview.eligible || [];
  const skipped = preview.skipped || [];
  const skipCounts = {};
  for (const s of skipped) skipCounts[s.reason] = (skipCounts[s.reason] || 0) + 1;

  card.appendChild(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Send to Blotato'),
      el('button', { class: 'modal-close', title: 'Close', type: 'button', onclick: close }, '✕'),
    ])
  );
  if (preview.dry_run) card.appendChild(el('span', { class: 'dry-run-banner' }, 'DRY RUN - no real Blotato calls will be made'));
  card.appendChild(el('div', { style: 'margin-top:10px;' }, `${eligible.length} post(s) eligible in the current view.`));
  if (skipped.length) {
    const lines = Object.entries(skipCounts).map(([reason, n]) => `${n} ${SKIP_REASON_LABELS[reason] || reason}`);
    card.appendChild(inlineBanner(`Skipping ${skipped.length}: ${lines.join(', ')}.`, 'info'));
  }
  if (!eligible.length) {
    card.appendChild(el('div', { class: 'toolbar', style: 'margin-top:12px;' }, [el('button', { class: 'button secondary md', type: 'button', onclick: close }, 'Close')]));
    document.body.appendChild(overlay);
    return;
  }

  const resultHost = el('div', { style: 'margin-top:10px;' });
  const sendBtn = el('button', { class: 'button primary md', type: 'button' }, `Send ${eligible.length} posts`);
  const cancelBtn = el('button', { class: 'button ghost md', type: 'button', onclick: close }, 'Cancel');
  sendBtn.addEventListener('click', async () => {
    sendBtn.disabled = true;
    cancelBtn.disabled = true;
    resultHost.innerHTML = '';
    try {
      const res = await api('/api/posts/submit-batch', { method: 'POST', body: { scope } });
      const dryLabel = res.dry_run ? ' (dry run)' : '';
      resultHost.appendChild(
        el('div', { class: 'msg-banner msg-ok' }, `Sent ${res.submitted.length} of ${res.attempted}${dryLabel}.`)
      );
      if (res.failed && res.failed.length) {
        for (const f of res.failed) resultHost.appendChild(inlineBanner(`Post #${f.id}: ${f.error}`, 'error'));
      }
      toast(`Sent ${res.submitted.length} post(s) to Blotato${dryLabel}.`, 'ok');
      if (typeof onSent === 'function') onSent();
      sendBtn.replaceWith(el('button', { class: 'button primary md', type: 'button', onclick: close }, 'Done'));
    } catch (err) {
      resultHost.appendChild(inlineBanner(`Could not send: ${err.message}`, 'error'));
      sendBtn.disabled = false;
      cancelBtn.disabled = false;
    }
  });
  card.appendChild(el('div', { class: 'toolbar', style: 'margin-top:12px;' }, [sendBtn, cancelBtn]));
  card.appendChild(resultHost);
  document.body.appendChild(overlay);
}

// ---- Quick-view / edit modal (opened from a calendar chip) ----
// isoToLocalInput: an ISO string -> a value a datetime-local input accepts,
// in the viewer's local time.
function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openPostModal(postId) {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card' });
  overlay.appendChild(card);
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  card.appendChild(el('div', { style: 'color:var(--muted);padding:8px;' }, 'Loading…'));

  api(`/api/posts/${postId}`)
    .then((post) => {
      card.innerHTML = '';
      const editable = RESCHEDULABLE_STATUSES.includes(post.status);

      card.appendChild(
        el('div', { class: 'modal-header' }, [
          el('div', {}, [
            platformIcon(post.platform, { size: 15 }),
            el('strong', {}, ` ${post.platform}`),
            ' ',
            el('span', { class: `pill status-${post.status}` }, post.status),
          ]),
          el('button', { class: 'modal-close', title: 'Close', onclick: close }, '✕'),
        ])
      );
      card.appendChild(el('div', { class: 'modal-sub' }, `${brandName(post.brand_id)}`));

      // B17a: tags/campaign as read-only chips (post detail view, not editable here)
      if (post.tags && post.tags.length) {
        card.appendChild(
          el('div', { class: 'chip-row', style: 'margin-top:6px;' }, post.tags.map((t) => tagDisplayChip(t)))
        );
      }

      // Publish at
      let publishInput = null;
      if (editable) {
        publishInput = el('input', { type: 'datetime-local', value: isoToLocalInput(post.publish_at) });
        card.appendChild(el('div', { class: 'field-row', style: 'margin-top:10px;' }, [el('label', {}, 'Publish at'), publishInput]));
      } else {
        card.appendChild(el('div', { style: 'margin-top:10px;font-size:12px;color:var(--muted);' }, `Publish at: ${fmtDate(post.publish_at)}`));
      }

      // F1: feed preview replaces the plain copy display - raw text stays
      // reachable via the editable textarea when the post is still local.
      const brand = state.brands.find((b) => b.id === post.brand_id);
      const mediaUrl = post.media && post.media.length ? (post.media[0].url || null) : null;
      const previewHost = el('div', { style: 'margin-top:8px;' });
      previewHost.appendChild(renderPostPreview(post.platform, { copy: post.copy || '', mediaUrl, brand }));
      card.appendChild(previewHost);

      // Copy (editable while local; read-only once submitted/published)
      let copyArea = null;
      if (editable) {
        copyArea = el('textarea', { rows: '8', style: 'width:100%;' });
        copyArea.value = post.copy || '';
        copyArea.addEventListener('input', () => {
          previewHost.innerHTML = '';
          previewHost.appendChild(renderPostPreview(post.platform, { copy: copyArea.value, mediaUrl, brand }));
        });
        card.appendChild(el('div', { class: 'field-row', style: 'margin-top:8px;' }, [el('label', {}, 'Copy (raw text)'), copyArea]));
      }

      if (post.public_url) {
        card.appendChild(el('div', { style: 'margin-top:8px;' }, [el('a', { href: post.public_url, target: '_blank' }, 'View published post →')]));
      }
      if (post.error_message && !isMissedWindowPost(post)) {
        card.appendChild(inlineBanner(post.error_message, 'error'));
      }

      // item 4: manual-account / missed-window banners
      if (isMissedWindowPost(post)) {
        card.appendChild(missedWindowBanner(post, { onResolved: () => { close(); if (typeof currentCalendarReload === 'function') currentCalendarReload(); } }));
      } else if (['scheduled_local', 'approved'].includes(post.status) && isManualPost(post)) {
        card.appendChild(manualAccountBanner());
      }
      const fcReminderModal = firstCommentReminder(post);
      if (fcReminderModal) card.appendChild(fcReminderModal);

      const actions = el('div', { class: 'toolbar', style: 'margin-top:12px;' });

      // item 1: Send to Blotato now
      if (canSendToBlotatoNow(post)) {
        actions.appendChild(sendNowControl(post, { onDone: () => { close(); if (typeof currentCalendarReload === 'function') currentCalendarReload(); }, size: 'md' }));
      }

      actions.appendChild(
        el('button', {
          class: 'button secondary md',
          type: 'button',
          onclick: async () => {
            await navigator.clipboard.writeText((copyArea ? copyArea.value : post.copy) || '');
            toast('Copied to clipboard.');
          },
        }, 'Copy text')
      );

      let saveBtn = null;
      if (editable) {
        saveBtn = el('button', {
          class: 'button primary md',
          type: 'button',
          onclick: async () => {
            const body = { copy: copyArea.value };
            if (publishInput) body.publish_at = publishInput.value ? new Date(publishInput.value).toISOString() : null;
            saveBtn.disabled = true;
            saveBtn.classList.add('is-pending');
            saveBtn.textContent = 'Saving…';
            try {
              await api(`/api/posts/${post.id}`, { method: 'PATCH', body });
              toast('Post saved.');
              close();
              if (typeof currentCalendarReload === 'function') currentCalendarReload();
            } catch (err) {
              toast(`Could not save: ${err.message}`, 'error');
              saveBtn.disabled = false;
              saveBtn.classList.remove('is-pending');
              saveBtn.textContent = 'Save changes';
            }
          },
        }, 'Save changes');
        actions.appendChild(saveBtn);
      }

      // F4: Duplicate (same brand) + Copy to brand -> (chip row toggled
      // below the action bar, same expand pattern as the popover's).
      actions.appendChild(
        el('button', {
          class: 'button ghost md',
          type: 'button',
          onclick: () => { close(); duplicatePostFlow(post); },
        }, 'Duplicate')
      );
      const copyToBrandRow = el('div', { class: 'chip-row', hidden: true, style: 'margin-top:8px;' });
      actions.appendChild(
        el('button', {
          class: 'button ghost md',
          type: 'button',
          onclick: () => {
            copyToBrandRow.hidden = !copyToBrandRow.hidden;
            if (!copyToBrandRow.hidden) {
              renderBrandPickerRow(copyToBrandRow, post.brand_id, (targetBrandId) => {
                close();
                duplicatePostFlow(post, { brandId: targetBrandId });
              });
            }
          },
        }, 'Copy to brand →')
      );

      actions.appendChild(el('a', { class: 'button ghost md', href: `#/post/${post.id}`, onclick: close }, 'Open full page →'));
      card.appendChild(actions);
      card.appendChild(copyToBrandRow);
    })
    .catch((err) => {
      card.innerHTML = '';
      card.appendChild(inlineBanner(`Could not load post: ${err.message}`, 'error'));
      card.appendChild(el('button', { class: 'button secondary md', style: 'margin-top:8px;', onclick: close }, 'Close'));
    });
}

// ---------------- Image prompt system - shared editor + quick-edit modal ----------------
// The "system/negative/brand/layout" fields that feed every Codex image
// handoff (Settings originally owned this outright). `buildImagePromptEditor`
// is the ONE place that builds the grid + Save/Reload - Settings and the new
// Composer/Quick-Compose "Edit prompts" modal both call this instead of each
// keeping their own copy, so there's exactly one save path to the same
// `image_prompt_*` settings keys (item 4 of the 2026-07-19 feedback pass).
function buildImagePromptEditor(container, initialSettings = {}) {
  const promptFields = [
    ['image_prompt_system', 'System direction', 7],
    ['image_prompt_negative', 'Negative prompt', 5],
    ['image_prompt_brand', 'Brand rules', 5],
    ['image_prompt_layout', 'Layout rules', 5],
  ];
  const promptInputs = {};
  const promptGrid = el('div', { class: 'settings-prompt-grid' });
  for (const [key, label, rows] of promptFields) {
    const area = el('textarea', { rows: String(rows), placeholder: label });
    area.value = initialSettings[key] || '';
    promptInputs[key] = area;
    promptGrid.appendChild(el('div', { class: 'field-row' }, [el('label', {}, label), area]));
  }
  container.appendChild(promptGrid);
  const msg = el('div');
  container.appendChild(
    el('div', { class: 'toolbar settings-prompt-actions' }, [
      el('button', {
        class: 'primary',
        onclick: async () => {
          msg.innerHTML = '';
          try {
            await api('/api/settings', {
              method: 'PATCH',
              body: Object.fromEntries(Object.entries(promptInputs).map(([key, input]) => [key, input.value])),
            });
            toast('Image prompt system saved.');
          } catch (err) {
            msg.appendChild(inlineBanner(err.message, 'error'));
          }
        },
      }, 'Save image prompts'),
      el('button', {
        onclick: async () => {
          msg.innerHTML = '';
          try {
            const fresh = await api('/api/settings');
            for (const [key] of promptFields) promptInputs[key].value = fresh[key] || '';
            toast('Reloaded from Settings.');
          } catch (err) {
            msg.appendChild(inlineBanner(err.message, 'error'));
          }
        },
      }, 'Reload'),
    ])
  );
  container.appendChild(msg);
  return { promptFields, promptInputs };
}

// Quick-edit modal - same fields/save path as Settings' Image prompt system
// card, opened from a ghost button next to "Request image" so a quick prompt
// tweak doesn't require leaving the composer.
function openImagePromptModal() {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card' });
  overlay.appendChild(card);
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  card.appendChild(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Image prompt system'),
      el('button', { class: 'modal-close', title: 'Close', type: 'button', onclick: close }, '✕'),
    ])
  );
  card.appendChild(
    settingsHint('These instructions are included in every Codex image handoff spec. Saving here saves to the same Settings fields.')
  );
  api('/api/settings')
    .then((settings) => buildImagePromptEditor(card, settings))
    .catch((err) => card.appendChild(inlineBanner(`Could not load settings: ${err.message}`, 'error')));
}

// ---------------- Quick Compose (FAB modal) ----------------
// Compact "start a post" dialog: brand -> accounts -> one big copy box with
// Draft-with-AI right next to it -> media -> schedule -> done in ~15s. This
// is the FAB's landing spot instead of the full #/composer page (CB's
// verdict: the full composer "opens up a whole bunch of text" - Quick
// Compose is the Sprout/Hootsuite-style compact modal). Reuses the composer's
// own endpoints (no new backend routes): POST /api/posts, /api/draft,
// /api/posts/:id/queue, /api/best-times, /api/media, /api/image-requests,
// PATCH /api/posts/:id (status: approved). "Open full composer" hands off to
// #/composer via sessionStorage (pd_composer_prefill_brand, already read by
// renderComposer, plus a new pd_composer_qc_prefill key it also reads at
// mount - see loadForBrand's "Quick Compose hand-off" block).
function openQuickCompose(prefill = {}) {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card modal-compose' });
  overlay.appendChild(card);

  function hasUnsavedChanges() {
    return copyArea.value.trim().length > 0;
  }
  function close({ force = false } = {}) {
    if (!force && hasUnsavedChanges() && !confirm('Discard this post?')) return;
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  card.appendChild(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Quick post'),
      el('button', { class: 'modal-close', title: 'Close', type: 'button', onclick: () => close() }, '✕'),
    ])
  );

  let brandId = (prefill.brandId != null ? prefill.brandId : null)
    || (getStickyBrand() && state.brands.some((b) => String(b.id) === String(getStickyBrand())) ? getStickyBrand() : null)
    || (state.brands[0] && state.brands[0].id)
    || null;
  let selectedAccounts = new Set(prefill.accountIds || []);
  let attachedImage = null;
  let currentProvider = sessionDraftProvider || 'claude';
  let mediaFiles = [];
  // F3: idea-drag/"Use in post" handoff - once a post is actually created
  // from this compose session, flip the source idea to 'done' (IDEA_STATUSES'
  // terminal "used" state) so it drops off the board's active columns.
  const prefillIdeaId = prefill.ideaId || null;
  // Returns true when the idea was actually flipped (so callers can fold
  // "Idea used." into their own single toast - toast() replaces the last one
  // rather than stacking, so two separate calls in a row would just lose
  // the first message).
  async function markIdeaUsedIfNeeded() {
    if (!prefillIdeaId) return false;
    try {
      await api(`/api/ideas/${prefillIdeaId}`, { method: 'PATCH', body: { status: 'done' } });
      return true;
    } catch {
      return false; // best-effort - the post was still created either way
    }
  }

  const brandChipRow = el('div', { class: 'chip-row' });
  const accountChipRow = el('div', { class: 'chip-row' });
  const charCountEl = el('div', { class: 'char-count' });
  const foldCountEl = el('div', { class: 'fold-count' });
  const previewToggleBtn = el('button', { class: 'button ghost sm', type: 'button' }, 'Preview');
  const previewHost = el('div', { class: 'feed-preview-host', style: 'margin-top:8px;' });
  let previewOpen = false;
  let previewDebounce = null;
  const toneSelect = el(
    'select',
    { class: 'sm' },
    ['business', 'personal', 'casual'].map((t) => el('option', { value: t }, t))
  );
  const aiMsg = el('div');
  const draftBtn = el('button', { class: 'button primary sm', type: 'button' }, 'Draft with AI');
  const copyArea = el('textarea', { rows: '6', placeholder: "What's the post about…", id: 'qc-copy-area' });
  autosizeTextarea(copyArea);
  copyArea.addEventListener('input', updateCharCount);

  const imageSelect = el('select', { class: 'sm' }, [el('option', { value: '' }, '(no image)')]);
  const imageReqBtn = el('button', { class: 'button secondary sm', type: 'button' }, 'Request image (Codex)');
  const imageStatus = el('div', { class: 'hint', style: 'color:var(--muted);font-size:12px;' });

  const publishAtInput = el('input', { type: 'datetime-local', class: 'sm' });
  const bestTimeHost = el('div', { class: 'best-time-host' });
  const queueBtn = el('button', { class: 'button secondary sm', type: 'button' }, 'Add to queue');
  const scheduleMsg = el('div');

  // item 6: compact first-comment toggle (same idea as the full composer's).
  let firstCommentEnabled = false;
  const firstCommentToggle = el('input', { type: 'checkbox' });
  const firstCommentInput = el('input', { placeholder: 'https://... (goes in the first comment)', class: 'sm', style: 'width:100%;margin-top:4px;' });
  firstCommentInput.hidden = true;
  firstCommentToggle.addEventListener('change', () => {
    firstCommentEnabled = firstCommentToggle.checked;
    firstCommentInput.hidden = !firstCommentEnabled;
    scheduleLivePreview();
  });
  firstCommentInput.addEventListener('input', scheduleLivePreview);
  const firstCommentRow = el('div', { class: 'field-row', style: 'margin-top:6px;' }, [
    el('label', { class: 'cv3-first-comment-label' }, [firstCommentToggle, ' Link in first comment']),
    firstCommentInput,
  ]);

  const saveBtn = el('button', { class: 'button primary md', type: 'button' }, 'Save draft');
  const saveApproveBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Save & approve');
  const openFullBtn = el('button', { class: 'button ghost md', type: 'button' }, 'Open full composer →');
  const actionMsg = el('div');

  function currentAccounts() {
    return state.accounts.filter((a) => String(a.brand_id) === String(brandId));
  }
  function selectedPlatforms() {
    const accounts = currentAccounts();
    return [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean);
  }
  function mostRestrictiveLimit() {
    const limits = selectedPlatforms().map((p) => textLimitFor(p)).filter((n) => n != null);
    return limits.length ? Math.min(...limits) : null;
  }
  // F1: the fold counter tracks whichever selected platform folds soonest
  // (most restrictive), matching mostRestrictiveLimit's approach for the
  // hard char limit above it.
  function mostRestrictiveFoldPlatform() {
    const platforms = selectedPlatforms();
    let best = null;
    for (const p of platforms) {
      const f = foldCharsFor(p);
      if (f == null) continue;
      if (best == null || f < best.fold) best = { platform: p, fold: f };
    }
    return best;
  }
  function updateCharCount() {
    const limit = mostRestrictiveLimit();
    if (limit == null) { charCountEl.textContent = ''; charCountEl.classList.remove('over'); }
    else {
      charCountEl.textContent = `${copyArea.value.length} / ${limit}`;
      charCountEl.classList.toggle('over', copyArea.value.length > limit);
    }
    const best = mostRestrictiveFoldPlatform();
    foldCountEl.className = 'fold-count';
    if (!best) { foldCountEl.textContent = ''; }
    else {
      const state2 = foldCounterState(copyArea.value, best.fold);
      foldCountEl.textContent = state2.text ? `${state2.text} (${best.platform})` : '';
      if (state2.cls) foldCountEl.classList.add(state2.cls);
    }
    scheduleLivePreview();
  }
  function scheduleLivePreview() {
    if (!previewOpen) return;
    clearTimeout(previewDebounce);
    previewDebounce = setTimeout(renderQcPreview, 200);
  }
  function renderQcPreview() {
    previewHost.innerHTML = '';
    if (!previewOpen) return;
    const platforms = selectedPlatforms();
    const platform = platforms[0];
    if (!platform) {
      previewHost.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'Pick an account to preview.'));
      return;
    }
    const brand = state.brands.find((b) => String(b.id) === String(brandId));
    const mediaUrl = attachedImage ? (mediaFiles.find((f) => f.path === attachedImage.path)?.url || null) : null;
    previewHost.appendChild(renderPostPreview(platform, { copy: copyArea.value, mediaUrl, brand }));
    if (firstCommentEnabled && firstCommentInput.value.trim()) {
      previewHost.appendChild(el('div', { class: 'feed-preview-first-comment' }, [
        el('span', { class: 'feed-preview-first-comment-label' }, 'first comment'),
        el('span', {}, firstCommentInput.value.trim()),
      ]));
    }
  }
  previewToggleBtn.addEventListener('click', () => {
    previewOpen = !previewOpen;
    previewToggleBtn.classList.toggle('active-tag', previewOpen);
    if (previewOpen) renderQcPreview();
    else previewHost.innerHTML = '';
  });

  function renderBrandChips() {
    brandChipRow.innerHTML = '';
    for (const b of state.brands) {
      const active = String(b.id) === String(brandId);
      brandChipRow.appendChild(
        el('button', {
          type: 'button',
          class: 'chip-btn' + (active ? ' active-tag' : ''),
          onclick: () => {
            if (String(brandId) === String(b.id)) return;
            brandId = b.id;
            setStickyBrand(b.id);
            selectedAccounts = new Set();
            renderBrandChips();
            renderAccountChips();
            renderMedia();
            updateCharCount();
            updateBestTime();
          },
        }, b.name)
      );
    }
  }

  function renderAccountChips() {
    accountChipRow.innerHTML = '';
    const accounts = currentAccounts();
    if (!accounts.length) {
      accountChipRow.appendChild(
        el('span', { style: 'color:var(--muted);font-size:12px;' }, 'No accounts for this brand yet - add one in the full composer.')
      );
      return;
    }
    for (const a of accounts) {
      const active = selectedAccounts.has(a.id);
      const manual = isManualAccount(a);
      accountChipRow.appendChild(
        el('button', {
          type: 'button',
          class: 'chip-btn' + (active ? ' active-tag' : ''),
          onclick: () => {
            if (active) selectedAccounts.delete(a.id);
            else selectedAccounts.add(a.id);
            renderAccountChips();
            updateCharCount();
            updateBestTime();
          },
        }, [platformIcon(a.platform, { size: 13 }), ` ${a.platform}${manual ? ' (manual)' : ''}`])
      );
    }
  }

  async function renderMedia() {
    imageSelect.innerHTML = '';
    imageSelect.appendChild(el('option', { value: '' }, '(no image)'));
    attachedImage = null;
    mediaFiles = await api('/api/media').catch(() => []);
    for (const f of mediaFiles.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.filename))) {
      imageSelect.appendChild(el('option', { value: f.path }, f.filename));
    }
  }
  imageSelect.onchange = () => {
    const f = mediaFiles.find((x) => x.path === imageSelect.value);
    attachedImage = f ? { path: f.path, altText: '' } : null;
    scheduleLivePreview();
  };

  let bestTimeToken = 0;
  function updateBestTime() {
    const accounts = currentAccounts();
    const firstAcct = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)).find(Boolean);
    const myToken = ++bestTimeToken;
    renderBestTimeHint(bestTimeHost, {
      brandId,
      platform: firstAcct?.platform,
      guard: { stale: () => myToken !== bestTimeToken },
      onApplyIso: (val) => { publishAtInput.value = val; },
    });
  }

  draftBtn.addEventListener('click', async () => {
    aiMsg.innerHTML = '';
    const platforms = selectedPlatforms();
    if (!platforms.length) {
      aiMsg.appendChild(inlineBanner('Pick at least one account first.', 'error'));
      return;
    }
    const ideaText = copyArea.value.trim() || 'Write an engaging post';
    draftBtn.disabled = true;
    draftBtn.classList.add('is-pending');
    draftBtn.textContent = 'Drafting…';
    try {
      const tp = await findToneProfileId(brandId, toneSelect.value).catch(() => null);
      const result = await api('/api/draft', {
        method: 'POST',
        body: { idea_text: ideaText, brand_id: Number(brandId), tone_profile_id: tp, platforms, provider: currentProvider },
      });
      const draft = result.drafts?.[platforms[0]];
      if (draft) {
        copyArea.value = draft;
        updateCharCount();
        aiMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Draft applied - edit freely, or open the full composer for per-platform variants.'));
      } else {
        aiMsg.appendChild(inlineBanner('No draft returned.', 'error'));
      }
    } catch (err) {
      if (err.status === 503) {
        aiMsg.appendChild(
          inlineBanner(`AI drafting unavailable - log in to the AI provider from the full composer's AI panel. (${err.message})`, 'error')
        );
      } else {
        aiMsg.appendChild(inlineBanner(`AI drafting unavailable: ${err.message}`, 'error'));
      }
    } finally {
      draftBtn.disabled = false;
      draftBtn.classList.remove('is-pending');
      draftBtn.textContent = 'Draft with AI';
    }
  });

  imageReqBtn.addEventListener('click', async () => {
    imageStatus.textContent = '';
    const platforms = selectedPlatforms();
    if (!platforms.length) { imageStatus.textContent = 'Pick at least one account first.'; return; }
    imageReqBtn.disabled = true;
    try {
      await api('/api/image-requests', {
        method: 'POST',
        body: { brand_id: Number(brandId), platforms, content_type: null, copy: copyArea.value, variant_count: 1, hints: {} },
      });
      imageStatus.textContent = 'Waiting on Codex - run the image handoff to generate this (see Images tab).';
    } catch (err) {
      imageStatus.textContent = `Could not request image: ${err.message}`;
    } finally {
      imageReqBtn.disabled = false;
    }
  });

  async function createPosts(publishAtOverride) {
    const accounts = currentAccounts();
    const targets = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
    if (!targets.length) return [];
    const media = attachedImage ? [{ path: attachedImage.path, altText: attachedImage.altText || '' }] : [];
    const created = [];
    for (const acct of targets) {
      const row = await api('/api/posts', {
        method: 'POST',
        body: {
          brand_id: Number(brandId),
          account_id: acct.id,
          platform: acct.platform,
          copy: copyArea.value,
          platform_fields: {},
          content_type: null,
          media,
          first_comment: firstCommentEnabled && firstCommentInput.value.trim() ? firstCommentInput.value.trim() : null,
          publish_at: publishAtOverride !== undefined
            ? publishAtOverride
            : (publishAtInput.value ? new Date(publishAtInput.value).toISOString() : null),
        },
      });
      created.push(row);
    }
    return created;
  }

  saveBtn.addEventListener('click', async () => {
    actionMsg.innerHTML = '';
    if (!selectedAccounts.size) { actionMsg.appendChild(inlineBanner('Pick at least one account first.', 'error')); return; }
    saveBtn.disabled = true;
    saveBtn.classList.add('is-pending');
    try {
      await createPosts();
      const ideaUsed = await markIdeaUsedIfNeeded();
      toast(ideaUsed ? 'Draft saved. Idea used.' : 'Draft saved.');
      close({ force: true });
      if (typeof currentCalendarReload === 'function') currentCalendarReload();
    } catch (err) {
      actionMsg.appendChild(inlineBanner(`Could not save: ${err.message}`, 'error'));
    } finally {
      saveBtn.disabled = false;
      saveBtn.classList.remove('is-pending');
    }
  });

  saveApproveBtn.addEventListener('click', async () => {
    actionMsg.innerHTML = '';
    if (!selectedAccounts.size) { actionMsg.appendChild(inlineBanner('Pick at least one account first.', 'error')); return; }
    saveApproveBtn.disabled = true;
    saveApproveBtn.classList.add('is-pending');
    try {
      const created = await createPosts();
      for (const row of created) {
        await api(`/api/posts/${row.id}`, { method: 'PATCH', body: { status: 'approved' } });
      }
      const ideaUsed = await markIdeaUsedIfNeeded();
      toast(ideaUsed ? 'Saved and approved. Idea used.' : 'Saved and approved.');
      close({ force: true });
      if (typeof currentCalendarReload === 'function') currentCalendarReload();
    } catch (err) {
      actionMsg.appendChild(inlineBanner(`Could not save & approve: ${err.message}`, 'error'));
    } finally {
      saveApproveBtn.disabled = false;
      saveApproveBtn.classList.remove('is-pending');
    }
  });

  queueBtn.addEventListener('click', async () => {
    scheduleMsg.innerHTML = '';
    if (!selectedAccounts.size) { scheduleMsg.appendChild(inlineBanner('Pick at least one account first.', 'error')); return; }
    queueBtn.disabled = true;
    try {
      const created = await createPosts(null);
      const lines = [];
      let anySucceeded = false;
      let anyNoSlot = false;
      for (const post of created) {
        try {
          const res = await api(`/api/posts/${post.id}/queue`, { method: 'POST', body: {} });
          lines.push(`${post.platform}: queued for ${fmtDate(res.publish_at)}`);
          anySucceeded = true;
        } catch (err) {
          if (err.status === 422 && err.data?.error === 'no_open_slot') {
            lines.push(`${post.platform}: no open queue slots - set one up in Settings`);
            anyNoSlot = true;
          } else {
            lines.push(`${post.platform}: ${err.message}`);
          }
        }
      }
      // The post(s) themselves were still saved as drafts even if queueing
      // failed (e.g. no open slot yet) - never close on a silent failure,
      // or the operator loses track of what happened to their draft.
      scheduleMsg.appendChild(
        el('div', { class: `msg-banner ${anySucceeded ? 'msg-ok' : 'msg-error'}` }, lines.join(' · '))
      );
      if (anyNoSlot) {
        scheduleMsg.appendChild(
          el('div', {}, [el('a', { href: '#/settings', onclick: () => close({ force: true }) }, 'Set up a queue slot in Settings')])
        );
      }
      if (anySucceeded) {
        const ideaUsed = await markIdeaUsedIfNeeded();
        toast(ideaUsed ? 'Added to queue. Idea used.' : 'Added to queue.');
        close({ force: true });
        if (typeof currentCalendarReload === 'function') currentCalendarReload();
      } else {
        toast('Draft saved, but could not queue.', 'error');
      }
    } catch (err) {
      scheduleMsg.appendChild(inlineBanner(`Could not queue: ${err.message}`, 'error'));
    } finally {
      queueBtn.disabled = false;
    }
  });

  openFullBtn.addEventListener('click', () => {
    if (brandId) sessionStorage.setItem('pd_composer_prefill_brand', brandId);
    else sessionStorage.removeItem('pd_composer_prefill_brand');
    sessionStorage.setItem(
      'pd_composer_qc_prefill',
      JSON.stringify({ copy: copyArea.value, account_ids: [...selectedAccounts] })
    );
    close({ force: true });
    location.hash = '#/composer';
  });

  card.append(
    el('div', { class: 'field-row', style: 'margin-top:10px;' }, [el('label', {}, 'Brand'), brandChipRow]),
    el('div', { class: 'field-row', style: 'margin-top:8px;' }, [el('label', {}, 'Post to'), accountChipRow]),
    el('div', { class: 'qc-copy-row', style: 'margin-top:10px;' }, [
      el('div', { class: 'toolbar qc-copy-toolbar' }, [
        el('label', {}, 'Tone'),
        toneSelect,
        draftBtn,
        previewToggleBtn,
        charCountEl,
      ]),
      foldCountEl,
      copyArea,
      previewHost,
      aiMsg,
    ]),
    el('div', { class: 'field-row', style: 'margin-top:8px;' }, [
      el('label', {}, 'Image'),
      el('div', { class: 'qc-inline-controls' }, [
        imageSelect,
        imageReqBtn,
        el('button', { class: 'button ghost sm', type: 'button', onclick: openImagePromptModal }, 'Edit prompts'),
      ]),
    ]),
    imageStatus,
    el('div', { class: 'field-row', style: 'margin-top:8px;' }, [
      el('label', {}, 'Publish at'),
      el('div', { class: 'qc-inline-controls' }, [publishAtInput, queueBtn]),
    ]),
    bestTimeHost,
    firstCommentRow,
    scheduleMsg,
    actionMsg,
    el('div', { class: 'toolbar qc-action-bar' }, [openFullBtn, saveApproveBtn, saveBtn])
  );

  if (prefill.copy) copyArea.value = prefill.copy;
  if (prefill.publishAt) publishAtInput.value = prefill.publishAt;
  renderBrandChips();
  renderAccountChips();
  renderMedia();
  updateCharCount();
  updateBestTime();

  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  setTimeout(() => copyArea.focus(), 0);
}

// ---------------- Review mode (F2) ----------------
// Batch approval for AI-drafted posts: one draft at a time, full F1 preview,
// act, next. Queue = status:'draft' posts (brand-filtered by the same sticky
// brand chip row Quick Compose/Home use), oldest first. No new backend
// endpoints beyond the F2 hard-delete (DELETE /api/posts/:id) - approve/skip
// reuse the existing PATCH /api/posts/:id + POST /api/posts/:id/queue paths,
// so the approve-gate (TikTok field check, UTM append) fires exactly as it
// does everywhere else.
async function renderReview(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  let reviewBrand = getStickyBrand();
  let queue = [];
  let originalTotal = 0;
  let approvedCount = 0;
  let skippedCount = 0;
  let trashedCount = 0;
  let currentCopyArea = null; // for the 'E' shortcut to focus

  const brandChipRow = el('div', { class: 'chip-row' });
  view.appendChild(pageHeader('Review', brandChipRow));

  const body = el('div', { class: 'review-body' });
  view.appendChild(body);

  function processed() {
    return approvedCount + skippedCount + trashedCount;
  }

  function renderBrandChips() {
    brandChipRow.innerHTML = '';
    brandChipRow.appendChild(
      el('button', {
        type: 'button',
        class: 'chip-btn' + (!reviewBrand ? ' active-tag' : ''),
        onclick: () => { if (!reviewBrand) return; reviewBrand = ''; setStickyBrand(''); load(); },
      }, 'All brands')
    );
    for (const b of state.brands) {
      brandChipRow.appendChild(
        el('button', {
          type: 'button',
          class: 'chip-btn' + (String(reviewBrand) === String(b.id) ? ' active-tag' : ''),
          onclick: () => {
            if (String(reviewBrand) === String(b.id)) return;
            reviewBrand = b.id;
            setStickyBrand(b.id);
            load();
          },
        }, b.name)
      );
    }
  }

  async function load() {
    renderBrandChips();
    body.innerHTML = '<p style="color:var(--muted)">Loading…</p>';
    const qs = reviewBrand ? `?status=draft&brand=${encodeURIComponent(reviewBrand)}` : '?status=draft';
    const posts = await api(`/api/posts${qs}`);
    queue = posts.slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    originalTotal = queue.length;
    approvedCount = 0;
    skippedCount = 0;
    trashedCount = 0;
    renderCurrent();
  }

  function renderCurrent() {
    body.innerHTML = '';
    currentCopyArea = null;

    if (!queue.length) {
      if (originalTotal === 0) {
        body.appendChild(
          emptyState('No drafts to review', 'Open Quick Compose', () => openQuickCompose(reviewBrand ? { brandId: reviewBrand } : {}))
        );
      } else {
        const parts = [`${approvedCount} approved`, `${skippedCount} skipped`];
        if (trashedCount) parts.push(`${trashedCount} trashed`);
        body.appendChild(
          el('div', { class: 'card review-summary' }, [
            el('h2', {}, 'All done'),
            el('div', {}, parts.join(', ') + '.'),
            el('div', { class: 'toolbar', style: 'margin-top:12px;' }, [
              el('a', { class: 'button primary md', href: '#/home' }, 'Back to Home'),
            ]),
          ])
        );
      }
      return;
    }

    const post = queue[0];
    const brand = state.brands.find((b) => b.id === post.brand_id);
    const mediaUrl = post.media && post.media.length ? (post.media[0].url || null) : null;

    const card = el('div', { class: 'card review-card' });
    card.appendChild(el('div', { class: 'review-progress' }, `${processed() + 1} of ${originalTotal}`));
    card.appendChild(
      el('div', { class: 'modal-sub' }, `${brandName(post.brand_id)} · ${post.platform}`)
    );

    const previewHost = el('div', { style: 'margin-top:8px;' });
    previewHost.appendChild(renderPostPreview(post.platform, { copy: post.copy || '', mediaUrl, brand }));
    card.appendChild(previewHost);

    const copyArea = el('textarea', { rows: '8', class: 'review-copy-area' });
    copyArea.value = post.copy || '';
    autosizeTextarea(copyArea);
    copyArea.addEventListener('input', () => {
      previewHost.innerHTML = '';
      previewHost.appendChild(renderPostPreview(post.platform, { copy: copyArea.value, mediaUrl, brand }));
    });
    card.appendChild(el('div', { class: 'field-row', style: 'margin-top:8px;' }, [el('label', {}, 'Copy'), copyArea]));
    currentCopyArea = copyArea;

    const publishAtInput = el('input', { type: 'datetime-local', class: 'sm' });
    if (post.publish_at) publishAtInput.value = isoToLocalInput(post.publish_at);
    const queueBtn = el('button', { class: 'button secondary sm', type: 'button' }, 'Add to queue');
    const scheduleMsg = el('div');
    const bestTimeHost = el('div', { class: 'best-time-host' });
    const noTimeHint = el('div');

    function updateNoTimeHint() {
      noTimeHint.innerHTML = '';
      if (!publishAtInput.value) {
        noTimeHint.appendChild(inlineBanner('No time set - it will not auto-post once approved.', 'info'));
      }
    }
    publishAtInput.addEventListener('input', updateNoTimeHint);
    updateNoTimeHint();

    card.appendChild(
      el('div', { class: 'field-row', style: 'margin-top:8px;' }, [
        el('label', {}, 'Publish at'),
        el('div', { class: 'qc-inline-controls' }, [publishAtInput, queueBtn]),
      ])
    );
    card.appendChild(bestTimeHost);
    card.appendChild(noTimeHint);
    card.appendChild(scheduleMsg);

    renderBestTimeHint(bestTimeHost, {
      brandId: post.brand_id,
      platform: post.platform,
      onApplyIso: (v) => { publishAtInput.value = v; updateNoTimeHint(); },
    });

    queueBtn.addEventListener('click', async () => {
      scheduleMsg.innerHTML = '';
      queueBtn.disabled = true;
      try {
        const res = await api(`/api/posts/${post.id}/queue`, { method: 'POST', body: {} });
        post.publish_at = res.publish_at;
        publishAtInput.value = isoToLocalInput(res.publish_at);
        updateNoTimeHint();
        toast('Added to queue.');
      } catch (err) {
        if (err.status === 422 && err.data?.error === 'no_open_slot') {
          scheduleMsg.appendChild(inlineBanner('No open queue slots - set one up in Settings.', 'error'));
        } else {
          scheduleMsg.appendChild(inlineBanner(`Could not queue: ${err.message}`, 'error'));
        }
      } finally {
        queueBtn.disabled = false;
      }
    });

    const actionMsg = el('div');
    const actionsRow = el('div', { class: 'toolbar review-actions', style: 'margin-top:12px;' });

    async function doApprove(andNext) {
      actionMsg.innerHTML = '';
      const body2 = { copy: copyArea.value, status: 'approved' };
      const newPublishAt = publishAtInput.value ? new Date(publishAtInput.value).toISOString() : null;
      if (newPublishAt !== (post.publish_at || null)) body2.publish_at = newPublishAt;
      approveNextBtn.disabled = true;
      approveBtn.disabled = true;
      try {
        await api(`/api/posts/${post.id}`, { method: 'PATCH', body: body2 });
        approvedCount++;
        toast('Approved.');
        if (typeof currentCalendarReload === 'function') currentCalendarReload();
        if (andNext) {
          queue.shift();
          renderCurrent();
        } else {
          actionMsg.appendChild(inlineBanner('Approved.', 'ok'));
          actionsRow.innerHTML = '';
          actionsRow.appendChild(
            el('button', { class: 'button primary md', type: 'button', onclick: () => { queue.shift(); renderCurrent(); } }, 'Next →')
          );
        }
      } catch (err) {
        approveNextBtn.disabled = false;
        approveBtn.disabled = false;
        if (err.status === 422 && err.data?.error === 'tiktok_fields_missing') {
          actionMsg.appendChild(inlineBanner(`Missing TikTok fields: ${(err.data.missing || []).join(', ')} - open in composer to fill them in.`, 'error'));
        } else {
          actionMsg.appendChild(inlineBanner(`Could not approve: ${err.message}`, 'error'));
        }
      }
    }

    function doSkip() {
      skippedCount++;
      queue.shift();
      renderCurrent();
    }

    async function doTrash() {
      if (!confirm('Delete this draft permanently? This cannot be undone.')) return;
      actionMsg.innerHTML = '';
      trashBtn.disabled = true;
      try {
        await api(`/api/posts/${post.id}`, { method: 'DELETE' });
        trashedCount++;
        toast('Deleted.');
        queue.shift();
        if (typeof currentCalendarReload === 'function') currentCalendarReload();
        renderCurrent();
      } catch (err) {
        trashBtn.disabled = false;
        actionMsg.appendChild(inlineBanner(`Could not delete: ${err.message}`, 'error'));
      }
    }

    function doOpenComposer() {
      if (post.brand_id) sessionStorage.setItem('pd_composer_prefill_brand', post.brand_id);
      else sessionStorage.removeItem('pd_composer_prefill_brand');
      sessionStorage.setItem(
        'pd_composer_qc_prefill',
        JSON.stringify({ copy: copyArea.value, account_ids: post.account_id ? [post.account_id] : [] })
      );
      location.hash = '#/composer';
    }

    const approveNextBtn = el('button', { class: 'button primary md', type: 'button', onclick: () => doApprove(true) }, 'Approve & next');
    const approveBtn = el('button', { class: 'button secondary md', type: 'button', onclick: () => doApprove(false) }, 'Approve');
    const skipBtn = el('button', { class: 'button ghost md', type: 'button', onclick: doSkip }, 'Skip');
    const trashBtn = el('button', { class: 'button destructive md', type: 'button', onclick: doTrash }, 'Trash');
    const openComposerBtn = el('button', { class: 'button ghost md', type: 'button', onclick: doOpenComposer }, 'Open in composer');
    actionsRow.append(approveNextBtn, approveBtn, skipBtn, trashBtn, openComposerBtn);

    // item 4: manual-account / missed-window banners (review queue is drafts,
    // so these are rare here, but a re-approved draft can carry either flag)
    if (isMissedWindowPost(post)) {
      card.appendChild(missedWindowBanner(post, { onResolved: () => { queue.shift(); renderCurrent(); } }));
    } else if (isManualPost(post)) {
      card.appendChild(manualAccountBanner());
    }
    // item 1: Send to Blotato now (only meaningful once approved+scheduled,
    // but shown here too so a draft that already has a publish_at + non-manual
    // account can be sent immediately without a second trip through Calendar)
    if (canSendToBlotatoNow(post)) {
      actionsRow.appendChild(sendNowControl(post, { onDone: () => { queue.shift(); renderCurrent(); } }));
    }

    card.appendChild(actionMsg);
    card.appendChild(actionsRow);
    card.appendChild(
      el('div', { class: 'review-key-hint' }, '? A approve & next · S skip · ← → prev/next · E edit copy · Esc leave editor')
    );

    body.appendChild(card);

    // Local prev/next (arrow keys) - re-orders the front of the queue so the
    // operator can glance back without those posts being counted as acted
    // on. Only meaningful while there's more than one post queued.
    card._reviewNav = {
      next: () => { if (queue.length > 1) { queue.push(queue.shift()); renderCurrent(); } },
      prev: () => { if (queue.length > 1) { queue.unshift(queue.pop()); renderCurrent(); } },
    };
  }

  function keyHandler(e) {
    if (currentRoute().name !== 'review') return;
    const active = document.activeElement;
    const typing = active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT' || active.isContentEditable);
    if (typing) {
      if (e.key === 'Escape') { active.blur(); e.preventDefault(); }
      return;
    }
    const card = body.querySelector('.review-card');
    if (e.key === 'a' || e.key === 'A') {
      e.preventDefault();
      const btn = card && card.querySelector('.review-actions .button.primary');
      if (btn) btn.click();
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      const btn = card && card.querySelectorAll('.review-actions .button.ghost')[0];
      if (btn) btn.click();
    } else if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      if (currentCopyArea) currentCopyArea.focus();
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (card && card._reviewNav) card._reviewNav.next();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (card && card._reviewNav) card._reviewNav.prev();
    }
  }
  function cleanup() {
    document.removeEventListener('keydown', keyHandler);
    window.removeEventListener('hashchange', cleanup);
  }
  document.addEventListener('keydown', keyHandler);
  window.addEventListener('hashchange', cleanup);

  await load();
}

// ---------------- Post detail ----------------

async function renderPostDetail(view, params) {
  const id = params[0];
  const post = await api(`/api/posts/${id}`);
  view.innerHTML = '';
  view.classList.add('view-default');
  view.appendChild(pageHeader([`Post #${post.id} - `, platformIcon(post.platform, { size: 16 }), ` ${post.platform}`], el('span', { class: `pill status-${post.status}` }, post.status)));

  const card = el('div', { class: 'card' });
  card.appendChild(el('div', {}, [el('strong', {}, 'Brand: '), brandName(post.brand_id)]));
  card.appendChild(el('div', {}, [el('strong', {}, 'Publish at: '), fmtDate(post.publish_at)]));
  card.appendChild(el('div', { style: 'margin-top:10px;white-space:pre-wrap;' }, post.copy || '(no copy)'));
  if (post.public_url) {
    card.appendChild(el('div', { style: 'margin-top:10px;' }, [el('a', { href: post.public_url, target: '_blank' }, post.public_url)]));
  }
  if (post.error_message) {
    card.appendChild(el('div', { style: 'margin-top:10px;' }, inlineBanner(post.error_message, 'error')));
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

      const actions = el('div', { class: 'toolbar' });
      if (isReddit) {
        actions.appendChild(
          el('button', {
            class: 'button secondary md',
            type: 'button',
            onclick: async () => {
              await navigator.clipboard.writeText(pf.title || '');
              toast('Title copied.');
            },
          }, 'Copy title')
        );
        actions.appendChild(
          el('button', {
            class: 'button secondary md',
            type: 'button',
            onclick: async () => {
              await navigator.clipboard.writeText(pf.body || post.copy || '');
              toast('Body copied.');
            },
          }, 'Copy body')
        );
        if (pf.subreddit) {
          actions.appendChild(
            el('a', {
              class: 'button secondary md',
              href: `https://www.reddit.com/r/${encodeURIComponent(pf.subreddit)}/submit`,
              target: '_blank',
            }, 'Open subreddit →')
          );
        }
      } else {
        actions.appendChild(
          el('button', {
            class: 'button secondary md',
            type: 'button',
            onclick: async () => {
              await navigator.clipboard.writeText(post.copy || '');
              toast('Copy copied.');
            },
          }, 'Copy')
        );
      }
      actions.appendChild(
        el('button', {
          class: 'button primary md',
          type: 'button',
          onclick: async () => {
            const url = prompt('Paste the published post URL:');
            if (!url) return;
            try {
              await api(`/api/posts/${post.id}/mark-posted`, { method: 'POST', body: { public_url: url } });
              toast('Marked posted.');
              router();
            } catch (err) {
              toast(`Could not mark posted: ${err.message}`, 'error');
            }
          },
        }, 'Mark posted')
      );
      panel.appendChild(actions);
      view.appendChild(panel);
    }
  }

  // status actions
  const actions = el('div', { class: 'toolbar' });
  if (post.status === 'draft') {
    actions.appendChild(
      el('button', {
        class: 'button primary md',
        type: 'button',
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
    actions.appendChild(el('button', { class: 'button destructive md', type: 'button', onclick: () => transition(post.id, 'canceled') }, 'Cancel'));
  } else if (post.status === 'approved' || post.status === 'scheduled_local') {
    actions.appendChild(el('button', { class: 'button destructive md', type: 'button', onclick: () => transition(post.id, 'canceled') }, 'Cancel'));
  }
  if (['approved', 'scheduled_local'].includes(post.status)) {
    actions.appendChild(
      el('button', {
        class: 'button primary md',
        type: 'button',
        onclick: async () => {
          try {
            await api(`/api/posts/${post.id}/submit`, { method: 'POST' });
            toast('Submitted.');
            router();
          } catch (err) {
            toast(`Could not submit: ${err.message}`, 'error');
          }
        },
      }, 'Submit now')
    );
  }
  view.appendChild(actions);

  async function transition(postId, status) {
    try {
      await api(`/api/posts/${postId}`, { method: 'PATCH', body: { status } });
      toast(status === 'canceled' ? 'Post canceled.' : 'Post updated.');
      router();
    } catch (err) {
      toast(`Could not update: ${err.message}`, 'error');
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
      class: 'button primary md',
      type: 'button',
      onclick: async () => {
        const body = { notes: notes.value };
        for (const f of fields) {
          const v = inputs[f].value;
          if (v !== '') body[f] = Number(v);
        }
        try {
          await api(`/api/posts/${post.id}/metrics`, { method: 'POST', body });
          toast('Metrics saved.');
          router();
        } catch (err) {
          toast(`Could not save metrics: ${err.message}`, 'error');
        }
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

    editCard.appendChild(
      el('button', {
        class: 'button primary md',
        type: 'button',
        onclick: async () => {
          try {
            await api(`/api/posts/${post.id}`, {
              method: 'PATCH',
              body: {
                copy: copyArea.value,
                platform_fields: editableFields,
                publish_at: publishAtEdit.value ? new Date(publishAtEdit.value).toISOString() : null,
              },
            });
            toast('Post saved.');
            router();
          } catch (err) {
            toast(`Could not save: ${err.message}`, 'error');
          }
        },
      }, 'Save changes')
    );
    view.appendChild(editCard);
  }
}

// ---------------- Ideas board ----------------

const IDEA_STATUSES = ['idea', 'clustered', 'drafted', 'done'];

async function renderIdeas(view) {
  view.innerHTML = '';
  view.classList.add('view-default');
  view.appendChild(pageHeader('Ideas Board'));

  const titleInput = el('input', { placeholder: 'New idea title…', style: 'width:260px' });
  const brandSelect = el('select', {}, [
    el('option', { value: '' }, '(no brand)'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const pillarInput = el('input', { placeholder: 'pillar (optional)' });
  const addBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      if (!titleInput.value.trim()) return;
      await api('/api/ideas', {
        method: 'POST',
        body: { title: titleInput.value.trim(), brand_id: brandSelect.value || null, pillar: pillarInput.value || null },
      });
      toast('Idea added.');
      renderIdeas(view);
    },
  }, '+ Add idea');
  view.appendChild(
    formSection('Add idea', null,
      el('div', { class: 'form-section-row', style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center;' }, [
        titleInput, brandSelect, pillarInput, addBtn,
      ])
    )
  );

  const ideas = await api('/api/ideas');
  const board = el('div', { class: 'kanban' });
  const statusLabels = { idea: 'Idea', clustered: 'Clustered', drafted: 'Drafted', done: 'Done' };
  for (const status of IDEA_STATUSES) {
    const col = el('div', { class: 'kanban-col' });
    col.appendChild(el('h3', {}, statusLabels[status] || status));
    const colIdeas = ideas.filter((i) => i.status === status);
    if (!colIdeas.length) {
      col.appendChild(emptyState('No ideas here yet.'));
    } else {
      colIdeas.forEach((idea) => col.appendChild(ideaCard(idea)));
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
          toast('Idea updated.');
          renderIdeas(view);
        },
      },
      [...IDEA_STATUSES, 'killed'].map((s) => el('option', { value: s, selected: s === idea.status ? 'selected' : undefined }, s))
    );
    // F3: drag this idea onto a calendar day to open Quick Compose prefilled
    // (see composeFromIdea) - "Use in post" is the same prefill without
    // needing a drag (touch/small screens, or just faster than aiming a
    // drag at the right day).
    const useBtn = el(
      'button',
      { class: 'button ghost sm', type: 'button', onclick: () => composeFromIdea(idea) },
      'Use in post'
    );
    const card = el('div', { class: 'idea-card', draggable: 'true' }, [
      el('div', {}, idea.title),
      el('div', { class: 'meta' }, `${idea.brand_id ? brandName(idea.brand_id) : 'no brand'}${idea.pillar ? ' · ' + idea.pillar : ''}`),
      select,
      useBtn,
    ]);
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(IDEA_DRAG_MIME, JSON.stringify({ id: idea.id, title: idea.title, brand_id: idea.brand_id }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    return card;
  }
}

// ---------------- Library ----------------

async function renderLibrary(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  const fileInput = el('input', { type: 'file', class: 'button secondary sm' });
  const uploadBtn = el('button', {
    class: 'button primary sm',
    type: 'button',
    onclick: async () => {
      if (!fileInput.files.length) return;
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      try {
        await api('/api/media', { method: 'POST', body: fd });
        toast('Uploaded.');
        renderLibrary(view);
      } catch (err) {
        toast(`Could not upload: ${err.message}`, 'error');
      }
    },
  }, 'Upload');
  // R1: title -> primary context control -> actions. Library has no brand
  // context, so the upload control is the sole action row.
  view.appendChild(pageHeader('Library', fileInput, uploadBtn));

  const files = await api('/api/media');
  if (!files.length) {
    view.appendChild(emptyState('No media yet - upload your first file above.'));
    return;
  }
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

// ---------------- Best-time nudge (B18a) ----------------
// Shared by the Composer's Schedule card and the Settings Queues editor -
// both just need "best window for brand+platform" rendered as a compact
// hint line with click-to-apply chips. Pure fetch + render, no state kept
// beyond the DOM the caller hands us.

// Client-side mirror of src/besttime.js's nextMatchingDatetime/nextOccurrence -
// duplicated (not imported) for the same reason parseDimsClient is: this is
// a plain <script> file, not an ES module, so it can't import src/*.js.
// Next ISO-local datetime-local value (YYYY-MM-DDTHH:MM) inside `band`
// ({days:[0-6,...], start_hour}) at/after now, rolling to next week if
// today's slot for that day has already passed.
function nextMatchingDatetimeLocal(band) {
  if (!band || !Array.isArray(band.days) || !band.days.length) return null;
  const now = new Date();
  const targetMinutes = (band.start_hour ?? 9) * 60;
  let best = null;
  for (const dow of band.days) {
    let dayDelta = dow - now.getDay();
    if (dayDelta < 0) dayDelta += 7;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (dayDelta === 0 && targetMinutes < nowMinutes) dayDelta += 7;
    const candidate = new Date(now);
    candidate.setHours(0, 0, 0, 0);
    candidate.setDate(candidate.getDate() + dayDelta);
    candidate.setHours(Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0);
    if (!best || candidate.getTime() < best.getTime()) best = candidate;
  }
  return best;
}

function dateToLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Fetches GET /api/best-times?brand_id=&platform= and renders a compact hint
 * line + click-to-apply band chips into `hostEl`. `onApplyIso(localInputValue)`
 * is called with a `datetime-local`-ready string when a chip is clicked (the
 * caller decides what to do with it - set a field, etc). Debounced by the
 * caller (this function itself just does one fetch+render per call); pass a
 * `token` object and this bails out if a newer call has since started, so
 * rapid brand/platform switches never race-render a stale result.
 */
async function renderBestTimeHint(hostEl, { brandId, platform, onApplyIso, guard } = {}) {
  hostEl.innerHTML = '';
  if (!brandId || !platform) return;
  let data;
  try {
    data = await api(`/api/best-times?brand_id=${brandId}&platform=${platform}`);
  } catch {
    return; // best-effort - nudge just doesn't show
  }
  if (guard && guard.stale && guard.stale()) return; // a newer request superseded this one
  hostEl.innerHTML = '';
  if (!data || !Array.isArray(data.bands) || !data.bands.length) return;

  const line = el('div', { class: 'best-time-hint' });
  const sourceLabel = data.source === 'data' ? 'from your data' : 'default';
  line.appendChild(el('span', { class: 'best-time-label' }, `Best window: ${data.bands[0].label} (${sourceLabel})`));
  if (data.last_post_days_ago !== null && data.last_post_days_ago !== undefined) {
    line.appendChild(
      el('span', { class: 'best-time-lastpost' }, ` · Last post to ${platform}: ${data.last_post_days_ago} day${data.last_post_days_ago === 1 ? '' : 's'} ago`)
    );
  }
  hostEl.appendChild(line);

  if (typeof onApplyIso === 'function') {
    const chipRow = el('div', { class: 'best-time-chips' });
    for (const band of data.bands) {
      chipRow.appendChild(
        el('button', {
          type: 'button',
          class: 'chip-btn best-time-chip',
          title: 'Set publish time to the next slot in this window',
          onclick: () => {
            const next = nextMatchingDatetimeLocal(band);
            if (next) onApplyIso(dateToLocalInputValue(next));
          },
        }, band.label)
      );
    }
    hostEl.appendChild(chipRow);
  }
}

// ---------------- Composer ----------------

async function renderComposer(view) {
  view.innerHTML = '';
  view.classList.add('view-default');
  view.classList.add('composer-v3');

  // One-off "Publish at" prefill when arriving from a calendar day click
  // (composeOnDate). Consumed once; applied to publishAtInput in loadForBrand.
  let prefillDate = sessionStorage.getItem('pd_composer_prefill_date');
  sessionStorage.removeItem('pd_composer_prefill_date');

  // One-off "Redraft the winner" handoff from Analytics (B18b). Consumed
  // once; applied in loadForBrand if it matches the brand being loaded -
  // preselects the matching platform's account, seeds the Default copy with a
  // "fresh take on this proven post" framing prompt, stages the original
  // as an example (existing examples mechanism, best-effort grounding for
  // future drafts), and auto-runs Draft with AI.
  let redraftData = null;
  const redraftRaw = sessionStorage.getItem('pd_composer_redraft');
  sessionStorage.removeItem('pd_composer_redraft');
  if (redraftRaw) {
    try {
      redraftData = JSON.parse(redraftRaw);
    } catch {
      redraftData = null;
    }
  }

  // Quick Compose (FAB modal) "Open full composer" hand-off - carries the
  // in-progress copy + selected accounts over so nothing typed there is
  // lost. Consumed once, applied in loadForBrand once accounts are known.
  let qcPrefill = null;
  const qcRaw = sessionStorage.getItem('pd_composer_qc_prefill');
  sessionStorage.removeItem('pd_composer_qc_prefill');
  if (qcRaw) {
    try {
      qcPrefill = JSON.parse(qcRaw);
    } catch {
      qcPrefill = null;
    }
  }

  const brandSelect = el('select', {}, [
    el('option', { value: '' }, 'Select brand…'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  view.appendChild(pageHeader('New post', brandSelect));

  const body = el('div', {});
  view.appendChild(body);

  let selectedAccounts = new Set();
  let currentTab = 'default'; // 'default' | platform name
  const draftsByPlatform = {}; // 'default' + one entry per platform
  const dirtyPlatforms = new Set(); // platforms the operator has edited directly (stop following Default)
  let contentType = '';
  let pillarText = '';
  let attachedImage = null; // { path, url, altText } - picked from the Library
  let pendingImageRequest = null; // { id, status, variants } - the "Waiting on Codex" placeholder
  let pendingImagePollTimer = null;
  let createdPostIds = []; // posts created for the current selection this session (Save draft / Save & approve / queue / image-request auto-save)

  async function loadForBrand(brandId) {
    body.innerHTML = '';
    clearInterval(pendingImagePollTimer);
    if (!brandId) return;
    const accounts = state.accounts.filter((a) => String(a.brand_id) === String(brandId));
    // B18b: preselect the matching platform's account when arriving from a
    // Redraft handoff, so it renders pre-checked.
    const pendingRedraft = redraftData && String(redraftData.brand_id) === String(brandId) ? redraftData : null;
    let redraftMatchingAcct = null;
    if (pendingRedraft) {
      redraftMatchingAcct = accounts.find((a) => a.platform === pendingRedraft.platform) || null;
      if (redraftMatchingAcct) selectedAccounts.add(redraftMatchingAcct.id);
      redraftData = null; // consume once - a later brand switch shouldn't repeat it
    }
    // Quick Compose hand-off: pre-check whichever accounts were selected there.
    if (qcPrefill && Array.isArray(qcPrefill.account_ids)) {
      for (const id of qcPrefill.account_ids) {
        if (accounts.some((a) => a.id === id)) selectedAccounts.add(id);
      }
    }
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
      { class: 'sm' },
      ['business', 'personal', 'casual'].map((t) =>
        el('option', { value: t, selected: t === defaultTone ? 'selected' : undefined }, t)
      )
    );
    // Per-platform structured fields (TikTok flags, blog title/slug/hero,
    // reddit title/subreddit/body), mutated in place by tiktokFieldsEditor/
    // blogFieldsEditor/redditFieldsEditor so they survive switching tabs.
    // Persisted into posts.platform_fields on Save draft.
    const platformFieldsByPlatform = {};
    const mediaFiles = await api('/api/media').catch(() => []);

    createdPostIds = [];

    // =========================================================
    // 1/2. Accounts row - icon chips, one line, wraps. "Manage accounts"
    // expands the old full account-management block (add platform, manual
    // toggle, remove) so it doesn't bloat the primary row.
    // =========================================================
    const accountsRow = el('div', { class: 'cv3-accounts-row' });
    const manageHost = el('div');
    manageHost.hidden = true;
    let manageOpen = false;

    function renderAccountsRow() {
      accountsRow.innerHTML = '';
      for (const a of accounts) {
        const active = selectedAccounts.has(a.id);
        const manual = isManualAccount(a);
        accountsRow.appendChild(
          el('button', {
            type: 'button',
            class: 'cv3-acct-chip' + (active ? ' active' : ''),
            onclick: () => {
              if (active) selectedAccounts.delete(a.id);
              else selectedAccounts.add(a.id);
              renderAccountsRow();
              renderCopyTabs();
              updateContentTypeSuggestion();
              updateBestTimeHint();
              renderMediaStrip();
              updateSummary();
            },
          }, [platformIcon(a.platform, { size: 14 }), ` ${a.platform}`, manual ? el('span', { class: 'manual-tag' }, ' (manual)') : ''])
        );
      }
      if (!accounts.length) {
        accountsRow.appendChild(el('span', { style: 'color:var(--muted);font-size:12px;' }, 'No accounts yet for this brand.'));
      }
      accountsRow.appendChild(
        el('button', {
          type: 'button',
          class: 'cv3-manage-link',
          onclick: () => {
            manageOpen = !manageOpen;
            manageHost.hidden = !manageOpen;
            manageHost.innerHTML = '';
            if (manageOpen) manageHost.appendChild(manageAccountsBox());
          },
        }, manageOpen ? 'Hide account management' : 'Manage accounts')
      );
    }

    // ---- Manage accounts (Advanced-style panel opened from the accounts
    // row): add a platform, toggle assisted-manual, remove an account. ----
    function manageAccountsBox() {
      const box = el('div', { class: 'card' });
      box.appendChild(el('h2', {}, 'Manage accounts'));
      function accountRow(a) {
        const limit = textLimitFor(a.platform);
        const limitStr = limit == null ? 'no char limit' : `${limit} char limit`;
        const badgeHost = el('span', { style: 'margin-left:8px;' });
        function renderBadge() {
          badgeHost.innerHTML = '';
          if (isManualAccount(a)) badgeHost.appendChild(el('span', { class: 'pill manual-pill' }, 'manual - copy & paste'));
        }
        renderBadge();
        const platformForced = isManualPlatform(a.platform);
        const manualToggle = el('input', { type: 'checkbox', class: 'switch' });
        manualToggle.checked = Number(a.manual) === 1;
        if (platformForced) manualToggle.disabled = true;
        manualToggle.addEventListener('change', async () => {
          const next = manualToggle.checked ? 1 : 0;
          try {
            const updated = await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { manual: next } });
            a.manual = updated?.manual ?? next;
            renderBadge();
            renderAccountsRow();
          } catch (err) {
            manualToggle.checked = !manualToggle.checked;
            toast(`Could not update manual flag: ${err.message}`, 'error');
          }
        });
        const manualLabel = el(
          'label',
          { class: 'manual-toggle-label', title: platformForced ? 'Already assisted-manual for this platform' : 'Mark as assisted-manual (copy & paste instead of auto-post)' },
          [manualToggle, ' manual']
        );
        const removeBtn = el('button', {
          class: 'account-remove',
          type: 'button',
          title: 'Remove this account',
          onclick: async () => {
            if (!confirm(`Remove the ${a.platform} account (#${a.id}) from this brand?`)) return;
            try {
              await api(`/api/accounts/${a.id}`, { method: 'DELETE' });
              state.accounts = state.accounts.filter((x) => x.id !== a.id);
              selectedAccounts.delete(a.id);
              await loadForBrand(brandId);
            } catch (err) {
              toast(`Could not remove account: ${err.message}`, 'error');
            }
          },
        }, '✕');
        return el('div', { class: 'account-row', style: 'display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin-bottom:6px;' }, [
          el('label', {}, `${a.platform} (account #${a.id}) - ${limitStr}`),
          manualLabel,
          badgeHost,
          removeBtn,
        ]);
      }
      if (accounts.length) accounts.map(accountRow).forEach((r) => box.appendChild(r));
      const existingPlatforms = new Set(accounts.map((a) => a.platform));
      const addablePlatforms = ['linkedin', 'facebook', 'twitter', 'instagram', 'reddit', 'tiktok', 'youtube', 'threads', 'blog']
        .filter((p) => !existingPlatforms.has(p));
      if (addablePlatforms.length) {
        const addSelect = el('select', {}, [
          el('option', { value: '' }, '+ add platform...'),
          ...addablePlatforms.map((p) => el('option', { value: p }, p)),
        ]);
        const addBtn = el('button', { class: 'btn-secondary', type: 'button' }, 'Add');
        const addMsg = el('span', { style: 'margin-left:8px;color:var(--muted);font-size:12px;' });
        addBtn.onclick = async () => {
          const platform = addSelect.value;
          if (!platform) return;
          addBtn.disabled = true;
          addMsg.textContent = 'Adding...';
          try {
            const created = await api('/api/accounts', { method: 'POST', body: { brand_id: brandId, platform } });
            state.accounts.push(created);
            selectedAccounts.add(created.id);
            manageOpen = true; // reopen post-render so the operator keeps context
            await loadForBrand(brandId);
          } catch (err) {
            addMsg.textContent = `Could not add: ${err.message}`;
            addBtn.disabled = false;
          }
        };
        box.appendChild(el('div', { class: 'field-row', style: 'margin-top:8px;' }, [addSelect, addBtn, addMsg]));
      }
      // Redistribute-from-blog (B11) lives here too - it's a secondary
      // one-off action, not core to composing a normal post.
      const redistributeHost = el('div');
      redistributeHost.hidden = true;
      let redistributeOpen = false;
      box.appendChild(
        el('div', { style: 'margin-top:10px;' }, [
          el('button', {
            class: 'button secondary sm',
            type: 'button',
            onclick: () => {
              redistributeOpen = !redistributeOpen;
              redistributeHost.hidden = !redistributeOpen;
              redistributeHost.innerHTML = '';
              if (redistributeOpen) redistributeHost.appendChild(redistributeForm(() => brandId));
            },
          }, 'Redistribute a blog post'),
          redistributeHost,
        ])
      );
      return box;
    }
    renderAccountsRow();

    // =========================================================
    // Details line - content type, tags, campaign (one compact row)
    // =========================================================
    const selectedTagIds = new Set();
    let selectedCampaignId = null;
    let brandTags = [];

    const contentTypeSelect = el(
      'select',
      { onchange: (e) => { contentType = e.target.value; renderMediaStrip(); } },
      [el('option', { value: '' }, '(unset)'), ...['static', 'carousel', 'image', 'text', 'video'].map((t) => el('option', { value: t }, t))]
    );
    const contentTypeHintEl = el('span', { class: 'hint', style: 'font-size:11px;color:var(--muted);margin-left:6px;', title: '' }, '');
    async function updateContentTypeSuggestion() {
      contentTypeHintEl.textContent = '';
      contentTypeHintEl.title = '';
      if (currentTab === 'default') return;
      try {
        const qs = new URLSearchParams({ brand_id: brandId, platform: currentTab });
        if (pillarText) qs.set('pillar', pillarText);
        const rec = await api(`/api/recommend/content-type?${qs.toString()}`);
        contentTypeHintEl.textContent = `💡 ${rec.suggestion}`;
        contentTypeHintEl.title = rec.ranked?.[0]?.reason || '';
      } catch {
        // best-effort only - recommender is a convenience, never blocks the composer
      }
    }
    const pillarInput = el('input', { placeholder: 'pillar (optional)', class: 'sm' });
    pillarInput.oninput = () => { pillarText = pillarInput.value; updateContentTypeSuggestion(); };

    const tagChipRow = el('div', { class: 'chip-row' });
    const tagCreateInput = el('input', { placeholder: '+ tag', class: 'sm', style: 'max-width:100px;display:inline-block;' });
    const campaignChipRow = el('div', { class: 'chip-row' });
    const campaignCreateInput = el('input', { placeholder: '+ campaign', class: 'sm', style: 'max-width:120px;display:inline-block;' });
    const tagsMsg = el('div');

    function renderTagPickers() {
      tagChipRow.innerHTML = '';
      campaignChipRow.innerHTML = '';
      for (const t of brandTags.filter((t) => t.kind === 'tag')) {
        const active = selectedTagIds.has(t.id);
        tagChipRow.appendChild(
          el('button', {
            type: 'button',
            class: 'chip-btn' + (active ? ' active-tag' : ''),
            style: `border-left:3px solid ${t.color || '#a3a19a'};${active ? `background:${t.color || 'var(--surface-2)'};color:#1a1200;` : ''}`,
            onclick: () => { active ? selectedTagIds.delete(t.id) : selectedTagIds.add(t.id); renderTagPickers(); },
          }, t.name)
        );
      }
      tagChipRow.appendChild(tagCreateInput);
      for (const t of brandTags.filter((t) => t.kind === 'campaign')) {
        const active = selectedCampaignId === t.id;
        campaignChipRow.appendChild(
          el('button', {
            type: 'button',
            class: 'chip-btn' + (active ? ' active-tag' : ''),
            style: `border-left:3px solid ${t.color || '#a3a19a'};${active ? `background:${t.color || 'var(--surface-2)'};color:#1a1200;` : ''}`,
            onclick: () => { selectedCampaignId = active ? null : t.id; renderTagPickers(); },
          }, t.name)
        );
      }
      campaignChipRow.appendChild(campaignCreateInput);
    }

    async function loadBrandTags() {
      try {
        brandTags = await api(`/api/tags?brand_id=${brandId}`);
      } catch (err) {
        brandTags = [];
        tagsMsg.innerHTML = '';
        tagsMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load tags: ${err.message}`));
      }
      renderTagPickers();
      loadAllTags(); // best-effort refresh of the calendar/analytics cache too
    }
    async function createInlineTag(kind, input) {
      const name = input.value.trim();
      if (!name) return;
      tagsMsg.innerHTML = '';
      try {
        const row = await api('/api/tags', { method: 'POST', body: { name, kind, color: nextTagColor(), brand_id: Number(brandId) } });
        brandTags.push(row);
        if (kind === 'tag') selectedTagIds.add(row.id);
        else selectedCampaignId = row.id;
        input.value = '';
        renderTagPickers();
      } catch (err) {
        tagsMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not create ${kind}: ${err.message}`));
      }
    }
    tagCreateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createInlineTag('tag', tagCreateInput); } });
    campaignCreateInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); createInlineTag('campaign', campaignCreateInput); } });
    await loadBrandTags();

    const detailsLine = el('div', { class: 'cv3-details-line' }, [
      el('div', { class: 'cv3-detail-field' }, [el('label', {}, 'Content type'), contentTypeSelect, contentTypeHintEl]),
      el('div', { class: 'cv3-detail-field' }, [el('label', {}, 'Pillar'), pillarInput]),
      el('div', { class: 'cv3-detail-field' }, [el('label', {}, 'Tags'), el('div', { class: 'cv3-tag-chip-add' }, [tagChipRow])]),
      el('div', { class: 'cv3-detail-field' }, [el('label', {}, 'Campaign (max one)'), el('div', { class: 'cv3-tag-chip-add' }, [campaignChipRow])]),
    ]);

    // =========================================================
    // Media strip - selected image, "+ Library", "Request image" (Codex),
    // and a "Waiting on Codex" placeholder tile while a request is pending.
    // =========================================================
    const mediaStrip = el('div', { class: 'cv3-media-strip' });
    const imageReqMsg = el('div');
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

    function stopPendingPoll() {
      if (pendingImagePollTimer) { clearInterval(pendingImagePollTimer); pendingImagePollTimer = null; }
    }
    function startPendingPoll() {
      stopPendingPoll();
      pendingImagePollTimer = setInterval(async () => {
        if (!pendingImageRequest) { stopPendingPoll(); return; }
        try {
          const row = await api(`/api/image-requests/${pendingImageRequest.id}`);
          pendingImageRequest = row;
          if (row.status && row.status !== 'requested' && row.status !== 'pending') {
            stopPendingPoll();
          }
          renderMediaStrip();
        } catch {
          // best-effort only - a transient poll failure just tries again
        }
      }, 4000);
    }

    async function ensurePostsSavedForImageRequest() {
      // Image requests persist via post_id (server auto-attaches the picked
      // variant to posts.media). If nothing's been saved yet this session,
      // silently save the current draft(s) first so the request has a post
      // to attach to - the operator never has to think about save-order.
      if (createdPostIds.length) return createdPostIds[0];
      const created = await createPostsForSelection();
      createdPostIds = created.map((p) => p.id);
      return createdPostIds[0] || null;
    }

    // item 7: alt text editor for the currently-attached image tile - inline
    // input toggled by a small "alt" button, plus a "Suggest" button that
    // calls the same /api/copy-assist alt_text mode the Advanced panel uses.
    async function suggestAltTextForAttached(altInput, altMsg) {
      altMsg.textContent = 'Asking AI…';
      try {
        const platforms = currentPlatforms();
        const res = await api('/api/copy-assist', {
          method: 'POST',
          body: {
            mode: 'alt_text',
            idea_text: draftsByPlatform.default || '',
            copy: getActiveCopy ? getActiveCopy() : '',
            brand_id: Number(brandId),
            platforms,
            image_path: attachedImage?.path,
            provider: sessionDraftProvider || 'claude',
          },
        });
        if (res.result?.alt_text) {
          altInput.value = res.result.alt_text;
          if (attachedImage) attachedImage.altText = res.result.alt_text;
          altMsg.textContent = '';
        } else {
          altMsg.textContent = 'No suggestion returned.';
        }
      } catch (err) {
        altMsg.textContent = err.status === 503 ? 'AI unavailable.' : err.message;
      }
    }
    function altTextEditor(imgObj, onSave) {
      const wrap = el('div', { class: 'cv3-media-alt', hidden: true });
      const altInput = el('input', { placeholder: 'Alt text (accessibility)', class: 'sm', value: imgObj.altText || '' });
      const altMsg = el('span', { style: 'font-size:11px;color:var(--muted);' });
      altInput.addEventListener('input', () => { imgObj.altText = altInput.value; if (onSave) onSave(altInput.value); });
      const suggestBtn = el('button', { class: 'button ghost sm', type: 'button', onclick: () => suggestAltTextForAttached(altInput, altMsg) }, 'Suggest');
      wrap.append(altInput, suggestBtn, altMsg);
      return wrap;
    }
    function renderMediaStrip() {
      mediaStrip.innerHTML = '';
      if (attachedImage) {
        const altBox = altTextEditor(attachedImage);
        const altBtn = el('button', { class: 'cv3-media-alt-btn', type: 'button', title: 'Edit alt text', onclick: () => { altBox.hidden = !altBox.hidden; } }, 'alt');
        const tile = el('div', { class: 'cv3-media-tile' }, [
          el('img', { src: attachedImage.url }),
          altBtn,
          el('button', { class: 'cv3-media-x', type: 'button', title: 'Remove image', onclick: () => { attachedImage = null; renderMediaStrip(); refreshActiveEditor(); } }, '✕'),
        ]);
        mediaStrip.appendChild(tile);
        mediaStrip.appendChild(altBox);
      }
      // "+ Library" tile
      const libTile = el('div', { class: 'cv3-media-tile add-tile' }, [el('span', {}, '📁'), el('span', {}, '+ Library')]);
      libTile.addEventListener('click', (e) => openLibraryPicker(e.currentTarget));
      mediaStrip.appendChild(libTile);
      // "Request image" tile
      const reqTile = el('div', { class: 'cv3-media-tile request-tile' }, [el('span', {}, '✨'), el('span', {}, 'Request image')]);
      reqTile.addEventListener('click', fireImageRequest);
      mediaStrip.appendChild(reqTile);
      mediaStrip.appendChild(
        el('button', { class: 'button ghost sm', type: 'button', style: 'align-self:center;', onclick: openImagePromptModal }, 'Edit prompts')
      );
      // Pending / resolved image-request placeholder
      if (pendingImageRequest) {
        const variants = Array.isArray(pendingImageRequest.variants) ? pendingImageRequest.variants : [];
        if (pendingImageRequest.chosen_path) {
          const chosen = variants.find((v) => v.path === pendingImageRequest.chosen_path) || {};
          const tile = el('div', { class: 'cv3-media-tile' }, [
            el('img', { src: chosen.url || pendingImageRequest.chosen_path }),
            el('button', { class: 'cv3-media-x', type: 'button', title: 'Remove', onclick: () => { pendingImageRequest = null; renderMediaStrip(); } }, '✕'),
          ]);
          mediaStrip.appendChild(tile);
        } else if (variants.length) {
          for (const v of variants) {
            const tile = el('div', { class: 'cv3-media-tile', title: 'Click to use this variant' }, [el('img', { src: v.url || v.path })]);
            tile.style.cursor = 'pointer';
            tile.addEventListener('click', async () => {
              try {
                const row = await api(`/api/image-requests/${pendingImageRequest.id}/pick`, { method: 'POST', body: { chosen_path: v.path } });
                pendingImageRequest = row;
                attachedImage = { path: v.path, url: v.url || v.path, altText: '' };
                stopPendingPoll();
                renderMediaStrip();
                refreshActiveEditor();
              } catch (err) {
                toast(`Could not use variant: ${err.message}`, 'error');
              }
            });
            mediaStrip.appendChild(tile);
          }
        } else {
          const tile = el('div', { class: 'cv3-media-tile pending-tile' }, [
            el('span', {}, '🖼️'),
            el('span', {}, 'Waiting on Codex'),
            el('button', {
              class: 'cv3-media-x', type: 'button', title: 'Cancel request',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${pendingImageRequest.id}/cancel`, { method: 'POST' });
                } catch {
                  // best-effort - clear the placeholder regardless
                }
                pendingImageRequest = null;
                stopPendingPoll();
                renderMediaStrip();
              },
            }, '✕'),
          ]);
          mediaStrip.appendChild(tile);
        }
      }
    }

    function openLibraryPicker(anchorEl) {
      document.querySelectorAll('.cv3-media-library-pop').forEach((n) => n.remove());
      const pop = el('div', { class: 'cv3-media-library-pop' });
      const images = mediaFiles.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.filename));
      if (!images.length) {
        pop.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;padding:6px;' }, 'No images in the Library yet.'));
      } else {
        for (const f of images) {
          pop.appendChild(el('button', { type: 'button', onclick: () => { attachedImage = { path: f.path, url: f.url, altText: '' }; pop.remove(); renderMediaStrip(); refreshActiveEditor(); } }, f.filename));
        }
      }
      document.body.appendChild(pop);
      const rect = anchorEl.getBoundingClientRect();
      pop.style.left = `${rect.left}px`;
      pop.style.top = `${rect.bottom + 6}px`;
      const onOutside = (e) => { if (!pop.contains(e.target) && e.target !== anchorEl) { pop.remove(); document.removeEventListener('mousedown', onOutside, true); } };
      setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
    }

    async function fireImageRequest() {
      imageReqMsg.innerHTML = '';
      const platforms = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean);
      if (!platforms.length) {
        imageReqMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one account first.'));
        return;
      }
      const copy = currentTab === 'reddit' ? (platformFieldsByPlatform.reddit?.body || '') : (draftsByPlatform[currentTab] || draftsByPlatform.default || '');
      const hints = {};
      if (sizeHintSelect.value) hints.size = sizeHintSelect.value;
      if (typeHintSelect.value) hints.type = typeHintSelect.value;
      try {
        const postId = await ensurePostsSavedForImageRequest();
        const res = await api('/api/image-requests', {
          method: 'POST',
          body: {
            brand_id: Number(brandId),
            post_id: postId || undefined,
            platforms,
            content_type: contentType || null,
            copy,
            variant_count: Number(variantCountSelect.value) || 1,
            hints,
          },
        });
        pendingImageRequest = res;
        renderMediaStrip();
        startPendingPoll();
      } catch (err) {
        imageReqMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, err.message));
      }
    }
    renderMediaStrip();

    // =========================================================
    // Schedule line - publish-at, add to queue, best-time chips, last-posted hint
    // =========================================================
    const publishAtInput = el('input', { type: 'datetime-local', class: 'sm' });
    if (prefillDate) { publishAtInput.value = prefillDate; prefillDate = null; } // from a calendar day click, applied once
    const bestTimeHost = el('div', { class: 'best-time-host' });
    let bestTimeToken = 0;
    function updateBestTimeHint() {
      const firstAcct = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)).find(Boolean);
      const myToken = ++bestTimeToken;
      renderBestTimeHint(bestTimeHost, {
        brandId,
        platform: firstAcct?.platform,
        guard: { stale: () => myToken !== bestTimeToken },
        onApplyIso: (val) => { publishAtInput.value = val; },
      });
    }
    updateBestTimeHint();

    const queueMsg = el('div');
    const queueBtn = el('button', { class: 'button secondary sm', type: 'button' }, 'Add to queue');
    queueBtn.addEventListener('click', async () => {
      queueMsg.innerHTML = '';
      if (![...selectedAccounts].length) {
        queueMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one account first.'));
        return;
      }
      let created;
      try {
        created = await createPostsForSelection(null);
        createdPostIds = created.map((p) => p.id);
      } catch (err) {
        queueMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not save draft: ${err.message}`));
        return;
      }
      if (!created.length) return;
      const lines = [];
      let earliest = null;
      for (const post of created) {
        try {
          const res = await api(`/api/posts/${post.id}/queue`, { method: 'POST', body: {} });
          const when = fmtDate(res.publish_at);
          lines.push(el('div', {}, `${post.platform}: queued for ${when}`));
          if (!earliest || res.publish_at < earliest) earliest = res.publish_at;
        } catch (err) {
          if (err.status === 422 && err.data?.error === 'no_open_slot') {
            lines.push(
              el('div', {}, [
                `${post.platform}: no active queue slots for this brand — `,
                el('a', { href: '#/settings', onclick: () => { location.hash = '#/settings'; } }, 'set one up in Settings'),
                '.',
              ])
            );
          } else {
            lines.push(el('div', {}, `${post.platform}: ${err.message}`));
          }
        }
      }
      if (earliest) publishAtInput.value = new Date(earliest).toISOString().slice(0, 16);
      toast('Draft(s) saved and queued. Go to Calendar to approve.');
      queueMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, lines));
    });

    // item 6: first-comment toggle - a small link the worker (or the
    // manual-post flow) can drop in as the first comment instead of cramming
    // it into the main copy. Saved defensively as first_comment on every
    // POST/PATCH so it round-trips even before/while the backend column ships.
    let firstCommentEnabled = false;
    const firstCommentToggle = el('input', { type: 'checkbox' });
    const firstCommentInput = el('input', { placeholder: 'https://... (goes in the first comment)', class: 'sm', style: 'width:260px;' });
    firstCommentInput.hidden = true;
    firstCommentToggle.addEventListener('change', () => {
      firstCommentEnabled = firstCommentToggle.checked;
      firstCommentInput.hidden = !firstCommentEnabled;
      refreshPreview();
    });
    firstCommentInput.addEventListener('input', refreshPreview);
    const firstCommentRow = el('div', { class: 'cv3-detail-field cv3-first-comment' }, [
      el('label', { class: 'cv3-first-comment-label' }, [firstCommentToggle, ' Link in first comment']),
      firstCommentInput,
    ]);

    const scheduleLine = el('div', { class: 'cv3-schedule-line' }, [
      el('div', { class: 'cv3-detail-field' }, [el('label', {}, 'Publish at'), publishAtInput]),
      queueBtn,
      bestTimeHost,
      firstCommentRow,
    ]);

    // =========================================================
    // Copy area - Default tab + one tab per selected platform. Tone / Draft
    // with AI / provider switch live directly above the box; the F1 preview
    // toggles under it (default ON, remembered per-browser).
    // =========================================================
    const copyTabsRow = el('div', { class: 'cv3-copy-tabs' });
    const copyToolbarRow = el('div', { class: 'cv3-copy-toolbar' });
    const copyHeaderRow = el('div', { class: 'cv3-copy-header' });
    const copyCountsEl = el('div', { class: 'cv3-copy-counts' });
    const copyTextarea = el('textarea', { class: 'cv3-copy-textarea', id: 'ai-idea-input', autofocus: 'autofocus' });
    autosizeTextarea(copyTextarea);
    const fieldsEditorHost = el('div'); // hosts tiktok/reddit/blog structured fields when active
    const aiMsg = el('div');
    const compareHost = el('div');
    const previewToggleBtn = el('button', { class: 'button ghost sm cv3-preview-toggle', type: 'button' }, 'Preview');
    const previewBody = el('div', { class: 'feed-preview-host' });
    let previewOpen = localStorage.getItem('pd_composer_preview_open') !== '0';

    function currentPlatforms() {
      return [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)?.platform).filter(Boolean);
    }

    function getActiveCopy() {
      if (currentTab === 'default') return draftsByPlatform.default || '';
      if (currentTab === 'reddit') return platformFieldsByPlatform.reddit?.body || '';
      return draftsByPlatform[currentTab] || '';
    }
    function setActiveCopy(v) {
      if (currentTab === 'default') {
        draftsByPlatform.default = v;
        // Propagate to every platform tab that hasn't been directly edited yet.
        for (const p of currentPlatforms()) {
          if (!dirtyPlatforms.has(p) && p !== 'reddit' && p !== 'blog') draftsByPlatform[p] = v;
        }
      } else if (currentTab === 'reddit') {
        platformFieldsByPlatform.reddit = platformFieldsByPlatform.reddit || {};
        platformFieldsByPlatform.reddit.body = v;
        dirtyPlatforms.add('reddit');
      } else {
        draftsByPlatform[currentTab] = v;
        dirtyPlatforms.add(currentTab);
      }
    }

    function refreshCopyHeader() {
      const platform = currentTab === 'default' ? null : currentTab;
      const foldChars = platform ? foldCharsFor(platform) : null;
      const limit = platform ? textLimitFor(platform) : null;
      const text = getActiveCopy();
      copyCountsEl.innerHTML = '';
      const lenEl = el('span', {}, limit == null ? `${text.length} chars` : `${text.length} / ${limit}`);
      if (limit != null && text.length > limit) lenEl.style.color = 'var(--red, #d9534f)';
      copyCountsEl.appendChild(lenEl);
      if (foldChars != null) {
        const st = foldCounterState(text, foldChars);
        copyCountsEl.appendChild(el('span', { class: st.cls || '' }, st.text));
      }
    }

    function refreshPreview() {
      previewBody.innerHTML = '';
      if (!previewOpen) return;
      const platform = currentTab === 'default' ? (currentPlatforms()[0] || 'linkedin') : currentTab;
      const brand = state.brands.find((b) => String(b.id) === String(brandId));
      const mediaUrl = attachedImage ? attachedImage.url || null : null;
      previewBody.appendChild(renderPostPreview(platform, { copy: getActiveCopy(), mediaUrl, brand }));
      // item 6: faint "first comment" bubble under the feed preview when set
      if (typeof firstCommentEnabled !== 'undefined' && firstCommentEnabled && firstCommentInput.value.trim()) {
        previewBody.appendChild(el('div', { class: 'feed-preview-first-comment' }, [
          el('span', { class: 'feed-preview-first-comment-label' }, 'first comment'),
          el('span', {}, firstCommentInput.value.trim()),
        ]));
      }
    }
    previewToggleBtn.classList.toggle('active-tag', previewOpen);
    previewToggleBtn.addEventListener('click', () => {
      previewOpen = !previewOpen;
      localStorage.setItem('pd_composer_preview_open', previewOpen ? '1' : '0');
      previewToggleBtn.classList.toggle('active-tag', previewOpen);
      refreshPreview();
    });

    function refreshActiveEditor() {
      refreshCopyHeader();
      refreshPreview();
      updateSummary();
    }

    function renderFieldsEditor() {
      fieldsEditorHost.innerHTML = '';
      if (currentTab === 'reddit') {
        const fields = platformFieldsByPlatform.reddit || (platformFieldsByPlatform.reddit = {});
        const editor = redditFieldsEditor(fields);
        const bodyArea = editor.querySelector ? editor.querySelector('textarea') : null;
        if (bodyArea) bodyArea.addEventListener('input', () => { refreshActiveEditor(); });
        fieldsEditorHost.appendChild(editor);
      } else if (currentTab === 'blog') {
        const fields = platformFieldsByPlatform.blog || (platformFieldsByPlatform.blog = {});
        fieldsEditorHost.appendChild(blogFieldsEditor(fields, mediaFiles));
      } else if (currentTab === 'tiktok') {
        const fields = platformFieldsByPlatform.tiktok || (platformFieldsByPlatform.tiktok = {});
        fieldsEditorHost.appendChild(tiktokFieldsEditor(fields));
      }
    }

    function renderCopyTabs() {
      copyTabsRow.innerHTML = '';
      const platforms = currentPlatforms();
      if (currentTab !== 'default' && !platforms.includes(currentTab)) currentTab = 'default';
      const tabDefs = [{ key: 'default', label: 'Default' }, ...platforms.map((p) => ({ key: p, label: p }))];
      for (const t of tabDefs) {
        copyTabsRow.appendChild(
          el('button', {
            type: 'button',
            class: t.key === currentTab ? 'active' : '',
            title: t.key === 'default' ? 'Shared copy' : t.label,
            onclick: () => {
              currentTab = t.key;
              renderCopyTabs();
              syncCopyTextareaVisibility();
              renderFieldsEditor();
              refreshActiveEditor();
              updateContentTypeSuggestion();
            },
          }, t.key === 'default' ? 'Default' : [platformIcon(t.key, { size: 13 }), ` ${t.label}`])
        );
      }
    }

    function syncCopyTextareaVisibility() {
      // Reddit's body lives in redditFieldsEditor's own textarea, not the
      // shared copy box, but everything else (including blog's markdown
      // body) uses the shared textarea.
      copyTextarea.hidden = currentTab === 'reddit';
      copyTextarea.value = currentTab === 'reddit' ? '' : getActiveCopy();
    }
    copyTextarea.addEventListener('input', () => {
      setActiveCopy(copyTextarea.value);
      refreshActiveEditor();
    });

    aiMsg.innerHTML = '';
    if (pendingRedraft && redraftMatchingAcct) {
      const framing = `Write a fresh take on this proven post - same idea, new angle and hook (don't copy it verbatim):\n\n${pendingRedraft.copy}`;
      draftsByPlatform.default = framing;
    }
    if (qcPrefill && qcPrefill.copy) {
      draftsByPlatform.default = qcPrefill.copy;
      qcPrefill = null;
    }

    const providerSwitchEl = providerSwitch(currentProvider, (v) => {
      currentProvider = v;
      sessionDraftProvider = v;
    });

    async function runAiDraft() {
      aiMsg.innerHTML = '';
      compareHost.innerHTML = '';
      const platforms = currentPlatforms();
      const ideaText = (draftsByPlatform.default || '').trim();
      if (!ideaText || !platforms.length) {
        aiMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one account and type an idea in Default first.'));
        return;
      }
      try {
        const tp = await findToneProfileId(brandId, toneSelect.value);
        const result = await api('/api/draft', {
          method: 'POST',
          body: { idea_text: ideaText, brand_id: Number(brandId), tone_profile_id: tp, platforms, provider: currentProvider },
        });
        Object.assign(draftsByPlatform, result.drafts);
        for (const p of Object.keys(result.drafts || {})) dirtyPlatforms.delete(p); // fresh AI output tracks Default again until hand-edited
        syncCopyTextareaVisibility();
        renderFieldsEditor();
        refreshActiveEditor();
        aiMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, `Drafts populated. Scrub applied: ${result.scrub_applied.join(', ') || 'none'}`));
      } catch (err) {
        aiMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, `AI drafting unavailable: ${err.message}`));
      }
    }

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
            for (const p of Object.keys(drafts)) dirtyPlatforms.delete(p);
            syncCopyTextareaVisibility();
            refreshActiveEditor();
            aiMsg.innerHTML = '';
            aiMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, `Filled composer fields from ${label}.`));
          },
        }, 'Use this')
      );
      return col;
    }

    const draftBtn = el('button', { class: 'button primary sm', type: 'button', onclick: runAiDraft }, 'Draft with AI');
    const compareBtn = el('button', {
      class: 'button secondary sm', type: 'button',
      onclick: async () => {
        aiMsg.innerHTML = '';
        compareHost.innerHTML = '';
        const platforms = currentPlatforms();
        const ideaText = (draftsByPlatform.default || '').trim();
        if (!ideaText || !platforms.length) {
          aiMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Pick at least one account and type an idea in Default first.'));
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
          for (const p of AI_PROVIDERS) grid.appendChild(compareColumn(p.label, p.value, cmp?.[p.value]));
          compareHost.appendChild(grid);
        } catch (err) {
          compareHost.innerHTML = '';
          compareHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Compare unavailable: ${err.message}`));
        }
      },
    }, 'Compare both');

    copyToolbarRow.append(
      el('label', {}, 'Tone'), toneSelect, draftBtn, compareBtn, providerSwitchEl
    );
    copyHeaderRow.append(el('div', {}, ''), copyCountsEl);

    // ---- AI status pill (moved from the old "Draft with AI" card header) ----
    const aiStatusHost = el('div', { class: 'ai-status-host', style: 'margin-bottom:6px;' });
    async function refreshAiStatus() {
      aiStatusHost.innerHTML = '';
      let status;
      try {
        status = await api('/api/ai/status');
      } catch {
        return;
      }
      function appendHint(text) {
        aiStatusHost.appendChild(el('div', { class: 'hint', style: 'margin-top:6px;color:var(--muted);' }, text));
      }
      function startProviderLogin(provider, noun) {
        return async () => {
          try {
            await api('/api/ai/login', { method: 'POST', body: { provider } });
            appendHint(`A Terminal window opened to sign you in to ${noun}. Approve in your browser if prompted, then click Recheck.`);
          } catch (err) {
            toast(`Could not start login: ${err.message}`, 'error');
          }
        };
      }
      function providerStatusRow(provider, s = {}) {
        const installed = s.installed === true;
        const loggedIn = s.loggedIn === true;
        const unknownLogin = installed && s.loggedIn == null;
        const label = provider === 'codex' ? 'Codex' : 'Claude';
        const pillText =
          provider === 'codex'
            ? loggedIn ? 'Codex: logged in' : unknownLogin ? 'Codex: installed' : installed ? 'Codex: not logged in' : 'Codex CLI not found'
            : loggedIn ? 'Claude: logged in' : installed ? 'Claude: not logged in' : 'Claude CLI not found';
        const pillClass = loggedIn ? 'ai-pill-ok' : 'ai-pill-warn';
        const row = el('div', { class: 'ai-status-row' }, [el('span', { class: `ai-pill ${pillClass}` }, pillText)]);
        const showLogin = installed && !loggedIn;
        if (showLogin) row.appendChild(el('button', { class: 'btn-secondary', type: 'button', onclick: startProviderLogin(provider, label) }, `Log in to ${label}`));
        row.appendChild(el('button', { class: 'btn-secondary', type: 'button', onclick: refreshAiStatus }, 'Recheck'));
        return row;
      }
      aiStatusHost.appendChild(providerStatusRow('claude', status.claude || {}));
      aiStatusHost.appendChild(providerStatusRow('codex', status.codex || {}));
    }
    refreshAiStatus();

    const copyCard = el('div', { class: 'cv3-copy-card' }, [
      copyTabsRow,
      copyToolbarRow,
      aiStatusHost,
      copyHeaderRow,
      copyTextarea,
      fieldsEditorHost,
      aiMsg,
      compareHost,
      previewToggleBtn,
      previewBody,
    ]);

    // =========================================================
    // Copy-assist (headlines / hashtags / alt text) + examples-grounding -
    // these are supplementary drafting aids, live in Advanced.
    // =========================================================
    function copyAssistPanel() {
      const box = el('div', { class: 'copy-assist-box card' });
      box.appendChild(el('h2', {}, 'Copy assist'));
      const btnRow = el('div', { class: 'toolbar', style: 'margin-top:8px;margin-bottom:4px;' });
      const msg = el('div');
      const resultHost = el('div');
      async function runAssist(mode) {
        msg.innerHTML = '';
        resultHost.innerHTML = '';
        try {
          const tp = await findToneProfileId(brandId, toneSelect.value).catch(() => null);
          const platforms = currentPlatforms();
          const res = await api('/api/copy-assist', {
            method: 'POST',
            body: {
              mode,
              idea_text: draftsByPlatform.default || '',
              copy: getActiveCopy(),
              brand_id: Number(brandId),
              tone_profile_id: tp,
              platforms,
              image_path: attachedImage?.path,
              provider: currentProvider,
            },
          });
          if (res.result?.headlines?.length) {
            const chipRow = el('div', { class: 'chip-row' });
            for (const h of res.result.headlines) chipRow.appendChild(el('button', { class: 'chip-btn', onclick: () => { setActiveCopy(h); syncCopyTextareaVisibility(); refreshActiveEditor(); } }, h));
            resultHost.appendChild(el('div', { style: 'margin-top:6px;' }, [el('div', { style: 'font-size:11px;color:var(--muted);' }, 'Headlines (click to insert):'), chipRow]));
          }
          if (res.result?.hashtags) {
            const tags = res.result.hashtags[currentTab] || Object.values(res.result.hashtags).flat();
            if (tags?.length) {
              const chipRow = el('div', { class: 'chip-row' });
              for (const t of tags) {
                chipRow.appendChild(el('button', { class: 'chip-btn', onclick: () => { const cur = getActiveCopy(); setActiveCopy(cur + (cur && !cur.endsWith(' ') ? ' ' : '') + t); syncCopyTextareaVisibility(); refreshActiveEditor(); } }, t));
              }
              resultHost.appendChild(el('div', { style: 'margin-top:6px;' }, [el('div', { style: 'font-size:11px;color:var(--muted);' }, 'Hashtags (click to append):'), chipRow]));
            }
          }
          if (res.result?.alt_text) {
            resultHost.appendChild(
              el('div', { style: 'margin-top:6px;' }, [
                el('div', { style: 'font-size:11px;color:var(--muted);' }, 'Alt text:'),
                el('div', { style: 'font-size:12px;' }, res.result.alt_text),
                el('button', { onclick: () => { if (attachedImage) { attachedImage.altText = res.result.alt_text; toast('Alt text set.'); } } }, 'Use as alt text'),
              ])
            );
          }
          if (res.scrub_applied?.length) msg.appendChild(el('div', { class: 'msg-banner msg-ok' }, `Scrub applied: ${res.scrub_applied.join(', ')}`));
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
      box.append(btnRow, msg, resultHost);
      return box;
    }

    function examplesPanel() {
      const platform = currentTab === 'default' ? (currentPlatforms()[0] || null) : currentTab;
      const container = el('div', { class: 'card' });
      container.appendChild(el('h2', {}, `Examples to match${platform ? ` (${platform})` : ''}`));
      if (!platform) {
        container.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'Select an account or a platform tab first.'));
        return container;
      }
      container.appendChild(
        el('div', { style: 'color:var(--muted);font-size:11px;margin:2px 0 10px;' },
          'Saved examples ground the Copy assist buttons above for this brand + platform.')
      );
      const chipsHost = el('div', { class: 'examples-chip-row' });
      container.appendChild(chipsHost);
      async function reloadExamples() {
        chipsHost.innerHTML = '';
        if (!brandId) return;
        try {
          const qs = new URLSearchParams({ brand_id: brandId, platform });
          const list = await api(`/api/examples?${qs.toString()}`);
          if (!list.length) { chipsHost.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;' }, 'No saved examples yet.')); return; }
          for (const ex of list) {
            const text = ex.text || '';
            chipsHost.appendChild(
              el('span', { class: 'example-chip' }, [
                el('span', { class: 'example-chip-text' }, text.length > 60 ? `${text.slice(0, 60)}…` : text || '(empty)'),
                el('button', { class: 'example-chip-x', title: 'Delete example', onclick: async () => { try { await api(`/api/examples/${ex.id}`, { method: 'DELETE' }); reloadExamples(); } catch (err) { toast(err.message, 'error'); } } }, '×'),
              ])
            );
          }
        } catch (err) {
          chipsHost.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not load examples: ${err.message}`));
        }
      }
      reloadExamples();
      const pasteArea = el('textarea', { rows: '3', placeholder: 'Paste an example post that nails the style/format…' });
      const pasteMsg = el('div');
      container.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Paste example text'), pasteArea]));
      container.appendChild(
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
      container.appendChild(pasteMsg);
      const fileInput = el('input', { type: 'file', accept: 'image/*' });
      const uploadMsg = el('div');
      const previewBox = el('div');
      container.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Upload screenshot'), fileInput]));
      container.appendChild(
        el('div', { class: 'toolbar' }, [
          el('button', {
            onclick: async () => {
              uploadMsg.innerHTML = '';
              previewBox.innerHTML = '';
              if (!fileInput.files.length) { uploadMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Choose a screenshot first.')); return; }
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
                    class: 'primary', style: 'margin-top:8px;',
                    onclick: async () => {
                      if (!brandId) { uploadMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, 'Select a brand first.')); return; }
                      try {
                        await api('/api/examples', { method: 'POST', body: { brand_id: Number(brandId), platform, source: 'screenshot', text: extracted.text, image_path: extracted.image_path } });
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
      container.appendChild(uploadMsg);
      container.appendChild(previewBox);
      return container;
    }

    // =========================================================
    // Image request options - part of Advanced (the strip's "Request image"
    // tile fires with these settings).
    // =========================================================
    function imageOptsCard() {
      const box = el('div', { class: 'card' });
      box.appendChild(el('h2', {}, 'Image request options'));
      box.appendChild(
        el('div', { class: 'composer-grid' }, [
          el('div', { class: 'field-row' }, [el('label', {}, 'Variant count'), variantCountSelect]),
          el('div', { class: 'field-row' }, [el('label', {}, 'Size / orientation'), sizeHintSelect]),
          el('div', { class: 'field-row' }, [el('label', {}, 'Type'), typeHintSelect]),
        ])
      );
      box.appendChild(imageReqMsg);
      return box;
    }

    // =========================================================
    // Sticky action bar - Save draft / Save & approve / summary / Advanced toggle
    // =========================================================
    const savedMsg = el('div');
    const summaryEl = el('span', { class: 'cv3-summary' });
    function updateSummary() {
      const platforms = currentPlatforms();
      if (!platforms.length) { summaryEl.textContent = 'Select at least one account.'; return; }
      const parts = platforms.map((p) => {
        const limit = textLimitFor(p);
        const len = (p === 'reddit' ? (platformFieldsByPlatform.reddit?.body || '') : (draftsByPlatform[p] || draftsByPlatform.default || '')).length;
        return limit == null ? `${p}: ${len}` : `${p}: ${len}/${limit}${len > limit ? ' ⚠' : ''}`;
      });
      summaryEl.textContent = parts.join('  ·  ');
    }

    async function createPostsForSelection(publishAtOverride) {
      const platforms = [...selectedAccounts].map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
      if (!platforms.length) return [];
      const media = attachedImage ? [{ path: attachedImage.path, altText: attachedImage.altText || '' }] : [];
      const created = [];
      for (const acct of platforms) {
        const fields = platformFieldsByPlatform[acct.platform] || {};
        const copy = acct.platform === 'reddit' ? (fields.body || '') : (draftsByPlatform[acct.platform] || draftsByPlatform.default || '');
        const row = await api('/api/posts', {
          method: 'POST',
          body: {
            brand_id: Number(brandId),
            account_id: acct.id,
            platform: acct.platform,
            copy,
            platform_fields: fields,
            content_type: contentType || null,
            media,
            first_comment: firstCommentEnabled && firstCommentInput.value.trim() ? firstCommentInput.value.trim() : null,
            publish_at: publishAtOverride !== undefined
              ? publishAtOverride
              : (publishAtInput.value ? new Date(publishAtInput.value).toISOString() : null),
          },
        });
        created.push(row);
      }
      const tagIds = [...selectedTagIds, ...(selectedCampaignId ? [selectedCampaignId] : [])];
      if (tagIds.length) {
        for (const row of created) {
          try {
            await api(`/api/posts/${row.id}/tags`, { method: 'PUT', body: { tag_ids: tagIds } });
          } catch (err) {
            tagsMsg.innerHTML = '';
            tagsMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, `Could not tag post #${row.id}: ${err.message}`));
          }
        }
      }
      return created;
    }

    const saveBtn = el('button', {
      class: 'button primary md', type: 'button',
      onclick: async () => {
        savedMsg.innerHTML = '';
        const created = await createPostsForSelection();
        if (!created.length) return;
        createdPostIds = created.map((p) => p.id);
        savedMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Draft(s) saved. Go to Calendar to approve.'));
      },
    }, 'Save draft');
    const saveApproveBtn = el('button', {
      class: 'button secondary md', type: 'button',
      onclick: async () => {
        savedMsg.innerHTML = '';
        const created = await createPostsForSelection();
        if (!created.length) return;
        createdPostIds = created.map((p) => p.id);
        for (const row of created) {
          try {
            await api(`/api/posts/${row.id}`, { method: 'PATCH', body: { status: 'approved' } });
          } catch (err) {
            savedMsg.appendChild(el('div', { class: 'msg-banner msg-error' }, `Saved but could not approve #${row.id}: ${err.message}`));
          }
        }
        savedMsg.appendChild(el('div', { class: 'msg-banner msg-ok' }, 'Saved and approved.'));
      },
    }, 'Save & approve');

    let advancedOpen = localStorage.getItem('pd_composer_advanced_open') === '1';
    const advancedToggleBtn = el('button', {
      class: 'button ghost sm cv3-advanced-toggle', type: 'button',
    }, advancedOpen ? 'Advanced ▾' : 'Advanced ▸');
    const advancedBody = el('div', { class: 'cv3-advanced-body' });
    advancedBody.hidden = !advancedOpen;
    function renderAdvanced() {
      advancedBody.innerHTML = '';
      advancedBody.appendChild(imageOptsCard());
      advancedBody.appendChild(copyAssistPanel());
      advancedBody.appendChild(examplesPanel());
    }
    advancedToggleBtn.addEventListener('click', () => {
      advancedOpen = !advancedOpen;
      localStorage.setItem('pd_composer_advanced_open', advancedOpen ? '1' : '0');
      advancedBody.hidden = !advancedOpen;
      advancedToggleBtn.textContent = advancedOpen ? 'Advanced ▾' : 'Advanced ▸';
      if (advancedOpen) renderAdvanced();
    });
    if (advancedOpen) renderAdvanced();

    const actionBar = el('div', { class: 'cv3-actionbar' }, [
      saveBtn, saveApproveBtn, summaryEl, advancedToggleBtn,
    ]);

    // =========================================================
    // Assemble the page, top to bottom, per spec.
    // =========================================================
    body.append(
      accountsRow,
      manageHost,
      copyCard,
      mediaStrip,
      detailsLine,
      scheduleLine,
      savedMsg,
      queueMsg,
      imageReqMsg,
      actionBar,
      el('div', { class: 'cv3-advanced' }, [advancedBody]),
    );

    renderCopyTabs();
    syncCopyTextareaVisibility();
    renderFieldsEditor();
    refreshActiveEditor();
    updateContentTypeSuggestion();
    updateSummary();

    // ---- B18b: finish the redraft handoff - stage the original as an
    // example (best-effort grounding) then run Draft with AI.
    if (pendingRedraft && redraftMatchingAcct) {
      aiMsg.appendChild(el('div', { class: 'msg-banner', style: 'color:var(--muted);' }, 'Redrafting your top post - fresh angle incoming…'));
      try {
        await api('/api/examples', {
          method: 'POST',
          body: { brand_id: Number(brandId), platform: pendingRedraft.platform, source: 'redraft', text: pendingRedraft.copy },
        });
      } catch {
        // best-effort only - the framing prompt already carries the original
      }
      await runAiDraft();
    }
  }

  brandSelect.onchange = () => {
    setStickyBrand(brandSelect.value);
    selectedAccounts = new Set();
    currentTab = 'default';
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
  // Never render an empty page: with no prefill and no sticky brand yet
  // (fresh install / cleared storage), default to the first brand.
  const effectiveBrand =
    prefillBrand ||
    getStickyBrand() ||
    (state.brands.length ? String(state.brands[0].id) : '');
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
// R6 fix: with many/long category labels (e.g. Ops "Posts by status", 8
// status names), horizontal centered labels collide with their neighbors.
// Past ~5 bars, or when any label is long, rotate the axis labels -40deg
// (anchor 'end') and truncate long ones with an SVG <title> tooltip carrying
// the full text - readable without overlap, full label still discoverable.
function svgBarChart(bars, { width = 420, height = 140, color = '#C8902A' } = {}) {
  const pad = 24;
  const maxLabelLen = Math.max(0, ...bars.map((b) => String(b.label).length));
  const rotateLabels = bars.length > 5 || maxLabelLen > 8;
  const bottomPad = rotateLabels ? 46 : pad;
  const max = Math.max(1, ...bars.map((b) => b.value));
  const barWidth = bars.length ? (width - pad * 2) / bars.length : 0;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height + (rotateLabels ? bottomPad - pad : 0)}`);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', height + (rotateLabels ? bottomPad - pad : 0));

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

    const fullLabel = String(b.label);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('font-size', '10');
    label.setAttribute('fill', 'var(--muted, #888)');
    if (rotateLabels) {
      const shown = fullLabel.length > 12 ? fullLabel.slice(0, 11) + '…' : fullLabel;
      label.setAttribute('x', x + w / 2);
      label.setAttribute('y', height - pad + 10);
      label.setAttribute('text-anchor', 'end');
      label.setAttribute('transform', `rotate(-40 ${x + w / 2} ${height - pad + 10})`);
      label.textContent = shown;
      if (shown !== fullLabel) {
        const title = document.createElementNS(ns, 'title');
        title.textContent = fullLabel;
        label.appendChild(title);
      }
    } else {
      label.setAttribute('x', x + w / 2);
      label.setAttribute('y', height - pad + 12);
      label.setAttribute('text-anchor', 'middle');
      label.textContent = fullLabel;
    }
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
  view.classList.add('view-default');

  // B17a: campaign selector - re-fetches the whole rollup scoped to a single
  // campaign tag via ?tag_id=, so every section below (totals, WoW, top10)
  // reads as "this campaign's numbers" rather than the account-wide ones.
  await loadAllTags();
  const campaigns = allTagsCache.filter((t) => t.kind === 'campaign');
  const campaignSelect = el('select', {}, [
    el('option', { value: '' }, 'All (no campaign filter)'),
    ...campaigns.map((c) => el('option', { value: c.id }, c.name)),
  ]);
  const importBtn = el('button', { class: 'button secondary sm', type: 'button', onclick: () => openMetricsImportModal(() => renderAnalyticsBody(campaignSelect.value)) }, 'Import analytics');
  const analyticsBody = el('div');
  // R1: title -> actions; export/import next, campaign filter (the only
  // narrowing filter on this view) rightmost.
  view.appendChild(pageHeader('Analytics', importBtn, el('span', {}, 'Campaign:'), campaignSelect));
  view.appendChild(analyticsBody);
  campaignSelect.onchange = () => renderAnalyticsBody(campaignSelect.value);
  await renderAnalyticsBody('');

  async function renderAnalyticsBody(tagId) {
    analyticsBody.innerHTML = '';
    const qs = tagId ? `?tag_id=${encodeURIComponent(tagId)}` : '';
    const data = await api(`/api/analytics${qs}`);
    if (tagId) {
      const campaign = tagById(tagId);
      const banner = inlineBanner([el('strong', {}, 'Campaign performance'), ` — scoped to "${campaign?.name || tagId}"`], 'info');
      banner.style.borderLeft = `4px solid ${campaign?.color || 'var(--gold)'}`;
      analyticsBody.appendChild(banner);
    }
    renderAnalyticsSections(analyticsBody, data);
  }
}

// ---- Redraft-the-winner (B18b) ----
// Stashes the original post's copy + brand/platform in sessionStorage and
// hands off to the Composer (same sessionStorage-handoff pattern as B9's
// Home quick-create bar), which auto-runs Draft with AI with a "fresh take
// on this proven post" framing prompt through the existing /api/draft path.
function redraftButton(p) {
  return el('button', {
    class: 'button ghost sm redraft-btn',
    type: 'button',
    title: 'Draft a fresh take on this proven post',
    onclick: () => {
      sessionStorage.setItem(
        'pd_composer_redraft',
        JSON.stringify({ brand_id: p.brand_id, platform: p.platform, copy: p.copy || '' })
      );
      setStickyBrand(String(p.brand_id));
      location.hash = '#/composer';
    },
  }, 'Redraft');
}

// Item 6 (2026-07-19 feedback): inline quick-entry for the metrics-due list
// - impressions/comments/shares mirror the 3 most prominent fields on the
// full manual metrics form (renderPostDetail's `fields` list starts with
// impressions/comments/shares; saves/profile_visits/follows/dms/leads stay
// full-form-only). Enter in any field or the checkmark button both save via
// the SAME POST /api/posts/:id/metrics route the full form uses - no new
// endpoint. On success the row is removed from the due list in place and a
// toast confirms, matching the rest of the app's save feedback pattern.
function metricsDueRow(p, dueContainer) {
  const impressionsInput = el('input', { type: 'number', class: 'sm', placeholder: 'impressions', style: 'width:90px;' });
  const commentsInput = el('input', { type: 'number', class: 'sm', placeholder: 'comments', style: 'width:80px;' });
  const sharesInput = el('input', { type: 'number', class: 'sm', placeholder: 'shares', style: 'width:70px;' });
  const rowMsg = el('div', { style: 'font-size:11px;' });
  const saveBtn = el('button', { class: 'button primary sm', type: 'button', title: 'Save metrics' }, '✓');

  async function save() {
    const body = {};
    if (impressionsInput.value !== '') body.impressions = Number(impressionsInput.value);
    if (commentsInput.value !== '') body.comments = Number(commentsInput.value);
    if (sharesInput.value !== '') body.shares = Number(sharesInput.value);
    if (!Object.keys(body).length) {
      rowMsg.innerHTML = '';
      rowMsg.appendChild(inlineBanner('Enter at least one value first.', 'error'));
      return;
    }
    saveBtn.disabled = true;
    try {
      await api(`/api/posts/${p.id}/metrics`, { method: 'POST', body });
      toast(`Metrics saved for #${p.id}.`);
      row.remove();
    } catch (err) {
      saveBtn.disabled = false;
      rowMsg.innerHTML = '';
      rowMsg.appendChild(inlineBanner(`Could not save: ${err.message}`, 'error'));
    }
  }
  saveBtn.onclick = save;
  for (const input of [impressionsInput, commentsInput, sharesInput]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
  }

  const row = el('div', { style: 'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border);' }, [
    el('div', { style: 'display:flex;flex-direction:column;gap:2px;min-width:180px;' }, [
      el('a', { href: `#/post/${p.id}` }, [platformIcon(p.platform, { size: 12 }), ` #${p.id} - ${brandName(p.brand_id)} - ${p.platform}`]),
      el('span', { style: 'color:var(--muted);font-size:11px;' }, `published ${fmtDate(p.updated_at)}`),
    ]),
    el('div', { style: 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;' }, [
      impressionsInput, commentsInput, sharesInput, saveBtn,
    ]),
    rowMsg,
  ]);
  return row;
}

function renderAnalyticsSections(view, data) {
  if (data.metrics_due.length) {
    const due = el('div', { class: 'card' });
    due.appendChild(el('h2', {}, `Metrics due (${data.metrics_due.length})`));
    due.appendChild(el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:6px;' },
      'Published posts older than 48h with no metrics entered yet.'));
    for (const p of data.metrics_due) {
      due.appendChild(metricsDueRow(p, due));
    }
    due.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;margin-top:8px;text-align:center;' }, `— end of list (${data.metrics_due.length}) —`));
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
          el('div', {}, [el('a', { href: `#/post/${p.id}` }, `#${p.id} ${p.platform}`), ` - ${p.total_impressions} impressions`, redraftButton(p)])
        );
      }
      const leadCol = el('div', {}, [el('h3', {}, 'Top 10 by leads')]);
      for (const p of brand.top10_by_leads) {
        leadCol.appendChild(
          el('div', {}, [el('a', { href: `#/post/${p.id}` }, `#${p.id} ${p.platform}`), ` - ${p.total_leads} leads`, redraftButton(p)])
        );
      }
      top10.append(impCol, leadCol);
      bodyHost.appendChild(top10);
    }
    renderTab();

    view.appendChild(card);
  }
}

// ---------------- Metrics import (item 7, 2026-07-19 feedback) ----------------
// Analytics -> "Import analytics": platform/brand + a CSV export (LinkedIn or
// Meta/Facebook) -> POST /api/metrics-import/preview (no writes) -> operator
// confirms/corrects matches -> POST /api/metrics-import/apply (writes). Both
// routes already existed server-side (src/metrics-import.js) with no UI.
function openMetricsImportModal(onApplied) {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card modal-import' });
  overlay.appendChild(card);
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);

  card.appendChild(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Import analytics'),
      el('button', { class: 'modal-close', title: 'Close', type: 'button', onclick: close }, '✕'),
    ])
  );

  const platformSelect = el('select', {}, [
    el('option', { value: '' }, 'Select platform…'),
    ...['linkedin', 'facebook', 'twitter', 'instagram', 'reddit', 'tiktok', 'youtube', 'threads'].map((p) => el('option', { value: p }, p)),
  ]);
  const brandSelect = el('select', {}, [
    el('option', { value: '' }, 'All brands'),
    ...state.brands.map((b) => el('option', { value: b.id }, b.name)),
  ]);
  const fileInput = el('input', { type: 'file', accept: '.csv,text/csv' });
  const previewBtn = el('button', { class: 'button primary md', type: 'button' }, 'Preview');
  const formMsg = el('div');
  card.append(
    el('div', { class: 'field-row' }, [el('label', {}, 'Platform'), platformSelect]),
    el('div', { class: 'field-row' }, [el('label', {}, 'Brand'), brandSelect]),
    el('div', { class: 'field-row' }, [el('label', {}, 'CSV export'), fileInput]),
    el('div', { style: 'color:var(--muted);font-size:11px;margin:-4px 0 8px;' }, 'Export as CSV from LinkedIn (Analytics -> Content) or Meta Business Suite (Insights -> Export). XLSX is not supported - export/save as CSV.'),
    el('div', { class: 'toolbar' }, [previewBtn]),
    formMsg
  );

  const previewHost = el('div');
  card.appendChild(previewHost);

  previewBtn.addEventListener('click', async () => {
    formMsg.innerHTML = '';
    previewHost.innerHTML = '';
    if (!platformSelect.value) { formMsg.appendChild(inlineBanner('Pick a platform first.', 'error')); return; }
    if (!fileInput.files.length) { formMsg.appendChild(inlineBanner('Choose a CSV file first.', 'error')); return; }
    previewBtn.disabled = true;
    try {
      const fd = new FormData();
      fd.append('file', fileInput.files[0]);
      fd.append('platform', platformSelect.value);
      if (brandSelect.value) fd.append('brand_id', brandSelect.value);
      const res = await api('/api/metrics-import/preview', { method: 'POST', body: fd });
      renderImportPreview(res);
    } catch (err) {
      formMsg.appendChild(inlineBanner(`Could not parse file: ${err.message}`, 'error'));
    } finally {
      previewBtn.disabled = false;
    }
  });

  function renderImportPreview(res) {
    previewHost.innerHTML = '';
    previewHost.appendChild(
      el('div', { style: 'color:var(--muted);font-size:12px;margin:8px 0;' },
        `${res.total_rows} row(s) parsed, ${res.skipped_rows} skipped (no parseable date).`)
    );
    if (!res.matches.length) {
      previewHost.appendChild(emptyState('No rows to import.'));
      return;
    }
    const table = el('table', { class: 'metrics-import-table' });
    table.appendChild(
      el('tr', {}, [
        el('th', {}, ''),
        el('th', {}, 'Date'),
        el('th', {}, 'Metrics'),
        el('th', {}, 'Matched post'),
        el('th', {}, 'Confidence'),
      ])
    );
    // Per-row state: whether it's included in the apply, and (for ambiguous
    // rows) which candidate post the operator picked.
    const rowStates = res.matches.map((m) => ({
      match: m,
      included: m.confidence !== 'none',
      chosenPostId: m.confidence === 'ambiguous' ? null : m.post_id,
    }));

    function metricsSummary(row) {
      const parts = [];
      for (const f of ['impressions', 'clicks', 'likes', 'comments', 'shares', 'reach', 'results', 'engagement_rate']) {
        if (row[f] != null && row[f] !== '') parts.push(`${f}: ${row[f]}`);
      }
      return parts.join(', ') || '(no metrics parsed)';
    }

    for (const state_ of rowStates) {
      const m = state_.match;
      const checkbox = el('input', { type: 'checkbox' });
      checkbox.checked = state_.included;
      checkbox.disabled = m.confidence === 'none' && !m.post_id;
      checkbox.addEventListener('change', () => { state_.included = checkbox.checked; });

      let matchCell;
      if (m.confidence === 'ambiguous' && m.candidates?.length) {
        const candSelect = el('select', {}, [
          el('option', { value: '' }, 'Pick a post…'),
          ...m.candidates.map((c) => el('option', { value: c.post_id }, `#${c.post_id} - ${c.post_copy_snippet || '(no copy)'}`)),
        ]);
        candSelect.addEventListener('change', () => {
          state_.chosenPostId = candSelect.value ? Number(candSelect.value) : null;
          state_.included = !!state_.chosenPostId;
          checkbox.checked = state_.included;
        });
        matchCell = candSelect;
      } else if (m.post_id) {
        matchCell = el('span', {}, `#${m.post_id} - ${m.post_copy_snippet || '(no copy)'}`);
      } else {
        matchCell = el('span', { style: 'color:var(--muted);' }, m.reason === 'unparseable_date' ? 'no date' : 'no match');
      }

      const confBadge = el('span', { class: `pill confidence-${m.confidence}` }, m.confidence);

      table.appendChild(
        el('tr', {}, [
          el('td', {}, checkbox),
          el('td', {}, m.row.date || '-'),
          el('td', { style: 'font-size:12px;' }, metricsSummary(m.row)),
          el('td', { style: 'font-size:12px;' }, matchCell),
          el('td', {}, confBadge),
        ])
      );
    }
    previewHost.appendChild(table);

    const applyMsg = el('div');
    const applyBtn = el('button', { class: 'button primary md', type: 'button' }, `Apply ${rowStates.filter((s) => s.included).length} rows`);
    function refreshApplyCount() {
      applyBtn.textContent = `Apply ${rowStates.filter((s) => s.included && s.chosenPostId).length} rows`;
    }
    table.addEventListener('change', refreshApplyCount);
    refreshApplyCount();

    applyBtn.addEventListener('click', async () => {
      const decisions = rowStates
        .filter((s) => s.included && s.chosenPostId)
        .map((s) => {
          const row = s.match.row;
          const metrics = { notes: '' };
          for (const f of ['impressions', 'comments', 'shares']) {
            if (row[f] != null && row[f] !== '') metrics[f] = row[f];
          }
          const extra = {};
          for (const f of ['likes', 'clicks', 'reach', 'results', 'engagement_rate']) {
            if (row[f] != null && row[f] !== '') extra[f] = row[f];
          }
          if (Object.keys(extra).length) metrics.extra = extra;
          return { post_id: s.chosenPostId, metrics };
        });
      if (!decisions.length) {
        applyMsg.innerHTML = '';
        applyMsg.appendChild(inlineBanner('No confirmed rows to apply - check at least one matched row.', 'error'));
        return;
      }
      applyBtn.disabled = true;
      try {
        const res2 = await api('/api/metrics-import/apply', { method: 'POST', body: { decisions } });
        toast(`Imported ${res2.applied} row(s) of metrics.`);
        close();
        if (typeof onApplied === 'function') onApplied();
      } catch (err) {
        applyMsg.innerHTML = '';
        applyMsg.appendChild(inlineBanner(`Could not apply: ${err.message}`, 'error'));
        applyBtn.disabled = false;
      }
    });
    previewHost.append(el('div', { class: 'toolbar', style: 'margin-top:10px;' }, [applyBtn]), applyMsg);
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
  view.classList.add('view-default');
  // R1: no filters/date-range on this view by design - it's a read-only,
  // whole-account stats glance, not scoped per-brand.
  view.appendChild(pageHeader('Ops Stats'));

  let data;
  try {
    data = await api('/api/usage');
  } catch (err) {
    view.appendChild(inlineBanner(`Could not load usage stats: ${err.message}`, 'error'));
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

  function barCard(title, bars) {
    const hasData = bars.some((b) => b.value > 0);
    return el('div', { class: 'card' }, [
      el('h2', {}, title),
      hasData ? svgBarChart(bars) : emptyState('No data yet.'),
    ]);
  }

  view.appendChild(barCard('Posts by status', Object.entries(data.posts_by_status || {}).map(([label, value]) => ({ label, value }))));
  view.appendChild(barCard('Posts by brand', (data.posts_by_brand || []).map((b) => ({ label: b.brand_name || `brand ${b.brand_id}`, value: b.count }))));
  view.appendChild(barCard('Posts by platform', (data.posts_by_platform || []).map((p) => ({ label: p.platform, value: p.count }))));
  view.appendChild(barCard('Content-type mix', (data.content_type_mix || []).map((c) => ({ label: c.content_type, value: c.count }))));

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

// Renders a checkbox as a real styled toggle switch (D2 R8: one switch
// pattern for every on/off setting, not a bare checkbox). The ON/OFF text
// stays alongside the switch (color is never the only state signal, R7).
function settingsToggleRow(checked, label) {
  const cb = el('input', { type: 'checkbox', class: 'switch' });
  cb.checked = checked;
  const stateEl = el('span', { class: `switch-state ${checked ? 'on' : 'off'}` }, checked ? 'ON' : 'OFF');
  const row = el('label', { class: 'settings-toggle-row switch-row' }, [
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

function settingsHint(text) {
  return el('div', { class: 'settings-hint' }, text);
}

async function renderSettings(view) {
  view.innerHTML = '';
  view.classList.add('view-narrow');
  view.appendChild(pageHeader('Settings'));

  let settings = {};
  try {
    settings = await api('/api/settings');
  } catch (err) {
    view.appendChild(inlineBanner(`Could not load settings: ${err.message}`, 'error'));
    return;
  }

  // L2: three labeled zones (Workspace / Brands / Integrations & ops) with
  // anchor links at top. Individual cards below are unchanged; they're just
  // routed into the right zone container at the bottom of this function
  // instead of appended straight to `view` as they're built.
  view.appendChild(
    el('nav', { class: 'settings-zone-nav' }, [
      el('a', { href: '#settings-zone-workspace' }, 'Workspace'),
      el('a', { href: '#settings-zone-brands' }, 'Brands'),
      el('a', { href: '#settings-zone-ops' }, 'Integrations & ops'),
    ])
  );

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
          toast('Voice saved.');
        } catch (err) {
          voiceMsg.appendChild(inlineBanner(err.message, 'error'));
        }
      },
    }, 'Save voice')
  );
  personalityCard.appendChild(voiceMsg);

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
          toast('Saved.');
        } catch (err) {
          rulesMsg.appendChild(inlineBanner(err.message, 'error'));
        }
      },
    }, 'Save rules')
  );
  rulesCard.appendChild(rulesMsg);

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
      toast('Saved.');
    } catch (err) {
      publishMsg.appendChild(inlineBanner(err.message, 'error'));
    }
  });
  publishCard.appendChild(publishMsg);

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
      toast('Saved.');
    } catch (err) {
      providerMsg.appendChild(inlineBanner(err.message, 'error'));
    }
  };
  providerCard.appendChild(providerMsg);

  // ---- Image prompt system ----
  const imagePromptCard = el('div', { class: 'card settings-section settings-prompt-card' });
  imagePromptCard.appendChild(el('h2', {}, 'Image prompt system'));
  imagePromptCard.appendChild(
    settingsHint('These instructions are included in every Codex image handoff spec, including Composer, chat agent, and blog redistribution requests.')
  );
  buildImagePromptEditor(imagePromptCard, settings);

  // ---- Per-brand tone tweaks ----
  const brandCard = el('div', { class: 'card settings-section' });
  brandCard.appendChild(el('h2', {}, 'Per-brand'));

  if (!state.brands.length) {
    brandCard.appendChild(emptyState('No brands yet.'));
    view.append(
      el('section', { id: 'settings-zone-workspace', class: 'settings-zone' }, [
        el('h2', { class: 'settings-zone-title' }, 'Workspace'),
        personalityCard, rulesCard, publishCard, providerCard, imagePromptCard,
      ]),
      el('section', { id: 'settings-zone-brands', class: 'settings-zone' }, [
        el('h2', { class: 'settings-zone-title' }, 'Brands'),
        brandCard,
      ])
    );
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
          toast('Default tone saved.');
        } catch (err) {
          defaultToneMsg.appendChild(inlineBanner(err.message, 'error'));
        }
      },
    }, 'Save default tone')
  );
  brandCard.appendChild(defaultToneMsg);

  const tonesHost = el('div');
  brandCard.appendChild(tonesHost);

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
      brandingHost.appendChild(inlineBanner(`Could not load brand: ${err.message}`, 'error'));
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
              logoMsg.appendChild(inlineBanner('Choose a logo file first.', 'error'));
              return;
            }
            const fd = new FormData();
            fd.append('logo', logoFileInput.files[0]);
            try {
              const updated = await api(`/api/brands/${brandId}/logo`, { method: 'POST', body: fd });
              brand.logo_path = updated?.logo_path || brand.logo_path;
              renderLogoPreview();
              logoFileInput.value = '';
              toast('Logo uploaded.');
            } catch (err) {
              logoMsg.appendChild(inlineBanner(err.message, 'error'));
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
        toast('Colors saved.');
      } catch (err) {
        colorsMsg.appendChild(inlineBanner(err.message, 'error'));
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
            toast('Saved.');
          } catch (err) {
            voiceDocMsg.appendChild(inlineBanner(err.message, 'error'));
          }
        },
      }, 'Save voice-doc path')
    );
    brandingHost.appendChild(voiceDocMsg);

    // ---- Link tracking / UTM (B18c) - applied automatically at the
    // approve transition (never on draft, so drafts stay clean). Brands
    // round-trip utm_enabled/utm_template via PATCH /api/brands/:id.
    const utmToggle = settingsToggleRow(Boolean(brand.utm_enabled), 'Link tracking (UTM)');
    const utmTemplateInput = el('input', {
      placeholder: 'utm_source={platform}&utm_medium=social&utm_campaign={campaign}',
      value: brand.utm_template || '',
    });
    const utmMsg = el('div');
    brandingHost.appendChild(utmToggle.row);
    brandingHost.appendChild(
      el('div', { class: 'field-row' }, [el('label', {}, 'UTM template'), utmTemplateInput])
    );
    brandingHost.appendChild(settingsHint('Applied when a post is approved.'));
    brandingHost.appendChild(
      el('button', {
        onclick: async () => {
          utmMsg.innerHTML = '';
          try {
            const updated = await api(`/api/brands/${brandId}`, {
              method: 'PATCH',
              body: { utm_enabled: utmToggle.cb.checked, utm_template: utmTemplateInput.value || null },
            });
            brand.utm_enabled = updated?.utm_enabled;
            brand.utm_template = updated?.utm_template;
            toast('Saved.');
          } catch (err) {
            utmMsg.appendChild(inlineBanner(err.message, 'error'));
          }
        },
      }, 'Save link tracking')
    );
    brandingHost.appendChild(utmMsg);
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
            toast('Saved.');
            loadPreview();
          } catch (err) {
            msg.appendChild(inlineBanner(err.message, 'error'));
          }
        },
      }, 'Save'),
      el('button', {
        onclick: async () => {
          msg.innerHTML = '';
          try {
            const reset = await api(`/api/tone-profiles/${profile.id}/reset`, { method: 'POST' });
            area.value = reset?.voice_rules || '';
            toast('Reset to global.');
            loadPreview();
          } catch (err) {
            msg.appendChild(inlineBanner(err.message, 'error'));
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
      tonesHost.appendChild(inlineBanner(`Could not load tone profiles: ${err.message}`, 'error'));
    }
  }

  // ---- Queues (B16a) - recurring weekly slots per brand+platform. "Add to
  // queue" (composer action bar) drops a post into the next open one. ----
  const QUEUE_DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ALL_PLATFORMS = ['linkedin', 'facebook', 'twitter', 'instagram', 'reddit', 'tiktok', 'youtube', 'threads', 'blog'];

  const queuesCard = el('div', { class: 'card settings-section' });
  queuesCard.appendChild(el('h2', {}, 'Queues'));
  queuesCard.appendChild(
    settingsHint('Recurring weekly time slots per platform. "Add to queue" in the Composer drops a post into the next open one.')
  );
  const queuesHost = el('div');
  queuesCard.appendChild(queuesHost);

  async function loadQueues() {
    queuesHost.innerHTML = '<p style="color:var(--muted);">Loading queue slots…</p>';
    let slots;
    try {
      slots = await api(`/api/queue-slots?brand_id=${brandId}`);
    } catch (err) {
      queuesHost.innerHTML = '';
      queuesHost.appendChild(inlineBanner(`Could not load queue slots: ${err.message}`, 'error'));
      return;
    }

    // Limit the platform picker to platforms this brand actually has an
    // account for, when that's derivable; otherwise offer all platforms.
    const brandPlatforms = [...new Set(
      state.accounts.filter((a) => String(a.brand_id) === String(brandId)).map((a) => a.platform)
    )];
    const platformOptions = brandPlatforms.length ? brandPlatforms : ALL_PLATFORMS;

    queuesHost.innerHTML = '';

    const listMsg = el('div');
    if (!slots.length) {
      queuesHost.appendChild(emptyState('No queue slots yet - add your first slot below.'));
    } else {
      const list = el('div', { class: 'queue-slot-list' });
      for (const slot of slots) {
        const activeToggle = el('input', { type: 'checkbox', class: 'switch' });
        activeToggle.checked = Number(slot.active) === 1;
        activeToggle.addEventListener('change', async () => {
          try {
            await api(`/api/queue-slots/${slot.id}`, { method: 'PATCH', body: { active: activeToggle.checked ? 1 : 0 } });
          } catch (err) {
            activeToggle.checked = !activeToggle.checked;
            toast(`Could not update slot: ${err.message}`, 'error');
          }
        });
        const removeBtn = el('button', {
          class: 'account-remove',
          type: 'button',
          title: 'Delete this slot',
          onclick: async () => {
            // Destructive - kept as a native confirm() rather than a custom
            // confirmation UI (judgment call per D2 spec R5).
            if (!confirm(`Delete the ${QUEUE_DAY_NAMES[slot.day_of_week]} ${slot.time_local} ${slot.platform} slot?`)) return;
            try {
              await api(`/api/queue-slots/${slot.id}`, { method: 'DELETE' });
              loadQueues();
            } catch (err) {
              toast(`Could not delete slot: ${err.message}`, 'error');
            }
          },
        }, '✕');
        list.appendChild(
          el('div', { class: 'queue-slot-row', style: 'display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:6px;' }, [
            el('span', { class: 'pill' }, slot.platform),
            el('span', {}, `${QUEUE_DAY_NAMES[slot.day_of_week]} ${slot.time_local}`),
            el('label', { style: 'display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);' }, [activeToggle, 'active']),
            removeBtn,
          ])
        );
      }
      queuesHost.appendChild(list);
    }

    // ---- Add-slot row ----
    const daySelect = el('select', {}, QUEUE_DAY_NAMES.map((name, i) => el('option', { value: String(i) }, name)));
    const timeInput = el('input', { type: 'time', value: '12:00' });
    const platformSelect = el('select', {}, platformOptions.map((p) => el('option', { value: p }, p)));
    const addMsg = el('div');
    const addBtn = el('button', {
      class: 'primary',
      onclick: async () => {
        addMsg.innerHTML = '';
        try {
          await api('/api/queue-slots', {
            method: 'POST',
            body: {
              brand_id: Number(brandId),
              platform: platformSelect.value,
              day_of_week: Number(daySelect.value),
              time_local: timeInput.value,
            },
          });
          loadQueues();
        } catch (err) {
          addMsg.appendChild(inlineBanner(err.message, 'error'));
        }
      },
    }, 'Add slot');
    queuesHost.appendChild(
      formSection('Add a slot', null,
        el('div', { class: 'form-section-row' }, [daySelect, timeInput, platformSelect, addBtn])
      )
    );
    queuesHost.appendChild(addMsg);
    queuesHost.appendChild(listMsg);

    // ---- Best-time hint (B18a #4) - cheap reuse of the composer's fetch,
    // one line, updates whenever the platform dropdown changes.
    const queueBestTimeHost = el('div', { style: 'margin-top:4px;' });
    queuesHost.appendChild(queueBestTimeHost);
    let queueBestTimeToken = 0;
    async function updateQueueBestTimeHint() {
      const platform = platformSelect.value;
      const myToken = ++queueBestTimeToken;
      queueBestTimeHost.innerHTML = '';
      if (!platform) return;
      let data;
      try {
        data = await api(`/api/best-times?brand_id=${brandId}&platform=${platform}`);
      } catch {
        return;
      }
      if (myToken !== queueBestTimeToken) return; // superseded by a later platform switch
      if (!data || !Array.isArray(data.bands) || !data.bands.length) return;
      queueBestTimeHost.appendChild(
        el('div', { class: 'best-time-hint' }, `Best window for ${platform}: ${data.bands[0].label}`)
      );
    }
    platformSelect.addEventListener('change', updateQueueBestTimeHint);
    updateQueueBestTimeHint();

    // ---- One-click seed: Daily 12:00 LinkedIn + Facebook (7 x 2 slots,
    // skips any that already exist for that day/time/platform). ----
    const seedMsg = el('div');
    const seedBtn = el('button', {
      onclick: async () => {
        seedMsg.innerHTML = '';
        const seedPlatforms = platformOptions.filter((p) => p === 'linkedin' || p === 'facebook');
        if (!seedPlatforms.length) {
          seedMsg.appendChild(inlineBanner('This brand has no LinkedIn or Facebook account.', 'error'));
          return;
        }
        const fresh = await api(`/api/queue-slots?brand_id=${brandId}`);
        let created = 0;
        for (let dow = 0; dow < 7; dow++) {
          for (const platform of seedPlatforms) {
            const exists = fresh.some((s) => s.day_of_week === dow && s.time_local === '12:00' && s.platform === platform);
            if (exists) continue;
            try {
              await api('/api/queue-slots', {
                method: 'POST',
                body: { brand_id: Number(brandId), platform, day_of_week: dow, time_local: '12:00' },
              });
              created++;
            } catch { /* skip on failure, keep seeding the rest */ }
          }
        }
        toast(`Seeded ${created} slot(s).`);
        loadQueues();
      },
    }, 'Daily 12:00 LinkedIn + Facebook');
    queuesHost.appendChild(el('div', { class: 'toolbar', style: 'margin-top:10px;' }, [seedBtn]));
    queuesHost.appendChild(seedMsg);
  }

  brandSelect.onchange = () => {
    brandId = brandSelect.value;
    setStickyBrand(brandId);
    loadBrand();
    loadBranding();
    loadQueues();
  };

  // ---- L2 assembly: Workspace / Brands / Integrations & ops zones ----
  view.append(
    el('section', { id: 'settings-zone-workspace', class: 'settings-zone' }, [
      el('h2', { class: 'settings-zone-title' }, 'Workspace'),
      personalityCard, rulesCard, publishCard, providerCard, imagePromptCard,
    ]),
    el('section', { id: 'settings-zone-brands', class: 'settings-zone' }, [
      el('h2', { class: 'settings-zone-title' }, 'Brands'),
      brandCard, brandingCard, queuesCard,
    ]),
    el('section', { id: 'settings-zone-ops', class: 'settings-zone' }, [
      el('h2', { class: 'settings-zone-title' }, 'Integrations & ops'),
      el('div', { class: 'card settings-section' }, [
        el('h2', {}, 'Status'),
        el('div', { style: 'color:var(--muted);font-size:12px;margin-bottom:10px;' },
          'Blotato connection, dry-run mode, and worker state live on the Ops Stats view - nothing to configure here yet.'),
        el('button', { class: 'button secondary sm', type: 'button', onclick: () => { location.hash = '#/ops'; } }, 'Open Ops Stats'),
      ]),
    ])
  );

  await Promise.all([loadBrand(), loadBranding(), loadQueues()]);
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
      fieldsHost.appendChild(emptyState('No fields yet - hit Generate to draft them.'));
      return;
    }
    for (const key of keys) {
      const value = fields[key] == null ? '' : String(fields[key]);
      const long = isLongProfileField(key, value);
      const input = long ? el('textarea', { rows: '4' }) : el('input', {});
      input.value = value;
      input.addEventListener('input', () => { fields[key] = input.value; });

      const copyBtn = el('button', { class: 'button ghost sm profile-copy-btn', type: 'button' }, 'Copy');
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

  const generateBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Generate');
  generateBtn.addEventListener('click', async () => {
    generateBtn.disabled = true;
    generateBtn.classList.add('is-pending');
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
      toast('Drafted - review before you copy-paste it anywhere.');
    } catch (err) {
      if (err.status === 503 || err.data?.error === 'ai_unavailable') {
        toast("AI unavailable - the claude CLI isn't reachable.", 'error');
      } else if (err.status === 404) {
        toast('Generate endpoint not available yet on this server.', 'error');
      } else {
        toast(err.message, 'error');
      }
    } finally {
      generateBtn.disabled = false;
      generateBtn.classList.remove('is-pending');
      generateBtn.textContent = originalText;
    }
  });

  const saveBtn = el('button', { class: 'button primary md', type: 'button' }, 'Save');
  saveBtn.addEventListener('click', async () => {
    try {
      await api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { fields } });
      toast('Saved.');
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const reviewedBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Mark reviewed');
  reviewedBtn.addEventListener('click', async () => {
    try {
      await api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { status: 'current' } });
      toast('Marked current.');
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const staleBtn = el('button', { class: 'button destructive md', type: 'button' }, 'Mark stale');
  staleBtn.addEventListener('click', async () => {
    try {
      await api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { status: 'stale' } });
      toast('Marked stale.');
      onChanged();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  const actions = el('div', { class: 'toolbar profile-card-actions' }, [generateBtn, saveBtn, reviewedBtn, staleBtn]);
  card.appendChild(actions);

  return card;
}

async function renderProfiles(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  if (!state.brands.length) {
    view.appendChild(pageHeader('Brand profiles'));
    view.appendChild(emptyState('No brands yet.'));
    return;
  }

  let brandId = getStickyBrand() && state.brands.some((b) => String(b.id) === getStickyBrand())
    ? getStickyBrand()
    : String(state.brands[0].id);
  const brandSelect = el('select', {}, state.brands.map((b) =>
    el('option', { value: String(b.id), selected: String(b.id) === brandId ? 'selected' : undefined }, b.name)
  ));
  view.appendChild(pageHeader('Brand profiles', brandSelect));
  view.appendChild(
    el('div', { style: 'color:var(--muted);font-size:12px;margin:-6px 0 14px;' },
      "The source of truth for each platform's profile - heading, bio, and the platform-standard fields. Generate drafts them in your voice; copy-paste is the whole point, nothing here posts anything.")
  );

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
        cardsHost.appendChild(inlineBanner('Profiles endpoint not available yet on this server.', 'error'));
      } else {
        cardsHost.appendChild(inlineBanner(`Could not load profiles: ${err.message}`, 'error'));
      }
      return;
    }
    cardsHost.innerHTML = '';
    if (!rows.length) {
      cardsHost.appendChild(
        emptyState('No profiles yet for this brand - Generate creates one per platform once it has an account/platform to draft for.')
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
  view.classList.add('view-default');

  const stickyBrandInit = getStickyBrand();
  const brandFilter = el('select', {}, [
    el('option', { value: '', selected: stickyBrandInit ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: b.id, selected: String(b.id) === String(stickyBrandInit) ? 'selected' : undefined }, b.name)
    ),
  ]);
  // R1: title -> primary context control (brand, drives both the list filter
  // and the add-note form below - single source of truth, no duplicate picker).
  view.appendChild(pageHeader('Research', brandFilter));

  const listHost = el('div');
  view.appendChild(listHost);

  async function reload() {
    listHost.innerHTML = '';
    const qs = brandFilter.value ? `?brand_id=${encodeURIComponent(brandFilter.value)}` : '';
    let notes;
    try {
      notes = await api(`/api/research${qs}`);
    } catch (err) {
      listHost.appendChild(inlineBanner(`Could not load research notes: ${err.message}`, 'error'));
      return;
    }
    if (!notes.length) {
      listHost.appendChild(emptyState('No research notes yet - add one below.'));
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
            class: 'button destructive sm',
            type: 'button',
            onclick: async () => {
              try {
                await api(`/api/research/${n.id}`, { method: 'DELETE' });
                toast('Note deleted.');
                reload();
              } catch (err) {
                toast(`Could not delete: ${err.message}`, 'error');
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

  // R1 fix: no second/duplicate brand picker here - the add-note form uses
  // the page-level brandFilter above as its brand context (falls back to
  // "no brand" when the filter is "All brands").
  const addSource = el('select', {}, RESEARCH_SOURCES.map((s) => el('option', { value: s }, s)));
  const addTitle = el('input', { placeholder: 'Title' });
  const addUrl = el('input', { placeholder: 'URL (optional)' });
  const addTags = el('input', { placeholder: 'tags, comma, separated' });
  const addBody = el('textarea', { rows: '5', placeholder: 'Body / notes' });
  const addMsg = el('div');
  const addBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      addMsg.innerHTML = '';
      try {
        await api('/api/research', {
          method: 'POST',
          body: {
            brand_id: brandFilter.value || null,
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
        toast('Note added.');
        reload();
      } catch (err) {
        addMsg.appendChild(inlineBanner(err.message, 'error'));
      }
    },
  }, '+ Add note');
  view.appendChild(
    formSection('Add note', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Source'), addSource]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Title'), addTitle]),
      el('div', { class: 'field-row' }, [el('label', {}, 'URL'), addUrl]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Tags'), addTags]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Body'), addBody]),
      addBtn,
      addMsg
    )
  );

  const importSource = el('select', {}, RESEARCH_SOURCES.map((s) => el('option', { value: s }, s)));
  const importFilename = el('input', { placeholder: 'filename (optional)' });
  const importContent = el('textarea', { rows: '6', placeholder: 'Paste CSV/text content here…' });
  const importMsg = el('div');
  const importBtn = el('button', {
    class: 'button primary md',
    type: 'button',
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
        toast('Imported.');
        reload();
      } catch (err) {
        importMsg.appendChild(inlineBanner(err.message, 'error'));
      }
    },
  }, 'Import');
  view.appendChild(
    formSection('Paste / import', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Source'), importSource]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Filename'), importFilename]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Content'), importContent]),
      importBtn,
      importMsg
    )
  );
}

// ---------------- Inspiration board (B8) ----------------

async function renderInspiration(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  const stickyBrandInit = getStickyBrand();
  const brandFilter = el('select', {}, [
    el('option', { value: '', selected: stickyBrandInit ? undefined : 'selected' }, 'All brands'),
    ...state.brands.map((b) =>
      el('option', { value: b.id, selected: String(b.id) === String(stickyBrandInit) ? 'selected' : undefined }, b.name)
    ),
  ]);
  view.appendChild(pageHeader('Inspiration', brandFilter));

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
    if (onAdd) actions.appendChild(el('button', { class: 'button primary sm', type: 'button', onclick: onAdd }, '+ Add to board'));
    if (onDelete) actions.appendChild(el('button', { class: 'button destructive sm', type: 'button', onclick: onDelete }, 'Delete'));
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
      gridHost.appendChild(inlineBanner(`Could not load inspiration board: ${err.message}`, 'error'));
      return;
    }
    if (!profiles.length) {
      gridHost.appendChild(emptyState('No profiles yet - add one below, or ask AI to suggest some.'));
      return;
    }
    const grid = el('div', { class: 'inspiration-grid' });
    for (const p of profiles) {
      grid.appendChild(
        profileCard(p, {
          onDelete: async () => {
            try {
              await api(`/api/inspiration/${p.id}`, { method: 'DELETE' });
              toast('Profile deleted.');
              reload();
            } catch (err) {
              toast(`Could not delete: ${err.message}`, 'error');
            }
          },
        })
      );
    }
    gridHost.appendChild(grid);
  }
  brandFilter.onchange = () => { setStickyBrand(brandFilter.value); reload(); };
  await reload();

  // R1 fix: no second/duplicate brand picker here - both forms below use the
  // page-level brandFilter as their brand context (same fix as Research).
  const addPlatform = el('select', {}, ['twitter', 'linkedin', 'facebook', 'instagram', 'tiktok', 'reddit', 'blog', 'other'].map((p) => el('option', { value: p }, p)));
  const addName = el('input', { placeholder: 'Name' });
  const addHandle = el('input', { placeholder: 'Handle (no @)' });
  const addUrl = el('input', { placeholder: 'URL' });
  const addNiche = el('input', { placeholder: 'Niche' });
  const addWhy = el('textarea', { rows: '2', placeholder: 'Why relevant' });
  const addTags = el('input', { placeholder: 'tags, comma, separated' });
  const addMsg = el('div');
  const addBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      addMsg.innerHTML = '';
      try {
        await api('/api/inspiration', {
          method: 'POST',
          body: {
            brand_id: brandFilter.value || null,
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
        toast('Profile added.');
        reload();
      } catch (err) {
        addMsg.appendChild(inlineBanner(err.message, 'error'));
      }
    },
  }, '+ Add profile');
  view.appendChild(
    formSection('Add profile', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Platform'), addPlatform]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Name'), addName]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Handle'), addHandle]),
      el('div', { class: 'field-row' }, [el('label', {}, 'URL'), addUrl]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Niche'), addNiche]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Why relevant'), addWhy]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Tags'), addTags]),
      addBtn,
      addMsg
    )
  );

  const suggestNiche = el('input', { placeholder: 'Niche (optional)' });
  const suggestPlatforms = el('input', { placeholder: 'Platforms, comma separated (optional)' });
  const suggestResults = el('div');
  const suggestMsg = el('div');
  const suggestBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      suggestMsg.innerHTML = '';
      suggestResults.innerHTML = '';
      try {
        const brand = brandFilter.value ? brandName(Number(brandFilter.value)) : undefined;
        const platforms = suggestPlatforms.value.split(',').map((p) => p.trim()).filter(Boolean);
        const res = await api('/api/inspiration/suggest', {
          method: 'POST',
          body: { brand_id: brandFilter.value || null, brand, niche: suggestNiche.value || undefined, platforms },
        });
        if (!res.suggestions || !res.suggestions.length) {
          suggestResults.appendChild(emptyState('No suggestions returned.'));
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
                        brand_id: brandFilter.value || null,
                        platform: s.platform || null,
                        name: s.name || null,
                        handle: s.handle || null,
                        url: s.url || null,
                        niche: suggestNiche.value || null,
                        why_relevant: s.why_relevant || null,
                        source: 'ai_suggested',
                      },
                    });
                    toast('Added to board.');
                    reload();
                  } catch (err) {
                    toast(`Could not add: ${err.message}`, 'error');
                  }
                },
              }
            )
          );
        }
        suggestResults.appendChild(grid);
      } catch (err) {
        if (err.status === 503) {
          suggestMsg.appendChild(inlineBanner('AI unavailable (claude CLI not found). Add profiles manually above.', 'error'));
        } else {
          suggestMsg.appendChild(inlineBanner(err.message, 'error'));
        }
      }
    },
  }, 'Suggest profiles');
  view.appendChild(
    formSection('Suggest profiles (AI)', null,
      el('div', { class: 'field-row' }, [el('label', {}, 'Niche'), suggestNiche]),
      el('div', { class: 'field-row' }, [el('label', {}, 'Platforms'), suggestPlatforms]),
      suggestBtn,
      suggestMsg,
      suggestResults
    )
  );
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
  const toggleBtn = el('button', { class: 'button secondary sm', type: 'button', style: 'margin-top:6px;width:100%;' }, 'Resize for platforms');
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

  const resultHost = el('div');
  panel.appendChild(
    el('button', {
      class: 'button primary sm',
      type: 'button',
      style: 'margin-top:6px;width:100%;',
      onclick: async () => {
        resultHost.innerHTML = '';
        const chosen = checks.filter((c) => c.cb.checked).map((c) => c.platform);
        if (!chosen.length) {
          toast('Pick at least one platform.', 'error');
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
            toast('Resized.');
          } else {
            resultHost.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;' }, 'Resize ran - no files returned.'));
          }
        } catch (err) {
          if (err.data?.error === 'resize_unavailable') {
            resultHost.appendChild(inlineBanner('Resize needs macOS sips - not available here.', 'warn'));
          } else {
            toast(err.message, 'error');
          }
        }
      },
    }, 'Resize')
  );
  panel.appendChild(resultHost);

  toggleBtn.addEventListener('click', () => { panel.hidden = !panel.hidden; });
  return wrap;
}

async function renderImages(view) {
  view.innerHTML = '';
  view.classList.add('view-default');

  const statusFilter = el('select', {}, [
    el('option', { value: '' }, 'All statuses'),
    ...['requested', 'generated', 'picked', 'canceled'].map((s) => el('option', { value: s }, s)),
  ]);
  // R1: title -> actions; status filter rightmost (only filter on this view).
  view.appendChild(pageHeader('Images', el('span', {}, 'Status:'), statusFilter));
  view.appendChild(
    inlineBanner('Codex drops generated variants into image-requests/generated/ - see docs/CODEX_IMAGE_HANDOFF.md for the handoff contract.', 'info')
  );

  const listHost = el('div');
  view.appendChild(listHost);

  async function reload() {
    listHost.innerHTML = '';
    const qs = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : '';
    let reqs;
    try {
      reqs = await api(`/api/image-requests${qs}`);
    } catch (err) {
      listHost.appendChild(inlineBanner(`Could not load image requests: ${err.message}`, 'error'));
      return;
    }
    if (!reqs.length) {
      listHost.appendChild(emptyState('No image requests yet - use "Request image (Codex)" in the Composer.'));
      return;
    }
    for (const r of reqs) {
      const card = el('div', { class: 'card' });
      // Item 5 (2026-07-19 feedback): 'requested' is the state right after
      // firing a request from either composer, before Codex has picked it up
      // - the raw word "requested" reads as ambiguous/stuck, so it gets a
      // clearer label here (same wording used in the two composers' success
      // messages, so the phrase is consistent everywhere it appears).
      const statusLabel = r.status === 'requested' ? 'Waiting on Codex' : r.status;
      card.appendChild(
        el('div', { style: 'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' }, [
          el('strong', {}, `Request #${r.id}`),
          el('span', { class: `pill status-${r.status}` }, statusLabel),
          el('span', { style: 'color:var(--muted);font-size:12px;' }, (r.platforms || []).join(', ')),
          r.content_type ? el('span', { style: 'color:var(--muted);font-size:12px;' }, r.content_type) : null,
          r.post_id ? el('a', { href: `#/post/${r.post_id}`, style: 'font-size:12px;' }, `→ post #${r.post_id}`) : null,
        ])
      );
      card.appendChild(el('div', { style: 'color:var(--muted);font-size:11px;margin-top:4px;' }, `Created: ${fmtDate(r.created_at)}`));
      if (r.status === 'requested') {
        card.appendChild(
          el('div', { style: 'color:var(--muted);font-size:12px;margin-top:4px;' },
            'Waiting on Codex - run the image handoff to generate variants for this request (see docs/CODEX_IMAGE_HANDOFF.md).')
        );
      }

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
              class: 'button primary sm',
              type: 'button',
              style: 'margin-top:6px;width:100%;',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/pick`, { method: 'POST', body: { chosen_path: v.path } });
                  toast('Variant picked.');
                  reload();
                } catch (err) {
                  toast(`Could not pick: ${err.message}`, 'error');
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
              class: 'button secondary sm',
              type: 'button',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/regenerate`, { method: 'POST' });
                  toast('Regenerating variants.');
                  reload();
                } catch (err) {
                  toast(`Could not regenerate: ${err.message}`, 'error');
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
              class: 'button destructive sm',
              type: 'button',
              onclick: async () => {
                try {
                  await api(`/api/image-requests/${r.id}/cancel`, { method: 'POST' });
                  toast('Request canceled.');
                  reload();
                } catch (err) {
                  toast(`Could not cancel: ${err.message}`, 'error');
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

  fab.addEventListener('click', () => { openQuickCompose(); });
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

// ---------------- item 3: Live/sync status pill (nav rail footer) ----------------
function syncStatusEls() {
  return {
    pill: document.getElementById('sync-status-pill'),
    dot: document.getElementById('sync-status-dot'),
    label: document.getElementById('sync-status-label'),
    popover: document.getElementById('sync-status-popover'),
    body: document.getElementById('sync-status-body'),
    syncNowBtn: document.getElementById('sync-status-sync-now'),
  };
}
function timeAgo(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const mins = Math.round(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}
async function refreshSyncStatusPill() {
  const { dot, label } = syncStatusEls();
  if (!dot) return;
  try {
    const ws = await api('/api/worker/status');
    dot.className = 'sync-status-dot';
    if (!ws.enabled) { dot.classList.add('sync-red'); label.textContent = 'Worker off'; }
    else if (ws.dryRun) { dot.classList.add('sync-amber'); label.textContent = 'Dry run'; }
    else { dot.classList.add('sync-green'); label.textContent = 'Live'; }
  } catch {
    dot.className = 'sync-status-dot sync-red';
    label.textContent = 'Unknown';
  }
}
async function refreshSyncStatusPopover() {
  const { body } = syncStatusEls();
  if (!body) return;
  body.innerHTML = '';
  body.appendChild(el('p', { style: 'color:var(--muted);font-size:12px;' }, 'Loading…'));
  try {
    const [ws, posts] = await Promise.all([api('/api/worker/status'), api('/api/posts')]);
    const submittedUpcoming = posts.filter((p) => ['submitted', 'submitted_dry'].includes(p.status) && p.publish_at && new Date(p.publish_at).getTime() >= Date.now()).length;
    const waiting = posts.filter((p) => p.status === 'scheduled_local').length;
    const errored = posts.filter((p) => p.error_message).length;
    body.innerHTML = '';
    body.appendChild(el('div', { class: 'sync-status-row' }, `Synced ${timeAgo(ws.lastRunAt)}`));
    body.appendChild(el('div', { class: 'sync-status-row' }, `Next run: ${ws.nextRunAt ? fmtDate(ws.nextRunAt) : '-'}`));
    body.appendChild(el('div', { class: 'sync-status-row' }, `${submittedUpcoming} submitted upcoming`));
    body.appendChild(el('div', { class: 'sync-status-row' }, `${waiting} scheduled, waiting`));
    body.appendChild(el('div', { class: 'sync-status-row' }, `${errored} with an error`));
  } catch (err) {
    body.innerHTML = '';
    body.appendChild(inlineBanner(`Could not load sync status: ${err.message}`, 'error'));
  }
}
function openSyncStatusPopover() {
  const { popover, pill } = syncStatusEls();
  if (!popover) return;
  popover.hidden = false;
  popover.setAttribute('aria-hidden', 'false');
  pill.setAttribute('aria-expanded', 'true');
  refreshSyncStatusPopover();
}
function closeSyncStatusPopover() {
  const { popover, pill } = syncStatusEls();
  if (!popover) return;
  popover.hidden = true;
  popover.setAttribute('aria-hidden', 'true');
  pill.setAttribute('aria-expanded', 'false');
}
function toggleSyncStatusPopover() {
  const { popover } = syncStatusEls();
  if (!popover) return;
  if (popover.hidden) openSyncStatusPopover();
  else closeSyncStatusPopover();
}
function wireSyncStatusPill() {
  const { pill, popover, syncNowBtn } = syncStatusEls();
  if (!pill) return;
  pill.addEventListener('click', toggleSyncStatusPopover);
  document.addEventListener('mousedown', (e) => {
    if (!popover.hidden && !popover.contains(e.target) && e.target !== pill && !pill.contains(e.target)) closeSyncStatusPopover();
  });
  syncNowBtn.addEventListener('click', async () => {
    syncNowBtn.disabled = true;
    syncNowBtn.textContent = 'Syncing…';
    try {
      const summary = await api('/api/worker/run-now', { method: 'POST', body: {} });
      toast(`Sync complete - ${summary.handoffCount} handed off, ${summary.verifyCount} verified.`, 'ok');
      await refreshSyncStatusPill();
      await refreshSyncStatusPopover();
      if (typeof currentCalendarReload === 'function') currentCalendarReload();
    } catch (err) {
      if (err.status === 409) toast('Already syncing - try again in a moment.', 'info');
      else toast(`Sync failed: ${err.message}`, 'error');
    } finally {
      syncNowBtn.disabled = false;
      syncNowBtn.textContent = 'Sync now';
    }
  });
  refreshSyncStatusPill();
  // Poll every 60s while the popover is closed; live-update every 10s while open.
  setInterval(() => {
    const { popover: p } = syncStatusEls();
    if (p && !p.hidden) refreshSyncStatusPopover();
  }, 10000);
  setInterval(() => {
    const { popover: p } = syncStatusEls();
    if (!p || p.hidden) refreshSyncStatusPill();
  }, 60000);
}

// ---------------- Nav rail (B16b) ----------------
// Persistent grouped left rail lives outside #view (in index.html); active-route
// highlight is already handled generically in router() via #sidebar a[data-route].
// This just wires the collapsible group headers, persisting each group's
// expanded/collapsed state per-group in localStorage.
function navGroupStorageKey(group) {
  return `pd_nav_${group}`;
}

function setNavGroupExpanded(groupEl, expanded) {
  const header = groupEl.querySelector('.nav-group-header');
  const links = groupEl.querySelector('.nav-group-links');
  if (!header || !links) return;
  groupEl.classList.toggle('collapsed', !expanded);
  header.setAttribute('aria-expanded', String(expanded));
  links.hidden = !expanded;
}

function wireNavRail() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.querySelectorAll('.nav-group').forEach((groupEl) => {
    const group = groupEl.dataset.group;
    const stored = localStorage.getItem(navGroupStorageKey(group));
    // Default: expanded, unless the user previously collapsed it.
    setNavGroupExpanded(groupEl, stored !== 'collapsed');

    const header = groupEl.querySelector('.nav-group-header');
    if (!header) return;
    header.addEventListener('click', () => {
      const expandedNow = header.getAttribute('aria-expanded') === 'true';
      const next = !expandedNow;
      setNavGroupExpanded(groupEl, next);
      localStorage.setItem(navGroupStorageKey(group), next ? 'expanded' : 'collapsed');
    });
  });
}

// ---------------- F5: keyboard shortcuts + Cmd+K palette ----------------

function isTypingTarget(e) {
  const t = e.target;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

// Subsequence fuzzy match, case-insensitive - a straight substring hit short-
// circuits (fast path for the common case), a subsequence match covers the
// rest ("qcp" matching "Quick Compose"). Good enough at CB's post volume;
// no scoring/sort needed beyond the caller's own ordering.
function fuzzyMatch(query, text) {
  if (!query) return true;
  const q = query.toLowerCase();
  const t = (text || '').toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function openShortcutCheatSheet() {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card' });
  overlay.appendChild(card);
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);

  card.appendChild(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Keyboard shortcuts'),
      el('button', { class: 'modal-close', type: 'button', title: 'Close', onclick: close }, '✕'),
    ])
  );
  const rows = [
    ['C', 'New post (Quick Compose)'],
    ['R', 'Go to Review'],
    ['1', 'Go to Home'],
    ['2', 'Go to Calendar / Queue'],
    ['3', 'Go to Ideas Board'],
    ['4', 'Go to Analytics'],
    ['?', 'This cheat sheet'],
    ['⌘K / Ctrl K', 'Command palette - jump, search posts, run actions'],
    ['A', 'Review mode: approve & next'],
    ['S', 'Review mode: skip'],
    ['E', 'Review mode: focus the copy editor'],
    ['← / →', 'Review mode: look at prev / next in queue'],
    ['Esc', 'Close the current modal, popover, or palette'],
  ];
  const list = el('div', { class: 'shortcut-list' });
  for (const [key, desc] of rows) {
    list.appendChild(
      el('div', { class: 'shortcut-row' }, [
        el('span', { class: 'shortcut-key' }, key),
        el('span', { class: 'shortcut-desc' }, desc),
      ])
    );
  }
  card.appendChild(list);
  document.body.appendChild(overlay);
}

// Cmd+K palette: single module-level flag so the global shortcut handler
// (and a stray second Cmd+K press) don't spawn two overlays at once.
let paletteOpen = false;

function closeCommandPalette(state) {
  if (!state || state.closed) return;
  state.closed = true;
  paletteOpen = false;
  state.overlay.remove();
  document.removeEventListener('keydown', state.onKey, true);
}

async function openCommandPalette() {
  if (paletteOpen) return;
  paletteOpen = true;

  const overlay = el('div', { class: 'modal-overlay palette-overlay' });
  const card = el('div', { class: 'modal-card palette-card' });
  overlay.appendChild(card);
  const input = el('input', { type: 'text', class: 'palette-input', placeholder: 'Jump to a view, run an action, or search posts by copy…' });
  const list = el('div', { class: 'palette-list' });
  const hint = el('div', { class: 'palette-hint' }, '↑↓ navigate · Enter select · Esc close');
  card.append(input, list, hint);
  document.body.appendChild(overlay);

  const state = { overlay, closed: false, matches: [], activeIndex: 0, onKey: () => {} };
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeCommandPalette(state); });

  const navEntries = [
    { type: 'nav', label: 'Home', hash: '#/home' },
    { type: 'nav', label: 'Calendar / Queue', hash: '#/calendar' },
    { type: 'nav', label: 'Review drafts', hash: '#/review' },
    { type: 'nav', label: 'Ideas Board', hash: '#/ideas' },
    { type: 'nav', label: 'Composer', hash: '#/composer' },
    { type: 'nav', label: 'Library', hash: '#/library' },
    { type: 'nav', label: 'Images', hash: '#/images' },
    { type: 'nav', label: 'Analytics', hash: '#/analytics' },
    { type: 'nav', label: 'Research', hash: '#/research' },
    { type: 'nav', label: 'Inspiration', hash: '#/inspiration' },
    { type: 'nav', label: 'Profiles', hash: '#/profiles' },
    { type: 'nav', label: 'Settings', hash: '#/settings' },
    { type: 'nav', label: 'Ops Stats', hash: '#/ops' },
  ];
  const actionEntries = [
    { type: 'action', label: 'New post → Quick Compose', run: () => openQuickCompose() },
    { type: 'action', label: 'Review drafts', run: () => { location.hash = '#/review'; } },
    { type: 'action', label: 'Import analytics', run: () => { location.hash = '#/analytics'; } },
    { type: 'action', label: 'Request image', run: () => { location.hash = '#/images'; } },
  ];

  let posts = [];
  try { posts = await api('/api/posts'); } catch { posts = []; }
  if (state.closed) return; // closed while the fetch was in flight

  function computeMatches(query) {
    const q = query.trim();
    const navMatches = navEntries.filter((n) => fuzzyMatch(q, n.label));
    const actionMatches = actionEntries.filter((a) => fuzzyMatch(q, a.label));
    let postMatches = [];
    if (q) {
      // Plain substring, not fuzzyMatch's subsequence fallback: post copy is
      // full prose, not a short label, so a subsequence match against a
      // whole paragraph is nearly always true and floods the list with
      // irrelevant posts. A real substring hit is what "search by copy
      // text" means here.
      const ql = q.toLowerCase();
      postMatches = posts
        .filter((p) => (p.copy || '').toLowerCase().includes(ql))
        .slice(0, 8)
        .map((p) => ({ type: 'post', label: (p.copy || '(no copy)').split('\n')[0], post: p }));
    }
    return [...navMatches, ...actionMatches, ...postMatches].slice(0, 12);
  }

  function selectMatch(m) {
    if (!m) return;
    closeCommandPalette(state);
    if (m.type === 'nav') location.hash = m.hash;
    else if (m.type === 'action') m.run();
    else if (m.type === 'post') openPostModal(m.post.id);
  }

  function renderList() {
    list.innerHTML = '';
    const matches = computeMatches(input.value);
    state.matches = matches;
    if (!matches.length) {
      list.appendChild(el('div', { class: 'palette-empty' }, 'No matches.'));
      return;
    }
    state.activeIndex = Math.min(state.activeIndex, matches.length - 1);
    matches.forEach((m, i) => {
      const row = el('div', {
        class: 'palette-item' + (i === state.activeIndex ? ' active' : ''),
        onclick: () => selectMatch(m),
      });
      if (m.type === 'post') {
        row.append(
          platformIcon(m.post.platform, { size: 13 }),
          el('span', { class: 'palette-item-label' }, ` ${m.label}`),
          el('span', { class: `pill status-${m.post.status}` }, m.post.status)
        );
      } else {
        row.append(
          el('span', { class: 'palette-item-label' }, m.label),
          el('span', { class: 'palette-item-kind' }, m.type === 'nav' ? 'Go to' : 'Action')
        );
      }
      list.appendChild(row);
    });
  }

  input.addEventListener('input', () => { state.activeIndex = 0; renderList(); });

  state.onKey = function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeCommandPalette(state); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); state.activeIndex = Math.min(state.activeIndex + 1, state.matches.length - 1); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); state.activeIndex = Math.max(state.activeIndex - 1, 0); renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); selectMatch(state.matches[state.activeIndex]); }
  };
  document.addEventListener('keydown', state.onKey, true);

  renderList();
  input.focus();
}

// Global single-key shortcuts. Ignored while the user is typing in a form
// field (Cmd/Ctrl+K is the one exception - it opens the palette regardless,
// same as most apps' command palettes). renderReview's own keydown handler
// (A/S/E/arrows) is view-scoped and only acts while #/review is current, and
// none of those letters overlap the ones handled here, so the two coexist
// without stepping on each other.
function wireGlobalShortcuts() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openCommandPalette();
      return;
    }
    if (isTypingTarget(e)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'c':
      case 'C':
        e.preventDefault();
        openQuickCompose();
        break;
      case 'r':
      case 'R':
        e.preventDefault();
        location.hash = '#/review';
        break;
      case '1':
        e.preventDefault();
        location.hash = '#/home';
        break;
      case '2':
        e.preventDefault();
        location.hash = '#/calendar';
        break;
      case '3':
        e.preventDefault();
        location.hash = '#/ideas';
        break;
      case '4':
        e.preventDefault();
        location.hash = '#/analytics';
        break;
      case '?':
        e.preventDefault();
        openShortcutCheatSheet();
        break;
      default:
        break;
    }
  });

  const hintBtn = document.getElementById('nav-shortcuts-hint');
  if (hintBtn) hintBtn.addEventListener('click', () => openShortcutCheatSheet());
}

wireNavRail();
wireGlobalChrome();
wireGlobalShortcuts();
wireSyncStatusPill();
