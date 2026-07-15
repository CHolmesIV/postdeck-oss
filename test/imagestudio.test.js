// Unit tests for the Codex image handoff (B8 feature 4): src/imagespec.js
// (buildBrief + createImageRequest + list/get/pick/cancel) and
// src/imagestudio.js (importGeneratedImages). Uses an in-memory SQLite DB
// (see test/analytics.test.js for the isolation pattern) plus real tmp dirs
// for the image-requests/media filesystem side, cleaned up after each run.
// Run with: node --test test/imagestudio.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-imagestudio-'));
const reqDir = path.join(tmpRoot, 'image-requests');
const mediaDir = path.join(tmpRoot, 'media');
process.env.POSTDECK_IMAGE_REQ_DIR = reqDir;
process.env.POSTDECK_MEDIA_DIR = mediaDir;

const { getDb } = await import('../src/db.js');
const {
  buildBrief,
  createImageRequest,
  listImageRequests,
  getImageRequest,
  pickVariant,
  cancelImageRequest,
} = await import('../src/imagespec.js');
const { importGeneratedImages, getGeneratedDir, getProcessedDir } = await import('../src/imagestudio.js');

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('buildBrief produces correct dims/format for instagram + tiktok', () => {
  const brief = buildBrief({
    platforms: ['instagram', 'tiktok'],
    content_type: 'static',
    copy: 'Launch announcement copy',
    brand: 1,
  });

  assert.equal(brief.recommended_format, 'png'); // static -> text-heavy -> png
  assert.equal(brief.content_type, 'static');
  assert.equal(brief.copy_context, 'Launch announcement copy');
  assert.equal(brief.brand, 1);

  const ig = brief.platforms.find((p) => p.platform === 'instagram');
  assert.ok(ig, 'instagram entry present');
  // instagram spec: portrait "1080x1350 (best real estate)" is picked over square.
  assert.equal(ig.dims.w, 1080);
  assert.equal(ig.dims.h, 1350);
  assert.equal(ig.aspect, ig.dims.aspect);
  assert.equal(ig.format, 'png');

  const tt = brief.platforms.find((p) => p.platform === 'tiktok');
  assert.ok(tt, 'tiktok entry present');
  // tiktok has no `image` spec (video-only) - must fall back, never throw.
  assert.ok(tt.dims.w > 0 && tt.dims.h > 0);
  assert.match(tt.safe_notes, /no image spec found/);
});

test('buildBrief never throws on an unknown platform and passes raw through', () => {
  const brief = buildBrief({ platforms: ['mastodon'], content_type: 'video', copy: '', brand: null });
  assert.equal(brief.recommended_format, 'jpg'); // video -> not text-heavy
  const entry = brief.platforms[0];
  assert.equal(entry.platform, 'mastodon');
  assert.ok(entry.dims.w > 0);
  assert.match(entry.safe_notes, /no image spec found/);
});

test('createImageRequest inserts a row and writes req-<id>.json to disk', () => {
  const db = getDb();
  const brief = buildBrief({ platforms: ['instagram'], content_type: 'static', copy: 'hello', brand: null });
  const row = createImageRequest(db, { post_id: null, brand_id: null, platforms: ['instagram'], content_type: 'static', brief });

  assert.ok(row.id);
  assert.equal(row.status, 'requested');
  assert.deepEqual(row.platforms, ['instagram']);
  assert.equal(row.content_type, 'static');
  assert.deepEqual(row.variants, []);
  assert.equal(row.brief.recommended_format, 'png');

  const specPath = path.join(reqDir, `req-${row.id}.json`);
  assert.ok(fs.existsSync(specPath), 'spec file should be written to disk');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  assert.equal(spec.request_id, row.id);
  assert.deepEqual(spec.platforms, ['instagram']);
  assert.equal(spec.output_dir, `image-requests/generated/req-${row.id}/`);
  assert.match(spec.instructions, /manifest\.json/);

  const fetched = getImageRequest(db, row.id);
  assert.equal(fetched.id, row.id);

  const listed = listImageRequests(db, { status: 'requested' });
  assert.ok(listed.some((r) => r.id === row.id));
});

