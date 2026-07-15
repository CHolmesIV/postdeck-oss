// Blog redistribution (B11 - SPEC.md "Assisted-manual upgrade + blog
// redistribution"). CB drops a blog URL; this module fetches + strips it
// (src/extract.js, no model call), drafts per-platform copy grounded in the
// brand's voice + the article text (reusing draft.js/copy_assist.js - same
// `claude -p` shell, same scrub.js pass), creates one DRAFT post per
// platform, and optionally requests one image brief from imagespec.js.
// Human Approve gate is untouched: every created post is hard-coded
// status:'draft'. Never throws on an AI-unavailable (503) drafting failure -
// returns whatever succeeded with ai_unavailable:true instead.

import { nowIso } from './db.js';
import { extractFromUrl } from './extract.js';
import { draftWithAi } from './draft.js';
import { copyAssist } from './copy_assist.js';
import { examplesGrounding } from './examples.js';
import { buildBrief, createImageRequest } from './imagespec.js';
import { recordUsage } from './usage.js';
import { withGlobalVoice } from './voice.js';

/** First tone profile for a brand, if any (mirrors agent.js's lookup). */
function firstToneProfile(db, brand_id) {
  if (brand_id == null) return null;
  return db.prepare('SELECT * FROM tone_profiles WHERE brand_id = ? ORDER BY id LIMIT 1').get(brand_id) || null;
}

/**
 * Draft per-platform copy from the article, grounded in brand voice. Uses
 * draft.js's draftWithAi (one batched call across all platforms) when the
 * brand has a tone profile; otherwise falls back to copy_assist's
 * 'headlines' mode plus a trimmed article excerpt as the body. Both paths
 * already run scrub.js. Throws (503-flagged) if the underlying CLI call
 * fails - caller decides what to do with a partial result.
 */
async function draftPerPlatform({ db, title, markdown, brand, toneProfile, platforms }) {
  const ideaText = `${title ? `${title}\n\n` : ''}${markdown}`;
  // B12: always merge in the global voice + global hard rules, whether or not
  // this brand has a tone profile - resolveVoice/withGlobalVoice is the
  // single source every generation path uses (see src/voice.js).
  const effectiveTone = withGlobalVoice(db, { brand_id: brand?.id ?? null, toneProfile });

  if (toneProfile) {
    const { drafts, scrub_applied } = await draftWithAi({ idea_text: ideaText, brand, toneProfile: effectiveTone, platforms });
    return { drafts, scrub_applied };
  }

  const grounding = platforms
    .map((p) => examplesGrounding(db, { brand_id: brand?.id ?? null, platform: p }))
    .find((g) => g) || '';

  const { result } = await copyAssist({
    mode: 'headlines',
    idea_text: ideaText,
    brand,
    toneProfile: effectiveTone,
    platforms,
    grounding,
  });
  const headlines = Array.isArray(result?.headlines) ? result.headlines : [];
  const excerpt = markdown.length > 600 ? `${markdown.slice(0, 600).trim()}…` : markdown;

  const drafts = {};
  platforms.forEach((p, i) => {
    const headline = headlines[i % Math.max(headlines.length, 1)] || title || '';
    drafts[p] = [headline, excerpt].filter(Boolean).join('\n\n');
  });
  return { drafts, scrub_applied: [] };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{url: string, brand_id?: number|null, platforms: string[], make_images?: boolean}} params
 * @returns {Promise<{source: {title: string|null, url: string}, drafts: object[],
 *   image_requests: object[], ai_unavailable?: true}>}
 * @throws {Error} if extractFromUrl fails (fetch failure/non-OK response) - the
 *   caller (POST /api/redistribute) maps this to a 400 fetch_failed response.
 */
async function redistributeFromUrl(db, { url, brand_id = null, platforms = [], make_images = true } = {}) {
  const { title, markdown } = await extractFromUrl(url);

  const targetPlatforms = Array.isArray(platforms) ? platforms.filter(Boolean) : [];
  const brand = brand_id != null ? db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id) : null;
  const toneProfile = firstToneProfile(db, brand_id);

  let draftedCopy = {};
  let aiUnavailable = false;

  if (targetPlatforms.length) {
    try {
      const { drafts } = await draftPerPlatform({ db, title, markdown, brand, toneProfile, platforms: targetPlatforms });
      draftedCopy = drafts || {};
      recordUsage(db, { kind: toneProfile ? 'ai_draft' : 'copy_assist', brand_id, meta: { source: 'redistribute', url } });
    } catch (err) {
      aiUnavailable = true;
    }
  }

  const now = nowIso();
  const drafts = [];
  for (const platform of targetPlatforms) {
    const copy = draftedCopy[platform] || '';
    const info = db
      .prepare(
        `
        INSERT INTO posts (
          external_id, idea_id, brand_id, account_id, platform, tone_profile_id,
          copy, media, platform_fields, content_type, publish_at, status, created_at, updated_at
        ) VALUES (
          NULL, NULL, @brand_id, NULL, @platform, @tone_profile_id,
          @copy, '[]', @platform_fields, NULL, NULL, 'draft', @now, @now
        )
      `
      )
      .run({
        brand_id: brand_id ?? null,
        platform,
        tone_profile_id: toneProfile ? toneProfile.id : null,
        copy,
        platform_fields: JSON.stringify({ source_url: url }),
        now,
      });
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
    drafts.push({
      ...row,
      media: JSON.parse(row.media || '[]'),
      platform_fields: JSON.parse(row.platform_fields || '{}'),
    });
  }

  const image_requests = [];
  if (make_images && targetPlatforms.length) {
    const brief = buildBrief({ platforms: targetPlatforms, content_type: 'image', copy: title || '', brand: brand ? brand.name : null });
    const row = createImageRequest(db, { post_id: null, brand_id, platforms: targetPlatforms, content_type: 'image', brief });
    recordUsage(db, { kind: 'image_request', brand_id, meta: { source: 'redistribute', url } });
    image_requests.push(row);
  }

  const out = { source: { title: title || null, url }, drafts, image_requests };
  if (aiUnavailable) out.ai_unavailable = true;
  return out;
}

export { redistributeFromUrl };
