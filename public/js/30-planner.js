// ---------------- D3: Planner ----------------
// Week / Month / List over one posts fetch, status filter chips, a drafts tray,
// drag-to-reschedule. Replaces the legacy Calendar and Review pages. The post
// editor is the drawer in 31-post-drawer.js.

const PLANNER_VIEW_KEY = 'pd_planner_view';
const PLANNER_TRAY_KEY = 'pd_planner_tray';
const PLANNER_FILTERS = [
  ['all', 'All'],
  ['drafts', 'Drafts'],
  ['scheduled', 'Scheduled'],
  ['posted', 'Posted'],
  ['attention', 'Needs attention'],
];
const PLANNER_STATE = { anchor: null, cleanupRegistered: false, dragId: null, expanded: new Set() };

// Local YYYY-MM-DD key (toISOString would shift late posts onto the next day).
function dateKeyLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Local calendar day of a stored publish_at (UTC ISO).
function postDayKey(iso) {
  return dateKeyLocal(new Date(iso));
}

function plannerSafeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function plannerSafeSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function plannerStartOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function plannerAddDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function plannerWeekStart(d) {
  const x = plannerStartOfDay(d);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); // Monday
  return x;
}
function plannerTimeShort(iso) {
  const d = new Date(iso);
  let h = d.getHours();
  const m = d.getMinutes();
  const suffix = h >= 12 ? 'p' : 'a';
  h = h % 12 || 12;
  return m ? `${h}:${String(m).padStart(2, '0')}${suffix}` : `${h}${suffix}`;
}
function plannerCopyLine(post) {
  const line = String(post.copy || '').split('\n').map((l) => l.trim()).find(Boolean);
  return line || '(no text yet)';
}
function plannerFilterKey(post) {
  const k = humanStatus(post).key;
  if (k === 'draft') return 'drafts';
  if (k === 'scheduled' || k === 'sending') return 'scheduled';
  if (k === 'posted') return 'posted';
  if (k === 'attention') return 'attention';
  return null; // canceled and unknown stay out of the Planner
}
function plannerReschedulable(post) {
  return RESCHEDULABLE_STATUSES.includes(post.status);
}

function plannerDayLabel(date, todayStart) {
  const diff = Math.round((plannerStartOfDay(date) - todayStart) / 86400000);
  const base = date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  if (diff === 0) return `Today, ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  if (diff === 1) return `Tomorrow, ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  return base;
}

// ---------------- D5: entries, folding, popover ----------------
// Every Planner item (social post or blog post) is described by one "entry" so a
// busy day can fold same-kind items into a single summary chip. Entry shape:
// { kind, groupKey, brandId, brandLabel, sort (minutes of day), timeLabel, title,
//   typeLabel, summaryLabel(n), icon(size), statusNode(), open(), chip(compact),
//   foldAlways }. 70-blog.js builds the blog ones (blogPlannerEntries).

// "Di-Hy AI Consulting" -> "Di-Hy". First word unless it is tiny.
function plannerBrandShort(name) {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return first.length > 2 ? first : String(name || '').trim();
}

// Brand color tag: dot + short name. Color comes from brands.colors.primary when set.
function plannerBrandColor(brandId) {
  const b = (state.brands || []).find((x) => x.id === brandId);
  const c = b && b.colors && typeof b.colors === 'object' ? b.colors.primary : null;
  if (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c)) {
    const lum = (parseInt(c.slice(1, 3), 16) * 299 + parseInt(c.slice(3, 5), 16) * 587 + parseInt(c.slice(5, 7), 16) * 114) / 1000;
    if (lum > 70) return c; // near-black brand colors vanish on the dark surface
  }
  return brandColor(brandId);
}
function plannerBrandTag(brandId, label) {
  const full = label || brandName(brandId);
  return el('span', { class: 'pl-tag', title: full }, [
    el('span', { class: 'pl-dot', style: `background:${plannerBrandColor(brandId)}` }),
    el('span', { class: 'pl-tag-text' }, plannerBrandShort(full)),
  ]);
}