test('a fabricated generated/req-<id>/ with manifest + fake images gets imported', () => {
  const db = getDb();
  const brief = buildBrief({ platforms: ['instagram', 'facebook'], content_type: 'static', copy: 'promo', brand: null });
  const row = createImageRequest(db, {
    post_id: null,
    brand_id: null,
    platforms: ['instagram', 'facebook'],
    content_type: 'static',
    brief,
  });

  const generatedDir = getGeneratedDir();
  const subdir = path.join(generatedDir, `req-${row.id}`);
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'variant-a.png'), 'fake-png-bytes-a');
  fs.writeFileSync(path.join(subdir, 'variant-b.png'), 'fake-png-bytes-b');
  fs.writeFileSync(
    path.join(subdir, 'manifest.json'),
    JSON.stringify({
      request_id: row.id,
      variants: [
        { file: 'variant-a.png', platform: 'instagram', dims: '1080x1350', notes: 'primary' },
        { file: 'variant-b.png', platform: 'facebook', dims: '1080x1350', notes: 'alt' },
      ],
    })
  );

  const updated = importGeneratedImages(db);
  assert.ok(updated.includes(row.id));

  const after = getImageRequest(db, row.id);
  assert.equal(after.status, 'generated');
  assert.equal(after.variants.length, 2);
  for (const v of after.variants) {
    assert.ok(v.path.startsWith('media/'));
    assert.ok(v.url.startsWith('/media/'));
    assert.ok(fs.existsSync(path.join(mediaDir, path.basename(v.path))), 'variant file should have landed in media/');
  }

  // Original generated subdir should be gone; manifest archived to processed/.
  assert.ok(!fs.existsSync(subdir), 'generated subdir should be moved out');
  const processedManifest = path.join(getProcessedDir(generatedDir), `req-${row.id}`, 'manifest.json');
  assert.ok(fs.existsSync(processedManifest), 'manifest should be archived to processed/');
});

test('importGeneratedImages skips a manifest with no matching image_requests row', () => {
  const db = getDb();
  const generatedDir = getGeneratedDir();
  const bogusId = 999999;
  const subdir = path.join(generatedDir, `req-${bogusId}`);
  fs.mkdirSync(subdir, { recursive: true });
  fs.writeFileSync(path.join(subdir, 'orphan.png'), 'fake-bytes');
  fs.writeFileSync(
    path.join(subdir, 'manifest.json'),
    JSON.stringify({ request_id: bogusId, variants: [{ file: 'orphan.png', platform: 'instagram', dims: '1080x1350', notes: '' }] })
  );

  const updated = importGeneratedImages(db);
  assert.ok(!updated.includes(bogusId));
  // Left in place - not archived, not deleted.
  assert.ok(fs.existsSync(subdir), 'orphan directory should be left untouched');
  assert.ok(fs.existsSync(path.join(subdir, 'orphan.png')));
});

test('pickVariant and cancelImageRequest update status/fields', () => {
  const db = getDb();
  const brief = buildBrief({ platforms: ['instagram'], content_type: 'static', copy: '', brand: null });
  const row = createImageRequest(db, { platforms: ['instagram'], content_type: 'static', brief });

  const picked = pickVariant(db, row.id, 'media/some-file.png');
  assert.equal(picked.status, 'picked');
  assert.equal(picked.chosen_path, 'media/some-file.png');

  const row2 = createImageRequest(db, { platforms: ['facebook'], content_type: 'static', brief });
  const canceled = cancelImageRequest(db, row2.id);
  assert.equal(canceled.status, 'canceled');
});

test('importGeneratedImages is a no-op when generated/ dir does not exist yet', () => {
  const freshTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-imagestudio-empty-'));
  const prevReqDir = process.env.POSTDECK_IMAGE_REQ_DIR;
  process.env.POSTDECK_IMAGE_REQ_DIR = path.join(freshTmp, 'image-requests');
  try {
    const db = getDb();
    const updated = importGeneratedImages(db);
    assert.deepEqual(updated, []);
  } finally {
    process.env.POSTDECK_IMAGE_REQ_DIR = prevReqDir;
    fs.rmSync(freshTmp, { recursive: true, force: true });
  }
});
