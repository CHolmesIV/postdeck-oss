// Analytics import: CB downloads LinkedIn/Facebook analytics exports (CSV) and
// uploads them into PostDeck. This module parses the export, normalizes the
// column headers (LinkedIn and Meta/Facebook use different labels for the same
// thing), matches each row to a published/submitted post by platform + date,
// and writes the confirmed rows into the existing `metrics` table via the same
// insert semantics as POST /api/posts/:id/metrics (append-only, one row per
// capture).
//
// No new dependencies: CSV parsing reuses src/import.js's parseCsv/csvToObjects.
// XLSX is explicitly unsupported (LinkedIn + Meta both offer CSV export) —
// parseMetricsFile returns a clear error rather than silently failing.

import { csvToObjects } from './import.js';
import { nowIso } from './db.js';

// ---------- 1. parseMetricsFile ----------

const XLSX_EXTS = ['.xlsx', '.xls'];

function extOf(filename) {
  const m = /\.[^.]+$/.exec(filename || '');
  return m ? m[0].toLowerCase() : '';
}

// buffer: Buffer|string, filename: original upload filename (used to pick a parser).
// Returns array of raw row objects (header -> raw string value), or throws an
// Error with a `.code` for the route to translate into a 400.
function parseMetricsFile(buffer, filename) {
  const ext = extOf(filename);
  if (XLSX_EXTS.includes(ext)) {
    const err = new Error('xlsx_not_supported: export as CSV instead');
    err.code = 'xlsx_not_supported';
    throw err;
  }
  const text = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer ?? '');
  if (!text.trim()) {
    const err = new Error('empty_file: no rows found in upload');
    err.code = 'empty_file';
    throw err;
  }
  // Strip a UTF-8 BOM — LinkedIn/Meta exports commonly include one, and it
  // would otherwise get glued onto the first header name.
  const cleaned = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows = csvToObjects(cleaned);
  if (rows.length === 0) {
    const err = new Error('empty_file: no data rows found (header only, or unparseable)');
    err.code = 'empty_file';
    throw err;
  }
  return rows;
}

// ---------- 2. normalizeRows ----------

