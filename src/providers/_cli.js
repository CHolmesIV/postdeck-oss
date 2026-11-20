// Shared subprocess plumbing for CLI-kind providers (claude, codex).
// execFile only (never a shell), stdin closed immediately, bounded retry on
// transient failures. Provider modules own arg-building and output parsing.

import fs from 'node:fs';
import { execFile } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve the binary for a CLI provider: explicit env, then known bundled
 * app paths, then the bare name on PATH. */
function resolveBin(provider) {
  if (process.env[provider.binEnv]) return process.env[provider.binEnv];
  for (const candidate of provider.fallbackBins || []) {
    if (typeof candidate === 'string' && candidate.startsWith('/') && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return provider.defaultBin;
}

function runCli(bin, args, { timeout = 90_000 } = {}) {
  return new Promise((resolve, reject) => {
    // execFile has no `stdio` option; grab the child and end stdin so a CLI
    // that would otherwise wait on input (claude -p, codex exec) returns fast.
    const child = execFile(bin, args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // `claude --output-format json` prints a JSON envelope even on non-zero
      // exit (is_error / not logged in). Prefer it so the parser can surface a
      // clean message instead of a raw "Command failed".
      if (stdout && stdout.trim().startsWith('{')) {
        resolve(stdout);
        return;
      }
      if (err) {
        reject(Object.assign(new Error(stderr || err.message), { code: err.code }));
        return;
      }
      resolve(stdout);
    });
    if (child.stdin) child.stdin.end();
  });
}

// Transient failures (API overload, brief network blips) show up as a
// non-zero exit with no JSON envelope. ENOENT (binary missing) is final.
async function runCliWithRetry(bin, args, { attempts = 3, timeout } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await runCli(bin, args, { timeout });
    } catch (err) {
      lastErr = err;
      if (err.code === 'ENOENT') throw err;
      if (i < attempts - 1) await sleep(700 * (i + 1));
    }
  }
  throw lastErr;
}

/** Probe a CLI with a status subcommand; never throws. Returns raw stdout or
 * `{ enoent: true }` when the binary is missing. */
function probeCli(bin, args, { timeout = 15_000 } = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') {
        resolve({ enoent: true, stdout: '', stderr: '' });
        return;
      }
      resolve({ enoent: false, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Open a new macOS Terminal window running the provider's interactive login
 * (browser OAuth). macOS only; elsewhere throws a 400 with a manual command. */
function openTerminalLogin(loginCmd, { platform = process.platform } = {}) {
  if (platform !== 'darwin') {
    const err = new Error(`In-app login is macOS-only. Run \`${loginCmd}\` in a terminal.`);
    err.statusCode = 400;
    err.manualCommand = loginCmd;
    throw err;
  }
  return new Promise((resolve, reject) => {
    const osa = `tell application "Terminal"
  activate
  do script "${loginCmd.replace(/"/g, '\\"')}"
end tell`;
    execFile('osascript', ['-e', osa], { timeout: 15_000 }, (err) => {
      if (err) {
        const e = new Error(`Could not open Terminal for login: ${err.message}`);
        e.statusCode = 500;
        e.manualCommand = loginCmd;
        reject(e);
        return;
      }
      resolve({ started: true, command: loginCmd });
    });
  });
}

function make503(message) {
  const err = new Error(message);
  err.statusCode = 503;
  return err;
}

export { resolveBin, runCli, runCliWithRetry, probeCli, openTerminalLogin, make503, sleep };
