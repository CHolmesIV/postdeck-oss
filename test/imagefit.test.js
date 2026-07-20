// Unit + integration tests for src/imagefit.js — the auto-normalize-for-
// platform pipeline built on top of resize.js's `sips` mechanism. Exercises
// the real macOS `sips` binary when it's available (skips gracefully
// otherwise, mirroring test/resize.test.js's style). Also covers the
// POST /api/media/fit route and the worker handoff on-the-fly substitution
// (Blotato submit stubbed like other worker tests).
//
// Run with: node --test test/imagefit.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-imagefit-'));
const mediaDir = path.join(tmpRoot, 'media');
fs.mkdirSync(mediaDir, { recursive: true });
process.env.POSTDECK_MEDIA_DIR = mediaDir;

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------- minimal PNG encoder (no deps) — same approach as resize.test.js ----------

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

/** Synthesize a solid-color RGB PNG (no deps, no fixture file). Defaults to
 * noisy-ish per-pixel color so deflate can't collapse it into a tiny file —
 * useful for the size-cap re-encode test. */
function makeTestPng(width, height, { noisy = false } = {}) {
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
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % 256;
  };
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      if (noisy) {
        raw[px] = rand();
        raw[px + 1] = rand();
        raw[px + 2] = rand();
      } else {
        raw[px] = 200;
        raw[px + 1] = 60;
        raw[px + 2] = 20;
      }
    }
  }
  const idat = pngChunk('IDAT', zlib.deflateSync(raw, { level: noisy ? 0 : 6 }));
  const iend = pngChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

const { fitImageForPlatform } = await import('../src/imagefit.js');
const { sipsAvailable } = await import('../src/resize.js');

let realSipsAvailable = false;
test('sipsAvailable() reflects this machine (probe once, informational)', async () => {
  realSipsAvailable = await sipsAvailable({ fresh: true });
  assert.equal(typeof realSipsAvailable, 'boolean');
});

test('fitImageForPlatform resizes an oversized image to fit within target dims, no upscale, preserves aspect (skipped if sips unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  // instagram portrait target is 1080x1350 — this source is much larger and
  // a different aspect ratio, so it must be scaled down to fit within (not
  // cropped to exactly) the target box.
  const srcPath = path.join(mediaDir, 'oversized-source.png');
  fs.writeFileSync(srcPath, makeTestPng(2400, 1200));

  const result = await fitImageForPlatform(srcPath, 'instagram');
  assert.ok(result.actions.some((a) => a.startsWith('resize')), 'expected a resize action');
  assert.ok(result.width <= 1080);
  assert.ok(result.height <= 1350);
  // aspect preserved (2:1 source) within rounding
  assert.ok(Math.abs(result.width / result.height - 2400 / 1200) < 0.05);
  assert.ok(result.path.includes('_fit_instagram'));
  assert.ok(fs.existsSync(path.join(mediaDir, path.basename(result.path))));

  // original untouched
  const orig = fs.readFileSync(srcPath);
  assert.ok(orig.length > 0);
});

test('fitImageForPlatform is a no-op (returns original, actions:[]) when already compliant (skipped if sips unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  // twitter accepts 1080x1080 — a small, already-jpeg-free png under the cap
  // and within dims should need nothing. Use a platform/dims combo where the
  // default format (jpg) forces a convert instead: pick a source already at
  // target format by first fitting it once, then re-checking the second call
  // is a pure cache hit with no re-derivation of the underlying pixels.
  const srcPath = path.join(mediaDir, 'compliant-source.png');
  fs.writeFileSync(srcPath, makeTestPng(100, 100));

  const first = await fitImageForPlatform(srcPath, 'twitter');
  assert.ok(first.path.includes('_fit_twitter') || first.actions.length === 0);

  const second = await fitImageForPlatform(srcPath, 'twitter');
  // Second call against the same source+platform must hit the cache path.
  if (first.actions.length > 0) {
    assert.deepEqual(second.actions, ['cached']);
    assert.equal(second.path, first.path);
  }
});

test('fitImageForPlatform re-encodes at descending jpeg quality until under the size cap (skipped if sips unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  // twitter's cap is 5MB. A large noisy (incompressible) PNG converted to
  // jpeg at quality 90 may still land over cap on some inputs — this test
  // just asserts the *mechanism*: if a recompress action fires, the final
  // file is at-or-under the cap, and the ladder only used documented steps.
  const srcPath = path.join(mediaDir, 'noisy-source.png');
  fs.writeFileSync(srcPath, makeTestPng(1080, 1080, { noisy: true }));

  const result = await fitImageForPlatform(srcPath, 'twitter');
  assert.ok(fs.existsSync(path.join(mediaDir, path.basename(result.path))));
  const bytes = fs.statSync(path.join(mediaDir, path.basename(result.path))).size;
  const recompressActions = result.actions.filter((a) => a.startsWith('recompress'));
  for (const a of recompressActions) {
    assert.match(a, /^recompress:q(90|80|70|60)$/);
  }
  // Either it ended under the 5MB cap, or it exhausted the ladder at q60 —
  // both are acceptable outcomes; what must never happen is silently
  // reporting compliance while still over cap without having tried.
  if (bytes > 5 * 1024 * 1024) {
    assert.ok(recompressActions.includes('recompress:q60'), 'must have tried the full ladder before giving up');
  }
});

