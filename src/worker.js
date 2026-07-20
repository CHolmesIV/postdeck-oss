// In-process Blotato worker (B4). Runs HANDOFF + VERIFY on a 5-minute
// setInterval, started from src/server.js. See SPEC.md "Worker" section.
//
// Safety: BLOTATO_DRY_RUN defaults ON (treat unset as on). Only an explicit
// '0' or 'false' disables it. In dry-run, blotato.js's real network functions
// are never called — the worker logs what it would submit and marks the post
// 'submitted_dry' instead of 'submitted'. This is a hard requirement for this
// build session: no real create/schedule/media-upload calls are allowed.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getDb, nowIso } from './db.js';
import * as blotato from './blotato.js';
import { exportSocialState } from './export.js';
import { syncSocialState } from './sync.js';
import { importCapturedIdeas } from './capture.js';
import { importGeneratedImages } from './imagestudio.js';
import { importResearchInbox } from './research.js';
import { recordUsage } from './usage.js';
import { getPlatformSpec } from './platforms.js';
import { fitImageForPlatform } from './imagefit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|tiff?|bmp)$/i;

function getMediaDir() {
  return process.env.POSTDECK_MEDIA_DIR || path.join(ROOT, 'media');
}

/** Resolve a stored media path/url (e.g. "media/123-file.png" or
 * "/media/123-file.png") to an absolute path under the media dir. Confines
 * to the basename (same defensive approach as server.js's resolveMediaPath)
 * so a malformed stored value can never escape media/. */
function resolveMediaAbsPath(relOrPath) {
  if (!relOrPath || typeof relOrPath !== 'string') return null;
  return path.join(getMediaDir(), path.basename(relOrPath));
}

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

/**
 * Handoff-time platform-fit substitution (imagefit.js). For every image in
 * `post.media`, if a `_fit_<platform>` derivative already exists it's used;
 * if not, it's generated right here (fitImageForPlatform caches the result
 * as a sibling file, so this is a one-time cost per source+platform). This
 * catches every image at the payload-construction choke point — not just
 * ones that came through the Codex handoff — so a manually-attached photo
 * gets the same oversized/wrong-format protection. Never blocks the
 * handoff: any fit error just falls back to the original media url/path.
 */
