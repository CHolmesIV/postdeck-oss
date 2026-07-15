// In-process Blotato worker (B4). Runs HANDOFF + VERIFY on a 5-minute
// setInterval, started from src/server.js. See SPEC.md "Worker" section.
//
// Safety: BLOTATO_DRY_RUN defaults ON (treat unset as on). Only an explicit
// '0' or 'false' disables it. In dry-run, blotato.js's real network functions
// are never called — the worker logs what it would submit and marks the post
// 'submitted_dry' instead of 'submitted'. This is a hard requirement for this
// build session: no real create/schedule/media-upload calls are allowed.

import { getDb, nowIso } from './db.js';
import * as blotato from './blotato.js';
import { exportSocialState } from './export.js';
import { syncSocialState } from './sync.js';
import { importCapturedIdeas } from './capture.js';
import { importGeneratedImages } from './imagestudio.js';
import { importResearchInbox } from './research.js';
import { recordUsage } from './usage.js';
import { getPlatformSpec } from './platforms.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_HANDOFF_ATTEMPTS = 3;
const MAX_VERIFY_ATTEMPTS = 6; // within the first hour after publish_at
const VERIFY_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_HANDOFF_WINDOW_HOURS = 48;

function isDryRun() {
  const v = process.env.BLOTATO_DRY_RUN;
  // default ON: unset, '1', 'true' (any case) => dry run. Only '0'/'false' disable it.
  if (v === undefined || v === null || v === '') return true;
  return !['0', 'false'].includes(String(v).toLowerCase());
}

function workerEnabled() {
  const v = process.env.POSTDECK_WORKER;
  // default ON: only '0'/'false' explicitly disables starting the worker.
  if (v === undefined || v === null || v === '') return true;
  return !['0', 'false'].includes(String(v).toLowerCase());
}

function getSetting(db, key, fallback) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

function setSettingIfMissing(db, key, value) {
  const existing = db.prepare('SELECT key FROM settings WHERE key = ?').get(key);
  if (!existing) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }
}

function getHandoffWindowHours(db) {
  setSettingIfMissing(db, 'handoff_window_hours', DEFAULT_HANDOFF_WINDOW_HOURS);
  return Number(getSetting(db, 'handoff_window_hours', DEFAULT_HANDOFF_WINDOW_HOURS));
}

function parseJsonColumn(value, fallback) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function summarize(text, len = 60) {
  if (!text) return '';
  return text.length > len ? `${text.slice(0, len)}...` : text;
}

function buildBlotatoPayload(post, account) {
  const media = parseJsonColumn(post.media, []);
  const platformFields = parseJsonColumn(post.platform_fields, {});
  const targetFields = account ? parseJsonColumn(account.target_fields, {}) : {};
  return {
    accountId: account ? account.blotato_account_id : null,
    content: {
      text: post.copy || '',
      mediaUrls: media.map((m) => m.url || m.path).filter(Boolean),
      platform: post.platform,
      additionalPosts: [],
      ...platformFields,
    },
    target: {
      targetType: targetFields.targetType || post.platform,
      ...targetFields,
    },
  };
}

/**
 * Run the HANDOFF phase for a single post row (used both by the interval
 * sweep and by the "submit now" route). Mutates the DB in place.
 * @param {import('better-sqlite3').Database} db
 * @param {object} post - full posts row
 * @returns {Promise<{ok: boolean, status: string, error?: string}>}
 */
