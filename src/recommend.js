// Content-type recommender (B8 — SPEC.md "Content-type picker + recommender").
// Pure/heuristic — no AI call. Ranks content_type by the brand's own metrics
// when they exist (basis: 'own_metrics'), else falls back to small,
// hand-encoded platform best-practice defaults (basis: 'best_practice').
// content_type in {static, carousel, image, text, video} — see db.js v4
// migration (posts.content_type).

const CONTENT_TYPES = ['static', 'carousel', 'image', 'text', 'video'];

// Best-practice fallback rankings per platform — CB's own judgment call
// encoded from platform-specs.json notes (SPEC.md B8 feature 2). Order is
// best-first; anything omitted is appended afterward in CONTENT_TYPES order.
const BEST_PRACTICE_DEFAULTS = {
  instagram: {
    order: ['carousel', 'image', 'video', 'static', 'text'],
    reason: 'Carousels drive saves/comments; reels drive non-follower reach (platform-specs.json notes).',
  },
  tiktok: {
    order: ['video', 'image', 'carousel', 'static', 'text'],
    reason: 'TikTok is a video-first platform; native-shot video beats every other format.',
  },
  twitter: {
    order: ['text', 'image', 'video', 'carousel', 'static'],
    reason: 'Text/thread posts with embedded media get rewarded on X; frequency matters more than format.',
  },
  linkedin: {
    order: ['carousel', 'text', 'image', 'video', 'static'],
    reason: 'LinkedIn carousels (document posts) and text posts outperform static images for reach.',
  },
  facebook: {
    order: ['image', 'video', 'carousel', 'text', 'static'],
    reason: 'Native image/video posts outperform link posts; all FB video shares as Reels since mid-2025.',
  },
  reddit: {
    order: ['text', 'image', 'static', 'carousel', 'video'],
    reason: 'Reddit is assisted-manual and text-self-post-first; low-effort promo formats get removed.',
  },
  blog: {
    order: ['text', 'image', 'static', 'carousel', 'video'],
    reason: 'Long-form text is the blog channel format; images are supporting hero/inline assets.',
  },
};

const DEFAULT_FALLBACK = {
  order: ['image', 'carousel', 'video', 'text', 'static'],
  reason: 'No platform-specific best-practice data — generic default ordering.',
};

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Per-content_type average engagement (comments+shares+saves, same
 * definition as analytics.js) for a brand, optionally scoped to a platform.
 * Only counts posts that have at least one metrics row.
 */
function ownMetricsRanking(db, { brand_id, platform } = {}) {
  const clauses = ['p.brand_id = ?', "p.content_type IS NOT NULL"];
  const params = [brand_id];
  if (platform) {
    clauses.push('p.platform = ?');
    params.push(platform);
  }
  const where = clauses.join(' AND ');
  const rows = db
    .prepare(
      `
      SELECT p.content_type AS content_type,
        COUNT(DISTINCT p.id) AS post_count,
        COALESCE(SUM(m.comments), 0) + COALESCE(SUM(m.shares), 0) + COALESCE(SUM(m.saves), 0) AS total_engagement
      FROM posts p
      JOIN metrics m ON m.post_id = p.id
      WHERE ${where}
      GROUP BY p.content_type
    `
    )
    .all(...params);

  if (!rows.length) return null;

  return rows
    .map((r) => ({
      content_type: r.content_type,
      score: r.post_count > 0 ? Number((r.total_engagement / r.post_count).toFixed(2)) : 0,
      post_count: r.post_count,
      reason: `Averages ${r.post_count > 0 ? (r.total_engagement / r.post_count).toFixed(1) : 0} engagement (comments+shares+saves) across ${r.post_count} of this brand's own post${r.post_count === 1 ? '' : 's'}.`,
    }))
    .sort((a, b) => b.score - a.score);
}

function bestPracticeRanking(platform) {
  const def = BEST_PRACTICE_DEFAULTS[platform] || DEFAULT_FALLBACK;
  const ordered = [...def.order, ...CONTENT_TYPES.filter((ct) => !def.order.includes(ct))];
  return ordered.map((content_type, idx) => ({
    content_type,
    score: ordered.length - idx,
    reason: idx === 0 ? def.reason : `Best-practice default ordering for ${platform || 'this platform'} (rank ${idx + 1}).`,
  }));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{brand_id: number, pillar?: string, platform?: string}} params
 * @returns {{suggestion: string, ranked: Array<{content_type: string, score: number, reason: string}>, basis: 'own_metrics'|'best_practice'}}
 */
function recommendContentType(db, { brand_id, pillar, platform } = {}) {
  const ownRanked = brand_id != null ? ownMetricsRanking(db, { brand_id, platform }) : null;

  if (ownRanked && ownRanked.length) {
    return {
      suggestion: ownRanked[0].content_type,
      ranked: ownRanked,
      basis: 'own_metrics',
    };
  }

  const ranked = bestPracticeRanking(platform);
  return {
    suggestion: ranked[0].content_type,
    ranked,
    basis: 'best_practice',
  };
}

export { recommendContentType, ownMetricsRanking, bestPracticeRanking, CONTENT_TYPES, BEST_PRACTICE_DEFAULTS, isoDaysAgo };
