// Claude via the `claude` subscription CLI (Claude Code). NO API key: reuses
// the operator's `claude auth login --claudeai` session in the macOS Keychain.

import { resolveBin, runCliWithRetry, probeCli, openTerminalLogin, make503 } from './_cli.js';

const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

/** Unwrap a `claude -p --output-format json` envelope to the model's raw text.
 * Throws (non-503) on a malformed envelope, 503 on not-logged-in / is_error. */
function parseClaudeEnvelope(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude CLI did not return valid JSON envelope: ${err.message}`);
  }
  const resultText = typeof outer.result === 'string' ? outer.result : stdout;
  if (/not logged in/i.test(resultText) || /\/login/i.test(resultText)) {
    throw make503('AI drafting unavailable: claude CLI is not logged in — use the "Log in to Claude" button, then Recheck.');
  }
  if (outer.is_error === true) {
    const subtype = outer.subtype || 'error';
    if (subtype === 'error_max_budget_usd') {
      throw make503('AI drafting unavailable: the request hit its cost cap. Try a shorter idea, or raise POSTDECK_DRAFT_BUDGET.');
    }
    throw make503(`AI drafting unavailable: claude CLI returned an error (${subtype}).`);
  }
  return resultText;
}

const provider = {
  name: 'claude',
  label: 'Claude',
  kind: 'cli',
  capabilities: { json: true, vision: true },
  get defaultModel() {
    return process.env.POSTDECK_DRAFT_MODEL || DEFAULT_MODEL;
  },
  binEnv: 'POSTDECK_CLAUDE_BIN',
  defaultBin: 'claude',
  fallbackBins: [],

  buildArgs(prompt, { model, budget, tools } = {}) {
    return [
      '-p',
      prompt,
      '--model',
      model || DEFAULT_MODEL,
      // `claude -p` is the full agentic Claude Code by default (reads files,
      // web-searches, loops) which blows --max-budget-usd. Drafting is one
      // completion: disable all tools. The vision path passes tools:'Read'
      // so the model can open the screenshot and nothing else.
      '--tools',
      tools || '',
      '--max-budget-usd',
      String(budget ?? '0.10'),
      '--output-format',
      'json',
    ];
  },
  parse: parseClaudeEnvelope,

  isConfigured() {
    return true;
  },

  async complete({ prompt, model, budget, tools, timeoutMs } = {}) {
    const stdout = await runCliWithRetry(resolveBin(provider), provider.buildArgs(prompt, { model, budget, tools }), {
      timeout: timeoutMs,
    });
    return parseClaudeEnvelope(stdout);
  },

  async authStatus() {
    const { enoent, stdout } = await probeCli(resolveBin(provider), ['auth', 'status']);
    if (enoent) return { provider: 'claude', installed: false, loggedIn: false, detail: 'claude CLI not found on PATH' };
    let loggedIn = false;
    try {
      const parsed = JSON.parse(stdout.trim());
      loggedIn = parsed && parsed.loggedIn === true;
    } catch {
      loggedIn = /logged in|authenticated/i.test(stdout) && !/not logged in/i.test(stdout);
    }
    return { provider: 'claude', installed: true, loggedIn, detail: loggedIn ? 'logged in' : 'not logged in' };
  },

  loginCommand() {
    return `${resolveBin(provider)} auth login --claudeai`;
  },
  async login(opts) {
    const r = await openTerminalLogin(provider.loginCommand(), opts);
    return { ...r, provider: 'claude' };
  },
};

export default provider;
export { parseClaudeEnvelope };
