// Codex image handoff — brief builder + request persistence (B8 "Image
// workflow — sizing preview + Codex handoff", SPEC.md B8 feature 4). This
// module is pure JSON/fs: it builds the outbound spec CB reviews before
// clicking "Request image", inserts the `image_requests` row, and writes the
// mirrored spec file `image-requests/req-<id>.json` that a Codex session
// reads as its contract. No AI calls happen here — see docs/CODEX_IMAGE_HANDOFF.md
// for the read/write contract Codex follows on the other end, and
// src/imagestudio.js for the worker-side importer that reads back what Codex
// produced.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb, nowIso } from './db.js';
import { getPlatformSpec } from './platforms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// Text-heavy content types read better as lossless PNG; everything else
// (photo-led single image, video thumbnails, etc.) is fine as JPG.
const PNG_CONTENT_TYPES = new Set(['static', 'text', 'carousel']);

// Used when a platform has no image spec at all (e.g. tiktok is video-only,
// blog renders via its own template) — never throw, just flag it.
const DEFAULT_DIMS_RAW = '1080x1350 (4:5)';

const DEFAULT_IMAGE_PROMPT_SETTINGS = Object.freeze({
  system:
    [
      'Create production-ready organic social visuals for PostDeck.',
      'Use the selected brand, platform, copy context, dimensions, logo, and colors as the source of truth.',
      'The visual should support the post instead of repeating the full caption.',
      'Use exact output dimensions. Keep key content inside the center safe zone.',
      'Use readable, restrained on-image text only when the content type needs it.',
      'Do not use generic startup stock-photo language. Make the image feel specific, operational, and useful.',
    ].join('\n'),
  negative:
    [
      'No em-dashes in visible text.',
      'No fake interface details, fake charts, distorted hands, illegible typography, random icons, or decorative clutter.',
      'No hype language such as game-changer, unlock, synergy, or leverage AI.',
      'No unbranded text cards when a brand logo or colors are available.',
    ].join('\n'),
  brand:
    [
      'Charles-first content should feel like an operator note: direct, practical, and earned.',
      'Di-Hy content should feel clean, implementation-focused, and business-first.',
      'Prefer Deep Ink, Slate White, Ember Gold, charcoal, and warm neutral surfaces unless the selected brand settings say otherwise.',
      'Use logo placement like a subtle signature, not a billboard.',
    ].join('\n'),
  layout:
    [
      'Prioritize scanability at feed size.',
      'Use strong composition, large readable hierarchy, high contrast, and one clear focal point.',
      'Avoid tiny body copy. If text is needed, keep it short enough to read on mobile.',
      'Leave breathing room around logos, faces, and headlines.',
    ].join('\n'),
});

function normalizePromptSettings(settings = {}) {
  const src = settings && typeof settings === 'object' ? settings : {};
  return {
    system: typeof src.system === 'string' && src.system.trim() ? src.system : DEFAULT_IMAGE_PROMPT_SETTINGS.system,
    negative: typeof src.negative === 'string' && src.negative.trim() ? src.negative : DEFAULT_IMAGE_PROMPT_SETTINGS.negative,
    brand: typeof src.brand === 'string' && src.brand.trim() ? src.brand : DEFAULT_IMAGE_PROMPT_SETTINGS.brand,
    layout: typeof src.layout === 'string' && src.layout.trim() ? src.layout : DEFAULT_IMAGE_PROMPT_SETTINGS.layout,
  };
}

function getImageReqDir() {
  return process.env.POSTDECK_IMAGE_REQ_DIR || path.join(ROOT, 'image-requests');
}

function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) {
    [a, b] = [b, a % b];
  }
  return a || 1;
}

/**
 * Best-effort parse of a spec-file dims string like "1080x1350 (4:5)" or
 * "1080x1080" into { w, h, aspect, raw }. If the string carries no parseable
 * WxH pair (or isn't a string at all), the raw value is passed through under
 * `raw` so callers never lose information and never throw.
 */
function parseDims(raw) {
  if (typeof raw !== 'string') {
    return { raw: raw ?? null };
  }
  const dimMatch = raw.match(/(\d+)\s*[x×]\s*(\d+)/i);
  if (!dimMatch) {
    return { raw };
  }
  const w = Number(dimMatch[1]);
  const h = Number(dimMatch[2]);
  const aspectMatch = raw.match(/\((\d+):(\d+)\)/);
  let aspect;
  if (aspectMatch) {
    aspect = `${aspectMatch[1]}:${aspectMatch[2]}`;
  } else {
    const d = gcd(w, h);
    aspect = `${w / d}:${h / d}`;
  }
  return { w, h, aspect, raw };
}

/**
 * Pick the most relevant raw dims string out of a platform's `image` spec
 * object, since the shape varies a lot across platforms (facebook has
 * feed/story, instagram has square/portrait/story, twitter has a `dims`
 * array, linkedin has feed/carousel, tiktok/blog have no `image` key at
 * all). Best-effort, content_type-aware, never throws.
 */
