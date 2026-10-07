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
  const btn = el('button', { class: `button secondary ${size}`, type: 'button' }, 'Send schedule to Blotato early');
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    await sendToBlotatoNow(post.id, { onDone });
    btn.disabled = false;
  });
  return el('div', { class: 'send-now-wrap' }, [
    btn,
    el('div', { class: 'send-now-sub' }, 'This does not publish now. It only hands the existing schedule to Blotato early.'),
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
  providers: [], // GET /api/ai/providers - see aiProviders() below
};

// ---------------- B15: AI provider switcher (Claude / Codex) ----------------
// The Settings draft_provider is the source of truth for the *default*; this
// module var just remembers the last choice for the rest of the session so
// switching brands/tabs in the composer doesn't reset it back to the setting.
let sessionDraftProvider = null;
// Fallback used when GET /api/ai/providers fails or hasn't shipped yet.
const AI_PROVIDERS_FALLBACK = [
  { name: 'claude', label: 'Claude', kind: 'cli', configured: true },
  { name: 'codex', label: 'Codex', kind: 'cli', configured: true },
];
// state.providers (populated in bootstrap from GET /api/ai/providers) is the
// source of truth for every provider-aware control below. aiProviders()
// returns only the configured ones, shaped like the old {value,label} list
// so existing call sites need minimal changes.
function aiProviders() {
  const list = (state.providers && state.providers.length) ? state.providers : AI_PROVIDERS_FALLBACK;
  return list.filter((p) => p.configured).map((p) => ({ value: p.name, label: p.label, kind: p.kind, raw: p }));
}
function providerLabel(name) {
  const found = aiProviders().find((p) => p.value === name);
  return found ? found.label : name === 'codex' ? 'Codex' : 'Claude';
}

// Small segmented control - one button per configured provider, one active.
// Shared by the Draft-with-AI box and the copy-assist panel (they read the
// same currentProvider closure var in renderComposer).
function providerSwitch(initial, onChange) {
  const wrap = el('div', { class: 'provider-switch' });
  let value = initial;
  const providers = aiProviders();
  const buttons = providers.map((p) =>
    el('button', {
      type: 'button',
      class: p.value === value ? 'active' : '',
      onclick: () => {
        value = p.value;
        for (const [i, b] of buttons.entries()) b.classList.toggle('active', providers[i].value === value);
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

// Convention: all dynamic content must go through el() / document.createTextNode -
// never assign innerHTML with interpolated user- or AI-generated text. The only
// sanctioned innerHTML template is platformIcon() over the static PLATFORM_ICON_PATHS map.
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
// D3: second arg is a kind string ('ok' | 'error' | 'warn') or an options
// object { tone, action: { label, onClick }, duration }. An action makes the
// toast an Undo toast: it stays longer and the button runs once.
let toastHost = null;
let toastTimer = null;
function toast(msg, kindOrOpts = 'ok') {
  if (typeof document === 'undefined') return;
  const opts = typeof kindOrOpts === 'string' ? { tone: kindOrOpts } : (kindOrOpts || {});
  const tone = opts.tone || 'ok';
  if (!toastHost) {
    toastHost = el('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const dismiss = () => { toastHost.innerHTML = ''; };
  const kids = [el('span', {}, msg)];
  if (opts.action && opts.action.label) {
    let used = false;
    kids.push(el('button', {
      class: 'toast-action',
      type: 'button',
      onclick: async () => {
        if (used) return;
        used = true;
        dismiss();
        try { await opts.action.onClick(); } catch (err) { toast(`Could not undo: ${err.message}`, 'error'); }
      },
    }, opts.action.label));
  }
  toastHost.innerHTML = '';
  toastHost.appendChild(el('div', { class: `toast toast-${tone}` }, kids));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismiss, opts.duration || (opts.action ? 7000 : 3500));
}

// D3 - confirm/prompt on a native <dialog>. Replaces window.confirm/alert/
// prompt everywhere: same look as the rest of the app, keyboard-safe (Esc
// cancels, focus returns to the opener), and awaitable.
//   if (!(await confirmDialog({ title: 'Cancel this post?', confirmLabel: 'Cancel post', tone: 'destructive' }))) return;
function openPdDialog({ title, body, confirmLabel, cancelLabel, tone, input }) {
  return new Promise((resolve) => {
    const opener = document.activeElement;
    const field = input
      ? el('input', { type: input.type || 'text', placeholder: input.placeholder || '', value: input.value || '', 'aria-label': input.label || title })
      : null;
    const confirmBtn = el('button', { class: `button md ${tone === 'destructive' ? 'destructive' : 'primary'}`, type: 'submit', value: 'confirm' }, confirmLabel);
    const cancelBtn = cancelLabel === null ? null : el('button', { class: 'button secondary md', type: 'button' }, cancelLabel || 'Cancel');
    const bodyKids = [el('h2', {}, title)];
    for (const para of [].concat(body || [])) {
      if (para) bodyKids.push(typeof para === 'string' ? el('p', {}, para) : para);
    }
    if (field) bodyKids.push(field);
    const form = el('form', { method: 'dialog' }, [
      el('div', { class: 'pd-dialog-body' }, bodyKids),
      el('div', { class: 'pd-dialog-actions' }, [cancelBtn, confirmBtn]),
    ]);
    const dlg = el('dialog', { class: 'pd-dialog' }, [form]);
    if (cancelBtn) cancelBtn.addEventListener('click', () => dlg.close('cancel'));
    form.addEventListener('submit', (e) => {
      if (field && !field.value.trim()) {
        e.preventDefault();
        field.focus();
        return;
      }
    });
    dlg.addEventListener('close', () => {
      const ok = dlg.returnValue === 'confirm';
      const value = field ? field.value.trim() : null;
      dlg.remove();
      if (opener && typeof opener.focus === 'function') opener.focus();
      resolve(input ? (ok ? value : null) : ok);
    });
    document.body.appendChild(dlg);
    dlg.showModal();
    (field || confirmBtn).focus();
  });
}

function confirmDialog({ title, body = '', confirmLabel = 'Confirm', cancelLabel = 'Cancel', tone = 'primary' } = {}) {
  return openPdDialog({ title, body, confirmLabel, cancelLabel, tone });
}

// Resolves to the trimmed string, or null when canceled.
function promptDialog({ title, body = '', label, placeholder = '', type = 'text', value = '', confirmLabel = 'Save', cancelLabel = 'Cancel' } = {}) {
  return openPdDialog({ title, body, confirmLabel, cancelLabel, tone: 'primary', input: { label, placeholder, type, value } });
}

// One-button notice (replaces alert()).
function noticeDialog({ title, body = '', confirmLabel = 'OK' } = {}) {
  return openPdDialog({ title, body, confirmLabel, cancelLabel: null, tone: 'primary' });
}

// D3 - the only status vocabulary the UI shows. Internal names
// (scheduled_local, failed_verify, submitted_dry, needs_check) never render.
function humanStatus(post) {
  const s = post && post.status;
  const missed = s === 'scheduled_local' && (post.missed_window || (typeof isMissedWindowPost === 'function' && isMissedWindowPost(post)));
  if (missed) return { key: 'attention', label: 'Missed time', tone: 'bad' };
  switch (s) {
    case 'draft': return { key: 'draft', label: 'Draft', tone: 'neutral' };
    case 'approved': return { key: 'scheduled', label: post.publish_at ? 'Scheduled' : 'Approved, no time', tone: 'gold' };
    case 'scheduled_local': return { key: 'scheduled', label: 'Scheduled', tone: 'gold' };
    case 'submitted': return { key: 'sending', label: 'Sent to Blotato', tone: 'info' };
    case 'submitted_dry': return { key: 'sending', label: 'Dry run', tone: 'info' };
    case 'published': return { key: 'posted', label: 'Posted', tone: 'ok' };
    case 'failed': return { key: 'attention', label: 'Failed', tone: 'bad' };
    case 'failed_verify': return { key: 'attention', label: 'Not confirmed', tone: 'bad' };
    case 'needs_check': return { key: 'attention', label: 'Check before resending', tone: 'bad' };
    case 'canceled': return { key: 'canceled', label: 'Canceled', tone: 'muted' };
    default: return { key: s || 'unknown', label: s || 'Unknown', tone: 'neutral' };
  }
}

// Blotato and worker errors arrive as raw API text ("Blotato validation
// error (422) for /v2/posts: {...json...}"). Turn the known ones into a
// sentence that says what happened and what to do; otherwise strip the
// endpoint and JSON noise and keep the message.
function humanizePostError(raw, platform) {
  const msg = String(raw || '').replace(/^(missed_window|needs_check):\s*/, '').trim();
  if (!msg) return '';
  const where = platform ? humanizePlatformName(platform) : 'that network';
  if (/Page \/ subaccount not found/i.test(msg)) {
    return `The ${where} page isn't connected in Blotato. Connect the page there, then reschedule.`;
  }
  if (/\/v2\/media/.test(msg) && /required property 'url'/i.test(msg)) {
    return 'The image upload failed (a bug fixed on Jul 24). Reschedule it and it will send with the image.';
  }
  if (/media file not found on disk/i.test(msg)) return 'The attached image file is missing from the library. Re-attach it, then reschedule.';
  if (/\(429\)|rate limit/i.test(msg)) return 'Blotato was rate-limiting requests. Reschedule it for a few minutes from now.';
  if (/network error|fetch failed|timed? ?out|ECONN/i.test(msg)) return "PostDeck couldn't reach Blotato. Check your connection, then reschedule.";
  const json = msg.match(/"message"\s*:\s*"([^"]+)"/);
  if (json) return json[1];
  return msg.replace(/\s+for \/v2\/[\w/]+:?/, '').slice(0, 160);
}

function statusPill(post) {
  const h = humanStatus(post);
  return el('span', { class: `status-pill status-pill--${h.tone}`, title: h.label }, h.label);
}

// D3 - view lifecycle. A view registers teardown for anything that outlives
// its DOM (intervals, document listeners); the router runs them on the next
// navigation. Overlays (drawers, sheets, popovers, modals) register a close
// function so a route change never leaves one stranded over another view.
const viewCleanups = [];
function onViewCleanup(fn) { viewCleanups.push(fn); }
function runViewCleanups() {
  while (viewCleanups.length) {
    const fn = viewCleanups.pop();
    try { fn(); } catch (err) { console.warn('[view cleanup]', err); }
  }
}

const openOverlays = new Set();
// Returns an unregister function; call it when the overlay closes itself.
function registerOverlay(closeFn) {
  openOverlays.add(closeFn);
  return () => openOverlays.delete(closeFn);
}
function closeAllOverlays() {
  for (const fn of [...openOverlays]) {
    try { fn(); } catch (err) { console.warn('[overlay close]', err); }
  }
  openOverlays.clear();
  // Legacy overlays that predate the registry.
  if (typeof closePostPopover === 'function') closePostPopover();
  document.querySelectorAll('.modal-overlay').forEach((n) => n.remove());
}

// An API call that nobody awaited/caught still tells the operator something
// went wrong instead of failing silently.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const err = event.reason;
    if (err && typeof err === 'object' && 'status' in err) {
      toast(`Something didn't save: ${err.message}`, 'error');
    }
  });
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
    header.appendChild(el('img', { class: 'feed-preview-avatar', src: brand.logo_path, alt: `${brand.name || 'Brand'} logo`, loading: 'lazy', decoding: 'async' }));
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
// guarded reload here. D3: focus/visibility refresh moved to the router
// (refreshLiveView), which calls this when it is set and otherwise refreshes
// views that opted in with markViewLive().
let currentCalendarReload = null;

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
