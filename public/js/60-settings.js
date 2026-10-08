// js/60-settings.js - D3 Settings (docs/DESIGN_WAVE_SPEC.md).
// Routes: #/settings (-> brands), #/settings/brands, #/settings/ai, #/settings/system.
// Tabs are real hash routes. In-tab section jumps use scrollIntoView, never href anchors.
// Replaces the legacy 15-settings.js, 14-ops.js (Ops Stats) and 16-profiles.js.

const SETTINGS_TABS = [
  ['brands', 'Brands'],
  ['ai', 'AI'],
  ['system', 'System'],
  ['blogs', 'Blogs'], // BLOG HOOK: body in 70-blog.js
  ['websites', 'Websites'], // WEB HOOK: body in 80-web.js
];
const SETTINGS_TONES = ['business', 'personal', 'casual'];
const SETTINGS_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SETTINGS_ALL_PLATFORMS = ['linkedin', 'facebook', 'twitter', 'instagram', 'reddit', 'tiktok', 'youtube', 'threads', 'blog'];
const SETTINGS_LONG_FIELD_HINTS = ['bio', 'about', 'overview', 'description', 'story', 'specialties'];

// ---------------- shared helpers (settingsHint is also used by 06-image-prompts.js) ----------------

function settingsHint(text) {
  return el('div', { class: 'settings-hint' }, text);
}

function parseGlobalHardRules(raw) {
  let parsed = {};
  if (raw) {
    try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { parsed = {}; }
  }
  return {
    no_em_dash: parsed.no_em_dash !== false,
    no_emoji_platforms: Array.isArray(parsed.no_emoji_platforms) ? parsed.no_emoji_platforms : [],
    banned_words: Array.isArray(parsed.banned_words) ? parsed.banned_words : [],
  };
}

// A switch with its state spelled out (colour is never the only signal).
function settingsToggleRow(checked, label) {
  const cb = el('input', { type: 'checkbox', class: 'switch' });
  cb.checked = checked;
  const stateEl = el('span', { class: `switch-state ${checked ? 'on' : 'off'}` }, checked ? 'On' : 'Off');
  const row = el('label', { class: 'st-toggle' }, [cb, el('span', { class: 'st-toggle-label' }, label), stateEl]);
  cb.addEventListener('change', () => {
    stateEl.textContent = cb.checked ? 'On' : 'Off';
    stateEl.classList.toggle('on', cb.checked);
    stateEl.classList.toggle('off', !cb.checked);
  });
  return { row, cb };
}

function stField(label, control, hint) {
  return el('div', { class: 'st-field' }, [
    el('label', { class: 'st-label' }, label),
    control,
    hint ? el('div', { class: 'st-field-hint' }, hint) : null,
  ]);
}

function stTextarea(value, rows, placeholder) {
  const ta = el('textarea', { rows: String(rows), placeholder: placeholder || '' });
  ta.value = value || '';
  return ta;
}

// Run an async save with the button disabled, then toast the outcome.
async function stSave(btn, fn, okMsg) {
  if (btn) btn.disabled = true;
  try {
    const result = await fn();
    toast(okMsg || 'Saved.', 'ok');
    return result === undefined ? true : result;
  } catch (err) {
    toast(`Not saved: ${err.message}`, 'error');
    return false;
  } finally {
    if (btn) btn.disabled = false;
  }
}

function stSection(title, hint, ...children) {
  return el('section', { class: 'st-section' }, [
    el('h2', { class: 'st-h2' }, title),
    hint ? el('p', { class: 'st-section-hint' }, hint) : null,
    ...children.flat().filter(Boolean),
  ]);
}

function stScrollTo(node) {
  if (!node) return;
  const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  node.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' });
}

function stRelTime(iso) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  let span;
  if (mins < 1) span = 'under a minute';
  else if (mins < 60) span = `${mins} minute${mins === 1 ? '' : 's'}`;
  else if (mins < 60 * 36) { const h = Math.round(mins / 60); span = `${h} hour${h === 1 ? '' : 's'}`; }
  else { const d = Math.round(mins / 1440); span = `${d} day${d === 1 ? '' : 's'}`; }
  if (mins < 1) return diff < 0 ? 'just now' : 'in under a minute';
  return diff < 0 ? `${span} ago` : `in ${span}`;
}

// ---------------- route ----------------

async function renderSettings(view, params = []) {
  view.innerHTML = '';
  view.classList.add('view-default', 'settings-view');

  const requested = params[0];
  const tab = SETTINGS_TABS.some(([k]) => k === requested) ? requested : 'brands';

  const tabs = el('nav', { class: 'st-tabs', 'aria-label': 'Settings sections' },
    SETTINGS_TABS.map(([key, label]) =>
      el('a', {
        class: `st-tab${key === tab ? ' active' : ''}`,
        href: `#/settings/${key}`,
        'aria-current': key === tab ? 'page' : null,
      }, label)
    )
  );
  view.appendChild(pageHeader('Settings'));
  view.appendChild(tabs);

  const body = el('div', { class: 'st-body' });
  view.appendChild(body);

  try {
    if (tab === 'brands') await settingsBrandsTab(body);
    else if (tab === 'ai') await settingsAiTab(body);
    else if (tab === 'blogs' && typeof blogSettingsTab === 'function') await blogSettingsTab(body); // BLOG HOOK
    else if (tab === 'websites' && typeof webSettingsTab === 'function') await webSettingsTab(body); // WEB HOOK
    else await settingsSystemTab(body);
  } catch (err) {
    body.appendChild(inlineBanner(`Could not load settings: ${err.message}`, 'error'));
  }
}
renderSettings.replacesLegacy = true;

// ================= BRANDS TAB =================

