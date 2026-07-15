// AI provider abstraction (B15 — SPEC.md "AI provider switcher"). A small
// registry keyed by provider name so a new provider (future) is a config
// entry, not a rewrite. Both current providers shell out to a subscription
// CLI already logged in on this machine — NEVER an API key.
//
// runDraft(provider, {prompt, model?, budget?}) -> Promise<string> resolving
// to the model's raw text response (unwrapped from whatever CLI-specific
// envelope/event-stream the provider uses). Throws a 503-flagged Error when
// the CLI binary is missing (ENOENT) or the CLI reports it isn't logged in.
//
// claude: `claude -p <prompt> --model <m> --max-budget-usd <b>
//   --output-format json`; envelope is `{"result": "<raw text>"}`.
//   Subscription login via `claude` / `/login`.
// codex: `codex exec --json <prompt>` — headless, prints a JSONL event
//   stream to stdout. We take the LAST `agent_message` event's `.text`
//   (tolerant of both a bare `{"type":"agent_message","text":...}` shape and
//   a `{"type":"item.completed","item":{"type":"agent_message","text":...}}`
//   shape, and of non-JSON lines interleaved in the stream — skipped).
//   ASSUMPTION (undocumented at build time, no `codex` CLI available to
//   introspect against): no read-only/sandbox flag is passed. `codex exec`
//   without a flag still requires a prompt-only response for our use (pure
//   text drafting, no file edits requested), but this is UNVERIFIED against
//   a real login — see SPEC.md B15 honesty note. If a real `codex --help`
//   later reveals a `--sandbox read-only` (or similar) flag, add it to
//   codex.buildArgs below; keep the parser as-is.
//   Reuses the saved Codex CLI login (ChatGPT/subscription) — no API key.

import { execFile, spawn } from 'node:child_process';

function make503(message) {
  const err = new Error(message);
  err.statusCode = 503;
  return err;
}

/**
 * Unwrap a `claude -p ... --output-format json` envelope and return the raw
 * text the model produced (still just text — the caller decides whether/how
 * to JSON.parse it for its own purposes). Throws (non-503) if the envelope
 * itself isn't valid JSON, and a 503-flagged error if the CLI reports it
 * isn't logged in.
 */