async function handoffOne(db, post) {
  const account = post.account_id
    ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(post.account_id)
    : null;
  const payload = buildBlotatoPayload(post, account);
  const now = nowIso();

  if (isDryRun()) {
    console.log(
      `[worker][dry-run] would submit post ${post.id}: accountId=${payload.accountId} ` +
        `platform=${post.platform} target=${JSON.stringify(payload.target)} ` +
        `scheduledTime=${post.publish_at} content="${summarize(payload.content.text)}"`
    );
    db.prepare(
      `UPDATE posts SET status = 'submitted_dry', updated_at = @now WHERE id = @id`
    ).run({ now, id: post.id });
    recordUsage(db, { kind: 'blotato_submit', brand_id: post.brand_id, meta: { dry_run: true } });
    return { ok: true, status: 'submitted_dry' };
  }

  try {
    const media = parseJsonColumn(post.media, []);
    const uploadedUrls = [];
    for (const m of media) {
      const filePath = m.path || m.url;
      if (!filePath) continue;
      const uploaded = await blotato.uploadMedia(filePath);
      uploadedUrls.push(uploaded.url || uploaded.id);
    }
    if (uploadedUrls.length) {
      payload.content.mediaUrls = uploadedUrls;
    }

    const result = await blotato.createPost(
      { accountId: payload.accountId, content: payload.content, target: payload.target },
      post.publish_at
    );
    const submissionId =
      result.postSubmissionId ||
      result.submissionId ||
      result.postId ||
      result.id;

    db.prepare(
      `UPDATE posts SET status = 'submitted', blotato_submission_id = @sub_id,
       error_message = NULL, updated_at = @now WHERE id = @id`
    ).run({ sub_id: submissionId ? String(submissionId) : null, now, id: post.id });
    recordUsage(db, { kind: 'blotato_submit', brand_id: post.brand_id, meta: { dry_run: false } });

    return { ok: true, status: 'submitted' };
  } catch (err) {
    const retryable = err.retryable !== false;
    const retryCount = (post.retry_count || 0) + 1;

    if (!retryable || retryCount >= MAX_HANDOFF_ATTEMPTS) {
      db.prepare(
        `UPDATE posts SET status = 'failed', retry_count = @rc, error_message = @err,
         updated_at = @now WHERE id = @id`
      ).run({ rc: retryCount, err: err.message, now, id: post.id });
      return { ok: false, status: 'failed', error: err.message };
    }

    db.prepare(
      `UPDATE posts SET retry_count = @rc, error_message = @err, updated_at = @now WHERE id = @id`
    ).run({ rc: retryCount, err: err.message, now, id: post.id });
    return { ok: false, status: post.status, error: err.message };
  }
}

/**
 * B11: an account/platform is "assisted-manual" if `accounts.manual=1` OR
 * its platform is `blotato:false` in platform-specs (Reddit today, more
 * later — generalizes the old hardcoded `platform != 'reddit'` skip). The
 * worker must NEVER hand these off to Blotato; they stay in their current
 * status until the dashboard's "Post now"/"Mark posted" flow does it by
 * hand (see POST /api/posts/:id/mark-posted).
 */
function isAssistedManual(db, post) {
  const spec = getPlatformSpec(post.platform);
  if (spec && spec.blotato === false) return true;
  if (!post.account_id) return false;
  const account = db.prepare('SELECT manual FROM accounts WHERE id = ?').get(post.account_id);
  return !!(account && account.manual);
}