async function buildBlotatoPayload(post, account) {
  const media = parseJsonColumn(post.media, []);
  const platformFields = parseJsonColumn(post.platform_fields, {});
  const targetFields = account ? parseJsonColumn(account.target_fields, {}) : {};

  const mediaUrls = [];
  for (const m of media) {
    const rawPath = m.path || m.url;
    if (!rawPath) continue;
    const absPath = resolveMediaAbsPath(rawPath);
    if (absPath && IMAGE_EXT_RE.test(absPath) && fs.existsSync(absPath)) {
      try {
        const fit = await fitImageForPlatform(absPath, post.platform);
        if (fit && fit.path && !fit.skipped) {
          if (fit.actions && fit.actions.length && fit.actions[0] !== 'cached') {
            console.log(
              `[worker] media fit for post ${post.id} (${post.platform}): ${fit.actions.join(', ')} -> ${fit.path}`
            );
          }
          mediaUrls.push(`/${fit.path}`);
          continue;
        }
      } catch (err) {
        console.error(`[worker] media fit failed for post ${post.id} (${post.platform}): ${err.message}`);
      }
    }
    mediaUrls.push(m.url || m.path);
  }

  // "Link in first comment": Blotato's additionalPosts only auto-chains on
  // twitter/bluesky/threads (verified against help.blotato.com llms-full.txt
  // 2026-07-19; entries are FLAT {text, mediaUrls}, platform inherited from
  // the parent content). For those platforms we attach it. For everything
  // else (linkedin/facebook etc.) the comment stays stored on the post and
  // the dashboard surfaces it as a paste-after-publish reminder instead —
  // never send an additionalPosts the API doesn't support.
  const THREADABLE = ['twitter', 'bluesky', 'threads'];
  const additionalPosts = [];
  if (
    post.first_comment &&
    String(post.first_comment).trim() &&
    THREADABLE.includes(post.platform)
  ) {
    additionalPosts.push({ text: post.first_comment, mediaUrls: [] });
  }

  return {
    accountId: account ? account.blotato_account_id : null,
    content: {
      text: post.copy || '',
      mediaUrls,
      platform: post.platform,
      additionalPosts,
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
  const payload = await buildBlotatoPayload(post, account);
  const now = nowIso();

  if (isDryRun()) {
    console.log(
      `[worker][dry-run] would submit post ${post.id}: accountId=${payload.accountId} ` +
        `platform=${post.platform} target=${JSON.stringify(payload.target)} ` +
        `scheduledTime=${post.publish_at} content="${summarize(payload.content.text)}"`
    );
    db.prepare(
      `UPDATE posts SET status = 'submitted_dry', error_message = NULL, updated_at = @now WHERE id = @id`
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

// Computer-was-off catch-up: a scheduled_local post whose publish_at is
// already in the past when the handoff sweep finally runs must NOT be
// silently blasted out late. Flag it instead (no schema change — reuses
// error_message) and leave it in scheduled_local for human review. An
// explicit submitNow() call still bypasses this and clears the flag.
const MISSED_WINDOW_MSG =
  'missed_window: computer was off past the publish time - review and resend';

function isMissedWindow(post) {
  return post.status === 'scheduled_local' && post.publish_at && Date.parse(post.publish_at) < Date.now();
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
  let handoffCount = 0;
  for (const post of rows) {
    if (isMissedWindow(post)) {
      if (post.error_message !== MISSED_WINDOW_MSG) {
        db.prepare(`UPDATE posts SET error_message = @msg, updated_at = @now WHERE id = @id`).run({
          msg: MISSED_WINDOW_MSG,
          now: nowIso(),
          id: post.id,
        });
      }
      continue;
    }
    await handoffOne(db, post);
    handoffCount += 1;
  }
  return handoffCount;
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

/**
 * B-batch: resolve which posts are eligible for a bulk submit, either from
 * an explicit list of post_ids or a scope window (from/to ISO + optional
 * brand_id/platform). Mirrors submitNow's eligibility rules (status +
 * assisted-manual + publish_at) so a post that would be rejected by
 * POST /api/posts/:id/submit is never silently "submitted" in a batch.
 * @returns {{ eligible: object[], skipped: {id:number, reason:string}[] }}
 */
function resolveBatchCandidates(db, { post_ids, scope }) {
  if (post_ids && post_ids.length) {
    return post_ids.map((id) => ({ id, post: db.prepare('SELECT * FROM posts WHERE id = ?').get(id) }));
  }
  const { from, to, brand_id, platform } = scope || {};
  let sql = `SELECT * FROM posts WHERE status IN ('scheduled_local', 'approved')
             AND publish_at IS NOT NULL AND publish_at >= ? AND publish_at <= ?`;
  const params = [from, to];
  if (brand_id) {
    sql += ' AND brand_id = ?';
    params.push(brand_id);
  }
  if (platform) {
    sql += ' AND platform = ?';
    params.push(platform);
  }
  const rows = db.prepare(sql).all(...params);
  return rows.map((post) => ({ id: post.id, post }));
}

function resolveBatch(db, { post_ids, scope }) {
  const candidates = resolveBatchCandidates(db, { post_ids, scope });
  const eligible = [];
  const skipped = [];
  for (const { id, post } of candidates) {
    if (!post) {
      skipped.push({ id, reason: 'wrong_status' });
      continue;
    }
    if (isAssistedManual(db, post)) {
      skipped.push({ id, reason: 'manual' });
      continue;
    }
    if (!['scheduled_local', 'approved'].includes(post.status)) {
      skipped.push({ id, reason: 'wrong_status' });
      continue;
    }
    if (!post.publish_at) {
      skipped.push({ id, reason: 'no_publish_at' });
      continue;
    }
    // A batch (bulk, not an explicit per-post human click) must never push a
    // late scheduled_local post through — same rule as the background worker
    // sweep. Explicit POST /api/posts/:id/submit still bypasses this.
    if (isMissedWindow(post)) {
      skipped.push({ id, reason: 'missed_window' });
      continue;
    }
    // Window filter only applies to scope-based resolution — an explicit
    // post_ids list is an intentional override of the time window.
    if (!post_ids && scope) {
      const ms = Date.parse(post.publish_at);
      const fromMs = Date.parse(scope.from);
      const toMs = Date.parse(scope.to);
      if (Number.isFinite(fromMs) && Number.isFinite(toMs) && (ms < fromMs || ms > toMs)) {
        skipped.push({ id, reason: 'wrong_status' });
        continue;
      }
    }
    eligible.push(post);
  }
  return { eligible, skipped };
}

/**
 * Runs handoffOne SEQUENTIALLY (never Promise.all — Blotato rate safety)
 * over the eligible set from resolveBatch, never throwing on a single-post
 * failure. Used by POST /api/posts/submit-batch.
 */
async function runSubmitBatch(db, { post_ids, scope }) {
  const { eligible, skipped } = resolveBatch(db, { post_ids, scope });
  const submitted = [];
  const failed = [];
  for (const post of eligible) {
    try {
      const result = await handoffOne(db, post);
      if (result.ok) {
        const fresh = db.prepare('SELECT blotato_submission_id FROM posts WHERE id = ?').get(post.id);
        submitted.push({ id: post.id, submission_id: fresh ? fresh.blotato_submission_id : null });
      } else {
        failed.push({ id: post.id, error: result.error || 'submit_failed' });
      }
    } catch (err) {
      failed.push({ id: post.id, error: err.message });
    }
  }
  return {
    attempted: eligible.length,
    submitted,
    skipped,
    failed,
    dry_run: isDryRun(),
  };
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
      // Pre-generate the platform-fit derivative for every platform this
      // request targeted, right after import — so by the time these images
      // reach the composer/handoff, the fit derivatives are already cached
      // (see fitImageForPlatform's cache check + the handoff substitution
      // above, which also covers non-Codex images generated on the fly).
      try {
        const platforms = parseJsonColumn(row?.platforms, []);
        const variants = parseJsonColumn(row?.variants, []);
        for (const variant of variants) {
          const absPath = resolveMediaAbsPath(variant?.path);
          if (!absPath || !IMAGE_EXT_RE.test(absPath) || !fs.existsSync(absPath)) continue;
          for (const platform of platforms) {
            try {
              const fit = await fitImageForPlatform(absPath, platform);
              if (fit.actions && fit.actions.length && fit.actions[0] !== 'cached') {
                console.log(`[worker] pre-fit image_request #${requestId} variant for ${platform}: ${fit.actions.join(', ')}`);
              }
            } catch (err) {
              console.error(`[worker] pre-fit failed for image_request #${requestId} platform ${platform}: ${err.message}`);
            }
          }
        }
      } catch (err) {
        console.error(`[worker] pre-fit sweep error for image_request #${requestId}: ${err.message}`);
      }
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

  return {
    handoffCount,
    verifyCount,
    imagesImported: generatedImageIds.length,
    changed,
    ranAt: status.lastRunAt,
  };
}

// Guards POST /api/worker/run-now against overlapping with either the
// 5-minute interval tick or another concurrent run-now call — runCycle
// mutates shared DB state (retry_count, verify_attempts, etc.) and is not
// safe to run twice at once.
let cycleInFlight = null;

async function runCycleNow() {
  if (cycleInFlight) return { busy: true };
  cycleInFlight = runCycle();
  try {
    const summary = await cycleInFlight;
    return { busy: false, summary };
  } finally {
    cycleInFlight = null;
  }
}

let intervalHandle = null;
let startupTimeoutHandle = null;

// Delay before the startup catch-up sweep (default 3s after boot). Test-only
// override so tests don't have to wait out a real 3s timer.
const STARTUP_DELAY_MS = Number(process.env.POSTDECK_WORKER_STARTUP_DELAY_MS) || 3000;

function startWorker() {
  if (!workerEnabled()) {
    console.log('[worker] POSTDECK_WORKER disabled — not starting');
    return null;
  }
  if (intervalHandle) return intervalHandle;
  console.log(
    `[worker] starting — every ${FIVE_MINUTES_MS / 60000}min, dryRun=${isDryRun()}`
  );
  // Computer-was-off catch-up: run one full cycle a few seconds after boot
  // (not waiting for the first 5-min tick), so posts that were due while the
  // machine was asleep/off get picked up promptly. Goes through runCycleNow
  // so it shares the overlap guard with run-now/the interval tick.
  startupTimeoutHandle = setTimeout(() => {
    startupTimeoutHandle = null;
    runCycleNow();
  }, STARTUP_DELAY_MS);
  intervalHandle = setInterval(runCycleNow, FIVE_MINUTES_MS);
  status.nextRunAt = new Date(Date.now() + FIVE_MINUTES_MS).toISOString();
  return intervalHandle;
}

function stopWorker() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  if (startupTimeoutHandle) {
    clearTimeout(startupTimeoutHandle);
    startupTimeoutHandle = null;
  }
}

export {
  startWorker,
  stopWorker,
  runCycle,
  runCycleNow,
  runHandoffPhase,
  runVerifyPhase,
  handoffOne,
  verifyOne,
  buildBlotatoPayload,
  submitNow,
  resolveBatch,
  runSubmitBatch,
  getWorkerStatus,
  isDryRun,
  workerEnabled,
  getHandoffWindowHours,
  runExportPhase,
  isAssistedManual,
  isMissedWindow,
  MISSED_WINDOW_MSG,
};