// One chip. Week/full: two lines (icon + brand tag + time, then the title).
// Compact (month): one line.
function plannerBuildChip({ icon, brandId, brandLabel, time, title, pill, flag, compact, cls, tip, aria }) {
  const kids = [];
  if (compact) {
    kids.push(el('span', { class: 'pl-chip-icon' }, icon), el('span', { class: 'pl-dot', style: `background:${plannerBrandColor(brandId)}`, title: brandLabel }));
    kids.push(el('span', { class: 'pl-chip-copy' }, title));
    if (flag) kids.push(el('span', { class: `pl-chip-flag pl-chip-flag--${flag.tone}`, title: flag.label }));
  } else {
    kids.push(el('span', { class: 'pl-chip-top' }, plannerBrandTag(brandId, brandLabel)));
    kids.push(el('span', { class: 'pl-chip-copy' }, title));
    kids.push(el('span', { class: 'pl-chip-foot' }, [el('span', { class: 'pl-chip-icon' }, icon), time ? el('span', { class: 'pl-chip-time' }, time) : null, pill]));
  }
  return el('div', {
    class: `pl-chip${compact ? ' is-compact' : ' is-full'} ${cls || ''}`.trim(),
    role: 'button', tabindex: '0', title: tip, 'aria-label': aria,
  }, kids);
}

// Decide what a day shows. Returns [{entry}] and [{group, mixed?}] in time order.
function plannerFold(entries, limit) {
  const groups = new Map();
  for (const e of entries) {
    if (!groups.has(e.groupKey)) groups.set(e.groupKey, []);
    groups.get(e.groupKey).push(e);
  }
  const foldKeys = new Set();
  for (const [k, list] of groups) if (list[0].foldAlways && list.length > 2) foldKeys.add(k);
  const build = () => {
    const out = [];
    const placed = new Set();
    for (const e of entries) {
      if (foldKeys.has(e.groupKey)) {
        if (!placed.has(e.groupKey)) { placed.add(e.groupKey); out.push({ group: groups.get(e.groupKey) }); }
      } else out.push({ entry: e });
    }
    return out;
  };
  let out = build();
  if (out.length > limit) {
    for (const [k, list] of groups) if (list.length > 1) foldKeys.add(k);
    out = build();
  }
  if (out.length > limit) {
    const keep = out.slice(0, limit - 1);
    const rest = out.slice(limit - 1).flatMap((d) => d.group || [d.entry]);
    out = [...keep, { group: rest, mixed: true }];
  }
  return out;
}

function plannerGroupLabel(d) {
  const n = d.group.length;
  return d.mixed ? `${n} more posts` : d.group[0].summaryLabel(n);
}
function plannerGroupDayTitle(date) {
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}

// Popover: native <dialog> with every item of a folded group on its own row.
function plannerOpenPopover({ title, sub, entries, opener }) {
  const dlg = el('dialog', { class: 'pl-pop', 'aria-label': title });
  let done = false;
  let unregister = () => {};
  function close() {
    if (done) return;
    done = true;
    unregister();
    if (dlg.open) dlg.close();
    dlg.remove();
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  }
  const rows = [...entries].sort((a, b) => a.sort - b.sort).map((e) => {
    const row = el('button', { class: 'pl-pop-row', type: 'button', 'aria-label': `${e.typeLabel}, ${e.brandLabel}: ${e.title}` }, [
      el('span', { class: 'pl-pop-time' }, e.timeLabel || ''),
      el('span', { class: 'pl-pop-type' }, [e.icon(14), el('span', {}, e.typeLabel)]),
      plannerBrandTag(e.brandId, e.brandLabel),
      el('span', { class: 'pl-pop-title' }, e.title),
      e.statusNode(),
    ]);
    row.addEventListener('click', () => { close(); e.open(); });
    return row;
  });
  dlg.append(
    el('header', { class: 'pl-pop-head' }, [
      el('div', {}, [el('h2', { class: 'pl-pop-title-h' }, title), el('p', { class: 'pl-pop-sub' }, sub || '')]),
      el('button', { class: 'button ghost sm', type: 'button', 'aria-label': 'Close list', onclick: close }, 'Close'),
    ]),
    el('div', { class: 'pl-pop-list' }, rows)
  );
  dlg.addEventListener('cancel', (ev) => { ev.preventDefault(); close(); });
  dlg.addEventListener('mousedown', (ev) => { if (ev.target === dlg) close(); });
  document.body.appendChild(dlg);
  dlg.showModal();
  unregister = registerOverlay(close);
  return dlg;
}

