// Unit tests for src/extract.js (B11 — SPEC.md "Assisted-manual upgrade +
// blog redistribution"). extractFromUrl is tested by monkey-patching global
// fetch (no real network); extractFromImage's 503 contract is tested against
// a nonexistent CLI binary, and its happy path via a stub bin echoing a
// canned --output-format json envelope (no real CLI/model call). Hermetic.
//
// Run with: node --test test/extract.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractFromUrl,
  extractFromImage,
  buildImageExtractPrompt,
  parseImageExtractOutput,
} from '../src/extract.js';

function fakeFetchResponse({ ok = true, status = 200, statusText = 'OK', body = '' }) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
  };
}

test('extractFromUrl strips scripts/styles/head/comments, prefers <article>, decodes entities, parses title', async () => {
  const html = `
    <html>
      <head><title>My Great Post &amp; More</title><style>body{color:red}</style></head>
      <body>
        <script>console.log('nope')</script>
        <!-- a comment that should vanish -->
        <nav>Ignore this nav text too... wait, nav isn't stripped explicitly but article wins</nav>
        <article>
          <h1>Big Heading</h1>
          <p>First paragraph with &quot;quotes&quot; and a &nbsp;space.</p>
          <ul>
            <li>Item one</li>
            <li>Item two &lt;3</li>
          </ul>
          <p>Last paragraph.</p>
        </article>
      </body>
    </html>
  `;

  const prevFetch = global.fetch;
  global.fetch = async () => fakeFetchResponse({ body: html });
  try {
    const { title, markdown } = await extractFromUrl('https://example.com/post');
    assert.equal(title, 'My Great Post & More');
    assert.match(markdown, /# Big Heading/);
    assert.match(markdown, /First paragraph with "quotes" and a space\./);
    assert.match(markdown, /- Item one/);
    assert.match(markdown, /- Item two <3/);
    assert.ok(!/<(p|ul|li|h1|script|style)\b/i.test(markdown), 'tags should be stripped');
    assert.ok(!/console\.log/.test(markdown), 'script content should be stripped');
    assert.ok(!/color:red/.test(markdown), 'style content should be stripped');
    assert.ok(!/should vanish/.test(markdown), 'HTML comments should be stripped');
  } finally {
    global.fetch = prevFetch;
  }
});

test('extractFromUrl falls back to <main> then <body> when no <article> is present, and title falls back to <h1>', async () => {
  const prevFetch = global.fetch;

  global.fetch = async () => fakeFetchResponse({ body: '<html><body><main><h1>Main Heading</h1><p>Body text.</p></main></body></html>' });
  try {
    const { title, markdown } = await extractFromUrl('https://example.com/main-only');
    assert.equal(title, 'Main Heading', 'title falls back to first <h1> when there is no <title>');
    assert.match(markdown, /# Main Heading/);
    assert.match(markdown, /Body text\./);
  } finally {
    global.fetch = prevFetch;
  }

  global.fetch = async () => fakeFetchResponse({ body: '<html><body><p>Plain body only.</p></body></html>' });
  try {
    const { markdown } = await extractFromUrl('https://example.com/body-only');
    assert.match(markdown, /Plain body only\./);
  } finally {
    global.fetch = prevFetch;
  }
});

test('extractFromUrl throws a clear error on a non-OK response or a fetch failure', async () => {
  const prevFetch = global.fetch;

  global.fetch = async () => fakeFetchResponse({ ok: false, status: 404, statusText: 'Not Found', body: '' });
  try {
    await assert.rejects(() => extractFromUrl('https://example.com/missing'), /404/);
  } finally {
    global.fetch = prevFetch;
  }

  global.fetch = async () => {
    throw new Error('network unreachable');
  };
  try {
    await assert.rejects(() => extractFromUrl('https://example.com/down'), /network unreachable/);
  } finally {
    global.fetch = prevFetch;
  }
});

test('extractFromUrl caps output length and notes truncation', async () => {
  const prevFetch = global.fetch;
  const bigParagraphs = Array.from({ length: 2000 }, (_, i) => `<p>Paragraph number ${i} with some filler text.</p>`).join('\n');
  global.fetch = async () => fakeFetchResponse({ body: `<html><body><article>${bigParagraphs}</article></body></html>` });
  try {
    const { markdown } = await extractFromUrl('https://example.com/huge');
    assert.ok(markdown.length <= 12_000 + 200, 'output should be capped at ~12000 chars plus a short truncation note');
    assert.match(markdown, /truncated/);
  } finally {
    global.fetch = prevFetch;
  }
});

test('buildImageExtractPrompt references the image path and demands strict JSON', () => {
  const prompt = buildImageExtractPrompt('/tmp/some-screenshot.png');
  assert.match(prompt, /\/tmp\/some-screenshot\.png/);
  assert.match(prompt, /STRICT JSON/);
});

test('parseImageExtractOutput extracts {text} from the CLI envelope, stripping markdown fences', () => {
  const stdout = JSON.stringify({ result: '```json\n{"text": "hello world"}\n```' });
  const parsed = parseImageExtractOutput(stdout);
  assert.deepEqual(parsed, { text: 'hello world' });
});

test('extractFromImage throws a 503-flagged error when the CLI binary is missing', async () => {
  process.env.POSTDECK_CLAUDE_BIN = '/nonexistent/claude-binary-postdeck-test';
  try {
    await assert.rejects(
      () => extractFromImage('/tmp/some-screenshot.png'),
      (err) => {
        assert.equal(err.statusCode, 503);
        return true;
      }
    );
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
  }
});

test('extractFromImage happy path: parses {text} from a stub claude bin (one call, cache-worthy result)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-extract-'));
  const binPath = path.join(dir, 'claude-stub.js');
  const envelope = JSON.stringify({ result: JSON.stringify({ text: 'hello' }) });
  fs.writeFileSync(binPath, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(envelope)});\n`, { mode: 0o755 });

  process.env.POSTDECK_CLAUDE_BIN = binPath;
  try {
    const { text } = await extractFromImage('/tmp/some-screenshot.png');
    assert.equal(text, 'hello');
  } finally {
    delete process.env.POSTDECK_CLAUDE_BIN;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
