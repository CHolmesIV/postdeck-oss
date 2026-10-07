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
    ['C', 'New post'],
    ['D', 'Drafts waiting'],
    ['1', 'Go to Home'],
    ['2', 'Go to Planner'],
    ['3', 'Go to Analytics'],
    ['4', 'Go to Settings'],
    ['?', 'This cheat sheet'],
    ['⌘K / Ctrl K', 'Command palette - jump, search posts, run actions'],
    ['Esc', 'Close the open drawer, sheet or dialog'],
    ['⌘ Enter', 'In New post: run the primary action'],
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
    { type: 'nav', label: 'Planner', hash: '#/planner' },
    { type: 'nav', label: 'Blog', hash: '#/blog' },
    { type: 'nav', label: 'Analytics', hash: '#/analytics' },
    { type: 'nav', label: 'Settings', hash: '#/settings' },
    { type: 'nav', label: 'Labs', hash: '#/labs' },
    { type: 'nav', label: 'Research (Labs)', hash: '#/research' },
    { type: 'nav', label: 'Inspiration (Labs)', hash: '#/inspiration' },
    { type: 'nav', label: 'Ideas (Labs)', hash: '#/ideas' },
    { type: 'nav', label: 'Library (Labs)', hash: '#/library' },
    { type: 'nav', label: 'Images (Labs)', hash: '#/images' },
  ];
  const actionEntries = [
    { type: 'action', label: 'New post', run: () => openNewPost() },
    { type: 'action', label: 'Drafts waiting', run: () => { location.hash = '#/planner?status=drafts'; } },
    { type: 'action', label: 'Needs attention', run: () => { location.hash = '#/planner?status=attention'; } },
    { type: 'action', label: 'Ask PostDeck (Labs)', run: () => openChatDrawer() },
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
    else if (m.type === 'post') openPostById(m.post.id);
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
          statusPill(m.post)
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
        if (document.querySelector('dialog[open], .modal-overlay')) return;
        e.preventDefault();
        openNewPost();
        break;
      case 'd':
      case 'D':
        e.preventDefault();
        location.hash = '#/planner?status=drafts';
        break;
      case '1':
        e.preventDefault();
        location.hash = '#/home';
        break;
      case '2':
        e.preventDefault();
        location.hash = '#/planner';
        break;
      case '3':
        e.preventDefault();
        location.hash = '#/analytics';
        break;
      case '4':
        e.preventDefault();
        location.hash = '#/settings';
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
