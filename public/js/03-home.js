// Home moved to 50-home.js in D3. Only helpers still shared with other views remain here.

// Small brand-initial disc for the "All brands" view (item 5) - reuses the
// same brandColor mapping the coverage strip already assigns per-brand.
function brandIdentityDisc(brandId) {
  const name = brandName(brandId) || '?';
  return el('span', { class: 'brand-identity-disc', style: `background:${brandColor(brandId)}`, title: brandName(brandId) }, name.trim().charAt(0).toUpperCase());
}
function manualWarnGlyph(post) {
  if (isMissedWindowPost(post)) return el('span', { class: 'manual-warn-glyph missed-window', title: 'missed window - review and resend' }, '⚠');
  if (['scheduled_local', 'approved'].includes(post.status) && isManualPost(post)) {
    return el('span', { class: 'manual-warn-glyph', title: "won't auto-post - this account is manual" }, '⚠');
  }
  return null;
}

// Keeps the local time-of-day, swaps in the day the chip was dropped on.
function rescheduleToDateKeepingTime(originalIso, newDateKey) {
  const [y, m, d] = newDateKey.split('-').map(Number);
  const dt = originalIso ? new Date(originalIso) : new Date();
  dt.setFullYear(y, m - 1, d);
  return dt.toISOString();
}

// F3: drag mime type for an idea-card drop onto a calendar day cell - kept
// distinct from the plain 'text/plain' postId the existing chip-reschedule
// drag uses, so the two drag kinds never get confused in the drop handler.
const IDEA_DRAG_MIME = 'application/x-postdeck-idea';

// F3: idea -> Quick Compose prefill, shared by the calendar drag-drop and the
// idea card's "Use in post" button. `dateKey` (YYYY-MM-DD) is only present on
// a calendar drop - the button omits it and just seeds the copy/brand as
// usual (no date context to prefill). idea.id rides along so the Quick
// Compose save path can flip the idea to 'done' once the post is created.
function composeFromIdea(idea, dateKey) {
  const sticky = getStickyBrand();
  const brandId = idea.brand_id != null
    ? idea.brand_id
    : (sticky && state.brands.some((b) => String(b.id) === String(sticky)) ? sticky : null);
  openQuickCompose({
    brandId,
    copy: idea.title || '',
    publishAt: dateKey ? `${dateKey}T09:00` : undefined,
    ideaId: idea.id,
  });
}

// Jump to the composer with "Publish at" prefilled to the clicked day (09:00
// local), carrying the calendar's current brand filter. Still used by the
// day popover's "+ New post" button... no - Quick Compose is preferred there
// (see openDayPopover); kept for any other future full-page entry points.
function composeOnDate(dateKey) {
  sessionStorage.setItem('pd_composer_prefill_date', `${dateKey}T09:00`);
  const brandSel = document.getElementById('cal-brand');
  if (brandSel && brandSel.value) sessionStorage.setItem('pd_composer_prefill_brand', brandSel.value);
  location.hash = '#/composer';
}
