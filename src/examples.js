// Example posts (B11 — SPEC.md "Assisted-manual upgrade + blog
// redistribution"). CB pastes an example post (text) or drops a screenshot;
// these ground the copy assistant/agent as "match the style/format of these
// example posts." Screenshots are converted to text EXACTLY ONCE (via
// src/extract.js's extractFromImage) and the result is cached on the row —
// never re-read the image on subsequent reads.

import { nowIso } from './db.js';
import { extractFromImage } from './extract.js';

// ---------- row helpers ----------

function parseTags(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseExampleRow(row) {
  if (!row) return row;
  return { ...row, tags: parseTags(row.tags) };
}

function getExample(db, id) {
  const row = db.prepare('SELECT * FROM examples WHERE id = ?').get(id);
  return parseExampleRow(row);
}

// ---------- CRUD ----------

/**
 * List examples, newest first. Optional filters:
 *  - brand_id: exact match (pass `null` explicitly for global/no-brand
 *    examples; omit the key entirely to return examples across all brands).
 *  - platform: exact match (same null/omit convention as brand_id).
 */
function listExamples(db, opts = {}) {
  const hasBrandFilter = Object.prototype.hasOwnProperty.call(opts, 'brand_id');
  const hasPlatformFilter = Object.prototype.hasOwnProperty.call(opts, 'platform');

  const clauses = [];
  const params = [];
  if (hasBrandFilter) {
    clauses.push('brand_id IS ?');
    params.push(opts.brand_id === undefined ? null : opts.brand_id);
  }
  if (hasPlatformFilter) {
    clauses.push('platform IS ?');
    params.push(opts.platform === undefined ? null : opts.platform);
  }

  let query = 'SELECT * FROM examples';
  if (clauses.length) query += ` WHERE ${clauses.join(' AND ')}`;
  query += ' ORDER BY created_at DESC, id DESC';

  return db.prepare(query).all(...params).map(parseExampleRow);
}

/**
 * Create an example. If `source === 'screenshot'` and no `text` was given but
 * an `image_path` was, run extractFromImage ONCE and store the returned text
 * (image_path is kept for reference, never re-read). If extraction 503s, the
 * row is still created with `text: null` and a note in `extraction_error` so
 * the caller/UI can retry — the whole create does not throw.
 */
async function createExample(
  db,
  { brand_id = null, platform = null, source = 'paste', text = null, image_path = null, tags = [] } = {}
) {
  const now = nowIso();
  let resolvedText = text ?? null;
  let extractionError = null;

  if (source === 'screenshot' && !resolvedText && image_path) {
    try {
      const extracted = await extractFromImage(image_path);
      resolvedText = extracted.text || null;
    } catch (err) {
      extractionError = err.message || 'image extraction failed';
    }
  }

  const info = db
    .prepare(
      `
    INSERT INTO examples (brand_id, platform, source, text, image_path, tags, created_at)
    VALUES (@brand_id, @platform, @source, @text, @image_path, @tags, @now)
  `
    )
    .run({
      brand_id: brand_id ?? null,
      platform: platform ?? null,
      source: source || 'paste',
      text: resolvedText,
      image_path: image_path ?? null,
      tags: JSON.stringify(Array.isArray(tags) ? tags : []),
      now,
    });

  const row = getExample(db, info.lastInsertRowid);
  if (extractionError) return { ...row, extraction_error: extractionError };
  return row;
}

function deleteExample(db, id) {
  const info = db.prepare('DELETE FROM examples WHERE id = ?').run(id);
  return info.changes > 0;
}

// ---------- grounding digest ----------

const GROUNDING_PREFIX = 'Match the style/format of these example posts:';
const SNIPPET_CAP = 400;

/**
 * Build a short plain-text digest of the most recent matching examples' text,
 * for feeding a drafting prompt as "match the style/format of these example
 * posts:". Returns '' if there are no matching examples (with text).
 */
function examplesGrounding(db, { brand_id, platform, limit = 3 } = {}) {
  const opts = {};
  if (brand_id !== undefined) opts.brand_id = brand_id;
  if (platform !== undefined) opts.platform = platform;

  const examples = listExamples(db, opts)
    .filter((e) => e.text && e.text.trim())
    .slice(0, Math.max(0, limit));

  if (!examples.length) return '';

  const lines = examples.map((e) => {
    const body = e.text.trim();
    const snippet = body.length > SNIPPET_CAP ? `${body.slice(0, SNIPPET_CAP)}…` : body;
    return `- (${e.source}) ${snippet}`;
  });

  return [GROUNDING_PREFIX, ...lines].join('\n');
}

export { listExamples, createExample, deleteExample, examplesGrounding };
