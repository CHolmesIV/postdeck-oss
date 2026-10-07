// js/40-create.js - D3 Create sheet (docs/DESIGN_WAVE_SPEC.md "Core interactions" 2).
// The one place a new post is written and scheduled. Replaces Quick Compose
// (07) and the full Composer (12); openQuickCompose / renderComposer are thin
// wrappers over openCreateSheet / renderCreateRoute.
//
// Idempotency (audit T8): the sheet keeps a map accountId -> { id, status, ... }.
// The first save POSTs one post per account; every later save PATCHes the same
// ids and only POSTs for accounts added since. Nothing here re-creates a post
// that already exists, and a retry after a partial failure only touches the
// accounts that did not finish.

const CREATE_PLATFORM_NAMES = {
  linkedin: 'LinkedIn', facebook: 'Facebook', twitter: 'X', instagram: 'Instagram',
  tiktok: 'TikTok', reddit: 'Reddit', youtube: 'YouTube', threads: 'Threads', blog: 'Blog',
};
const CREATE_SNAPSHOT_PREFIX = 'pd_create_draft_';
const CREATE_DESELECT_PREFIX = 'pd_create_off_';
const CREATE_DELIVERY_KEY = 'pd_create_delivery';
const CREATE_NET_FIELD_PLATFORMS = ['tiktok', 'reddit', 'blog'];
let CREATE_ACTIVE = null;

// ---------------- small helpers ----------------
function csName(platform) {
  return CREATE_PLATFORM_NAMES[platform] || String(platform || '').replace(/^./, (c) => c.toUpperCase());
}
function csLsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
}
function csLsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable - autosave is best-effort */ }
}
function csLsDel(key) {
  try { localStorage.removeItem(key); } catch { /* best-effort */ }
}
function csPad(n) { return String(n).padStart(2, '0'); }
function csLocalValue(d) {
  return `${d.getFullYear()}-${csPad(d.getMonth() + 1)}-${csPad(d.getDate())}T${csPad(d.getHours())}:${csPad(d.getMinutes())}`;
}
function csTomorrowNine() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}
function csNextWeekdayNine() {
  const d = csTomorrowNine();
  d.setDate(d.getDate() + 1); // strictly after tomorrow so the two chips differ
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d;
}
// prefill.publishAt may be a real ISO instant or a bare local "YYYY-MM-DDTHH:MM" (legacy callers).
function csWhenFromPrefill(prefill) {
  if (prefill.publishAt) {
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(prefill.publishAt)) return prefill.publishAt;
    const d = new Date(prefill.publishAt);
    if (!Number.isNaN(d.getTime())) return csLocalValue(d);
  }
  if (prefill.date) return `${prefill.date}T${prefill.time || '09:00'}`;
  return '';
}
function csFmtWhen(localValue) {
  const d = new Date(localValue);
  if (!localValue || Number.isNaN(d.getTime())) return '';
  const day = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
}
function csResize(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}
function csAccountOff(brandId) { return csLsGet(CREATE_DESELECT_PREFIX + brandId, []); }
function csBrandAccounts(brandId) {
  return state.accounts.filter((a) => String(a.brand_id) === String(brandId) && Number(a.active) !== 0);
}
function csIsConnected(a) { return !isManualAccount(a) && !!a.blotato_account_id; }
function csDefaultSelection(brandId) {
  const accounts = csBrandAccounts(brandId);
  const off = new Set(csAccountOff(brandId));
  let pool = accounts.filter(csIsConnected);
  if (!pool.length) pool = accounts.filter((a) => isManualAccount(a));
  if (!pool.length) pool = accounts;
  return new Set(pool.filter((a) => !off.has(a.id)).map((a) => a.id));
}

// Three-way close prompt built on confirmDialog: Esc and "Keep editing" are the
// safe default, so a stray Escape can never throw work away.
async function csAskKeep() {
  let choice = 'keep';
  const discardBtn = el('button', {
    class: 'button destructive sm cs-dialog-discard',
    type: 'button',
    onclick: (e) => { choice = 'discard'; e.currentTarget.closest('dialog').close('cancel'); },
  }, 'Discard draft');
  const save = await confirmDialog({
    title: 'Keep this draft?',
    body: ['This post is not saved yet.', discardBtn],
    confirmLabel: 'Save draft',
    cancelLabel: 'Keep editing',
  });
  return save ? 'save' : choice;
}

// Legacy hand-offs (sessionStorage keys the old composer consumed) + #/create?query.
function csRoutePrefill(q) {
  const prefill = {};
  if (q.brandId || q.brand) prefill.brandId = q.brandId || q.brand;
  if (q.date) prefill.date = q.date;
  if (q.time) prefill.time = q.time;
  if (q.publishAt) prefill.publishAt = q.publishAt;
  if (q.copy) prefill.copy = q.copy;
  if (q.ideaText) prefill.ideaText = q.ideaText;
  if (q.accountIds) prefill.accountIds = String(q.accountIds).split(',').map(Number).filter(Boolean);
  const take = (key) => {
    let value = null;
    try { value = sessionStorage.getItem(key); sessionStorage.removeItem(key); } catch { value = null; }
    return value;
  };
  const legacyBrand = take('pd_composer_prefill_brand');
  const legacyDate = take('pd_composer_prefill_date');
  const legacyQc = take('pd_composer_qc_prefill');
  const legacyRedraft = take('pd_composer_redraft');
  const focusAi = take('pd_composer_focus_ai');
  if (legacyBrand && !prefill.brandId) prefill.brandId = legacyBrand;
  if (legacyDate && !prefill.publishAt && !prefill.date) prefill.publishAt = legacyDate;
  if (focusAi) prefill.focusIdea = true;
  if (legacyQc) {
    try {
      const qc = JSON.parse(legacyQc);
      if (qc.copy && !prefill.copy) prefill.copy = qc.copy;
      if (Array.isArray(qc.account_ids) && qc.account_ids.length && !prefill.accountIds) prefill.accountIds = qc.account_ids;
    } catch { /* ignore a malformed hand-off */ }
  }
  if (legacyRedraft) {
    try {
      const rd = JSON.parse(legacyRedraft);
      if (rd.brand_id) prefill.brandId = rd.brand_id;
      const acct = state.accounts.find((a) => String(a.brand_id) === String(rd.brand_id) && a.platform === rd.platform);
      if (acct) prefill.accountIds = [acct.id];
      prefill.ideaText = `Write a fresh take on this proven post. Same idea, new angle and hook, do not copy it verbatim:\n\n${rd.copy || ''}`;
      prefill.autoDraft = true;
    } catch { /* ignore */ }
  }
  return prefill;
}

async function renderCreateRoute(view, params) {
  const prefill = csRoutePrefill(routeQuery());
  if (typeof renderPlanner === 'function') await renderPlanner(view, params || []);
  else await renderCalendar(view);
  openCreateSheet(prefill);
}
renderCreateRoute.replacesLegacy = true;

