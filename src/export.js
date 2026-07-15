// State export (B5). Builds a compact snapshot of the social schedule and
// writes it to state/social-state.json. Consumed by the Agentic OS bridge
// (rsync via src/sync.js) - see SPEC.md "Worker" item 3 and
// "Idea capture from the road". This file is also runnable directly:
//   node src/export.js
// which builds + writes the state once and prints the path.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, nowIso } from './db.js';
import { isDryRun, getWorkerStatus } from './worker.js';
import { build30dSummary } from './analytics.js';
import { usageSummaryForExport } from './usage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = process.env.POSTDECK_STATE_DIR || path.join(ROOT, 'state');
const STATE_FILE = path.join(STATE_DIR, 'social-state.json');

const NEXT_14_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const LAST_7_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function hookFromCopy(copy) {
  if (!copy) return '';
  const text = String(copy).trim();
  return text.length > 80 ? `${text.slice(0, 80)}` : text;
}

/**
 * Build the social-state object described in SPEC.md's worker/export section.
 * Pure function of the DB - no I/O side effects beyond the read queries.
 * @param {import('better-sqlite3').Database} [db]
 */
function buildSocialState(db = getDb()) {
  const now = new Date();
  const nowIsoStr = now.toISOString();
  const in14Days = new Date(now.getTime() + NEXT_14_DAYS_MS).toISOString();
  const last7Days = new Date(now.getTime() - LAST_7_DAYS_MS).toISOString();

  const brands = db.prepare('SELECT * FROM brands ORDER BY id').all();

  const brandStates = brands.map((brand) => {
    const upcoming = db
      .prepare(
        `
        SELECT publish_at, platform, status, copy
        FROM posts
        WHERE brand_id = ?
          AND publish_at IS NOT NULL
          AND publish_at >= ?
          AND publish_at <= ?
        ORDER BY publish_at
      `
      )
      .all(brand.id, nowIsoStr, in14Days);

    const next_14_days = upcoming.map((p) => ({
      publish_at: p.publish_at,
      platform: p.platform,
      status: p.status,
      hook: hookFromCopy(p.copy),
    }));

    const draft = db
      .prepare(`SELECT COUNT(*) c FROM posts WHERE brand_id = ? AND status = 'draft'`)
      .get(brand.id).c;
    const approved = db
      .prepare(`SELECT COUNT(*) c FROM posts WHERE brand_id = ? AND status = 'approved'`)
      .get(brand.id).c;
    const scheduled_local = db
      .prepare(`SELECT COUNT(*) c FROM posts WHERE brand_id = ? AND status = 'scheduled_local'`)
      .get(brand.id).c;
    const submitted = db
      .prepare(
        `SELECT COUNT(*) c FROM posts WHERE brand_id = ? AND status IN ('submitted', 'submitted_dry')`
      )
      .get(brand.id).c;
    const published_last_7d = db
      .prepare(
        `SELECT COUNT(*) c FROM posts WHERE brand_id = ? AND status = 'published' AND updated_at >= ?`
      )
      .get(brand.id, last7Days).c;
    const failed = db
      .prepare(
        `SELECT COUNT(*) c FROM posts WHERE brand_id = ? AND status IN ('failed', 'failed_verify')`
      )
      .get(brand.id).c;

    return {
      slug: brand.slug,
      next_14_days,
      counts: {
        draft,
        approved,
        scheduled_local,
        submitted,
        published_last_7d,
        failed,
      },
      analytics_30d: build30dSummary(db, brand.id),
    };
  });

  const failureRows = db
    .prepare(
      `SELECT id AS post_id, platform, error_message FROM posts WHERE status IN ('failed', 'failed_verify') ORDER BY updated_at DESC`
    )
    .all();
  const failures = failureRows.map((r) => ({
    post_id: r.post_id,
    platform: r.platform,
    error_message: r.error_message || null,
  }));

  let lastWorkerRun = null;
  try {
    lastWorkerRun = getWorkerStatus().lastRunAt || null;
  } catch {
    lastWorkerRun = null;
  }

  let usage = null;
  try {
    usage = usageSummaryForExport(db);
  } catch {
    usage = null;
  }

  return {
    generated_at: nowIsoStr,
    dry_run_mode: isDryRun(),
    brands: brandStates,
    failures,
    last_worker_run: lastWorkerRun,
    usage,
  };
}

/**
 * Build + write state/social-state.json. Returns {state, path}.
 */
function exportSocialState(db = getDb()) {
  const state = buildSocialState(db);
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return { state, path: STATE_FILE };
}

export { buildSocialState, exportSocialState, STATE_FILE, STATE_DIR };

// CLI entrypoint: `node src/export.js`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const { path: written } = exportSocialState();
  console.log(`[export] wrote ${written}`);
}
