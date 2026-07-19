// Unit + integration tests for B18a best-time nudge (src/besttime.js +
// server.js GET /api/best-times). In-memory DB — mirrors test/queue.test.js's
// isolation style. Run with: node --test test/besttime.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { bestTimes, nextMatchingDatetime, daysSinceLastPost, MIN_DATA_POSTS } = await import('../src/besttime.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'Besttime Test Brand', `besttime-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedPublishedPost(db, { brand_id, platform, publishAtIso, engagement }) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, '', '[]', '{}', ?, 'published', ?, ?)`
    )
    .run(brand_id, platform, publishAtIso, now, now);
  const postId = info.lastInsertRowid;
  db.prepare(
    `INSERT INTO metrics (post_id, captured_at, impressions, comments, shares, saves)
     VALUES (?, ?, 0, ?, 0, 0)`
  ).run(postId, now, engagement);
  return postId;
}

// A fixed Tuesday/Thursday at 10am (inside the 9-12 hour bin) — deterministic
// regardless of when the suite runs.
function tuesdayAt(hour, weekOffset = 0) {
  // 2026-07-21 is a Tuesday.
  const d = new Date('2026-07-21T00:00:00');
  d.setDate(d.getDate() + weekOffset * 7);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function wednesdayAt(hour, weekOffset = 0) {
  // 2026-07-22 is a Wednesday.
  const d = new Date('2026-07-22T00:00:00');
  d.setDate(d.getDate() + weekOffset * 7);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test('bestTimes() falls back to platform-specs defaults below the data threshold', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  // 3 published posts w/ metrics — below MIN_DATA_POSTS (8).
  for (let i = 0; i < 3; i++) {
    seedPublishedPost(db, { brand_id: brandId, platform: 'linkedin', publishAtIso: tuesdayAt(9, i), engagement: 10 });
  }
  const result = bestTimes(db, brandId, 'linkedin');
  assert.equal(result.source, 'default');
  assert.ok(result.bands.length >= 1);
  assert.ok(result.bands[0].label);
  assert.ok(Array.isArray(result.bands[0].days));
});

test('bestTimes() falls back to defaults for a platform with zero posts', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const result = bestTimes(db, brandId, 'facebook');
  assert.equal(result.source, 'default');
  assert.deepEqual(result.bands[0].label, 'Wed-Fri 9am-1pm');
});

test('bestTimes() buckets by day-of-week + hour band once >= 8 published posts exist, top band wins', () => {
  const db = getDb();
  const brandId = seedBrand(db);

  // Heavy winner: Tuesday 9-12 bin, 5 posts x engagement 20 = 100.
  for (let i = 0; i < 5; i++) {
    seedPublishedPost(db, { brand_id: brandId, platform: 'twitter', publishAtIso: tuesdayAt(10, i), engagement: 20 });
  }
  // Weaker runner-up: Wednesday 15-18 bin, 3 posts x engagement 5 = 15.
  for (let i = 0; i < 3; i++) {
    seedPublishedPost(db, { brand_id: brandId, platform: 'twitter', publishAtIso: wednesdayAt(16, i), engagement: 5 });
  }

  const result = bestTimes(db, brandId, 'twitter');
  assert.equal(result.source, 'data');
  assert.ok(result.bands.length >= 1);
  assert.ok(result.bands.length <= 3);

  const top = result.bands[0];
  assert.deepEqual(top.days, [2]); // Tuesday
  assert.equal(top.start_hour, 9);
  assert.equal(top.end_hour, 12);
  assert.match(top.label, /Tue/);
});

test('bestTimes() requires exactly MIN_DATA_POSTS to flip from default to data', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  for (let i = 0; i < MIN_DATA_POSTS - 1; i++) {
    seedPublishedPost(db, { brand_id: brandId, platform: 'instagram', publishAtIso: tuesdayAt(11, i), engagement: 1 });
  }
  assert.equal(bestTimes(db, brandId, 'instagram').source, 'default');

  seedPublishedPost(db, { brand_id: brandId, platform: 'instagram', publishAtIso: tuesdayAt(11, 99), engagement: 1 });
  assert.equal(bestTimes(db, brandId, 'instagram').source, 'data');
});

test('nextMatchingDatetime() resolves the next occurrence inside a band, rolling to next week if today already passed', () => {
  const band = { days: [2, 4], start_hour: 9, end_hour: 11 }; // Tue/Thu 9am
  const sunday = new Date('2026-07-19T12:00:00'); // Sunday
  const iso = nextMatchingDatetime(band, sunday);
  assert.ok(iso);
  const d = new Date(iso);
  assert.equal(d.getDay(), 2, 'earliest matching day is Tuesday');
  assert.equal(d.getHours(), 9);

  // From a time on Tuesday afternoon (past 9am), same band should roll to Thursday.
  const tuesdayAfternoon = new Date('2026-07-21T14:00:00');
  const iso2 = nextMatchingDatetime(band, tuesdayAfternoon);
  const d2 = new Date(iso2);
  assert.equal(d2.getDay(), 4, 'Tuesday 9am already passed -> rolls to Thursday');
});

test('nextMatchingDatetime() returns null for a malformed/empty band', () => {
  assert.equal(nextMatchingDatetime(null), null);
  assert.equal(nextMatchingDatetime({ days: [] }), null);
});

test('daysSinceLastPost() returns null when there is no published/submitted post yet, else the day count', () => {
  const db = getDb();
  const brandId = seedBrand(db);
  assert.equal(daysSinceLastPost(db, brandId, 'reddit'), null);

  const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, status, created_at, updated_at)
     VALUES (?, 'reddit', '', '[]', '{}', 'published', ?, ?)`
  ).run(brandId, fiveDaysAgo, fiveDaysAgo);

  const days = daysSinceLastPost(db, brandId, 'reddit');
  assert.ok(days >= 4 && days <= 5);
});

test('GET /api/best-times returns the payload + last_post_days_ago, 400 without required params', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const missing = await app.inject({ method: 'GET', url: '/api/best-times' });
  assert.equal(missing.statusCode, 400);

  const res = await app.inject({ method: 'GET', url: `/api/best-times?brand_id=${brandId}&platform=facebook` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.source, 'default');
  assert.ok(Array.isArray(body.bands));
  assert.equal(body.last_post_days_ago, null);

  await app.close();
});