async function settingsBrandsTab(body) {
  if (!state.brands.length) {
    body.appendChild(emptyState('No brands yet.'));
    return;
  }
  let brandId = getStickyBrand() && state.brands.some((b) => String(b.id) === getStickyBrand())
    ? getStickyBrand()
    : String(state.brands[0].id);

  const chipsHost = el('div', { class: 'st-chips', role: 'group', 'aria-label': 'Brand' });
  const panelHost = el('div', { class: 'st-panel' });
  body.append(chipsHost, panelHost);

  function paintChips() {
    chipsHost.innerHTML = '';
    for (const b of state.brands) {
      const active = String(b.id) === String(brandId);
      chipsHost.appendChild(el('button', {
        class: `st-chip${active ? ' active' : ''}`,
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        onclick: () => {
          if (active) return;
          brandId = String(b.id);
          setStickyBrand(brandId);
          paintChips();
          panelHost.innerHTML = '';
          loadPanel();
        },
      }, b.name));
    }
    chipsHost.appendChild(el('button', {
      class: 'st-chip st-chip-add',
      type: 'button',
      onclick: settingsAddBrand,
    }, '+ Add brand'));
  }

  async function settingsAddBrand() {
    const name = await promptDialog({
      title: 'Add a brand',
      body: 'It gets its own voice, accounts and queue. You can connect accounts after it exists.',
      label: 'Brand name',
      placeholder: 'For example, Client Four',
      confirmLabel: 'Add brand',
    });
    if (!name) return;
    try {
      const created = await api('/api/brands', { method: 'POST', body: { name } });
      state.brands = await api('/api/brands');
      brandId = String(created.id);
      setStickyBrand(brandId);
      paintChips();
      panelHost.innerHTML = '';
      loadPanel();
      toast(`${created.name} added.`);
    } catch (err) {
      toast(`Could not add the brand: ${err.message}`, 'error');
    }
  }

  let panelToken = 0;
  async function loadPanel({ keepScroll = false } = {}) {
    const token = ++panelToken;
    const y = window.scrollY;
    let panel;
    try {
      panel = await settingsBuildBrandPanel(brandId, () => loadPanel({ keepScroll: true }));
    } catch (err) {
      if (token !== panelToken) return;
      panelHost.innerHTML = '';
      panelHost.appendChild(inlineBanner(`Could not load this brand: ${err.message}`, 'error'));
      return;
    }
    if (token !== panelToken) return;
    panelHost.replaceChildren(panel);
    if (keepScroll) window.scrollTo(0, y);
  }

  paintChips();
  await loadPanel();
}

async function settingsRefreshAccounts() {
  try { state.accounts = await api('/api/accounts'); } catch { /* keep the old list */ }
}

async function settingsBuildBrandPanel(brandId, reload) {
  const [brands, tones, slots, profiles, settings] = await Promise.all([
    api('/api/brands'),
    api(`/api/tone-profiles?brand_id=${brandId}`).catch(() => null),
    api(`/api/queue-slots?brand_id=${brandId}`).catch(() => null),
    api(`/api/profiles?brand_id=${encodeURIComponent(brandId)}`).catch(() => null),
    api('/api/settings').catch(() => ({})),
  ]);
  const brand = brands.find((b) => String(b.id) === String(brandId));
  if (!brand) throw new Error('Brand not found');
  const accounts = state.accounts.filter((a) => String(a.brand_id) === String(brandId));

  const sections = {};
  const panel = el('div', { class: 'st-brand-panel' });

  sections.voice = settingsVoiceSection(brand, tones, settings);
  sections.accounts = settingsAccountsSection(brand, accounts, reload);
  sections.slots = settingsSlotsSection(brand, slots, accounts, reload);
  sections.profiles = settingsProfilesSection(brand, profiles, reload);
  sections.branding = settingsBrandingSection(brand);
  sections.tracking = settingsTrackingSection(brand);

  // Completeness checklist (what the old Home setup matrix showed).
  const hasToneRules = (tones || []).some((t) => settingsRealToneRules(t.voice_rules));
  const globalVoiceSet = Boolean((settings.global_voice || '').trim());
  const checks = [
    { label: 'Accounts added', done: accounts.length > 0, detail: accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : 'None yet', target: 'accounts' },
    { label: 'Queue slots', done: (slots || []).length > 0, detail: (slots || []).length ? `${slots.length} slot${slots.length === 1 ? '' : 's'}` : 'None yet', target: 'slots' },
    { label: 'Voice and tone', done: hasToneRules || globalVoiceSet, detail: hasToneRules ? 'Brand tone set' : globalVoiceSet ? 'Using your global voice' : 'Not set', target: 'voice' },
    { label: 'Platform profiles', done: (profiles || []).length > 0 && !(profiles || []).some((p) => p.status === 'stale'), detail: !(profiles || []).length ? 'None yet' : (profiles || []).some((p) => p.status === 'stale') ? 'One or more stale' : 'Current', target: 'profiles' },
    { label: 'Link tracking', done: Boolean(brand.utm_enabled), detail: brand.utm_enabled ? 'On' : 'Off (optional)', optional: true, target: 'tracking' },
  ];
  const required = checks.filter((c) => !c.optional);
  const doneCount = required.filter((c) => c.done).length;
  const checklist = el('div', { class: 'st-checklist' }, [
    el('div', { class: 'st-checklist-head' }, `${doneCount} of ${required.length} set up`),
    ...checks.map((c) => el('button', {
      class: `st-check${c.done ? ' done' : ''}`, type: 'button',
      onclick: () => stScrollTo(sections[c.target]),
    }, [
      el('span', { class: 'st-check-mark', 'aria-hidden': 'true' }, c.done ? '✓' : c.optional ? '·' : '○'),
      el('span', { class: 'st-check-label' }, c.label),
      el('span', { class: 'st-check-detail' }, c.detail),
    ])),
  ]);

  const jumps = el('nav', { class: 'st-jumps', 'aria-label': 'Jump to section' }, [
    ['voice', 'Voice'], ['accounts', 'Accounts'], ['slots', 'Queue slots'],
    ['profiles', 'Profiles'], ['branding', 'Branding'], ['tracking', 'Link tracking'],
  ].map(([k, label]) => el('button', { class: 'st-jump', type: 'button', onclick: () => stScrollTo(sections[k]) }, label)));

  panel.append(checklist, jumps,
    sections.voice, sections.accounts, sections.slots, sections.profiles, sections.branding, sections.tracking);
  return panel;
}

// ---- Voice ----

