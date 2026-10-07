// ---------------- Best-time nudge (B18a) ----------------
// Shared by the Composer's Schedule card and the Settings Queues editor -
// both just need "best window for brand+platform" rendered as a compact
// hint line with click-to-apply chips. Pure fetch + render, no state kept
// beyond the DOM the caller hands us.

// Client-side mirror of src/besttime.js's nextMatchingDatetime/nextOccurrence -
// duplicated (not imported) for the same reason parseDimsClient is: this is
// a plain <script> file, not an ES module, so it can't import src/*.js.
// Next ISO-local datetime-local value (YYYY-MM-DDTHH:MM) inside `band`
// ({days:[0-6,...], start_hour}) at/after now, rolling to next week if
// today's slot for that day has already passed.
function nextMatchingDatetimeLocal(band) {
  if (!band || !Array.isArray(band.days) || !band.days.length) return null;
  const now = new Date();
  const targetMinutes = (band.start_hour ?? 9) * 60;
  let best = null;
  for (const dow of band.days) {
    let dayDelta = dow - now.getDay();
    if (dayDelta < 0) dayDelta += 7;
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    if (dayDelta === 0 && targetMinutes < nowMinutes) dayDelta += 7;
    const candidate = new Date(now);
    candidate.setHours(0, 0, 0, 0);
    candidate.setDate(candidate.getDate() + dayDelta);
    candidate.setHours(Math.floor(targetMinutes / 60), targetMinutes % 60, 0, 0);
    if (!best || candidate.getTime() < best.getTime()) best = candidate;
  }
  return best;
}

function dateToLocalInputValue(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Fetches GET /api/best-times?brand_id=&platform= and renders a compact hint
 * line + click-to-apply band chips into `hostEl`. `onApplyIso(localInputValue)`
 * is called with a `datetime-local`-ready string when a chip is clicked (the
 * caller decides what to do with it - set a field, etc). Debounced by the
 * caller (this function itself just does one fetch+render per call); pass a
 * `token` object and this bails out if a newer call has since started, so
 * rapid brand/platform switches never race-render a stale result.
 */
async function renderBestTimeHint(hostEl, { brandId, platform, onApplyIso, guard } = {}) {
  hostEl.innerHTML = '';
  if (!brandId || !platform) return;
  let data;
  try {
    data = await api(`/api/best-times?brand_id=${brandId}&platform=${platform}`);
  } catch {
    return; // best-effort - nudge just doesn't show
  }
  if (guard && guard.stale && guard.stale()) return; // a newer request superseded this one
  hostEl.innerHTML = '';
  if (!data || !Array.isArray(data.bands) || !data.bands.length) return;

  const line = el('div', { class: 'best-time-hint' });
  const sourceLabel = data.source === 'data' ? 'from your data' : 'default';
  line.appendChild(el('span', { class: 'best-time-label' }, `Best window: ${data.bands[0].label} (${sourceLabel})`));
  if (data.last_post_days_ago !== null && data.last_post_days_ago !== undefined) {
    line.appendChild(
      el('span', { class: 'best-time-lastpost' }, ` · Last post to ${platform}: ${data.last_post_days_ago} day${data.last_post_days_ago === 1 ? '' : 's'} ago`)
    );
  }
  hostEl.appendChild(line);

  if (typeof onApplyIso === 'function') {
    const chipRow = el('div', { class: 'best-time-chips' });
    for (const band of data.bands) {
      chipRow.appendChild(
        el('button', {
          type: 'button',
          class: 'chip-btn best-time-chip',
          title: 'Set publish time to the next slot in this window',
          onclick: () => {
            const next = nextMatchingDatetimeLocal(band);
            if (next) onApplyIso(dateToLocalInputValue(next));
          },
        }, band.label)
      );
    }
    hostEl.appendChild(chipRow);
  }
}