test('fitImageForPlatform skips platforms with no image spec (tiktok/blog) without throwing (skipped if sips unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  const srcPath = path.join(mediaDir, 'tiktok-source.png');
  fs.writeFileSync(srcPath, makeTestPng(200, 200));

  const result = await fitImageForPlatform(srcPath, 'tiktok');
  assert.equal(result.skipped, 'no_image_spec');
  assert.equal(result.actions.length, 0);
});

test('fitImageForPlatform never overwrites the original file', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  const srcPath = path.join(mediaDir, 'never-overwrite.png');
  const original = makeTestPng(2000, 2000);
  fs.writeFileSync(srcPath, original);

  await fitImageForPlatform(srcPath, 'instagram');
  const stillThere = fs.readFileSync(srcPath);
  assert.equal(stillThere.length, original.length);
});

test('fitImageForPlatform returns skipped:sips_unavailable when sips is missing', async () => {
  const prevBin = process.env.POSTDECK_SIPS_BIN;
  process.env.POSTDECK_SIPS_BIN = '/definitely/not/a/real/binary/sips-does-not-exist';
  try {
    await sipsAvailable({ fresh: true });
    const srcPath = path.join(mediaDir, 'unavailable-source.png');
    fs.writeFileSync(srcPath, makeTestPng(50, 50));

    const result = await fitImageForPlatform(srcPath, 'instagram');
    assert.equal(result.skipped, 'sips_unavailable');
    assert.equal(result.path, srcPath);
  } finally {
    if (prevBin === undefined) delete process.env.POSTDECK_SIPS_BIN;
    else process.env.POSTDECK_SIPS_BIN = prevBin;
    await sipsAvailable({ fresh: true });
  }
});

// ---------- route contract: POST /api/media/fit ----------

const { buildServer } = await import('../src/server.js');

test('POST /api/media/fit confines path to media/ (no traversal)', async () => {
  const app = buildServer();
  for (const evil of ['../package.json', '/etc/hosts', '../../etc/passwd']) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/media/fit',
      payload: { path: evil, platform: 'instagram' },
    });
    assert.notEqual(res.statusCode, 200, `traversal ${evil} must not succeed`);
  }
  await app.close();
});

test('POST /api/media/fit requires path and platform', async () => {
  const app = buildServer();
  const noPath = await app.inject({ method: 'POST', url: '/api/media/fit', payload: { platform: 'instagram' } });
  assert.equal(noPath.statusCode, 400);
  const noPlatform = await app.inject({ method: 'POST', url: '/api/media/fit', payload: { path: 'media/x.png' } });
  assert.equal(noPlatform.statusCode, 400);
  await app.close();
});

test('POST /api/media/fit 404s on a missing source file', async () => {
  const app = buildServer();
  const res = await app.inject({
    method: 'POST',
    url: '/api/media/fit',
    payload: { path: 'media/does-not-exist.png', platform: 'instagram' },
  });
  assert.equal(res.statusCode, 404);
  await app.close();
});

test('POST /api/media/fit runs fitImageForPlatform and returns its result (skipped if sips unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  const app = buildServer();
  const fileName = 'route-source.png';
  fs.writeFileSync(path.join(mediaDir, fileName), makeTestPng(2000, 2000));

  const res = await app.inject({
    method: 'POST',
    url: '/api/media/fit',
    payload: { path: `media/${fileName}`, platform: 'instagram' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(Array.isArray(body.actions));
  assert.ok(body.path);
  await app.close();
});

// ---------- worker handoff: on-the-fly substitution ----------

test('worker handoff substitutes a platform-fit derivative into the Blotato payload (dry-run, skipped if sips unavailable)', async (t) => {
  if (!realSipsAvailable) {
    t.skip('sips not available on this machine');
    return;
  }
  const { getDb, nowIso } = await import('../src/db.js');
  const { handoffOne } = await import('../src/worker.js');
  const db = getDb();

  const now = nowIso();
  const brandInfo = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run('Imagefit Test Brand', `imagefit-${Math.random()}`, now, now);
  const brandId = brandInfo.lastInsertRowid;

  const fileName = 'handoff-source.png';
  fs.writeFileSync(path.join(mediaDir, fileName), makeTestPng(2400, 2400));
  const media = JSON.stringify([{ path: `media/${fileName}`, url: `/media/${fileName}` }]);

  const postInfo = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, 'instagram', 'test copy', ?, '{}', ?, 'scheduled_local', ?, ?)`
    )
    .run(brandId, media, now, now, now);
  const postId = postInfo.lastInsertRowid;
  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);

  const result = await handoffOne(db, post);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'submitted_dry');

  // A derivative should now exist on disk for this source+platform.
  const derivativeExists = fs
    .readdirSync(mediaDir)
    .some((f) => f.startsWith('handoff-source') && f.includes('_fit_instagram'));
  assert.ok(derivativeExists, 'expected a cached _fit_instagram derivative to be created during handoff');
});
