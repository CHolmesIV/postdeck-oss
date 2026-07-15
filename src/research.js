// Manual research ingestion (B8 — SPEC.md "Research + inspiration ingestion").
// CB drops in Google Trends CSV exports, Reddit findings, best-practice notes
// (tagged to brand/pillar); the copy assistant and recommender read these back
// as grounding. Mirrors src/capture.js for the drop-and-forget inbox flow, but
// against a `research-inbox/` dir instead of `capture-inbox/`.
//
// Also runnable directly: `node src/research.js` (runs the inbox importer).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, nowIso } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

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

function parseResearchRow(row) {
  if (!row) return row;
  return { ...row, tags: parseTags(row.tags) };
}

function getResearchNote(db, id) {
  const row = db.prepare('SELECT * FROM research_notes WHERE id = ?').get(id);
  return parseResearchRow(row);
}

// ---------- CRUD ----------

/**
 * List research notes, newest first. Optional filters:
 *  - brand_id: exact match (pass `null` explicitly for global/no-brand notes;
 *    omit the key entirely to return notes across all brands).
 *  - tag: keep only notes whose `tags` array (once parsed) contains this value.
 */
function listResearch(db, opts = {}) {
  const { tag } = opts;
  const hasBrandFilter = Object.prototype.hasOwnProperty.call(opts, 'brand_id');

  let query = 'SELECT * FROM research_notes';
  const params = [];
  if (hasBrandFilter) {
    query += ' WHERE brand_id IS ?';
    params.push(opts.brand_id === undefined ? null : opts.brand_id);
  }
  query += ' ORDER BY created_at DESC, id DESC';

  const rows = db.prepare(query).all(...params).map(parseResearchRow);
  if (!tag) return rows;
  return rows.filter((r) => Array.isArray(r.tags) && r.tags.includes(tag));
}

/**
 * Create a research note. `captured_at` defaults to now if not given;
 * `created_at` is always set to now. Returns the row with tags parsed back
 * into an array.
 */
function createResearchNote(
  db,
  { brand_id = null, source = 'manual', title = null, url = null, body = null, tags = [], captured_at = null } = {}
) {
  const now = nowIso();
  const info = db
    .prepare(
      `
    INSERT INTO research_notes (brand_id, source, title, url, body, tags, captured_at, created_at)
    VALUES (@brand_id, @source, @title, @url, @body, @tags, @captured_at, @now)
  `
    )
    .run({
      brand_id: brand_id ?? null,
      source: source || 'manual',
      title: title || null,
      url: url || null,
      body: body || null,
      tags: JSON.stringify(Array.isArray(tags) ? tags : []),
      captured_at: captured_at || now,
      now,
    });
  return getResearchNote(db, info.lastInsertRowid);
}

const UPDATABLE_FIELDS = ['brand_id', 'source', 'title', 'url', 'body', 'tags', 'captured_at'];

