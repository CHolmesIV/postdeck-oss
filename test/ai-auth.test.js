// Unit tests for the AI auth helpers in src/ai.js: getAuthStatus() parses
// `claude auth status` JSON, and startLogin() refuses (with a manual-command
// hint) on non-macOS. Uses a tiny stub binary for `claude` so no real CLI or
// login is touched.
//
// Run with: node --test test/ai-auth.test.js

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cliDir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-aiauth-'));

// Stub `claude`: `claude auth status` -> prints {loggedIn} from an env flag;
// anything else exits 0 with empty output.
const stubPath = path.join(cliDir, 'claude-stub.js');
fs.writeFileSync(
  stubPath,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write(JSON.stringify({ loggedIn: process.env.STUB_LOGGED_IN === '1', authMethod: 'none' }));
  process.exit(0);
}
process.exit(0);
`,
  { mode: 0o755 }
);
process.env.POSTDECK_CLAUDE_BIN = stubPath;

const { getAuthStatus, startLogin } = await import('../src/ai.js');

test('getAuthStatus reports logged-in when claude auth status says so', async () => {
  process.env.STUB_LOGGED_IN = '1';
  const s = await getAuthStatus('claude');
  assert.equal(s.installed, true);
  assert.equal(s.loggedIn, true);
});

test('getAuthStatus reports not-logged-in otherwise', async () => {
  process.env.STUB_LOGGED_IN = '0';
  const s = await getAuthStatus('claude');
  assert.equal(s.installed, true);
  assert.equal(s.loggedIn, false);
});

test('getAuthStatus reports not-installed when the bin is missing', async () => {
  const prev = process.env.POSTDECK_CLAUDE_BIN;
  process.env.POSTDECK_CLAUDE_BIN = path.join(cliDir, 'does-not-exist-xyz');
  const s = await getAuthStatus('claude');
  assert.equal(s.installed, false);
  assert.equal(s.loggedIn, false);
  process.env.POSTDECK_CLAUDE_BIN = prev;
});

test('startLogin refuses on non-macOS with a manual command hint', async () => {
  await assert.rejects(
    () => startLogin('claude', { platform: 'linux' }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.manualCommand, /auth login --claudeai/);
      return true;
    }
  );
});