function pickImageDimsRaw(image, content_type) {
  if (!image) return null;
  if (content_type === 'carousel' && typeof image.carousel === 'string') return image.carousel;
  if (typeof image.feed === 'string') return image.feed;
  if (typeof image.portrait === 'string') return image.portrait;
  if (typeof image.square === 'string') return image.square;
  if (typeof image.story === 'string') return image.story;
  if (Array.isArray(image.dims) && image.dims.length) return image.dims[0];
  if (typeof image.dims === 'string') return image.dims;
  return null;
}

/**
 * Pure function: builds the Codex image brief for a set of platforms given
 * the post's content_type, copy, and brand. Never throws on a missing/odd
 * platform spec — falls back to a sane default dims string plus a note
 * flagging it, so a bad/incomplete platform-specs.json entry never blocks
 * the request flow.
 */
function buildBrief({
  platforms = [],
  content_type = null,
  copy = '',
  brand = null,
  variant_count = 1,
  hints = [],
  logo_path = null,
  colors = null,
  prompt_settings = null,
} = {}) {
  const recommended_format = PNG_CONTENT_TYPES.has(content_type) ? 'png' : 'jpg';
  // B14: CB picks how many variants Codex generates (default 1); per-variant
  // hints (size/orientation + type) let CB steer the mix without re-typing a
  // brief from scratch. Never throws on a bad value — clamps to >= 1.
  const effectiveVariantCount = Math.max(1, Number.isFinite(Number(variant_count)) ? Math.floor(Number(variant_count)) : 1);
  const hintsList = Array.isArray(hints) ? hints : [];

  const platformBriefs = (platforms || []).map((platform) => {
    const spec = getPlatformSpec(platform);
    const image = spec?.image || null;
    const rawDims = pickImageDimsRaw(image, content_type);
    const usedDefault = !rawDims;
    const dims = parseDims(rawDims || DEFAULT_DIMS_RAW);

    const format = (Array.isArray(image?.formats) && image.formats[0]) || recommended_format;
    const max_mb = image?.max_mb ?? null;

    const notes = [];
    if (usedDefault) {
      notes.push(
        `no image spec found for "${platform}" in platform-specs.json — using default ${DEFAULT_DIMS_RAW}; verify manually before generating.`
      );
    }
    if (spec?.notes) notes.push(spec.notes);
    if (Array.isArray(spec?.image?._uncertain)) notes.push(...spec.image._uncertain);
    notes.push('Keep key subjects/text inside the middle ~80% of the frame (safe zone) — platform UI chrome (captions, buttons, profile bars) crops the edges.');

    return {
      platform,
      dims,
      format,
      max_mb,
      aspect: dims.aspect || null,
      safe_notes: notes.join(' '),
    };
  });

  const quality_notes = [
    recommended_format === 'png'
      ? 'Text-heavy content_type — export lossless PNG to keep text/edges crisp (no JPEG compression artifacts on typography).'
      : 'Photo/video-led content_type — JPG is fine; keep quality high (90+) to avoid banding.',
    `Generate ${effectiveVariantCount} variant${effectiveVariantCount === 1 ? '' : 's'} per request so CB has a real choice at pick time.`,
  ];
  if (logo_path) {
    quality_notes.push(`Brand logo available at ${logo_path} — incorporate subtly (corner watermark or similar) if it suits this content_type.`);
  }
  if (colors) {
    quality_notes.push(`Brand colors: ${JSON.stringify(colors)} — use as accent/background where it fits.`);
  }

  return {
    platforms: platformBriefs,
    recommended_format,
    quality_notes,
    prompt_settings: normalizePromptSettings(prompt_settings),
    content_type: content_type ?? null,
    copy_context: copy || '',
    brand: brand ?? null,
    variant_count: effectiveVariantCount,
    hints: hintsList,
    logo_path: logo_path ?? null,
    colors: colors ?? null,
  };
}

/**
 * Insert an `image_requests` row (status 'requested') and write the mirrored
 * outbound spec file `image-requests/req-<id>.json` for a Codex session to
 * read. Returns the parsed row. Creates the image-requests dir (and any
 * ancestors) as needed.
 */
