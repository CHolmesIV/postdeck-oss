// ---------------- D3: the single post drawer ----------------
// One editor for every existing post. Opened from the Planner, Home, search and
// #/post/:id through openPostDrawer(id). Also holds the shared post helpers the
// retired popover/modal/detail code used to own (quick schedule, quiet hours,
// needs-check panel, duplicate flow).

// ---- shared helpers ----

function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function firstUrlInfo(copy) {
  const match = String(copy || '').match(/https?:\/\/[^\s)\]}>,]+/i);
  if (!match) return null;
  const before = String(copy || '').slice(0, match.index);
  const paragraph = before.split(/\n\s*\n|\n/).filter((line) => line.trim()).length + 1;
  return { url: match[0], index: match.index, paragraph };
}

// PrimeWright and conversion-led posts use hook -> link -> explanation. Moves
// the first URL-bearing line directly below the opening line without
// rewriting any copy around it.
function moveFirstLinkHigher(copy) {
  const lines = String(copy || '').split('\n');
  const linkIndex = lines.findIndex((line) => /https?:\/\//i.test(line));
  const hookIndex = lines.findIndex((line) => line.trim());
  if (linkIndex < 0 || hookIndex < 0 || linkIndex <= hookIndex + 1) return String(copy || '');
  const [linkLine] = lines.splice(linkIndex, 1);
  lines.splice(hookIndex + 1, 0, linkLine);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}

// Returns a datetime-local value. 'friday' stays for older callers.
function quickScheduleValue(kind) {
  const d = new Date();
  d.setSeconds(0, 0);
  if (kind === 'later') d.setHours(Math.max(d.getHours() + 2, 15), 0, 0, 0);
  if (kind === 'tomorrow') { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
  if (kind === 'weekday') {
    const day = postDrawerNextWeekday();
    d.setTime(day.getTime());
  }
  if (kind === 'friday') {
    let delta = (5 - d.getDay() + 7) % 7;
    if (delta === 0 && d.getHours() >= 12) delta = 7;
    d.setDate(d.getDate() + delta);
    d.setHours(12, 0, 0, 0);
  }
  return dateToLocalInputValue(d);
}

// First weekday after tomorrow, 9 AM. Distinct from the "Tomorrow" preset.
function postDrawerNextWeekday() {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setDate(d.getDate() + 2);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return d;
}

// Soft quiet-hours check. Returns { quiet_start, quiet_end } when the time is
// inside quiet hours, otherwise null. Best effort: a failure is "not quiet".
async function quietHoursInfo(publishAt) {
  if (!publishAt) return null;
  try {
    const check = await api(`/api/settings/quiet-hours-check?publish_at=${encodeURIComponent(publishAt)}`);
    return check.within_quiet_hours ? check : null;
  } catch {
    return null;
  }
}

// Dialog version for callers without inline UI (bulk actions). Returns false
// only when the operator backs out.
async function confirmQuietHours(publishAt, { count = 1 } = {}) {
  const info = await quietHoursInfo(publishAt);
  if (!info) return true;
  const subject = count > 1 ? `The earliest of these ${count} posts is` : 'This post is';
  return confirmDialog({
    title: 'Inside quiet hours',
    body: `${subject} set for ${fmtDate(publishAt)}, inside quiet hours (${info.quiet_start} to ${info.quiet_end}). Schedule it anyway?`,
    confirmLabel: 'Schedule anyway',
  });
}

// Approves one post. True when it went through, false when the operator
// declined the quiet-hours confirm. Throws on a real API failure.
async function approvePost(post) {
  if (!(await confirmQuietHours(post.publish_at))) return false;
  await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'approved' } });
  return true;
}

// A post that has been handed off has real metrics to enter.
function hasEverPublished(post) {
  return ['submitted', 'published', 'failed_verify'].includes(post.status);
}

// needs_check: the send to Blotato did not finish cleanly, so the post may
// already be live. PostDeck never resends these on its own.
function needsCheckPanel(post, onDone) {
  const urlInput = el('input', { type: 'url', placeholder: 'Paste the live post URL' });
  const markBtn = el('button', { class: 'button primary md', type: 'button' }, 'Mark as posted');
  const draftBtn = el('button', { class: 'button secondary md', type: 'button' }, "It didn't post - move to draft");
  markBtn.onclick = async () => {
    const url = urlInput.value.trim();
    if (!url) {
      toast('Paste the live post URL first.', 'error');
      urlInput.focus();
      return;
    }
    markBtn.disabled = true;
    try {
      await api(`/api/posts/${post.id}/mark-posted`, { method: 'POST', body: { public_url: url } });
      toast('Marked as posted.');
      onDone();
    } catch (err) {
      markBtn.disabled = false;
      toast(`Could not mark posted: ${err.message}`, 'error');
    }
  };
  draftBtn.onclick = async () => {
    draftBtn.disabled = true;
    try {
      await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'draft', publish_at: null } });
      toast('Moved to drafts. Reschedule it when ready.');
      onDone();
    } catch (err) {
      draftBtn.disabled = false;
      toast(`Could not move to draft: ${err.message}`, 'error');
    }
  };
  return el('div', { class: 'pd-panel pd-panel--bad needs-check-panel' }, [
    el('h3', {}, 'Check before resending'),
    el('p', {}, `Sending to Blotato did not finish cleanly, so this post may already be live on ${humanizePlatformName(post.platform)}. PostDeck will not resend it on its own.`),
    el('p', { class: 'pd-hint' }, 'Open the account and look for it. If it is there, paste its URL. If it is not, move it back to draft.'),
    el('div', { class: 'pd-field' }, [urlInput]),
    el('div', { class: 'pd-row' }, [markBtn, draftBtn]),
  ]);
}