function parseClaudeEnvelope(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude CLI did not return valid JSON envelope: ${err.message}`);
  }
  const resultText = typeof outer.result === 'string' ? outer.result : stdout;
  if (/not logged in/i.test(resultText) || /\/login/i.test(resultText)) {
    throw make503('AI drafting unavailable: claude CLI is not logged in — run `claude` then `/login`.');
  }
  return resultText;
}

/**
 * Parse a `codex exec --json` JSONL event stream and return the text of the
 * LAST agent_message event (concatenated if the last message spans more
 * than one event of that type in a row — in practice codex emits one final
 * message, but we don't assume that). Non-JSON lines are skipped rather than
 * failing the whole parse (headless CLIs sometimes interleave banners/log
 * lines with the JSON events).
 */
function parseCodexStream(stdout) {
  const lines = String(stdout).split('\n');
  let lastText = null;
  let sawErrorEvent = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let evt;
    try {
      evt = JSON.parse(trimmed);
    } catch {
      continue; // tolerate non-JSON lines in the stream
    }
    if (!evt || typeof evt !== 'object') continue;

    if (evt.type === 'error' || evt.type === 'item.error') sawErrorEvent = true;

    // Two tolerated shapes: a bare agent_message event, or an
    // item.completed wrapper around an agent_message item.
    if (evt.type === 'agent_message' && typeof evt.text === 'string') {
      lastText = evt.text;
    } else if (
      evt.type === 'item.completed' &&
      evt.item &&
      evt.item.type === 'agent_message' &&
      typeof evt.item.text === 'string'
    ) {
      lastText = evt.item.text;
    }
  }

  if (lastText == null) {
    if (sawErrorEvent) {
      throw make503('AI drafting unavailable: codex CLI reported an error — run `codex login` and retry.');
    }
    throw make503(
      'AI drafting unavailable: codex CLI returned no agent message (not logged in? run `codex login`).'
    );
  }
  if (/not logged in/i.test(lastText) || /codex login/i.test(lastText)) {
    throw make503('AI drafting unavailable: codex CLI is not logged in — run `codex login`.');
  }
  return lastText;
}

const PROVIDERS = {
  claude: {
    binEnv: 'POSTDECK_CLAUDE_BIN',
    defaultBin: 'claude',
    buildArgs(prompt, { model, budget } = {}) {
      return [
        '-p',
        prompt,
        '--model',
        model || 'claude-haiku-4-5-20251001',
        '--max-budget-usd',
        String(budget ?? '0.05'),
        '--output-format',
        'json',
      ];
    },
    parse: parseClaudeEnvelope,
  },
  codex: {
    binEnv: 'POSTDECK_CODEX_BIN',
    defaultBin: 'codex',
    // Headless, JSON event stream, pure text response. See file-header note:
    // no sandbox/read-only flag added (unverified against a real codex
    // login) — model/budget are claude-specific and intentionally unused.
    buildArgs(prompt) {
      return ['exec', '--json', prompt];
    },
    parse: parseCodexStream,
  },
};

function getBin(providerName) {
  const provider = PROVIDERS[providerName];
  return process.env[provider.binEnv] || provider.defaultBin;
}

function runCli(providerName, args) {
  return new Promise((resolve, reject) => {
    execFile(
      getBin(providerName),
      args,
      {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
        // Close stdin (/dev/null) so `claude -p` doesn't sit for ~3s waiting
        // on stdin it never receives ("no stdin data received in 3s" warning)
        // when the prompt is passed as an argv arg. Removes per-draft latency.
        stdio: ['ignore', 'pipe', 'pipe'],
      },
      (err, stdout) => {
        if (err) {
          reject(Object.assign(new Error(err.message), { code: err.code }));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * @param {'claude'|'codex'} providerName
 * @param {{prompt: string, model?: string, budget?: string|number}} params
 * @returns {Promise<string>} the model's raw text response
 * @throws {Error & {statusCode?: number}} 503-flagged when the CLI is
 *   missing or not logged in.
 */
async function runDraft(providerName, { prompt, model, budget } = {}) {
  const provider = PROVIDERS[providerName];
  if (!provider) {
    throw make503(`AI drafting unavailable: unknown provider "${providerName}"`);
  }

  const args = provider.buildArgs(prompt, { model, budget });
  let stdout;
  try {
    stdout = await runCli(providerName, args);
  } catch (err) {
    const fix = providerName === 'codex' ? 'run `codex login`' : 'run `claude` then `/login`';
    throw make503(
      `AI drafting unavailable: could not run ${providerName} CLI (${
        err.code === 'ENOENT' ? 'not found on PATH' : err.message
      }) — ${fix}.`
    );
  }

  return provider.parse(stdout);
}

/**
 * Report whether a provider's CLI is installed and logged in, without
 * spending any tokens. For claude we call `claude auth status` (fast,
 * non-interactive, prints JSON `{loggedIn:boolean,...}`). For codex we only
 * check that the binary resolves (no cheap status probe assumed). Never
 * throws — returns a plain status object so the UI can render a pill.
 *
 * @returns {Promise<{provider:string, installed:boolean, loggedIn:boolean, detail?:string}>}
 */
function getAuthStatus(providerName) {
  const provider = PROVIDERS[providerName];
  if (!provider) return Promise.resolve({ provider: providerName, installed: false, loggedIn: false, detail: 'unknown provider' });
  const bin = getBin(providerName);

  if (providerName === 'claude') {
    return new Promise((resolve) => {
      execFile(bin, ['auth', 'status'], { timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }, (err, stdout) => {
        if (err && err.code === 'ENOENT') {
          resolve({ provider: 'claude', installed: false, loggedIn: false, detail: 'claude CLI not found on PATH' });
          return;
        }
        let loggedIn = false;
        try {
          const parsed = JSON.parse(String(stdout || '').trim());
          loggedIn = parsed && parsed.loggedIn === true;
        } catch {
          // Older CLIs print human text; fall back to a loose check.
          loggedIn = /logged in|authenticated/i.test(String(stdout || '')) && !/not logged in/i.test(String(stdout || ''));
        }
        resolve({ provider: 'claude', installed: true, loggedIn, detail: loggedIn ? 'logged in' : 'not logged in' });
      });
    });
  }

  // codex: only a presence check (no assumed status subcommand).
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }, (err) => {
      if (err && err.code === 'ENOENT') {
        resolve({ provider: 'codex', installed: false, loggedIn: false, detail: 'codex CLI not installed' });
        return;
      }
      // Installed; we can't cheaply confirm login, so report unknown-but-present.
      resolve({ provider: 'codex', installed: true, loggedIn: null, detail: 'installed (login unverified)' });
    });
  });
}

/**
 * Launch the provider's interactive login in a NEW macOS Terminal window so
 * the operator can complete the browser OAuth without typing anything. The
 * subscription flow is `claude auth login --claudeai` (NO API key). Returns
 * once the window has been asked to open; the caller then polls
 * getAuthStatus() (a "Recheck" button in the UI).
 *
 * macOS only (uses `open -a Terminal`). Throws a plain Error elsewhere so the
 * route can 400 with a "run it yourself" hint.
 */
async function startLogin(providerName, { platform = process.platform } = {}) {
  const bin = getBin(providerName);
  const loginCmd =
    providerName === 'codex'
      ? `${bin} login`
      : `${bin} auth login --claudeai`;

  if (platform !== 'darwin') {
    const err = new Error(`In-app login is macOS-only. Run \`${loginCmd}\` in a terminal.`);
    err.statusCode = 400;
    err.manualCommand = loginCmd;
    throw err;
  }

  return new Promise((resolve, reject) => {
    // `open -a Terminal` with a command requires a script file or AppleScript.
    // osascript keeps it dependency-free and pops a visible window running the
    // login command, which opens the browser for OAuth.
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
      resolve({ started: true, provider: providerName, command: loginCmd });
    });
  });
}

export { runDraft, PROVIDERS, parseClaudeEnvelope, parseCodexStream, getAuthStatus, startLogin };