function createImageRequest(
  db = getDb(),
  { post_id = null, brand_id = null, platforms = [], content_type = null, brief, variant_count, hints } = {}
) {
  const now = nowIso();
  const platformsJson = JSON.stringify(platforms || []);
  // B14: variant_count/hints can arrive either already-embedded in `brief`
  // (the normal path — buildBrief() puts them there) or as separate
  // top-level args (a caller-supplied custom `brief` that skipped
  // buildBrief) — fill gaps without clobbering what's already there.
  const effectiveBrief = { ...(brief || {}) };
  if (variant_count !== undefined && effectiveBrief.variant_count === undefined) {
    effectiveBrief.variant_count = variant_count;
  }
  if (hints !== undefined && effectiveBrief.hints === undefined) {
    effectiveBrief.hints = hints;
  }
  const briefJson = JSON.stringify(effectiveBrief);

  const info = db
    .prepare(
      `
      INSERT INTO image_requests (post_id, brand_id, platforms, content_type, brief, status, variants, created_at, updated_at)
      VALUES (@post_id, @brand_id, @platforms, @content_type, @brief, 'requested', '[]', @now, @now)
    `
    )
    .run({ post_id, brand_id, platforms: platformsJson, content_type, brief: briefJson, now });

  const id = info.lastInsertRowid;

  const reqDir = getImageReqDir();
  fs.mkdirSync(reqDir, { recursive: true });
  const outputDir = `image-requests/generated/req-${id}/`;
  const requestedVariantCount = Number(effectiveBrief.variant_count) || 2;
  const specFile = {
    request_id: id,
    created_at: now,
    brand: brand_id,
    platforms,
    content_type,
    brief: effectiveBrief,
    instructions:
      `Generate ${requestedVariantCount} image variant${requestedVariantCount === 1 ? '' : 's'} at the exact dims/format specified per platform in \`brief.platforms[]\`. ` +
      'Respect `max_mb` and `safe_notes` (safe zones, brand notes). If `brief.hints[]` is present, use it to steer per-variant size/orientation/type (e.g. thumbnail vs feed post vs story). If `brief.logo_path`/`brief.colors` are set, incorporate the brand logo/colors where it fits. ' +
      `Drop the output files plus a manifest.json into ${outputDir} — see docs/CODEX_IMAGE_HANDOFF.md for the exact manifest.json shape PostDeck expects back.`,
    output_dir: outputDir,
  };
  fs.writeFileSync(path.join(reqDir, `req-${id}.json`), JSON.stringify(specFile, null, 2));

  return getImageRequest(db, id);
}

function parseRow(row) {
  if (!row) return row;
  const out = { ...row };
  for (const col of ['platforms', 'brief', 'variants']) {
    if (out[col] != null) {
      try {
        out[col] = JSON.parse(out[col]);
      } catch {
        // leave as raw string if it's not valid JSON
      }
    }
  }
  return out;
}

function listImageRequests(db = getDb(), { status, post_id } = {}) {
  let sql = 'SELECT * FROM image_requests';
  const conditions = [];
  const params = {};
  if (status) {
    conditions.push('status = @status');
    params.status = status;
  }
  if (post_id != null) {
    conditions.push('post_id = @post_id');
    params.post_id = post_id;
  }
  if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
  sql += ' ORDER BY id DESC';
  const rows = db.prepare(sql).all(params);
  return rows.map(parseRow);
}

function getImageRequest(db = getDb(), id) {
  const row = db.prepare('SELECT * FROM image_requests WHERE id = ?').get(id);
  return parseRow(row);
}

function pickVariant(db = getDb(), id, chosen_path) {
  const now = nowIso();
  db.prepare(`UPDATE image_requests SET chosen_path = @chosen_path, status = 'picked', updated_at = @now WHERE id = @id`).run({
    id,
    chosen_path,
    now,
  });
  return getImageRequest(db, id);
}

function cancelImageRequest(db = getDb(), id) {
  const now = nowIso();
  db.prepare(`UPDATE image_requests SET status = 'canceled', updated_at = @now WHERE id = @id`).run({ id, now });
  return getImageRequest(db, id);
}

/**
 * B14 "Regenerate / more variants": bump an existing request into a fresh
 * `image_requests` row for the SAME post/brand/platforms/content_type, so CB
 * can ask for another round of variants without re-typing the brief. Carries
 * the source brief forward (optionally overriding variant_count/hints),
 * writes a brand-new `req-<id>.json`, and stamps `regenerated_from` on the
 * new brief so a Codex session/human can see the lineage. Throws a
 * 404-flagged error if the source request doesn't exist.
 */
function regenerateImageRequest(db = getDb(), { source_request_id, variant_count, hints } = {}) {
  const source = getImageRequest(db, source_request_id);
  if (!source) {
    const err = new Error(`image_request #${source_request_id} not found`);
    err.statusCode = 404;
    throw err;
  }
  const brief = { ...(source.brief && typeof source.brief === 'object' ? source.brief : {}) };
  if (variant_count !== undefined) brief.variant_count = Math.max(1, Number(variant_count) || 1);
  if (hints !== undefined) brief.hints = Array.isArray(hints) ? hints : [];
  brief.regenerated_from = source.id;

  return createImageRequest(db, {
    post_id: source.post_id,
    brand_id: source.brand_id,
    platforms: Array.isArray(source.platforms) ? source.platforms : [],
    content_type: source.content_type,
    brief,
  });
}

export {
  buildBrief,
  DEFAULT_IMAGE_PROMPT_SETTINGS,
  normalizePromptSettings,
  createImageRequest,
  regenerateImageRequest,
  listImageRequests,
  getImageRequest,
  pickVariant,
  cancelImageRequest,
  getImageReqDir,
  parseDims,
  pickImageDimsRaw,
};