// The folded-group chip. Opens the popover.
function plannerSummaryChip(d, { compact, date, cls = '' } = {}) {
  const first = d.group[0];
  const label = plannerGroupLabel(d);
  const brandId = d.mixed ? null : first.brandId;
  const sameBrand = !d.mixed && d.group.every((e) => e.brandId === first.brandId);
  const node = el('button', {
    class: `pl-chip pl-summary${compact ? ' is-compact' : ' is-full'} ${cls}`.trim(), type: 'button',
    title: `${label}. Click to see each one.`,
    'aria-haspopup': 'dialog', 'aria-label': `${label}. Open the list.`,
  }, compact ? [
    d.mixed ? null : el('span', { class: 'pl-chip-icon' }, first.icon(13)),
    sameBrand ? el('span', { class: 'pl-dot', style: `background:${plannerBrandColor(brandId)}` }) : null,
    el('span', { class: 'pl-chip-copy' }, label),
  ] : [
    // Week/list: the count reads first and large, the words sit under it at full width,
    // so a narrow day column never wraps one word per line.
    el('span', { class: 'pl-summary-head' }, [
      d.mixed ? null : el('span', { class: 'pl-chip-icon' }, first.icon(13)),
      sameBrand ? el('span', { class: 'pl-dot', style: `background:${plannerBrandColor(brandId)}` }) : null,
      el('strong', { class: 'pl-summary-count' }, String(d.group.length)),
      el('span', { class: 'pl-summary-go', 'aria-hidden': 'true' }, '›'),
    ]),
    el('span', { class: 'pl-chip-copy' }, label.replace(/^\d+\s+/, '')),
  ]);
  node.addEventListener('click', () => plannerOpenPopover({
    title: label, sub: date ? plannerGroupDayTitle(date) : '', entries: d.group, opener: node,
  }));
  return node;
}

