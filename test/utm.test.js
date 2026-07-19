// Unit + integration tests for B18c UTM auto-append (src/utm.js + the
// approve-gate hook in server.js's PATCH /api/posts/:id). In-memory DB —
// mirrors test/queue.test.js's isolation style.
// Run with: node --test test/utm.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const { appendUtm, getBrandUtmSettings, setBrandUtmSettings, DEFAULT_TEMPLATE } = await import('../src/utm.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'UTM Test Brand', overrides.slug || `utm-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, { brand_id, platform = 'facebook', status = 'draft', copy = '' } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, ?, '[]', '{}', NULL, ?, ?, ?)`
    )
    .run(brand_id, platform, copy, status, now, now);
  return info.lastInsertRowid;
}

// ---------- appendUtm() unit tests ----------

test('appendUtm() appends the default template to a bare link with no query string', () => {
  const out = appendUtm('Check this out: https://example.com/post', { platform: 'facebook', brand: 'acme' });
  assert.equal(
    out,
    'Check this out: https://example.com/post?utm_source=facebook&utm_medium=social&utm_campaign=acme'
  );
});

test('appendUtm() is idempotent — a second pass leaves already-tagged links untouched', () => {
  const once = appendUtm('Link: https://example.com/x', { platform: 'twitter', brand: 'acme' });
  const twice = appendUtm(once, { platform: 'twitter', brand: 'acme' });
  assert.equal(once, twice);
});

test('appendUtm() skips links that already carry a utm_ param, even with a different platform/campaign', () => {
  const text = 'https://example.com/x?utm_source=newsletter&utm_medium=email';
  const out = appendUtm(text, { platform: 'linkedin', brand: 'acme' });
  assert.equal(out, text);
});

test('appendUtm() substitutes the campaign when given, falling back to brand when campaign is absent', () => {
  const withCampaign = appendUtm('https://example.com', { platform: 'instagram', campaign: 'q3-launch', brand: 'acme' });
  assert.match(withCampaign, /utm_campaign=q3-launch/);

  const withoutCampaign = appendUtm('https://example.com', { platform: 'instagram', brand: 'acme' });
  assert.match(withoutCampaign, /utm_campaign=acme/);
});

test('appendUtm() rewrites multiple links in the same copy', () => {
  const text = 'First https://a.example.com and second https://b.example.com/path here.';
  const out = appendUtm(text, { platform: 'tiktok', brand: 'acme' });
  const matches = [...out.matchAll(/utm_source=tiktok/g)];
  assert.equal(matches.length, 2);
});

test('appendUtm() joins onto an existing query string with & (not a second ?), and handles a trailing bare ?', () => {
  const withQuery = appendUtm('See https://example.com/x?ref=abc', { platform: 'facebook', brand: 'acme' });
  assert.equal(withQuery, 'See https://example.com/x?ref=abc&utm_source=facebook&utm_medium=social&utm_campaign=acme');

  const bareQuestionMark = appendUtm('See https://example.com/x?', { platform: 'facebook', brand: 'acme' });
  assert.equal(bareQuestionMark, 'See https://example.com/x?utm_source=facebook&utm_medium=social&utm_campaign=acme');
});

test('appendUtm() preserves trailing sentence punctuation after the appended params', () => {
  const out = appendUtm('Read it here: https://example.com/post.', { platform: 'facebook', brand: 'acme' });
  assert.ok(out.endsWith('.'));
  assert.equal(
    out,
    'Read it here: https://example.com/post?utm_source=facebook&utm_medium=social&utm_campaign=acme.'
  );

  const parens = appendUtm('(see https://example.com/post)', { platform: 'facebook', brand: 'acme' });
  assert.ok(parens.endsWith(')'));
});

test('appendUtm() respects a custom template override', () => {
  const out = appendUtm('https://example.com', {
    platform: 'facebook',
    brand: 'acme',
    template: 'utm_source={platform}&utm_medium=paid',
  });
  assert.equal(out, 'https://example.com?utm_source=facebook&utm_medium=paid');
});

test('appendUtm() is a no-op on text with no links', () => {
  assert.equal(appendUtm('no links here', { platform: 'facebook' }), 'no links here');
  assert.equal(appendUtm('', { platform: 'facebook' }), '');
});

