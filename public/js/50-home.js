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

function homeNeedsRow(post) {
  const h = humanStatus(post);
  return el('div', { class: 'home-row home-row--attention' }, [
    el('div', { class: 'home-row-main' }, [
      el('div', { class: 'home-row-reason' }, [
        el('span', { class: `status-pill status-pill--${h.tone}` }, h.label),
        el('span', {}, homeAttentionReason(post)),
      ]),
      el('div', { class: 'home-row-meta' }, [
        platformIcon(post.platform, { size: 13 }),
        el('span', {}, `${brandName(post.brand_id)} on ${humanizePlatformName(post.platform)}`),
        post.publish_at ? el('span', {}, `Planned ${fmtDate(post.publish_at)}`) : null,
      ]),
      el('div', { class: 'home-row-copy' }, homeFirstLine(post)),
    ]),
    el('button', { class: 'button primary sm', type: 'button', onclick: () => openPostById(post.id) }, 'Review'),
  ]);
}

function homeLinkRow(text, href, { dismissKey, onDismiss } = {}) {
  const row = el('div', { class: 'home-row home-row--quiet' }, [
    el('a', { class: 'home-row-link', href }, text),
  ]);
  if (dismissKey) {
    row.appendChild(el('button', {
      class: 'button ghost sm', type: 'button', 'aria-label': `Dismiss: ${text}`,
      onclick: () => { homeDismiss(dismissKey); row.remove(); if (onDismiss) onDismiss(); },
    }, 'Dismiss'));
  }
  return row;
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
    list.appendChild(homeLinkRow(`${drafts.length} draft${drafts.length === 1 ? '' : 's'} waiting`, '#/planner?status=drafts'));
  }

  const metricsDue = (analytics?.metrics_due || []).filter((p) => !brandId || String(p.brand_id) === String(brandId));
  const dismissed = homeDismissedSet();
  const metricsKey = `metrics-due:${metricsDue.map((p) => p.id).sort().join('|')}`;
  if (metricsDue.length && !dismissed.has(metricsKey)) {
    list.appendChild(homeLinkRow(
      `${metricsDue.length} post${metricsDue.length === 1 ? ' is' : 's are'} ready for metrics`,
      '#/analytics',
      { dismissKey: metricsKey, onDismiss: () => { if (!list.children.length) host.innerHTML = ''; } }
    ));
  }

  const hasScheduled = posts.some((p) => HOME_GOING_OUT.includes(p.status));
  if (workerStatus && workerStatus.enabled === false && hasScheduled) {
    list.insertBefore(el('div', { class: 'home-row home-row--quiet' }, [
      el('a', { class: 'home-row-link', href: '#/settings/system' }, 'The posting worker is off, so scheduled posts will not send. See System settings.'),
    ]), list.firstChild);
  }

  if (!list.children.length) return;
  section.appendChild(el('h2', { class: 'home-h2' }, 'Needs you'));
  section.appendChild(list);
  host.appendChild(section);
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
