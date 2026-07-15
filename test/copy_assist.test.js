// Unit tests for src/copy_assist.js (B8 — SPEC.md "Copy assistant").
// Mocks the claude CLI the way test/blotato.mock.test.js mocks its
// dependency: POSTDECK_CLAUDE_BIN points at a tiny stub script written to a
// temp file that echoes a canned --output-format json envelope.
// Run with: node --test test/copy_assist.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { copyAssist, buildCopyAssistPrompt, parseClaudeCliOutput, MODES } from '../src/copy_assist.js';

const brand = { name: 'Di-Hy AI Consulting' };
const toneProfile = {
  name: 'business',
  voice_rules: 'Direct, no fluff.',
  hard_rules: JSON.stringify({ no_em_dash: true, banned_words: ['synergy'] }),
};

/**
 * Write a stub "claude" CLI that ignores its args and prints a canned
 * --output-format json envelope: {"result": "<inner JSON string>"}.
 */
function writeStubClaudeBin(innerJsonString) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-copyassist-'));
  const binPath = path.join(dir, 'claude-stub.js');
  const envelope = JSON.stringify({ result: innerJsonString });
  fs.writeFileSync(
    binPath,
    `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`,
    { mode: 0o755 }
  );
  return { dir, binPath };
}

test('buildCopyAssistPrompt rejects an unknown mode', () => {
  assert.throws(() => buildCopyAssistPrompt({ mode: 'bogus' }), /unknown mode/);
});

test('buildCopyAssistPrompt builds mode-specific prompts including brand voice + grounding', () => {
  for (const mode of MODES) {
    const prompt = buildCopyAssistPrompt({
      mode,
      idea_text: 'Launch our new AI ops offering',
      brand,
      toneProfile,
      platforms: ['instagram', 'twitter'],
      image_path: '/media/di-hy/launch-hero.png',
      grounding: 'Question-hooks outperform statements for this brand.',
    });
    assert.ok(prompt.includes(brand.name), `${mode} prompt should include brand name`);
    assert.ok(prompt.includes('Question-hooks outperform statements'), `${mode} prompt should include grounding`);
    assert.ok(prompt.includes('STRICT JSON'), `${mode} prompt should demand strict JSON`);
  }
});

test('parseClaudeCliOutput extracts inner JSON from the CLI envelope', () => {
  const stdout = JSON.stringify({ result: '{"headlines": ["A", "B"]}' });
  const parsed = parseClaudeCliOutput(stdout);
  assert.deepEqual(parsed, { headlines: ['A', 'B'] });
});

test('parseClaudeCliOutput strips markdown fences from the inner result', () => {
  const stdout = JSON.stringify({ result: '```json\n{"alt_text": "a description"}\n```' });
  const parsed = parseClaudeCliOutput(stdout);
  assert.deepEqual(parsed, { alt_text: 'a description' });
});

test('copyAssist headlines mode: parses result and scrubs an em-dash', async () => {
  const { dir, binPath } = writeStubClaudeBin(
    JSON.stringify({ headlines: ['Ship it — now, or never', 'Clean headline here'] })
  );
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const { result, scrub_applied } = await copyAssist({
      mode: 'headlines',
      idea_text: 'Launch post',
      brand,
      toneProfile,
    });
    assert.equal(result.headlines.length, 2);
    assert.ok(!/—/.test(result.headlines[0]), 'em-dash must be scrubbed from headline');
    assert.ok(scrub_applied.includes('no_em_dash'));
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copyAssist alt_text mode: parses a single alt_text string', async () => {
  const { dir, binPath } = writeStubClaudeBin(
    JSON.stringify({ alt_text: 'A laptop on a desk with a coffee cup nearby.' })
  );
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const { result } = await copyAssist({
      mode: 'alt_text',
      copy: 'Our new workflow in action.',
      image_path: '/media/di-hy/laptop.png',
      brand,
      toneProfile,
    });
    assert.equal(typeof result.alt_text, 'string');
    assert.ok(result.alt_text.length > 0);
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copyAssist hashtags mode: returns a per-platform hashtags object', async () => {
  const { dir, binPath } = writeStubClaudeBin(
    JSON.stringify({
      hashtags: {
        instagram: ['#aiops', '#consulting', '#automation'],
        twitter: ['#ai'],
      },
    })
  );
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const { result } = await copyAssist({
      mode: 'hashtags',
      copy: 'Our new workflow in action.',
      platforms: ['instagram', 'twitter'],
      brand,
      toneProfile,
    });
    assert.ok(Array.isArray(result.hashtags.instagram));
    assert.ok(Array.isArray(result.hashtags.twitter));
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copyAssist all mode: combines headlines, alt_text, and hashtags, scrubbing every string', async () => {
  const { dir, binPath } = writeStubClaudeBin(
    JSON.stringify({
      headlines: ['Leverage synergy — win big', 'Second headline'],
      alt_text: 'A dashboard screenshot with charts.',
      hashtags: { instagram: ['#growth', '#ai'] },
    })
  );
  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const { result, scrub_applied } = await copyAssist({
      mode: 'all',
      idea_text: 'Launch post',
      platforms: ['instagram'],
      image_path: '/media/dashboard.png',
      brand,
      toneProfile,
    });
    assert.equal(result.headlines.length, 2);
    assert.ok(!/synergy/i.test(result.headlines[0]), 'banned word must be scrubbed');
    assert.ok(!/—/.test(result.headlines[0]), 'em-dash must be scrubbed');
    assert.equal(typeof result.alt_text, 'string');
    assert.ok(Array.isArray(result.hashtags.instagram));
    assert.ok(scrub_applied.includes('no_em_dash'));
    assert.ok(scrub_applied.some((r) => r.startsWith('banned_word:synergy')));
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('copyAssist throws a 503-flagged error when the CLI binary is missing', async () => {
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    await assert.rejects(
      () => copyAssist({ mode: 'headlines', idea_text: 'x', brand, toneProfile }),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});