function settingsVoiceSection(brand, tones, settings) {
  const brandId = brand.id;

  // Brand voice: paste or write it here; it is saved to the brand's voice doc
  // (Social Media/brands/<slug>/voice.md), which drafting reads on every call.
  const voiceArea = stTextarea('', 14, 'Paste how this brand should sound: who it talks to, what it sounds like, what it never says, a few example lines.');
  voiceArea.classList.add('st-voice-area');
  voiceArea.disabled = true;
  const voiceCount = el('div', { class: 'st-field-hint' }, 'Loading the brand voice...');
  const voiceSave = el('button', { class: 'button primary sm', type: 'button', disabled: 'disabled' }, 'Save brand voice');
  const voiceWhere = el('div', { class: 'st-field-hint st-voice-where' });
  const voiceHost = el('div', {}, [voiceArea, el('div', { class: 'st-actions' }, [voiceSave]), voiceCount]);
  let promptCap = 4000;

  function renderCount() {
    const n = voiceArea.value.trim().length;
    voiceCount.textContent = n > promptCap
      ? `${n.toLocaleString()} characters. Drafting only uses the first ${promptCap.toLocaleString()}, so put what matters most at the top.`
      : `${n.toLocaleString()} characters. Long dashes become regular dashes when you save.`;
    voiceCount.classList.toggle('st-warn', n > promptCap);
  }
  voiceArea.addEventListener('input', renderCount);

  function showInfo(info) {
    promptCap = info.prompt_cap || promptCap;
    if (info.is_global_voice) {
      voiceHost.innerHTML = '';
      voiceHost.appendChild(el('div', { class: 'st-note' }, [
        el('span', {}, `${brand.name} uses your personal voice card as its voice. Edit it as your global voice so every brand stays in sync.`),
        el('a', { class: 'button secondary sm', href: '#/settings/ai' }, 'Edit global voice'),
      ]));
      voiceWhere.textContent = `Source: ${info.path}`;
      return;
    }
    voiceArea.value = info.text || '';
    voiceArea.disabled = false;
    voiceSave.disabled = false;
    voiceWhere.textContent = info.path
      ? `Saved to Social Media/${info.path}${info.exists ? '' : ' (will be created when you save)'}`
      : `Will be saved to Social Media/brands/${brand.slug || 'brand'}/voice.md`;
    renderCount();
  }

  api(`/api/brands/${brandId}/voice`)
    .then(showInfo)
    .catch((err) => { voiceCount.textContent = `Could not load the brand voice: ${err.message}`; });

  voiceSave.onclick = async () => {
    const info = await stSave(voiceSave, () =>
      api(`/api/brands/${brandId}/voice`, { method: 'PUT', body: { text: voiceArea.value } }), `${brand.name} voice saved. New drafts use it now.`);
    if (info && typeof info === 'object') showInfo(info);
  };

  const toneSelect = el('select', { 'aria-label': 'Default tone' }, SETTINGS_TONES.map((t) => el('option', { value: t }, t[0].toUpperCase() + t.slice(1))));
  const savedTone = settings[`brand_${brandId}_default_tone`];
  toneSelect.value = SETTINGS_TONES.includes(savedTone) ? savedTone : 'business';
  const toneSave = el('button', { class: 'button secondary sm', type: 'button' }, 'Save');
  toneSave.onclick = () => stSave(toneSave, () =>
    api('/api/settings', { method: 'PATCH', body: { [`brand_${brandId}_default_tone`]: toneSelect.value } }), 'Default tone saved.');

  const toneGrid = el('div', { class: 'st-tone-grid' });
  if (tones === null) {
    toneGrid.appendChild(inlineBanner('Could not load tone profiles.', 'error'));
  } else {
    for (const name of SETTINGS_TONES) {
      const profile = tones.find((p) => p.name === name);
      toneGrid.appendChild(profile ? settingsToneEditor(brandId, profile) : el('div', { class: 'st-tone' }, `No ${name} tone profile for this brand yet.`));
    }
  }

  return stSection('Voice',
    'Drafts for this brand use three layers, in order: your global voice (AI tab), this brand voice, then the tone tweak you pick.',
    stField('Brand voice', voiceHost, null),
    voiceWhere,
    stField('Default tone', el('div', { class: 'st-inline' }, [toneSelect, toneSave]), 'Used when you draft without picking a tone.'),
    el('h3', { class: 'st-h3' }, 'Tone tweaks'),
    el('p', { class: 'st-section-hint' }, 'Optional. A line or two that shifts the brand voice for business, personal or casual posts.'),
    toneGrid
  );
}

function settingsToneEditor(brandId, profile) {
  const area = stTextarea(settingsRealToneRules(profile.voice_rules), 4, 'Inherits your global voice and the brand voice doc. Add a light tweak for this tone.');
  const previewBody = el('div', { class: 'st-preview' });
  const preview = el('details', { class: 'st-preview-details' }, [el('summary', {}, 'See the full voice the AI gets'), previewBody]);
  async function loadPreview() {
    previewBody.textContent = '';
    try {
      const resolved = await api(`/api/voice/resolve?brand_id=${brandId}&tone=${profile.name}`);
      previewBody.textContent = resolved.voice || '(empty)';
    } catch { /* preview is best effort */ }
  }
  loadPreview();
  const save = el('button', { class: 'button primary sm', type: 'button' }, 'Save');
  save.onclick = async () => {
    const ok = await stSave(save, () => api(`/api/tone-profiles/${profile.id}`, { method: 'PATCH', body: { voice_rules: area.value } }), `${profile.name} tone saved.`);
    if (ok) loadPreview();
  };
  const reset = el('button', { class: 'button ghost sm', type: 'button' }, 'Reset');
  reset.onclick = async () => {
    const ok = await stSave(reset, async () => {
      const r = await api(`/api/tone-profiles/${profile.id}/reset`, { method: 'POST' });
      area.value = settingsRealToneRules(r?.voice_rules);
    }, `${profile.name} tone reset to your global voice.`);
    if (ok) loadPreview();
  };
  return el('div', { class: 'st-tone' }, [
    el('h3', { class: 'st-h3' }, profile.name[0].toUpperCase() + profile.name.slice(1)),
    area, preview,
    el('div', { class: 'st-actions' }, [save, reset]),
  ]);
}

// ---- Accounts ----

function settingsAccountLabel(a) {
  const name = a.display_name || a.name || (a.target_fields && (a.target_fields.name || a.target_fields.pageName)) || '';
  return name ? `${humanizePlatformName(a.platform)} - ${name}` : humanizePlatformName(a.platform);
}

