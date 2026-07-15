// Usage/ops-stats rollups (B8 — SPEC.md "Ops-stats tab"). Pure functions of
// the DB (except recordUsage, which appends one row). server.js exposes
// GET /api/usage; export.js pulls a compact summary into social-state.json.

import { getDb, nowIso } from './db.js';

const POST_STATUSES = [
  'draft',
  'approved',
  'scheduled_local',
  'submitted',
  'submitted_dry',
  'published',
  'failed',
  'canceled',
];

const USAGE_KINDS = ['ai_draft', 'copy_assist', 'blotato_submit', 'image_request', 'image_generated', 'agent', 'agent_publish'];

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Append a usage_events row. Returns the inserted row. */
function recordUsage(db, { kind, brand_id = null, meta = {} } = {}) {
  const created_at = nowIso();
  const info = db
    .prepare(
      `INSERT INTO usage_events (kind, brand_id, meta, created_at) VALUES (?, ?, ?, ?)`
    )
    .run(kind, brand_id, JSON.stringify(meta ?? {}), created_at);
  return db.prepare('SELECT * FROM usage_events WHERE id = ?').get(info.lastInsertRowid);
}

function postsByStatus(db) {
  const rows = db.prepare('SELECT status, COUNT(*) c FROM posts GROUP BY status').all();
  const out = {};
  for (const status of POST_STATUSES) out[status] = 0;
  for (const row of rows) {
    out[row.status] = row.c;
  }
  return out;
}

function postsByBrand(db) {
  return db
    .prepare(
      `
      SELECT p.brand_id AS brand_id, b.name AS brand_name, COUNT(*) AS count
      FROM posts p
      LEFT JOIN brands b ON b.id = p.brand_id
      GROUP BY p.brand_id
      ORDER BY count DESC
    `
    )
    .all();
}

function postsByPlatform(db) {
  return db
    .prepare('SELECT platform, COUNT(*) AS count FROM posts GROUP BY platform ORDER BY count DESC')
    .all();
}

function contentTypeMix(db) {
  const rows = db
    .prepare(
      `SELECT COALESCE(content_type, 'unset') AS content_type, COUNT(*) AS count
       FROM posts GROUP BY COALESCE(content_type, 'unset') ORDER BY count DESC`
    )
    .all();
  return rows;
}

function scheduledThisWeek(db) {
  const now = nowIso();
  const in7Days = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  return db
    .prepare(
      `
      SELECT COUNT(*) c FROM posts
      WHERE status IN ('approved', 'scheduled_local', 'submitted')
        AND publish_at IS NOT NULL
        AND publish_at >= ?
        AND publish_at <= ?
    `
    )
    .get(now, in7Days).c;
}

function draftsAwaiting(db) {
  return db.prepare(`SELECT COUNT(*) c FROM posts WHERE status = 'draft'`).get().c;
}

function publishedThisMonth(db) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const nextMonthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  ).toISOString();
  return db
    .prepare(
      `
      SELECT COUNT(*) c FROM posts
      WHERE status = 'published'
        AND COALESCE(publish_at, updated_at) >= ?
        AND COALESCE(publish_at, updated_at) < ?
    `
    )
    .get(monthStart, nextMonthStart).c;
}

function publishedAllTime(db) {
  return db.prepare(`SELECT COUNT(*) c FROM posts WHERE status = 'published'`).get().c;
}

function usageCounts(db, { sinceIso } = {}) {
  const clauses = [];
  const params = [];
  if (sinceIso) {
    clauses.push('created_at >= ?');
    params.push(sinceIso);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db
    .prepare(`SELECT kind, COUNT(*) AS count FROM usage_events ${where} GROUP BY kind`)
    .all(...params);
  const out = {};
  for (const kind of USAGE_KINDS) out[kind] = 0;
  for (const row of rows) {
    out[row.kind] = row.count;
  }
  return out;
}

/** Full ops-stats payload for the dashboard's #/ops view. */
function buildUsageStats(db = getDb()) {
  return {
    posts_by_status: postsByStatus(db),
    posts_by_brand: postsByBrand(db),
    posts_by_platform: postsByPlatform(db),
    content_type_mix: contentTypeMix(db),
    scheduled_this_week: scheduledThisWeek(db),
    drafts_awaiting: draftsAwaiting(db),
    published_this_month: publishedThisMonth(db),
    published_all_time: publishedAllTime(db),
    usage_counts: usageCounts(db),
    usage_last_7d: usageCounts(db, { sinceIso: isoDaysAgo(7) }),
    generated_at: nowIso(),
  };
}

/** Compact usage subset for export.js's social-state (AOS digest). */
function usageSummaryForExport(db = getDb()) {
  return {
    drafts_awaiting: draftsAwaiting(db),
    scheduled_this_week: scheduledThisWeek(db),
    published_this_month: publishedThisMonth(db),
    usage_last_7d: usageCounts(db, { sinceIso: isoDaysAgo(7) }),
  };
}

export { recordUsage, buildUsageStats, usageSummaryForExport, POST_STATUSES, USAGE_KINDS };
