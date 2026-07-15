// Auto-resize-to-platform (B14 "Image studio v2" feature 3 — SPEC.md B14 §1).
// macOS `sips` only, no new npm deps. Given a chosen image + a set of target
// platforms (or explicit {width,height} pairs), produces center-crop-to-fill
// copies at each target's exact dims into media/ — the same file-naming
// convention as POST /api/media (timestamp-prefixed).
//
// Degrades with a clear `resize_unavailable` error when `sips` isn't on PATH
// (non-macOS) — src/server.js maps that to a 503 with a friendly message.
// POSTDECK_SIPS_BIN lets tests point at a fake/missing binary without
// touching the real `sips` on the machine running the suite.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getPlatformSpec } from './platforms.js';
import { parseDims, pickImageDimsRaw } from './imagespec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function sipsBin() {
  return process.env.POSTDECK_SIPS_BIN || 'sips';
}

function getMediaDir() {
  return process.env.POSTDECK_MEDIA_DIR || path.join(ROOT, 'media');
}

function runSips(args) {
  return new Promise((resolve, reject) => {
    execFile(sipsBin(), args, { timeout: 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(new Error(stderr || err.message), { cause: err, code: err.code }));
        return;
      }
      resolve(stdout);
    });
  });
}

let cachedAvailable = null;

/**
 * Detect whether `sips` (or the POSTDECK_SIPS_BIN override) is runnable on
 * this machine. Cached after the first check; pass {fresh:true} to re-probe
 * (tests that flip POSTDECK_SIPS_BIN mid-run).
 */
async function sipsAvailable({ fresh = false } = {}) {
  if (cachedAvailable !== null && !fresh) return cachedAvailable;
  try {
    await runSips(['--help']);
    cachedAvailable = true;
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

function makeUnavailableError() {
  const err = new Error(
    `resize_unavailable: "${sipsBin()}" is not available on this machine. sips is macOS-only — auto-resize needs a Mac (or a working POSTDECK_SIPS_BIN override).`
  );
  err.code = 'resize_unavailable';
  return err;
}

/** Parse `sips -g pixelWidth -g pixelHeight <path>` output into {width, height}. */
function parsePixelSizeOutput(stdout) {
  const wMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const hMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  return {
    width: wMatch ? Number(wMatch[1]) : null,
    height: hMatch ? Number(hMatch[1]) : null,
  };
}

async function getImagePixelSize(absPath) {
  const stdout = await runSips(['-g', 'pixelWidth', '-g', 'pixelHeight', absPath]);
  return parsePixelSizeOutput(stdout);
}

function safeMediaName(originalBase) {
  const uniquer = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}_${uniquer}-${originalBase.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
}

/**
 * Center-crop-to-fill then resample a source image to EXACTLY width×height,
 * writing a new file into outDir. Verifies the final dims with `sips -g`.
 * Throws a `resize_unavailable`-coded error if sips isn't runnable, or a
 * plain error if the source file is missing / width/height are invalid.
 *
 * @param {string} srcAbsPath - absolute path to the source image
 * @param {{width:number, height:number, outDir?:string}} opts
 * @returns {Promise<{path:string, url:string, width:number, height:number}>}
 */
async function resizeToDims(srcAbsPath, { width, height, outDir } = {}) {
  if (!(await sipsAvailable())) {
    throw makeUnavailableError();
  }
  if (!fs.existsSync(srcAbsPath)) {
    throw new Error(`source image not found: ${srcAbsPath}`);
  }
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!w || !h || w <= 0 || h <= 0) {
    throw new Error(`invalid target dims: ${width}x${height}`);
  }

  const targetDir = outDir || getMediaDir();
  fs.mkdirSync(targetDir, { recursive: true });

  const ext = path.extname(srcAbsPath) || '.png';
  const base = path.basename(srcAbsPath, ext);
  const outName = safeMediaName(`${base}${ext}`);
  const outPath = path.join(targetDir, outName);
  fs.copyFileSync(srcAbsPath, outPath);

  // 1) Resample so the SMALLER dimension covers the target (cover-fit), so
  //    the subsequent crop never letterboxes.
  let srcSize;
  try {
    srcSize = await getImagePixelSize(outPath);
  } catch {
    srcSize = { width: null, height: null };
  }
  if (srcSize.width && srcSize.height) {
    const scale = Math.max(w / srcSize.width, h / srcSize.height);
    const resampleW = Math.max(w, Math.round(srcSize.width * scale));
    const resampleH = Math.max(h, Math.round(srcSize.height * scale));
    await runSips(['--resampleWidth', String(resampleW), '--resampleHeight', String(resampleH), outPath]);
  } else {
    // Best-effort fallback if pixel probing failed for some reason — resample
    // straight to target so we still end up at the right final size below.
    await runSips(['--resampleWidth', String(w), '--resampleHeight', String(h), outPath]);
  }

  // 2) Center-crop to the exact target dims.
  await runSips(['--cropToHeightWidth', String(h), String(w), outPath]);

  const finalSize = await getImagePixelSize(outPath);

  return {
    path: `media/${outName}`,
    url: `/media/${outName}`,
    width: finalSize.width ?? w,
    height: finalSize.height ?? h,
  };
}

/**
 * Given a source image + a list of platform names, produce one resized copy
 * per platform (dims parsed from config/platform-specs.json `image.*`, same
 * lookup approach as src/imagespec.js's buildBrief). A platform whose dims
 * can't be parsed (no image spec, e.g. tiktok/blog) is skipped and noted —
 * never throws for that reason alone.
 *
 * @returns {Promise<{results: Array<object>, skipped: Array<{platform:string, reason:string}>}>}
 */
async function resizeForPlatforms(srcAbsPath, platforms = [], { outDir, content_type = null } = {}) {
  const results = [];
  const skipped = [];

  for (const platform of platforms || []) {
    const spec = getPlatformSpec(platform);
    const image = spec?.image || null;
    const rawDims = pickImageDimsRaw(image, content_type);
    const dims = rawDims ? parseDims(rawDims) : null;

    if (!dims || !dims.w || !dims.h) {
      skipped.push({ platform, reason: 'no parseable image dims for this platform in platform-specs.json' });
      continue;
    }

    try {
      const out = await resizeToDims(srcAbsPath, { width: dims.w, height: dims.h, outDir });
      results.push({ platform, dims: `${dims.w}x${dims.h}`, ...out });
    } catch (err) {
      if (err.code === 'resize_unavailable') throw err; // no point continuing the loop
      skipped.push({ platform, reason: err.message });
    }
  }

  return { results, skipped };
}

export { resizeToDims, resizeForPlatforms, sipsAvailable, sipsBin, getMediaDir };
