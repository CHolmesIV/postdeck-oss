// js/70-blog.js - Blog add-on frontend (docs/BLOG_ADDON_SPEC.md).
// Owns: #/blog view, the blog editor drawer, and the hooks the Planner, Home and
// Settings files call (blogPlanner*, blogHomeRows, blogSettingsTab).
// Everything is prefixed blog/BLOG_/bl- so it never collides with other files.

const BLOG_LAST_SITE_KEY = 'pd_blog_site';
const BLOG_PLANNER_KEY = 'pd_planner_blog';
// Edited through the Schedule / Approve controls, never as free fields.
const BLOG_MANAGED = ['status', 'needs_cb_review', 'publish_date', 'publish_time', 'slug'];
const BLOG_STATE = {
  planner: { items: [], redraw: null, drag: null },
  home: { at: 0, sites: [], posts: {} },
  editor: null,
  tok: 0,
};

// ---------------- small helpers ----------------

function blogSafeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function blogSafeSet(key, value) { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } }
function blogEnc(s) { return encodeURIComponent(String(s)); }
function blogPath(siteId, rest = '') { return `/api/blog/sites/${blogEnc(siteId)}${rest}`; }
function blogPostPath(siteId, slug, rest = '') { return blogPath(siteId, `/posts/${blogEnc(slug)}${rest}`); }

function blogLabel(key) {
  const s = String(key).replace(/_/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function blogWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}
function blogWordLabel(n) { return `${Number(n || 0).toLocaleString()} word${Number(n) === 1 ? '' : 's'}`; }

function blogIsEmpty(v) {
  return v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length);
}

function blogSlugify(text) {
  return String(text || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function blogTodayKey() { return dateKeyLocal(new Date()); }

// "Tue Nov 3, 9:00 AM" from a YYYY-MM-DD and optional HH:MM.
function blogWhen(dateStr, timeStr) {
  if (!dateStr) return 'No date';
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh, mm] = String(timeStr || '').split(':').map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0);
  if (Number.isNaN(dt.getTime())) return String(dateStr);
  const day = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  if (!timeStr) return day;
  return `${day}, ${dt.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function blogWhenIso(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}
function blogTimeShort(hhmm) {
  if (!hhmm) return '';
  const [h, m] = String(hhmm).split(':').map(Number);
  if (Number.isNaN(h)) return '';
  const suffix = h >= 12 ? 'p' : 'a';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

function blogStatusPill(post) {
  const map = { draft: ['Draft', 'neutral'], scheduled: ['Scheduled', 'gold'], published: ['Published', 'ok'] };
  const [label, tone] = map[post.status] || [String(post.status || 'Draft'), 'neutral'];
  return el('span', { class: `status-pill status-pill--${tone}` }, label);
}
function blogReviewPill(post) {
  if (post.status === 'published') return null;
  return post.needs_review
    ? el('span', { class: 'status-pill status-pill--info' }, 'Needs your review')
    : el('span', { class: 'status-pill status-pill--ok' }, 'Approved');
}

function blogSiteDefaultTime(site) { return (site && site.default_time) || '09:00'; }

function blogPostWhen(site, post) {
  if (post.status === 'published') return blogWhen(post.publish_date);
  return blogWhen(post.publish_date, post.publish_date ? (post.publish_time || blogSiteDefaultTime(site)) : null);
}

function blogNextFreeDay(posts, excludeSlug) {
  const taken = new Set((posts || []).filter((p) => p.slug !== excludeSlug && p.publish_date).map((p) => p.publish_date));
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < 180; i += 1) {
    d.setDate(d.getDate() + 1);
    const key = dateKeyLocal(d);
    if (!taken.has(key)) return key;
  }
  return dateKeyLocal(d);
}

async function blogWorkerDry() {
  try { return !!(await api('/api/worker/status')).dryRun; } catch { return true; }
}

async function blogBusy(btn, fn) {
  if (btn) { btn.disabled = true; btn.classList.add('is-pending'); }
  try { return await fn(); } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('is-pending'); }
  }
}

function blogDocIcon(size = 13) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z', 'M14 3v6h6', 'M8 13h8M8 17h5']) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
  }
  return svg;
}

// Collapsible release log: summary line plus the raw output.
function blogRunLog(run) {
  if (!run) return null;
  const mode = run.mode === 'dry' ? 'Dry run' : 'Live release';
  const when = run.finished_at || run.started_at;
  return el('div', { class: `bl-run${run.ok ? ' is-ok' : ' is-bad'}` }, [
    el('div', { class: 'bl-run-head' }, [
      el('span', { class: `status-pill status-pill--${run.ok ? 'ok' : 'bad'}` }, run.ok ? 'Succeeded' : 'Failed'),
      el('span', { class: 'bl-run-meta' }, `${mode}${run.trigger === 'schedule' ? ', scheduled' : ''}${when ? `, ${fmtDate(when)}` : ''}`),
    ]),
    run.summary ? el('div', { class: 'bl-run-summary' }, run.summary) : null,
    Array.isArray(run.released) && run.released.length
      ? el('div', { class: 'bl-run-summary' }, `Released: ${run.released.join(', ')}`)
      : null,
    run.output
      ? el('details', { class: 'bl-run-log' }, [el('summary', {}, 'Show log'), el('pre', {}, run.output)])
      : null,
  ]);
}

async function blogApprove(siteId, slug) {
  return api(blogPostPath(siteId, slug, '/approve'), { method: 'POST', body: {} });
}

// Confirm, then release everything due on the site. Returns the run or null.
async function blogReleaseSite(site, { onDone } = {}) {
  const dry = await blogWorkerDry();
  const ok = await confirmDialog({
    title: `Release ${site.name} now?`,
    body: dry
      ? 'DRY RUN is on. PostDeck builds the site and runs the checks, but nothing is uploaded.'
      : `This goes LIVE on ${site.live_url || site.name} right away. Every approved post due today releases together.`,
    confirmLabel: dry ? 'Run dry release' : 'Release now',
    tone: dry ? 'primary' : 'destructive',
  });
  if (!ok) return null;
  try {
    const res = await api(blogPath(site.id, '/release'), { method: 'POST', body: {} });
    const run = res && res.run ? res.run : res;
    if (run && run.ok === false) toast(`Release failed: ${run.summary || 'see the log on the Blog page.'}`, 'error');
    else toast(dry ? 'Dry run finished. Nothing was uploaded.' : `Released on ${site.name}.`, 'ok');
    if (onDone) onDone(run);
    return run;
  } catch (err) {
    const code = err.data && err.data.error;
    if (code === 'blocked') toast('Release blocked. Some posts due today still need your review.', 'error');
    else if (code === 'in_flight') toast('A release is already running for this site.', 'warn');
    else toast(`Could not release: ${err.message}`, 'error');
    if (onDone) onDone(null);
    return null;
  }
}

// ---------------- #/blog ----------------

async function renderBlog(view, params = []) {
  view.innerHTML = '';
  view.classList.add('view-default', 'blog-view');
  markViewLive();

  let sites;
  try {
    sites = await api('/api/blog/sites');
  } catch (err) {
    view.appendChild(pageHeader('Blog'));
    view.appendChild(inlineBanner(`Could not load blog sites: ${err.message}`, 'error'));
    return;
  }
  if (!Array.isArray(sites) || !sites.length) {
    view.appendChild(pageHeader('Blog'));
    view.appendChild(emptyState('No blog sites found yet.'));
    return;
  }

  const requested = params[0] ? decodeURIComponent(params[0]) : (routeQuery().site || ''); // WEB HOOK: #/blog?site=<id>
  const stored = blogSafeGet(BLOG_LAST_SITE_KEY);
  const site = sites.find((s) => s.id === requested) || sites.find((s) => s.id === stored) || sites[0];
  blogSafeSet(BLOG_LAST_SITE_KEY, site.id);

  const reload = () => refreshView();
  const newBtn = el('button', { class: 'button primary md', type: 'button', onclick: () => openBlogEditor(site.id, null, { onChange: reload }) }, 'New blog post');

  if (typeof webBlogMaybeOpen === 'function') webBlogMaybeOpen(site.id, reload); // WEB HOOK: &new=1&keyword= / &open=<slug> (80-web.js)

  let posts = [];
  let ws = null;
  let postsError = null;
  await Promise.all([
    api(blogPath(site.id, '/posts')).then((p) => { posts = Array.isArray(p) ? p : []; }).catch((err) => { postsError = err; }),
    api('/api/worker/status').then((w) => { ws = w; }).catch(() => {}),
  ]);

  const now = Date.now();
  const blocked = Array.isArray(site.blocked) ? site.blocked : [];
  const dueApproved = posts.filter((p) => p.status === 'scheduled' && !p.needs_review && !p.released && p.due_at && new Date(p.due_at).getTime() <= now);
  const actions = [newBtn];
  if (dueApproved.length && !blocked.length && !site.releasing) {
    const relBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Release now');
    relBtn.onclick = () => blogBusy(relBtn, () => blogReleaseSite(site, { onDone: reload }));
    actions.unshift(relBtn);
  }
  view.appendChild(pageHeader('Blog', actions));

  view.appendChild(el('nav', { class: 'bl-tabs', 'aria-label': 'Blog sites' }, sites.map((s) => el('a', {
    class: `bl-tab${s.id === site.id ? ' active' : ''}`,
    href: `#/blog/${blogEnc(s.id)}`,
    'aria-current': s.id === site.id ? 'page' : null,
  }, [s.name, s.counts && s.counts.needs_review ? el('span', { class: 'bl-tab-count', title: 'Needs your review' }, String(s.counts.needs_review)) : null]))));

  // ---- status strip ----
  const runHost = el('div');
  const strip = el('section', { class: 'bl-strip', 'aria-label': `${site.name} status` });
  const rows = [];
  rows.push(el('div', { class: 'bl-strip-row' }, [
    el('span', { class: 'bl-strip-label' }, 'Live site'),
    site.live_url
      ? el('a', { class: 'bl-link', href: site.live_url, target: '_blank', rel: 'noopener noreferrer' }, site.live_url.replace(/^https?:\/\//, ''))
      : el('span', { class: 'bl-muted' }, 'No live URL found in build_blog.py'),
    ws ? el('span', { class: `status-pill status-pill--${ws.dryRun ? 'info' : 'ok'}` }, ws.dryRun ? 'DRY RUN' : 'LIVE') : null,
  ]));
  rows.push(el('div', { class: 'bl-strip-row' }, [
    el('span', { class: 'bl-strip-label' }, 'Next release'),
    site.next_due
      ? el('span', {}, `Next release: ${blogWhenIso(site.next_due.at)} - ${site.next_due.title}`)
      : el('span', { class: 'bl-muted' }, 'Nothing approved and scheduled'),
    site.paused ? el('a', { class: 'status-pill status-pill--bad bl-pill-link', href: '#/settings/blogs' }, 'Releases paused') : null,
  ]));
  const last = site.last_release;
  rows.push(el('div', { class: 'bl-strip-row' }, [
    el('span', { class: 'bl-strip-label' }, 'Last release'),
    site.releasing
      ? el('span', {}, 'Releasing now...')
      : last
        ? el('span', { class: 'bl-strip-last' }, [
          el('span', { class: `status-pill status-pill--${last.ok ? 'ok' : 'bad'}` }, last.ok ? 'OK' : 'Failed'),
          el('span', {}, ` ${fmtDate(last.finished_at || last.started_at)}${last.summary ? `, ${last.summary}` : ''}`),
        ])
        : el('span', { class: 'bl-muted' }, 'No releases yet'),
  ]));
  strip.append(...rows, el('p', { class: 'bl-rule' }, 'Approved posts go live at their scheduled time while PostDeck is open. Release now publishes right away.'));
  view.append(strip, runHost);
  if (last && !last.ok && last.output) runHost.appendChild(blogRunLog(last));

  // ---- blocked banner ----
  if (blocked.length) {
    const box = el('section', { class: 'bl-blocked', role: 'alert' }, [
      el('h2', { class: 'bl-blocked-title' }, 'Release blocked'),
      el('p', {}, `These posts are due but still need your review. Nothing releases on ${site.name} until you approve them or move their dates.`),
    ]);
    for (const b of blocked) {
      const approveBtn = el('button', { class: 'button primary sm', type: 'button' }, 'Approve');
      const moveBtn = el('button', { class: 'button secondary sm', type: 'button' }, 'Move date');
      approveBtn.onclick = () => blogBusy(approveBtn, async () => {
        try { await blogApprove(site.id, b.slug); toast(`Approved "${b.title}".`); reload(); } catch (err) { toast(`Could not approve: ${err.message}`, 'error'); }
      });
      moveBtn.onclick = async () => {
        const date = await promptDialog({ title: 'Move date', body: `Pick a new date for "${b.title}".`, label: 'New date', type: 'date', value: b.publish_date || blogTodayKey(), confirmLabel: 'Move' });
        if (!date) return;
        try { await api(blogPostPath(site.id, b.slug, '/schedule'), { method: 'POST', body: { publish_date: date } }); toast(`Moved to ${blogWhen(date)}.`); reload(); } catch (err) { toast(`Could not move it: ${err.message}`, 'error'); }
      };
      box.appendChild(el('div', { class: 'bl-blocked-row' }, [
        el('div', { class: 'bl-blocked-main' }, [el('strong', {}, b.title), el('span', { class: 'bl-muted' }, ` was due ${blogWhen(b.publish_date)}`)]),
        el('div', { class: 'bl-row-actions' }, [approveBtn, moveBtn]),
      ]));
    }
    view.appendChild(box);
  }

  if (postsError) {
    view.appendChild(inlineBanner(`Could not load posts: ${postsError.message}`, 'error'));
    return;
  }
  if (!posts.length) {
    view.appendChild(emptyState('No posts on this site yet.', 'New blog post', () => openBlogEditor(site.id, null, { onChange: reload })));
    return;
  }

  // ---- lists ----
  const open = (p) => openBlogEditor(site.id, p.slug, { onChange: reload });
  const byDate = (a, b) => String(a.publish_date || '9999').localeCompare(String(b.publish_date || '9999')) || String(a.publish_time || '').localeCompare(String(b.publish_time || ''));
  const needsReview = posts.filter((p) => p.status !== 'published' && p.needs_review).sort(byDate);
  const scheduled = posts.filter((p) => p.status === 'scheduled' && !p.needs_review).sort(byDate);
  const drafts = posts.filter((p) => p.status === 'draft' && !p.needs_review).sort(byDate);
  const published = posts.filter((p) => p.status === 'published').sort((a, b) => String(b.publish_date || '').localeCompare(String(a.publish_date || '')));

  // Each section is a collapsible <details>. Open state is remembered per site.
  // Published collapses by default once it has more than 10 posts.
  function section(title, hint, list, { hideIfEmpty = false, defaultOpen = true } = {}) {
    if (!list.length && hideIfEmpty) return null;
    const storeKey = `pd_blog_open:${site.id}:${title}`;
    const saved = blogSafeGet(storeKey);
    const isOpen = saved === 'open' ? true : saved === 'closed' ? false : defaultOpen;
    const head = [
      el('h2', { class: 'bl-h2' }, title),
      el('span', { class: 'bl-count', 'aria-label': `${list.length} posts` }, String(list.length)),
      el('span', { class: 'bl-caret', 'aria-hidden': 'true' }),
    ];
    const body = el('div', { class: 'bl-list' }, list.length ? list.map((p) => blogRow(site, p, open)) : [el('p', { class: 'bl-empty' }, hint)]);
    const d = el('details', { class: 'bl-section' }, [el('summary', { class: 'bl-section-head' }, head), body]);
    if (isOpen) d.setAttribute('open', 'open');
    d.addEventListener('toggle', () => blogSafeSet(storeKey, d.open ? 'open' : 'closed'));
    return d;
  }
  view.appendChild(section('Needs your review', 'Nothing waiting on you.', needsReview));
  view.appendChild(section('Scheduled', 'No approved posts are scheduled. Approve a post and give it a date.', scheduled));
  view.appendChild(section('Drafts', 'No approved drafts without a date.', drafts));
  const pub = section('Published', '', published, { hideIfEmpty: true, defaultOpen: published.length <= 10 });
  if (pub) view.appendChild(pub);
  if (typeof webBlogStats === 'function') webBlogStats(site, view); // WEB HOOK: 28-day views on published rows (80-web.js)
}

function blogRow(site, post, onOpen) {
  const f = post.fields || {};
  const meta = [el('span', {}, blogPostWhen(site, post))];
  if (f.cluster) meta.push(el('span', {}, blogLabel(String(f.cluster).replace(/-/g, ' '))));
  meta.push(el('span', {}, blogWordLabel(post.word_count)));
  if (post.status !== 'published') meta.push(el('span', { class: post.needs_review ? 'bl-meta-review' : '' }, post.needs_review ? 'Needs your review' : 'Approved'));
  const row = el('div', { class: 'bl-row', role: 'button', tabindex: '0', 'data-slug': post.slug, 'aria-label': `${post.title || post.slug}, ${blogPostWhen(site, post)}${post.status !== 'published' ? (post.needs_review ? ', needs your review' : ', approved') : ''}` }, [
    el('div', { class: 'bl-row-main' }, [
      el('div', { class: 'bl-row-title' }, post.title || post.slug),
      el('div', { class: 'bl-row-meta' }, meta),
    ]),
    el('div', { class: 'bl-row-pills' }, [blogStatusPill(post), el('span', { class: 'bl-row-go', 'aria-hidden': 'true' }, '›')]),
  ]);
  row.addEventListener('click', () => onOpen(post));
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(post); } });
  return row;
}

