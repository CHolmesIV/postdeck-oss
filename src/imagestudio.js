// Worker-side importer for the Codex image handoff (B8 feature 4). Mirrors
// src/capture.js: scans a generated/ dir for what Codex produced, moves the
// variant files into media/, updates the image_requests row, and archives
// the manifest. Called once per worker cycle (see src/worker.js) alongside
// importCapturedIdeas. Also runnable directly: `node src/imagestudio.js`.
//
// Contract (see docs/CODEX_IMAGE_HANDOFF.md): each `image-requests/req-<id>.json`
// spec written by src/imagespec.js asks Codex to drop its output into
// `image-requests/generated/req-<id>/manifest.json` +
// `{request_id, variants: [{file, platform, dims, notes}]}`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, nowIso } from './db.js';
import { getImageReqDir } from './imagespec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function getGeneratedDir() {
  return path.join(getImageReqDir(), 'generated');
}

function getProcessedDir(generatedDir) {
  return path.join(generatedDir, 'processed');
}

function getMediaDir() {
  return process.env.POSTDECK_MEDIA_DIR || path.join(ROOT, 'media');
}

function safeMediaName(originalName, uniquer) {
  return `${Date.now()}_${uniquer}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Scan `image-requests/generated/req-<id>/` subdirs for a manifest.json,
 * move each listed variant file into media/, update the matching
 * image_requests row to status 'generated' with variants[], then archive
 * the subdir (manifest + any leftovers) to
 * `image-requests/generated/processed/req-<id>/`.
 *
 * A manifest whose request_id has no matching image_requests row is
 * skipped (logged, left in place — nothing moved, nothing archived).
 * Safe to call repeatedly; a missing/empty generated dir is a no-op.
 * Returns the list of updated request ids.
 */
function importGeneratedImages(db = getDb()) {
  const generatedDir = getGeneratedDir();
  const processedDir = getProcessedDir(generatedDir);
  const mediaDir = getMediaDir();
  fs.mkdirSync(generatedDir, { recursive: true });
  fs.mkdirSync(processedDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });

  const updated = [];
  let entries;
  try {
    entries = fs.readdirSync(generatedDir, { withFileTypes: true });
  } catch {
    return updated;
  }

  const subdirs = entries
    .filter((e) => e.isDirectory() && e.name !== 'processed' && /^req-\d+$/.test(e.name))
    .map((e) => e.name)
    .sort();

  let uniquer = 0;

  for (const subdirName of subdirs) {
    const subdirPath = path.join(generatedDir, subdirName);
    const manifestPath = path.join(subdirPath, 'manifest.json');

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.error(`[imagestudio] failed to read/parse ${manifestPath}: ${err.message}`);
      continue;
    }

    const requestId = manifest.request_id;
    const row = db.prepare('SELECT * FROM image_requests WHERE id = ?').get(requestId);
    if (!row) {
      console.error(`[imagestudio] ${subdirName}: no image_requests row for request_id ${requestId} — leaving in place`);
      continue;
    }

    const variants = [];
    for (const variant of manifest.variants || []) {
      const srcPath = path.join(subdirPath, variant.file);
      if (!fs.existsSync(srcPath)) {
        console.error(`[imagestudio] ${subdirName}: variant file missing: ${variant.file}`);
        continue;
      }
      uniquer += 1;
      const newName = safeMediaName(variant.file, uniquer);
      const destPath = path.join(mediaDir, newName);
      fs.renameSync(srcPath, destPath);
      variants.push({
        path: `media/${newName}`,
        url: `/media/${newName}`,
        platform: variant.platform ?? null,
        dims: variant.dims ?? null,
        notes: variant.notes ?? null,
      });
    }

    const now = nowIso();
    db.prepare(`UPDATE image_requests SET status = 'generated', variants = @variants, updated_at = @now WHERE id = @id`).run({
      id: requestId,
      variants: JSON.stringify(variants),
      now,
    });
    updated.push(requestId);
    console.log(`[imagestudio] imported ${variants.length} variant(s) for image_request #${requestId}`);

    // Archive the manifest (+ any leftovers) so generated/ doesn't grow forever.
    const archiveDest = path.join(processedDir, subdirName);
    try {
      fs.rmSync(archiveDest, { recursive: true, force: true });
      fs.renameSync(subdirPath, archiveDest);
    } catch (err) {
      console.error(`[imagestudio] failed to archive ${subdirPath} -> ${archiveDest}: ${err.message}`);
    }
  }

  return updated;
}

export { importGeneratedImages, getGeneratedDir, getProcessedDir, getMediaDir };

// CLI entrypoint: `node src/imagestudio.js`
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const updated = importGeneratedImages();
  console.log(`[imagestudio] done — ${updated.length} request(s) imported`);
}
