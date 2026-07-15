// Analytics rollups (B7) — fed by the `metrics` table (manual entry, see
// SPEC.md "Analytics portal"). Pure functions of the DB; server.js exposes
// GET /api/analytics, and export.js pulls a 30-day summary per brand into
// social-state.json for the Agentic OS bridge.

import { getDb } from './db.js';

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Sum metrics for a brand (optionally scoped to a platform and/or a
 * captured_at window). engagement = comments + shares + saves (SPEC.md).
 */
function rollupFor(db, { brandId, platform, sinceIso, untilIso } = {}) {
  const clauses = [];
  const params = [];
  if (brandId != null) {
    clauses.push('p.brand_id = ?');
    params.push(brandId);
  }
  if (platform) {
    clauses.push('p.platform = ?');
    params.push(platform);
  }
  if (sinceIso) {
    clauses.push('m.captured_at >= ?');
    params.push(sinceIso);
  }
  if (untilIso) {
    clauses.push('m.captured_at < ?');
    params.push(untilIso);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = db
    .prepare(
      `
      SELECT
        COALESCE(SUM(m.impressions), 0) AS impressions,
        COALESCE(SUM(m.comments), 0) AS comments,
        COALESCE(SUM(m.shares), 0) AS shares,
        COALESCE(SUM(m.saves), 0) AS saves,
        COALESCE(SUM(m.follows), 0) AS follows,
        COALESCE(SUM(m.dms), 0) AS dms,
        COALESCE(SUM(m.leads), 0) AS leads,
        COALESCE(SUM(m.call_booked), 0) AS calls_booked
      FROM metrics m
      JOIN posts p ON p.id = m.post_id
      ${where}
    `
    )
    .get(...params);
  return { ...row, engagement: row.comments + row.shares + row.saves };
}

function postsPublishedCount(db, { brandId, sinceIso } = {}) {
  const clauses = [`p.status = 'published'`];
  const params = [];
  if (brandId != null) {
    clauses.push('p.brand_id = ?');
    params.push(brandId);
  }
  if (sinceIso) {
    clauses.push('p.updated_at >= ?');
    params.push(sinceIso);
  }
  return db.prepare(`SELECT COUNT(*) c FROM posts p WHERE ${clauses.join(' AND ')}`).get(...params).c;
}

function topPosts(db, { brandId, orderBy = 'impressions', limit = 10 } = {}) {
  const col = orderBy === 'leads' ? 'total_leads' : 'total_impressions';
  const clauses = [];
  const params = [];
  if (brandId != null) {
    clauses.push('p.brand_id = ?');
    params.push(brandId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(
      `
      SELECT p.id, p.brand_id, p.platform, p.copy, p.publish_at,
        COALESCE(SUM(m.impressions), 0) AS total_impressions,
        COALESCE(SUM(m.leads), 0) AS total_leads
      FROM posts p
      JOIN metrics m ON m.post_id = p.id
      ${where}
      GROUP BY p.id
      ORDER BY ${col} DESC
      LIMIT ?
    `
    )
    .all(...params, limit);
}

/** Published posts older than `hours` with zero metrics rows — the "nudge"
 * queue from SPEC.md's Analytics portal section. */
function metricsDue(db, { hours = 48 } = {}) {
  const cutoff = isoDaysAgo(hours / 24);
  return db
    .prepare(
      `
      SELECT p.id, p.brand_id, p.platform, p.copy, p.publish_at, p.updated_at
      FROM posts p
      LEFT JOIN metrics m ON m.post_id = p.id
      WHERE p.status = 'published' AND p.updated_at <= ?
      GROUP BY p.id
      HAVING COUNT(m.id) = 0
      ORDER BY p.updated_at
    `
    )
    .all(cutoff);
}

function deltaArrow(current, previous) {
  if (previous === 0 && current === 0) return 'flat';
  if (previous === 0) return 'up';
  const pct = (current - previous) / previous;
  if (pct > 0.01) return 'up';
  if (pct < -0.01) return 'down';
  return 'flat';
}

const ROLLUP_PLATFORMS = ['facebook', 'instagram', 'tiktok', 'reddit', 'twitter', 'linkedin', 'blog'];

function buildBrandAnalytics(db, brand) {
  const windows = { '7d': 7, '30d': 30, '90d': 90 };
  const totals = {};
  for (const [key, days] of Object.entries(windows)) {
    const sinceIso = isoDaysAgo(days);
    totals[key] = {
      ...rollupFor(db, { brandId: brand.id, sinceIso }),
      posts_published: postsPublishedCount(db, { brandId: brand.id, sinceIso }),
    };
  }
  totals.all_time = {
    ...rollupFor(db, { brandId: brand.id }),
    posts_published: postsPublishedCount(db, { brandId: brand.id }),
  };

  const by_platform = {};
  for (const platform of ROLLUP_PLATFORMS) {
    by_platform[platform] = rollupFor(db, { brandId: brand.id, platform, sinceIso: isoDaysAgo(30) });
  }

  const last7 = rollupFor(db, { brandId: brand.id, sinceIso: isoDaysAgo(7) });
  const prior7 = rollupFor(db, { brandId: brand.id, sinceIso: isoDaysAgo(14), untilIso: isoDaysAgo(7) });
  const week_over_week = {
    impressions: deltaArrow(last7.impressions, prior7.impressions),
    engagement: deltaArrow(last7.engagement, prior7.engagement),
    leads: deltaArrow(last7.leads, prior7.leads),
    current: last7,
    previous: prior7,
  };

  return {
    brand_id: brand.id,
    slug: brand.slug,
    name: brand.name,
    totals,
    by_platform,
    week_over_week,
    top10_by_impressions: topPosts(db, { brandId: brand.id, orderBy: 'impressions' }),
    top10_by_leads: topPosts(db, { brandId: brand.id, orderBy: 'leads' }),
  };
}

/** Full analytics payload for the dashboard's #/analytics view. */
function buildAnalytics(db = getDb()) {
  const brands = db.prepare('SELECT * FROM brands ORDER BY id').all();
  return {
    generated_at: new Date().toISOString(),
    brands: brands.map((b) => buildBrandAnalytics(db, b)),
    metrics_due: metricsDue(db),
  };
}

/** Compact 30-day summary for one brand — used by export.js's social-state. */
function build30dSummary(db, brandId) {
  const sinceIso = isoDaysAgo(30);
  const totals = rollupFor(db, { brandId, sinceIso });
  return {
    posts_published: postsPublishedCount(db, { brandId, sinceIso }),
    impressions: totals.impressions,
    engagement: totals.engagement,
    leads: totals.leads,
  };
}

export { buildAnalytics, build30dSummary, rollupFor, topPosts, metricsDue, isoDaysAgo, deltaArrow };
