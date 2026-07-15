// Unit tests for src/ai.js (B15 — SPEC.md "AI provider switcher").
// Stubs both provider CLIs the way test/copy_assist.test.js mocks `claude`:
// a tiny node script written to a temp file, pointed at via
// POSTDECK_CLAUDE_BIN / POSTDECK_CODEX_BIN.
//
// Run with: node --test test/ai.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runDraft, PROVIDERS, parseClaudeEnvelope, parseCodexStream } from '../src/ai.js';

function writeStubBin(name, script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `postdeck-ai-${name}-`));
  const binPath = path.join(dir, `${name}-stub.js`);
  fs.writeFileSync(binPath, script, { mode: 0o755 });
  return { dir, binPath };
}

function writeStubClaudeBin(innerText) {
  const envelope = JSON.stringify({ result: innerText });
  return writeStubBin('claude', `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`);
}

function writeStubCodexBin(jsonlLines) {
  const stream = jsonlLines.join('\n');
  return writeStubBin('codex', `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stream)});\n`);
}

test('PROVIDERS registry has claude and codex with the expected shape', () => {
  assert.ok(PROVIDERS.claude);
  assert.ok(PROVIDERS.codex);
  for (const name of ['claude', 'codex']) {
    assert.equal(typeof PROVIDERS[name].binEnv, 'string');
    assert.equal(typeof PROVIDERS[name].defaultBin, 'string');
    assert.equal(typeof PROVIDERS[name].buildArgs, 'function');
    assert.equal(typeof PROVIDERS[name].parse, 'function');
  }
});

test('claude buildArgs shells `-p <prompt> --model <m> --max-budget-usd <b> --output-format json`', () => {
  const args = PROVIDERS.claude.buildArgs('hello world', { model: 'claude-haiku-4-5-20251001', budget: '0.05' });
  assert.deepEqual(args, [
    '-p',
    'hello world',
    '--model',
    'claude-haiku-4-5-20251001',
    '--max-budget-usd',
    '0.05',
    '--output-format',
    'json',
  ]);
});

test('codex buildArgs shells `exec --json <prompt>` (headless, no API key)', () => {
  const args = PROVIDERS.codex.buildArgs('hello world');
  assert.deepEqual(args, ['exec', '--json', 'hello world']);
});

test('parseClaudeEnvelope unwraps the outer .result to raw text', () => {
  const stdout = JSON.stringify({ result: '{"twitter": "drafted text"}' });
  assert.equal(parseClaudeEnvelope(stdout), '{"twitter": "drafted text"}');
});

test('runDraft(claude) returns the model raw text via a stubbed bin', async () => {
  const { dir, binPath } = writeStubClaudeBin('drafted text');
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const text = await runDraft('claude', { prompt: 'draft something', model: 'm', budget: '0.05' });
    assert.equal(text, 'drafted text');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parseCodexStream reads the JSONL stream and returns the final agent_message text', () => {
  const stdout = [
    '{"type":"session.created","session_id":"abc"}',
    'not json, a banner line the CLI printed',
    '{"type":"item.completed","item":{"type":"agent_message","text":"drafted text"}}',
  ].join('\n');
  assert.equal(parseCodexStream(stdout), 'drafted text');
});

test('parseCodexStream skips non-JSON lines and takes the LAST agent_message when multiple appear', () => {
  const stdout = [
    'garbage line 1',
    '{"type":"agent_message","text":"first draft, superseded"}',
    'garbage line 2 {not json',
    '{"type":"item.completed","item":{"type":"agent_message","text":"final draft"}}',
  ].join('\n');
  assert.equal(parseCodexStream(stdout), 'final draft');
});

test('parseCodexStream throws a 503-flagged error when no agent_message is found', () => {
  const stdout = ['{"type":"session.created","session_id":"abc"}', 'no agent message here'].join('\n');
  assert.throws(() => parseCodexStream(stdout), (err) => {
    assert.equal(err.statusCode, 503);
    return true;
  });
});

test('runDraft(codex) returns the model raw text via a stubbed bin, tolerating non-JSON lines', async () => {
  const { dir, binPath } = writeStubCodexBin([
    '{"type":"session.created","session_id":"abc"}',
    'a stray banner line',
    '{"type":"item.completed","item":{"type":"agent_message","text":"drafted text"}}',
  ]);
  process.env.POSTDECK_CODEX_BIN = binPath;
  try {
    const text = await runDraft('codex', { prompt: 'draft something' });
    assert.equal(text, 'drafted text');
  } finally {
    delete process.env.POSTDECK_CODEX_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runDraft(claude) throws a 503-flagged error when the bin is missing', async () => {
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    await assert.rejects(
      () => runDraft('claude', { prompt: 'x' }),
      (err) => {
        assert.equal(err.statusCode, 503);
        assert.match(err.message, /claude/i);
        return true;
      }
    );
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});

test('runDraft(codex) throws a 503-flagged error when the bin is missing', async () => {
  process.env.POSTDECK_CODEX_BIN = '/nonexistent/codex-binary-postdeck-test';
  try {
    await assert.rejects(
      () => runDraft('codex', { prompt: 'x' }),
      (err) => {
        assert.equal(err.statusCode, 503);
        assert.match(err.message, /codex/i);
        return true;
      }
    );
  } finally {
    delete process.env.POSTDECK_CODEX_BIN;
  }
});

test('runDraft throws a 503-flagged error for an unknown provider', async () => {
  await assert.rejects(
    () => runDraft('bogus-provider', { prompt: 'x' }),
    (err) => {
      assert.equal(err.statusCode, 503);
      return true;
    }
  );
});

test('runDraft(claude) surfaces a 503 when the CLI reports it is not logged in', async () => {
  const { dir, binPath } = writeStubClaudeBin('Not logged in. Please run /login to continue.');
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    await assert.rejects(
      () => runDraft('claude', { prompt: 'x' }),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
