// Unit tests for src/agent.js (B10 - SPEC.md "In-app chat agent").
// Mocks the claude CLI the way test/copy_assist.test.js does: POSTDECK_CLAUDE_BIN
// points at a tiny stub script written to a temp file that echoes a canned
// --output-format json envelope. DB is isolated via POSTDECK_DB_PATH pointing
// at a temp sqlite file (not :memory:, so the stub's separate child process
// invocations don't matter - only the parent process touches the DB anyway).
// Run with: node --test test/agent.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-agent-db-'));
process.env.POSTDECK_DB_PATH = path.join(tmpDbDir, 'agent-test.db');
process.env.BLOTATO_DRY_RUN = '1';

const { getDb, nowIso } = await import('../src/db.js');
const { runAgent, executeAction } = await import('../src/agent.js');

function seedBrand(db, overrides = {}) {
  const now = nowIso();
  const info = db
    .prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)`)
    .run(overrides.name || 'Agent Test Brand', `agent-${Math.random()}`, now, now);
  return info.lastInsertRowid;
}

/**
 * Write a stub "claude" CLI that: on its FIRST invocation, returns a canned
 * {reply, actions} envelope (`firstCallActions`); on every subsequent
 * invocation, returns an empty-actions envelope so the bounded loop
 * terminates after round 2. Invocation count is tracked via a counter file
 * on disk since each call is a separate child process.
 */
function writeStubClaudeBin(firstCallActions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-agent-cli-'));
  const binPath = path.join(dir, 'claude-stub.js');
  const counterPath = path.join(dir, 'counter.txt');
  fs.writeFileSync(counterPath, '0');

  const script = `#!/usr/bin/env node
const fs = require('fs');
const counterPath = ${JSON.stringify(counterPath)};
let n = Number(fs.readFileSync(counterPath, 'utf8') || '0');
n += 1;
fs.writeFileSync(counterPath, String(n));
let envelope;
if (n === 1) {
  envelope = { reply: 'working on it', actions: ${JSON.stringify(firstCallActions)} };
} else {
  envelope = { reply: 'done', actions: [] };
}
process.stdout.write(JSON.stringify({ result: JSON.stringify(envelope) }));
`;
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return { dir, binPath };
}

test('runAgent executes a create_draft_post action and the created post is status draft', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const { dir, binPath } = writeStubClaudeBin([
    { tool: 'create_draft_post', args: { brand_id: brandId, platform: 'linkedin', copy: 'Hello' } },
  ]);
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const result = await runAgent(db, { message: 'draft a linkedin post', brand_id: brandId });

    assert.equal(result.actions.length, 1);
    const action = result.actions[0];
    assert.equal(action.tool, 'create_draft_post');
    assert.ok(action.summary.includes('Created draft #'));
    assert.ok(action.link.startsWith('#/post/'));

    const postId = Number(action.link.replace('#/post/', ''));
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    assert.ok(post, 'post should exist');
    assert.equal(post.status, 'draft');
    assert.equal(post.platform, 'linkedin');

    assert.equal(result.reply, 'done', 'final reply should come from the round with no more actions');
    assert.ok(Array.isArray(result.history));
    assert.ok(result.history.some((h) => h.role === 'user' && h.content === 'draft a linkedin post'));
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runAgent stops the loop within MAX_ROUNDS when actions keep coming back empty', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const { dir, binPath } = writeStubClaudeBin([]); // no actions even on round 1
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const result = await runAgent(db, { message: 'what is my usage this week?', brand_id: brandId });
    assert.equal(result.actions.length, 0);
    assert.equal(result.reply, 'working on it');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('there is no submit/cancel/delete tool - a fabricated "publish_post" action is skipped, not executed; approve_post/publish_now exist but refuse unarmed', async () => {
  const db = getDb();
  const brandId = seedBrand(db);

  // Seed a draft post so we can prove its status never changes.
  const now = nowIso();
  const postInfo = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, status, created_at, updated_at)
       VALUES (?, 'linkedin', 'seed copy', '[]', '{}', 'draft', ?, ?)`
    )
    .run(brandId, now, now);
  const postId = postInfo.lastInsertRowid;

  // These tool names simply don't exist, ever - no gate, no arming switch.
  for (const badTool of ['publish_post', 'submit_post', 'cancel_post', 'delete_post']) {
    const result = await executeAction(db, { tool: badTool, args: { id: postId, status: 'approved' } });
    assert.ok(
      /unsupported/i.test(result.summary),
      `${badTool} should be reported as unsupported, got: ${result.summary}`
    );
  }

  // B14: approve_post/publish_now DO exist now, but stay inert unless CB has
  // armed agent_can_publish in Settings (default '0' / unset here) - the
  // refusal path, not an "unsupported tool" path.
  for (const gatedTool of ['approve_post', 'publish_now']) {
    const result = await executeAction(db, { tool: gatedTool, args: { id: postId } });
    assert.match(result.summary, /off - arm it in Settings/, `${gatedTool} should refuse while unarmed`);
  }

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(post.status, 'draft', 'status must be untouched by any fabricated/unarmed publish/approve tool call');

  // Also drive it through the full runAgent loop to confirm the model can't
  // reach a state change this way either.
  const { dir, binPath } = writeStubClaudeBin([
    { tool: 'publish_post', args: { id: postId } },
  ]);
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const result = await runAgent(db, { message: 'publish this post', brand_id: brandId });
    assert.equal(result.actions.length, 1);
    assert.ok(/unsupported/i.test(result.actions[0].summary));
    const postAfter = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
    assert.equal(postAfter.status, 'draft');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('update_draft_post refuses to edit a post that is no longer status draft', async () => {
  const db = getDb();
  const brandId = seedBrand(db);
  const now = nowIso();
  const info = db
    .prepare(
      `INSERT INTO posts (brand_id, platform, copy, media, platform_fields, status, created_at, updated_at)
       VALUES (?, 'linkedin', 'approved copy', '[]', '{}', 'approved', ?, ?)`
    )
    .run(brandId, now, now);
  const postId = info.lastInsertRowid;

  const result = await executeAction(db, { tool: 'update_draft_post', args: { id: postId, copy: 'hijacked copy' } });
  assert.ok(/can only edit drafts|only edit drafts/i.test(result.summary));

  const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
  assert.equal(post.copy, 'approved copy', 'copy must be untouched for a non-draft post');
});

test('runAgent throws a 503-flagged error when the CLI binary is missing', async () => {
  const db = getDb();
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-agent-test';
  try {
    await assert.rejects(
      () => runAgent(db, { message: 'hello' }),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});
