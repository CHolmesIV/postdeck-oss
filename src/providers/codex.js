// Codex via the `codex` subscription CLI (ChatGPT login). NO API key.
// `codex exec` is agentic by default; constrained to a single read-only,
// ephemeral turn. Verified against codex-cli 0.144.2.

import { resolveBin, runCliWithRetry, probeCli, openTerminalLogin, make503 } from './_cli.js';

/** Parse a `codex exec --json` JSONL stream; return the LAST agent_message
 * text. Non-JSON lines are skipped. 503 when no message / not logged in. */
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
      continue;
    }
    if (!evt || typeof evt !== 'object') continue;
    if (evt.type === 'error' || evt.type === 'item.error') sawErrorEvent = true;
    if (evt.type === 'agent_message' && typeof evt.text === 'string') {
      lastText = evt.text;
    } else if (evt.type === 'item.completed' && evt.item && evt.item.type === 'agent_message' && typeof evt.item.text === 'string') {
      lastText = evt.item.text;
    }
  }
  if (lastText == null) {
    if (sawErrorEvent) throw make503('AI drafting unavailable: codex CLI reported an error — run `codex login` and retry.');
    throw make503('AI drafting unavailable: codex CLI returned no agent message (not logged in? run `codex login`).');
  }
  if (/not logged in/i.test(lastText) || /codex login/i.test(lastText)) {
    throw make503('AI drafting unavailable: codex CLI is not logged in — run `codex login`.');
  }
  return lastText;
}

const provider = {
  name: 'codex',
  label: 'Codex',
  kind: 'cli',
  capabilities: { json: true, vision: false },
  get defaultModel() {
    return process.env.POSTDECK_CODEX_MODEL || null; // CLI picks its own default
  },
  binEnv: 'POSTDECK_CODEX_BIN',
  defaultBin: 'codex',
  fallbackBins: ['/Applications/ChatGPT.app/Contents/Resources/codex', '/Applications/Codex.app/Contents/MacOS/codex'],

  buildArgs(prompt, { model } = {}) {
    const args = ['exec', '--json', '-s', 'read-only', '--skip-git-repo-check', '--ephemeral'];
    const m = model || provider.defaultModel;
    if (m) args.push('-m', m);
    args.push(prompt);
    return args;
  },
  parse: parseCodexStream,

  isConfigured() {
    return true;
  },

  async complete({ prompt, model, timeoutMs } = {}) {
    const stdout = await runCliWithRetry(resolveBin(provider), provider.buildArgs(prompt, { model }), { timeout: timeoutMs });
    return parseCodexStream(stdout);
  },

  async authStatus() {
    const { enoent, stdout, stderr } = await probeCli(resolveBin(provider), ['login', 'status'], { timeout: 10_000 });
    if (enoent) return { provider: 'codex', installed: false, loggedIn: false, detail: 'codex CLI not installed' };
    const text = (stdout || stderr || '').trim();
    const loggedIn = /logged in/i.test(text) && !/not logged in/i.test(text);
    return { provider: 'codex', installed: true, loggedIn, detail: text || (loggedIn ? 'logged in' : 'not logged in') };
  },

  loginCommand() {
    return `${resolveBin(provider)} login`;
  },
  async login(opts) {
    const r = await openTerminalLogin(provider.loginCommand(), opts);
    return { ...r, provider: 'codex' };
  },
};

export default provider;
export { parseCodexStream };
