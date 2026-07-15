// Unit tests for src/resize.js (B14 "Auto-resize to platform specs" -
// SPEC.md B14 §1). Exercises the real macOS `sips` binary when it's
// available (this repo's target runtime is CB's Mac); when it's not, the
// suite still verifies the `resize_unavailable` contract by pointing
// POSTDECK_SIPS_BIN at a binary that can't possibly exist.
//
// A tiny valid PNG is synthesized in-process (no fixture file, no new npm
// dep) via zlib - see makeTestPng() below - so the suite never depends on a
// checked-in binary asset.
//
// Run with: node --test test/resize.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.POSTDECK_DB_PATH = ':memory:';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-resize-'));
const mediaDir = path.join(tmpRoot, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- minimal PNG encoder (no deps) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

/** Synthesize a tiny solid-color RGB PNG (no deps, no fixture file). */
function makeTestPng(width, height, [r, g, b] = [200, 60, 20]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: RGB
  ihdrData[10] = 0;
  ihdrData[11] = 0;
  ihdrData[12] = 0;
  const ihdr = pngChunk('IHDR', ihdrData);

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

const { sipsAvailable, resizeToDims, resizeForPlatforms } = await import('../src/resize.js');

let realSipsAvailable = false;
test('sipsAvailable() reflects this machine (probe once, informational)', async () => {
  realSipsAvailable = await sipsAvailable({ fresh: true });
  // No assertion either way - this just records the environment for the
  // conditional tests below and always passes.
  assert.equal(typeof realSipsAvailable, 'boolean');
});

test('resizeToDims center-crops + resamples to the exact target dims (skipped if sips is unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  const srcPath = path.join(tmpRoot, 'source-wide.png');
  fs.writeFileSync(srcPath, makeTestPng(400, 200));

  const out = await resizeToDims(srcPath, { width: 150, height: 150, outDir: mediaDir });
  assert.ok(out.path.startsWith('media/'));
  assert.ok(out.url.startsWith('/media/'));
  assert.equal(out.width, 150);
  assert.equal(out.height, 150);
  assert.ok(fs.existsSync(path.join(mediaDir, path.basename(out.path))));
});

test('resizeForPlatforms produces one file per platform and skips platforms with no parseable dims (skipped if sips unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  const srcPath = path.join(tmpRoot, 'source-square.png');
  fs.writeFileSync(srcPath, makeTestPng(300, 300));

  const { results, skipped } = await resizeForPlatforms(srcPath, ['instagram', 'facebook', 'tiktok'], {
    outDir: mediaDir,
  });

  assert.ok(results.some((r) => r.platform === 'instagram'));
  assert.ok(results.some((r) => r.platform === 'facebook'));
  for (const r of results) {
    assert.ok(r.width > 0 && r.height > 0);
    assert.ok(fs.existsSync(path.join(mediaDir, path.basename(r.path))));
  }
  // tiktok has no `image` spec in platform-specs.json (video-only) - must be
  // skipped, never thrown.
  assert.ok(skipped.some((s) => s.platform === 'tiktok'));
});

test('resizeToDims throws a resize_unavailable-coded error when sips is missing', async () => {
  const prevBin = process.env.POSTDECK_SIPS_BIN;
  process.env.POSTDECK_SIPS_BIN = '/definitely/not/a/real/binary/sips-does-not-exist';
  try {
    const available = await sipsAvailable({ fresh: true });
    assert.equal(available, false);

    const srcPath = path.join(tmpRoot, 'source-unavailable.png');
    fs.writeFileSync(srcPath, makeTestPng(50, 50));

    await assert.rejects(
      () => resizeToDims(srcPath, { width: 100, height: 100, outDir: mediaDir }),
      (err) => {
        assert.equal(err.code, 'resize_unavailable');
        assert.match(err.message, /resize_unavailable/);
        return true;
      }
    );
  } finally {
    if (prevBin === undefined) delete process.env.POSTDECK_SIPS_BIN;
    else process.env.POSTDECK_SIPS_BIN = prevBin;
    await sipsAvailable({ fresh: true }); // restore the cache for later tests/files
  }
});

test('resizeToDims rejects a missing source file with a plain (non-resize_unavailable) error', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  await assert.rejects(
    () => resizeToDims(path.join(tmpRoot, 'nope.png'), { width: 100, height: 100, outDir: mediaDir }),
    /source image not found/
  );
});
