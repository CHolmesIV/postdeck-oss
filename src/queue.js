// Queue slots (B16a — SPEC.md "Queue slots (Sprout's signature pattern)").
// Instead of hand-picking publish_at per post, a brand+platform defines
// recurring weekly slots; "Add to queue" walks them forward from `from` and
// drops the post into the next one that isn't already taken, isn't inside
// quiet hours, and isn't in the past. No live re-flow when slots change —
// keep it dumb (see spec note).

import { nowIso } from './db.js';
import { isWithinQuietHours, getAllSettings } from './settings.js';

const MINUTES_PER_DAY = 24 * 60;
const DAYS_PER_WEEK = 7;
const TAKEN_STATUSES = ['scheduled_local', 'submitted', 'approved'];

// ---------- slot CRUD ----------

function listQueueSlots(db, { brand_id, platform } = {}) {
  const clauses = [];
  const params = [];
  let sql = 'SELECT * FROM queue_slots WHERE 1=1';
  if (brand_id !== undefined && brand_id !== null) {
    clauses.push('brand_id = ?');
    params.push(brand_id);
  }
  if (platform) {
    clauses.push('platform = ?');
    params.push(platform);
  }
  if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
  sql += ' ORDER BY day_of_week, time_local';
  return db.prepare(sql).all(...params);
}

function getQueueSlot(db, id) {
  return db.prepare('SELECT * FROM queue_slots WHERE id = ?').get(id);
}

function validateSlotInput({ brand_id, platform, day_of_week, time_local }) {
  if (brand_id === undefined || brand_id === null) return 'brand_id is required';
  if (!platform) return 'platform is required';
  const dow = Number(day_of_week);
  if (!Number.isInteger(dow) || dow < 0 || dow > 6) return 'day_of_week must be an integer 0-6';
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(String(time_local || ''))) {
    return "time_local must be 'HH:MM' (24hr)";
  }
  return null;
}

function createQueueSlot(db, input = {}) {
  const err = validateSlotInput(input);
  if (err) return { error: err };
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO queue_slots (brand_id, platform, day_of_week, time_local, active, created_at)
       VALUES (@brand_id, @platform, @day_of_week, @time_local, @active, @now)`
    )
    .run({
      brand_id: input.brand_id,
      platform: input.platform,
      day_of_week: Number(input.day_of_week),
      time_local: input.time_local,
      active: input.active === undefined ? 1 : input.active ? 1 : 0,
      now,
    });
  return { row: getQueueSlot(db, info.lastInsertRowid) };
}

function updateQueueSlot(db, id, patch = {}) {
  const existing = getQueueSlot(db, id);
  if (!existing) return { error: 'not_found' };

  const merged = {
    brand_id: patch.brand_id !== undefined ? patch.brand_id : existing.brand_id,
    platform: patch.platform !== undefined ? patch.platform : existing.platform,
    day_of_week: patch.day_of_week !== undefined ? Number(patch.day_of_week) : existing.day_of_week,
    time_local: patch.time_local !== undefined ? patch.time_local : existing.time_local,
    active: patch.active !== undefined ? (patch.active ? 1 : 0) : existing.active,
  };
  const err = validateSlotInput(merged);
  if (err) return { error: err };

  db.prepare(
    `UPDATE queue_slots SET brand_id = @brand_id, platform = @platform, day_of_week = @day_of_week,
     time_local = @time_local, active = @active WHERE id = @id`
  ).run({ ...merged, id });
  return { row: getQueueSlot(db, id) };
}

function deleteQueueSlot(db, id) {
  const existing = getQueueSlot(db, id);
  if (!existing) return { error: 'not_found' };
  db.prepare('DELETE FROM queue_slots WHERE id = ?').run(id);
  return { ok: true };
}

// ---------- next-open-slot computation ----------

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** Local-time day-of-week (0=Sun..6=Sat) + minutes-since-midnight for a Date. */
function dateParts(d) {
  return { dow: d.getDay(), minutes: d.getHours() * 60 + d.getMinutes() };
}

/** Build a Date for the next occurrence of (dow, minutes) at-or-after `from`. */
function nextOccurrence(from, dow, minutes) {
  const fromParts = dateParts(from);
  let dayDelta = dow - fromParts.dow;
  if (dayDelta < 0) dayDelta += DAYS_PER_WEEK;
  if (dayDelta === 0 && minutes < fromParts.minutes) {
    // Same day, but the slot's time has already passed today — roll to next week.
    dayDelta = DAYS_PER_WEEK;
  }
  const candidate = new Date(from);
  candidate.setHours(0, 0, 0, 0);
  candidate.setDate(candidate.getDate() + dayDelta);
  candidate.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
  return candidate;
}

/**
 * Find the next open datetime for a brand+platform's queue, starting from
 * `from` (Date or ISO string, defaults to now). Walks the brand's active
 * slots for that platform in weekly order, skipping:
 *  - datetimes already taken by an existing post (status scheduled_local /
 *    submitted / approved with a matching publish_at) for that brand+platform
 *  - datetimes inside the configured quiet-hours window
 *  - same-day slots whose time has already passed (rolled to next week by
 *    nextOccurrence above)
 * Returns the first open slot's ISO datetime, or null if the brand/platform
 * has no active slots. Walks up to 2 full weeks forward as a safety bound.
 * @param {import('better-sqlite3').Database} db
 * @param {number} brand_id
 * @param {string} platform
 * @param {Date|string} [from]
 * @returns {string|null}
 */
function nextOpenSlot(db, brand_id, platform, from) {
  const fromDate = from ? new Date(from) : new Date();
  const slots = db
    .prepare(
      `SELECT * FROM queue_slots WHERE brand_id = ? AND platform = ? AND active = 1
       ORDER BY day_of_week, time_local`
    )
    .all(brand_id, platform);
  if (!slots.length) return null;

  const takenPlaceholders = TAKEN_STATUSES.map(() => '?').join(', ');
  const isTaken = (iso) => {
    const row = db
      .prepare(
        `SELECT 1 FROM posts WHERE brand_id = ? AND platform = ? AND publish_at = ?
         AND status IN (${takenPlaceholders}) LIMIT 1`
      )
      .get(brand_id, platform, iso, ...TAKEN_STATUSES);
    return !!row;
  };

  const settings = getAllSettings(db);

  // Walk up to 2 weeks of weekly occurrences, in chronological order, and
  // return the first one that's open.
  const MAX_WEEKS = 2;
  for (let week = 0; week < MAX_WEEKS; week++) {
    const candidates = slots
      .map((slot) => {
        const minutes = toMinutes(slot.time_local);
        const occurrence = nextOccurrence(fromDate, slot.day_of_week, minutes);
        occurrence.setDate(occurrence.getDate() + week * DAYS_PER_WEEK);
        return occurrence;
      })
      .sort((a, b) => a.getTime() - b.getTime());

    for (const candidate of candidates) {
      if (candidate.getTime() < fromDate.getTime()) continue; // safety, shouldn't happen
      const iso = candidate.toISOString();
      if (isWithinQuietHours(iso, settings.quiet_start, settings.quiet_end)) continue;
      if (isTaken(iso)) continue;
      return iso;
    }
  }
  return null;
}

export {
  listQueueSlots,
  getQueueSlot,
  createQueueSlot,
  updateQueueSlot,
  deleteQueueSlot,
  nextOpenSlot,
};
