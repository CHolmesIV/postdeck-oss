// Idea capture importer (B5). Watches an inbox dir for *.md/*.txt files
// dropped from the road (see SPEC.md "Idea capture from the road") and turns
// each one into an `ideas` row, then moves the file to capture-inbox/processed/.
// Called once per worker cycle. Also runnable directly: `node src/capture.js`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, nowIso } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function getInboxDir() {
  return process.env.POSTDECK_CAPTURE_DIR || path.join(ROOT, 'capture-inbox');
}

function getProcessedDir(inboxDir) {
  return path.join(inboxDir, 'processed');
}

function parseFile(raw) {
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  const title = (lines[0] || '').replace(/^#+\s*/, '').trim() || '(untitled idea)';
  const notes = lines.slice(1).join('\n').trim();
  return { title, notes };
}

/**
 * Scan the inbox dir for *.md/*.txt files, insert one `ideas` row per file
 * (status 'idea', source 'capture'), then move the file to processed/.
 * Returns the list of created idea rows. Safe to call repeatedly — the
 * inbox and processed dirs are created if missing, and an empty/missing
 * inbox is a no-op.
 */
function importCapturedIdeas(db = getDb()) {
  const inboxDir = getInboxDir();
  const processedDir = getProcessedDir(inboxDir);
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
    .filter((e) => e.isFile() && /\.(md|txt)$/i.test(e.name))
    .map((e) => e.name)
    .sort();

  const now = nowIso();
  const insert = db.prepare(
    `
    INSERT INTO ideas (brand_id, title, notes, status, source, created_at, updated_at)
    VALUES (NULL, @title, @notes, 'idea', 'capture', @now, @now)
  `
  );

  for (const name of files) {
    const filePath = path.join(inboxDir, name);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.error(`[capture] failed to read ${filePath}: ${err.message}`);
      continue;
    }
    const { title, notes } = parseFile(raw);
    const info = insert.run({ title, notes, now });
    const row = db.prepare('SELECT * FROM ideas WHERE id = ?').get(info.lastInsertRowid);
    created.push(row);

    const dest = path.join(processedDir, name);
    try {
      fs.renameSync(filePath, dest);
    } catch (err) {
      console.error(`[capture] failed to move ${filePath} -> ${dest}: ${err.message}`);
    }
    console.log(`[capture] imported idea #${row.id} "${title}" from ${name}`);
  }

  return created;
}

export { importCapturedIdeas, getInboxDir, getProcessedDir };

// CLI entrypoint: `node src/capture.js`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const created = importCapturedIdeas();
  console.log(`[capture] done — ${created.length} idea(s) imported`);
}
