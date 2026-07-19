// Tags & campaigns (B17a — SPEC.md "Tags & campaigns (Sprout's two-tier
// model, simplified)"). A `tag` is a plain label; a `campaign` is the same
// row shape with kind='campaign' — the composer/calendar filter the same
// list by kind. brand_id NULL = global (usable by any brand). A post may
// carry many tags but at most one campaign.

import { nowIso } from './db.js';

const KINDS = ['tag', 'campaign'];

function validateTagInput({ name, kind }) {
  if (!name || !String(name).trim()) return 'name is required';
  if (kind !== undefined && !KINDS.includes(kind)) return "kind must be 'tag' or 'campaign'";
  return null;
}

function listTags(db, { kind, brand_id } = {}) {
  const clauses = [];
  const params = [];
  let sql = 'SELECT * FROM tags WHERE 1=1';
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  if (brand_id !== undefined && brand_id !== null) {
    // A brand's tag list includes its own tags plus global ones.
    clauses.push('(brand_id = ? OR brand_id IS NULL)');
    params.push(brand_id);
  }
  if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
  sql += ' ORDER BY kind, name';
  return db.prepare(sql).all(...params);
}

function getTag(db, id) {
  return db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
}

function createTag(db, input = {}) {
  const err = validateTagInput(input);
  if (err) return { error: err };
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO tags (name, kind, color, brand_id, created_at)
       VALUES (@name, @kind, @color, @brand_id, @now)`
    )
    .run({
      name: String(input.name).trim(),
      kind: input.kind || 'tag',
      color: input.color || null,
      brand_id: input.brand_id === undefined ? null : input.brand_id,
      now,
    });
  return { row: getTag(db, info.lastInsertRowid) };
}

function updateTag(db, id, patch = {}) {
  const existing = getTag(db, id);
  if (!existing) return { error: 'not_found' };
  const merged = {
    name: patch.name !== undefined ? patch.name : existing.name,
    kind: patch.kind !== undefined ? patch.kind : existing.kind,
    color: patch.color !== undefined ? patch.color : existing.color,
    brand_id: patch.brand_id !== undefined ? patch.brand_id : existing.brand_id,
  };
  const err = validateTagInput(merged);
  if (err) return { error: err };
  db.prepare(
    `UPDATE tags SET name = @name, kind = @kind, color = @color, brand_id = @brand_id WHERE id = @id`
  ).run({ ...merged, id });
  return { row: getTag(db, id) };
}

function deleteTag(db, id) {
  const existing = getTag(db, id);
  if (!existing) return { error: 'not_found' };
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  return { ok: true };
}

/** Replace the full tag set for a post. Enforces at most one campaign-kind
 * tag per post — rejects (no write) if the caller passes two+ campaigns. */
function setPostTags(db, post_id, tag_ids = []) {
  const ids = [...new Set((tag_ids || []).map(Number).filter((n) => Number.isInteger(n)))];
  if (ids.length) {
    const placeholders = ids.map(() => '?').join(', ');
    const rows = db.prepare(`SELECT id, kind FROM tags WHERE id IN (${placeholders})`).all(...ids);
    if (rows.length !== ids.length) return { error: 'unknown_tag_id' };
    const campaignCount = rows.filter((r) => r.kind === 'campaign').length;
    if (campaignCount > 1) return { error: 'only one campaign tag allowed per post' };
  }

  const run = db.transaction(() => {
    db.prepare('DELETE FROM post_tags WHERE post_id = ?').run(post_id);
    const insert = db.prepare('INSERT INTO post_tags (post_id, tag_id) VALUES (?, ?)');
    for (const tagId of ids) insert.run(post_id, tagId);
  });
  run();
  return { row: getPostTags(db, post_id) };
}

function getPostTags(db, post_id) {
  return db
    .prepare(
      `SELECT t.* FROM tags t
       JOIN post_tags pt ON pt.tag_id = t.id
       WHERE pt.post_id = ?
       ORDER BY t.kind, t.name`
    )
    .all(post_id);
}

/** Fetch tags for many posts at once (avoids N+1 on the calendar/list
 * payloads). Returns a Map<post_id, Tag[]>. */
function getTagsForPosts(db, postIds = []) {
  const ids = [...new Set((postIds || []).map(Number).filter((n) => Number.isInteger(n)))];
  const map = new Map();
  if (!ids.length) return map;
  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT pt.post_id AS post_id, t.* FROM post_tags pt
       JOIN tags t ON t.id = pt.tag_id
       WHERE pt.post_id IN (${placeholders})
       ORDER BY t.kind, t.name`
    )
    .all(...ids);
  for (const { post_id, ...tag } of rows) {
    if (!map.has(post_id)) map.set(post_id, []);
    map.get(post_id).push(tag);
  }
  return map;
}

export { listTags, getTag, createTag, updateTag, deleteTag, setPostTags, getPostTags, getTagsForPosts };
