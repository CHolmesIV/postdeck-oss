// Rsync state/social-state.json to the Agentic OS VPS (B5 bridge). See
// SPEC.md "Worker" item 3. One-way, read-only on the VPS side. Called by the
// worker after every export, rate-limited to once per 15 minutes. Also
// runnable directly: `node src/sync.js`.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { STATE_FILE } from './export.js';

const execFileAsync = promisify(execFile);

const DEFAULT_HOST = '';
const DEFAULT_USER = 'root';
const DEFAULT_REMOTE_PATH = '/path/to/state/social.json';
const DEFAULT_KEY = path.join(os.homedir(), '.ssh', 'id_ed25519');

const RATE_LIMIT_MS = 15 * 60 * 1000;
let lastSyncAt = 0;

function syncEnabled() {
  const v = process.env.POSTDECK_SYNC_ENABLED;
  // Opt-in: off unless explicitly enabled (public default; set POSTDECK_SYNC_ENABLED=1).
  if (v === undefined || v === null || v === '') return false;
  return !['0', 'false'].includes(String(v).toLowerCase());
}

function getSyncConfig() {
  const target = process.env.POSTDECK_SYNC_TARGET; // e.g. root@host:/path/to/state/social.json
  let user = process.env.POSTDECK_SYNC_USER || DEFAULT_USER;
  let host = process.env.POSTDECK_SYNC_HOST || DEFAULT_HOST;
  let remotePath = process.env.POSTDECK_SYNC_PATH || DEFAULT_REMOTE_PATH;
  const key = process.env.POSTDECK_SYNC_KEY || DEFAULT_KEY;

  if (target) {
    const m = target.match(/^([^@]+)@([^:]+):(.+)$/);
    if (m) {
      user = m[1];
      host = m[2];
      remotePath = m[3];
    }
  }

  return { user, host, remotePath, key };
}

/**
 * Rsync the exported state file to the VPS, unless disabled/unconfigured or
 * within the rate-limit window. Returns a result object; never throws.
 */
async function syncSocialState({ force = false } = {}) {
  if (!syncEnabled()) {
    console.log('[sync] POSTDECK_SYNC_ENABLED=0 - skipping');
    return { ok: false, skipped: true, reason: 'disabled' };
  }

  const { user, host, remotePath, key } = getSyncConfig();
  if (!host || !remotePath) {
    console.log('[sync] no sync target configured - skipping');
    return { ok: false, skipped: true, reason: 'unconfigured' };
  }

  const now = Date.now();
  if (!force && now - lastSyncAt < RATE_LIMIT_MS) {
    return { ok: false, skipped: true, reason: 'rate_limited' };
  }

  if (!fs.existsSync(STATE_FILE)) {
    console.log(`[sync] ${STATE_FILE} does not exist - skipping (run export first)`);
    return { ok: false, skipped: true, reason: 'no_state_file' };
  }

  if (!fs.existsSync(key)) {
    console.log(`[sync] ssh key ${key} not found - skipping`);
    return { ok: false, skipped: true, reason: 'no_key' };
  }

  const dest = `${user}@${host}:${remotePath}`;
  const sshCmd = `ssh -i ${key} -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10`;

  try {
    await execFileAsync('rsync', ['-az', '-e', sshCmd, STATE_FILE, dest], { timeout: 30000 });
    lastSyncAt = now;
    console.log(`[sync] pushed ${STATE_FILE} -> ${dest}`);
    return { ok: true, dest };
  } catch (err) {
    console.error(`[sync] rsync failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

export { syncSocialState, syncEnabled, getSyncConfig, RATE_LIMIT_MS };

// CLI entrypoint: `node src/sync.js` (forces the sync, ignoring the
// 15-min rate limit, so a manual run always fires).
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  syncSocialState({ force: true }).then((result) => {
    if (!result.ok) {
      console.error('[sync] result:', result);
      process.exitCode = result.skipped ? 0 : 1;
    }
  });
}
