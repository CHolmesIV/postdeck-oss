// js/50-home.js - D3 Home (docs/DESIGN_WAVE_SPEC.md). Overrides nothing now: the legacy
// renderHome was removed from 03-home.js. Purpose: in 5 seconds, what is going out and
// what needs CB.

const HOME_DISMISSED_KEY = 'pd_attention_dismissed'; // same key as the legacy Home, so old dismissals persist
const HOME_GOING_OUT = ['approved', 'scheduled_local', 'submitted', 'submitted_dry'];

function homeDismissedSet() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_DISMISSED_KEY) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : []);
  } catch { return new Set(); }
}
function homeDismiss(key) {
  try {
    const set = homeDismissedSet();
    set.add(key);
    localStorage.setItem(HOME_DISMISSED_KEY, JSON.stringify([...set].slice(-200)));
  } catch { /* storage unavailable: the row just comes back */ }
}

// ---------------- Redistribute-from-blog (kept: 20-chrome.js Labs calls it) ----------------
// Paste a blog URL, pick platforms, optionally make images -> POST /api/redistribute.
// Drafts land as status 'draft'; a human still approves each one.
function redistributeForm(getBrandId) {
  const container = el('div', { class: 'redistribute-form' });
  container.appendChild(el('p', { class: 'home-hint' },
    'Paste a blog URL. PostDeck drafts a post for each platform you pick, plus an image brief if "Make images" is on.'));

  const urlInput = el('input', { placeholder: 'https://example.com/blog/my-post', 'aria-label': 'Blog URL' });
  container.appendChild(el('div', { class: 'field-row' }, [el('label', {}, 'Blog URL'), urlInput]));

  const platformsHost = el('div', { class: 'field-row' });
  const checks = {};
  function renderPlatformChecks() {
    platformsHost.innerHTML = '';
    platformsHost.appendChild(el('label', {}, 'Platforms'));
    const brandId = getBrandId();
    const accounts = brandId ? state.accounts.filter((a) => String(a.brand_id) === String(brandId)) : state.accounts;
    const list = [...new Set(accounts.map((a) => a.platform))];
    const platforms = list.length ? list : Object.keys(state.platformSpecs || {});
    for (const key of Object.keys(checks)) delete checks[key];
    const row = el('div', { class: 'redistribute-platform-row' });
    if (!platforms.length) row.appendChild(el('span', { class: 'home-hint' }, 'No platforms available. Pick a brand with accounts.'));
    for (const p of platforms) {
      const cb = el('input', { type: 'checkbox' });
      cb.checked = true;
      checks[p] = cb;
      row.appendChild(el('label', { class: 'redistribute-check' }, [cb, ` ${humanizePlatformName(p)}`]));
    }
    platformsHost.appendChild(row);
  }
  renderPlatformChecks();
  container.appendChild(platformsHost);

  const makeImagesCb = el('input', { type: 'checkbox' });
  makeImagesCb.checked = true;
  container.appendChild(el('label', { class: 'redistribute-check' }, [makeImagesCb, ' Make images']));

  const msg = el('div');
  const submitBtn = el('button', {
    class: 'button primary md',
    type: 'button',
    onclick: async () => {
      msg.innerHTML = '';
      const brandId = getBrandId();
      const url = urlInput.value.trim();
      const platforms = Object.keys(checks).filter((p) => checks[p].checked);
      if (!url) { msg.appendChild(inlineBanner('Enter a blog URL.', 'error')); return; }
      if (!brandId) { msg.appendChild(inlineBanner('Pick a brand first.', 'error')); return; }
      if (!platforms.length) { msg.appendChild(inlineBanner('Pick at least one platform.', 'error')); return; }
      submitBtn.disabled = true;
      msg.appendChild(inlineBanner('Drafting from the article for each platform. This can take a minute.', 'info'));
      try {
        const res = await api('/api/redistribute', {
          method: 'POST',
          body: { url, brand_id: Number(brandId), platforms, make_images: makeImagesCb.checked },
        });
        msg.innerHTML = '';
        const n = res.drafts?.length ?? 0;
        toast(`Created ${n} draft${n === 1 ? '' : 's'} from "${res.source?.title || url}".`);
        if (res.ai_unavailable) toast('AI was unavailable for some platforms. Check those drafts before approving.', 'warn');
        setTimeout(() => { location.hash = '#/planner?status=drafts'; }, 700);
      } catch (err) {
        msg.innerHTML = '';
        let text = err.message;
        if (err.status === 400 && err.data?.error === 'fetch_failed') text = "Couldn't fetch that URL. Check that it loads in a browser and try again.";
        else if (err.status === 503 || err.data?.error === 'ai_unavailable') text = 'AI is unavailable (the claude CLI was not found or is signed out).';
        else if (err.status === 404) text = 'This server does not have the redistribute endpoint yet.';
        msg.appendChild(inlineBanner(text, 'error'));
        toast(text, 'error');
      } finally {
        submitBtn.disabled = false;
      }
    },
  }, 'Redistribute');
  container.appendChild(el('div', { class: 'redistribute-actions' }, [submitBtn]));
  container.appendChild(msg);
  return container;
}