function settingsAccountsSection(brand, accounts, reload) {
  const list = el('div', { class: 'st-list' });
  if (!accounts.length) {
    list.appendChild(emptyState('No accounts for this brand yet. Add one below to draft and schedule for it.'));
  }
  for (const a of accounts) {
    const connected = !a.manual && a.blotato_account_id;
    const activeCb = el('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Active' });
    activeCb.checked = a.active === undefined ? true : Number(a.active) === 1;
    activeCb.onchange = async () => {
      try {
        await api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { active: activeCb.checked } });
        toast(activeCb.checked ? 'Account is active.' : 'Account paused. It will not be offered when creating posts.');
        await settingsRefreshAccounts();
      } catch (err) {
        activeCb.checked = !activeCb.checked;
        toast(`Not saved: ${err.message}`, 'error');
      }
    };
    const manualBtn = el('button', { class: 'button ghost sm', type: 'button' }, a.manual ? 'Switch to auto-post' : 'Switch to copy and paste');
    manualBtn.onclick = async () => {
      if (a.manual && !a.blotato_account_id) {
        toast('This account has no Blotato connection, so it cannot auto-post.', 'warn');
        return;
      }
      const ok = await stSave(manualBtn, () => api(`/api/accounts/${a.id}`, { method: 'PATCH', body: { manual: !a.manual } }),
        a.manual ? 'Account will auto-post through Blotato.' : 'Account is now copy and paste.');
      if (ok) { await settingsRefreshAccounts(); reload(); }
    };
    const removeBtn = el('button', { class: 'button ghost sm st-danger', type: 'button' }, 'Remove');
    removeBtn.onclick = async () => {
      const yes = await confirmDialog({
        title: `Remove ${settingsAccountLabel(a)}?`,
        body: 'Existing posts keep their history but lose this account link. This cannot be undone.',
        confirmLabel: 'Remove account', tone: 'destructive',
      });
      if (!yes) return;
      const ok = await stSave(removeBtn, () => api(`/api/accounts/${a.id}`, { method: 'DELETE' }), 'Account removed.');
      if (ok) { await settingsRefreshAccounts(); reload(); }
    };
    list.appendChild(el('div', { class: 'st-row' }, [
      el('div', { class: 'st-row-main' }, [
        platformIcon(a.platform, { size: 16 }),
        el('span', { class: 'st-row-title' }, settingsAccountLabel(a)),
        el('span', { class: `status-pill status-pill--${connected ? 'ok' : 'muted'}` }, connected ? 'Connected' : 'Manual'),
      ]),
      el('div', { class: 'st-row-actions' }, [
        el('label', { class: 'st-mini-toggle' }, [activeCb, 'Active']),
        manualBtn, removeBtn,
      ]),
    ]));
  }

  const taken = new Set(accounts.map((a) => a.platform));
  const options = SETTINGS_ALL_PLATFORMS.filter((p) => !taken.has(p));
  const add = el('div', { class: 'st-inline' });
  if (options.length) {
    const sel = el('select', { 'aria-label': 'Platform to add' }, options.map((p) => el('option', { value: p }, humanizePlatformName(p))));
    const addBtn = el('button', { class: 'button secondary sm', type: 'button' }, 'Add account');
    addBtn.onclick = async () => {
      const ok = await stSave(addBtn, () => api('/api/accounts', { method: 'POST', body: { brand_id: brand.id, platform: sel.value } }),
        `${humanizePlatformName(sel.value)} added as copy and paste.`);
      if (ok) { await settingsRefreshAccounts(); reload(); }
    };
    add.append(sel, addBtn);
  }

  return stSection('Accounts',
    'Connected accounts post automatically through Blotato. Manual accounts give you the copy to paste yourself.',
    list,
    options.length ? stField('Add a platform', add, 'New accounts start as copy and paste. Connect them to Blotato in the server seed to auto-post.') : null
  );
}

// ---- Queue slots ----