// ---------- per-brand settings ----------

test('getBrandUtmSettings()/setBrandUtmSettings() round-trip, default disabled', () => {
  const db = getDb();
  const brandId = seedBrand(db);

  assert.deepEqual(getBrandUtmSettings(db, brandId), { enabled: false, template: null });

  setBrandUtmSettings(db, brandId, { enabled: true });
  assert.deepEqual(getBrandUtmSettings(db, brandId), { enabled: true, template: null });

  setBrandUtmSettings(db, brandId, { template: 'utm_source={platform}&utm_medium=social&utm_campaign=custom' });
  const after = getBrandUtmSettings(db, brandId);
  assert.equal(after.enabled, true, 'unrelated patch does not clobber enabled');
  assert.equal(after.template, 'utm_source={platform}&utm_medium=social&utm_campaign=custom');

  setBrandUtmSettings(db, brandId, { enabled: false });
  assert.equal(getBrandUtmSettings(db, brandId).enabled, false);
});

// ---------- PATCH /api/brands/:id wiring ----------

test('PATCH /api/brands/:id sets utm_enabled/utm_template, GET /api/brands returns them', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/brands/${brandId}`,
    payload: { utm_enabled: true, utm_template: 'utm_source={platform}&utm_medium=social&utm_campaign={campaign}' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().utm_enabled, true);
  assert.equal(patched.json().utm_template, 'utm_source={platform}&utm_medium=social&utm_campaign={campaign}');

  const list = await app.inject({ method: 'GET', url: '/api/brands' });
  const row = list.json().find((b) => b.id === brandId);
  assert.equal(row.utm_enabled, true);

  await app.close();
});

// ---------- approve-gate hook ----------

test('PATCH approve rewrites links when the brand has utm_enabled, and is a no-op on draft save', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db, { slug: 'acme-approve' });
  setBrandUtmSettings(db, brandId, { enabled: true });

  const postId = seedPost(db, { brand_id: brandId, platform: 'facebook', status: 'draft', copy: 'https://example.com/x' });

  // Draft save (no status change) must NOT touch the copy.
  const draftSave = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { copy: 'https://example.com/x still a draft' },
  });
  assert.equal(draftSave.statusCode, 200);
  assert.ok(!draftSave.json().copy.includes('utm_source'), 'draft save must not append UTM params');

  // Approve crosses into 'approved' -> hook fires.
  const approved = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { status: 'approved' },
  });
  assert.equal(approved.statusCode, 200);
  assert.match(approved.json().copy, /utm_source=facebook/);
  assert.match(approved.json().copy, /utm_campaign=acme-approve/);

  await app.close();
});

test('PATCH approve does not touch copy when the brand has utm disabled (default)', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId, platform: 'facebook', status: 'draft', copy: 'https://example.com/x' });

  const approved = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { status: 'approved' },
  });
  assert.equal(approved.statusCode, 200);
  assert.equal(approved.json().copy, 'https://example.com/x');

  await app.close();
});

test('PATCH approve is idempotent: re-approving via scheduled_local (publish_at set) does not double-tag', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db, { slug: 'acme-idempotent' });
  setBrandUtmSettings(db, brandId, { enabled: true });
  const postId = seedPost(db, { brand_id: brandId, platform: 'twitter', status: 'draft', copy: 'https://example.com/y' });

  const first = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { status: 'approved', publish_at: new Date(Date.now() + 86400000).toISOString() },
  });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, 'scheduled_local'); // approved + publish_at supersedes to scheduled_local
  const firstCopy = first.json().copy;
  assert.match(firstCopy, /utm_source=twitter/);

  // Rescheduling while already scheduled_local does not re-enter the approve
  // gate (enteringApprovedGate requires crossing INTO approved/scheduled_local
  // from a status that wasn't already there), so copy stays as-is.
  const reschedule = await app.inject({
    method: 'PATCH',
    url: `/api/posts/${postId}`,
    payload: { publish_at: new Date(Date.now() + 2 * 86400000).toISOString() },
  });
  assert.equal(reschedule.statusCode, 200);
  assert.equal(reschedule.json().copy, firstCopy);

  await app.close();
});