// ---------------- Home ----------------

function homeFirstLine(post) {
  const line = String(post.copy || '').split('\n').find((l) => l.trim()) || '';
  return line.trim() || '(no copy yet)';
}

// Plain-language reason a post needs CB. Keyed off the raw status because
// humanStatus() collapses all of these to "attention".
function homeAttentionReason(post) {
  if (post.status === 'needs_check') return 'May already be live. Check before sending it again.';
  if (post.status === 'failed_verify') return 'Blotato never confirmed this. It may be live.';
  if (post.status === 'failed') {
    const err = humanizePostError(post.error_message, post.platform);
    return err ? `Did not post. ${err}` : 'Did not post. Fix it and reschedule.';
  }
  return 'Its time passed while PostDeck was closed. Send it now or pick a new time.';
}

function homeTrunc(text, max) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}...` : t;
}

// One line per row: pill, short reason (full text in title), brand + platform, one action.
// Closing is added to every row (own and hook rows) by homeNeedsEnhance below.
function homeNeedsRow(post) {
  const h = humanStatus(post);
  const full = homeAttentionReason(post);
  const rank = h.tone === 'bad' ? '0' : '1';
  return el('div', {
    class: 'home-row home-row--attention',
    'data-home-key': `post:${post.id}`,
    'data-home-sig': `${post.status}|${post.updated_at || ''}`,
    'data-home-rank': rank,
    title: `${h.label}: ${full}\n${homeFirstLine(post)}`,
  }, [
    el('div', { class: 'home-row-main' }, [
      el('div', { class: 'home-row-reason' }, [
        el('span', { class: `status-pill status-pill--${h.tone}` }, h.label),
        el('span', {}, homeTrunc(full, 70)),
      ]),
      el('div', { class: 'home-row-meta' }, [
        platformIcon(post.platform, { size: 13 }),
        el('span', {}, `${brandName(post.brand_id)} on ${humanizePlatformName(post.platform)}`),
      ]),
    ]),
    el('button', { class: 'button primary sm', type: 'button', onclick: () => openPostById(post.id) }, 'Review'),
  ]);
}

function homeLinkRow(text, href, { key, sig, rank } = {}) {
  const attrs = { class: 'home-row home-row--quiet' };
  if (key) { attrs['data-home-key'] = key; attrs['data-home-sig'] = sig || text; }
  if (rank !== undefined) attrs['data-home-rank'] = String(rank);
  return el('div', attrs, [el('a', { class: 'home-row-link', href }, text)]);
}

function buildHomeNeedsYou(host, posts, analytics, workerStatus, brandId) {
  host.innerHTML = '';
  const section = el('section', { class: 'home-section' });
  const list = el('div', { class: 'home-list' });

  const attention = posts
    .filter((p) => humanStatus(p).key === 'attention')
    .sort((a, b) => String(a.publish_at || '').localeCompare(String(b.publish_at || '')));
  attention.forEach((p) => list.appendChild(homeNeedsRow(p)));

  const drafts = posts.filter((p) => p.status === 'draft');
  if (drafts.length) {
    list.appendChild(homeLinkRow(`${drafts.length} draft${drafts.length === 1 ? '' : 's'} waiting`, '#/planner?status=drafts',
      { key: 'drafts-waiting', sig: String(drafts.length), rank: 2 }));
  }

  const metricsDue = (analytics?.metrics_due || []).filter((p) => !brandId || String(p.brand_id) === String(brandId));
  if (metricsDue.length) {
    list.appendChild(homeLinkRow(
      `${metricsDue.length} post${metricsDue.length === 1 ? ' is' : 's are'} ready for metrics`,
      '#/analytics',
      { key: 'metrics-due', sig: metricsDue.map((p) => p.id).sort().join('|'), rank: 2 }
    ));
  }

  const hasScheduled = posts.some((p) => HOME_GOING_OUT.includes(p.status));
  if (workerStatus && workerStatus.enabled === false && hasScheduled) {
    const wr = homeLinkRow('The posting worker is off, so scheduled posts will not send. See System settings.', '#/settings/system',
      { key: 'worker-off', rank: 0 });
    list.insertBefore(wr, list.firstChild);
  }

  if (!list.children.length) return;
  section.appendChild(el('h2', { class: 'home-h2' }, 'Needs you'));
  section.appendChild(list);
  host.appendChild(section);
}

// ---------------- Needs you: hide, group, collapse (docs/D5_EASE_PASS_SPEC.md B) ----------------
// Runs over EVERY row in the Needs you host, because the blog (70-blog.js) and website (80-web.js)
// hooks append their rows after buildHomeNeedsYou, asynchronously. A MutationObserver on the host
// re-runs it whenever rows arrive.
//
// Row keys (stored in localStorage `pd_home_hidden` as { [key]: { until: ISO|null, sig } }):
//  - Own rows carry data-home-key: `post:<id>` (sig = status|updated_at), `drafts-waiting`,
//    `metrics-due`, `worker-off`.
//  - Hook rows have no key; one is derived from the DOM: `x:<pill label>|<reason text with digits
//    replaced by #>|<first link href>`; the sig is the full reason text + the description line, so a
//    changed count, title or error brings the row back after "Hide until it changes".
const HOME_HIDDEN_KEY = 'pd_home_hidden';
const HOME_COLLAPSED_KEY = 'pd_home_needs_collapsed';
const HOME_TOP_N = 4;
const HOME_GROUP_MIN = 3;
const homeNeedsUi = { showAll: false, expanded: new Set() };

