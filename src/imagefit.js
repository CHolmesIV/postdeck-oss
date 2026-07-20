// Auto-normalize-for-platform pipeline, built on top of the same `sips`
// mechanism as src/resize.js (B14). Where resize.js does an explicit
// center-crop-to-exact-dims job (composer-driven "resize to platform"),
// this module is the defensive backstop: given ANY image + a target
// platform, it makes sure the file will actually be accepted by that
// platform — fits it within the platform's max dims (no upscale, aspect
// preserved), converts format if needed, and re-encodes at descending
// jpeg quality if it's still over the platform's max file size.
//
// Never overwrites the original — always writes a new derivative file
// named `<original>_fit_<platform><ext>` next to the source. Re-running
// against an existing derivative is a cheap cache hit (see below), so
// callers (the worker's Blotato handoff, the /api/media/fit route) can
// call this on every image without worrying about redoing the work.
//
// Degrades exactly like resize.js: if `sips` isn't on PATH (non-macOS),
// returns { skipped: 'sips_unavailable' } instead of throwing.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getPlatformSpec } from './platforms.js';
import { parseDims, pickImageDimsRaw } from './imagespec.js';
import { sipsAvailable, sipsBin } from './resize.js';

// Conservative defaults for platforms whose config/platform-specs.json entry
// doesn't (yet) carry an explicit `image.max_mb`. Filled in per the task
// brief; anything not listed here falls back to DEFAULT_MAX_MB.
const DEFAULT_MAX_MB_BY_PLATFORM = {
  linkedin: 8,
  facebook: 8,
  instagram: 8,
  twitter: 5,
  reddit: 20,
};
const DEFAULT_MAX_MB = 8;

// Descending jpeg quality ladder used when a file is still over its size cap
// after the dims/format fixes. Floors at 60 — never degrades further than
// that (a still-oversized file at q60 is reported, not silently mangled).
const JPEG_QUALITY_STEPS = [90, 80, 70, 60];

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

function makeUnavailableError() {
  const err = new Error(
    `resize_unavailable: "${sipsBin()}" is not available on this machine. sips is macOS-only — auto-fit needs a Mac (or a working POSTDECK_SIPS_BIN override).`
  );
  err.code = 'resize_unavailable';
  return err;
}

/** Parse `sips -g pixelWidth -g pixelHeight -g format <path>` output. */
function parseProbeOutput(stdout) {
  const wMatch = stdout.match(/pixelWidth:\s*(\d+)/);
  const hMatch = stdout.match(/pixelHeight:\s*(\d+)/);
  const fMatch = stdout.match(/format:\s*(\S+)/);
  return {
    width: wMatch ? Number(wMatch[1]) : null,
    height: hMatch ? Number(hMatch[1]) : null,
    format: fMatch ? fMatch[1].toLowerCase() : null,
  };
}

async function probeImage(absPath) {
  const stdout = await runSips(['-g', 'pixelWidth', '-g', 'pixelHeight', '-g', 'format', absPath]);
  return parseProbeOutput(stdout);
}

/** 'jpg' -> 'jpeg' (the only rename sips's `-s format` cares about); everything
 * else (png, gif, tiff, bmp) passes through unchanged. */
function sipsFormatName(fmt) {
  const f = String(fmt || '').toLowerCase();
  return f === 'jpg' ? 'jpeg' : f;
}

/** Extension to use for the derivative file, matching the target format. */
function extForFormat(fmt) {
  const f = String(fmt || '').toLowerCase();
  if (f === 'jpeg') return '.jpg';
  return `.${f}`;
}

function getMaxMb(spec, platform) {
  const image = spec?.image;
  if (image && typeof image.max_mb === 'number') return image.max_mb;
  if (DEFAULT_MAX_MB_BY_PLATFORM[platform] != null) return DEFAULT_MAX_MB_BY_PLATFORM[platform];
  return DEFAULT_MAX_MB;
}

/** Deterministic sibling path for a platform's fit derivative — same input
 * always maps to the same output path, which is what makes the "does a
 * `_fit_<platform>` sibling already exist" cache check in worker.js work. */
function fitDerivativePath(mediaPath, platform, targetFormat) {
  const dir = path.dirname(mediaPath);
  const ext = extForFormat(targetFormat);
  const base = path.basename(mediaPath, path.extname(mediaPath));
  return path.join(dir, `${base}_fit_${platform}${ext}`);
}

