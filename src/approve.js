// The Approve gate, shared by every path that moves a draft into
// approved/scheduled_local (PATCH /api/posts/:id, approve-batch, publish-now,
// POST /api/posts/:id/queue, and the chat agent's approve_post). Audit T10:
// the queue route and the agent used to skip the TikTok field check and the
// UTM pass the human PATCH path ran.

import { validateTiktokFields } from './validate.js';
import { applyApproveUtm } from './utm.js';

function parsePlatformFields(raw) {
  if (raw && typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw || '{}') || {};
  } catch {
    return {};
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} post  the stored posts row
 * @param {object} [o]
 * @param {string} [o.copy]  defaults to post.copy
 * @param {string|null} [o.first_comment]  defaults to post.first_comment
 * @param {object|string} [o.platform_fields]  pending override; defaults to the stored value
 * @param {boolean} [o.utm=true]  false when the post was already tagged once
 * @returns {{ok:false,error:string,message:string,missing:string[]} |
 *           {ok:true,copy:string,first_comment:string|null}}
 */
export function runApproveGate(db, post, o = {}) {
  const copy = o.copy !== undefined ? o.copy : post.copy;
  const firstComment = o.first_comment !== undefined ? o.first_comment : post.first_comment;
  if (post.platform === 'tiktok') {
    const pf = parsePlatformFields(o.platform_fields !== undefined ? o.platform_fields : post.platform_fields);
    const { ok, missing } = validateTiktokFields(pf);
    if (!ok) {
      return {
        ok: false,
        error: 'tiktok_fields_missing',
        message: `TikTok post is missing required fields: ${missing.join(', ')}`,
        missing,
      };
    }
  }
  if (o.utm === false) return { ok: true, copy, first_comment: firstComment };
  const tagged = applyApproveUtm(db, post, { copy, first_comment: firstComment });
  return { ok: true, copy: tagged.copy, first_comment: tagged.first_comment };
}