function homeHiddenLoad() {
  try {
    const parsed = JSON.parse(localStorage.getItem(HOME_HIDDEN_KEY) || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}
function homeHiddenSave(map) {
  try {
    const entries = Object.entries(map).slice(-300);
    localStorage.setItem(HOME_HIDDEN_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch { /* storage unavailable: hiding just lasts until reload */ }
}
function homeIsHidden(map, key, sig) {
  const e = map[key];
  if (!e || e.sig !== sig) return false;
  if (e.until == null) return true;
  return Date.parse(e.until) > Date.now();
}
function homeCollapsedGet() {
  try { return localStorage.getItem(HOME_COLLAPSED_KEY) === '1'; } catch { return false; }
}
function homeCollapsedSet(v) {
  try { localStorage.setItem(HOME_COLLAPSED_KEY, v ? '1' : '0'); } catch { /* ignore */ }
}

const HOME_GROUP_NOUNS = {
  'Failed': 'posts failed to send',
  'Not confirmed': 'posts not confirmed by Blotato',
  'Check before resending': 'posts to check before resending',
  'Missed time': 'posts missed their time',
  'Website': 'website alerts',
  'Release blocked': 'blog releases blocked',
  'Release failed': 'blog releases failed',
  'Due': 'blog releases due',
};

// Give a raw row its key/sig/title and a close button (once).
function homeNeedsPrepare(row) {
  if (row.dataset.homeEnh) return;
  row.dataset.homeEnh = '1';
  const reasonEl = row.querySelector('.home-row-reason') || row.querySelector('.home-row-link');
  const pillEl = row.querySelector('.status-pill, [class*="pill"]');
  let reason = (reasonEl ? reasonEl.textContent : row.textContent || '').replace(/\s+/g, ' ').trim();
  const pillText = pillEl ? pillEl.textContent.replace(/\s+/g, ' ').trim() : '';
  if (pillText && reasonEl && reasonEl.contains(pillEl) && reason.startsWith(pillText)) reason = reason.slice(pillText.length).trim();
  const copyEl = row.querySelector('.home-row-copy');
  const copy = copyEl ? copyEl.textContent.trim() : '';
  const linkEl = row.querySelector('a[href]');
  const href = linkEl ? linkEl.getAttribute('href') : '';
  if (!row.dataset.homeKey) {
    row.dataset.homeKey = `x:${pillEl ? pillEl.textContent.trim() : ''}|${reason.replace(/\d+/g, '#')}|${href}`;
    row.dataset.homeSig = `${reason}|${copy}`;
  }
  if (!row.dataset.homeRank) {
    row.dataset.homeRank = pillEl ? (/bad|warn/.test(pillEl.className) ? '0' : '1') : '2';
  }
  if (!row.title) row.title = copy ? `${reason}\n${copy}` : reason;
  row.dataset.homeLabel = homeTrunc(reason, 48);
  const kindPill = pillEl && row.querySelector('.home-row-reason') ? pillEl.textContent.trim() : '';
  row.dataset.homeKind = kindPill;
  row.appendChild(homeCloseControl(() => [row]));
}

// The close (x) button and its two-choice menu. getRows returns the rows (or group members) it hides.
function homeCloseControl(getRows, groupLabel) {
  const wrap = el('div', { class: 'home-x', 'data-home-x': '1' });
  const btn = el('button', {
    class: 'home-x-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false',
    'aria-label': 'Hide this item',
  }, '×');
  let menu = null;
  function close(focusBtn) {
    if (!menu) return;
    menu.remove(); menu = null;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onDoc, true);
    if (focusBtn) btn.focus();
  }
  function onDoc(e) { if (!wrap.contains(e.target)) close(false); }
  function choose(mode) {
    const rows = getRows();
    const label = groupLabel ? groupLabel() : (rows[0] && rows[0].dataset.homeLabel) || 'Item';
    close(false);
    homeHide(rows, mode, label, wrap.closest('[data-home-host]'));
  }
  function open() {
    menu = el('div', { class: 'home-x-menu', role: 'menu' }, [
      el('button', { class: 'home-x-item', type: 'button', role: 'menuitem', onclick: () => choose('day') }, 'Hide for a day'),
      el('button', { class: 'home-x-item', type: 'button', role: 'menuitem', onclick: () => choose('change') }, 'Hide until it changes'),
    ]);
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('.home-x-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'Escape') { e.preventDefault(); close(true); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
      else if (e.key === 'Tab') close(false);
    });
    wrap.appendChild(menu);
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onDoc, true);
    menu.querySelector('.home-x-item').focus();
  }
  btn.onclick = () => (menu ? close(true) : open());
  btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !menu) { e.preventDefault(); open(); } });
  wrap.appendChild(btn);
  return wrap;
}

