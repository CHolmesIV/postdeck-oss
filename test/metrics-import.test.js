// Unit + route tests for the analytics-import backend (src/metrics-import.js +
// POST /api/metrics-import/preview + /apply in src/server.js). In-memory DB,
// worker/sync disabled — mirrors test/queue.test.js's isolation style.
//
// Run with: node --test test/metrics-import.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { parseMetricsFile, normalizeRows, matchRows, applyImport } = await import('../src/metrics-import.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'Metrics Import Test Brand', `metrics-import-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, { brand_id, platform = 'linkedin', status = 'published', publish_at, copy = '' } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '{}', ?, ?, ?, ?)`
    )
    .run(brand_id, platform, copy, publish_at, status, now, now);
  return info.lastInsertRowid;
}

// ---------- fixtures: LinkedIn + Meta/Facebook style CSV exports ----------

const LINKEDIN_CSV = [
  'Date,Impressions (organic),Clicks,Reactions,Comments,Shares,Engagement rate',
  '2026-07-10,1200,45,30,5,2,3.2%',
  '2026-07-11,900,20,15,1,0,2.1%',
  ',100,5,2,0,0,1.0%', // no date -> should be skipped
].join('\n');

const FACEBOOK_CSV = [
  'Date,Post reach,Reactions,Comments,Shares,Results',
  '07/12/2026,2200,80,10,4,3',
].join('\n');

// ---------- unit: parseMetricsFile ----------

test('parseMetricsFile parses CSV and rejects xlsx', () => {
  const rows = parseMetricsFile(Buffer.from(LINKEDIN_CSV, 'utf8'), 'linkedin_export.csv');
  assert.equal(rows.length, 3);
  assert.equal(rows[0]['Impressions (organic)'], '1200');

  assert.throws(
    () => parseMetricsFile(Buffer.from('irrelevant'), 'export.xlsx'),
    /xlsx_not_supported/
  );

  assert.throws(() => parseMetricsFile(Buffer.from('   \n  '), 'empty.csv'), /empty_file/);
});

// ---------- unit: normalizeRows — header synonyms ----------

test('normalizeRows maps LinkedIn-style headers', () => {
  const rows = parseMetricsFile(Buffer.from(LINKEDIN_CSV, 'utf8'), 'linkedin.csv');
  const normalized = normalizeRows(rows);
  assert.equal(normalized.length, 3);

  const [row1, row2, row3] = normalized;
  assert.equal(row1.date, '2026-07-10');
  assert.equal(row1.impressions, 1200);
  assert.equal(row1.clicks, 45);
  assert.equal(row1.likes, 30); // Reactions -> likes
  assert.equal(row1.comments, 5);
  assert.equal(row1.shares, 2);
  assert.equal(row1.engagement_rate, '3.2%'); // non-numeric field, kept raw

  assert.equal(row2.date, '2026-07-11');
  assert.equal(row2.impressions, 900);

  assert.equal(row3._skipped, true);
  assert.equal(row3._skipReason, 'unparseable_date');
});

test('normalizeRows maps Meta/Facebook-style headers', () => {
  const rows = parseMetricsFile(Buffer.from(FACEBOOK_CSV, 'utf8'), 'facebook.csv');
  const normalized = normalizeRows(rows);
  assert.equal(normalized.length, 1);
  const [row] = normalized;
  assert.equal(row.date, '2026-07-12');
  assert.equal(row.reach, 2200); // Post reach -> reach
  assert.equal(row.likes, 80); // Reactions -> likes
  assert.equal(row.comments, 10);
  assert.equal(row.shares, 4);
  assert.equal(row.results, 3);
});

test('normalizeRows preserves unknown columns in an extra bag', () => {
  const csv = 'Date,Impressions,Weird Custom Column\n2026-07-10,500,foo';
  const rows = parseMetricsFile(Buffer.from(csv, 'utf8'), 'weird.csv');
  const [row] = normalizeRows(rows);
  assert.equal(row.impressions, 500);
  assert.equal(row.extra['Weird Custom Column'], 'foo');
});

// ---------- unit: matchRows ----------

test('matchRows: exact same-day match, adjacent (+/-1 day), ambiguous, and none', () => {
  const db = getDb();
  const brandId = seedBrand(db);

  const exactPost = seedPost(db, { brand_id: brandId, platform: 'linkedin', publish_at: '2026-07-10T09:00:00.000Z', copy: 'Exact match post' });
  const adjacentPost = seedPost(db, { brand_id: brandId, platform: 'linkedin', publish_at: '2026-07-14T09:00:00.000Z', copy: 'Adjacent match post' });
  // Two posts same day -> ambiguous
  seedPost(db, { brand_id: brandId, platform: 'linkedin', publish_at: '2026-07-20T09:00:00.000Z', copy: 'Ambiguous A' });
  seedPost(db, { brand_id: brandId, platform: 'linkedin', publish_at: '2026-07-20T18:00:00.000Z', copy: 'Ambiguous B' });

  const csv = [
    'Date,Impressions',
    '2026-07-10,111', // exact
    '2026-07-15,222', // adjacent to 07-14 (+1 day)
    '2026-07-20,333', // ambiguous
    '2026-08-01,444', // none
  ].join('\n');
  const rows = normalizeRows(parseMetricsFile(Buffer.from(csv, 'utf8'), 'x.csv'));
  const { matches } = matchRows(db, rows, { platform: 'linkedin', brand_id: brandId });

  assert.equal(matches[0].confidence, 'exact');
  assert.equal(matches[0].post_id, exactPost);

  assert.equal(matches[1].confidence, 'adjacent');
  assert.equal(matches[1].post_id, adjacentPost);

  assert.equal(matches[2].confidence, 'ambiguous');
  assert.equal(matches[2].post_id, null);
  assert.equal(matches[2].candidates.length, 2);

  assert.equal(matches[3].confidence, 'none');
  assert.equal(matches[3].post_id, null);
});