function settingsSlotsSection(brand, slots, accounts, reload) {
  const brandId = brand.id;
  const host = el('div');
  if (slots === null) {
    host.appendChild(inlineBanner('Could not load queue slots.', 'error'));
    return stSection('Queue slots', null, host);
  }

  const platformOptions = accounts.length ? [...new Set(accounts.map((a) => a.platform))] : SETTINGS_ALL_PLATFORMS;
  const list = el('div', { class: 'st-list' });
  if (!slots.length) list.appendChild(emptyState('No queue slots yet. Add one below, or seed a daily noon slot.'));
  const sorted = [...slots].sort((a, b) => a.day_of_week - b.day_of_week || String(a.time_local).localeCompare(String(b.time_local)));
  for (const slot of sorted) {
    const activeCb = el('input', { type: 'checkbox', class: 'switch', 'aria-label': 'Active' });
    activeCb.checked = Number(slot.active) === 1;
    activeCb.onchange = async () => {
      try {
        await api(`/api/queue-slots/${slot.id}`, { method: 'PATCH', body: { active: activeCb.checked ? 1 : 0 } });
        toast(activeCb.checked ? 'Slot is active.' : 'Slot paused.');
      } catch (err) {
        activeCb.checked = !activeCb.checked;
        toast(`Not saved: ${err.message}`, 'error');
      }
    };
    const rm = el('button', { class: 'button ghost sm st-danger', type: 'button' }, 'Delete');
    rm.onclick = async () => {
      const yes = await confirmDialog({
        title: 'Delete this slot?',
        body: `${SETTINGS_DAYS[slot.day_of_week]} ${slot.time_local} on ${humanizePlatformName(slot.platform)}. Posts already queued stay where they are.`,
        confirmLabel: 'Delete slot', tone: 'destructive',
      });
      if (!yes) return;
      const ok = await stSave(rm, () => api(`/api/queue-slots/${slot.id}`, { method: 'DELETE' }), 'Slot deleted.');
      if (ok) reload();
    };
    list.appendChild(el('div', { class: 'st-row' }, [
      el('div', { class: 'st-row-main' }, [
        platformIcon(slot.platform, { size: 16 }),
        el('span', { class: 'st-row-title' }, `${SETTINGS_DAYS[slot.day_of_week]} ${slot.time_local}`),
        el('span', { class: 'st-row-sub' }, humanizePlatformName(slot.platform)),
      ]),
      el('div', { class: 'st-row-actions' }, [el('label', { class: 'st-mini-toggle' }, [activeCb, 'Active']), rm]),
    ]));
  }
  host.appendChild(list);

  const daySel = el('select', { 'aria-label': 'Day' }, SETTINGS_DAYS.map((n, i) => el('option', { value: String(i) }, n)));
  const timeIn = el('input', { type: 'time', value: '12:00', 'aria-label': 'Time' });
  const platSel = el('select', { 'aria-label': 'Platform' }, platformOptions.map((p) => el('option', { value: p }, humanizePlatformName(p))));
  const addBtn = el('button', { class: 'button primary sm', type: 'button' }, 'Add slot');
  addBtn.onclick = async () => {
    const ok = await stSave(addBtn, () => api('/api/queue-slots', {
      method: 'POST',
      body: { brand_id: Number(brandId), platform: platSel.value, day_of_week: Number(daySel.value), time_local: timeIn.value },
    }), 'Slot added.');
    if (ok) reload();
  };
  const bestHost = el('div', { class: 'st-field-hint' });
  let bestToken = 0;
  async function bestHint() {
    const mine = ++bestToken;
    bestHost.textContent = '';
    try {
      const data = await api(`/api/best-times?brand_id=${brandId}&platform=${platSel.value}`);
      if (mine !== bestToken || !data || !Array.isArray(data.bands) || !data.bands.length) return;
      bestHost.textContent = `Best window for ${humanizePlatformName(platSel.value)}: ${data.bands[0].label}`;
    } catch { /* hint only */ }
  }
  platSel.addEventListener('change', bestHint);
  bestHint();

  const seedBtn = el('button', { class: 'button ghost sm', type: 'button' }, 'Seed daily 12:00 LinkedIn and Facebook');
  seedBtn.onclick = async () => {
    const seedPlatforms = platformOptions.filter((p) => p === 'linkedin' || p === 'facebook');
    if (!seedPlatforms.length) { toast('This brand has no LinkedIn or Facebook account.', 'warn'); return; }
    seedBtn.disabled = true;
    let created = 0;
    try {
      const fresh = await api(`/api/queue-slots?brand_id=${brandId}`);
      for (let dow = 0; dow < 7; dow++) {
        for (const platform of seedPlatforms) {
          if (fresh.some((s) => s.day_of_week === dow && s.time_local === '12:00' && s.platform === platform)) continue;
          try {
            await api('/api/queue-slots', { method: 'POST', body: { brand_id: Number(brandId), platform, day_of_week: dow, time_local: '12:00' } });
            created++;
          } catch { /* keep seeding the rest */ }
        }
      }
      toast(created ? `Added ${created} slot${created === 1 ? '' : 's'}.` : 'Those slots already exist.');
      reload();
    } catch (err) {
      toast(`Could not seed slots: ${err.message}`, 'error');
    } finally {
      seedBtn.disabled = false;
    }
  };

  host.appendChild(stField('Add a slot', el('div', { class: 'st-inline' }, [daySel, timeIn, platSel, addBtn]), null));
  host.appendChild(bestHost);
  host.appendChild(el('div', { class: 'st-actions' }, [seedBtn]));
  return stSection('Queue slots', 'Recurring weekly times. "Add to queue" in the post editor drops a post into the next open slot.', host);
}

// ---- Profiles (folded in from the old Brand profiles page) ----

function settingsProfilesSection(brand, profiles, reload) {
  const host = el('div', { class: 'st-list' });
  if (profiles === null) {
    host.appendChild(inlineBanner('Could not load profiles on this server.', 'error'));
  } else if (!profiles.length) {
    host.appendChild(emptyState('No profiles yet. They appear once this brand has an account to draft for.'));
  } else {
    for (const row of profiles) host.appendChild(settingsProfileCard(row, reload));
  }
  return stSection('Profiles',
    'The source of truth for each platform profile: heading, bio and standard fields. Generate drafts them in your voice. Nothing here posts anything; copy and paste is the point.',
    host);
}