function homeHide(rows, mode, label, host) {
  const map = homeHiddenLoad();
  const before = {};
  const until = mode === 'day' ? new Date(Date.now() + 24 * 3600 * 1000).toISOString() : null;
  for (const r of rows) {
    const k = r.dataset.homeKey;
    before[k] = map[k];
    map[k] = { until, sig: r.dataset.homeSig || '' };
  }
  homeHiddenSave(map);
  if (host) homeNeedsEnhance(host);
  const headBtn = host && host.querySelector('.home-needs-toggle');
  if (headBtn) headBtn.focus();
  toast(rows.length > 1 ? `Hid ${rows.length} items.` : `Hid "${label}".`, {
    action: {
      label: 'Undo',
      onClick: () => {
        const cur = homeHiddenLoad();
        for (const k of Object.keys(before)) { if (before[k]) cur[k] = before[k]; else delete cur[k]; }
        homeHiddenSave(cur);
        if (host && host.isConnected) homeNeedsEnhance(host);
      },
    },
  });
}

function homeNeedsEnhance(host) {
  const obs = host._homeObs;
  if (obs) obs.disconnect();
  try { homeNeedsEnhanceInner(host); } catch (err) { console.warn('[home needs]', err); }
  if (obs) obs.observe(host, { childList: true, subtree: true });
}

