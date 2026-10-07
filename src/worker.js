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
import { getDb, nowIso, DB_PATH } from './db.js';
import os from 'node:os';
import * as blotato from './blotato.js';
import { exportSocialState } from './export.js';
import { syncSocialState } from './sync.js';
import { importCapturedIdeas } from './capture.js';
import { importGeneratedImages } from './imagestudio.js';
import { importResearchInbox } from './research.js';
import { recordUsage } from './usage.js';
import { getPlatformSpec } from './platforms.js';
import { fitImageForPlatform } from './imagefit.js';
import { normalizeIso, toMs } from './time.js';
import { runBlogPhase } from './blog.js';
import { runWebPhase } from './web.js';

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
// Verify (audit T2): Blotato's LinkedIn queue sometimes reports 'in-progress'
// for well over 25 minutes, so give-up is measured from the FIRST verify poll
// (posts.verify_started_at), not from publish_at, and only after 24h. Poll
// every cycle (5 min) for the first hour, then at most every 30 min.
const VERIFY_GIVE_UP_MS = 24 * 60 * 60 * 1000;
const VERIFY_FAST_PHASE_MS = ONE_HOUR_MS;
const VERIFY_SLOW_POLL_MS = 30 * 60 * 1000;
const VERIFY_POLL_SLACK_MS = 60 * 1000; // cycle jitter
// A scheduled_local post is only "missed" once publish_at is this far past (T7);
// anything inside the grace is still handed off.
const MISSED_WINDOW_GRACE_MS = 15 * 60 * 1000;
// Approving a post due within this long hands it off right away (T7) instead of
// waiting for the next 5-minute sweep to notice it.
const IMMEDIATE_HANDOFF_MS = 10 * 60 * 1000;
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
// Audit S2: posts currently mid-handoff. submitNow() (a click), publish-now,
// submit-batch and the 5-minute sweep can all reach handoffOne for the same
// row; each read the status, then `await`ed image-fit + network work, then
// wrote - so two of them could both see 'scheduled_local' and both call
// Blotato. Single process, so an in-memory claim set is a complete fix.
const inFlightPostIds = new Set();

// needs_check: the post may already be live on the network, so PostDeck will
// not resend it. The operator confirms (Mark as posted) or moves it to draft.
const NEEDS_CHECK_PREFIX =
  'needs_check: Blotato may have published this - check the account before resending.';
const NEEDS_CHECK_NO_ID_MSG =
  'needs_check: Blotato accepted the post but returned no submission id, so PostDeck cannot track it - check the account.';
const SUBMITTABLE_STATUSES = ['scheduled_local', 'approved'];

async function handoffOne(db, post) {
  if (inFlightPostIds.has(post.id)) {
    return { ok: false, status: post.status, error: 'in_flight: this post is already being submitted' };
  }
  inFlightPostIds.add(post.id);
  try {
    return await handoffOneLocked(db, post);
  } finally {
    inFlightPostIds.delete(post.id);
  }
}