function settingsProfileCard(row, reload) {
  const fields = { ...(row.fields || {}) };
  let open = false;
  const wrap = el('div', { class: 'st-profile' });
  const bodyHost = el('div', { class: 'st-profile-body' });

  const stale = row.status === 'stale';
  const toggle = el('button', { class: 'st-profile-head', type: 'button', 'aria-expanded': 'false' }, [
    platformIcon(row.platform, { size: 16 }),
    el('span', { class: 'st-row-title' }, humanizePlatformName(row.platform)),
    el('span', { class: `status-pill status-pill--${stale ? 'bad' : row.status === 'current' ? 'ok' : 'neutral'}` },
      stale ? 'Stale' : row.status === 'current' ? 'Current' : String(row.status || 'Draft')),
    el('span', { class: 'st-row-sub' },
      row.last_reviewed_at ? `Reviewed ${fmtDate(row.last_reviewed_at)}` : 'Not reviewed'),
    el('span', { class: 'st-profile-caret', 'aria-hidden': 'true' }, 'Edit'),
  ]);
  toggle.onclick = () => {
    open = !open;
    toggle.setAttribute('aria-expanded', String(open));
    bodyHost.hidden = !open;
    if (open && !bodyHost.childElementCount) buildBody();
  };
  bodyHost.hidden = true;

  function renderFields(fieldsHost) {
    fieldsHost.innerHTML = '';
    const keys = Object.keys(fields);
    if (!keys.length) { fieldsHost.appendChild(emptyState('No fields yet. Generate drafts them.')); return; }
    for (const key of keys) {
      const value = fields[key] == null ? '' : String(fields[key]);
      const long = SETTINGS_LONG_FIELD_HINTS.some((h) => key.toLowerCase().includes(h)) || value.length > 80;
      const input = long ? el('textarea', { rows: '4' }) : el('input', {});
      input.value = value;
      input.addEventListener('input', () => { fields[key] = input.value; });
      const copy = el('button', { class: 'button ghost sm', type: 'button' }, 'Copy');
      copy.onclick = async () => {
        try {
          await navigator.clipboard.writeText(fields[key] || '');
          toast(`${humanizeKey(key)} copied.`);
        } catch {
          toast('Could not copy. Select the text and copy it by hand.', 'error');
        }
      };
      fieldsHost.appendChild(el('div', { class: 'st-field' }, [
        el('div', { class: 'st-label-row' }, [el('label', { class: 'st-label' }, humanizeKey(key)), copy]),
        input,
      ]));
    }
  }

  function buildBody() {
    const fieldsHost = el('div');
    renderFields(fieldsHost);
    const gen = el('button', { class: 'button secondary sm', type: 'button' }, 'Generate');
    gen.onclick = async () => {
      gen.disabled = true;
      gen.textContent = 'Generating...';
      try {
        const updated = await api('/api/profiles/generate', { method: 'POST', body: { brand_id: row.brand_id, platform: row.platform } });
        Object.keys(fields).forEach((k) => delete fields[k]);
        Object.assign(fields, updated.fields || {});
        renderFields(fieldsHost);
        toast('Drafted. Review it before you paste it anywhere.');
      } catch (err) {
        if (err.status === 503 || err.data?.error === 'ai_unavailable') toast('AI is unavailable. The claude CLI is not reachable or is signed out.', 'error');
        else toast(`Could not generate: ${err.message}`, 'error');
      } finally {
        gen.disabled = false;
        gen.textContent = 'Generate';
      }
    };
    const save = el('button', { class: 'button primary sm', type: 'button' }, 'Save');
    save.onclick = async () => { if (await stSave(save, () => api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { fields } }), 'Profile saved.')) reload(); };
    const reviewed = el('button', { class: 'button ghost sm', type: 'button' }, 'Mark reviewed');
    reviewed.onclick = async () => { if (await stSave(reviewed, () => api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { status: 'current' } }), 'Marked current.')) reload(); };
    const markStale = el('button', { class: 'button ghost sm', type: 'button' }, 'Mark stale');
    markStale.onclick = async () => { if (await stSave(markStale, () => api(`/api/profiles/${row.id}`, { method: 'PATCH', body: { status: 'stale' } }), 'Marked stale.')) reload(); };
    bodyHost.append(fieldsHost, el('div', { class: 'st-actions' }, [save, gen, reviewed, markStale]));
  }

  wrap.append(toggle, bodyHost);
  return wrap;
}

// ---- Branding ----

function settingsBrandingSection(brand) {
  const brandId = brand.id;
  let colors = { primary: '#c9a227', accent: '#2f6fed' };
  if (brand.colors) {
    try {
      const parsed = typeof brand.colors === 'string' ? JSON.parse(brand.colors) : brand.colors;
      colors = { primary: parsed.primary || colors.primary, accent: parsed.accent || colors.accent };
    } catch { /* defaults */ }
  }

  const preview = el('div', { class: 'st-logo' });
  function paintLogo() {
    preview.innerHTML = '';
    if (brand.logo_path) preview.appendChild(el('img', { src: brand.logo_path, alt: `${brand.name} logo`, loading: 'lazy', decoding: 'async' }));
    else preview.appendChild(el('span', { class: 'st-field-hint' }, 'No logo yet.'));
  }
  paintLogo();
  const file = el('input', { type: 'file', accept: 'image/*', 'aria-label': 'Logo file' });
  const upload = el('button', { class: 'button secondary sm', type: 'button' }, 'Upload logo');
  upload.onclick = async () => {
    if (!file.files.length) { toast('Choose a logo file first.', 'warn'); return; }
    const fd = new FormData();
    fd.append('logo', file.files[0]);
    await stSave(upload, async () => {
      const updated = await api(`/api/brands/${brandId}/logo`, { method: 'POST', body: fd });
      brand.logo_path = updated?.logo_path || brand.logo_path;
      paintLogo();
      file.value = '';
    }, 'Logo uploaded.');
  };

  const primary = el('input', { type: 'color', value: colors.primary, 'aria-label': 'Primary color' });
  const accent = el('input', { type: 'color', value: colors.accent, 'aria-label': 'Accent color' });
  const saveColors = el('button', { class: 'button secondary sm', type: 'button' }, 'Save colors');
  saveColors.onclick = () => stSave(saveColors, () => api(`/api/brands/${brandId}`, {
    method: 'PATCH', body: { colors: JSON.stringify({ primary: primary.value, accent: accent.value }) },
  }), 'Colors saved.');

  return stSection('Branding',
    "The logo and colors feed this brand's image brief so Codex can brand generated assets.",
    stField('Logo', el('div', { class: 'st-logo-row' }, [preview, el('div', { class: 'st-inline' }, [file, upload])])),
    stField('Colors', el('div', { class: 'st-inline' }, [
      el('label', { class: 'st-color' }, ['Primary', primary]),
      el('label', { class: 'st-color' }, ['Accent', accent]),
      saveColors,
    ]))
  );
}

// ---- Link tracking ----

function settingsTrackingSection(brand) {
  const toggle = settingsToggleRow(Boolean(brand.utm_enabled), 'Add UTM tags to links');
  const tpl = el('input', {
    placeholder: 'utm_source={platform}&utm_medium=social&utm_campaign={campaign}',
    value: brand.utm_template || '',
    'aria-label': 'UTM template',
  });
  const save = el('button', { class: 'button primary sm', type: 'button' }, 'Save');
  save.onclick = () => stSave(save, async () => {
    const updated = await api(`/api/brands/${brand.id}`, {
      method: 'PATCH', body: { utm_enabled: toggle.cb.checked, utm_template: tpl.value || null },
    });
    brand.utm_enabled = updated?.utm_enabled;
    brand.utm_template = updated?.utm_template;
  }, 'Link tracking saved.');
  return stSection('Link tracking', 'Tags are added when a post is approved, so drafts stay clean.',
    toggle.row, stField('UTM template', tpl), el('div', { class: 'st-actions' }, [save]));
}

// ================= AI TAB =================

