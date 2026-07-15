import './env.js';

// Blotato REST client (raw fetch, no MCP — see SPEC.md "Decision 2").
//
// Confirmed from official Blotato API docs (fetched 2026-07-15):
//   - Base URL: https://backend.blotato.com (docs explicitly say api.blotato.com is
//     NOT valid). Kept overridable via BLOTATO_API_BASE for tests/mocks.
//   - Auth header: `blotato-api-key: <key>`
//   - POST /v2/posts body: { post: {accountId, content, target}, scheduledTime }
//     scheduledTime is a ROOT-level sibling of "post" — confirmed by docs, and
//     critical per SPEC.md (nesting it inside `post` publishes immediately).
//   - Successful POST /v2/posts responses return `postSubmissionId` as the
//     scheduling/status-tracking identifier.
//   - GET /v2/users/me/accounts — confirmed, used for the one-time read-only
//     account listing in step 4 of the B4 task, not used by the worker itself.
//   - GET /v2/posts/{postSubmissionId} is the status endpoint.
//   - GET /v2/users/me/accounts/{accountId}/subaccounts lists pages/subaccounts
//     for a connected top-level account.
// UNCONFIRMED from docs (quickstart page didn't show a full curl example):
//   - POST /v2/media exact request body shape (assumed { url } or { filePath }-ish
//     presigned-upload flow per "Presigned Upload" mention) — best guess below.

const DEFAULT_BASE = 'https://backend.blotato.com';
const TIMEOUT_MS = 30_000;
const MAX_ATTEMPTS = 5;

function apiBase() {
  return process.env.BLOTATO_API_BASE || DEFAULT_BASE;
}

function apiKey() {
  return process.env.BLOTATO_API_KEY || '';
}

class BlotatoError extends Error {
  constructor(message, { status, body, retryable } = {}) {
    super(message);
    this.name = 'BlotatoError';
    this.status = status;
    this.body = body;
    this.retryable = retryable !== false; // default true unless explicitly false
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Parse a Retry-After-style hint out of a 429 response body/message, since
// Blotato's rate-limit response shape isn't documented — look for a header
// first, then fall back to sniffing the JSON/text body for a number of
// seconds or an ISO timestamp.
function parseRetryAfterMs(res, bodyText) {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const asNumber = Number(header);
    if (!Number.isNaN(asNumber)) return asNumber * 1000;
    const asDate = Date.parse(header);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  }
  if (bodyText) {
    const secMatch = bodyText.match(/retry[-_ ]?after["\s:]+(\d+)/i);
    if (secMatch) return Number(secMatch[1]) * 1000;
    const isoMatch = bodyText.match(/"(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)"/);
    if (isoMatch) {
      const ms = Date.parse(isoMatch[1]) - Date.now();
      if (!Number.isNaN(ms) && ms > 0) return ms;
    }
  }
  return null;
}

async function request(pathName, { method = 'GET', body, headers = {} } = {}) {
  const url = `${apiBase()}${pathName}`;
  let attempt = 0;
  let lastErr;

  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          'content-type': 'application/json',
          'blotato-api-key': apiKey(),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = new BlotatoError(`network error calling ${pathName}: ${err.message}`, {
        retryable: true,
      });
      if (attempt >= MAX_ATTEMPTS) throw lastErr;
      await sleep(2 ** attempt * 500);
      continue;
    }
    clearTimeout(timer);

    if (res.status === 429) {
      const text = await res.text().catch(() => '');
      const retryMs = parseRetryAfterMs(res, text);
      if (attempt >= MAX_ATTEMPTS) {
        throw new BlotatoError(`Blotato rate limit (429) after ${attempt} attempts: ${text}`, {
          status: 429,
          body: text,
          retryable: true,
        });
      }
      await sleep(retryMs != null ? retryMs : 2 ** attempt * 1000);
      continue;
    }

    if (res.status === 422) {
      const text = await res.text().catch(() => '');
      // 422 is a permanent/validation failure — never retry (per task spec).
      throw new BlotatoError(`Blotato validation error (422) for ${pathName}: ${text}`, {
        status: 422,
        body: text,
        retryable: false,
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BlotatoError(`Blotato API error ${res.status} for ${pathName}: ${text}`, {
        status: res.status,
        body: text,
        retryable: res.status >= 500,
      });
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }

  throw lastErr || new BlotatoError(`request to ${pathName} failed after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Upload a media file to Blotato ahead of post creation.
 * BEST-GUESS shape: docs mention a "Presigned Upload" flow for local files but
 * the quickstart page didn't show the exact request body. We send the file
 * path as `filePath` — adjust once the full API reference is confirmed.
 * @param {string} filePath - absolute or media/-relative path to the asset.
 * @returns {Promise<{id: string, url: string}>}
 */
async function uploadMedia(filePath) {
  return request('/v2/media', {
    method: 'POST',
    body: { filePath },
  });
}

/**
 * Create (and, via root-level scheduledTime, schedule) a post.
 * CRITICAL: scheduledTime must stay a root-level sibling of "post" — nesting
 * it inside `post` causes Blotato to publish immediately (see SPEC.md).
 * @param {{accountId: string, content: object, target: object}} post
 * @param {string} scheduledTime - ISO 8601 timestamp.
 * @returns {Promise<{postSubmissionId?: string, id?: string, [key: string]: any}>}
 */
async function createPost({ accountId, content, target }, scheduledTime) {
  return request('/v2/posts', {
    method: 'POST',
    body: {
      post: { accountId, content, target },
      scheduledTime, // root-level, NOT nested in `post` — see comment above.
    },
  });
}

/**
 * Poll a submitted post's status by postSubmissionId.
 * @param {string} submissionId
 */
async function getPostStatus(submissionId) {
  return request(`/v2/posts/${encodeURIComponent(submissionId)}`, { method: 'GET' });
}

/**
 * Read-only helper: list connected Blotato accounts. Confirmed endpoint.
 * Not used by the worker; used for the one-time real-API validation step.
 */
async function listAccounts() {
  return request('/v2/users/me/accounts', { method: 'GET' });
}

async function listSubaccounts(accountId) {
  return request(`/v2/users/me/accounts/${encodeURIComponent(accountId)}/subaccounts`, {
    method: 'GET',
  });
}

export { uploadMedia, createPost, getPostStatus, listAccounts, listSubaccounts, BlotatoError, apiBase };