function renderBrandPickerRow(hostEl, currentBrandId, onPick) {
  hostEl.innerHTML = '';
  const targets = state.brands.filter((b) => String(b.id) !== String(currentBrandId));
  if (!targets.length) {
    hostEl.appendChild(el('span', { class: 'pd-hint' }, 'No other brands set up.'));
    return;
  }
  for (const b of targets) {
    hostEl.appendChild(el('button', { type: 'button', class: 'chip-btn', onclick: () => onPick(b.id) }, b.name));
  }
}

// Duplicates `post` (same brand, or copy-to-brand). The server strips the time
// and status. For a cross-brand copy the copy is best-effort re-voiced through
// the target brand's tone; any failure there silently keeps the verbatim copy.
async function duplicatePostFlow(post, { brandId, onChange } = {}) {
  const crossBrand = brandId != null && String(brandId) !== String(post.brand_id);
  let created;
  try {
    created = await api(`/api/posts/${post.id}/duplicate`, {
      method: 'POST',
      body: crossBrand ? { brand_id: brandId } : {},
    });
  } catch (err) {
    toast(`Could not duplicate: ${err.message}`, 'error');
    return;
  }

  let revoiced = false;
  if (crossBrand) {
    try {
      const tp = await findToneProfileId(brandId, 'business');
      if (tp) {
        const draftRes = await api('/api/draft', {
          method: 'POST',
          body: {
            idea_text: post.copy || '',
            brand_id: Number(brandId),
            tone_profile_id: tp,
            platforms: [post.platform],
            provider: sessionDraftProvider || 'claude',
          },
        });
        const redraft = draftRes.drafts && draftRes.drafts[post.platform];
        if (redraft) {
          await api(`/api/posts/${created.id}`, { method: 'PATCH', body: { copy: redraft } });
          created.copy = redraft;
          revoiced = true;
        }
      }
    } catch {
      // AI unavailable or no tone profile: the duplicate keeps the original copy.
    }
  }

  let msg = crossBrand ? `Copied to ${brandName(brandId)}.` : 'Post duplicated.';
  if (revoiced) msg = `Copied to ${brandName(brandId)} and re-voiced with AI.`;
  if (created.account_unresolved) msg += ' No matching account for that brand yet. Pick one before scheduling.';
  toast(msg, created.account_unresolved ? 'warn' : 'ok');
  if (typeof onChange === 'function') onChange();
  else if (typeof currentCalendarReload === 'function') currentCalendarReload();
  openPostDrawer(created.id, { onChange });
}

// ---- legacy entry points, kept as thin wrappers ----
function openPostPopover(postId, anchorEl, opts = {}) { return openPostDrawer(postId, opts); }
function openPostModal(postId, opts = {}) { return openPostDrawer(postId, opts); }
function closePostPopover() { /* the drawer registers itself with registerOverlay */ }

// ---- the drawer ----

let postDrawerCurrent = null; // { id, closeSilently }

function postDrawerAccountLabel(post) {
  return `${brandName(post.brand_id)} on ${humanizePlatformName(post.platform)}`;
}

function postDrawerIsMissed(post) {
  if (post.status !== 'scheduled_local') return false;
  if (post.missed_window || isMissedWindowPost(post)) return true;
  return !!post.publish_at && Date.now() - new Date(post.publish_at).getTime() > 15 * 60000;
}

async function postDrawerWorkerDryRun() {
  try { return !!(await api('/api/worker/status')).dryRun; } catch { return false; }
}