async function handoffOneLocked(db, post) {
  const account = post.account_id
    ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(post.account_id)
    : null;
  const payload = await buildBlotatoPayload(post, account);
  const now = nowIso();

  // Re-read right before any network call: the row the caller loaded may be
  // stale (already submitted by a sibling path a moment ago, or canceled).
  const fresh = db.prepare('SELECT status FROM posts WHERE id = ?').get(post.id);
  if (!fresh || !SUBMITTABLE_STATUSES.includes(fresh.status)) {
    return {
      ok: false,
      status: fresh ? fresh.status : 'missing',
      error: `post is now '${fresh ? fresh.status : 'missing'}' - not submitted`,
    };
  }

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
      const mediaRef = m.path || m.url;
      if (!mediaRef) continue;
      const localPath = resolveMediaAbsPath(mediaRef);
      const uploadSource = localPath && fs.existsSync(localPath) ? localPath : mediaRef;
      const uploaded = await blotato.uploadMedia(uploadSource);
      uploadedUrls.push(uploaded.url || uploaded.id);
    }
    if (uploadedUrls.length) {
      payload.content.mediaUrls = uploadedUrls;
    }

    // Blotato must always get UTC ISO (T6); a zone-less/garbage legacy value is
    // refused here (non-retryable) rather than sent at the wrong hour.
    const scheduledTime = normalizeIso(post.publish_at);
    const result = await blotato.createPost(
      { accountId: payload.accountId, content: payload.content, target: payload.target },
      scheduledTime
    );
    const submissionId =
      result.postSubmissionId ||
      result.submissionId ||
      result.postId ||
      result.id;

    // Blotato accepted the request but gave us nothing to track. Verify would
    // poll /v2/posts/null forever; park it for a human instead.
    if (!submissionId) {
      db.prepare(
        `UPDATE posts SET status = 'needs_check', error_message = @err, updated_at = @now WHERE id = @id`
      ).run({ err: NEEDS_CHECK_NO_ID_MSG, now, id: post.id });
      recordUsage(db, { kind: 'blotato_submit', brand_id: post.brand_id, meta: { dry_run: false, no_id: true } });
      return { ok: false, status: 'needs_check', error: NEEDS_CHECK_NO_ID_MSG };
    }

    db.prepare(
      `UPDATE posts SET status = 'submitted', blotato_submission_id = @sub_id,
       error_message = NULL, updated_at = @now WHERE id = @id`
    ).run({ sub_id: submissionId ? String(submissionId) : null, now, id: post.id });
    recordUsage(db, { kind: 'blotato_submit', brand_id: post.brand_id, meta: { dry_run: false } });

    return { ok: true, status: 'submitted' };
  } catch (err) {
    // Timeout / dropped connection / 5xx on post creation: it may be live.
    // Never auto-retry; the sweep only picks up scheduled_local, so this
    // status takes the post out of rotation until a human checks.
    if (err.ambiguous) {
      const msg = `${NEEDS_CHECK_PREFIX} ${err.message}`;
      db.prepare(
        `UPDATE posts SET status = 'needs_check', error_message = @err, updated_at = @now WHERE id = @id`
      ).run({ err: msg, now, id: post.id });
      return { ok: false, status: 'needs_check', error: msg };
    }

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
  return (
    post.status === 'scheduled_local' &&
    !!post.publish_at &&
    toMs(post.publish_at) < Date.now() - MISSED_WINDOW_GRACE_MS
  );
}

/**
 * T7: a post approved for a few minutes from now would otherwise sit until the
 * next 5-minute sweep, see its time already past and get flagged missed. When
 * a post has just entered scheduled_local and is due within 10 minutes, hand it
 * off now. Only when the worker is enabled (tests/sandbox run with it off), and
 * never blocking: callers may ignore the returned promise (null = not due),
 * errors are logged, not thrown.
 */
function kickHandoffIfDue(db, postId) {
  if (!workerEnabled()) return null;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  if (!post || post.status !== 'scheduled_local' || !post.publish_at) return null;
  if (isAssistedManual(db, post) || isMissedWindow(post)) return null;
  if (toMs(post.publish_at) > Date.now() + IMMEDIATE_HANDOFF_MS) return null;
  return Promise.resolve()
    .then(() => handoffOne(db, post))
    .catch((err) => console.error(`[worker] immediate handoff of post ${postId} failed: ${err.message}`));
}