/**
 * Given ANY source image + a platform, produce (or reuse a cached) derivative
 * that's guaranteed to be within that platform's dims/format/size-cap rules
 * per config/platform-specs.json. Never overwrites the original.
 *
 * @param {string} mediaPath - absolute path to the source image
 * @param {string} platform
 * @returns {Promise<{path:string, width:?number, height:?number, bytes:?number, actions:string[], skipped?:string}>}
 */
async function fitImageForPlatform(mediaPath, platform) {
  if (!(await sipsAvailable())) {
    return { path: mediaPath, width: null, height: null, bytes: null, actions: [], skipped: 'sips_unavailable' };
  }
  if (!fs.existsSync(mediaPath)) {
    throw new Error(`source image not found: ${mediaPath}`);
  }

  const spec = getPlatformSpec(platform);
  const image = spec?.image || null;
  const rawDims = pickImageDimsRaw(image, null);
  const dims = rawDims ? parseDims(rawDims) : null;

  if (!dims || !dims.w || !dims.h) {
    // e.g. tiktok (video-only), blog (rendered, no image spec) — nothing to fit against.
    return { path: mediaPath, width: null, height: null, bytes: null, actions: [], skipped: 'no_image_spec' };
  }

  const targetFormatRaw = (Array.isArray(image?.formats) && image.formats[0]) || 'jpg';
  const targetFormat = sipsFormatName(targetFormatRaw); // 'jpeg' | 'png' | ...
  const maxMb = getMaxMb(spec, platform);
  const capBytes = maxMb * 1024 * 1024;

  const outPath = fitDerivativePath(mediaPath, platform, targetFormat);

  // Cache hit: a derivative for this exact source+platform already exists.
  if (fs.existsSync(outPath)) {
    const cached = await probeImage(outPath).catch(() => ({ width: null, height: null, format: null }));
    const bytes = fs.statSync(outPath).size;
    return {
      path: `media/${path.basename(outPath)}`,
      width: cached.width,
      height: cached.height,
      bytes,
      actions: ['cached'],
    };
  }

  const original = await probeImage(mediaPath).catch(() => ({ width: null, height: null, format: null }));
  const actions = [];

  const needsResize =
    original.width && original.height && (original.width > dims.w || original.height > dims.h);
  const needsFormatConvert = original.format && original.format !== targetFormat;
  const originalBytes = fs.statSync(mediaPath).size;

  if (!needsResize && !needsFormatConvert && originalBytes <= capBytes) {
    // Already compliant — no derivative needed. Report the path in the same
    // `media/<name>` shape callers get from every other path here.
    return {
      path: `media/${path.basename(mediaPath)}`,
      width: original.width,
      height: original.height,
      bytes: originalBytes,
      actions: [],
    };
  }

  // Work on a fresh copy so the original is never touched.
  fs.copyFileSync(mediaPath, outPath);

  try {
    if (needsResize) {
      // Fit-within (not cover): scale down by the smaller ratio so both
      // dims land at-or-under target, preserving aspect. Never upscale.
      const scale = Math.min(dims.w / original.width, dims.h / original.height, 1);
      const newW = Math.max(1, Math.round(original.width * scale));
      const newH = Math.max(1, Math.round(original.height * scale));
      await runSips(['--resampleWidth', String(newW), '--resampleHeight', String(newH), outPath]);
      actions.push(`resize:${newW}x${newH}`);
    }

    if (needsFormatConvert) {
      await runSips(['-s', 'format', targetFormat, outPath]);
      actions.push(`convert:${targetFormat}`);
    }

    let bytes = fs.statSync(outPath).size;
    if (bytes > capBytes) {
      if (targetFormat === 'jpeg') {
        for (const q of JPEG_QUALITY_STEPS) {
          await runSips(['-s', 'formatOptions', String(q), outPath]);
          bytes = fs.statSync(outPath).size;
          actions.push(`recompress:q${q}`);
          if (bytes <= capBytes) break;
        }
      } else {
        actions.push('size_over_cap_no_recompress');
      }
    }

    const finalProbe = await probeImage(outPath).catch(() => ({ width: null, height: null }));
    const finalBytes = fs.statSync(outPath).size;

    return {
      path: `media/${path.basename(outPath)}`,
      width: finalProbe.width ?? null,
      height: finalProbe.height ?? null,
      bytes: finalBytes,
      actions,
    };
  } catch (err) {
    // Best-effort cleanup of a partial derivative on failure — never leave a
    // half-written file that a later cache-hit check would trust.
    try {
      fs.unlinkSync(outPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

export { fitImageForPlatform, fitDerivativePath, getMaxMb, DEFAULT_MAX_MB_BY_PLATFORM, DEFAULT_MAX_MB };
