// publish_at normalization (audit 2026-10-07 T6). publish_at used to be stored
// as whatever text arrived (`...Z`, no-ms, `YYYY-MM-DD HH:MM:SS`, no zone), and
// compared as strings in SQL. Every write path now goes through normalizeIso so
// the column only ever holds UTC ISO with milliseconds and a trailing Z.

// Zone-less date-times, T or space separated (SQLite datetime('now') style).
const ZONELESS_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/**
 * @param {string|number|Date|null|undefined} value
 * @returns {string|null} UTC ISO ('2026-08-19T22:17:34.000Z'), or null for
 *   null/undefined/'' input.
 * @throws {Error} statusCode 400, code 'invalid_publish_at', retryable:false
 *   when the value cannot be parsed. Zone-less strings are read as UTC.
 */
export function normalizeIso(value) {
  if (value === null || value === undefined) return null;
  let ms;
  if (value instanceof Date) {
    ms = value.getTime();
  } else if (typeof value === 'number') {
    ms = value;
  } else if (typeof value === 'string') {
    const s = value.trim();
    if (!s) return null;
    const m = ZONELESS_RE.exec(s);
    ms = Date.parse(m ? `${m[1]}T${m[2]}Z` : s);
  } else {
    ms = NaN;
  }
  if (!Number.isFinite(ms) || Number.isNaN(new Date(ms).getTime())) {
    const err = new Error(`Invalid publish_at '${String(value)}' - expected an ISO 8601 date-time.`);
    err.statusCode = 400;
    err.code = 'invalid_publish_at';
    err.retryable = false;
    throw err;
  }
  return new Date(ms).toISOString();
}

/** Epoch ms of a stored publish_at (any legacy format), or NaN. */
export function toMs(value) {
  try {
    const iso = normalizeIso(value);
    return iso === null ? NaN : Date.parse(iso);
  } catch {
    return NaN;
  }
}