// Header-synonym map: normalized field -> array of possible source headers
// (case/whitespace-insensitive match against the raw CSV header). Covers
// LinkedIn's "Content" export tab and Meta/Facebook's post-level insights export.
const HEADER_SYNONYMS = {
  date: ['date', 'post date', 'published date', 'created date', 'date created'],
  impressions: [
    'impressions',
    'impressions (organic)',
    'impressions (total)',
    'impressions (organic, total)',
  ],
  clicks: ['clicks', 'clicks (organic)', 'link clicks'],
  likes: ['likes', 'reactions', 'reactions, comments and shares'],
  comments: ['comments'],
  shares: ['shares', 'reposts'],
  engagement_rate: ['engagement rate', 'engagement rate (organic)'],
  reach: ['post reach', 'reach'],
  results: ['results'],
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Build a lookup from normalized-header -> canonical field name once.
const HEADER_LOOKUP = (() => {
  const map = {};
  for (const [canonical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    for (const syn of synonyms) {
      map[normalizeHeader(syn)] = canonical;
    }
  }
  return map;
})();

const NUMERIC_FIELDS = ['impressions', 'clicks', 'likes', 'comments', 'shares', 'reach', 'results'];

function parseNumber(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s === '') return null;
  // Strip thousands separators and a trailing "%" (engagement rate columns).
  const cleaned = s.replace(/,/g, '').replace(/%$/, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseDate(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  // Normalize to a bare calendar day (YYYY-MM-DD) — exports are day-granularity.
  return d.toISOString().slice(0, 10);
}

// rows: array of raw {header: value} objects from parseMetricsFile.
// Returns array of {date, impressions, clicks, likes, comments, shares,
// engagement_rate, reach, results, extra, _skipped, _skipReason, _raw}.
// Rows without a parseable date are marked _skipped with a reason, but still
// returned (so the preview can show CB what was dropped and why).
function normalizeRows(rows) {
  return rows.map((raw) => {
    const out = { extra: {}, _raw: raw };
    for (const [header, value] of Object.entries(raw)) {
      const canonical = HEADER_LOOKUP[normalizeHeader(header)];
      if (canonical) {
        out[canonical] = NUMERIC_FIELDS.includes(canonical) ? parseNumber(value) : value;
      } else if (normalizeHeader(header) !== '') {
        out.extra[header] = value;
      }
    }
    const date = parseDate(out.date);
    if (!date) {
      out._skipped = true;
      out._skipReason = 'unparseable_date';
      out.date = null;
      return out;
    }
    out.date = date;
    out._skipped = false;
    return out;
  });
}

// ---------- 3. matchRows ----------

const DAY_MS = 24 * 60 * 60 * 1000;

function dayDiff(aIso, bIso) {
  return Math.round((new Date(aIso).getTime() - new Date(bIso).getTime()) / DAY_MS);
}

// db: better-sqlite3 handle. rows: normalized rows from normalizeRows.
// opts: {platform (required), brand_id (optional)}.
// Returns {matches: [{row, post_id, post_copy_snippet, confidence, candidates?}]}
//   confidence: 'exact' (same-day match, unique) | 'adjacent' (±1 day, unique)
//               | 'ambiguous' (multiple candidates) | 'none' (no candidate).
function matchRows(db, rows, { platform, brand_id } = {}) {
  if (!platform) {
    throw Object.assign(new Error('platform is required'), { code: 'platform_required' });
  }
  let sql = `
    SELECT id, copy, publish_at, brand_id
    FROM posts
    WHERE platform = ?
      AND status IN ('submitted', 'published')
      AND publish_at IS NOT NULL
  `;
  const params = [platform];
  if (brand_id !== undefined && brand_id !== null && brand_id !== '') {
    sql += ' AND brand_id = ?';
    params.push(brand_id);
  }
  const candidates = db.prepare(sql).all(...params);

  const matches = rows.map((row) => {
    if (row._skipped || !row.date) {
      return { row, post_id: null, post_copy_snippet: null, confidence: 'none', reason: row._skipReason || 'no_date' };
    }
    const scored = candidates
      .map((c) => ({ c, diff: dayDiff(row.date, c.publish_at.slice(0, 10)) }))
      .filter((x) => Math.abs(x.diff) <= 1);

    const exact = scored.filter((x) => x.diff === 0);
    const adjacent = scored.filter((x) => x.diff !== 0);

    const snippet = (copy) => (copy ? String(copy).slice(0, 80) : null);

    if (exact.length === 1) {
      return {
        row,
        post_id: exact[0].c.id,
        post_copy_snippet: snippet(exact[0].c.copy),
        confidence: 'exact',
      };
    }
    if (exact.length > 1 || (exact.length === 0 && adjacent.length > 1)) {
      const pool = exact.length > 0 ? exact : adjacent;
      return {
        row,
        post_id: null,
        post_copy_snippet: null,
        confidence: 'ambiguous',
        candidates: pool.map((x) => ({
          post_id: x.c.id,
          post_copy_snippet: snippet(x.c.copy),
          publish_at: x.c.publish_at,
        })),
      };
    }
    if (adjacent.length === 1) {
      return {
        row,
        post_id: adjacent[0].c.id,
        post_copy_snippet: snippet(adjacent[0].c.copy),
        confidence: 'adjacent',
      };
    }
    return { row, post_id: null, post_copy_snippet: null, confidence: 'none' };
  });

  return { matches };
}

// ---------- 4. applyImport ----------

// db: better-sqlite3 handle.
// decisions: [{post_id, metrics: {impressions, comments, shares, likes, clicks,
//   reach, results, engagement_rate, extra, notes, captured_at}}]
// Follows the same append-only insert semantics as POST /api/posts/:id/metrics
// (src/server.js) — one new metrics row per decision, no upsert/replace.
// Fields with no corresponding metrics-table column (likes, clicks, reach,
// results, engagement_rate, extra) are folded into `notes` as a JSON blob
// appended after any explicit notes text, so nothing from the export is lost.
function applyImport(db, decisions) {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    return { applied: 0 };
  }
  const insert = db.prepare(`
    INSERT INTO metrics (
      post_id, captured_at, impressions, comments, shares, saves,
      profile_visits, follows, dms, leads, call_booked, notes
    ) VALUES (
      @post_id, @captured_at, @impressions, @comments, @shares, @saves,
      @profile_visits, @follows, @dms, @leads, @call_booked, @notes
    )
  `);

  const postExists = db.prepare('SELECT id FROM posts WHERE id = ?');

  const run = db.transaction((items) => {
    let applied = 0;
    for (const d of items) {
      if (!d || !d.post_id) continue;
      if (!postExists.get(d.post_id)) continue;
      const m = d.metrics || {};
      const unmapped = {};
      for (const key of ['likes', 'clicks', 'reach', 'results', 'engagement_rate']) {
        if (m[key] !== undefined && m[key] !== null) unmapped[key] = m[key];
      }
      if (m.extra && Object.keys(m.extra).length) unmapped.extra = m.extra;
      const notesParts = [];
      if (m.notes) notesParts.push(String(m.notes));
      if (Object.keys(unmapped).length) notesParts.push(JSON.stringify(unmapped));
      insert.run({
        post_id: d.post_id,
        captured_at: m.captured_at || nowIso(),
        impressions: m.impressions ?? null,
        comments: m.comments ?? null,
        shares: m.shares ?? null,
        saves: m.saves ?? null,
        profile_visits: m.profile_visits ?? null,
        follows: m.follows ?? null,
        dms: m.dms ?? null,
        leads: m.leads ?? null,
        call_booked: m.call_booked ?? null,
        notes: notesParts.length ? notesParts.join(' | ') : null,
      });
      applied++;
    }
    return applied;
  });

  const applied = run(decisions);
  return { applied };
}

export { parseMetricsFile, normalizeRows, matchRows, applyImport, HEADER_SYNONYMS };