test('matchRows requires platform', () => {
  const db = getDb();
  assert.throws(() => matchRows(db, [], {}), /platform is required/);
});

// ---------- unit: applyImport ----------

test('applyImport writes metrics rows readable via the existing metrics read path', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId, platform: 'linkedin', publish_at: '2026-07-10T09:00:00.000Z' });

  const { applied } = applyImport(db, [
    {
      post_id: postId,
      metrics: {
        impressions: 1200,
        comments: 5,
        shares: 2,
        likes: 30,
        clicks: 45,
        engagement_rate: '3.2%',
        extra: { 'Weird Custom Column': 'foo' },
      },
    },
    { post_id: 999999, metrics: { impressions: 1 } }, // missing post -> silently dropped
  ]);
  assert.equal(applied, 1);

  const rows = db.prepare('SELECT * FROM metrics WHERE post_id = ?').all(postId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].impressions, 1200);
  assert.equal(rows[0].comments, 5);
  assert.equal(rows[0].shares, 2);
  assert.match(rows[0].notes, /"likes":30/);
  assert.match(rows[0].notes, /Weird Custom Column/);
});

// ---------- route: POST /api/metrics-import/apply ----------

test('POST /api/metrics-import/apply applies decisions and returns count', async () => {
  const db = getDb();
  const app = buildServer();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId, platform: 'linkedin', publish_at: '2026-07-10T09:00:00.000Z' });

  const res = await app.inject({
    method: 'POST',
    url: '/api/metrics-import/apply',
    payload: { decisions: [{ post_id: postId, metrics: { impressions: 500 } }] },
  });
  assert.equal(res.statusCode, 201);
  assert.deepEqual(JSON.parse(res.body), { applied: 1 });

  const empty = await app.inject({ method: 'POST', url: '/api/metrics-import/apply', payload: {} });
  assert.equal(empty.statusCode, 400);

  await app.close();
});

// ---------- route: POST /api/metrics-import/preview (multipart) ----------

function buildMultipartBody({ boundary, filename, csvContent, fields }) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  }
  parts.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/csv\r\n\r\n${csvContent}\r\n`
  );
  parts.push(`--${boundary}--\r\n`);
  return Buffer.from(parts.join(''), 'utf8');
}

test('POST /api/metrics-import/preview parses+matches an uploaded CSV without writing', async () => {
  const db = getDb();
  const app = buildServer();
  const brandId = seedBrand(db);
  const postId = seedPost(db, {
    brand_id: brandId,
    platform: 'linkedin',
    publish_at: '2026-07-10T09:00:00.000Z',
    copy: 'A post about pricing',
  });

  const boundary = '----postdeckTestBoundary';
  const body = buildMultipartBody({
    boundary,
    filename: 'linkedin_export.csv',
    csvContent: LINKEDIN_CSV,
    fields: { platform: 'linkedin', brand_id: String(brandId) },
  });

  const res = await app.inject({
    method: 'POST',
    url: '/api/metrics-import/preview',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: body,
  });

  assert.equal(res.statusCode, 200);
  const json = JSON.parse(res.body);
  assert.equal(json.platform, 'linkedin');
  assert.equal(json.total_rows, 3);
  assert.equal(json.skipped_rows, 1);
  assert.equal(json.matches[0].confidence, 'exact');
  assert.equal(json.matches[0].post_id, postId);
  assert.match(json.matches[0].post_copy_snippet, /pricing/);

  // no rows written by preview
  const metricsCount = db.prepare('SELECT COUNT(*) AS n FROM metrics WHERE post_id = ?').get(postId).n;
  assert.equal(metricsCount, 0);

  await app.close();
});

test('POST /api/metrics-import/preview 400s with a clear message on missing file/platform', async () => {
  const app = buildServer();
  const boundary = '----postdeckTestBoundary2';

  const noFileBody = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="platform"\r\n\r\nlinkedin\r\n--${boundary}--\r\n`,
    'utf8'
  );
  const noFileRes = await app.inject({
    method: 'POST',
    url: '/api/metrics-import/preview',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: noFileBody,
  });
  assert.equal(noFileRes.statusCode, 400);
  assert.match(JSON.parse(noFileRes.body).error, /no file uploaded/);

  const noPlatformBody = buildMultipartBody({
    boundary: '----postdeckTestBoundary3',
    filename: 'export.csv',
    csvContent: LINKEDIN_CSV,
    fields: {},
  });
  const noPlatformRes = await app.inject({
    method: 'POST',
    url: '/api/metrics-import/preview',
    headers: { 'content-type': 'multipart/form-data; boundary=----postdeckTestBoundary3' },
    payload: noPlatformBody,
  });
  assert.equal(noPlatformRes.statusCode, 400);
  assert.match(JSON.parse(noPlatformRes.body).error, /platform is required/);

  const xlsxBody = buildMultipartBody({
    boundary: '----postdeckTestBoundary4',
    filename: 'export.xlsx',
    csvContent: 'irrelevant',
    fields: { platform: 'linkedin' },
  });
  const xlsxRes = await app.inject({
    method: 'POST',
    url: '/api/metrics-import/preview',
    headers: { 'content-type': 'multipart/form-data; boundary=----postdeckTestBoundary4' },
    payload: xlsxBody,
  });
  assert.equal(xlsxRes.statusCode, 400);
  assert.equal(JSON.parse(xlsxRes.body).error, 'xlsx_not_supported');

  await app.close();
});