async function renderPlanner(view) {
  view.innerHTML = '';
  view.classList.add('view-flush');

  const [initialPosts, ws] = await Promise.all([
    api('/api/posts'),
    api('/api/worker/status').catch(() => null),
  ]);
  let posts = Array.isArray(initialPosts) ? initialPosts : [];

  if (!PLANNER_STATE.anchor) PLANNER_STATE.anchor = plannerStartOfDay(new Date());
  if (!PLANNER_STATE.cleanupRegistered) {
    PLANNER_STATE.cleanupRegistered = true;
    onViewCleanup(() => { PLANNER_STATE.anchor = null; PLANNER_STATE.cleanupRegistered = false; PLANNER_STATE.expanded.clear(); });
  }

  let brandId = getStickyBrand();
  if (brandId && !state.brands.some((b) => String(b.id) === String(brandId))) brandId = '';
  let mode = plannerSafeGet(PLANNER_VIEW_KEY);
  if (!['week', 'month', 'list'].includes(mode)) mode = 'week';
  const q = routeQuery().status;
  let status = PLANNER_FILTERS.some(([k]) => k === q) ? q : 'all';
  const narrow = () => window.innerWidth < 1100;
  const savedTray = plannerSafeGet(PLANNER_TRAY_KEY);
  let trayOpen = savedTray ? savedTray === 'open' : !narrow();

  markViewLive();

  async function reload() {
    try {
      const fresh = await api('/api/posts');
      if (Array.isArray(fresh)) posts = fresh;
    } catch (err) {
      toast(`Could not refresh the Planner: ${err.message}`, 'error');
    }
    draw();
    if (typeof blogPlannerLoad === 'function') blogPlannerLoad(draw); // BLOG HOOK: blog chips (70-blog.js)
  }
  currentCalendarReload = reload;
  const openPost = (id) => openPostDrawer(id, { onChange: reload });
  const newPost = (extra = {}) => openNewPost({ brandId: brandId ? Number(brandId) : undefined, ...extra });

  // ---- controls ----
  const brandSelect = el('select', { class: 'sm', 'aria-label': 'Brand' }, [
    el('option', { value: '' }, 'All brands'),
    ...state.brands.map((b) => el('option', { value: b.id, selected: String(b.id) === String(brandId) ? 'selected' : undefined }, b.name)),
  ]);
  brandSelect.addEventListener('change', () => {
    brandId = brandSelect.value;
    setStickyBrand(brandId);
    draw();
  });

  const modeButtons = {};
  const modeGroup = el('div', { class: 'pl-seg', role: 'group', 'aria-label': 'View' });
  for (const [key, label] of [['week', 'Week'], ['month', 'Month'], ['list', 'List']]) {
    const b = el('button', { class: 'pl-seg-btn', type: 'button', onclick: () => { mode = key; plannerSafeSet(PLANNER_VIEW_KEY, key); draw(); } }, label);
    modeButtons[key] = b;
    modeGroup.appendChild(b);
  }

  const rangeLabel = el('span', { class: 'pl-range', 'aria-live': 'polite' });
  function shift(dir) {
    const a = PLANNER_STATE.anchor;
    if (mode === 'week') PLANNER_STATE.anchor = plannerAddDays(a, 7 * dir);
    else if (mode === 'month') PLANNER_STATE.anchor = new Date(a.getFullYear(), a.getMonth() + dir, 1);
    else PLANNER_STATE.anchor = plannerAddDays(a, 30 * dir);
    draw();
  }
  const navGroup = el('div', { class: 'pl-nav' }, [
    el('button', { class: 'button secondary sm', type: 'button', onclick: () => { PLANNER_STATE.anchor = plannerStartOfDay(new Date()); draw(); } }, 'Today'),
    el('button', { class: 'button ghost sm pl-nav-btn', type: 'button', 'aria-label': 'Previous', onclick: () => shift(-1) }, '‹'),
    el('button', { class: 'button ghost sm pl-nav-btn', type: 'button', 'aria-label': 'Next', onclick: () => shift(1) }, '›'),
    rangeLabel,
  ]);
  const newBtn = el('button', { class: 'button primary md', type: 'button', onclick: () => newPost() }, 'New post');

  view.appendChild(pageHeader('Planner', brandSelect, modeGroup, navGroup, newBtn));

  if (ws) {
    const line = ws.enabled === false
      ? 'Posting is paused. Scheduled posts will not go out.'
      : ws.dryRun ? 'Dry run: nothing reaches Blotato.' : 'Posting is LIVE.';
    view.appendChild(el('div', { class: `pl-status-line${ws.dryRun || ws.enabled === false ? ' is-warn' : ''}` }, line));
  }

  const chipsHost = el('div', { class: 'pl-filters', role: 'group', 'aria-label': 'Filter by status' });
  const attnHost = el('div', { class: 'pl-attn-host' });
  const mainHost = el('div', { class: 'pl-main' });
  const trayHost = el('aside', { class: 'pl-tray', 'aria-label': 'Drafts tray' });
  const layout = el('div', { class: 'pl-layout' }, [mainHost, trayHost]);
  view.append(chipsHost, attnHost, layout);

  // ---- data helpers ----
  const inBrand = () => posts.filter((p) => (!brandId || String(p.brand_id) === String(brandId)) && plannerFilterKey(p));
  function visible() {
    const list = inBrand();
    return status === 'all' ? list : list.filter((p) => plannerFilterKey(p) === status);
  }
  const byTime = (a, b) => new Date(a.publish_at) - new Date(b.publish_at) || a.id - b.id;

  function setStatus(next) {
    status = next;
    if (currentRoute().name === 'planner') {
      const qs = next === 'all' ? '' : `?status=${next}`;
      history.replaceState(null, '', `#/planner${qs}`);
    }
    draw();
  }

  // ---- chips ----
  function chip(post, { compact = false } = {}) {
    const h = humanStatus(post);
    const canDrag = plannerReschedulable(post);
    const plain = h.key === 'scheduled' && h.label === 'Scheduled';
    const pn = humanizePlatformName(post.platform);
    const node = plannerBuildChip({
      icon: platformIcon(post.platform, { size: 14 }),
      brandId: post.brand_id, brandLabel: brandName(post.brand_id),
      time: post.publish_at ? plannerTimeShort(post.publish_at) : '',
      title: plannerCopyLine(post),
      pill: !plain ? statusPill(post) : null,
      flag: h.key !== 'scheduled' ? { tone: h.tone, label: h.label } : null,
      compact,
      cls: `pl-chip--${h.key}${canDrag ? ' is-draggable' : ''}`,
      tip: `${brandName(post.brand_id)}, ${pn}, ${h.label}${post.publish_at ? `, ${fmtDate(post.publish_at)}` : ''}\n${post.copy || ''}`.trim(),
      aria: `${pn} post for ${brandName(post.brand_id)}, ${h.label}. ${plannerCopyLine(post)}`,
    });
    if (canDrag) node.setAttribute('draggable', 'true');
    node.addEventListener('click', () => openPost(post.id));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(post.id); }
    });
    if (canDrag) wireDrag(node, post.id);
    return node;
  }

  function socialEntry(p) {
    const pn = humanizePlatformName(p.platform);
    const d = p.publish_at ? new Date(p.publish_at) : null;
    return {
      kind: 'social', groupKey: `social:${p.platform}:${p.brand_id}`, id: p.id,
      brandId: p.brand_id, brandLabel: brandName(p.brand_id),
      sort: d ? d.getHours() * 60 + d.getMinutes() : 0,
      timeLabel: d ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '',
      title: plannerCopyLine(p), typeLabel: `${pn} post`,
      summaryLabel: (n) => `${n} ${pn} post${n === 1 ? '' : 's'}`,
      icon: (size) => platformIcon(p.platform, { size }),
      statusNode: () => statusPill(p),
      open: () => openPost(p.id),
      chip: (compact) => chip(p, { compact }),
    };
  }
  const entrySort = (a, b) => a.sort - b.sort || (a.id || 0) - (b.id || 0);
  function dayEntries(key, dayPosts) {
    const blogs = typeof blogPlannerEntries === 'function' ? blogPlannerEntries(key, { brandId, status, onChange: reload, redraw: draw }) : []; // BLOG HOOK
    return [...dayPosts.map(socialEntry), ...blogs].sort(entrySort);
  }

  function wireDrag(node, id) {
    node.addEventListener('dragstart', (e) => {
      PLANNER_STATE.dragId = id;
      e.dataTransfer.setData('text/plain', String(id));
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('is-dragging');
      layout.classList.add('is-dragging');
    });
    node.addEventListener('dragend', () => {
      PLANNER_STATE.dragId = null;
      node.classList.remove('is-dragging');
      layout.classList.remove('is-dragging');
      view.querySelectorAll('.is-drop').forEach((n) => n.classList.remove('is-drop'));
    });
  }

  async function movePost(postId, date) {
    const post = posts.find((p) => p.id === postId);
    if (!post) return;
    const todayStart = plannerStartOfDay(new Date());
    if (plannerStartOfDay(date) < todayStart) {
      toast('That day has already passed. Drop it on today or later.', 'warn');
      return;
    }
    if (post.publish_at && postDayKey(post.publish_at) === dateKeyLocal(date)) return;
    let h = 9;
    let m = 0;
    if (post.publish_at) {
      const old = new Date(post.publish_at);
      h = old.getHours();
      m = old.getMinutes();
    }
    let next = new Date(date.getFullYear(), date.getMonth(), date.getDate(), h, m, 0, 0);
    if (next.getTime() < Date.now() + 5 * 60000) {
      next = new Date(Date.now() + 15 * 60000);
      next.setMinutes(Math.ceil(next.getMinutes() / 15) * 15, 0, 0);
    }
    const prev = post.publish_at;
    post.publish_at = next.toISOString();
    draw();
    try {
      const res = await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { publish_at: post.publish_at } });
      Object.assign(post, { publish_at: res.publish_at, status: res.status, updated_at: res.updated_at });
      toast(`Moved to ${next.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} at ${next.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}.`, {
        tone: 'ok',
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { publish_at: prev } });
            } catch (err) {
              toast(`Could not undo: ${err.message}`, 'error');
            }
            reload();
          },
        },
      });
      draw();
    } catch (err) {
      post.publish_at = prev;
      draw();
      toast(`Could not move it: ${err.message}`, 'error');
    }
  }

  function wireDropTarget(node, date) {
    const past = plannerStartOfDay(date) < plannerStartOfDay(new Date());
    node.addEventListener('dragover', (e) => {
      if ((!PLANNER_STATE.dragId && !(typeof blogPlannerDragActive === 'function' && blogPlannerDragActive())) || past) return; // BLOG HOOK
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      node.classList.add('is-drop');
    });
    node.addEventListener('dragleave', (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove('is-drop');
    });
    node.addEventListener('drop', (e) => {
      e.preventDefault();
      node.classList.remove('is-drop');
      if (typeof blogPlannerDrop === 'function' && blogPlannerDrop(date)) return; // BLOG HOOK: dragged a blog chip
      const id = PLANNER_STATE.dragId || Number(e.dataTransfer.getData('text/plain'));
      PLANNER_STATE.dragId = null;
      if (id) movePost(id, date);
    });
  }

  // ---- day cells ----
  function dayCell(date, dayPosts, { compact = false, outside = false, withWeekday = false } = {}) {
    const todayStart = plannerStartOfDay(new Date());
    const key = dateKeyLocal(date);
    const isToday = key === dateKeyLocal(todayStart);
    const isPast = plannerStartOfDay(date) < todayStart;
    const cell = el('div', {
      class: `pl-day${isToday ? ' is-today' : ''}${isPast ? ' is-past' : ''}${outside ? ' is-outside' : ''}${compact ? ' is-compact' : ''}`,
      'data-day': key,
    });
    const headText = withWeekday
      ? [el('span', { class: 'pl-day-name' }, date.toLocaleDateString(undefined, { weekday: 'short' })), el('span', { class: 'pl-day-num' }, String(date.getDate()))]
      : [el('span', { class: 'pl-day-num' }, String(date.getDate()))];
    cell.appendChild(el('div', { class: 'pl-day-head' }, headText));
    if (typeof webPlannerTint === 'function') webPlannerTint(cell, key, brandId, compact); // WEB HOOK: traffic tint (80-web.js)
    const list = el('div', { class: 'pl-day-list' });
    plannerFold(dayEntries(key, dayPosts), compact ? 2 : 3).forEach((d) => {
      list.appendChild(d.entry ? d.entry.chip(compact) : plannerSummaryChip(d, { compact, date }));
    });
    cell.appendChild(list);
    if (!isPast) {
      cell.appendChild(el('button', {
        class: 'pl-add', type: 'button',
        'aria-label': `New post on ${date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`,
        onclick: () => newPost({ date: key, time: '09:00' }),
      }, '+ New post'));
    }
    wireDropTarget(cell, date);
    return cell;
  }

  function groupByDay(list) {
    const map = new Map();
    for (const p of list) {
      if (!p.publish_at) continue;
      const k = postDayKey(p.publish_at);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(p);
    }
    return map;
  }

  // ---- views ----
  function drawWeek(list) {
    const start = plannerWeekStart(PLANNER_STATE.anchor);
    const map = groupByDay(list);
    const grid = el('div', { class: 'pl-week' });
    for (let i = 0; i < 7; i += 1) {
      const d = plannerAddDays(start, i);
      grid.appendChild(dayCell(d, map.get(dateKeyLocal(d)) || [], { withWeekday: true }));
    }
    const end = plannerAddDays(start, 6);
    rangeLabel.textContent = start.getMonth() === end.getMonth()
      ? `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} to ${end.getDate()}, ${end.getFullYear()}`
      : `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} to ${end.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${end.getFullYear()}`;
    return grid;
  }

  function drawMonth(list) {
    const a = PLANNER_STATE.anchor;
    const first = new Date(a.getFullYear(), a.getMonth(), 1);
    const start = plannerWeekStart(first);
    const map = groupByDay(list);
    const wrap = el('div', { class: 'pl-month' });
    const names = el('div', { class: 'pl-month-names' });
    for (let i = 0; i < 7; i += 1) {
      names.appendChild(el('div', {}, plannerAddDays(start, i).toLocaleDateString(undefined, { weekday: 'short' })));
    }
    wrap.appendChild(names);
    const grid = el('div', { class: 'pl-month-grid' });
    const weeks = Math.ceil(((first.getDay() + 6) % 7 + new Date(a.getFullYear(), a.getMonth() + 1, 0).getDate()) / 7);
    for (let i = 0; i < weeks * 7; i += 1) {
      const d = plannerAddDays(start, i);
      grid.appendChild(dayCell(d, map.get(dateKeyLocal(d)) || [], { compact: true, outside: d.getMonth() !== a.getMonth() }));
    }
    wrap.appendChild(grid);
    rangeLabel.textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    return wrap;
  }

  function drawList(list) {
    const todayStart = plannerStartOfDay(new Date());
    const start = plannerStartOfDay(PLANNER_STATE.anchor);
    const end = plannerAddDays(start, 30);
    rangeLabel.textContent = `${start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} to ${plannerAddDays(end, -1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    const inRange = list.filter((p) => p.publish_at && new Date(p.publish_at) >= start && new Date(p.publish_at) < end).sort(byTime);
    const wrap = el('div', { class: 'pl-list' });
    const map = groupByDay(inRange);
    const startKey = dateKeyLocal(start);
    const endKey = dateKeyLocal(end);
    const blogDays = typeof blogPlannerDays === 'function' ? blogPlannerDays(brandId, status) : []; // BLOG HOOK
    const keys = [...new Set([...map.keys(), ...blogDays.filter((k) => k >= startKey && k < endKey)])].sort();
    if (!keys.length) {
      wrap.appendChild(emptyState('Nothing in this stretch.', 'New post', () => newPost()));
      return wrap;
    }
    for (const key of keys) {
      const [y, m, d] = key.split('-').map(Number);
      const date = new Date(y, m - 1, d);
      const group = el('section', { class: 'pl-group' });
      group.appendChild(el('h2', { class: 'pl-group-title' }, plannerDayLabel(date, todayStart)));
      for (const f of plannerFold(dayEntries(key, map.get(key) || []), 4)) {
        if (f.entry) {
          const e = f.entry;
          const row = el('div', { class: 'pl-row', role: 'button', tabindex: '0', onclick: () => e.open() }, [
            el('span', { class: 'pl-row-time' }, e.timeLabel),
            plannerBrandTag(e.brandId, e.brandLabel),
            el('span', { class: 'pl-row-platform' }, [e.icon(14), el('span', {}, e.typeLabel)]),
            el('span', { class: 'pl-row-copy' }, e.title),
            e.statusNode(),
          ]);
          row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); e.open(); } });
          group.appendChild(row);
        } else {
          group.appendChild(plannerSummaryChip(f, { date, cls: 'pl-summary--row' }));
        }
      }
      wrap.appendChild(group);
    }
    return wrap;
  }

  // ---- strips ----
  function drawChips() {
    const base = inBrand();
    const counts = { all: base.length, drafts: 0, scheduled: 0, posted: 0, attention: 0 };
    base.forEach((p) => { counts[plannerFilterKey(p)] += 1; });
    chipsHost.innerHTML = '';
    for (const [key, label] of PLANNER_FILTERS) {
      chipsHost.appendChild(el('button', {
        class: `pl-filter${status === key ? ' is-active' : ''}${key === 'attention' && counts.attention ? ' is-alert' : ''}`,
        type: 'button', 'aria-pressed': status === key ? 'true' : 'false',
        onclick: () => setStatus(key),
      }, [label, el('span', { class: 'pl-count' }, String(counts[key]))]));
    }
    const blogBtn = typeof blogPlannerFilterButton === 'function' ? blogPlannerFilterButton(brandId, draw) : null; // BLOG HOOK
    if (blogBtn) chipsHost.appendChild(blogBtn);
    const webBtn = typeof webPlannerFilterButton === 'function' ? webPlannerFilterButton(brandId, draw) : null; // WEB HOOK: Traffic toggle (80-web.js)
    if (webBtn) chipsHost.appendChild(webBtn);
  }

  function drawAttention() {
    attnHost.innerHTML = '';
    const items = inBrand().filter((p) => plannerFilterKey(p) === 'attention').sort((a, b) => new Date(a.publish_at || 0) - new Date(b.publish_at || 0));
    if (!items.length || status === 'attention') return;
    // One quiet line, closable. It comes back only when the set of posts changes.
    const sig = items.map((p) => `${p.id}:${p.status}`).join(',');
    let hiddenSig = null;
    try { hiddenSig = localStorage.getItem('pd_planner_attn_hidden'); } catch (_) {}
    if (hiddenSig === sig) return;
    const strip = el('div', { class: 'pl-attn', role: 'region', 'aria-label': 'Posts needing attention' }, [
      el('span', { class: 'pl-attn-title' }, items.length === 1 ? '1 post needs attention.' : `${items.length} posts need attention.`),
      el('button', { class: 'button secondary sm', type: 'button', onclick: () => (items.length === 1 ? openPost(items[0].id) : setStatus('attention')) }, items.length === 1 ? 'Review' : 'Show them'),
      el('button', {
        class: 'pl-attn-close', type: 'button', 'aria-label': 'Hide until something changes', title: 'Hide until something changes',
        onclick: () => {
          try { localStorage.setItem('pd_planner_attn_hidden', sig); } catch (_) {}
          drawAttention();
          if (typeof toast === 'function') toast('Hidden until something changes. Home and the Needs attention filter still list them.');
        },
      }, '×'),
    ]);
    attnHost.appendChild(strip);
  }

  function drawTray() {
    const drafts = posts
      .filter((p) => (!brandId || String(p.brand_id) === String(brandId)) && !p.publish_at && ['draft', 'approved'].includes(p.status))
      .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
    layout.classList.toggle('tray-collapsed', !trayOpen);
    trayHost.innerHTML = '';
    const toggle = el('button', {
      class: 'pl-tray-toggle', type: 'button', 'aria-expanded': trayOpen ? 'true' : 'false',
      onclick: () => { trayOpen = !trayOpen; plannerSafeSet(PLANNER_TRAY_KEY, trayOpen ? 'open' : 'closed'); drawTray(); },
    }, [el('span', {}, 'Drafts'), el('span', { class: 'pl-count' }, String(drafts.length)), el('span', { class: 'pl-tray-caret', 'aria-hidden': 'true' }, trayOpen ? '›' : '‹')]);
    trayHost.appendChild(toggle);
    if (!trayOpen) return;
    const body = el('div', { class: 'pl-tray-body' });
    if (!drafts.length) {
      body.appendChild(el('p', { class: 'pl-tray-empty' }, 'No unscheduled drafts. Drafts without a time land here, ready to drag onto a day.'));
    } else {
      body.appendChild(el('p', { class: 'pl-tray-hint' }, 'Drag a draft onto a day. It keeps its draft status and gets a 9 AM time.'));
      for (const p of drafts) {
        const h = humanStatus(p);
        const card = el('div', {
          class: 'pl-tray-card is-draggable', role: 'button', tabindex: '0', draggable: 'true',
          'aria-label': `${humanizePlatformName(p.platform)} draft for ${brandName(p.brand_id)}. ${plannerCopyLine(p)}`,
        }, [
          el('div', { class: 'pl-tray-meta' }, [
            el('span', { class: 'pl-dot', style: `background:${brandColor(p.brand_id)}` }),
            el('span', {}, brandName(p.brand_id)),
            platformIcon(p.platform, { size: 13 }),
            h.key !== 'draft' ? statusPill(p) : null,
          ]),
          el('div', { class: 'pl-tray-copy' }, plannerCopyLine(p)),
        ]);
        card.addEventListener('click', () => openPost(p.id));
        card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPost(p.id); } });
        wireDrag(card, p.id);
        body.appendChild(card);
      }
    }
    trayHost.appendChild(body);
  }

  function draw() {
    for (const [key, btn] of Object.entries(modeButtons)) {
      btn.classList.toggle('is-active', key === mode);
      btn.setAttribute('aria-pressed', key === mode ? 'true' : 'false');
    }
    const list = visible();
    mainHost.innerHTML = '';
    mainHost.appendChild(mode === 'week' ? drawWeek(list) : mode === 'month' ? drawMonth(list) : drawList(list));
    drawChips();
    drawAttention();
    drawTray();
  }

  draw();
  if (typeof blogPlannerLoad === 'function') blogPlannerLoad(draw); // BLOG HOOK: blog chips (70-blog.js)
}
renderPlanner.replacesLegacy = true;

// #/post/:id keeps working: show the Planner and open the drawer on that post.
async function renderPostDetail(view, params) {
  const id = Number(params[0]);
  let post = null;
  try {
    post = await api(`/api/posts/${id}`);
  } catch (err) {
    view.appendChild(inlineBanner(err.status === 404 ? 'That post no longer exists.' : `Could not load the post: ${err.message}`, 'error'));
    return;
  }
  if (post.publish_at) PLANNER_STATE.anchor = plannerStartOfDay(new Date(post.publish_at));
  await renderPlanner(view);
  if (postDrawerCurrent && postDrawerCurrent.id === id) return;
  openPostDrawer(id, {
    onChange: () => refreshView(),
    onClose: () => {
      if (currentRoute().name === 'post') history.replaceState(null, '', '#/planner');
    },
  });
}

// Old routes still resolve at load time in 99-main.js; the router forwards
// them to #/planner because renderPlanner.replacesLegacy is set.
function renderCalendar(view) { return renderPlanner(view); }
function renderReview(view) { return renderPlanner(view); }