async function settingsAiTab(body) {
  const settings = await api('/api/settings');

  // Global voice
  const voice = stTextarea(settings.global_voice, 8, 'Describe your voice: tone, phrasing habits, things you always or never say.');
  const voiceSave = el('button', { class: 'button primary sm', type: 'button' }, 'Save voice');
  voiceSave.onclick = async () => {
    const res = await stSave(voiceSave, () => api('/api/settings', { method: 'PATCH', body: { global_voice: voice.value } }), 'Voice saved. New drafts use it now.');
    // The server normalizes long dashes; show exactly what the AI will get.
    if (res && typeof res === 'object' && typeof res.global_voice === 'string') voice.value = res.global_voice;
  };

  // Global rules
  const rules = parseGlobalHardRules(settings.global_hard_rules);
  const emDash = settingsToggleRow(rules.no_em_dash, 'No em dashes');
  const emoji = settingsToggleRow(rules.no_emoji_platforms.includes('linkedin'), 'No emojis on LinkedIn');
  const banned = el('input', { placeholder: 'comma-separated, e.g. leverage, synergy', value: rules.banned_words.join(', '), 'aria-label': 'Banned words' });
  const rulesSave = el('button', { class: 'button primary sm', type: 'button' }, 'Save rules');
  rulesSave.onclick = () => stSave(rulesSave, () => api('/api/settings', {
    method: 'PATCH',
    body: {
      global_hard_rules: JSON.stringify({
        no_em_dash: emDash.cb.checked,
        no_emoji_platforms: emoji.cb.checked ? ['linkedin'] : [],
        banned_words: banned.value.split(',').map((w) => w.trim()).filter(Boolean),
      }),
    },
  }), 'Rules saved.');

  // Providers
  const providerOptions = (selected) => aiProviders().map((p) => el('option', { value: p.value, selected: selected === p.value ? 'selected' : null }, p.label));
  const draftSel = el('select', { 'aria-label': 'Drafting provider' }, providerOptions(settings.draft_provider || 'claude'));
  draftSel.onchange = () => stSave(null, async () => {
    await api('/api/settings', { method: 'PATCH', body: { draft_provider: draftSel.value } });
    sessionDraftProvider = draftSel.value;
  }, 'Drafting provider saved.');
  const agentSel = el('select', { 'aria-label': 'Chat agent provider' }, providerOptions(settings.agent_provider || settings.draft_provider || 'claude'));
  agentSel.onchange = () => stSave(null, () => api('/api/settings', { method: 'PATCH', body: { agent_provider: agentSel.value } }), 'Chat agent provider saved.');

  // Assistant authority
  const authority = settingsToggleRow(settings.agent_can_publish === '1', 'Allow the assistant to approve and publish');
  let authorityBusy = false;
  authority.cb.addEventListener('change', async () => {
    if (authorityBusy) return;
    authorityBusy = true;
    const want = authority.cb.checked;
    const revert = () => {
      authority.cb.checked = !want;
      authority.cb.dispatchEvent(new Event('change'));
    };
    try {
      if (want) {
        const yes = await confirmDialog({
          title: 'Let the assistant publish?',
          body: 'It will be able to approve and publish live posts without you. Dry run still applies when it is on.',
          confirmLabel: 'Allow publishing', tone: 'destructive',
        });
        if (!yes) { authorityBusy = false; revert(); return; }
      }
      await api('/api/settings', { method: 'PATCH', body: { agent_can_publish: want ? '1' : '0' } });
      toast(want ? 'Assistant can now approve and publish.' : 'Assistant is draft-only.');
    } catch (err) {
      toast(`Not saved: ${err.message}`, 'error');
      revert();
    }
    authorityBusy = false;
  });

  const imageHost = el('div', { class: 'st-image-prompts' });
  buildImagePromptEditor(imageHost, settings);

  body.append(
    stSection('Global voice', 'Your personal voice. Every brand starts from it, then adds its own brand voice under Brands > Voice. Paste freely: long dashes become regular dashes when you save.',
      stField('Your voice', voice), el('div', { class: 'st-actions' }, [voiceSave])),
    stSection('Global rules', 'Enforced on every draft, on top of any brand or tone setting.',
      emDash.row, emoji.row, stField('Banned words', banned), el('div', { class: 'st-actions' }, [rulesSave])),
    stSection('Drafting',
      'Codex needs the codex CLI signed in. Claude uses the claude CLI login. Neither needs an API key.',
      stField('Draft with', draftSel),
      stField('Chat agent provider', agentSel, 'Defaults to the drafting provider, but can differ.')),
    stSection('Assistant authority', null,
      authority.row,
      el('p', { class: 'st-warning' }, 'When off, the assistant can only draft. When on, it can approve and publish live posts. Dry run still applies.')),
    stSection('Image prompts',
      'Included in every Codex image request: the post editor, the assistant and blog redistribution.',
      imageHost)
  );
}

// ================= SYSTEM TAB =================