function homeNeedsEnhanceInner(host) {
  const section = host.querySelector(':scope > .home-section');
  if (!section) return;
  const list = section.querySelector('.home-list');
  if (!list) return;
  list.classList.add('home-needs-list');
  host.dataset.homeHost = '1';

  // Head: collapse toggle + "N hidden. Show".
  let head = section.querySelector(':scope > .home-needs-head');
  if (!head) {
    const oldH2 = section.querySelector(':scope > h2');
    if (oldH2) oldH2.remove();
    const toggle = el('button', { class: 'home-needs-toggle', type: 'button', 'aria-expanded': 'true' }, [
      el('span', { class: 'home-needs-caret', 'aria-hidden': 'true' }),
      el('h2', { class: 'home-h2' }, 'Needs you'),
    ]);
    toggle.onclick = () => {
      homeCollapsedSet(!homeCollapsedGet());
      homeNeedsEnhance(host);
      const t = host.querySelector('.home-needs-toggle');
      if (t) t.focus();
    };
    head = el('div', { class: 'home-needs-head' }, [toggle, el('span', { class: 'home-needs-note' })]);
    section.insertBefore(head, section.firstChild);
  }

  // Reset generated nodes and per-run state.
  list.querySelectorAll('[data-home-ui]').forEach((n) => n.remove());
  const rows = [...list.children].filter((n) => n.classList.contains('home-row'));
  rows.forEach((r) => {
    homeNeedsPrepare(r);
    r.hidden = false;
    r.classList.remove('home-row--member');
  });

  const map = homeHiddenLoad();
  const hiddenRows = rows.filter((r) => homeIsHidden(map, r.dataset.homeKey, r.dataset.homeSig || ''));
  hiddenRows.forEach((r) => { r.hidden = true; });
  const visible = rows.filter((r) => !r.hidden)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (Number(a.r.dataset.homeRank) - Number(b.r.dataset.homeRank)) || (a.i - b.i))
    .map((o) => o.r);

  // Group rows of the same kind when there are 3 or more.
  const byKind = new Map();
  visible.forEach((r) => {
    const k = r.dataset.homeKind;
    if (!k) return;
    if (!byKind.has(k)) byKind.set(k, []);
    byKind.get(k).push(r);
  });
  const items = [];
  const seen = new Set();
  for (const r of visible) {
    const k = r.dataset.homeKind;
    const members = k ? byKind.get(k) : null;
    if (members && members.length >= HOME_GROUP_MIN) {
      if (seen.has(k)) continue;
      seen.add(k);
      items.push({ kind: k, members });
    } else {
      items.push({ row: r });
    }
  }

  const collapsed = homeCollapsedGet();
  section.classList.toggle('is-collapsed', collapsed);
  head.querySelector('.home-needs-toggle').setAttribute('aria-expanded', String(!collapsed));
  head.querySelector('.home-needs-caret').dataset.open = collapsed ? '0' : '1';
  list.hidden = collapsed;

  const frag = [];
  const shown = homeNeedsUi.showAll ? items : items.slice(0, HOME_TOP_N);
  const extra = items.length - shown.length;
  items.forEach((item, idx) => {
    const show = idx < shown.length;
    if (item.row) {
      item.row.hidden = !show;
      frag.push(item.row);
      return;
    }
    const open = homeNeedsUi.expanded.has(item.kind);
    const noun = HOME_GROUP_NOUNS[item.kind] || `${item.kind.toLowerCase()} items`;
    const text = `${item.members.length} ${noun}`;
    const toggle = el('button', {
      class: 'home-group-toggle', type: 'button', 'aria-expanded': String(open),
      onclick: () => {
        if (homeNeedsUi.expanded.has(item.kind)) homeNeedsUi.expanded.delete(item.kind);
        else homeNeedsUi.expanded.add(item.kind);
        homeNeedsEnhance(host);
        const again = [...host.querySelectorAll('.home-group-toggle')].find((b) => b.dataset.kind === item.kind);
        if (again) again.focus();
      },
    }, [el('span', { class: 'home-needs-caret', 'aria-hidden': 'true', 'data-open': open ? '1' : '0' }), el('span', { class: 'home-group-text' }, text)]);
    toggle.dataset.kind = item.kind;
    const tone = item.members[0].querySelector('.status-pill, [class*="pill"]');
    const header = el('div', { class: 'home-row home-row--group', 'data-home-ui': '1', title: text }, [
      el('span', { class: tone ? tone.className : 'status-pill' }, item.kind),
      toggle,
      homeCloseControl(() => item.members, () => text),
    ]);
    header.hidden = !show;
    frag.push(header);
    item.members.forEach((m) => {
      m.classList.add('home-row--member');
      m.hidden = !(show && open);
      frag.push(m);
    });
  });
  if (!homeNeedsUi.showAll && extra > 0) {
    frag.push(el('div', { class: 'home-row home-row--more', 'data-home-ui': '1' }, [
      el('button', { class: 'home-more-btn', type: 'button', onclick: () => { homeNeedsUi.showAll = true; homeNeedsEnhance(host); } },
        `Show ${extra} more`),
    ]));
  } else if (homeNeedsUi.showAll && items.length > HOME_TOP_N) {
    frag.push(el('div', { class: 'home-row home-row--more', 'data-home-ui': '1' }, [
      el('button', { class: 'home-more-btn', type: 'button', onclick: () => { homeNeedsUi.showAll = false; homeNeedsEnhance(host); } }, 'Show fewer'),
    ]));
  }
  if (!items.length && hiddenRows.length) {
    frag.push(el('div', { class: 'home-row home-row--quiet', 'data-home-ui': '1' }, [el('span', { class: 'home-row-link' }, 'Nothing needs you right now.')]));
  }
  frag.forEach((n) => list.appendChild(n));

  // Head note: hidden count + restore, or a count when collapsed.
  const note = head.querySelector('.home-needs-note');
  note.innerHTML = '';
  if (collapsed && items.length) {
    note.appendChild(el('span', {}, `${items.length} item${items.length === 1 ? '' : 's'}. `));
  }
  if (hiddenRows.length) {
    note.appendChild(el('span', {}, `${hiddenRows.length} hidden. `));
    note.appendChild(el('button', {
      class: 'home-link home-restore', type: 'button',
      onclick: () => {
        const cur = homeHiddenLoad();
        hiddenRows.forEach((r) => { delete cur[r.dataset.homeKey]; });
        homeHiddenSave(cur);
        homeNeedsEnhance(host);
      },
    }, 'Show'));
  }
}