async function runHandoffPhase(db) {
  const windowHours = getHandoffWindowHours(db);
  const cutoff = new Date(Date.now() + windowHours * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM posts WHERE status = 'scheduled_local' AND publish_at IS NOT NULL
       AND publish_at <= ?`
    )
    .all(cutoff)
    .filter((post) => !isAssistedManual(db, post));
  for (const post of rows) {
    await handoffOne(db, post);
  }
  return rows.length;
}

/**
 * "Submit now" — run HANDOFF logic immediately for one post, ignoring the
 * handoff window. Used by POST /api/posts/:id/submit.
 */
async function submitNow(postId) {
  const db = getDb();
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post) return { ok: false, error: 'not_found' };
  if (isAssistedManual(db, post)) {
    return {
      ok: false,
      error: `${post.platform} is assisted-manual (not supported by Blotato / manual account) — use the "Mark posted" flow instead`,
    };
  }
  if (!['scheduled_local', 'approved'].includes(post.status)) {
    return { ok: false, error: `cannot submit post in status '${post.status}'` };
  }
  const result = await handoffOne(db, post);
  const updated = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  return { ...result, post: updated };
}

async function verifyOne(db, post) {
  if (isDryRun()) {
    // Nothing to verify against a real API in dry-run; dry-run posts stay
    // 'submitted_dry' until a human resets them. Skip silently.
    return;
  }
  try {
    const result = await blotato.getPostStatus(post.blotato_submission_id);
    const state = (result.status || result.state || '').toLowerCase();
    const now = nowIso();

    if (state === 'published' || state === 'success' || state === 'succeeded') {
      db.prepare(
        `UPDATE posts SET status = 'published', public_url = @url, error_message = NULL,
         updated_at = @now WHERE id = @id`
      ).run({ url: result.public_url || result.url || null, now, id: post.id });
      return;
    }
    if (state === 'failed' || state === 'error') {
      db.prepare(
        `UPDATE posts SET status = 'failed', error_message = @err, updated_at = @now WHERE id = @id`
      ).run({ err: result.errorMessage || result.error || 'publish failed', now, id: post.id });
      return;
    }

    // Still pending — bump verify_attempts, and give up after the window/attempt cap.
    const attempts = (post.verify_attempts || 0) + 1;
    const publishAtMs = post.publish_at ? Date.parse(post.publish_at) : Date.now();
    const withinWindow = Date.now() - publishAtMs <= VERIFY_WINDOW_MS;

    if (attempts >= MAX_VERIFY_ATTEMPTS || !withinWindow) {
      db.prepare(
        `UPDATE posts SET status = 'failed_verify', verify_attempts = @va, updated_at = @now WHERE id = @id`
      ).run({ va: attempts, now, id: post.id });
    } else {
      db.prepare(
        `UPDATE posts SET verify_attempts = @va, updated_at = @now WHERE id = @id`
      ).run({ va: attempts, now, id: post.id });
    }
  } catch (err) {
    const attempts = (post.verify_attempts || 0) + 1;
    const now = nowIso();
    if (attempts >= MAX_VERIFY_ATTEMPTS) {
      db.prepare(
        `UPDATE posts SET status = 'failed_verify', verify_attempts = @va, error_message = @err,
         updated_at = @now WHERE id = @id`
      ).run({ va: attempts, err: err.message, now, id: post.id });
    } else {
      db.prepare(
        `UPDATE posts SET verify_attempts = @va, error_message = @err, updated_at = @now WHERE id = @id`
      ).run({ va: attempts, err: err.message, now, id: post.id });
    }
  }
}

async function runVerifyPhase(db) {
  const now = nowIso();
  const rows = db
    .prepare(`SELECT * FROM posts WHERE status = 'submitted' AND publish_at IS NOT NULL AND publish_at < ?`)
    .all(now);
  for (const post of rows) {
    await verifyOne(db, post);
  }
  return rows.length;
}

// ---------- worker status (for the dashboard, step 5) ----------
const status = {
  lastRunAt: null,
  nextRunAt: null,
  lastExportAt: null,
  dryRun: isDryRun(),
  enabled: workerEnabled(),
};

function getWorkerStatus() {
  return { ...status, dryRun: isDryRun(), enabled: workerEnabled() };
}

let lastExportAtMs = 0;

/**
 * Export social-state.json + rsync it to the VPS. Runs on every
 * state-changing cycle, and forced (regardless of change) at least once an
 * hour — see SPEC.md worker item 3.
 */
async function runExportPhase(db, { changed }) {
  const now = Date.now();
  const dueHourly = now - lastExportAtMs >= ONE_HOUR_MS;
  if (!changed && !dueHourly) return;
  try {
    exportSocialState(db);
    lastExportAtMs = now;
    status.lastExportAt = nowIso();
    await syncSocialState();
  } catch (err) {
    console.error('[worker] export/sync error', err);
  }
}

async function runCycle() {
  const db = getDb();
  status.lastRunAt = nowIso();
  let handoffCount = 0;
  let verifyCount = 0;
  try {
    handoffCount = await runHandoffPhase(db);
    verifyCount = await runVerifyPhase(db);
  } catch (err) {
    console.error('[worker] cycle error', err);
  }

  try {
    importCapturedIdeas(db);
  } catch (err) {
    console.error('[worker] capture import error', err);
  }

  let generatedImageIds = [];
  try {
    generatedImageIds = importGeneratedImages(db) || [];
    for (const requestId of generatedImageIds) {
      const row = db.prepare('SELECT * FROM image_requests WHERE id = ?').get(requestId);
      recordUsage(db, { kind: 'image_generated', brand_id: row ? row.brand_id : null, meta: { request_id: requestId } });
    }
  } catch (err) {
    console.error('[worker] image import error', err);
  }

  try {
    importResearchInbox(db);
  } catch (err) {
    console.error('[worker] research import error', err);
  }

  const changed = handoffCount > 0 || verifyCount > 0 || generatedImageIds.length > 0;
  await runExportPhase(db, { changed });

  status.nextRunAt = new Date(Date.now() + FIVE_MINUTES_MS).toISOString();
}

let intervalHandle = null;

function startWorker() {
  if (!workerEnabled()) {
    console.log('[worker] POSTDECK_WORKER disabled — not starting');
    return null;
  }
  if (intervalHandle) return intervalHandle;
  console.log(
    `[worker] starting — every ${FIVE_MINUTES_MS / 60000}min, dryRun=${isDryRun()}`
  );
  // Kick one cycle off shortly after boot, then every 5 minutes.
  runCycle();
  intervalHandle = setInterval(runCycle, FIVE_MINUTES_MS);
  status.nextRunAt = new Date(Date.now() + FIVE_MINUTES_MS).toISOString();
  return intervalHandle;
}

function stopWorker() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export {
  startWorker,
  stopWorker,
  runCycle,
  runHandoffPhase,
  runVerifyPhase,
  handoffOne,
  verifyOne,
  submitNow,
  getWorkerStatus,
  isDryRun,
  workerEnabled,
  getHandoffWindowHours,
  runExportPhase,
  isAssistedManual,
};