async function settingsSystemTab(body) {
  const [worker, usage, posts, settings] = await Promise.all([
    api('/api/worker/status').catch(() => null),
    api('/api/usage').catch(() => null),
    api('/api/posts').catch(() => []),
    api('/api/settings').catch(() => ({})),
  ]);

  // Posting mode (read only)
  const dry = worker ? worker.dryRun : null;
  const mode = el('div', { class: 'st-kv' }, [
    el('span', { class: `status-pill status-pill--${dry === null ? 'muted' : dry ? 'info' : 'ok'}` }, dry === null ? 'Unknown' : dry ? 'DRY RUN' : 'LIVE'),
    el('span', { class: 'st-kv-text' }, dry === null
      ? 'Could not read worker status.'
      : dry ? 'Nothing is really posted. Posts are marked as sent so you can test the flow.'
        : 'Posts go out to real accounts. Blotato cannot delete a post once it is sent.'),
  ]);
  const modeHint = settingsHint('Posting mode is set by BLOTATO_DRY_RUN in the server environment. Change it there and restart PostDeck.');

  // Worker
  const workerRows = [];
  if (worker) {
    workerRows.push(['Worker', worker.enabled === false ? 'Off. Scheduled posts will not send until it is on.' : 'On']);
    workerRows.push(['Last check', worker.lastRunAt ? `${stRelTime(worker.lastRunAt)} (${fmtDate(worker.lastRunAt)})` : 'Has not run since PostDeck started']);
    workerRows.push(['Next check', worker.nextRunAt ? `${stRelTime(worker.nextRunAt)} (${fmtDate(worker.nextRunAt)})` : 'Not scheduled']);
  }

  // Blotato
  const accounts = state.accounts;
  const connected = accounts.filter((a) => !a.manual && a.blotato_account_id);
  const manual = accounts.filter((a) => a.manual || !a.blotato_account_id);
  const blotato = el('div', { class: 'st-kv' }, [
    el('span', { class: `status-pill status-pill--${connected.length ? 'ok' : 'muted'}` }, connected.length ? 'Connected' : 'Not connected'),
    el('span', { class: 'st-kv-text' }, `${connected.length} of ${accounts.length} accounts post through Blotato. ${manual.length} ${manual.length === 1 ? 'is' : 'are'} copy and paste.`),
  ]);

  // Account health
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000;
  const healthRows = accounts.map((a) => {
    const mine = posts.filter((p) => String(p.account_id) === String(a.id));
    const published = mine.filter((p) => p.status === 'published' && p.publish_at);
    const last = published.length ? published.reduce((m, p) => (new Date(p.publish_at) > new Date(m.publish_at) ? p : m)).publish_at : null;
    const problems = mine.filter((p) => ['failed', 'failed_verify', 'needs_check'].includes(p.status) && new Date(p.updated_at || p.publish_at || 0).getTime() >= cutoff).length;
    const scheduled = mine.filter((p) => ['approved', 'scheduled_local', 'submitted'].includes(p.status)).length;
    return el('div', { class: 'st-row' }, [
      el('div', { class: 'st-row-main' }, [
        platformIcon(a.platform, { size: 16 }),
        el('span', { class: 'st-row-title' }, `${brandName(a.brand_id)} on ${humanizePlatformName(a.platform)}`),
        el('span', { class: `status-pill status-pill--${problems ? 'bad' : 'ok'}` }, problems ? `${problems} problem${problems === 1 ? '' : 's'} in 14 days` : 'Healthy'),
      ]),
      el('div', { class: 'st-row-sub' }, `${last ? `Last posted ${fmtDate(last)}` : 'Never posted'} · ${scheduled} scheduled`),
    ]);
  });

  // Backups
  const lastBackup = (worker && worker.lastBackupAt) || settings.last_backup_at || null;
  const backup = el('div', { class: 'st-kv' }, [
    el('span', { class: `status-pill status-pill--${lastBackup ? 'ok' : 'muted'}` }, lastBackup ? 'Backed up' : 'No backup yet'),
    el('span', { class: 'st-kv-text' }, lastBackup
      ? `Last backup ${stRelTime(lastBackup)} (${fmtDate(lastBackup)}). One snapshot a day is kept for a few days.`
      : 'No backup has run since PostDeck started. The worker takes one a day.'),
  ]);

  body.append(
    stSection('Posting', null, mode, modeHint),
    stSection('Worker', 'The worker sends scheduled posts and checks on Blotato.',
      workerRows.length ? el('dl', { class: 'st-dl' }, workerRows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)])) : inlineBanner('Could not read worker status.', 'error')),
    stSection('Blotato', null, blotato),
    stSection('Account health', 'Problems counted over the last 14 days.',
      healthRows.length ? el('div', { class: 'st-list' }, healthRows) : emptyState('No accounts yet. Add one under Brands.')),
    stSection('Backups', null, backup),
    settingsUsageSection(usage)
  );
}

function settingsUsageSection(data) {
  if (!data) return stSection('Usage', null, inlineBanner('Could not load usage stats.', 'error'));
  const tiles = el('div', { class: 'st-tiles' }, [
    ['Drafts waiting', data.drafts_awaiting],
    ['Scheduled this week', data.scheduled_this_week],
    ['Posted this month', data.published_this_month],
    ['Posted all time', data.published_all_time],
  ].map(([label, value]) => el('div', { class: 'st-tile' }, [
    el('div', { class: 'st-tile-value' }, String(value ?? 0)),
    el('div', { class: 'st-tile-label' }, label),
  ])));

  function bars(title, entries) {
    const rows = entries.filter((e) => e.value > 0);
    if (!rows.length) return null;
    const max = Math.max(...rows.map((r) => r.value));
    return el('div', { class: 'st-bars' }, [
      el('h3', { class: 'st-h3' }, title),
      ...rows.map((r) => el('div', { class: 'st-bar-row' }, [
        el('span', { class: 'st-bar-label' }, r.label),
        el('span', { class: 'st-bar-track' }, [el('span', { class: 'st-bar-fill', style: `width:${Math.max(4, Math.round((r.value / max) * 100))}%` })]),
        el('span', { class: 'st-bar-value' }, String(r.value)),
      ])),
    ]);
  }
  const statusLabel = (s) => humanStatus({ status: s }).label;
  const kinds = Object.keys(data.usage_counts || {});
  const usage = kinds.length ? el('div', { class: 'st-usage' }, [
    el('h3', { class: 'st-h3' }, 'AI and tool usage'),
    el('div', { class: 'st-usage-row st-usage-head' }, [el('span', {}, 'Kind'), el('span', {}, 'All time'), el('span', {}, 'Last 7 days')]),
    ...kinds.map((k) => el('div', { class: 'st-usage-row' }, [
      el('span', {}, humanizeKey(k)), el('span', {}, String(data.usage_counts[k] ?? 0)), el('span', {}, String((data.usage_last_7d || {})[k] ?? 0)),
    ])),
  ]) : null;

  return stSection('Usage', null,
    tiles,
    el('div', { class: 'st-bars-grid' }, [
      bars('Posts by status', Object.entries(data.posts_by_status || {}).map(([label, value]) => ({ label: statusLabel(label), value }))),
      bars('Posts by brand', (data.posts_by_brand || []).map((b) => ({ label: b.brand_name || `Brand ${b.brand_id}`, value: b.count }))),
      bars('Posts by platform', (data.posts_by_platform || []).map((p) => ({ label: humanizePlatformName(p.platform), value: p.count }))),
      bars('Content types', (data.content_type_mix || []).map((c) => ({ label: humanizeKey(c.content_type), value: c.count }))),
    ].filter(Boolean)),
    usage);
}

// Seed placeholder tone rules ("Voice reference for X ... Placeholder ...")
// are ignored by drafting (src/voice.js), so show them as empty, not as rules.
function settingsRealToneRules(text) {
  const t = String(text || '').trim();
  return t.startsWith('Voice reference for') && /placeholder/i.test(t) ? '' : t;
}