// Attach once per Needs you host; hook rows arrive later and re-trigger the pass.
function homeNeedsAttach(host) {
  if (!host._homeObs) {
    let queued = false;
    host._homeObs = new MutationObserver((records) => {
      // Opening/closing the close menu mutates a .home-x wrapper; that must not rebuild the rows.
      if (records.every((r) => r.target.nodeType === 1 && r.target.closest('.home-x'))) return;
      if (queued) return;
      queued = true;
      Promise.resolve().then(() => { queued = false; if (host.isConnected) homeNeedsEnhance(host); });
    });
  }
  homeNeedsEnhance(host);
}

function homeDayLabel(dayKey) {
  const today = dateKeyLocal(new Date());
  const tomorrow = dateKeyLocal(new Date(Date.now() + 24 * 3600 * 1000));
  const [y, m, d] = dayKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const pretty = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  if (dayKey === today) return `Today, ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  if (dayKey === tomorrow) return `Tomorrow, ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return pretty;
}

function buildHomeComingUp(host, posts, brandId) {
  host.innerHTML = '';
  const now = Date.now();
  const end = now + 7 * 24 * 3600 * 1000;
  const upcoming = posts
    .filter((p) => HOME_GOING_OUT.includes(p.status) && p.publish_at)
    .filter((p) => { const t = new Date(p.publish_at).getTime(); return t >= now && t <= end; })
    .sort((a, b) => new Date(a.publish_at) - new Date(b.publish_at));

  const section = el('section', { class: 'home-section' });
  section.appendChild(el('div', { class: 'home-section-head' }, [
    el('h2', { class: 'home-h2' }, 'Coming up'),
    upcoming.length ? el('a', { class: 'home-link', href: '#/planner' }, 'Open Planner') : null,
  ]));

  if (!upcoming.length) {
    section.appendChild(el('div', { class: 'home-empty' }, [
      el('p', {}, 'Nothing scheduled this week.'),
      el('button', {
        class: 'button primary sm', type: 'button',
        onclick: () => openNewPost(brandId ? { brandId } : {}),
      }, 'New post'),
    ]));
    host.appendChild(section);
    return;
  }

  const groups = new Map();
  for (const p of upcoming) {
    const key = postDayKey(p.publish_at);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const [key, items] of groups) {
    const group = el('div', { class: 'home-day' });
    group.appendChild(el('div', { class: 'home-day-label' }, homeDayLabel(key)));
    for (const p of items) {
      const time = new Date(p.publish_at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      group.appendChild(el('button', { class: 'home-post', type: 'button', onclick: () => openPostById(p.id) }, [
        el('span', { class: 'home-post-time' }, time),
        el('span', { class: 'home-post-platform' }, [platformIcon(p.platform, { size: 14 })]),
        el('span', { class: 'home-post-brand' }, brandName(p.brand_id)),
        el('span', { class: 'home-post-copy' }, homeFirstLine(p)),
        statusPill(p),
      ]));
    }
    section.appendChild(group);
  }
  host.appendChild(section);
}

function buildHomeRecent(host, posts) {
  host.innerHTML = '';
  const recent = posts
    .filter((p) => p.status === 'published')
    .sort((a, b) => String(b.published_at || b.updated_at || b.publish_at || '').localeCompare(String(a.published_at || a.updated_at || a.publish_at || '')))
    .slice(0, 5);
  if (!recent.length) return;
  const section = el('section', { class: 'home-section' });
  section.appendChild(el('h2', { class: 'home-h2' }, 'Recently posted'));
  for (const p of recent) {
    section.appendChild(el('div', { class: 'home-recent' }, [
      el('span', { class: 'home-post-platform' }, [platformIcon(p.platform, { size: 13 })]),
      el('span', { class: 'home-post-brand' }, brandName(p.brand_id)),
      el('button', { class: 'home-recent-copy', type: 'button', onclick: () => openPostById(p.id) }, homeFirstLine(p)),
      el('span', { class: 'home-recent-date' }, fmtDate(p.published_at || p.publish_at)),
      p.public_url ? el('a', { class: 'home-link', href: p.public_url, target: '_blank', rel: 'noopener noreferrer' }, 'View') : null,
    ]));
  }
  host.appendChild(section);
}

function buildHomeAnalyticsLine(host, analytics, brandId) {
  host.innerHTML = '';
  if (!analytics || !Array.isArray(analytics.brands)) return;
  const rows = brandId ? analytics.brands.filter((b) => String(b.brand_id) === String(brandId)) : analytics.brands;
  let postsN = 0;
  let eng = 0;
  for (const b of rows) {
    const t = b.totals && b.totals['30d'];
    if (!t) continue;
    postsN += t.posts_published || 0;
    eng += t.engagement || 0;
  }
  if (!postsN && !eng) return;
  host.appendChild(el('a', { class: 'home-link home-analytics-line', href: '#/analytics' },
    `Last 30 days: ${postsN} post${postsN === 1 ? '' : 's'}, ${eng} engagement${eng === 1 ? '' : 's'}. See Analytics`));
}

async function renderHome(view) {
  view.innerHTML = '';
  view.classList.add('view-default', 'home-view');
  markViewLive();

  let brandId = getStickyBrand();
  if (brandId && !state.brands.some((b) => String(b.id) === String(brandId))) brandId = '';

  const filter = el('select', { class: 'home-brand-filter', 'aria-label': 'Filter by brand' }, [
    el('option', { value: '' }, 'All brands'),
    ...state.brands.map((b) => el('option', { value: String(b.id) }, b.name)),
  ]);
  filter.value = brandId;
  const newBtn = el('button', {
    class: 'button primary md', type: 'button',
    onclick: () => openNewPost(brandId ? { brandId } : {}),
  }, 'New post');
  view.appendChild(pageHeader('Home', filter, newBtn));

  const needsHost = el('div');
  const upHost = el('div');
  const recentHost = el('div');
  const analyticsHost = el('div');
  view.append(needsHost, upHost, recentHost, analyticsHost);

  let data = null;
  function paint() {
    if (!data) return;
    const posts = brandId ? data.posts.filter((p) => String(p.brand_id) === String(brandId)) : data.posts;
    buildHomeNeedsYou(needsHost, posts, data.analytics, data.worker, brandId);
    buildHomeComingUp(upHost, posts, brandId);
    buildHomeRecent(recentHost, posts);
    buildHomeAnalyticsLine(analyticsHost, data.analytics, brandId);
    if (typeof blogHomeRows === 'function') blogHomeRows(needsHost, upHost, brandId); // BLOG HOOK: blog rows (70-blog.js)
    if (typeof webHomeRows === 'function') webHomeRows(needsHost, analyticsHost); // WEB HOOK: traffic line + alerts (80-web.js)
    homeNeedsAttach(needsHost);
  }

  filter.onchange = () => {
    brandId = filter.value;
    setStickyBrand(brandId);
    paint();
  };

  // Three parallel requests, no per-brand loops.
  let posts;
  try {
    const [p, worker, analytics] = await Promise.all([
      api('/api/posts'),
      api('/api/worker/status').catch(() => null),
      api('/api/analytics').catch(() => null),
    ]);
    posts = p;
    data = { posts, worker, analytics };
  } catch (err) {
    view.appendChild(inlineBanner(`Could not load posts: ${err.message}`, 'error'));
    return;
  }
  paint();
}
renderHome.replacesLegacy = true;
