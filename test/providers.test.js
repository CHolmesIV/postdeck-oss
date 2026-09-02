// B23 provider layer: registry shape, Grok HTTP adapter via stubbed fetch,
// /api/ai/providers route, compare-any, origin guard, agent_provider setting.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';

const { runDraft, listProviders, invalidateStatusCache, configuredProviders, visionProviderName } = await import('../src/ai.js');
const { PROVIDERS, ALL } = await import('../src/providers/index.js');
const grok = (await import('../src/providers/grok.js')).default;
const { buildServer } = await import('../src/server.js');

function writeStub(name, envelope) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `postdeck-prov-${name}-`));
  const binPath = path.join(dir, `${name}-stub.js`);
  fs.writeFileSync(binPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`, { mode: 0o755 });
  return binPath;
}

test('registry lists claude, codex, grok with the common contract', () => {
  assert.deepEqual(ALL.map((p) => p.name), ['claude', 'codex', 'grok']);
  for (const p of ALL) {
    assert.equal(typeof p.label, 'string');
    assert.ok(['cli', 'http'].includes(p.kind));
    assert.equal(typeof p.isConfigured, 'function');
    assert.equal(typeof p.complete, 'function');
    assert.equal(typeof p.authStatus, 'function');
    assert.equal(typeof p.login, 'function');
    assert.equal(typeof p.capabilities, 'object');
  }
  assert.equal(PROVIDERS.grok.kind, 'http');
});

test('grok is unconfigured without XAI_API_KEY and runDraft 503s cleanly', async () => {
  delete process.env.XAI_API_KEY;
  assert.equal(grok.isConfigured(), false);
  assert.ok(!configuredProviders().some((p) => p.name === 'grok'));
  await assert.rejects(runDraft('grok', { prompt: 'x' }), (err) => err.statusCode === 503 && /not configured/i.test(err.message));
});

test('grok complete() posts an OpenAI-compatible body and returns message content', async () => {
  process.env.XAI_API_KEY = 'test-key';
  process.env.POSTDECK_GROK_MODEL = 'grok-test';
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"linkedin":"hi"}' } }] }), text: async () => '' };
  };
  try {
    const text = await runDraft('grok', { prompt: 'draft it', fetchImpl });
    assert.equal(text, '{"linkedin":"hi"}');
    assert.equal(seen.url, 'https://api.x.ai/v1/chat/completions');
    assert.equal(seen.init.headers.authorization, 'Bearer test-key');
    assert.equal(seen.body.model, 'grok-test');
    assert.equal(seen.body.messages[0].content, 'draft it');
    assert.ok(configuredProviders().some((p) => p.name === 'grok'));
  } finally {
    delete process.env.XAI_API_KEY;
    delete process.env.POSTDECK_GROK_MODEL;
  }
});

test('grok complete() surfaces a 503 on a rejected key', async () => {
  process.env.XAI_API_KEY = 'bad';
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'nope' });
  try {
    await assert.rejects(runDraft('grok', { prompt: 'x', fetchImpl }), (err) => err.statusCode === 503 && /rejected/i.test(err.message));
  } finally {
    delete process.env.XAI_API_KEY;
  }
});

test('vision provider is claude (only provider with vision capability)', () => {
  assert.equal(visionProviderName(), 'claude');
});

test('claude buildArgs honors tools option (vision path passes Read)', () => {
  const args = PROVIDERS.claude.buildArgs('p', { tools: 'Read' });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read');
  const def = PROVIDERS.claude.buildArgs('p');
  assert.equal(def[def.indexOf('--tools') + 1], '');
});

test('listProviders caches for 30s and ?fresh bypasses', async () => {
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-bin';
  process.env.POSTDECK_CODEX_BIN = '/nonexistent/codex-bin';
  try {
    invalidateStatusCache();
    const a = await listProviders();
    const b = await listProviders();
    assert.equal(a, b, 'same cached array instance');
    const c = await listProviders({ fresh: true });
    assert.notEqual(a, c);
    const claude = c.find((p) => p.name === 'claude');
    assert.equal(claude.status.installed, false);
    const g = c.find((p) => p.name === 'grok');
    assert.equal(g.configured, false);
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    delete process.env.POSTDECK_CODEX_BIN;
    invalidateStatusCache();
  }
});

test('GET /api/ai/providers returns the registry; /api/ai/status keeps claude/codex keys', async () => {
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-bin';
  process.env.POSTDECK_CODEX_BIN = '/nonexistent/codex-bin';
  const app = buildServer();
  try {
    invalidateStatusCache();
    const res = await app.inject({ method: 'GET', url: '/api/ai/providers?fresh=1' });
    assert.equal(res.statusCode, 200);
    const rows = res.json();
    assert.deepEqual(rows.map((r) => r.name), ['claude', 'codex', 'grok']);
    const st = await app.inject({ method: 'GET', url: '/api/ai/status' });
    const body = st.json();
    assert.ok(body.claude && body.codex);
    assert.equal(body.claude.installed, false);
  } finally {
    await app.close();
    delete process.env.POSTDECK_CLAUDE_BIN;
    delete process.env.POSTDECK_CODEX_BIN;
    invalidateStatusCache();
  }
});

test('origin guard: cross-origin POST is refused, same-origin and no-origin pass, bad Host refused', async () => {
  const app = buildServer();
  try {
    const evil = await app.inject({ method: 'POST', url: '/api/ideas', headers: { origin: 'https://evil.example', host: '127.0.0.1:4520' }, payload: { title: 'x' } });
    assert.equal(evil.statusCode, 403);
    assert.equal(evil.json().error, 'forbidden_origin');
    const same = await app.inject({ method: 'POST', url: '/api/ideas', headers: { origin: 'http://127.0.0.1:4520', host: '127.0.0.1:4520' }, payload: { title: 'ok' } });
    assert.equal(same.statusCode, 201);
    const none = await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'curl' } });
    assert.equal(none.statusCode, 201);
    const rebind = await app.inject({ method: 'GET', url: '/api/health', headers: { host: 'attacker.example:4520' } });
    assert.equal(rebind.statusCode, 403);
    assert.equal(rebind.json().error, 'forbidden_host');
    const evilGet = await app.inject({ method: 'GET', url: '/api/health', headers: { origin: 'https://evil.example' } });
    assert.equal(evilGet.statusCode, 200, 'GET with foreign Origin is harmless (CORS blocks the read)');
  } finally {
    await app.close();
  }
});

test('settings round-trips agent_provider and defaults it to draft_provider', async () => {
  const app = buildServer();
  try {
    const before = (await app.inject({ method: 'GET', url: '/api/settings' })).json();
    assert.equal(before.agent_provider, before.draft_provider);
    const upd = (await app.inject({ method: 'PATCH', url: '/api/settings', payload: { agent_provider: 'codex' } })).json();
    assert.equal(upd.agent_provider, 'codex');
    assert.equal(upd.draft_provider, before.draft_provider);
  } finally {
    await app.close();
  }
});

test('compare honors body.providers[] and keys the response by name', async () => {
  const bin = writeStub('claude', JSON.stringify({ result: '{"linkedin":"from stub"}' }));
  process.env.POSTDECK_CLAUDE_BIN = bin;
  const app = buildServer();
  try {
    const { getDb, nowIso } = await import('../src/db.js');
    const db = getDb();
    const now = nowIso();
    const b = db.prepare(`INSERT INTO brands (name, slug, active, created_at, updated_at) VALUES ('B','b-${Math.random()}',1,?,?)`).run(now, now);
    const t = db.prepare(`INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at) VALUES (?, 'business', '', '{}', ?, ?)`).run(b.lastInsertRowid, now, now);
    const res = await app.inject({
      method: 'POST',
      url: '/api/draft/compare',
      payload: { idea_text: 'i', brand_id: b.lastInsertRowid, tone_profile_id: t.lastInsertRowid, platforms: ['linkedin'], providers: ['claude'] },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body), ['claude']);
    assert.equal(body.claude.result.drafts.linkedin, 'from stub');
  } finally {
    await app.close();
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});
