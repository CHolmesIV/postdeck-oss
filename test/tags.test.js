// Unit + integration tests for B17a tags & campaigns (src/tags.js +
// server.js /api/tags + /api/posts/:id/tags + tag-filtered analytics).
// In-memory DB, worker/sync disabled — mirrors test/queue.test.js's
// isolation style.
//
// Run with: node --test test/tags.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0'; // don't start the interval timer in tests
process.env.POSTDECK_SYNC_ENABLED = '0';

const { getDb, nowIso } = await import('../src/db.js');
const { buildServer } = await import('../src/server.js');
const {
  listTags,
  createTag,
  updateTag,
  deleteTag,
  setPostTags,
  getPostTags,
  getTagsForPosts,
} = await import('../src/tags.js');
const { buildAnalytics } = await import('../src/analytics.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'Tags Test Brand', `tags-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

function seedPost(db, { brand_id, platform = 'facebook', status = 'draft', publish_at = null } = {}) {
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, publish_at, status, created_at, updated_at)
       VALUES (?, ?, '', '[]', '{}', ?, ?, ?, ?)`
    )
    .run(brand_id, platform, publish_at, status, now, now);
  return info.lastInsertRowid;
}

function seedMetrics(db, post_id, { impressions = 0, comments = 0, shares = 0, saves = 0, leads = 0 } = {}) {
  const now = nowIso();
  db.prepare(
    `INSERT INTO metrics (post_id, captured_at, impressions, comments, shares, saves, leads)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(post_id, now, impressions, comments, shares, saves, leads);
}

test('tag CRUD', async () => {
  const db = getDb();
  const brandId = seedBrand(db);

  const { row: created, error: createErr } = createTag(db, {
    name: 'Product Launch',
    kind: 'campaign',
    color: '#ff6600',
    brand_id: brandId,
  });
  assert.equal(createErr, undefined);
  assert.equal(created.name, 'Product Launch');
  assert.equal(created.kind, 'campaign');
  assert.equal(created.brand_id, brandId);

  const { row: globalTag } = createTag(db, { name: 'Evergreen' }); // defaults: kind 'tag', brand_id null
  assert.equal(globalTag.kind, 'tag');
  assert.equal(globalTag.brand_id, null);

  const listed = listTags(db, { brand_id: brandId });
  assert.equal(listed.length, 2); // brand's own campaign + the global tag

  const campaignsOnly = listTags(db, { kind: 'campaign' });
  assert.equal(campaignsOnly.length, 1);
  assert.equal(campaignsOnly[0].id, created.id);

  const { row: updated, error: updateErr } = updateTag(db, created.id, { color: '#00ff00' });
  assert.equal(updateErr, undefined);
  assert.equal(updated.color, '#00ff00');

  const { error: badKind } = createTag(db, { name: 'Bad', kind: 'nope' });
  assert.match(badKind, /kind/);

  const { error: badName } = createTag(db, { name: '   ' });
  assert.match(badName, /name/);

  const { ok, error: deleteErr } = deleteTag(db, globalTag.id);
  assert.equal(ok, true);
  assert.equal(deleteErr, undefined);
  assert.equal(listTags(db, { brand_id: brandId }).length, 1);

  const missing = deleteTag(db, 999999);
  assert.equal(missing.error, 'not_found');
});

test('setPostTags replaces the join set and enforces one-campaign-max', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId });

  const { row: tagA } = createTag(db, { name: 'Tag A', brand_id: brandId });
  const { row: tagB } = createTag(db, { name: 'Tag B', brand_id: brandId });
  const { row: campaign1 } = createTag(db, { name: 'Campaign 1', kind: 'campaign', brand_id: brandId });
  const { row: campaign2 } = createTag(db, { name: 'Campaign 2', kind: 'campaign', brand_id: brandId });

  // Set two tags + one campaign — allowed.
  const { row: setResult, error: setErr } = setPostTags(db, postId, [tagA.id, tagB.id, campaign1.id]);
  assert.equal(setErr, undefined);
  assert.equal(setResult.length, 3);
  assert.equal(getPostTags(db, postId).length, 3);

  // Replace: drop tagB, keep the rest — the join is fully replaced, not merged.
  const { row: replaced } = setPostTags(db, postId, [tagA.id, campaign1.id]);
  assert.equal(replaced.length, 2);
  assert.ok(!replaced.some((t) => t.id === tagB.id));

  // Two campaigns on one post — rejected, no write happens.
  const { error: tooManyCampaigns } = setPostTags(db, postId, [campaign1.id, campaign2.id]);
  assert.match(tooManyCampaigns, /one campaign/);
  // Unchanged since the rejected call must not have written.
  assert.equal(getPostTags(db, postId).length, 2);

  // Unknown tag id — rejected.
  const { error: unknown } = setPostTags(db, postId, [999999]);
  assert.equal(unknown, 'unknown_tag_id');

  // Clearing the set.
  const { row: cleared } = setPostTags(db, postId, []);
  assert.equal(cleared.length, 0);
});

test('getTagsForPosts batches tags for many posts in one query (no N+1)', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const post1 = seedPost(db, { brand_id: brandId });
  const post2 = seedPost(db, { brand_id: brandId });
  const post3 = seedPost(db, { brand_id: brandId }); // no tags

  const { row: tagA } = createTag(db, { name: 'A', brand_id: brandId });
  const { row: tagB } = createTag(db, { name: 'B', brand_id: brandId });
  setPostTags(db, post1, [tagA.id, tagB.id]);
  setPostTags(db, post2, [tagA.id]);

  const map = getTagsForPosts(db, [post1, post2, post3]);
  assert.equal(map.get(post1).length, 2);
  assert.equal(map.get(post2).length, 1);
  assert.equal(map.has(post3), false);

  assert.deepEqual(getTagsForPosts(db, []), new Map());
});