// ---------------- the editor drawer ----------------

async function openBlogEditor(siteId, slug, { onChange, prefill } = {}) {
  if (BLOG_STATE.editor) BLOG_STATE.editor.closeSilently();
  const opener = document.activeElement;
  const ctx = {
    siteId, slug: slug || null, isNew: !slug,
    site: null, schema: [], post: null, sitePosts: [],
    fields: {}, body: '', mtime: null,
    dirtyFields: new Set(), bodyDirty: false, edited: false,
    saveTimer: null, saving: Promise.resolve(), changed: false, closed: false, conflict: false,
    tab: 'edit', preview: null, previewStale: true,
    dry: true, inputs: {}, sched: { date: '', time: '', dirty: false },
    lastRun: null, blocked: null,
  };

  const scrim = el('div', { class: 'pd-scrim' });
  const panel = el('aside', { class: 'pd-drawer bl-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Blog post', tabindex: '-1' });
  const content = el('div', { class: 'pd-drawer-inner' }, el('div', { class: 'pd-loading' }, 'Loading post...'));
  panel.appendChild(content);
  document.body.append(scrim, panel);
  requestAnimationFrame(() => { scrim.classList.add('is-open'); panel.classList.add('is-open'); });
  panel.focus();

  const unregister = registerOverlay(() => closeDrawer({ notifyChange: false, immediate: true }));

  function notify() {
    if (typeof onChange === 'function') onChange();
    else if (typeof refreshView === 'function') refreshView();
  }

  function focusables() {
    return [...panel.querySelectorAll('a[href], button:not([disabled]), textarea:not([readonly]), input:not([disabled]):not([readonly]), select:not([disabled]), summary')]
      .filter((n) => !n.closest('[hidden]') && n.offsetParent !== null);
  }
  function onKey(e) {
    if (document.querySelector('dialog[open]')) return;
    if (e.key === 'Escape') { e.preventDefault(); requestClose(); return; }
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  document.addEventListener('keydown', onKey);
  scrim.addEventListener('mousedown', () => requestClose());

  function closeDrawer({ notifyChange = true, immediate = false } = {}) {
    if (ctx.closed) return;
    ctx.closed = true;
    clearTimeout(ctx.saveTimer);
    const hadDirty = !ctx.isNew && !ctx.conflict && (ctx.dirtyFields.size > 0 || ctx.bodyDirty);
    if (hadDirty) ctx.saving = ctx.saving.then(doSave);
    document.removeEventListener('keydown', onKey);
    unregister();
    if (BLOG_STATE.editor && BLOG_STATE.editor.token === ctx) BLOG_STATE.editor = null;
    const remove = () => { scrim.remove(); panel.remove(); };
    if (immediate) remove();
    else {
      scrim.classList.remove('is-open');
      panel.classList.remove('is-open');
      setTimeout(remove, 200);
    }
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    if (notifyChange && (ctx.changed || hadDirty)) ctx.saving.then(() => notify());
  }
  BLOG_STATE.editor = { token: ctx, closeSilently: () => closeDrawer({ notifyChange: false, immediate: true }) };

  async function requestClose() {
    if (ctx.closed) return;
    if (ctx.isNew) {
      if (ctx.edited) {
        const save = await confirmDialog({ title: 'Save this post?', body: 'It has not been saved yet.', confirmLabel: 'Save', cancelLabel: 'Not yet' });
        if (save) {
          if (!(await createPost())) return;
          closeDrawer({});
          return;
        }
        const discard = await confirmDialog({ title: 'Discard this post?', body: 'Everything you typed will be lost.', confirmLabel: 'Discard', cancelLabel: 'Keep editing', tone: 'destructive' });
        if (!discard) return;
        closeDrawer({ notifyChange: false });
        return;
      }
      closeDrawer({ notifyChange: false });
      return;
    }
    try {
      await flushSave();
    } catch (err) {
      const discard = await confirmDialog({ title: 'Edits not saved', body: `${err.message} Close anyway and lose them?`, confirmLabel: 'Discard edits', cancelLabel: 'Keep editing', tone: 'destructive' });
      if (!discard) return;
      ctx.dirtyFields.clear();
      ctx.bodyDirty = false;
    }
    if (ctx.sched.dirty) {
      const discard = await confirmDialog({ title: 'Discard the new date?', body: 'You picked a date or time but did not schedule it. Your text edits are already saved.', confirmLabel: 'Discard date', cancelLabel: 'Keep editing', tone: 'destructive' });
      if (!discard) return;
    }
    closeDrawer({});
  }

  // ---- saving ----
  const savedNote = el('span', { class: 'pd-saved', 'aria-live': 'polite' });
  function setSaved(text, tone) {
    savedNote.textContent = text;
    savedNote.className = `pd-saved${tone ? ` pd-saved--${tone}` : ''}`;
  }

  function markDirty(key) {
    ctx.edited = true;
    ctx.previewStale = true;
    if (key === '__body') ctx.bodyDirty = true; else ctx.dirtyFields.add(key);
    if (ctx.isNew) { setSaved('Not saved yet'); return; }
    setSaved('');
    if (ctx.conflict) return;
    clearTimeout(ctx.saveTimer);
    ctx.saveTimer = setTimeout(() => { ctx.saving = ctx.saving.then(doSave); }, 1500);
  }

  async function doSave() {
    if (ctx.isNew || ctx.conflict) return;
    if (!ctx.dirtyFields.size && !ctx.bodyDirty) return;
    const keys = [...ctx.dirtyFields];
    const fields = {};
    keys.forEach((k) => { fields[k] = ctx.fields[k]; });
    const sendBody = ctx.bodyDirty;
    const body = { fields, mtime: ctx.mtime };
    if (sendBody) body.body_md = ctx.body;
    ctx.dirtyFields.clear();
    ctx.bodyDirty = false;
    setSaved('Saving...');
    try {
      const res = await api(blogPostPath(siteId, ctx.slug), { method: 'PATCH', body });
      ctx.changed = true;
      applyPost(res);
      setSaved('Saved');
    } catch (err) {
      keys.forEach((k) => ctx.dirtyFields.add(k));
      if (sendBody) ctx.bodyDirty = true;
      if (err.status === 409 && err.data && err.data.error === 'changed_on_disk') {
        ctx.conflict = true;
        setSaved('Not saved: the file changed on disk', 'bad');
        await handleConflict();
      } else {
        setSaved(`Not saved: ${err.message}`, 'bad');
      }
    }
  }

  async function handleConflict() {
    const reload = await confirmDialog({
      title: 'This post changed on disk',
      body: 'The file was edited somewhere else after you opened it. Reload to see the latest version. Edits you made here since then will be lost.',
      confirmLabel: 'Reload',
      cancelLabel: 'Keep editing',
    });
    if (reload) {
      ctx.dirtyFields.clear(); ctx.bodyDirty = false; ctx.conflict = false;
      await load();
      toast('Reloaded the latest version from disk.', 'warn');
      return;
    }
    const overwrite = await confirmDialog({
      title: 'Overwrite the file with your version?',
      body: 'Your edited fields and body replace what is on disk. Other fields changed on disk are kept.',
      confirmLabel: 'Overwrite',
      cancelLabel: 'Keep editing',
      tone: 'destructive',
    });
    if (!overwrite) return;
    try {
      const fresh = await api(blogPostPath(siteId, ctx.slug));
      ctx.mtime = fresh.mtime;
      ctx.conflict = false;
      await doSave();
    } catch (err) {
      toast(`Could not overwrite: ${err.message}`, 'error');
    }
  }

  async function flushSave() {
    clearTimeout(ctx.saveTimer);
    if (ctx.isNew) return;
    if (ctx.conflict && (ctx.dirtyFields.size || ctx.bodyDirty)) throw new Error('The file changed on disk. Reload or overwrite it first.');
    ctx.saving = ctx.saving.then(doSave);
    await ctx.saving;
    if (ctx.dirtyFields.size || ctx.bodyDirty) throw new Error('Your edits could not be saved. Try again.');
  }

  // Merge a server Post into the editor without touching what the user is typing.
  function applyPost(res) {
    if (!res) return;
    ctx.post = { ...(ctx.post || {}), ...res, body_md: ctx.body };
    if (res.mtime != null) ctx.mtime = res.mtime;
    if (res.slug) ctx.slug = res.slug;
    if (res.fields) for (const k of BLOG_MANAGED) if (k in res.fields) ctx.fields[k] = res.fields[k];
    renderHead();
    renderSchedule();
    renderFooter();
  }

  function collectNewFields() {
    const out = {};
    for (const f of ctx.schema) {
      if (BLOG_MANAGED.includes(f.key)) continue;
      const v = ctx.fields[f.key];
      if (typeof v === 'boolean') out[f.key] = v;
      else if (!blogIsEmpty(v)) out[f.key] = v;
    }
    const slugVal = ctx.slugInput ? ctx.slugInput.value.trim() : '';
    if (slugVal) out.slug = slugVal;
    return out;
  }

  async function createPost() {
    const title = String(ctx.fields.title || '').trim();
    if (!title) { toast('Add a title first.', 'error'); if (ctx.inputs.title) ctx.inputs.title.focus(); return false; }
    for (const f of ctx.schema) {
      if (!f.required || BLOG_MANAGED.includes(f.key) || f.kind === 'bool') continue;
      if (blogIsEmpty(ctx.fields[f.key])) {
        toast(`${blogLabel(f.key)} is required.`, 'error');
        if (ctx.inputs[f.key]) ctx.inputs[f.key].focus();
        return false;
      }
    }
    setSaved('Saving...');
    try {
      const res = await api(blogPath(siteId, '/posts'), { method: 'POST', body: { fields: collectNewFields(), body_md: ctx.body } });
      ctx.changed = true;
      ctx.isNew = false;
      ctx.slug = res.slug;
      ctx.edited = false;
      ctx.dirtyFields.clear();
      ctx.bodyDirty = false;
      toast('Saved as a draft. Approve it and pick a date when it is ready.');
      await load();
      return true;
    } catch (err) {
      setSaved(`Not saved: ${err.message}`, 'bad');
      toast(`Could not save: ${err.message}`, 'error');
      return false;
    }
  }

  // ---- load ----
  async function load() {
    try {
      const [sites, schema, post, ws, list] = await Promise.all([
        api('/api/blog/sites'),
        api(blogPath(siteId, '/schema')),
        ctx.slug ? api(blogPostPath(siteId, ctx.slug)) : Promise.resolve(null),
        api('/api/worker/status').catch(() => null),
        api(blogPath(siteId, '/posts')).catch(() => []),
      ]);
      ctx.site = (Array.isArray(sites) ? sites : []).find((s) => s.id === siteId) || { id: siteId, name: siteId, default_time: '09:00' };
      ctx.schema = (schema && schema.fields) || [];
      ctx.sitePosts = Array.isArray(list) ? list : [];
      ctx.dry = ws ? !!ws.dryRun : true;
      if (post) {
        ctx.post = post;
        ctx.fields = { ...(post.fields || {}) };
        ctx.body = post.body_md || '';
        ctx.mtime = post.mtime;
        ctx.isNew = false;
        if (ctx.reading === undefined) ctx.reading = post.status === 'published' && !prefill; // published posts open read-first
      } else if (prefill && typeof prefill === 'object') {
        ctx.fields = { ...prefill, ...ctx.fields }; // WEB HOOK: keyword from Analytics
      }
      ctx.inputs = {};
      ctx.preview = null;
      ctx.previewStale = true;
      ctx.blocked = null;
      initSched();
      render();
    } catch (err) {
      content.innerHTML = '';
      content.appendChild(el('div', { class: 'pd-head-bare' }, el('button', { class: 'button ghost sm pd-close', type: 'button', onclick: () => closeDrawer({ notifyChange: false }) }, 'Close')));
      content.appendChild(el('div', { class: 'bl-load-error' }, inlineBanner(err.status === 404 ? 'This post no longer exists.' : `Could not load the post: ${err.message}`, 'error')));
    }
  }

  function initSched() {
    const p = ctx.post;
    ctx.sched = {
      date: (p && p.publish_date) || '',
      time: (p && p.publish_time) || blogSiteDefaultTime(ctx.site),
      dirty: false,
    };
  }

  // ---- render ----
  let headHost; let tabsHost; let readPane; let editPane; let previewPane; let schedHost; let footHost; let wordCount; let headTitleEl;
  const approved = () => !!ctx.post && ctx.post.needs_review === false;
  const published = () => !!ctx.post && ctx.post.status === 'published';

  function render() {
    content.innerHTML = '';
    panel.setAttribute('aria-label', ctx.isNew ? 'New blog post' : `Blog post: ${ctx.fields.title || ctx.slug}`);
    headHost = el('header', { class: 'pd-head bl-head' });
    tabsHost = el('div', { class: 'bl-tabsbar', role: 'tablist', 'aria-label': 'Editor view' });
    editPane = el('div', { class: 'pd-body bl-pane' });
    previewPane = el('div', { class: 'pd-body bl-pane', hidden: 'hidden' });
    schedHost = el('section', { class: 'pd-section bl-sched' });
    footHost = el('footer', { class: 'bl-foot' });
    readPane = el('div', { class: 'pd-body bl-pane bl-read' });
    content.append(headHost, tabsHost, readPane, editPane, previewPane, footHost);

    buildEditPane();
    renderHead();
    renderTabs();
    renderSchedule();
    renderFooter();
    showTab(ctx.tab);
    if (ctx.reading && published() && !ctx.isNew) buildReadPane();
    applyReading();
    if (!ctx.firstRender) {
      ctx.firstRender = true;
      const titleInput = ctx.inputs.title;
      if (titleInput && ctx.isNew) titleInput.focus({ preventScroll: true }); else panel.focus();
    }
  }

  function renderHead() {
    if (!headHost) return;
    headHost.innerHTML = '';
    const title = String(ctx.fields.title || '').trim() || (ctx.isNew ? 'New blog post' : ctx.slug);
    headTitleEl = el('strong', { class: 'bl-head-title' }, title);
    const kicker = [el('span', { class: 'pd-type-badge' }, [blogDocIcon(14), el('span', {}, 'Blog post')])];
    const meta = [];
    const brandId = ctx.site ? ctx.site.brand_id : null;
    meta.push(el('span', { class: 'pd-brand-line' }, [
      el('span', { class: 'pd-dot', style: `background:${typeof plannerBrandColor === 'function' ? plannerBrandColor(brandId) : brandColor(brandId)}` }),
      ctx.site ? ctx.site.name : '',
    ]));
    if (ctx.post && !ctx.isNew) {
      kicker.push(blogStatusPill(ctx.post));
      const rp = blogReviewPill(ctx.post);
      if (rp) kicker.push(rp);
      meta.push(el('span', { class: 'pd-muted' }, blogPostWhen(ctx.site, ctx.post)));
      if (ctx.post.live_url && published()) meta.push(el('a', { class: 'pd-live-link', href: ctx.post.live_url, target: '_blank', rel: 'noopener noreferrer' }, 'View live'));
    } else {
      kicker.push(el('span', { class: 'status-pill status-pill--neutral' }, 'Not saved yet'));
    }
    headHost.append(
      el('div', { class: 'pd-head-main' }, [
        el('div', { class: 'pd-head-kicker' }, kicker),
        el('div', { class: 'pd-head-title' }, headTitleEl),
        el('div', { class: 'pd-head-meta bl-head-meta' }, meta),
      ]),
      el('button', { class: 'button ghost sm pd-close', type: 'button', 'aria-label': 'Close blog post', onclick: () => requestClose() }, 'Close')
    );
  }

  // Published posts open on a readable summary; Edit reveals the form.
  function applyReading() {
    const reading = !!ctx.reading && published() && !ctx.isNew;
    if (readPane) readPane.hidden = !reading;
    if (tabsHost) tabsHost.hidden = reading;
    if (editPane) editPane.hidden = reading || ctx.tab !== 'edit';
    if (previewPane) previewPane.hidden = reading || ctx.tab !== 'preview';
  }

  function buildReadPane() {
    readPane.innerHTML = '';
    const f = ctx.fields;
    const post = ctx.post;
    const facts = [];
    const add = (label, node) => { if (node != null && node !== '') facts.push(el('div', { class: 'bl-fact' }, [el('dt', {}, label), el('dd', {}, node)])); };
    add('Published', blogWhen(post.publish_date));
    add('Keyword', f.primary_keyword || '');
    add('Cluster', f.cluster ? blogLabel(String(f.cluster).replace(/-/g, ' ')) : '');
    add('Length', blogWordLabel(post.word_count != null ? post.word_count : blogWords(ctx.body)));
    if (post.live_url) add('Live link', el('a', { class: 'bl-link', href: post.live_url, target: '_blank', rel: 'noopener noreferrer' }, post.live_url.replace(/^https?:\/\//, '')));
    const statHost = el('dd', {}, 'Loading...');
    const statRow = el('div', { class: 'bl-fact', hidden: 'hidden' }, [el('dt', {}, 'Last 28 days'), statHost]);
    readPane.append(
      f.description ? el('p', { class: 'bl-read-desc' }, f.description) : el('p', { class: 'bl-read-desc bl-muted' }, 'No description yet.'),
      el('dl', { class: 'bl-facts' }, [...facts, statRow])
    );
    if (ctx.lastRun) readPane.appendChild(blogRunLog(ctx.lastRun));
    if (typeof webApi === 'function') {
      const qs = `?blog_site_id=${blogEnc(siteId)}&range=28`;
      webApi(`/api/web/blog-stats${qs}`).then((res) => {
        const st = res && res.posts && res.posts[ctx.slug];
        if (!st || !statRow.isConnected) return;
        const parts = [`${Number(st.views || 0).toLocaleString()} view${Number(st.views) === 1 ? '' : 's'}`, `${Number(st.search_clicks || 0).toLocaleString()} search click${Number(st.search_clicks) === 1 ? '' : 's'}`];
        if (st.position != null) parts.push(`Google position ${Number(st.position).toFixed(1)}`);
        statHost.textContent = parts.join(', ');
        statRow.hidden = false;
      }).catch(() => {});
    }
  }

  function renderTabs() {
    tabsHost.innerHTML = '';
    for (const [key, label] of [['edit', 'Edit'], ['preview', 'Preview']]) {
      tabsHost.appendChild(el('button', {
        class: `pl-seg-btn bl-tab-btn${ctx.tab === key ? ' is-active' : ''}`, type: 'button', role: 'tab',
        'aria-selected': ctx.tab === key ? 'true' : 'false',
        onclick: () => showTab(key),
      }, label));
    }
  }

  function showTab(key) {
    if (key === 'preview' && ctx.isNew) {
      toast('Save the post first, then preview it.', 'warn');
      return;
    }
    ctx.tab = key;
    editPane.hidden = key !== 'edit' || (!!ctx.reading && published());
    previewPane.hidden = key !== 'preview' || (!!ctx.reading && published());
    renderTabs();
    if (key === 'preview' && (ctx.previewStale || !ctx.preview)) runPreview();
  }

  // ---- fields ----
  function fieldControl(f) {
    const key = f.key;
    const id = `bl-f-${key}`;
    const val = ctx.fields[key];
    let node;
    let setVal;
    if (f.kind === 'long') {
      node = el('textarea', { id, rows: '3' });
      setVal = (v) => { node.value = v == null ? '' : String(v); autosizeTextarea(node); node.style.height = 'auto'; node.style.height = `${node.scrollHeight + 2}px`; };
    } else if (f.kind === 'date') {
      node = el('input', { id, type: 'date' });
      setVal = (v) => { node.value = v == null ? '' : String(v); };
    } else if (f.kind === 'bool') {
      node = el('input', { id, type: 'checkbox' });
      setVal = (v) => { node.checked = v === true || v === 'true'; };
    } else if (f.kind === 'list') {
      node = el('input', { id, type: 'text', placeholder: 'Comma separated' });
      setVal = (v) => { node.value = Array.isArray(v) ? v.join(', ') : (v == null ? '' : String(v)); };
    } else if (f.kind === 'select') {
      const opts = [...(f.options || [])];
      if (typeof val === 'string' && val && !opts.includes(val)) opts.push(val);
      node = el('select', { id }, [
        ...(f.required && val ? [] : [el('option', { value: '' }, 'Not set')]),
        ...opts.map((o) => el('option', { value: o }, o)),
      ]);
      setVal = (v) => { node.value = v == null ? '' : String(v); };
    } else {
      node = el('input', { id, type: 'text' });
      setVal = (v) => { node.value = v == null ? '' : String(v); };
    }
    setVal(val);
    const read = () => {
      if (f.kind === 'bool') return node.checked;
      if (f.kind === 'list') return node.value.split(',').map((s) => s.trim()).filter(Boolean);
      return node.value;
    };
    const onEdit = () => {
      ctx.fields[key] = read();
      markDirty(key);
      if (key === 'title') {
        if (headTitleEl) headTitleEl.textContent = String(node.value).trim() || (ctx.isNew ? 'New blog post' : ctx.slug);
        if (ctx.slugInput && ctx.isNew && !ctx.slugTouched) ctx.slugInput.placeholder = blogSlugify(node.value) || 'Made from the title';
      }
    };
    node.addEventListener('input', onEdit);
    node.addEventListener('change', onEdit);
    node.fillFromAi = (v) => { setVal(v); onEdit(); };
    ctx.inputs[key] = node;
    return node;
  }

  function slugField() {
    const wrap = el('div', { class: 'bl-field' });
    wrap.appendChild(el('label', { class: 'pd-label', for: 'bl-f-slug' }, 'Slug'));
    if (ctx.isNew) {
      ctx.slugInput = el('input', { id: 'bl-f-slug', type: 'text', placeholder: blogSlugify(ctx.fields.title) || 'Made from the title' });
      ctx.slugInput.addEventListener('input', () => { ctx.slugTouched = true; ctx.edited = true; });
      wrap.append(ctx.slugInput, el('div', { class: 'pd-hint' }, 'The web address of the post. Leave it empty to build it from the title.'));
    } else {
      ctx.slugInput = null;
      const ro = el('input', { id: 'bl-f-slug', type: 'text', readonly: 'readonly' });
      ro.value = ctx.slug || '';
      wrap.append(ro, el('div', { class: 'pd-hint' }, published() ? 'Locked once published. Renaming would break the live link.' : 'Fixed after the first save.'));
    }
    return wrap;
  }

  function buildEditPane() {
    editPane.innerHTML = '';
    ctx.slugInput = null;
    ctx.slugTouched = false;
    const fields = ctx.schema.filter((f) => !BLOG_MANAGED.includes(f.key));
    const hasTitle = fields.some((f) => f.key === 'title');

    // Draft with AI
    editPane.appendChild(aiSection());

    // Fields
    const grid = el('div', { class: 'bl-fields' });
    if (!hasTitle) grid.appendChild(slugField());
    let slugDone = !hasTitle;
    for (const f of fields) {
      const wide = f.kind === 'long' || f.kind === 'list' || f.key === 'title';
      const control = fieldControl(f);
      if (f.kind === 'bool') {
        grid.appendChild(el('label', { class: 'bl-field bl-check', for: control.id }, [control, el('span', {}, blogLabel(f.key))]));
      } else {
        grid.appendChild(el('div', { class: `bl-field${wide ? ' bl-field--wide' : ''}` }, [
          el('label', { class: 'pd-label', for: control.id }, `${blogLabel(f.key)}${f.required ? ' (required)' : ''}`),
          control,
        ]));
      }
      if (!slugDone && f.key === 'title') { grid.appendChild(slugField()); slugDone = true; }
    }
    editPane.appendChild(el('section', { class: 'pd-section' }, [el('div', { class: 'pd-label-row' }, [el('h3', { class: 'bl-h3' }, 'Details'), savedNote]), grid]));

    // Body
    const bodyArea = el('textarea', { class: 'bl-body', id: 'bl-body', rows: '20', spellcheck: 'true', 'aria-label': 'Post body in Markdown', placeholder: 'Write or paste the post here. Markdown works.' });
    bodyArea.value = ctx.body;
    wordCount = el('span', { class: 'pd-hint', 'aria-live': 'polite' }, blogWordLabel(blogWords(ctx.body)));
    bodyArea.addEventListener('input', () => {
      ctx.body = bodyArea.value;
      wordCount.textContent = blogWordLabel(blogWords(ctx.body));
      markDirty('__body');
    });
    ctx.bodyArea = bodyArea;
    editPane.appendChild(el('section', { class: 'pd-section' }, [
      el('div', { class: 'pd-label-row' }, [el('label', { class: 'bl-h3', for: 'bl-body' }, 'Body'), wordCount]),
      bodyArea,
    ]));

    editPane.appendChild(schedHost);
  }

  // ---- Draft with AI ----
  function aiSection() {
    const idea = el('textarea', { rows: '3', placeholder: 'What is this post about? Paste rough notes, an outline or a question to answer.', 'aria-label': 'Idea or notes' });
    const kw = el('input', { type: 'text', placeholder: 'Primary keyword', 'aria-label': 'Primary keyword' });
    if (ctx.fields.primary_keyword) kw.value = ctx.fields.primary_keyword;
    const go = el('button', { class: 'button primary md', type: 'button' }, 'Draft with AI');
    go.onclick = () => blogBusy(go, async () => {
      const title = String(ctx.fields.title || '').trim();
      if (!idea.value.trim() && !title) { toast('Add a title or some notes first.', 'error'); return; }
      const body = { site: siteId, title: title || undefined, idea: idea.value.trim() || undefined, primary_keyword: kw.value.trim() || undefined };
      if (typeof sessionDraftProvider !== 'undefined' && sessionDraftProvider) body.provider = sessionDraftProvider;
      let res;
      try {
        res = await api('/api/blog/draft', { method: 'POST', body });
      } catch (err) {
        const msg = err.status === 503 || (err.data && err.data.error === 'ai_unavailable')
          ? ((err.data && err.data.message) || 'AI is unavailable right now. The claude CLI may be missing or signed out.')
          : `Could not draft: ${err.message}`;
        toast(msg, 'error');
        return;
      }
      let filled = 0;
      for (const [k, v] of Object.entries(res.fields || {})) {
        const input = ctx.inputs[k];
        if (!input || BLOG_MANAGED.includes(k) || input.type === 'checkbox') continue;
        if (blogIsEmpty(ctx.fields[k]) && !blogIsEmpty(v)) { input.fillFromAi(v); filled += 1; }
      }
      let bodyFilled = false;
      if (res.body_md) {
        let replace = true;
        if (ctx.body.trim()) {
          replace = await confirmDialog({ title: 'Replace the body?', body: 'The AI draft replaces the text in the body box now.', confirmLabel: 'Replace', cancelLabel: 'Keep mine', tone: 'destructive' });
        }
        if (replace) {
          ctx.body = res.body_md;
          ctx.bodyArea.value = res.body_md;
          wordCount.textContent = blogWordLabel(blogWords(ctx.body));
          markDirty('__body');
          bodyFilled = true;
        }
      }
      toast(bodyFilled || filled ? 'Draft ready. Read it through before you approve.' : 'Nothing new to fill in.', bodyFilled || filled ? 'ok' : 'warn');
    });
    return el('details', { class: 'pd-details bl-ai', open: ctx.isNew ? 'open' : undefined }, [
      el('summary', {}, 'Draft with AI'),
      el('div', { class: 'pd-details-body' }, [
        el('div', { class: 'pd-field' }, [el('label', { class: 'pd-label' }, 'Idea or notes'), idea]),
        el('div', { class: 'pd-field' }, [el('label', { class: 'pd-label' }, 'Primary keyword'), kw]),
        el('p', { class: 'pd-hint' }, 'Fills empty fields and the body in this site\'s voice. Fields you already filled stay as they are.'),
        el('div', { class: 'pd-row' }, [go]),
      ]),
    ]);
  }

  // ---- schedule + approval ----
  function renderSchedule() {
    if (!schedHost) return;
    schedHost.innerHTML = '';
    schedHost.appendChild(el('h3', { class: 'bl-h3' }, 'Approval and release'));
    if (ctx.isNew) {
      schedHost.appendChild(el('p', { class: 'pd-hint' }, 'Save the post first. Then you can approve it and pick a release date and time.'));
      return;
    }
    const post = ctx.post;
    if (published()) {
      schedHost.appendChild(el('p', { class: 'bl-sched-line' }, `Published ${blogWhen(post.publish_date)}.`));
      if (post.live_url) schedHost.appendChild(el('a', { class: 'bl-link', href: post.live_url, target: '_blank', rel: 'noopener noreferrer' }, post.live_url));
      if (ctx.lastRun) schedHost.appendChild(blogRunLog(ctx.lastRun));
      return;
    }

    schedHost.appendChild(el('p', { class: 'bl-sched-line' }, post.status === 'scheduled'
      ? `Scheduled for ${blogPostWhen(ctx.site, post)}.`
      : 'Not scheduled. Pick a date and time below.'));
    if (post.status === 'scheduled' && post.needs_review) {
      schedHost.appendChild(el('p', { class: 'pd-note pd-note--warn' }, 'This post still needs your approval. Until you approve it, it will block releases on this site once it is due.'));
    }

    const dateInput = el('input', { type: 'date', 'aria-label': 'Release date' });
    dateInput.value = ctx.sched.date;
    const timeInput = el('input', { type: 'time', 'aria-label': 'Release time' });
    timeInput.value = ctx.sched.time;
    const note = el('div', { class: 'pd-note pd-note--warn', hidden: 'hidden' });
    function refreshNote() {
      const other = ctx.sched.date ? ctx.sitePosts.find((p) => p.slug !== ctx.slug && p.publish_date === ctx.sched.date) : null;
      note.hidden = !other;
      note.textContent = other ? `"${other.title || other.slug}" is already set for ${blogWhen(ctx.sched.date)}. Posts on the same day release together, at the earlier time.` : '';
    }
    function onSched() {
      ctx.sched.date = dateInput.value;
      ctx.sched.time = timeInput.value;
      ctx.sched.dirty = ctx.sched.date !== (post.publish_date || '') || ctx.sched.time !== (post.publish_time || blogSiteDefaultTime(ctx.site));
      refreshNote();
    }
    dateInput.addEventListener('input', onSched);
    timeInput.addEventListener('input', onSched);
    refreshNote();

    const nextFree = el('button', { class: 'chip-btn', type: 'button' }, 'Next free day, 9 AM');
    nextFree.onclick = () => {
      dateInput.value = blogNextFreeDay(ctx.sitePosts, ctx.slug);
      timeInput.value = '09:00';
      onSched();
    };
    const tomorrow = el('button', { class: 'chip-btn', type: 'button' }, 'Tomorrow');
    tomorrow.onclick = () => {
      const d = new Date(); d.setDate(d.getDate() + 1);
      dateInput.value = dateKeyLocal(d);
      timeInput.value = blogSiteDefaultTime(ctx.site);
      onSched();
    };

    const schedBtn = el('button', { class: 'button primary md', type: 'button' }, post.status === 'scheduled' ? 'Update schedule' : 'Schedule');
    schedBtn.onclick = () => blogBusy(schedBtn, doSchedule);
    const row = [schedBtn];
    if (post.status === 'scheduled') {
      const unBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Unschedule');
      unBtn.onclick = () => blogBusy(unBtn, doUnschedule);
      row.push(unBtn);
    }
    schedHost.append(
      el('div', { class: 'bl-sched-inputs' }, [
        el('label', { class: 'pd-field' }, [el('span', { class: 'pd-label' }, 'Date'), dateInput]),
        el('label', { class: 'pd-field' }, [el('span', { class: 'pd-label' }, 'Time'), timeInput]),
      ]),
      el('div', { class: 'pd-presets' }, [nextFree, tomorrow]),
      note,
      el('div', { class: 'pd-row' }, row)
    );
    if (ctx.blocked && ctx.blocked.length) schedHost.appendChild(blockedPanel());
    if (ctx.lastRun) schedHost.appendChild(blogRunLog(ctx.lastRun));
  }

  function blockedPanel() {
    const panelEl = el('div', { class: 'pd-panel pd-panel--bad', role: 'alert' }, [
      el('h3', {}, 'Release blocked'),
      el('p', {}, 'These posts are due but still need your review. Approve them, then release again.'),
    ]);
    for (const b of ctx.blocked) {
      const btn = el('button', { class: 'button primary sm', type: 'button' }, 'Approve');
      btn.onclick = () => blogBusy(btn, async () => {
        try {
          const res = await blogApprove(siteId, b.slug);
          ctx.blocked = ctx.blocked.filter((x) => x.slug !== b.slug);
          if (b.slug === ctx.slug) applyPost(res); else renderSchedule();
          ctx.changed = true;
          toast(`Approved "${b.title}".`);
        } catch (err) { toast(`Could not approve: ${err.message}`, 'error'); }
      });
      panelEl.appendChild(el('div', { class: 'bl-blocked-row' }, [
        el('div', { class: 'bl-blocked-main' }, [el('strong', {}, b.title), el('span', { class: 'bl-muted' }, ` due ${blogWhen(b.publish_date)}`)]),
        btn,
      ]));
    }
    return panelEl;
  }

  async function doSchedule() {
    if (!ctx.sched.date) { toast('Pick a date first.', 'error'); return; }
    const time = ctx.sched.time || blogSiteDefaultTime(ctx.site);
    if (ctx.sched.date < blogTodayKey() && approved()) {
      const ok = await confirmDialog({ title: 'That date has passed', body: 'This post is approved, so it releases on the next check after you schedule it.', confirmLabel: 'Schedule anyway' });
      if (!ok) return;
    }
    try {
      await flushSave();
      const res = await api(blogPostPath(siteId, ctx.slug, '/schedule'), { method: 'POST', body: { publish_date: ctx.sched.date, publish_time: time } });
      ctx.changed = true;
      applyPost(res);
      initSched();
      renderSchedule();
      toast(res.needs_review ? `Scheduled for ${blogWhen(res.publish_date, res.publish_time || time)}. Approve it so it can release.` : `Scheduled for ${blogWhen(res.publish_date, res.publish_time || time)}.`, res.needs_review ? 'warn' : 'ok');
    } catch (err) { toast(`Could not schedule: ${err.message}`, 'error'); }
  }

  async function doUnschedule() {
    try {
      await flushSave();
      const res = await api(blogPostPath(siteId, ctx.slug, '/unschedule'), { method: 'POST', body: {} });
      ctx.changed = true;
      applyPost(res);
      initSched();
      renderSchedule();
      toast('Unscheduled. It is a draft again.');
    } catch (err) { toast(`Could not unschedule: ${err.message}`, 'error'); }
  }

  async function doApprove() {
    try {
      await flushSave();
      const res = await blogApprove(siteId, ctx.slug);
      ctx.changed = true;
      applyPost(res);
      toast(res.status === 'scheduled' ? `Approved. It releases ${blogPostWhen(ctx.site, res)}.` : 'Approved. Schedule it to set a release time.');
    } catch (err) { toast(`Could not approve: ${err.message}`, 'error'); }
  }

  async function doUnapprove() {
    try {
      await flushSave();
      const res = await api(blogPostPath(siteId, ctx.slug), { method: 'PATCH', body: { fields: { needs_cb_review: true }, mtime: ctx.mtime } });
      ctx.changed = true;
      applyPost(res);
      toast('Back to needs your review. It will not release until you approve it again.');
    } catch (err) {
      if (err.status === 409) { ctx.conflict = true; await handleConflict(); }
      else toast(`Could not change approval: ${err.message}`, 'error');
    }
  }

  async function doRelease() {
    const title = String(ctx.fields.title || ctx.slug);
    const ok = await confirmDialog({
      title: `Release "${title}" on ${ctx.site.name}?`,
      body: ctx.dry
        ? 'DRY RUN is on. PostDeck builds the site and runs the checks, but nothing is uploaded.'
        : `This goes LIVE on ${ctx.site.live_url || ctx.site.name} right away. Anything else approved and due today on this site releases with it.`,
      confirmLabel: ctx.dry ? 'Run dry release' : 'Release now',
      tone: ctx.dry ? 'primary' : 'destructive',
    });
    if (!ok) return;
    try {
      await flushSave();
      const res = await api(blogPostPath(siteId, ctx.slug, '/release-now'), { method: 'POST', body: {} });
      ctx.changed = true;
      ctx.lastRun = res.run || null;
      ctx.blocked = null;
      if (res.post) { applyPost(res.post); initSched(); }
      renderSchedule();
      if (res.run && res.run.ok === false) toast(`Release failed: ${res.run.summary || 'see the log below.'}`, 'error');
      else toast(ctx.dry ? 'Dry run finished. Nothing was uploaded.' : 'Released.', 'ok');
    } catch (err) {
      const code = err.data && err.data.error;
      if (code === 'blocked') {
        ctx.blocked = err.data.blocked || [];
        renderSchedule();
        toast('Release blocked. Other posts due today still need your review.', 'error');
        schedHost.scrollIntoView({ block: 'center' });
      } else if (code === 'in_flight') toast('A release is already running for this site. Try again in a minute.', 'warn');
      else if (code === 'not_approved') toast('Approve this post before releasing it.', 'warn');
      else toast(`Could not release: ${err.message}`, 'error');
    }
  }

  // ---- footer ----
  function renderFooter() {
    if (!footHost) return;
    footHost.innerHTML = '';
    const left = el('div', { class: 'bl-foot-left' });
    const right = el('div', { class: 'bl-foot-right' });
    if (ctx.reading && published() && !ctx.isNew) {
      const edit = el('button', { class: 'button primary md', type: 'button' }, 'Edit');
      edit.onclick = () => { ctx.reading = false; ctx.firstRender = true; render(); const t = ctx.inputs.title; if (t) t.focus({ preventScroll: true }); };
      left.appendChild(edit);
      if (ctx.post.live_url) right.appendChild(el('a', { class: 'button secondary md', href: ctx.post.live_url, target: '_blank', rel: 'noopener noreferrer' }, 'View live'));
      footHost.append(left, right);
      return;
    }
    const save = el('button', { class: `button ${ctx.isNew ? 'primary' : 'secondary'} md`, type: 'button' }, ctx.isNew ? 'Save draft' : 'Save');
    save.onclick = () => blogBusy(save, async () => {
      if (ctx.isNew) { await createPost(); return; }
      try {
        if (ctx.conflict) { await handleConflict(); return; }
        await flushSave();
        ctx.changed = true;
        setSaved('Saved');
        toast('Saved.');
      } catch (err) { toast(`Could not save: ${err.message}`, 'error'); }
    });
    left.appendChild(save);
    if (!ctx.isNew && !published()) {
      const ap = el('button', { class: `button ${approved() ? 'secondary' : 'primary'} md`, type: 'button' }, approved() ? 'Mark as needs review' : 'Approve');
      ap.onclick = () => blogBusy(ap, approved() ? doUnapprove : doApprove);
      left.appendChild(ap);
    }
    if (!ctx.isNew && !published() && approved()) {
      const rel = el('button', { class: 'button secondary md', type: 'button' }, 'Release now');
      rel.onclick = () => blogBusy(rel, doRelease);
      right.appendChild(rel);
    }
    if (published() && ctx.post.live_url) {
      right.appendChild(el('a', { class: 'button secondary md', href: ctx.post.live_url, target: '_blank', rel: 'noopener noreferrer' }, 'View live'));
    }
    footHost.append(left, right);
  }

  // ---- preview ----
  async function runPreview() {
    previewPane.innerHTML = '';
    previewPane.appendChild(el('div', { class: 'pd-loading' }, 'Building the preview with the site\'s own template...'));
    try {
      await flushSave();
      const res = await api(blogPostPath(siteId, ctx.slug, '/preview'), { method: 'POST', body: {} });
      ctx.preview = res;
      ctx.previewStale = false;
      drawPreview();
    } catch (err) {
      previewPane.innerHTML = '';
      const again = el('button', { class: 'button secondary md', type: 'button', onclick: () => runPreview() }, 'Try again');
      previewPane.append(inlineBanner(`Could not build the preview: ${err.message}`, 'error'), el('div', { class: 'pd-row' }, again));
    }
  }

  function drawPreview() {
    const res = ctx.preview;
    previewPane.innerHTML = '';
    if (!res) return;
    const rebuild = el('button', { class: 'button secondary sm', type: 'button' }, 'Rebuild preview');
    rebuild.onclick = () => blogBusy(rebuild, runPreview);
    previewPane.appendChild(el('div', { class: 'pd-label-row' }, [el('h3', { class: 'bl-h3' }, 'Preview'), rebuild]));
    if (res.build_error) {
      previewPane.appendChild(el('div', { class: 'pd-panel pd-panel--bad' }, [el('h3', {}, 'The site build failed'), el('pre', { class: 'bl-log' }, res.build_error)]));
    }
    const qa = Array.isArray(res.qa) ? res.qa : [];
    const qaBox = el('section', { class: 'bl-qa' }, [el('h3', { class: 'bl-h3' }, 'Checks')]);
    if (!qa.length) qaBox.appendChild(el('p', { class: 'pd-ok' }, res.build_error ? 'No checks ran.' : 'No problems found.'));
    else {
      const ul = el('ul', { class: 'bl-qa-list' });
      for (const q of qa) {
        const fail = String(q.level).toUpperCase() === 'FAIL';
        ul.appendChild(el('li', { class: `bl-qa-item ${fail ? 'is-fail' : 'is-warn'}` }, [el('span', { class: 'bl-qa-level' }, fail ? 'FAIL' : 'WARN'), el('span', {}, q.message)]));
      }
      qaBox.appendChild(ul);
    }
    previewPane.appendChild(qaBox);
    if (res.url) {
      previewPane.appendChild(el('iframe', { class: 'bl-frame', src: res.url, title: `Preview of ${ctx.fields.title || ctx.slug}`, sandbox: 'allow-same-origin allow-popups' }));
    }
  }

  await load();
}

// ---------------- Planner hooks ----------------

async function blogPlannerLoad(redraw) {
  BLOG_STATE.planner.redraw = redraw;
  try {
    const sites = await api('/api/blog/sites');
    const lists = await Promise.all((Array.isArray(sites) ? sites : []).map((s) => api(blogPath(s.id, '/posts'))
      .then((l) => (Array.isArray(l) ? l : []).map((post) => ({ site: s, post })))
      .catch(() => [])));
    BLOG_STATE.planner.items = lists.flat();
  } catch {
    BLOG_STATE.planner.items = [];
  }
  if (typeof redraw === 'function') redraw();
}

function blogPlannerEnabled() { return blogSafeGet(BLOG_PLANNER_KEY) !== 'off'; }

function blogPlannerBrandItems(brandId) {
  return BLOG_STATE.planner.items.filter((it) => !brandId || String(it.site.brand_id) === String(brandId));
}

// Filter chip. Returns null when no blog sites exist.
function blogPlannerFilterButton(brandId, redraw) {
  const items = blogPlannerBrandItems(brandId).filter((it) => it.post.publish_date);
  if (!BLOG_STATE.planner.items.length) return null;
  const on = blogPlannerEnabled();
  return el('button', {
    class: `pl-filter${on ? ' is-active' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false',
    title: 'Show or hide blog posts on the Planner',
    onclick: () => { blogSafeSet(BLOG_PLANNER_KEY, on ? 'off' : 'on'); redraw(); },
  }, ['Blog', el('span', { class: 'pl-count' }, String(items.length))]);
}

function blogPlannerStatusMatch(post, status) {
  if (!status || status === 'all') return true;
  if (status === 'drafts') return post.status === 'draft';
  if (status === 'scheduled') return post.status === 'scheduled';
  if (status === 'posted') return post.status === 'published';
  return false;
}

function blogPlannerFiltered(dayKey, { brandId, status } = {}) {
  if (!blogPlannerEnabled()) return [];
  return blogPlannerBrandItems(brandId).filter((it) => it.post.publish_date === dayKey && blogPlannerStatusMatch(it.post, status));
}

// Days (YYYY-MM-DD) that have at least one visible blog item. Used by the List view.
function blogPlannerDays(brandId, status) {
  if (!blogPlannerEnabled()) return [];
  return [...new Set(blogPlannerBrandItems(brandId)
    .filter((it) => it.post.publish_date && blogPlannerStatusMatch(it.post, status))
    .map((it) => it.post.publish_date))];
}

// Entries for the Planner's fold logic (30-planner.js, plannerFold).
function blogPlannerEntries(dayKey, { brandId, status, onChange, redraw } = {}) {
  return blogPlannerFiltered(dayKey, { brandId, status }).map((item) => {
    const { site, post } = item;
    const published = post.status === 'published';
    const hhmm = post.publish_time || blogSiteDefaultTime(site);
    const [h, m] = String(hhmm).split(':').map(Number);
    const open = () => openBlogEditor(site.id, post.slug, { onChange: () => { if (onChange) onChange(); } });
    return {
      kind: 'blog', groupKey: `blog:${site.id}:${published ? 'pub' : 'open'}`, id: 0,
      foldAlways: published,
      brandId: site.brand_id, brandLabel: site.name,
      sort: (h || 0) * 60 + (m || 0),
      timeLabel: published ? 'Published' : blogTimeShort(hhmm),
      title: post.title || post.slug, typeLabel: 'Blog post',
      summaryLabel: (n) => `${n} ${site.name} blog post${n === 1 ? '' : 's'}`,
      icon: (size) => blogDocIcon(size),
      statusNode: () => blogReviewPill(post) || blogStatusPill(post),
      open,
      chip: (compact) => blogPlannerChip(item, { compact, onChange, redraw }),
    };
  });
}

function blogPlannerChip(item, { compact, onChange, redraw }) {
  const { site, post } = item;
  const canDrag = post.status !== 'published';
  const time = post.status === 'published' ? '' : blogTimeShort(post.publish_time || blogSiteDefaultTime(site));
  const key = post.status === 'published' ? 'posted' : post.status;
  const needs = post.status !== 'published' && post.needs_review;
  const node = plannerBuildChip({
    icon: blogDocIcon(14),
    brandId: site.brand_id, brandLabel: site.name,
    time,
    title: post.title || post.slug,
    pill: needs ? blogReviewPill(post) : (post.status === 'draft' ? blogStatusPill(post) : null),
    flag: needs ? { tone: 'info', label: 'Needs your review' } : null,
    compact,
    cls: `bl-chip pl-chip--${key}${canDrag ? ' is-draggable' : ''}`,
    tip: `Blog post, ${site.name}: ${post.title || post.slug}\n${blogPostWhen(site, post)}${needs ? '\nNeeds your review' : ''}`,
    aria: `Blog post for ${site.name}: ${post.title || post.slug}, ${post.status}`,
  });
  if (canDrag) node.setAttribute('draggable', 'true');
  const open = () => openBlogEditor(site.id, post.slug, { onChange: () => { if (onChange) onChange(); } });
  node.addEventListener('click', open);
  node.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  if (canDrag) {
    node.addEventListener('dragstart', (e) => {
      BLOG_STATE.planner.drag = { item };
      e.dataTransfer.setData('text/plain', `blog:${site.id}:${post.slug}`);
      e.dataTransfer.effectAllowed = 'move';
      node.classList.add('is-dragging');
      const layout = document.querySelector('.pl-layout');
      if (layout) layout.classList.add('is-dragging');
    });
    node.addEventListener('dragend', () => {
      BLOG_STATE.planner.drag = null;
      node.classList.remove('is-dragging');
      const layout = document.querySelector('.pl-layout');
      if (layout) layout.classList.remove('is-dragging');
      document.querySelectorAll('.pl-day.is-drop').forEach((n) => n.classList.remove('is-drop'));
    });
  }
  return node;
}

function blogPlannerDragActive() { return !!BLOG_STATE.planner.drag; }

// Called by the Planner drop handler. True when a blog chip was being dragged.
function blogPlannerDrop(date) {
  const drag = BLOG_STATE.planner.drag;
  if (!drag) return false;
  BLOG_STATE.planner.drag = null;
  blogPlannerMove(drag.item, dateKeyLocal(date));
  return true;
}

async function blogPlannerMove(item, dayKey) {
  const { site, post } = item;
  const redraw = BLOG_STATE.planner.redraw || (() => {});
  if (dayKey < blogTodayKey()) { toast('That day has already passed. Drop it on today or later.', 'warn'); return; }
  if (post.publish_date === dayKey) return;
  const prev = { publish_date: post.publish_date, mtime: post.mtime };
  const wasScheduled = post.status === 'scheduled';
  post.publish_date = dayKey;
  redraw();
  try {
    let res;
    if (wasScheduled) {
      res = await api(blogPostPath(site.id, post.slug, '/schedule'), { method: 'POST', body: { publish_date: dayKey, publish_time: post.publish_time || blogSiteDefaultTime(site) } });
    } else {
      res = await api(blogPostPath(site.id, post.slug), { method: 'PATCH', body: { fields: { publish_date: dayKey }, mtime: post.mtime } });
    }
    Object.assign(post, { publish_date: res.publish_date || dayKey, publish_time: res.publish_time !== undefined ? res.publish_time : post.publish_time, mtime: res.mtime != null ? res.mtime : post.mtime, status: res.status || post.status, due_at: res.due_at !== undefined ? res.due_at : post.due_at });
    toast(`Moved "${post.title || post.slug}" to ${blogWhen(dayKey)}.`);
    redraw();
  } catch (err) {
    Object.assign(post, prev);
    redraw();
    if (err.status === 409 && err.data && err.data.error === 'changed_on_disk') toast('That post changed on disk. Reload the Planner and try again.', 'error');
    else toast(`Could not move it: ${err.message}`, 'error');
  }
}

// ---------------- Home hook ----------------

async function blogHomeData() {
  const h = BLOG_STATE.home;
  if (Date.now() - h.at < 15000 && h.sites.length) return h;
  const sites = await api('/api/blog/sites');
  const list = Array.isArray(sites) ? sites : [];
  const posts = {};
  await Promise.all(list.filter((s) => s.counts && s.counts.scheduled).map((s) => api(blogPath(s.id, '/posts')).then((p) => { posts[s.id] = Array.isArray(p) ? p : []; }).catch(() => { posts[s.id] = []; })));
  Object.assign(h, { at: Date.now(), sites: list, posts });
  return h;
}

async function blogHomeRows(needsHost, upHost, brandId) {
  const tok = String(++BLOG_STATE.tok);
  needsHost.dataset.blogTok = tok;
  let data;
  try { data = await blogHomeData(); } catch { return; }
  if (needsHost.dataset.blogTok !== tok || !needsHost.isConnected) return;
  const sites = data.sites.filter((s) => !brandId || String(s.brand_id) === String(brandId));
  needsHost.querySelectorAll('[data-blog-rows]').forEach((n) => n.remove());
  upHost.querySelectorAll('[data-blog-rows]').forEach((n) => n.remove());
  const refresh = () => { BLOG_STATE.home.at = 0; if (typeof refreshView === 'function') refreshView(); };

  // Needs you
  const rows = [];
  const now = Date.now();
  for (const s of sites) {
    const blocked = Array.isArray(s.blocked) ? s.blocked : [];
    if (blocked.length) {
      rows.push(el('div', { class: 'home-row home-row--attention' }, [
        el('div', { class: 'home-row-main' }, [
          el('div', { class: 'home-row-reason' }, [el('span', { class: 'status-pill status-pill--bad' }, 'Release blocked'), el('span', {}, `Release blocked on ${s.name}`)]),
          el('div', { class: 'home-row-copy' }, `${blocked.length === 1 ? '1 post is' : `${blocked.length} posts are`} due but not approved: ${blocked.map((b) => b.title).join(', ')}`),
        ]),
        el('a', { class: 'button primary sm', href: `#/blog/${blogEnc(s.id)}` }, 'Review'),
      ]));
    } else if (s.next_due && new Date(s.next_due.at).getTime() <= now && !s.releasing && !s.paused) {
      const btn = el('button', { class: 'button primary sm', type: 'button' }, 'Release');
      btn.onclick = () => blogBusy(btn, () => blogReleaseSite(s, { onDone: refresh }));
      rows.push(el('div', { class: 'home-row home-row--attention' }, [
        el('div', { class: 'home-row-main' }, [
          el('div', { class: 'home-row-reason' }, [el('span', { class: 'status-pill status-pill--gold' }, 'Due'), el('span', {}, `Blog release due on ${s.name}`)]),
          el('div', { class: 'home-row-copy' }, s.next_due.title),
        ]),
        btn,
      ]));
    }
    const lr = s.last_release;
    if (lr && lr.ok === false) {
      rows.push(el('div', { class: 'home-row home-row--attention' }, [
        el('div', { class: 'home-row-main' }, [
          el('div', { class: 'home-row-reason' }, [el('span', { class: 'status-pill status-pill--bad' }, 'Release failed'), el('span', {}, `The last blog release on ${s.name} failed`)]),
          el('div', { class: 'home-row-copy' }, `${fmtDate(lr.finished_at || lr.started_at)}${lr.summary ? `: ${lr.summary}` : ''}`),
        ]),
        el('a', { class: 'button secondary sm', href: `#/blog/${blogEnc(s.id)}` }, 'See log'),
      ]));
    }
    const n = s.counts ? s.counts.needs_review : 0;
    if (n) {
      rows.push(el('div', { class: 'home-row home-row--quiet' }, [
        el('a', { class: 'home-row-link', href: `#/blog/${blogEnc(s.id)}` }, `${n} blog post${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your review on ${s.name}`),
      ]));
    }
  }
  if (rows.length) {
    let list = needsHost.querySelector('.home-list');
    if (!list) {
      list = el('div', { class: 'home-list' });
      needsHost.appendChild(el('section', { class: 'home-section' }, [el('h2', { class: 'home-h2' }, 'Needs you'), list]));
    }
    rows.forEach((r, i) => { r.setAttribute('data-blog-rows', '1'); list.insertBefore(r, list.children[i] || null); });
  }

  // Coming up: next 7 days
  const end = now + 7 * 24 * 3600 * 1000;
  const upcoming = [];
  for (const s of sites) {
    for (const p of data.posts[s.id] || []) {
      if (p.status !== 'scheduled' || p.released || !p.due_at) continue;
      const t = new Date(p.due_at).getTime();
      if (t >= now && t <= end) upcoming.push({ s, p, t });
    }
  }
  upcoming.sort((a, b) => a.t - b.t);
  if (upcoming.length) {
    let section = upHost.querySelector('.home-section');
    if (!section) { section = el('section', { class: 'home-section' }, [el('h2', { class: 'home-h2' }, 'Coming up')]); upHost.appendChild(section); }
    const empty = section.querySelector('.home-empty');
    if (empty) empty.remove();
    const groups = new Map();
    for (const u of upcoming) {
      const k = dateKeyLocal(new Date(u.t));
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(u);
    }
    for (const [k, items] of groups) {
      const group = el('div', { class: 'home-day', 'data-blog-rows': '1' }, [el('div', { class: 'home-day-label' }, `${homeDayLabel(k)}, blog`)]);
      for (const { s, p, t } of items) {
        group.appendChild(el('button', { class: 'home-post', type: 'button', onclick: () => openBlogEditor(s.id, p.slug, { onChange: refresh }) }, [
          el('span', { class: 'home-post-time' }, new Date(t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })),
          el('span', { class: 'home-post-platform' }, blogDocIcon(14)),
          el('span', { class: 'home-post-brand' }, s.name),
          el('span', { class: 'home-post-copy' }, p.title || p.slug),
          blogReviewPill(p) || blogStatusPill(p),
        ]));
      }
      section.appendChild(group);
    }
  }
}

