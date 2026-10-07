// ---------------- D3: entry points shared by every view ----------------
// One way in for "new post" and "open this post", so the FAB, shortcuts,
// palette, Home and Planner all land in the same editor. The Create sheet
// (40-create.js) and post drawer (31-post-drawer.js) define the real
// implementations; until they exist these fall back to the legacy editors.
function openNewPost(prefill = {}) {
  if (typeof openCreateSheet === 'function') return openCreateSheet(prefill);
  return openQuickCompose(prefill);
}

function openPostById(postId) {
  if (typeof openPostDrawer === 'function') return openPostDrawer(postId);
  location.hash = `#/post/${postId}`;
}

// ---------------- D3: Labs ----------------
// Tools CB hasn't used yet live here, out of the main nav. Policy
// (2026-10-07): anything still unused on 2026-11-07 gets deleted.
const LABS_ITEMS = [
  { title: 'Research', desc: 'Notes and sources for post ideas.', hash: '#/research' },
  { title: 'Inspiration', desc: 'Creators and accounts worth studying.', hash: '#/inspiration' },
  { title: 'Ideas', desc: 'A backlog of post ideas.', hash: '#/ideas' },
  { title: 'Library', desc: 'Every uploaded image and file.', hash: '#/library' },
  { title: 'Images', desc: 'Image requests handed to Codex.', hash: '#/images' },
  { title: 'Redistribute a blog post', desc: 'Turn one article into social posts for each network.', run: () => openRedistributeModal() },
  { title: 'Ask PostDeck', desc: 'Chat with the assistant. It drafts; it never publishes unless you allow it in Settings.', run: () => openChatDrawer() },
];
const LABS_REVIEW_DATE = '2026-11-07';

// Blog -> social drafts (redistributeForm lives with the Home view).
function openRedistributeModal() {
  const overlay = el('div', { class: 'modal-overlay' });
  const card = el('div', { class: 'modal-card' });
  let unregister = () => {};
  function close() {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    unregister();
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  unregister = registerOverlay(close);
  card.append(
    el('div', { class: 'modal-header' }, [
      el('strong', {}, 'Redistribute a blog post'),
      el('button', { class: 'modal-close', type: 'button', title: 'Close', onclick: close }, '✕'),
    ]),
    redistributeForm(() => getStickyBrand() || (state.brands[0] && state.brands[0].id))
  );
  overlay.appendChild(card);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
}

async function renderLabs(view) {
  view.appendChild(pageHeader('Labs'));
  view.appendChild(el('p', { class: 'labs-note' }, `Extra tools kept out of the main navigation. Anything here that's still unused on ${new Date(`${LABS_REVIEW_DATE}T12:00:00`).toLocaleDateString(undefined, { month: 'long', day: 'numeric' })} gets removed.`));
  view.appendChild(el('div', { class: 'labs-list' }, LABS_ITEMS.map((item) => {
    const body = el('div', {}, [
      el('div', { class: 'labs-item-title' }, item.title),
      el('div', { class: 'labs-item-desc' }, item.desc),
    ]);
    const arrow = el('span', { 'aria-hidden': 'true' }, '→');
    if (item.hash) return el('a', { class: 'labs-item', href: item.hash }, [body, arrow]);
    return el('button', { class: 'labs-item', type: 'button', onclick: item.run }, [body, arrow]);
  })));
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

  fab.addEventListener('click', () => { openNewPost(); });
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
    // Default comes from data-default-collapsed (Labs starts closed); after
    // that the operator's last choice sticks.
    const expanded = stored ? stored !== 'collapsed' : groupEl.dataset.defaultCollapsed !== '1';
    setNavGroupExpanded(groupEl, expanded);

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