test('GET /api/posts and GET /api/posts/:id include each post\'s tags', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId });
  const { row: tag } = createTag(db, { name: 'Featured', brand_id: brandId });
  setPostTags(db, postId, [tag.id]);

  const list = await app.inject({ method: 'GET', url: `/api/posts?brand=${brandId}` });
  assert.equal(list.statusCode, 200);
  const listedPost = list.json().find((p) => p.id === postId);
  assert.ok(listedPost);
  assert.equal(listedPost.tags.length, 1);
  assert.equal(listedPost.tags[0].id, tag.id);

  const single = await app.inject({ method: 'GET', url: `/api/posts/${postId}` });
  assert.equal(single.statusCode, 200);
  assert.equal(single.json().tags.length, 1);
  assert.equal(single.json().tags[0].name, 'Featured');

  await app.close();
});

test('GET/POST/PATCH/DELETE /api/tags + PUT /api/posts/:id/tags contract', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);
  const postId = seedPost(db, { brand_id: brandId });

  const created = await app.inject({
    method: 'POST',
    url: '/api/tags',
    payload: { name: 'Q3 Push', kind: 'campaign', brand_id: brandId, color: '#123456' },
  });
  assert.equal(created.statusCode, 201);
  const tag = created.json();

  const badCreate = await app.inject({ method: 'POST', url: '/api/tags', payload: { name: '' } });
  assert.equal(badCreate.statusCode, 400);

  const list = await app.inject({ method: 'GET', url: `/api/tags?brand_id=${brandId}&kind=campaign` });
  assert.equal(list.statusCode, 200);
  assert.equal(list.json().length, 1);

  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/tags/${tag.id}`,
    payload: { name: 'Q3 Push (updated)' },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().name, 'Q3 Push (updated)');

  const patchMissing = await app.inject({ method: 'PATCH', url: '/api/tags/999999', payload: { name: 'x' } });
  assert.equal(patchMissing.statusCode, 404);

  const putTags = await app.inject({
    method: 'PUT',
    url: `/api/posts/${postId}/tags`,
    payload: { tag_ids: [tag.id] },
  });
  assert.equal(putTags.statusCode, 200);
  assert.equal(putTags.json().tags.length, 1);

  const putMissingPost = await app.inject({
    method: 'PUT',
    url: '/api/posts/999999/tags',
    payload: { tag_ids: [tag.id] },
  });
  assert.equal(putMissingPost.statusCode, 404);

  const { row: campaign2 } = createTag(db, { name: 'Other Campaign', kind: 'campaign', brand_id: brandId });
  const tooManyCampaigns = await app.inject({
    method: 'PUT',
    url: `/api/posts/${postId}/tags`,
    payload: { tag_ids: [tag.id, campaign2.id] },
  });
  assert.equal(tooManyCampaigns.statusCode, 400);

  const deleted = await app.inject({ method: 'DELETE', url: `/api/tags/${tag.id}` });
  assert.equal(deleted.statusCode, 204);

  const deleteMissing = await app.inject({ method: 'DELETE', url: `/api/tags/${tag.id}` });
  assert.equal(deleteMissing.statusCode, 404);

  await app.close();
});

test('analytics rollup + top posts filtered by tag_id', async () => {
  const app = buildServer();
  const db = getDb();
  const brandId = seedBrand(db);

  const taggedPost = seedPost(db, { brand_id: brandId, status: 'published' });
  const untaggedPost = seedPost(db, { brand_id: brandId, status: 'published' });

  seedMetrics(db, taggedPost, { impressions: 1000, comments: 10, shares: 5, saves: 5, leads: 3 });
  seedMetrics(db, untaggedPost, { impressions: 50, comments: 1, shares: 0, saves: 0, leads: 0 });

  const { row: campaign } = createTag(db, { name: 'Filtered Campaign', kind: 'campaign', brand_id: brandId });
  setPostTags(db, taggedPost, [campaign.id]);

  // Unfiltered: both posts count.
  const unfiltered = buildAnalytics(db);
  const brandUnfiltered = unfiltered.brands.find((b) => b.brand_id === brandId);
  assert.equal(brandUnfiltered.totals.all_time.impressions, 1050);
  assert.equal(brandUnfiltered.totals.all_time.leads, 3);

  // Filtered by tag_id: only the tagged post's metrics count, same shape.
  const filtered = buildAnalytics(db, { tagId: campaign.id });
  assert.equal(filtered.tag_id, campaign.id);
  const brandFiltered = filtered.brands.find((b) => b.brand_id === brandId);
  assert.equal(brandFiltered.totals.all_time.impressions, 1000);
  assert.equal(brandFiltered.totals.all_time.leads, 3);
  assert.equal(brandFiltered.top10_by_impressions.length, 1);
  assert.equal(brandFiltered.top10_by_impressions[0].id, taggedPost);
  // Shape parity with the unfiltered payload.
  assert.deepEqual(Object.keys(brandFiltered).sort(), Object.keys(brandUnfiltered).sort());

  // HTTP route accepts ?tag_id=.
  const res = await app.inject({ method: 'GET', url: `/api/analytics?tag_id=${campaign.id}` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.tag_id, campaign.id);
  const routeBrand = body.brands.find((b) => b.brand_id === brandId);
  assert.equal(routeBrand.totals.all_time.impressions, 1000);

  await app.close();
});