// ---------------- Settings tab ----------------

async function blogSettingsTab(body) {
  const [sites, settings] = await Promise.all([
    api('/api/blog/sites').catch((err) => { throw err; }),
    api('/api/settings').catch(() => ({})),
  ]);
  const truthy = (v) => v === true || v === 1 || v === 'true' || v === '1';

  // Global
  const timeInput = el('input', { type: 'time' });
  timeInput.value = settings.blog_default_time || '09:00';
  const timeSave = el('button', { class: 'button secondary md', type: 'button' }, 'Save time');
  timeSave.onclick = () => stSave(timeSave, () => api('/api/settings', { method: 'PATCH', body: { blog_default_time: timeInput.value || '09:00' } }), 'Default release time saved.');
  const { row: pauseRow, cb: pauseCb } = settingsToggleRow(truthy(settings.blog_paused), 'Pause blog releases');
  pauseCb.addEventListener('change', async () => {
    try {
      await api('/api/settings', { method: 'PATCH', body: { blog_paused: pauseCb.checked } });
      toast(pauseCb.checked ? 'Blog releases paused. Nothing goes live until you turn this off.' : 'Blog releases are on again.', pauseCb.checked ? 'warn' : 'ok');
    } catch (err) {
      pauseCb.checked = !pauseCb.checked;
      pauseCb.dispatchEvent(new Event('change'));
      toast(`Not saved: ${err.message}`, 'error');
    }
  });
  body.appendChild(stSection('Blog releases', 'Approved posts go live at their scheduled time while PostDeck is open.', [
    stField('Default release time', el('div', { class: 'pd-row' }, [timeInput, timeSave]), 'Used when you schedule a post without picking a time.'),
    pauseRow,
    settingsHint('Pausing stops scheduled releases on every site. Release now on a post still works.'),
  ]));

  if (!sites.length) {
    body.appendChild(stSection('Sites', null, emptyState('No blog sites found yet.')));
    return;
  }

  for (const s of sites) {
    const select = el('select', { 'aria-label': `Brand voice for ${s.name}` }, [
      el('option', { value: '' }, 'None'),
      ...state.brands.map((b) => el('option', { value: String(b.id) }, b.name)),
    ]);
    const current = settings[`blog_site_brand:${s.id}`] != null && settings[`blog_site_brand:${s.id}`] !== '' ? settings[`blog_site_brand:${s.id}`] : s.brand_id;
    select.value = current != null ? String(current) : '';
    select.addEventListener('change', () => stSave(select, () => api('/api/settings', { method: 'PATCH', body: { [`blog_site_brand:${s.id}`]: select.value } }), `${s.name} now drafts in ${select.value ? brandName(select.value) : 'no brand'} voice.`));

    const releasesHost = el('div', { class: 'bl-releases' }, el('p', { class: 'bl-muted' }, 'Loading releases...'));
    api(blogPath(s.id, '/releases')).then((list) => {
      releasesHost.innerHTML = '';
      const five = (Array.isArray(list) ? list : []).slice(0, 5);
      if (!five.length) { releasesHost.appendChild(el('p', { class: 'bl-muted' }, 'No releases yet.')); return; }
      five.forEach((r) => releasesHost.appendChild(blogRunLog(r)));
    }).catch((err) => { releasesHost.innerHTML = ''; releasesHost.appendChild(inlineBanner(`Could not load releases: ${err.message}`, 'error')); });

    body.appendChild(stSection(s.name, s.live_url ? s.live_url.replace(/^https?:\/\//, '') : 'No live URL found.', [
      stField('Brand voice for AI drafts', select),
      el('h3', { class: 'st-h3' }, 'Last 5 releases'),
      releasesHost,
    ]));
  }
}