async function runHandoffPhase(db) {
  const windowHours = getHandoffWindowHours(db);
  const cutoffMs = Date.now() + windowHours * 60 * 60 * 1000;
  // Compared as epoch ms, never as strings (T6): legacy rows may not be in the
  // normalized format. An unparseable publish_at (NaN) is never due.
  const rows = db
    .prepare(`SELECT * FROM posts WHERE status = 'scheduled_local' AND publish_at IS NOT NULL`)
    .all()
    .filter((post) => toMs(post.publish_at) <= cutoffMs)
    .filter((post) => !isAssistedManual(db, post));
  let handoffCount = 0;
  for (const post of rows) {
    if (isMissedWindow(post)) {
      // Never replace a real handoff error (e.g. a Blotato 5xx) with the flag;
      // the API derives missed_window from the time, not from this message.
      if (!post.error_message) {
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
             AND publish_at IS NOT NULL`;
  const params = [];
  if (brand_id) {
    sql += ' AND brand_id = ?';
    params.push(brand_id);
  }
  if (platform) {
    sql += ' AND platform = ?';
    params.push(platform);
  }
  // Window filtered numerically (T6), not by SQL string compare.
  const fromMs = toMs(from);
  const toMsVal = toMs(to);
  const rows = db.prepare(sql).all(...params).filter((post) => {
    const ms = toMs(post.publish_at);
    return ms >= fromMs && ms <= toMsVal;
  });
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
      const ms = toMs(post.publish_at);
      const fromMs = toMs(scope.from);
      const toMsVal = toMs(scope.to);
      if (Number.isFinite(fromMs) && Number.isFinite(toMsVal) && (ms < fromMs || ms > toMsVal)) {
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

// ---------- verify (T2) ----------
// Blotato's real status body uses camelCase (`publicUrl`, `errorMessage`);
// snake_case / `url` are kept as fallbacks.
function interpretRemote(result) {
  const state = String(result.status || result.state || '').toLowerCase();
  if (state === 'published' || state === 'success' || state === 'succeeded') {
    return { kind: 'published', state, publicUrl: result.publicUrl || result.public_url || result.url || null };
  }
  if (state === 'failed' || state === 'error') {
    const raw = result.errorMessage || result.error || 'publish failed';
    return { kind: 'failed', state, message: typeof raw === 'string' ? raw : JSON.stringify(raw) };
  }
  return { kind: 'pending', state: state || 'unknown' };
}

/** Writes a terminal Blotato answer (published/failed) onto the post. Shared
 * by the background sweep and the manual recheck route. Returns true if the
 * remote answer was terminal. */
function applyTerminalRemote(db, post, remote, now) {
  if (remote.kind === 'published') {
    db.prepare(
      `UPDATE posts SET status = 'published', public_url = @url, error_message = NULL,
       last_remote_state = @state, updated_at = @now WHERE id = @id`
    ).run({ url: remote.publicUrl, state: remote.state, now, id: post.id });
    return true;
  }
  if (remote.kind === 'failed') {
    db.prepare(
      `UPDATE posts SET status = 'failed', error_message = @err, last_remote_state = @state,
       updated_at = @now WHERE id = @id`
    ).run({ err: remote.message, state: remote.state, now, id: post.id });
    return true;
  }
  return false;
}

/** Whether the sweep should poll this post this cycle: every cycle for the
 * first hour after the first poll, then at most every 30 minutes. updated_at
 * doubles as "last polled" (every poll writes it). */
function verifyPollDue(post, nowMs) {
  const started = Date.parse(post.verify_started_at || '');
  if (!Number.isFinite(started) || nowMs - started < VERIFY_FAST_PHASE_MS) return true;
  const last = Date.parse(post.updated_at || '');
  if (!Number.isFinite(last)) return true;
  return nowMs - last >= VERIFY_SLOW_POLL_MS - VERIFY_POLL_SLACK_MS;
}

/**
 * Background verify of one 'submitted' post. Gives up (failed_verify, with a
 * real error_message) only 24h after the first poll; the old early exits (6
 * attempts / 1h past publish_at) abandoned posts that were in fact live. A
 * post with no submission id can't be polled at all and goes straight to
 * failed_verify.
 */
async function verifyOne(db, post) {
  if (isDryRun()) {
    // Nothing to verify against a real API in dry-run; dry-run posts stay
    // 'submitted_dry' until a human resets them. Skip silently.
    return;
  }
  const nowMs = Date.now();
  const now = nowIso();
  if (!post.blotato_submission_id) {
    db.prepare(
      `UPDATE posts SET status = 'failed_verify', error_message = @err, updated_at = @now WHERE id = @id`
    ).run({ err: NO_SUBMISSION_ID_VERIFY_MSG, now, id: post.id });
    return;
  }
  if (!verifyPollDue(post, nowMs)) return;

  const startedAt = post.verify_started_at || now;
  const attempts = (post.verify_attempts || 0) + 1;
  const gaveUp = nowMs - Date.parse(startedAt) >= VERIFY_GIVE_UP_MS;
  try {
    const remote = interpretRemote(await blotato.getPostStatus(post.blotato_submission_id));
    if (applyTerminalRemote(db, post, remote, now)) return;
    if (gaveUp) {
      db.prepare(
        `UPDATE posts SET status = 'failed_verify', verify_attempts = @va, verify_started_at = @sa,
         last_remote_state = @state, error_message = @err, updated_at = @now WHERE id = @id`
      ).run({ va: attempts, sa: startedAt, state: remote.state, err: verifyGiveUpMessage(remote.state), now, id: post.id });
    } else {
      db.prepare(
        `UPDATE posts SET verify_attempts = @va, verify_started_at = @sa, last_remote_state = @state,
         updated_at = @now WHERE id = @id`
      ).run({ va: attempts, sa: startedAt, state: remote.state, now, id: post.id });
    }
  } catch (err) {
    if (gaveUp) {
      db.prepare(
        `UPDATE posts SET status = 'failed_verify', verify_attempts = @va, verify_started_at = @sa,
         error_message = @err, updated_at = @now WHERE id = @id`
      ).run({
        va: attempts,
        sa: startedAt,
        err: `Could not reach Blotato to verify for 24h (${err.message}). Check the account - it may be live.`,
        now,
        id: post.id,
      });
    } else {
      db.prepare(
        `UPDATE posts SET verify_attempts = @va, verify_started_at = @sa, error_message = @err,
         updated_at = @now WHERE id = @id`
      ).run({ va: attempts, sa: startedAt, err: err.message, now, id: post.id });
    }
  }
}

const NO_SUBMISSION_ID_VERIFY_MSG =
  'No Blotato submission id was stored for this post, so it cannot be tracked. Check the account - it may be live.';

function verifyGiveUpMessage(state) {
  return `Blotato still reported '${state}' after 24h. Check the account - it may be live.`;
}

/**
 * Manual recheck (POST /api/posts/:id/recheck): one status poll for a
 * failed_verify or submitted post. published -> published (+ public_url);
 * failed -> failed (+ message); still in progress -> back to 'submitted' with
 * the verify counters reset so the sweep resumes. Dry-run polls nothing.
 * Network/API errors throw and leave the post untouched.
 * @returns {Promise<{post: object, blotato_state: string}>}
 */
async function recheckOne(db, post) {
  if (isDryRun()) return { post, blotato_state: 'dry_run' };
  const remote = interpretRemote(await blotato.getPostStatus(post.blotato_submission_id));
  const now = nowIso();
  if (!applyTerminalRemote(db, post, remote, now)) {
    db.prepare(
      `UPDATE posts SET status = 'submitted', verify_attempts = 0, verify_started_at = NULL,
       last_remote_state = @state, error_message = NULL, updated_at = @now WHERE id = @id`
    ).run({ state: remote.state, now, id: post.id });
  }
  return { post: db.prepare('SELECT * FROM posts WHERE id = ?').get(post.id), blotato_state: remote.state };
}

async function runVerifyPhase(db) {
  const nowMs = Date.now();
  // Numeric compare (T6): publish_at may be in a legacy string format.
  const rows = db
    .prepare(`SELECT * FROM posts WHERE status = 'submitted' AND publish_at IS NOT NULL`)
    .all()
    .filter((post) => toMs(post.publish_at) < nowMs);
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
  lastBackupAt: null,
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

// ---------- daily SQLite backup (audit D1) ----------
// postdeck.db is the system of record for what was published where. One
// consistent snapshot a day via better-sqlite3's online backup API (safe
// under WAL, no lock on the live DB), kept for POSTDECK_BACKUP_KEEP days.
// Runs only for the real DB (no POSTDECK_DB_PATH override) unless a backup dir
// is set explicitly - so the test suite's temp DBs never write to ~/Library.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
function backupDir() {
  return (
    process.env.POSTDECK_BACKUP_DIR ||
    path.join(os.homedir(), 'Library', 'Application Support', 'PostDeck', 'backups')
  );
}
function backupEnabled() {
  if (process.env.POSTDECK_BACKUP_DIR) return true;
  if (process.env.POSTDECK_DB_PATH) return false; // tests / ad-hoc DBs
  return DB_PATH === path.join(ROOT, 'postdeck.db');
}
async function runBackupPhase(db) {
  if (!backupEnabled()) return { skipped: 'disabled' };
  const last = Date.parse(getSetting(db, 'last_backup_at', '') || '') || 0;
  if (Date.now() - last < ONE_DAY_MS) return { skipped: 'fresh' };
  const dir = backupDir();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const dest = path.join(dir, `postdeck-${stamp}.db`);
  await db.backup(dest);
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    'last_backup_at',
    JSON.stringify(nowIso())
  );
  const keep = Math.max(1, Number(process.env.POSTDECK_BACKUP_KEEP) || 14);
  const old = fs
    .readdirSync(dir)
    .filter((f) => /^postdeck-.*\.db$/.test(f))
    .sort()
    .slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  console.log(`[worker] db backup -> ${dest} (keeping ${keep})`);
  status.lastBackupAt = nowIso();
  return { dest, pruned: old.length };
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

  try {
    await runBackupPhase(db);
  } catch (err) {
    console.error('[worker] backup error', err);
  }

  // Blog add-on: release approved posts whose date+time has passed. Isolated so
  // a blog failure can never break social posting.
  try {
    await runBlogPhase(db);
  } catch (err) {
    console.error('[worker] blog phase error', err);
  }

  // Website analytics sync (server logs, GA4, Search Console). Isolated too.
  try {
    await runWebPhase(db);
  } catch (err) {
    console.error('[worker] web phase error', err);
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
  recheckOne,
  kickHandoffIfDue,
  buildBlotatoPayload,
  submitNow,
  resolveBatch,
  runSubmitBatch,
  getWorkerStatus,
  isDryRun,
  workerEnabled,
  getHandoffWindowHours,
  runExportPhase,
  runBackupPhase,
  backupDir,
  isAssistedManual,
  isMissedWindow,
  MISSED_WINDOW_MSG,
  MISSED_WINDOW_GRACE_MS,
};
