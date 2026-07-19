// Best-time nudge (B18a — docs/B16_B18_COMPETITIVE_WAVE_SPEC.md "Insight-at-
// decision-point + link tracking"). Rides on data already in the system:
// buckets published-post engagement (comments+shares+saves, same convention
// as analytics.js's rollupFor) by day-of-week + 3h hour band, and falls back
// to static per-platform defaults in config/platform-specs.json when there
// isn't enough data yet. Suggestion only — never auto-schedules (queue slots,
// src/queue.js, remain the actual automation).

import { loadPlatformSpecs } from './platforms.js';

const MIN_DATA_POSTS = 8;
const HOUR_BAND_SIZE = 3; // hours per bucket
const TOP_N = 3;
const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Local-time day-of-week (0=Sun..6=Sat) + minutes-since-midnight for a Date. */
function dateParts(d) {
  return { dow: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
}

/** Next occurrence (Date) of (dow, minutes) at/after `from`, rolling to next
 * week if that dow's time-of-day has already passed today. Mirrors
 * src/queue.js's nextOccurrence. */
function nextOccurrence(from, dow, minutes) {
  const fp = dateParts(from);
  let dayDelta = dow - fp.dow;
  if (dayDelta < 0) dayDelta += 7;
  if (dayDelta === 0 && minutes < fp.minutes) dayDelta += 7;
  const candidate = new Date(from);
  candidate.setHours(0, 0, 0, 0);
  candidate.setDate(candidate.getDate() + dayDelta);
  candidate.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return candidate;
}

/**
 * Next ISO datetime inside `band` ({days:[0-6,...], start_hour, ...}) at/after
 * `from` (Date|string, defaults to now). Uses `start_hour` as the target
 * time-of-day and picks the earliest occurrence across all of `band.days`.
 * Returns null for a malformed/empty band.
 */
function nextMatchingDatetime(band, from = new Date()) {
  if (!band || !Array.isArray(band.days) || !band.days.length) return null;
  const fromDate = from instanceof Date ? from : new Date(from);
  if (Number.isNaN(fromDate.getTime())) return null;
  const minutes = (band.start_hour ?? 9) * 60;
  let best = null;
  for (const dow of band.days) {
    const candidate = nextOccurrence(fromDate, dow, minutes);
    if (!best || candidate.getTime() < best.getTime()) best = candidate;
  }
  return best ? best.toISOString() : null;
}

function hourLabel(hour) {
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? 'am' : 'pm';
  let display = h % 12;
  if (display === 0) display = 12;
  return `${display}${period}`;
}

function bandLabel(days, startHour, endHour) {
  const names = [...days].sort((a, b) => a - b).map((d) => DOW_NAMES[d]);
  const dayPart =
    names.length > 1 ? `${names[0]}-${names[names.length - 1]}` : names[0] || '';
  return `${dayPart} ${hourLabel(startHour)}-${hourLabel(endHour)}`.trim();
}

/** Static fallback bands for a platform, read from config/platform-specs.json
 * (`best_times.bands`). Returns [] if the platform/key is missing. */
function defaultBands(platform) {
  const specs = loadPlatformSpecs();
  const spec = specs[platform];
  const bands = spec?.best_times?.bands;
  if (!Array.isArray(bands)) return [];
  return bands.map((b) => ({
    days: b.days,
    start_hour: b.start_hour,
    end_hour: b.end_hour,
    label: b.label || bandLabel(b.days, b.start_hour, b.end_hour),
  }));
}

/**
 * bestTimes(db, brand_id, platform):
 *  - if >= MIN_DATA_POSTS published posts (that brand+platform) carry at
 *    least one metrics row: bucket each post's total engagement
 *    (comments+shares+saves, matching analytics.js's rollupFor convention)
 *    by day-of-week + HOUR_BAND_SIZE-hour band (keyed off publish_at, falling
 *    back to updated_at), and return the top 3 bands by summed engagement.
 *  - else: static defaults from config/platform-specs.json.
 * @returns {{source: 'data'|'default', bands: Array<{days:number[], start_hour:number, end_hour:number, label:string}>}}
 */
function bestTimes(db, brand_id, platform) {
  const rows = db
    .prepare(
      `
      SELECT p.publish_at, p.updated_at,
        COALESCE(SUM(m.comments), 0) + COALESCE(SUM(m.shares), 0) + COALESCE(SUM(m.saves), 0) AS engagement
      FROM posts p
      JOIN metrics m ON m.post_id = p.id
      WHERE p.status = 'published' AND p.brand_id = ? AND p.platform = ?
      GROUP BY p.id
    `
    )
    .all(brand_id, platform);

  if (rows.length < MIN_DATA_POSTS) {
    return { source: 'default', bands: defaultBands(platform) };
  }

  const buckets = new Map(); // key `${dow}:${hourBin}` -> { dow, hourBin, engagement }
  for (const row of rows) {
    const ts = row.publish_at || row.updated_at;
    if (!ts) continue;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) continue;
    const dow = d.getDay();
    const hourBin = Math.floor(d.getHours() / HOUR_BAND_SIZE) * HOUR_BAND_SIZE;
    const key = `${dow}:${hourBin}`;
    const existing = buckets.get(key) || { dow, hourBin, engagement: 0 };
    existing.engagement += row.engagement;
    buckets.set(key, existing);
  }

  const ranked = [...buckets.values()].sort((a, b) => b.engagement - a.engagement).slice(0, TOP_N);

  if (!ranked.length) {
    return { source: 'default', bands: defaultBands(platform) };
  }

  const bands = ranked.map(({ dow, hourBin }) => {
    const days = [dow];
    const start_hour = hourBin;
    const end_hour = hourBin + HOUR_BAND_SIZE;
    return { days, start_hour, end_hour, label: bandLabel(days, start_hour, end_hour) };
  });

  return { source: 'data', bands };
}

/** Days since the most recent published (or submitted, still in flight to
 * publish) post for a brand+platform, or null if there isn't one yet. */
function daysSinceLastPost(db, brand_id, platform) {
  const row = db
    .prepare(
      `
      SELECT MAX(updated_at) AS last_at FROM posts
      WHERE brand_id = ? AND platform = ? AND status IN ('published', 'submitted')
    `
    )
    .get(brand_id, platform);
  if (!row || !row.last_at) return null;
  const last = new Date(row.last_at);
  if (Number.isNaN(last.getTime())) return null;
  const ms = Date.now() - last.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

export { bestTimes, nextMatchingDatetime, daysSinceLastPost, defaultBands, MIN_DATA_POSTS, HOUR_BAND_SIZE };
