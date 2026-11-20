// ---------------- Router ----------------

// The route table lives in 99-main.js: it references view functions from
// later script files, so it can only be built once they have all loaded.

// Query string after the route, e.g. #/planner?status=drafts -> { status: 'drafts' }.
function routeQuery() {
  const q = location.hash.split('?')[1] || '';
  return Object.fromEntries(new URLSearchParams(q));
}

function currentRoute() {
  const hash = location.hash.replace(/^#\//, '').split('?')[0];
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
let lastRenderedHash = null;
let liveViewActive = false;

// D3: old routes forward to their replacements once the replacement view
// ships. A replacement opts in by setting `replacesLegacy = true` on its
// render function (e.g. renderPlanner.replacesLegacy = true), so each build
// can land independently and nothing redirects to a view that can't serve it.
const ROUTE_REDIRECTS = {
  calendar: 'planner',
  review: 'planner',
  composer: 'create',
  ops: 'settings/system',
  profiles: 'settings/brands',
};

// A view that shows server state that changes on its own (Planner, Home)
// calls this during render; it then refreshes on window focus and every
// 60s while visible, unless the operator is typing.
function markViewLive() {
  liveViewActive = true;
}

function skeletonView() {
  return el('div', { class: 'skeleton-view', 'aria-busy': 'true', 'aria-label': 'Loading' }, [
    el('div', { class: 'skeleton-bar lg' }),
    el('div', { class: 'skeleton-bar block' }),
    el('div', { class: 'skeleton-bar' }),
    el('div', { class: 'skeleton-bar' }),
    el('div', { class: 'skeleton-bar block' }),
  ]);
}

// router({ refresh }) - a call for the hash that is already on screen is a
// refresh: it re-renders in place (no skeleton, no entrance animation, scroll
// kept). That covers every legacy `router()` call made after a save. A new
// hash is a navigation: overlays close, view cleanups run, scroll resets, and
// a skeleton appears only if the view takes longer than 150ms.
async function router({ refresh = false } = {}) {
  const myToken = ++routerToken;
  const { name, params } = currentRoute();

  const redirect = ROUTE_REDIRECTS[name];
  const target = redirect && routes[redirect.split('/')[0]];
  if (target && target.replacesLegacy) {
    const rest = params.length ? `/${params.join('/')}` : '';
    location.replace(`#/${redirect}${name === 'review' ? '?status=drafts' : rest}`);
    return;
  }

  const hash = location.hash;
  const isRefresh = refresh || hash === lastRenderedHash;
  document.querySelectorAll('#sidebar a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === name);
  });

  if (!isRefresh) {
    closeAllOverlays();
    runViewCleanups();
    liveViewActive = false;
    currentCalendarReload = null;
  }
  const scrollY = window.scrollY;

  let skeletonTimer = null;
  if (!isRefresh) {
    skeletonTimer = setTimeout(() => {
      if (myToken !== routerToken) return;
      const live = document.getElementById('view');
      if (live) {
        live.innerHTML = '';
        live.appendChild(skeletonView());
      }
    }, 150);
  }

  const scratch = document.createElement('main');
  scratch.id = 'view';
  const handler = routes[name] || renderHome;
  try {
    await handler(scratch, params);
  } catch (err) {
    scratch.innerHTML = '';
    scratch.appendChild(inlineBanner(`This page failed to load: ${err.message}`, 'error'));
  }
  clearTimeout(skeletonTimer);

  if (myToken !== routerToken) return; // a newer navigation superseded this run - discard it
  if (!isRefresh) scratch.classList.add('view-enter');
  const current = document.getElementById('view');
  if (current) current.replaceWith(scratch);
  lastRenderedHash = hash;
  if (isRefresh) window.scrollTo(0, scrollY);
  else window.scrollTo(0, 0);
}

// Re-render the current view in place after a mutation.
function refreshView() {
  return router({ refresh: true });
}

function isOperatorTyping() {
  const a = document.activeElement;
  if (!a) return false;
  return a.tagName === 'TEXTAREA' || a.isContentEditable || (a.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit'].includes(a.type));
}

function refreshLiveView() {
  if (document.visibilityState !== 'visible' || isOperatorTyping()) return;
  if (openOverlays.size || document.querySelector('dialog[open]')) return;
  if (typeof currentCalendarReload === 'function') currentCalendarReload();
  else if (liveViewActive) refreshView();
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', refreshLiveView);
  window.addEventListener('focus', refreshLiveView);
  setInterval(refreshLiveView, 60000);
}

window.addEventListener('hashchange', router);

async function bootstrap() {
  const [brands, accounts, platformSpecs, providers] = await Promise.all([
    api('/api/brands'),
    api('/api/accounts'),
    api('/api/platform-specs').catch(() => ({})),
    api('/api/ai/providers').catch(() => AI_PROVIDERS_FALLBACK),
  ]);
  state.brands = brands;
  state.accounts = accounts;
  state.platformSpecs = platformSpecs;
  state.providers = providers;
  if (!location.hash) location.hash = '#/home';
  router();
}

// bootstrap() runs from 99-main.js once every script has loaded.