function openPostDrawer(postId, { onChange, onClose } = {}) {
  if (postDrawerCurrent) postDrawerCurrent.closeSilently();
  const opener = document.activeElement;
  const ctx = {
    id: postId,
    post: null,
    slots: null,
    dirty: {},
    saveTimer: null,
    saving: Promise.resolve(),
    changed: false,
    closed: false,
    timeDirty: () => false,
  };

  const scrim = el('div', { class: 'pd-scrim' });
  const panel = el('aside', { class: 'pd-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Post', tabindex: '-1' });
  const content = el('div', { class: 'pd-drawer-inner' }, el('div', { class: 'pd-loading' }, 'Loading post...'));
  panel.appendChild(content);
  document.body.append(scrim, panel);
  requestAnimationFrame(() => { scrim.classList.add('is-open'); panel.classList.add('is-open'); });
  panel.focus();

  const unregister = registerOverlay(() => closeDrawer({ notifyChange: false, immediate: true }));

  function notify() {
    if (typeof onChange === 'function') onChange();
    else refreshView();
  }

  function focusables() {
    return [...panel.querySelectorAll('a[href], button:not([disabled]), textarea:not([readonly]), input:not([disabled]), select:not([disabled]), summary')]
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

  async function requestClose() {
    if (ctx.closed) return;
    if (ctx.timeDirty()) {
      const ok = await confirmDialog({
        title: 'Discard the new time?',
        body: 'You picked a new time but did not schedule it. Your text edits are already saved.',
        confirmLabel: 'Discard time',
        cancelLabel: 'Keep editing',
        tone: 'destructive',
      });
      if (!ok) return;
    }
    closeDrawer({});
  }

  function closeDrawer({ notifyChange = true, immediate = false } = {}) {
    if (ctx.closed) return;
    ctx.closed = true;
    clearTimeout(ctx.saveTimer);
    const hadDirty = Object.keys(ctx.dirty).length > 0;
    if (hadDirty) ctx.saving = ctx.saving.then(doSave);
    document.removeEventListener('keydown', onKey);
    unregister();
    if (postDrawerCurrent && postDrawerCurrent.id === postId && postDrawerCurrent.token === ctx) postDrawerCurrent = null;
    const remove = () => { scrim.remove(); panel.remove(); };
    if (immediate) remove();
    else {
      scrim.classList.remove('is-open');
      panel.classList.remove('is-open');
      setTimeout(remove, 200);
    }
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    if (typeof onClose === 'function') onClose();
    if (notifyChange && (ctx.changed || hadDirty)) ctx.saving.then(() => notify());
  }
  postDrawerCurrent = { id: postId, token: ctx, closeSilently: () => closeDrawer({ notifyChange: false, immediate: true }) };

  // ---- autosave (copy, first comment) ----
  const savedNote = el('span', { class: 'pd-saved', 'aria-live': 'polite' });
  function setSaved(text, tone) {
    savedNote.textContent = text;
    savedNote.className = `pd-saved${tone ? ` pd-saved--${tone}` : ''}`;
  }
  async function doSave() {
    const body = ctx.dirty;
    if (!Object.keys(body).length) return;
    ctx.dirty = {};
    setSaved('Saving...');
    try {
      const res = await api(`/api/posts/${postId}`, { method: 'PATCH', body });
      if (ctx.post) Object.assign(ctx.post, { copy: res.copy, first_comment: res.first_comment });
      ctx.changed = true;
      setSaved('Saved');
    } catch (err) {
      ctx.dirty = { ...body, ...ctx.dirty };
      setSaved(`Not saved: ${err.message}`, 'bad');
    }
  }
  function queueSave(field, value) {
    ctx.dirty[field] = value;
    clearTimeout(ctx.saveTimer);
    setSaved('');
    ctx.saveTimer = setTimeout(() => { ctx.saving = ctx.saving.then(doSave); }, 800);
  }
  async function flushSave() {
    clearTimeout(ctx.saveTimer);
    ctx.saving = ctx.saving.then(doSave);
    await ctx.saving;
    if (Object.keys(ctx.dirty).length) throw new Error('Your text edits could not be saved. Try again.');
  }

  async function mutate(label, fn, { close = true } = {}) {
    try {
      await fn();
      ctx.changed = true;
      notify();
      if (close) closeDrawer({ notifyChange: false });
      else await load();
    } catch (err) {
      toast(`${label}: ${err.message}`, 'error');
    }
  }

  // ---- load + render ----
  async function load() {
    try {
      const post = await api(`/api/posts/${postId}`);
      ctx.post = post;
      if (ctx.slots === null && post.brand_id != null) {
        api(`/api/queue-slots?brand_id=${post.brand_id}`).then((s) => {
          ctx.slots = Array.isArray(s) ? s : [];
          if (!ctx.closed && ctx.onSlots) ctx.onSlots();
        }).catch(() => { ctx.slots = []; });
      }
      render();
    } catch (err) {
      content.innerHTML = '';
      content.appendChild(postDrawerHeaderClose(() => requestClose()));
      content.appendChild(inlineBanner(err.status === 404 ? 'This post no longer exists.' : `Could not load post: ${err.message}`, 'error'));
    }
  }

  function postDrawerHeaderClose(onClick) {
    return el('div', { class: 'pd-head-bare' }, el('button', { class: 'button ghost sm pd-close', type: 'button', 'aria-label': 'Close', onclick: onClick }, 'Close'));
  }

  function render() {
    const post = ctx.post;
    const brand = state.brands.find((b) => b.id === post.brand_id);
    const editable = RESCHEDULABLE_STATUSES.includes(post.status);
    const missed = postDrawerIsMissed(post);
    const mediaUrl = post.media && post.media.length ? (post.media[0].url || null) : null;
    ctx.timeDirty = () => false;
    content.innerHTML = '';
    panel.setAttribute('aria-label', `${brandName(post.brand_id)} ${humanizePlatformName(post.platform)} post`);

    // header
    content.appendChild(el('header', { class: 'pd-head' }, [
      el('div', { class: 'pd-head-main' }, [
        el('div', { class: 'pd-head-title' }, [
          el('span', { class: 'pd-dot', style: `background:${brandColor(post.brand_id)}` }),
          el('strong', {}, brandName(post.brand_id)),
          el('span', { class: 'pd-muted' }, [platformIcon(post.platform, { size: 14 }), ` ${humanizePlatformName(post.platform)}`]),
        ]),
        el('div', { class: 'pd-head-meta' }, [
          statusPill(post),
          el('span', { class: 'pd-muted' }, post.publish_at ? fmtDate(post.publish_at) : 'No time set'),
        ]),
      ]),
      el('button', { class: 'button ghost sm pd-close', type: 'button', 'aria-label': 'Close post', onclick: () => requestClose() }, 'Close'),
    ]));

    const body = el('div', { class: 'pd-body' });
    content.appendChild(body);

    if (post.tags && post.tags.length) {
      body.appendChild(el('div', { class: 'pd-tags' }, post.tags.map((t) => tagDisplayChip(t))));
    }

    // banners and recovery panels that sit above the copy
    if (missed) body.appendChild(missedPanel(post));
    else if (['scheduled_local', 'approved'].includes(post.status) && isManualPost(post)) body.appendChild(manualAccountBanner());
    if (post.status === 'failed') body.appendChild(failedPanel(post));
    if (post.status === 'failed_verify') body.appendChild(failedVerifyPanel(post));
    if (post.status === 'needs_check') {
      body.appendChild(needsCheckPanel(post, () => { ctx.changed = true; notify(); closeDrawer({ notifyChange: false }); }));
    }
    if (post.status === 'submitted' || post.status === 'submitted_dry') {
      body.appendChild(sendingPanel(post));
    }
    const fcReminder = firstCommentReminder(post);
    if (fcReminder) body.appendChild(fcReminder);

    // preview + copy
    const previewHost = el('div', { class: 'pd-preview' });
    const copyArea = el('textarea', { class: 'pd-copy', rows: '8', 'aria-label': 'Post text' });
    copyArea.value = post.copy || '';
    if (!editable) copyArea.setAttribute('readonly', 'readonly');
    const linkInsight = el('div', { class: 'pd-link-insight' });
    const linkMoveBtn = el('button', { class: 'button ghost sm', type: 'button' }, 'Move link higher');
    function refreshPreview() {
      previewHost.innerHTML = '';
      previewHost.appendChild(renderPostPreview(post.platform, { copy: copyArea.value, mediaUrl, brand }));
      linkInsight.innerHTML = '';
      const info = firstUrlInfo(copyArea.value);
      if (!info) {
        linkInsight.textContent = '';
        linkMoveBtn.hidden = true;
      } else {
        const high = info.paragraph <= 2;
        linkInsight.appendChild(el('span', { class: high ? 'pd-ok' : 'pd-warn' }, high ? 'Link is high in the post.' : `Link is in paragraph ${info.paragraph}. Links work best directly below the hook.`));
        linkMoveBtn.hidden = !editable || high;
      }
    }
    copyArea.addEventListener('input', () => { refreshPreview(); if (editable) queueSave('copy', copyArea.value); });
    linkMoveBtn.onclick = () => {
      copyArea.value = moveFirstLinkHigher(copyArea.value);
      autosizeTextarea(copyArea);
      copyArea.dispatchEvent(new Event('input'));
      copyArea.style.height = 'auto';
      copyArea.style.height = `${copyArea.scrollHeight + 2}px`;
    };
    if (editable) autosizeTextarea(copyArea);

    body.append(
      el('section', { class: 'pd-section' }, [el('div', { class: 'pd-label' }, 'Preview'), previewHost]),
      el('section', { class: 'pd-section' }, [
        el('div', { class: 'pd-label-row' }, [
          el('label', { class: 'pd-label' }, 'Post text'),
          el('span', { class: 'pd-label-tools' }, [savedNote, linkMoveBtn]),
        ]),
        copyArea,
        linkInsight,
      ])
    );
    refreshPreview();

    if (post.public_url) {
      body.appendChild(el('div', { class: 'pd-row' }, el('a', { class: 'button secondary md', href: post.public_url, target: '_blank', rel: 'noopener' }, 'View post')));
    }

    if (post.status === 'published' && typeof webPostLine === 'function') webPostLine(body, post.id); // WEB HOOK: "Sent N visits" (80-web.js)

    if (editable) {
      body.appendChild(deliverySection(post, copyArea, missed));
      body.appendChild(optionsSection(post));
    }
    body.appendChild(footerActions(post, editable));
    if (!ctx.firstRender) {
      ctx.firstRender = true;
      if (editable && !missed) { copyArea.focus({ preventScroll: true }); }
      else panel.focus();
    }
  }

  // ---- recovery panels ----
  function missedPanel(post) {
    const manual = isManualPost(post);
    const sendBtn = el('button', { class: 'button primary md', type: 'button' }, 'Send now');
    const pickBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Pick a new time');
    sendBtn.onclick = async () => {
      const dry = await postDrawerWorkerDryRun();
      const ok = await confirmDialog({
        title: `Send to ${postDrawerAccountLabel(post)} now?`,
        body: dry ? 'DRY RUN is on, so nothing reaches Blotato.' : 'This goes LIVE as soon as Blotato picks it up. It cannot be deleted from PostDeck afterwards.',
        confirmLabel: dry ? 'Send (dry run)' : 'Send now',
        tone: dry ? 'primary' : 'destructive',
      });
      if (!ok) return;
      sendBtn.disabled = true;
      try {
        await flushSave();
        const res = await api(`/api/posts/${post.id}/submit`, { method: 'POST', body: {} });
        const wasDry = res.status === 'submitted_dry' || (res.post && res.post.status === 'submitted_dry');
        toast(wasDry ? 'Sent in dry run. Nothing reached Blotato.' : 'Sent to Blotato.');
        ctx.changed = true;
        notify();
        closeDrawer({ notifyChange: false });
      } catch (err) {
        sendBtn.disabled = false;
        toast(`Could not send: ${err.message}`, 'error');
      }
    };
    pickBtn.onclick = () => {
      if (ctx.pickNewTime) ctx.pickNewTime();
    };
    return el('div', { class: 'pd-panel pd-panel--bad' }, [
      el('h3', {}, 'This missed its time'),
      el('p', {}, `It was set for ${fmtDate(post.publish_at)} but never went out, most likely because the app was closed. Send it now or pick a new time.`),
      manual
        ? el('p', { class: 'pd-hint' }, 'This account is set to manual, so PostDeck never sends it. Post it by hand, then use Mark as posted below.')
        : null,
      el('div', { class: 'pd-row' }, manual ? [pickBtn] : [sendBtn, pickBtn]),
    ]);
  }

  function failedPanel(post) {
    const fixBtn = el('button', { class: 'button primary md', type: 'button' }, 'Fix and reschedule');
    const cancelBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Cancel post');
    fixBtn.onclick = () => mutate('Could not move to draft', async () => {
      await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'draft', publish_at: null } });
      toast('Moved to drafts. Your text is kept. Pick a new time below.');
    }, { close: false });
    cancelBtn.onclick = () => cancelPost(post);
    return el('div', { class: 'pd-panel pd-panel--bad' }, [
      el('h3', {}, 'This post did not go out'),
      el('p', {}, post.error_message ? humanizePostError(post.error_message, post.platform) : 'Blotato rejected it, and no reason came back.'),
      el('p', { class: 'pd-hint' }, 'Fix and reschedule moves it back to a draft with your text kept, so you can change it and pick a time.'),
      el('div', { class: 'pd-row' }, [fixBtn, cancelBtn]),
    ]);
  }

  function failedVerifyPanel(post) {
    const checkBtn = el('button', { class: 'button primary md', type: 'button' }, 'Check again');
    const markBtn = el('button', { class: 'button secondary md', type: 'button' }, 'Mark as posted');
    const draftBtn = el('button', { class: 'button ghost md', type: 'button' }, 'Move to draft');
    checkBtn.onclick = async () => {
      checkBtn.disabled = true;
      try {
        const res = await api(`/api/posts/${post.id}/recheck`, { method: 'POST', body: {} });
        const next = res && res.post ? res.post.status : null;
        if (next === 'published') toast('Confirmed. The post is live.');
        else if (next === 'failed') toast('Blotato reports it failed. Move it to draft to try again.', 'warn');
        else toast(`Still not confirmed${res && res.blotato_state ? ` (Blotato says ${res.blotato_state})` : ''}. Check the account.`, 'warn');
        ctx.changed = true;
        notify();
        await load();
      } catch (err) {
        checkBtn.disabled = false;
        toast(err.status === 404 ? 'Checking is not available for this post. Look at the account and use Mark as posted.' : err.message, 'warn');
      }
    };
    markBtn.onclick = () => markPostedFlow(post);
    draftBtn.onclick = () => moveToDraft(post, { undo: false });
    return el('div', { class: 'pd-panel pd-panel--bad' }, [
      el('h3', {}, 'Blotato never confirmed this'),
      el('p', {}, 'It may be live. Check the account before you do anything else, or ask Blotato again.'),
      el('div', { class: 'pd-row' }, [checkBtn, markBtn, draftBtn]),
    ]);
  }

  function sendingPanel(post) {
    const wrap = el('div', { class: 'pd-panel pd-panel--info' }, [
      el('h3', {}, post.status === 'submitted_dry' ? 'Dry run' : 'Sent to Blotato'),
      el('p', {}, post.status === 'submitted_dry'
        ? 'Nothing reached Blotato. This is what a live send would have done.'
        : 'Blotato is publishing it. This usually takes a minute. It becomes Posted once Blotato confirms.'),
    ]);
    if (post.status === 'submitted') {
      const btn = el('button', { class: 'button secondary sm', type: 'button' }, 'Check status');
      btn.onclick = async () => {
        btn.disabled = true;
        try {
          const res = await api(`/api/posts/${post.id}/recheck`, { method: 'POST', body: {} });
          toast(res && res.post && res.post.status === 'published' ? 'Confirmed. The post is live.' : 'Still processing.', 'ok');
          ctx.changed = true;
          notify();
          await load();
        } catch (err) {
          btn.disabled = false;
          toast(err.message, 'warn');
        }
      };
      wrap.appendChild(el('div', { class: 'pd-row' }, btn));
    }
    return wrap;
  }

  // ---- shared actions ----
  async function markPostedFlow(post) {
    const url = await promptDialog({
      title: 'Mark as posted',
      body: 'Paste the link to the live post. PostDeck will record it as posted and send nothing to Blotato.',
      label: 'Post URL',
      placeholder: 'https://',
      type: 'url',
      confirmLabel: 'Mark as posted',
    });
    if (!url) return;
    await mutate('Could not mark posted', async () => {
      await api(`/api/posts/${post.id}/mark-posted`, { method: 'POST', body: { public_url: url } });
      toast('Marked as posted.');
    });
  }

  async function moveToDraft(post, { undo = true } = {}) {
    const prevIso = post.publish_at;
    const prevStatus = post.status;
    try {
      await flushSave();
      await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'draft', publish_at: null } });
    } catch (err) {
      toast(`Could not move to draft: ${err.message}`, 'error');
      return;
    }
    ctx.changed = true;
    const canUndo = undo && ['approved', 'scheduled_local'].includes(prevStatus);
    toast('Moved to drafts.', canUndo ? {
      tone: 'ok',
      duration: 8000,
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'approved', publish_at: prevIso } });
            toast('Back on the schedule.');
          } catch (err) {
            toast(`Could not undo: ${err.message}`, 'error');
          }
          notify();
        },
      },
    } : 'ok');
    notify();
    closeDrawer({ notifyChange: false });
  }

  async function cancelPost(post) {
    const ok = await confirmDialog({
      title: 'Cancel this post?',
      body: 'It will not be sent. A canceled post cannot be put back on the schedule. You can duplicate it first if you might want it again.',
      confirmLabel: 'Cancel post',
      cancelLabel: 'Keep it',
      tone: 'destructive',
    });
    if (!ok) return;
    await mutate('Could not cancel', async () => {
      await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { status: 'canceled' } });
      toast('Post canceled.');
    });
  }

  async function deletePost(post) {
    const ok = await confirmDialog({
      title: post.status === 'draft' ? 'Delete this draft?' : 'Delete this post?',
      body: 'This removes it for good. It cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'destructive',
    });
    if (!ok) return;
    await mutate('Could not delete', async () => {
      await api(`/api/posts/${post.id}`, { method: 'DELETE' });
      toast('Deleted.');
    });
  }

  // ---- delivery ----
  function deliverySection(post, copyArea, missed) {
    const isDraft = post.status === 'draft';
    let delivery = isDraft ? 'draft' : 'schedule';
    const dt = el('input', { type: 'datetime-local', value: isoToLocalInput(post.publish_at), 'aria-label': 'Publish time' });
    const initialDt = dt.value;
    const choiceHost = el('div', { class: 'pd-choices', role: 'radiogroup', 'aria-label': 'What should happen' });
    const schedulePanel = el('div', { class: 'pd-schedule' });
    const note = el('div', { class: 'pd-note', hidden: true, role: 'status' });
    const msgHost = el('div', { class: 'pd-msg' });
    const primary = el('button', { class: 'button primary md pd-primary', type: 'button' }, 'Save draft');

    const presets = el('div', { class: 'pd-presets' });
    const showLater = new Date().getHours() < 21;
    const weekdayDate = postDrawerNextWeekday();
    const presetDefs = [];
    if (showLater) presetDefs.push(['later', 'Later today']);
    presetDefs.push(['tomorrow', 'Tomorrow 9 AM']);
    presetDefs.push(['weekday', `${weekdayDate.toLocaleDateString(undefined, { weekday: 'short' })} 9 AM`]);
    for (const [kind, label] of presetDefs) {
      presets.appendChild(el('button', {
        class: 'chip-btn', type: 'button',
        onclick: () => { dt.value = quickScheduleValue(kind); onTimeChange(); },
      }, label));
    }
    schedulePanel.append(el('div', { class: 'pd-label' }, 'Publish at'), dt, presets, note);

    let qhToken = 0;
    async function onTimeChange() {
      const token = ++qhToken;
      note.hidden = true;
      if (!dt.value) return;
      const when = new Date(dt.value);
      if (when.getTime() < Date.now()) {
        note.textContent = 'That time has already passed. Pick a later time, or use Post now.';
        note.className = 'pd-note pd-note--warn';
        note.hidden = false;
        return;
      }
      const iso = when.toISOString();
      const info = await quietHoursInfo(iso);
      if (token !== qhToken || !info) return;
      note.textContent = `${fmtDate(iso)} is inside quiet hours (${info.quiet_start} to ${info.quiet_end}). You can still schedule it.`;
      note.className = 'pd-note pd-note--warn';
      note.hidden = false;
    }
    dt.addEventListener('input', onTimeChange);
    dt.addEventListener('change', onTimeChange);

    const hasSlots = () => Array.isArray(ctx.slots) && ctx.slots.some((s) => s.active === undefined || s.active);
    function defs() {
      const list = [
        ['draft', 'Save as draft', 'Keeps it here. Nothing sends.'],
        ['schedule', 'Schedule', 'Goes out at the time you pick.'],
      ];
      if (hasSlots()) list.push(['queue', 'Add to queue', `Takes the next open ${brandName(post.brand_id)} slot.`]);
      list.push(['now', 'Post now', 'Publishes right away.']);
      return list;
    }
    function renderChoices() {
      choiceHost.innerHTML = '';
      for (const [value, title, sub] of defs()) {
        choiceHost.appendChild(el('button', {
          class: `pd-choice${delivery === value ? ' is-active' : ''}`,
          type: 'button', role: 'radio', 'aria-checked': delivery === value ? 'true' : 'false',
          onclick: () => { delivery = value; renderChoices(); },
        }, [el('strong', {}, title), el('span', {}, sub)]));
      }
      schedulePanel.hidden = delivery !== 'schedule';
      const labels = {
        draft: isDraft ? 'Save draft' : 'Move to draft',
        schedule: isDraft ? 'Schedule post' : 'Update time',
        queue: 'Add to queue',
        now: 'Post now',
      };
      primary.textContent = labels[delivery];
      primary.className = `button ${delivery === 'now' ? 'destructive' : 'primary'} md pd-primary`;
      if (delivery === 'schedule') onTimeChange();
    }
    ctx.onSlots = renderChoices;
    ctx.pickNewTime = () => {
      delivery = 'schedule';
      renderChoices();
      if (!dt.value || new Date(dt.value).getTime() < Date.now()) dt.value = quickScheduleValue('tomorrow');
      onTimeChange();
      dt.scrollIntoView({ block: 'center', behavior: 'smooth' });
      dt.focus({ preventScroll: true });
    };
    ctx.timeDirty = () => delivery === 'schedule' && dt.value !== initialDt;
    renderChoices();

    primary.onclick = async () => {
      msgHost.innerHTML = '';
      primary.disabled = true;
      try {
        await flushSave();
        if (delivery === 'draft') {
          if (isDraft) {
            toast('Draft saved.');
            ctx.changed = true;
            notify();
            closeDrawer({ notifyChange: false });
          } else {
            await moveToDraft(post);
          }
        } else if (delivery === 'schedule') {
          if (!dt.value) throw new Error('Pick a date and time first.');
          const when = new Date(dt.value);
          if (when.getTime() < Date.now() + 30000) throw new Error('Pick a time in the future, or use Post now.');
          const publish_at = when.toISOString();
          await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { publish_at, status: 'approved' } });
          toast(`Scheduled for ${fmtDate(publish_at)}.`);
          ctx.changed = true;
          notify();
          closeDrawer({ notifyChange: false });
        } else if (delivery === 'queue') {
          const queued = await api(`/api/posts/${post.id}/queue`, { method: 'POST', body: {} });
          toast(`Queued for ${fmtDate(queued.publish_at)}.`);
          ctx.changed = true;
          notify();
          closeDrawer({ notifyChange: false });
        } else {
          const dry = await postDrawerWorkerDryRun();
          const ok = await confirmDialog({
            title: `Post to ${postDrawerAccountLabel(post)} now?`,
            body: dry
              ? 'DRY RUN is on, so nothing reaches Blotato. This only rehearses the send.'
              : 'This goes LIVE right now. Blotato cannot delete it after sending, and PostDeck cannot take it back.',
            confirmLabel: dry ? 'Post now (dry run)' : 'Post now',
            tone: dry ? 'primary' : 'destructive',
          });
          if (!ok) { primary.disabled = false; return; }
          const result = await api(`/api/posts/${post.id}/publish-now`, { method: 'POST', body: {} });
          toast(result && result.dry_run ? 'Dry run complete. Nothing reached Blotato.' : 'Sent. It is going live.');
          ctx.changed = true;
          notify();
          closeDrawer({ notifyChange: false });
        }
      } catch (err) {
        msgHost.appendChild(inlineBanner(err.message, 'error'));
      } finally {
        primary.disabled = false;
      }
    };

    return el('section', { class: 'pd-section pd-delivery', id: 'pd-delivery' }, [
      el('div', { class: 'pd-label' }, post.status === 'draft' ? 'What should happen?' : 'Delivery'),
      choiceHost,
      schedulePanel,
      msgHost,
      primary,
    ]);
  }

  // ---- first comment + platform options ----
  function optionsSection(post) {
    const details = el('details', { class: 'pd-details' });
    details.appendChild(el('summary', {}, 'Options'));
    const inner = el('div', { class: 'pd-details-body' });

    const fc = el('textarea', { rows: '3', placeholder: 'Optional. Posted as the first comment.', 'aria-label': 'First comment' });
    fc.value = post.first_comment || '';
    fc.addEventListener('input', () => queueSave('first_comment', fc.value));
    inner.appendChild(el('div', { class: 'pd-field' }, [el('label', { class: 'pd-label' }, 'First comment'), fc]));
    if (!['twitter', 'bluesky', 'threads'].includes(post.platform)) {
      inner.appendChild(el('p', { class: 'pd-hint' }, `Blotato cannot post a first comment on ${humanizePlatformName(post.platform)}. You will get a reminder to paste it once the post is live.`));
    }

    if (['tiktok', 'reddit', 'blog'].includes(post.platform)) {
      const fields = { ...(post.platform_fields || {}) };
      const host = el('div', { class: 'pd-field' });
      inner.appendChild(host);
      (async () => {
        if (post.platform === 'blog') {
          const media = await api('/api/media').catch(() => []);
          host.appendChild(blogFieldsEditor(fields, media));
        } else if (post.platform === 'tiktok') host.appendChild(tiktokFieldsEditor(fields));
        else host.appendChild(redditFieldsEditor(fields));
      })();
      const saveBtn = el('button', { class: 'button secondary sm', type: 'button' }, `Save ${humanizePlatformName(post.platform)} options`);
      saveBtn.onclick = async () => {
        saveBtn.disabled = true;
        try {
          await api(`/api/posts/${post.id}`, { method: 'PATCH', body: { platform_fields: fields } });
          ctx.changed = true;
          toast('Options saved.');
        } catch (err) {
          toast(`Could not save options: ${err.message}`, 'error');
        } finally {
          saveBtn.disabled = false;
        }
      };
      inner.appendChild(saveBtn);
    }
    details.appendChild(inner);
    return details;
  }

  // ---- footer ----
  function footerActions(post, editable) {
    const row = el('div', { class: 'pd-footer' });
    const copyBtn = el('button', { class: 'button ghost sm', type: 'button' }, 'Copy text');
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(ctx.post.copy || ''); toast('Text copied.'); } catch { toast('Could not copy. Select the text instead.', 'error'); }
    };
    const dupBtn = el('button', { class: 'button ghost sm', type: 'button' }, 'Duplicate');
    dupBtn.onclick = () => { closeDrawer({ notifyChange: false, immediate: true }); duplicatePostFlow(post, { onChange }); };
    const brandRow = el('div', { class: 'pd-brand-row', hidden: true });
    const toBrandBtn = el('button', { class: 'button ghost sm', type: 'button' }, 'Copy to brand');
    toBrandBtn.onclick = () => {
      brandRow.hidden = !brandRow.hidden;
      if (!brandRow.hidden) {
        renderBrandPickerRow(brandRow, post.brand_id, (targetBrandId) => {
          closeDrawer({ notifyChange: false, immediate: true });
          duplicatePostFlow(post, { brandId: targetBrandId, onChange });
        });
      }
    };
    const buttons = [copyBtn, dupBtn, toBrandBtn];

    if (['approved', 'scheduled_local'].includes(post.status)) {
      const toDraft = el('button', { class: 'button ghost sm', type: 'button' }, 'Move to draft');
      toDraft.onclick = () => moveToDraft(post);
      buttons.push(toDraft);
    }
    if (['approved', 'scheduled_local'].includes(post.status)) {
      const markBtn = el('button', { class: 'button ghost sm', type: 'button' }, 'Already posted? Mark as posted');
      markBtn.onclick = () => markPostedFlow(post);
      buttons.push(markBtn);
    }
    if (['approved', 'scheduled_local'].includes(post.status)) {
      const cancel = el('button', { class: 'button ghost sm pd-danger', type: 'button' }, 'Cancel post');
      cancel.onclick = () => cancelPost(post);
      buttons.push(cancel);
    }
    if (['draft', 'canceled'].includes(post.status)) {
      const del = el('button', { class: 'button ghost sm pd-danger', type: 'button' }, post.status === 'draft' ? 'Delete draft' : 'Delete');
      del.onclick = () => deletePost(post);
      buttons.push(del);
    }
    row.append(...buttons, brandRow);
    return row;
  }

  load();
  return { close: () => requestClose() };
}