// ---------------- the sheet ----------------
function openCreateSheet(prefill = {}) {
  if (CREATE_ACTIVE) {
    CREATE_ACTIVE.applyPrefill(prefill);
    return CREATE_ACTIVE;
  }
  const opener = document.activeElement;
  const S = {
    brandId: null,
    sel: new Set(),
    idea: prefill.ideaText || '',
    toneName: '',
    provider: sessionDraftProvider || 'claude',
    copy: prefill.copy || '',
    per: {},
    custom: false,
    tab: 'main',
    variants: [],
    active: -1,
    media: [],
    imgOpen: false,
    libOpen: false,
    advOpen: false,
    firstComment: '',
    tagIds: new Set(),
    campaignId: null,
    tagsTouched: false,
    contentType: '',
    pillar: '',
    pf: {},
    delivery: 'draft',
    when: '',
    postIds: new Map(), // accountId -> { id, status, sent, queued }
    busy: false,
    dirty: false,
    ideaId: prefill.ideaId || null,
    tones: [],
    slots: [],
    brandTags: [],
    mediaFiles: [],
    settings: null,
    imgReq: null,
    imgCount: 1,
    imgSize: '',
    previewPlatform: null,
    restoredNote: false,
    suggestions: [],
    quiet: null,
  };
  let brandToken = 0;
  let snapshotTimer = null;
  let quietToken = 0;
  let suggestToken = 0;
  let imgPoll = null;
  let closed = false;

  // ---- derived values ----
  const accountsForBrand = () => csBrandAccounts(S.brandId);
  const selectedAccounts = () => accountsForBrand().filter((a) => S.sel.has(a.id));
  const selectedPlatforms = () => [...new Set(selectedAccounts().map((a) => a.platform))];
  const currentBrand = () => state.brands.find((b) => String(b.id) === String(S.brandId)) || null;
  function ensurePf(platform) {
    if (!S.pf[platform]) {
      S.pf[platform] = {};
      if (platform === 'tiktok') tiktokFieldsEditor(S.pf[platform]); // fills the required defaults
    }
    return S.pf[platform];
  }
  const customActive = () => S.custom && selectedPlatforms().length > 1;
  function copyFor(platform) {
    if (platform === 'reddit') {
      const body = S.pf.reddit && S.pf.reddit.body;
      if (body && body.trim()) return body;
    }
    if (customActive() && S.per[platform] !== undefined) return S.per[platform];
    return S.copy;
  }
  function activeText() {
    return (customActive() && S.tab !== 'main') ? (S.per[S.tab] !== undefined ? S.per[S.tab] : S.copy) : S.copy;
  }
  function setActiveText(value) {
    if (customActive() && S.tab !== 'main') S.per[S.tab] = value;
    else S.copy = value;
    syncVariant();
  }
  function syncVariant() {
    if (S.active >= 0 && S.variants[S.active]) S.variants[S.active] = { ...S.variants[S.active], main: S.copy, per: { ...S.per } };
  }
  function hasContent() {
    return !!(S.idea.trim() || S.copy.trim() || S.media.length || Object.values(S.per).some((t) => String(t).trim()));
  }
  function overLimitInfo() {
    const out = [];
    for (const p of selectedPlatforms()) {
      const limit = textLimitFor(p);
      const len = copyFor(p).length;
      if (limit != null && len > limit) out.push({ platform: p, over: len - limit });
    }
    return out;
  }
  const providerEntry = () => (state.providers || []).find((p) => p.name === S.provider) || null;

  // ---- persistence (autosave snapshot) ----
  const snapshotKey = () => CREATE_SNAPSHOT_PREFIX + S.brandId;
  function writeSnapshot() {
    if (closed || !S.brandId) return;
    if (!hasContent() && !S.postIds.size) { csLsDel(snapshotKey()); return; }
    csLsSet(snapshotKey(), {
      brandId: S.brandId, accountIds: [...S.sel], idea: S.idea, toneName: S.toneName, copy: S.copy, per: S.per,
      custom: S.custom, tab: S.tab, variants: S.variants, active: S.active, delivery: S.delivery, when: S.when,
      media: S.media, firstComment: S.firstComment, tagIds: [...S.tagIds], campaignId: S.campaignId,
      contentType: S.contentType, pillar: S.pillar, pf: S.pf, ideaId: S.ideaId,
      postIds: [...S.postIds.entries()], savedAt: Date.now(),
    });
  }
  function touch() {
    S.dirty = true;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(writeSnapshot, 400);
  }
  function applySnapshot(snap) {
    const valid = new Set(accountsForBrand().map((a) => a.id));
    S.sel = new Set((snap.accountIds || []).filter((id) => valid.has(id)));
    S.idea = snap.idea || '';
    S.toneName = snap.toneName || '';
    S.copy = snap.copy || '';
    S.per = snap.per || {};
    S.custom = !!snap.custom;
    S.tab = snap.tab || 'main';
    S.variants = snap.variants || [];
    S.active = typeof snap.active === 'number' ? snap.active : -1;
    S.delivery = snap.delivery || 'draft';
    S.when = snap.when || '';
    S.media = snap.media || [];
    S.firstComment = snap.firstComment || '';
    S.tagIds = new Set(snap.tagIds || []);
    S.campaignId = snap.campaignId || null;
    S.contentType = snap.contentType || '';
    S.pillar = snap.pillar || '';
    S.pf = snap.pf || {};
    S.ideaId = snap.ideaId || S.ideaId;
    S.postIds = new Map((snap.postIds || []).filter(([id]) => valid.has(id)));
    S.restoredNote = true;
  }

  // ---- DOM skeleton ----
  const titleId = 'cs-title';
  const brandRow = el('div', { class: 'cs-chips', role: 'group', 'aria-label': 'Brand' });
  const acctRow = el('div', { class: 'cs-chips', role: 'group', 'aria-label': 'Post to' });
  const restoredHost = el('div');
  const ideaInput = el('textarea', { class: 'cs-idea', rows: '2', placeholder: 'A rough thought, a link, a story. Draft with AI writes from this.', id: 'cs-idea' });
  const toneSelect = el('select', { class: 'cs-select', 'aria-label': 'Tone' });
  const providerHost = el('div', { class: 'cs-provider' });
  const providerNote = el('span', { class: 'cs-quiet' });
  const draftBtn = el('button', { class: 'button primary sm', type: 'button' }, 'Draft with AI');
  const aiMsg = el('div', { class: 'cs-msg', 'aria-live': 'polite' });
  const variantRow = el('div', { class: 'cs-variants' });
  const customToggle = el('input', { type: 'checkbox', id: 'cs-custom' });
  const customLabel = el('label', { class: 'cs-toggle', for: 'cs-custom' }, [customToggle, el('span', {}, 'Customize per network')]);
  const tabRow = el('div', { class: 'cs-tabs', role: 'tablist' });
  const copyArea = el('textarea', { class: 'cs-copy', rows: '6', placeholder: 'Write the post here, or draft it with AI above.', id: 'cs-copy', 'aria-label': 'Post copy' });
  const countRow = el('div', { class: 'cs-counts', 'aria-live': 'polite' });
  const imgToggle = el('button', { class: 'cs-disclosure', type: 'button', 'aria-expanded': 'false' });
  const imgPanel = el('div', { class: 'cs-panel' });
  const advToggle = el('button', { class: 'cs-disclosure', type: 'button', 'aria-expanded': 'false' });
  const advPanel = el('div', { class: 'cs-panel' });
  const segRow = el('div', { class: 'cs-seg', role: 'radiogroup', 'aria-label': 'Delivery' });
  const deliveryPanel = el('div', { class: 'cs-delivery-panel' });
  const previewTabs = el('div', { class: 'cs-preview-tabs' });
  const previewHost = el('div', { class: 'cs-preview-host' });
  const bannerHost = el('div', { class: 'cs-footer-banner', 'aria-live': 'polite' });
  const summaryEl = el('div', { class: 'cs-summary' });
  const primaryBtn = el('button', { class: 'button primary md cs-primary', type: 'button' }, 'Save draft');
  const closeBtn = el('button', { class: 'cs-close', type: 'button', 'aria-label': 'Close', title: 'Close (Esc)' }, '\u2715');

  const editorCol = el('div', { class: 'cs-editor' }, [
    restoredHost,
    el('section', { class: 'cs-section' }, [el('div', { class: 'cs-label' }, 'Brand'), brandRow]),
    el('section', { class: 'cs-section' }, [el('div', { class: 'cs-label' }, 'Post to'), acctRow]),
    el('section', { class: 'cs-section' }, [
      el('label', { class: 'cs-label', for: 'cs-idea' }, "What's the post about?"),
      ideaInput,
      el('div', { class: 'cs-ai-row' }, [
        el('div', { class: 'cs-field-inline' }, [el('label', { for: 'cs-tone', class: 'cs-quiet' }, 'Tone'), toneSelect]),
        providerHost,
        draftBtn,
      ]),
      providerNote,
      aiMsg,
    ]),
    el('section', { class: 'cs-section' }, [
      el('div', { class: 'cs-label-row' }, [el('label', { class: 'cs-label', for: 'cs-copy' }, 'Post'), customLabel]),
      variantRow,
      tabRow,
      copyArea,
      countRow,
    ]),
    el('section', { class: 'cs-section cs-collapsible' }, [imgToggle, imgPanel]),
    el('section', { class: 'cs-section cs-collapsible' }, [advToggle, advPanel]),
    el('section', { class: 'cs-section' }, [el('div', { class: 'cs-label' }, 'When'), segRow, deliveryPanel]),
  ]);
  toneSelect.id = 'cs-tone';
  const previewCol = el('aside', { class: 'cs-preview', 'aria-label': 'Preview' }, [
    el('div', { class: 'cs-label' }, 'Preview'),
    previewTabs,
    previewHost,
  ]);
  const body = el('div', { class: 'cs-body' }, [el('div', { class: 'cs-cols' }, [editorCol, previewCol])]);
  const footer = el('footer', { class: 'cs-footer' }, [bannerHost, el('div', { class: 'cs-footer-row' }, [summaryEl, primaryBtn])]);
  const sheet = el('div', { class: 'cs-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabindex: '-1' }, [
    el('header', { class: 'cs-header' }, [el('h2', { id: titleId }, 'New post'), closeBtn]),
    body,
    footer,
  ]);
  const scrim = el('div', { class: 'cs-scrim' }, [sheet]);

  // ---- render functions ----
  function renderBrandChips() {
    brandRow.innerHTML = '';
    const locked = S.postIds.size > 0;
    for (const b of state.brands) {
      const active = String(b.id) === String(S.brandId);
      const chip = el('button', {
        type: 'button',
        class: 'cs-chip' + (active ? ' is-on' : ''),
        'aria-pressed': active ? 'true' : 'false',
        title: locked && !active ? 'This post is already saved for the current brand. Start a new post to change brands.' : '',
        onclick: () => switchBrand(b.id),
      }, b.name);
      if (locked && !active) chip.disabled = true;
      brandRow.appendChild(chip);
    }
  }

  function renderAccountChips() {
    acctRow.innerHTML = '';
    const accounts = accountsForBrand();
    if (!accounts.length) {
      acctRow.appendChild(el('span', { class: 'cs-quiet' }, 'No active accounts for this brand. Add one in Settings, then come back.'));
      return;
    }
    const perPlatform = {};
    for (const a of accounts) perPlatform[a.platform] = (perPlatform[a.platform] || 0) + 1;
    for (const a of accounts) {
      const on = S.sel.has(a.id);
      const manual = isManualAccount(a);
      const note = manual ? 'assisted' : (csIsConnected(a) ? '' : 'not connected');
      const label = csName(a.platform) + (perPlatform[a.platform] > 1 ? ` #${a.id}` : '');
      acctRow.appendChild(el('button', {
        type: 'button',
        class: 'cs-chip cs-acct' + (on ? ' is-on' : ''),
        'aria-pressed': on ? 'true' : 'false',
        title: manual ? 'Assisted posting: PostDeck prepares it, you paste it in.' : (note ? 'No Blotato connection on this account yet.' : 'Connected through Blotato'),
        onclick: () => toggleAccount(a.id),
      }, [platformIcon(a.platform, { size: 14 }), el('span', {}, label), note ? el('span', { class: 'cs-chip-note' }, note) : null]));
    }
  }

  function renderProvider() {
    providerHost.innerHTML = '';
    if (typeof providerSwitch === 'function' && aiProviders().length > 1) {
      providerHost.appendChild(providerSwitch(S.provider, (v) => { S.provider = v; sessionDraftProvider = v; renderProviderNote(); }));
    }
    renderProviderNote();
  }
  function renderProviderNote() {
    const p = providerEntry();
    const label = providerLabel(S.provider);
    let text = '';
    if (p) {
      const st = p.status || {};
      if (p.kind === 'http') text = p.configured ? `${label} is ready.` : `${label} needs an API key in Settings.`;
      else if (st.installed === false) text = `${label} is not installed on this Mac.`;
      else if (st.loggedIn === false) text = `${label} is not signed in. Run its login in Terminal, then try again.`;
      else text = `${label} is ready.`;
    }
    providerNote.textContent = text;
  }

  function renderTone() {
    toneSelect.innerHTML = '';
    if (!S.tones.length) {
      toneSelect.appendChild(el('option', { value: '' }, 'No tone profiles'));
      toneSelect.disabled = true;
      return;
    }
    toneSelect.disabled = false;
    for (const t of S.tones) {
      const opt = el('option', { value: t.name }, t.name);
      if (t.name === S.toneName) opt.selected = true;
      toneSelect.appendChild(opt);
    }
  }

  function renderVariants() {
    variantRow.innerHTML = '';
    if (S.variants.length < 2) return;
    variantRow.appendChild(el('span', { class: 'cs-quiet' }, 'Versions'));
    S.variants.forEach((v, i) => {
      variantRow.appendChild(el('button', {
        type: 'button',
        class: 'cs-chip cs-chip-sm' + (i === S.active ? ' is-on' : ''),
        'aria-pressed': i === S.active ? 'true' : 'false',
        onclick: () => loadVariant(i),
      }, v.label || `v${i + 1}`));
    });
  }

  function renderTabs() {
    const platforms = selectedPlatforms();
    const show = platforms.length > 1;
    customLabel.hidden = !show;
    tabRow.hidden = !(show && S.custom);
    tabRow.innerHTML = '';
    if (!show) S.tab = 'main';
    if (!show || !S.custom) return;
    if (S.tab !== 'main' && !platforms.includes(S.tab)) S.tab = 'main';
    const defs = [{ key: 'main', label: 'Main' }, ...platforms.map((p) => ({ key: p, label: csName(p) }))];
    for (const t of defs) {
      tabRow.appendChild(el('button', {
        type: 'button', role: 'tab',
        class: 'cs-tab' + (t.key === S.tab ? ' is-on' : ''),
        'aria-selected': t.key === S.tab ? 'true' : 'false',
        onclick: () => openTab(t.key),
      }, [t.key === 'main' ? null : platformIcon(t.key, { size: 13 }), el('span', {}, t.label)]));
    }
  }

  function renderCounts() {
    countRow.innerHTML = '';
    const platforms = selectedPlatforms();
    if (!platforms.length) {
      countRow.appendChild(el('span', { class: 'cs-quiet' }, `${S.copy.length} characters`));
      return;
    }
    for (const p of platforms) {
      const limit = textLimitFor(p);
      const len = copyFor(p).length;
      const over = limit != null && len > limit;
      countRow.appendChild(el('span', {
        class: 'cs-count' + (over ? ' is-over' : ''),
        title: limit == null ? `${csName(p)} has no character limit` : `${csName(p)} allows ${limit} characters`,
      }, `${csName(p)} ${len}${limit == null ? '' : ` / ${limit}`}`));
    }
  }

  function renderPreview() {
    const platforms = selectedPlatforms();
    previewTabs.innerHTML = '';
    previewHost.innerHTML = '';
    if (!platforms.length) {
      previewHost.appendChild(el('div', { class: 'cs-quiet cs-preview-empty' }, 'Pick an account to see how the post will look.'));
      return;
    }
    let platform = (customActive() && S.tab !== 'main') ? S.tab : S.previewPlatform;
    if (!platforms.includes(platform)) platform = platforms[0];
    S.previewPlatform = platform;
    if (platforms.length > 1) {
      for (const p of platforms) {
        previewTabs.appendChild(el('button', {
          type: 'button',
          class: 'cs-tab' + (p === platform ? ' is-on' : ''),
          'aria-pressed': p === platform ? 'true' : 'false',
          onclick: () => { S.previewPlatform = p; if (customActive()) openTab(p); else renderPreview(); },
        }, [platformIcon(p, { size: 13 }), el('span', {}, csName(p))]));
      }
    }
    const mediaUrl = S.media[0] ? (S.media[0].url || `/${S.media[0].path}`) : null;
    previewHost.appendChild(renderPostPreview(platform, { copy: copyFor(platform), mediaUrl, brand: currentBrand() }));
    if (S.firstComment.trim()) {
      previewHost.appendChild(el('div', { class: 'feed-preview-first-comment' }, [
        el('span', { class: 'feed-preview-first-comment-label' }, 'first comment'),
        el('span', {}, S.firstComment.trim()),
      ]));
    }
  }

  function renderImages() {
    imgToggle.innerHTML = '';
    imgToggle.setAttribute('aria-expanded', S.imgOpen ? 'true' : 'false');
    imgToggle.append(...[
      el('span', { class: 'cs-disc-caret', 'aria-hidden': 'true' }, S.imgOpen ? '\u25BE' : '\u25B8'),
      el('span', {}, 'Images'),
      S.media.length ? el('span', { class: 'cs-badge' }, String(S.media.length)) : null,
    ].filter(Boolean));
    imgPanel.hidden = !S.imgOpen;
    if (!S.imgOpen) return;
    imgPanel.innerHTML = '';
    if (S.media.length) {
      const list = el('div', { class: 'cs-media-list' });
      S.media.forEach((m, i) => {
        const alt = el('input', { class: 'cs-input', placeholder: 'Alt text for screen readers', 'aria-label': `Alt text for image ${i + 1}`, value: m.altText || '' });
        alt.addEventListener('input', () => { m.altText = alt.value; touch(); });
        list.appendChild(el('div', { class: 'cs-media-item' }, [
          el('img', { src: m.url || `/${m.path}`, alt: '', loading: 'lazy' }),
          alt,
          el('button', {
            class: 'button ghost sm', type: 'button', 'aria-label': `Remove image ${i + 1}`,
            onclick: () => { S.media.splice(i, 1); touch(); renderImages(); renderPreview(); },
          }, 'Remove'),
        ]));
      });
      imgPanel.appendChild(list);
    }
    const fileInput = el('input', { type: 'file', accept: 'image/*', hidden: 'hidden', 'aria-label': 'Upload an image' });
    fileInput.addEventListener('change', () => { if (fileInput.files && fileInput.files[0]) uploadFile(fileInput.files[0]); fileInput.value = ''; });
    const sizeSel = el('select', { class: 'cs-select', 'aria-label': 'Image shape' }, [
      ['', 'Any shape'], ['square', 'Square'], ['portrait', 'Portrait 4:5'], ['landscape', 'Landscape'], ['vertical', 'Vertical 9:16'],
    ].map(([v, l]) => el('option', { value: v, selected: S.imgSize === v ? 'selected' : undefined }, l)));
    sizeSel.addEventListener('change', () => { S.imgSize = sizeSel.value; });
    const countSel = el('select', { class: 'cs-select', 'aria-label': 'Image variants' }, [1, 2, 3, 4].map((n) =>
      el('option', { value: String(n), selected: S.imgCount === n ? 'selected' : undefined }, `${n} variant${n > 1 ? 's' : ''}`)));
    countSel.addEventListener('change', () => { S.imgCount = Number(countSel.value) || 1; });
    imgPanel.appendChild(el('div', { class: 'cs-btn-row' }, [
      el('button', { class: 'button secondary sm', type: 'button', onclick: () => { S.libOpen = !S.libOpen; renderImages(); } }, 'From library'),
      el('button', { class: 'button secondary sm', type: 'button', onclick: () => fileInput.click() }, 'Upload'),
      el('button', { class: 'button secondary sm', type: 'button', id: 'cs-request-image', onclick: requestImage }, 'Request image (Codex)'),
      el('button', { class: 'button ghost sm', type: 'button', onclick: () => openImagePromptModal() }, 'Edit image prompts'),
      fileInput,
    ]));
    imgPanel.appendChild(el('div', { class: 'cs-btn-row cs-btn-row-quiet' }, [sizeSel, countSel]));
    if (S.libOpen) {
      const images = S.mediaFiles.filter((f) => /\.(png|jpe?g|gif|webp)$/i.test(f.filename));
      const grid = el('div', { class: 'cs-lib-grid' });
      if (!images.length) grid.appendChild(el('div', { class: 'cs-quiet' }, 'No images in the library yet. Upload one or request one from Codex.'));
      for (const f of images) {
        grid.appendChild(el('button', {
          type: 'button', class: 'cs-lib-tile', title: f.filename, 'aria-label': `Attach ${f.filename}`,
          onclick: () => { attachImage({ path: f.path, url: f.url, altText: '' }); S.libOpen = false; renderImages(); },
        }, el('img', { src: f.url, alt: '', loading: 'lazy' })));
      }
      imgPanel.appendChild(grid);
    }
    if (S.imgReq) imgPanel.appendChild(renderImageRequest());
  }

  function renderImageRequest() {
    const r = S.imgReq;
    const variants = Array.isArray(r.variants) ? r.variants : [];
    const box = el('div', { class: 'cs-imgreq' });
    if (r.chosen_path || r.status === 'canceled') return box;
    if (variants.length) {
      box.appendChild(el('div', { class: 'cs-quiet' }, 'Codex finished. Pick the one to use.'));
      const grid = el('div', { class: 'cs-lib-grid' });
      for (const v of variants) {
        grid.appendChild(el('button', {
          type: 'button', class: 'cs-lib-tile', 'aria-label': 'Use this image',
          onclick: async () => {
            try {
              const row = await api(`/api/image-requests/${r.id}/pick`, { method: 'POST', body: { chosen_path: v.path } });
              S.imgReq = row;
              clearInterval(imgPoll);
              attachImage({ path: v.path, url: v.url || `/${v.path}`, altText: '' });
              renderImages();
            } catch (err) { showBanner(`Could not use that image: ${err.message}`, 'error'); }
          },
        }, el('img', { src: v.url || `/${v.path}`, alt: '', loading: 'lazy' })));
      }
      box.appendChild(grid);
    } else {
      box.appendChild(el('div', { class: 'cs-quiet' }, 'Waiting on Codex. Run the image handoff and this fills in by itself.'));
      box.appendChild(el('button', {
        class: 'button ghost sm', type: 'button',
        onclick: async () => {
          try { await api(`/api/image-requests/${r.id}/cancel`, { method: 'POST' }); } catch { /* clear the placeholder regardless */ }
          S.imgReq = null; clearInterval(imgPoll); renderImages();
        },
      }, 'Cancel request'));
    }
    return box;
  }

  function renderAdvanced() {
    advToggle.innerHTML = '';
    advToggle.setAttribute('aria-expanded', S.advOpen ? 'true' : 'false');
    const used = [S.firstComment.trim(), S.tagIds.size, S.campaignId, S.contentType].filter(Boolean).length;
    advToggle.append(...[
      el('span', { class: 'cs-disc-caret', 'aria-hidden': 'true' }, S.advOpen ? '\u25BE' : '\u25B8'),
      el('span', {}, 'Advanced'),
      used ? el('span', { class: 'cs-badge' }, String(used)) : null,
    ].filter(Boolean));
    advPanel.hidden = !S.advOpen;
    if (!S.advOpen) return;
    advPanel.innerHTML = '';

    const fc = el('input', { class: 'cs-input', placeholder: 'https://... a link or note that posts as the first comment', id: 'cs-first-comment', value: S.firstComment });
    fc.addEventListener('input', () => { S.firstComment = fc.value; touch(); renderPreview(); });
    advPanel.appendChild(el('div', { class: 'cs-field' }, [el('label', { for: 'cs-first-comment' }, 'First comment'), fc]));

    const ct = el('select', { class: 'cs-select', id: 'cs-ctype' }, [
      el('option', { value: '' }, 'Not set'),
      ...['static', 'carousel', 'image', 'text', 'video'].map((t) => el('option', { value: t, selected: S.contentType === t ? 'selected' : undefined }, t)),
    ]);
    const ctHint = el('span', { class: 'cs-quiet' });
    ct.addEventListener('change', () => { S.contentType = ct.value; touch(); renderAdvancedBadge(); });
    const pillar = el('input', { class: 'cs-input', id: 'cs-pillar', placeholder: 'Content pillar (optional)', value: S.pillar });
    pillar.addEventListener('input', () => { S.pillar = pillar.value; touch(); });
    pillar.addEventListener('change', () => suggestContentType(ctHint));
    advPanel.appendChild(el('div', { class: 'cs-field-grid' }, [
      el('div', { class: 'cs-field' }, [el('label', { for: 'cs-ctype' }, 'Content type'), ct, ctHint]),
      el('div', { class: 'cs-field' }, [el('label', { for: 'cs-pillar' }, 'Pillar'), pillar]),
    ]));
    suggestContentType(ctHint);

    advPanel.appendChild(renderTagPickers('tag', 'Tags'));
    advPanel.appendChild(renderTagPickers('campaign', 'Campaign (one)'));

    const netPlatforms = selectedPlatforms().filter((p) => CREATE_NET_FIELD_PLATFORMS.includes(p));
    for (const p of netPlatforms) {
      const fields = ensurePf(p);
      let editor;
      if (p === 'tiktok') editor = tiktokFieldsEditor(fields);
      else if (p === 'reddit') {
        editor = redditFieldsEditor(fields);
      } else editor = blogFieldsEditor(fields, S.mediaFiles);
      editor.addEventListener('input', () => { touch(); renderCounts(); renderPreview(); });
      advPanel.appendChild(el('div', { class: 'cs-field' }, [el('div', { class: 'cs-label' }, `${csName(p)} fields`), editor]));
    }
  }
  function renderAdvancedBadge() { renderAdvanced(); }

  async function suggestContentType(hostEl) {
    const platform = selectedPlatforms()[0];
    if (!platform || !hostEl) return;
    try {
      const qs = new URLSearchParams({ brand_id: S.brandId, platform });
      if (S.pillar) qs.set('pillar', S.pillar);
      const rec = await api(`/api/recommend/content-type?${qs.toString()}`);
      if (rec && rec.suggestion) hostEl.textContent = `Suggested: ${rec.suggestion}`;
    } catch { /* the recommender is a convenience, never a blocker */ }
  }

  function renderTagPickers(kind, label) {
    const wrap = el('div', { class: 'cs-field' });
    wrap.appendChild(el('div', { class: 'cs-label' }, label));
    const row = el('div', { class: 'cs-chips' });
    for (const t of S.brandTags.filter((x) => x.kind === kind)) {
      const on = kind === 'tag' ? S.tagIds.has(t.id) : S.campaignId === t.id;
      row.appendChild(el('button', {
        type: 'button', class: 'cs-chip cs-chip-sm' + (on ? ' is-on' : ''), 'aria-pressed': on ? 'true' : 'false',
        onclick: () => {
          S.tagsTouched = true;
          if (kind === 'tag') { on ? S.tagIds.delete(t.id) : S.tagIds.add(t.id); } else S.campaignId = on ? null : t.id;
          touch(); renderAdvanced();
        },
      }, [el('span', { class: 'cs-dot', style: `background:${t.color || 'var(--faint)'}` }), el('span', {}, t.name)]));
    }
    const add = el('input', { class: 'cs-input cs-input-sm', placeholder: kind === 'tag' ? '+ new tag' : '+ new campaign', 'aria-label': `New ${kind}` });
    add.addEventListener('keydown', async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const name = add.value.trim();
      if (!name) return;
      try {
        const row2 = await api('/api/tags', { method: 'POST', body: { name, kind, color: typeof nextTagColor === 'function' ? nextTagColor() : null, brand_id: Number(S.brandId) } });
        S.brandTags.push(row2);
        S.tagsTouched = true;
        if (kind === 'tag') S.tagIds.add(row2.id); else S.campaignId = row2.id;
        touch(); renderAdvanced();
      } catch (err) { showBanner(`Could not create ${kind}: ${err.message}`, 'error'); }
    });
    row.appendChild(add);
    wrap.appendChild(row);
    return wrap;
  }

  function hasQueue() { return S.slots.some((s) => Number(s.active) !== 0); }

  function renderDelivery() {
    if (S.delivery === 'queue' && !hasQueue()) S.delivery = 'draft';
    segRow.innerHTML = '';
    const opts = [['draft', 'Draft'], ['schedule', 'Schedule']];
    if (hasQueue()) opts.push(['queue', 'Next open slot']);
    opts.push(['now', 'Post now']);
    for (const [value, label] of opts) {
      const on = S.delivery === value;
      segRow.appendChild(el('button', {
        type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false',
        class: 'cs-seg-btn' + (on ? ' is-on' : '') + (value === 'now' ? ' is-now' : ''),
        onclick: () => {
          S.delivery = value;
          if (value !== 'now') csLsSet(CREATE_DELIVERY_KEY, value);
          touch(); renderDelivery(); renderFooter(); loadSuggestions(); checkQuiet();
        },
      }, label));
    }
    deliveryPanel.innerHTML = '';
    if (S.delivery === 'draft') {
      deliveryPanel.appendChild(el('p', { class: 'cs-quiet cs-note' }, 'Saved to the Planner drafts tray with no time. Schedule it later.'));
    } else if (S.delivery === 'queue') {
      deliveryPanel.appendChild(el('p', { class: 'cs-quiet cs-note' }, "Goes in the first open slot on this brand's posting schedule. Each network gets its own next slot."));
    } else if (S.delivery === 'now') {
      deliveryPanel.appendChild(el('p', { class: 'cs-note cs-now-note' }, 'Publishes straight away. You will be asked to confirm, and it says whether this is live or a dry run.'));
    } else {
      const input = el('input', { type: 'datetime-local', class: 'cs-input cs-when', id: 'cs-when', 'aria-label': 'Publish date and time', value: S.when });
      input.addEventListener('input', () => { S.when = input.value; touch(); renderFooter(); checkQuiet(); });
      const chips = el('div', { class: 'cs-chips', id: 'cs-time-chips' });
      for (const sug of S.suggestions) {
        chips.appendChild(el('button', {
          type: 'button', class: 'cs-chip cs-chip-sm' + (S.when === sug.value ? ' is-on' : ''),
          onclick: () => { S.when = sug.value; touch(); renderDelivery(); renderFooter(); checkQuiet(); },
        }, sug.label));
      }
      deliveryPanel.appendChild(el('div', { class: 'cs-when-row' }, [input, chips]));
      deliveryPanel.appendChild(el('div', { class: 'cs-quiet-host', id: 'cs-quiet-host' }));
      renderQuiet();
    }
  }

  function renderQuiet() {
    const host = document.getElementById('cs-quiet-host');
    if (!host) return;
    host.innerHTML = '';
    if (S.delivery === 'schedule' && S.quiet && S.quiet.within_quiet_hours) {
      host.appendChild(el('div', { class: 'cs-warn', role: 'status' },
        `That time falls in quiet hours (${S.quiet.quiet_start} to ${S.quiet.quiet_end}). You can still schedule it, or pick another time.`));
    }
  }

  async function checkQuiet() {
    S.quiet = null;
    renderQuiet();
    if (S.delivery !== 'schedule' || !S.when) return;
    const d = new Date(S.when);
    if (Number.isNaN(d.getTime())) return;
    const token = ++quietToken;
    try {
      const res = await api(`/api/settings/quiet-hours-check?publish_at=${encodeURIComponent(d.toISOString())}`);
      if (token !== quietToken) return;
      S.quiet = res;
      renderQuiet();
    } catch { /* the warning is best-effort; it never blocks scheduling */ }
  }

  async function loadSuggestions() {
    if (S.delivery !== 'schedule') return;
    const token = ++suggestToken;
    const found = [];
    const platform = selectedPlatforms()[0];
    if (platform && typeof nextMatchingDatetimeLocal === 'function') {
      try {
        const data = await api(`/api/best-times?brand_id=${S.brandId}&platform=${platform}`);
        for (const band of (data.bands || []).slice(0, 3)) {
          const next = nextMatchingDatetimeLocal(band);
          if (!next) continue;
          const value = dateToLocalInputValue(next);
          if (!found.some((f) => f.value === value)) found.push({ value, label: `Best: ${csFmtWhen(value).replace(' at ', ' ')}` });
        }
      } catch { /* fall back to the plain presets below */ }
    }
    if (token !== suggestToken) return;
    const fallbacks = [
      { value: csLocalValue(csTomorrowNine()), label: 'Tomorrow 9 AM' },
      { value: csLocalValue(csNextWeekdayNine()), label: 'Next weekday 9 AM' },
    ];
    const todayFive = new Date();
    todayFive.setHours(17, 0, 0, 0);
    if (todayFive.getTime() > Date.now() + 30 * 60000) fallbacks.push({ value: csLocalValue(todayFive), label: 'Today 5 PM' });
    for (const f of fallbacks) {
      if (found.length >= 3) break;
      if (!found.some((x) => x.value === f.value)) found.push(f);
    }
    S.suggestions = found.slice(0, 3);
    if (S.delivery === 'schedule') renderDelivery();
  }

  function primaryLabel() {
    const n = selectedAccounts().length;
    if (S.delivery === 'schedule') return `Schedule ${n || ''} ${n === 1 ? 'post' : 'posts'}`.replace(/\s+/g, ' ').trim();
    if (S.delivery === 'queue') return 'Add to queue';
    if (S.delivery === 'now') return 'Post now';
    return 'Save draft';
  }

  function renderFooter() {
    const accts = selectedAccounts();
    const names = [...new Set(accts.map((a) => csName(a.platform)))].join(' + ');
    const brand = currentBrand();
    let tail = '';
    if (S.delivery === 'schedule') tail = S.when ? `, ${csFmtWhen(S.when)}` : ', pick a time';
    else if (S.delivery === 'queue') tail = ', next open slot';
    else if (S.delivery === 'now') tail = ', right now';
    else tail = ', saved as draft';
    summaryEl.textContent = accts.length
      ? `${names}${brand ? ` for ${brand.name}` : ''}${tail}`
      : 'Pick at least one account to post to.';
    primaryBtn.textContent = primaryLabel();
    primaryBtn.classList.toggle('destructive', S.delivery === 'now');
    primaryBtn.classList.toggle('primary', S.delivery !== 'now');
    primaryBtn.disabled = S.busy;
    primaryBtn.classList.toggle('is-pending', S.busy);
    draftBtn.disabled = S.busy;
    closeBtn.disabled = false;
  }

  function renderRestored() {
    restoredHost.innerHTML = '';
    if (!S.restoredNote) return;
    restoredHost.appendChild(el('div', { class: 'cs-restored' }, [
      el('span', {}, 'Picked up your unsaved draft from last time.'),
      el('button', { class: 'button ghost sm', type: 'button', onclick: () => discardAll({ keepOpen: true }) }, 'Start over'),
    ]));
  }

  function showBanner(msg, kind = 'error', extra = null) {
    bannerHost.innerHTML = '';
    if (!msg) return;
    const box = el('div', { class: `cs-banner cs-banner-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, [el('div', {}, msg)]);
    if (extra) box.appendChild(extra);
    bannerHost.appendChild(box);
  }

  function setCopyValue() {
    copyArea.value = activeText();
    csResize(copyArea);
  }

  function updateAll() {
    renderCounts();
    renderPreview();
    renderFooter();
  }

  // ---- interactions ----
  function toggleAccount(id) {
    if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
    const off = new Set(csAccountOff(S.brandId));
    if (S.sel.has(id)) off.delete(id); else off.add(id);
    csLsSet(CREATE_DESELECT_PREFIX + S.brandId, [...off]);
    touch();
    renderAccountChips(); renderTabs(); renderAdvanced(); updateAll(); loadSuggestions();
  }

  function openTab(key) {
    S.tab = key;
    if (key !== 'main' && S.per[key] === undefined) S.per[key] = S.copy; // seeded from main when first opened
    syncVariant();
    renderTabs(); setCopyValue(); renderCounts(); renderPreview();
  }

  function loadVariant(i) {
    const v = S.variants[i];
    if (!v) return;
    S.active = i;
    S.copy = v.main || '';
    S.per = { ...(v.per || {}) };
    renderVariants(); renderTabs(); setCopyValue(); touch(); updateAll();
  }

  async function loadBrandData() {
    const token = ++brandToken;
    const brandId = S.brandId;
    const [tones, slots, tags, settings] = await Promise.all([
      api(`/api/tone-profiles?brand_id=${brandId}`).catch(() => []),
      api(`/api/queue-slots?brand_id=${brandId}`).catch(() => []),
      api(`/api/tags?brand_id=${brandId}`).catch(() => []),
      S.settings ? Promise.resolve(S.settings) : api('/api/settings').catch(() => ({})),
    ]);
    if (token !== brandToken || closed) return;
    S.settings = settings;
    S.tones = Array.isArray(tones) ? tones : [];
    S.slots = Array.isArray(slots) ? slots : [];
    S.brandTags = Array.isArray(tags) ? tags : [];
    if (!S.settings.__providerApplied) {
      if (!sessionDraftProvider && S.settings.draft_provider === 'codex') S.provider = 'codex';
      S.settings.__providerApplied = true;
    }
    const preferred = S.toneName || S.settings[`brand_${brandId}_default_tone`] || 'business';
    const match = S.tones.find((t) => t.name === preferred) || S.tones[0];
    S.toneName = match ? match.name : '';
    renderTone(); renderProvider(); renderAdvanced(); renderDelivery(); renderFooter();
    loadSuggestions(); checkQuiet();
  }

  function switchBrand(id) {
    if (String(id) === String(S.brandId) || S.postIds.size) return;
    clearTimeout(snapshotTimer);
    csLsDel(snapshotKey()); // content moves with the sheet; do not leave a stale copy under the old brand
    S.brandId = id;
    setStickyBrand(id);
    S.sel = csDefaultSelection(id);
    S.tab = 'main';
    S.tagIds = new Set(); S.campaignId = null; S.tones = []; S.slots = []; S.brandTags = [];
    S.toneName = '';
    renderBrandChips(); renderAccountChips(); renderTabs(); renderTone(); renderAdvanced(); renderDelivery();
    updateAll();
    touch();
    loadBrandData();
  }

  async function uploadFile(file) {
    showBanner('');
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await api('/api/media', { method: 'POST', body: fd });
      S.mediaFiles.push({ filename: res.filename, path: res.path, url: res.url });
      attachImage({ path: res.path, url: res.url, altText: '' });
      renderImages();
    } catch (err) {
      showBanner(`Could not upload that file: ${err.message}. Check it is an image under the size limit and try again.`, 'error');
    }
  }
  function attachImage(img) {
    if (!S.media.some((m) => m.path === img.path)) S.media.push(img);
    touch(); renderImages(); renderPreview();
  }

  async function requestImage() {
    showBanner('');
    if (!selectedAccounts().length) { showBanner('Pick at least one account first so Codex knows the shape to make.', 'error'); return; }
    if (S.busy) return;
    try {
      // Image requests attach to a post. Use the same accountId -> postId map as
      // Save so a later Schedule updates these posts instead of duplicating them.
      const out = await syncPosts('draft', { silent: true });
      const firstOk = out.find((r) => r.ok);
      if (!firstOk) { showBanner(`Could not save a draft for the image request: ${out[0] ? out[0].error : 'no account'}.`, 'error'); return; }
      const hints = {};
      if (S.imgSize) hints.size = S.imgSize;
      const res = await api('/api/image-requests', {
        method: 'POST',
        body: {
          brand_id: Number(S.brandId), post_id: firstOk.id, platforms: selectedPlatforms(),
          content_type: S.contentType || null, copy: copyFor(selectedPlatforms()[0]), variant_count: S.imgCount, hints,
        },
      });
      S.imgReq = res;
      touch();
      startImgPoll();
      renderImages(); renderBrandChips();
    } catch (err) {
      showBanner(`Could not request the image: ${err.message}`, 'error');
    }
  }
  function startImgPoll() {
    clearInterval(imgPoll);
    imgPoll = setInterval(async () => {
      if (!S.imgReq || closed) { clearInterval(imgPoll); return; }
      try {
        const row = await api(`/api/image-requests/${S.imgReq.id}`);
        S.imgReq = row;
        const done = row.status && row.status !== 'requested' && row.status !== 'pending';
        if (done) clearInterval(imgPoll);
        if (S.imgOpen) renderImages();
      } catch { /* try again next tick */ }
    }, 4000);
  }

  async function runDraft() {
    aiMsg.innerHTML = '';
    const platforms = selectedPlatforms();
    if (!platforms.length) { aiMsg.appendChild(el('div', { class: 'cs-banner cs-banner-error' }, 'Pick at least one account to draft for.')); return; }
    if (!S.idea.trim() && S.copy.trim()) { S.idea = S.copy.trim(); ideaInput.value = S.idea; csResize(ideaInput); }
    if (!S.idea.trim()) { aiMsg.appendChild(el('div', { class: 'cs-banner cs-banner-error' }, 'Write a line about the post first, then draft.')); ideaInput.focus(); return; }
    const tone = S.tones.find((t) => t.name === S.toneName);
    if (!tone) { aiMsg.appendChild(el('div', { class: 'cs-banner cs-banner-error' }, 'This brand has no tone profile yet. Add one in Settings, Brands, then draft again.')); return; }
    draftBtn.disabled = true;
    draftBtn.classList.add('is-pending');
    draftBtn.textContent = S.variants.length ? 'Drafting another...' : 'Drafting...';
    try {
      const result = await api('/api/draft', {
        method: 'POST',
        body: { idea_text: S.idea.trim(), brand_id: Number(S.brandId), tone_profile_id: tone.id, platforms, provider: S.provider },
      });
      const drafts = result.drafts || {};
      const main = drafts[platforms[0]] !== undefined ? drafts[platforms[0]] : Object.values(drafts)[0];
      if (!main) { aiMsg.appendChild(el('div', { class: 'cs-banner cs-banner-error' }, 'The AI returned nothing. Try again, or switch provider.')); return; }
      if (!S.variants.length && S.copy.trim()) S.variants.push({ main: S.copy, per: { ...S.per }, label: 'Mine' });
      const per = {};
      if (customActive()) for (const p of platforms) if (drafts[p] !== undefined) per[p] = drafts[p]; // every network keeps its own draft
      S.variants.push({ main, per });
      loadVariant(S.variants.length - 1);
      aiMsg.appendChild(el('div', { class: 'cs-banner cs-banner-ok' },
        S.variants.length > 1 ? 'New version added. Use the version chips to compare.' : 'Draft added. Edit it freely, or draft again for another version.'));
    } catch (err) {
      const label = providerLabel(S.provider);
      const hint = err.status === 503
        ? `${label} is not available right now (${err.message}). Sign in to it in Terminal, or switch provider, then try again.`
        : `Drafting failed: ${err.message}. Try again in a moment.`;
      aiMsg.appendChild(el('div', { class: 'cs-banner cs-banner-error' }, hint));
    } finally {
      draftBtn.classList.remove('is-pending');
      draftBtn.textContent = 'Draft with AI';
      draftBtn.disabled = S.busy;
    }
  }

  // ---- save engine (idempotent) ----
  function bodyFor(acct) {
    const fields = ensurePf(acct.platform);
    const tone = S.tones.find((t) => t.name === S.toneName);
    return {
      copy: copyFor(acct.platform),
      platform_fields: fields,
      content_type: S.contentType || null,
      media: S.media.map((m) => ({ path: m.path, altText: m.altText || '' })),
      first_comment: S.firstComment.trim() || null,
      tone_profile_id: tone ? tone.id : undefined,
    };
  }

  async function removeStale() {
    // Accounts deselected after their post was created here: delete the draft
    // (walking it back to draft first if needed). Only posts this sheet made.
    const notes = [];
    for (const [acctId, entry] of [...S.postIds.entries()]) {
      if (S.sel.has(acctId)) continue;
      try {
        if (entry.status && entry.status !== 'draft') {
          await api(`/api/posts/${entry.id}`, { method: 'PATCH', body: { status: 'draft', publish_at: null } });
        }
        await api(`/api/posts/${entry.id}`, { method: 'DELETE' });
        S.postIds.delete(acctId);
      } catch (err) {
        if (err.status === 404) S.postIds.delete(acctId);
        else notes.push(`${csName((state.accounts.find((a) => a.id === acctId) || {}).platform)}: ${err.message}`);
      }
    }
    return notes;
  }

  // mode: 'draft' | 'schedule' | 'queue' | 'now'. Returns [{ acct, ok, id, error }].
  async function syncPosts(mode, { silent = false } = {}) {
    S.busy = true; renderFooter();
    const results = [];
    try {
      const staleNotes = await removeStale();
      const whenIso = mode === 'schedule' ? new Date(S.when).toISOString() : null;
      for (const acct of selectedAccounts()) {
        const res = { acct, ok: false, id: null, error: '' };
        results.push(res);
        try {
          let entry = S.postIds.get(acct.id);
          const body = bodyFor(acct);
          if (entry) {
            try {
              const row = await api(`/api/posts/${entry.id}`, { method: 'PATCH', body });
              entry.status = row.status;
            } catch (err) {
              if (err.status !== 404) throw err;
              S.postIds.delete(acct.id); // deleted elsewhere: create it again, once
              entry = null;
            }
          }
          if (!entry) {
            const row = await api('/api/posts', {
              method: 'POST',
              body: { ...body, brand_id: Number(S.brandId), account_id: acct.id, platform: acct.platform, idea_id: S.ideaId || undefined, publish_at: null },
            });
            entry = { id: row.id, status: row.status || 'draft', sent: false, queued: false };
            S.postIds.set(acct.id, entry);
            writeSnapshot(); // record the id immediately so a crash cannot orphan it
          }
          res.id = entry.id;

          if (S.tagsTouched || S.tagIds.size || S.campaignId) {
            const tagIds = [...S.tagIds, ...(S.campaignId ? [S.campaignId] : [])];
            try { await api(`/api/posts/${entry.id}/tags`, { method: 'PUT', body: { tag_ids: tagIds } }); }
            catch (err) { res.tagError = err.message; }
          }

          if (mode === 'draft') {
            if (entry.status && entry.status !== 'draft') {
              const row = await api(`/api/posts/${entry.id}`, { method: 'PATCH', body: { status: 'draft', publish_at: null } });
              entry.status = row.status; entry.queued = false;
            }
          } else if (mode === 'schedule') {
            const row = await api(`/api/posts/${entry.id}`, { method: 'PATCH', body: { status: 'approved', publish_at: whenIso } });
            entry.status = row.status; entry.queued = false;
          } else if (mode === 'queue') {
            if (!entry.queued) {
              const q = await api(`/api/posts/${entry.id}/queue`, { method: 'POST', body: {} });
              entry.queued = true; entry.status = 'scheduled_local'; res.publishAt = q.publish_at;
            }
          } else if (mode === 'now') {
            if (!entry.sent) {
              const out = await api(`/api/posts/${entry.id}/publish-now`, { method: 'POST', body: {} });
              entry.sent = true; res.dryRun = !!out.dry_run;
            }
          }
          res.ok = true;
        } catch (err) {
          res.error = err.status === 422 && err.data && err.data.error === 'no_open_slot'
            ? 'no open queue slot for this network. Add slots in Settings.'
            : err.message;
        }
      }
      results.staleNotes = staleNotes;
    } finally {
      S.busy = false; renderFooter(); renderBrandChips();
    }
    return results;
  }

  function validate(mode) {
    const accts = selectedAccounts();
    if (!accts.length) return 'Pick at least one account to post to.';
    if (mode === 'draft') return '';
    for (const a of accts) {
      if (!copyFor(a.platform).trim()) return `The ${csName(a.platform)} post is empty. Write something first, or save it as a draft.`;
    }
    const over = overLimitInfo();
    if (over.length) return `${over.map((o) => `${csName(o.platform)} is ${o.over} over`).join(', ')}. Trim it before ${mode === 'schedule' ? 'scheduling' : mode === 'queue' ? 'queueing' : 'posting'}.`;
    if (mode === 'schedule') {
      if (!S.when) return 'Pick a date and time to schedule.';
      if (new Date(S.when).getTime() <= Date.now()) return 'That time has already passed. Pick a later time.';
    }
    return '';
  }

  async function submit(modeOverride) {
    if (S.busy) return;
    const mode = modeOverride || S.delivery;
    showBanner('');
    const problem = validate(mode);
    if (problem) { showBanner(problem, 'error'); return; }
    if (mode === 'now') {
      let dry = false;
      try { dry = !!(await api('/api/worker/status')).dryRun; } catch { dry = false; }
      const names = selectedAccounts().map((a) => csName(a.platform));
      const ok = await confirmDialog({
        title: dry ? 'Post now (dry run)?' : 'Post now, for real?',
        body: [
          `This sends to: ${names.join(', ')}.`,
          dry ? 'DRY RUN is on, so nothing will actually be published.' : 'LIVE: it publishes immediately, and Blotato cannot delete a post once it is sent.',
        ],
        confirmLabel: dry ? 'Run dry run' : 'Post now',
        tone: dry ? 'primary' : 'destructive',
      });
      if (!ok) return;
    }
    const results = await syncPosts(mode);
    const failed = results.filter((r) => !r.ok);
    const done = results.filter((r) => r.ok);
    const stale = results.staleNotes || [];
    if (failed.length || stale.length) {
      const list = el('ul', { class: 'cs-fail-list' }, [
        ...failed.map((f) => el('li', {}, `${csName(f.acct.platform)}: ${f.error}`)),
        ...stale.map((n) => el('li', {}, `Could not remove an old post, ${n}`)),
      ]);
      const note = !failed.length
        ? 'Everything saved, but an old post for a removed account could not be deleted.'
        : done.length
        ? `${done.length} of ${results.length} went through. The rest are saved as drafts. Fix the issue and press the button again; finished posts will not be created twice.`
        : 'Nothing went through. Your draft is saved here; fix the issue and press the button again.';
      showBanner(note, 'error', list);
      touch(); writeSnapshot();
      return;
    }
    await finish(mode, results);
  }

  async function finish(mode, results) {
    const n = results.length;
    const ids = results.map((r) => r.id).filter(Boolean);
    if (S.ideaId) { try { await api(`/api/ideas/${S.ideaId}`, { method: 'PATCH', body: { status: 'done' } }); } catch { /* the posts are saved either way */ } }
    let msg;
    if (mode === 'draft') msg = n === 1 ? 'Draft saved.' : `${n} drafts saved.`;
    else if (mode === 'schedule') msg = `Scheduled ${n} ${n === 1 ? 'post' : 'posts'} for ${csFmtWhen(S.when)}.`;
    else if (mode === 'queue') msg = `Added ${n} ${n === 1 ? 'post' : 'posts'} to the queue.`;
    else msg = results.some((r) => r.dryRun) ? `Dry run done for ${n} ${n === 1 ? 'post' : 'posts'}. Nothing went live.` : `Posted ${n} ${n === 1 ? 'post' : 'posts'}.`;
    const first = ids[0];
    csLsDel(snapshotKey());
    S.dirty = false;
    closeSheet({ force: true });
    toast(msg, {
      tone: 'ok',
      action: {
        label: 'View in Planner',
        onClick: () => {
          location.hash = '#/planner';
          if (first) setTimeout(() => openPostById(first), 350);
        },
      },
    });
    refreshView();
  }

  async function discardAll({ keepOpen = false } = {}) {
    clearTimeout(snapshotTimer);
    // Delete only drafts this sheet created; a post already scheduled is left
    // alone unless it can be walked back, which removeStale handles per account.
    S.sel = new Set();
    await removeStale();
    csLsDel(snapshotKey());
    if (keepOpen) {
      S.idea = ''; S.copy = ''; S.per = {}; S.variants = []; S.active = -1; S.media = []; S.firstComment = '';
      S.tagIds = new Set(); S.campaignId = null; S.contentType = ''; S.pillar = ''; S.pf = {}; S.custom = false; S.tab = 'main';
      S.restoredNote = false; S.dirty = false; S.imgReq = null;
      S.sel = csDefaultSelection(S.brandId);
      ideaInput.value = ''; customToggle.checked = false;
      renderAll();
    }
  }

  async function requestClose() {
    if (S.busy) return;
    if (S.dirty && (hasContent() || S.postIds.size)) {
      const choice = await csAskKeep();
      if (choice === 'keep') return;
      if (choice === 'save') {
        const problem = validate('draft');
        if (problem) { showBanner(problem, 'error'); return; }
        const results = await syncPosts('draft');
        const failed = results.filter((r) => !r.ok);
        if (failed.length) { showBanner(`Could not save: ${failed.map((f) => `${csName(f.acct.platform)}: ${f.error}`).join('; ')}`, 'error'); return; }
        await finish('draft', results);
        return;
      }
      await discardAll();
    }
    closeSheet({ force: true });
  }

  function closeSheet({ force = false } = {}) {
    if (closed) return;
    clearTimeout(snapshotTimer);
    clearInterval(imgPoll);
    // Route change: keep the work for next time. Must run before `closed` is
    // set - writeSnapshot() is a no-op once the sheet is closed.
    if (!force && S.dirty) writeSnapshot();
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    unregister();
    scrim.remove();
    CREATE_ACTIVE = null;
    if (opener && typeof opener.focus === 'function' && document.contains(opener)) opener.focus();
    if (/^#\/create(\?|$)/.test(location.hash)) location.hash = '#/planner';
  }

  // ---- keyboard ----
  function onKey(e) {
    if (closed) return;
    if (e.key === 'Escape') {
      if (document.querySelector('dialog[open], .modal-overlay')) return; // a confirm or the prompt editor owns Esc
      e.preventDefault();
      requestClose();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      submit();
      return;
    }
    if (e.key === 'Tab' && !document.querySelector('dialog[open]')) {
      const nodes = [...sheet.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')]
        .filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null && n.type !== 'hidden');
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  // ---- wiring ----
  ideaInput.addEventListener('input', () => { S.idea = ideaInput.value; csResize(ideaInput); touch(); });
  toneSelect.addEventListener('change', () => { S.toneName = toneSelect.value; touch(); });
  draftBtn.addEventListener('click', runDraft);
  customToggle.addEventListener('change', () => {
    S.custom = customToggle.checked;
    if (!S.custom) S.tab = 'main';
    touch(); renderTabs(); setCopyValue(); updateAll();
  });
  copyArea.addEventListener('input', () => { setActiveText(copyArea.value); csResize(copyArea); touch(); updateAll(); });
  imgToggle.addEventListener('click', () => { S.imgOpen = !S.imgOpen; renderImages(); });
  advToggle.addEventListener('click', () => { S.advOpen = !S.advOpen; renderAdvanced(); });
  primaryBtn.addEventListener('click', () => submit());
  closeBtn.addEventListener('click', requestClose);
  scrim.addEventListener('mousedown', (e) => { if (e.target === scrim) requestClose(); });

  function renderAll() {
    renderBrandChips(); renderAccountChips(); renderTone(); renderProvider(); renderVariants(); renderTabs();
    customToggle.checked = S.custom;
    ideaInput.value = S.idea;
    setCopyValue(); csResize(ideaInput);
    renderImages(); renderAdvanced(); renderDelivery(); renderRestored(); updateAll();
  }

  function applyPrefill(p) {
    const when = csWhenFromPrefill(p);
    if (p.brandId != null && !S.postIds.size) switchBrand(p.brandId);
    if (when) { S.when = when; S.delivery = 'schedule'; renderDelivery(); renderFooter(); checkQuiet(); loadSuggestions(); }
    if (p.copy && !S.copy.trim()) { S.copy = p.copy; setCopyValue(); updateAll(); }
    if (p.ideaText && !S.idea.trim()) { S.idea = p.ideaText; ideaInput.value = S.idea; csResize(ideaInput); }
    if (when || p.copy || p.ideaText) (S.idea.trim() || !S.copy.trim() ? ideaInput : copyArea).focus();
  }

  // ---- initial state ----
  const wanted = prefill.brandId != null ? prefill.brandId : getStickyBrand();
  const startBrand = state.brands.find((b) => String(b.id) === String(wanted)) || state.brands[0] || null;
  S.brandId = startBrand ? startBrand.id : null;
  if (startBrand) setStickyBrand(startBrand.id);
  S.sel = Array.isArray(prefill.accountIds) && prefill.accountIds.length
    ? new Set(csBrandAccounts(S.brandId).filter((a) => prefill.accountIds.includes(a.id)).map((a) => a.id))
    : csDefaultSelection(S.brandId);
  const lastDelivery = csLsGet(CREATE_DELIVERY_KEY, 'draft');
  S.delivery = ['draft', 'schedule', 'queue'].includes(lastDelivery) ? lastDelivery : 'draft';
  const prefillWhen = csWhenFromPrefill(prefill);
  S.when = prefillWhen || csLocalValue(csTomorrowNine());
  if (prefillWhen) S.delivery = 'schedule';
  if (S.delivery === 'queue') S.delivery = 'draft'; // flips to queue only once slots are known and confirm the brand has them

  if (!prefill.copy && !prefill.ideaText && S.brandId) {
    const snap = csLsGet(snapshotKey());
    if (snap && snap.brandId === S.brandId) {
      const keepSel = Array.isArray(prefill.accountIds) && prefill.accountIds.length ? new Set(S.sel) : null;
      applySnapshot(snap);
      if (keepSel && keepSel.size) S.sel = keepSel;
      if (prefillWhen) { S.when = prefillWhen; S.delivery = 'schedule'; }
    }
  }
  if (S.copy && S.active < 0 && !S.variants.length) { /* hand-written or prefilled copy: no versions yet */ }

  const unregister = registerOverlay(() => closeSheet());
  document.addEventListener('keydown', onKey, true);
  document.body.appendChild(scrim);
  renderAll();
  loadBrandData().then(() => {
    if (S.delivery === 'draft' && !prefillWhen && csLsGet(CREATE_DELIVERY_KEY) === 'queue' && hasQueue() && !S.postIds.size) {
      S.delivery = 'queue'; renderDelivery(); renderFooter();
    }
    if (prefill.autoDraft && !closed) runDraft();
  });
  api('/api/media').then((files) => { S.mediaFiles = Array.isArray(files) ? files : []; if (S.libOpen) renderImages(); }).catch(() => {});
  api('/api/ai/providers').then((list) => { if (Array.isArray(list) && list.length) { state.providers = list; renderProvider(); } }).catch(() => {});
  if (S.imgReq) startImgPoll();

  setTimeout(() => {
    if (closed) return;
    if (prefill.focusIdea || !S.copy.trim() || S.idea.trim() === '') ideaInput.focus();
    else copyArea.focus();
  }, 30);

  CREATE_ACTIVE = { applyPrefill, close: () => closeSheet(), state: S };
  return CREATE_ACTIVE;
}
