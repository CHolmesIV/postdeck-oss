// Generic settings read/write on the `settings` key/value table (B6 polish).
// Shared shape between src/worker.js (handoff_window_hours, which keeps its
// own local copy of getSetting for now to avoid touching a working B4 file)
// and src/server.js (quiet hours + a real Settings API for the dashboard).

import { getDb } from './db.js';

const DEFAULTS = {
  quiet_start: '22:00',
  quiet_end: '07:00',
  handoff_window_hours: 48,
};

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSetting(db, key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (@key, @value)
     ON CONFLICT(key) DO UPDATE SET value = @value`
  ).run({ key, value: JSON.stringify(value) });
}

function setSettingIfMissing(db, key, value) {
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
  if (!existing) setSetting(db, key, value);
}

function getAllSettings(db = getDb()) {
  for (const [k, v] of Object.entries(DEFAULTS)) setSettingIfMissing(db, k, v);
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = getSetting(db, k, DEFAULTS[k]);
  return out;
}

function updateSettings(db, patch = {}) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULTS && v !== undefined) setSetting(db, k, v);
  }
  return getAllSettings(db);
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm || '0:0').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Whether an ISO publish_at timestamp falls inside the configured local
 * quiet-hours window. Handles windows that wrap midnight (e.g. 22:00-07:00).
 * This is a soft-warning check only (see SPEC.md B6) — never a hard block.
 */
function isWithinQuietHours(publishAtIso, quietStart = DEFAULTS.quiet_start, quietEnd = DEFAULTS.quiet_end) {
  if (!publishAtIso) return false;
  const d = new Date(publishAtIso);
  if (Number.isNaN(d.getTime())) return false;
  const minutes = d.getHours() * 60 + d.getMinutes();
  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  if (start === end) return false; // 0-length window = quiet hours disabled
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end; // wraps midnight
}

export { getSetting, setSetting, setSettingIfMissing, getAllSettings, updateSettings, isWithinQuietHours, DEFAULTS };