function updateResearchNote(db, id, patch = {}) {
  const existing = getResearchNote(db, id);
  if (!existing) return null;

  const sets = [];
  const params = { id };
  for (const field of UPDATABLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(patch, field)) continue;
    sets.push(`${field} = @${field}`);
    params[field] = field === 'tags' ? JSON.stringify(Array.isArray(patch.tags) ? patch.tags : []) : patch[field];
  }
  if (!sets.length) return existing;

  db.prepare(`UPDATE research_notes SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return getResearchNote(db, id);
}

function deleteResearchNote(db, id) {
  const info = db.prepare('DELETE FROM research_notes WHERE id = ?').run(id);
  return info.changes > 0;
}

// ---------- forgiving text/CSV import ----------

function looksLikeCsv(source, filename) {
  if (source === 'google_trends') return true;
  if (filename && /\.csv$/i.test(filename)) return true;
  return false;
}

function titleFromFilename(filename) {
  if (!filename) return '(untitled research)';
  const base = path.basename(filename).replace(/\.[^./\\]+$/, '');
  const cleaned = base.replace(/[-_]+/g, ' ').trim();
  return cleaned || '(untitled research)';
}

/** First non-empty line = title (leading #'s stripped), rest = body. */
function parseResearchContent(content) {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const firstIdx = lines.findIndex((l) => l.trim().length > 0);
  if (firstIdx === -1) return { title: '(untitled research)', body: '' };
  const title = lines[firstIdx].replace(/^#+\s*/, '').trim() || '(untitled research)';
  const body = lines.slice(firstIdx + 1).join('\n').trim();
  return { title, body };
}

/**
 * Parse a dropped file/paste into a research note and persist it. Keep it
 * forgiving: CSV-looking content (source 'google_trends' or a .csv filename)
 * stores the raw content in body with the title taken from the filename;
 * anything else treats the first non-empty line as the title.
 */
function importResearchText(db, { brand_id = null, source = 'manual', filename = null, content = '' } = {}) {
  let title;
  let body;
  let effectiveSource = source || 'manual';

  if (looksLikeCsv(source, filename)) {
    title = titleFromFilename(filename);
    body = content || '';
    if (!source || source === 'manual') effectiveSource = 'google_trends';
  } else {
    const parsed = parseResearchContent(content);
    title = parsed.title;
    body = parsed.body;
  }

  return createResearchNote(db, { brand_id, source: effectiveSource, title, body, tags: [] });
}

// ---------- grounding digest ----------

/**
 * Build a short plain-text digest of the most recent relevant research notes
 * for a brand, for feeding into the copy assistant's prompt as grounding.
 * Accepts either `tag` or `pillar` (alias) as the tag filter.
 */
function groundingForBrand(db, { brand_id, pillar = null, tag = null, limit = 5 } = {}) {
  const filterTag = tag || pillar || null;
  const opts = { tag: filterTag };
  if (brand_id !== undefined) opts.brand_id = brand_id;

  const notes = listResearch(db, opts).slice(0, Math.max(0, limit));
  if (!notes.length) return '';

  return notes
    .map((n) => {
      const body = (n.body || '').trim();
      const snippet = body.length > 300 ? `${body.slice(0, 300)}…` : body;
      const tagsStr = n.tags && n.tags.length ? ` [${n.tags.join(', ')}]` : '';
      return `- (${n.source}) ${n.title || '(untitled)'}${tagsStr}: ${snippet}`;
    })
    .join('\n');
}

// ---------- research-inbox importer (mirrors capture.js) ----------

function getResearchDir() {
  return process.env.POSTDECK_RESEARCH_DIR || path.join(ROOT, 'research-inbox');
}

function getResearchProcessedDir(inboxDir) {
  return path.join(inboxDir, 'processed');
}

function inferInboxSource(filename) {
  return /\.csv$/i.test(filename) ? 'google_trends' : 'best_practice';
}

/**
 * Scan the research-inbox dir for *.md/*.txt/*.csv files, insert one
 * `research_notes` row per file, then move the file to processed/. Returns
 * the list of created rows. Safe to call repeatedly.
 */
function importResearchInbox(db = getDb()) {
  const inboxDir = getResearchDir();
  const processedDir = getResearchProcessedDir(inboxDir);
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });

  const created = [];
  let entries;
  try {
    entries = fs.readdirSync(inboxDir, { withFileTypes: true });
  } catch {
    return created;
  }

  const files = entries
    .filter((e) => e.isFile() && /\.(md|txt|csv)$/i.test(e.name))
    .map((e) => e.name)
    .sort();

  for (const name of files) {
    const filePath = path.join(inboxDir, name);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`[research] failed to read ${filePath}: ${err.message}`);
      continue;
    }

    const source = inferInboxSource(name);
    const row = importResearchText(db, { brand_id: null, source, filename: name, content: raw });
    created.push(row);

    const dest = path.join(processedDir, name);
    try {
      fs.renameSync(filePath, dest);
    } catch (err) {
      console.error(`[research] failed to move ${filePath} -> ${dest}: ${err.message}`);
    }
    console.log(`[research] imported note #${row.id} "${row.title}" from ${name}`);
  }

  return created;
}

export {
  listResearch,
  createResearchNote,
  updateResearchNote,
  deleteResearchNote,
  importResearchText,
  groundingForBrand,
  importResearchInbox,
  getResearchDir,
  getResearchProcessedDir,
};

// CLI entrypoint: `node src/research.js`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const created = importResearchInbox();
  console.log(`[research] done — ${created.length} note(s) imported`);
}
