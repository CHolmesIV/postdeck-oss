// AI provider facade. Every AI call in PostDeck goes through runDraft(); the
// vendors live in src/providers/ (one file each) and are registered in
// src/providers/index.js. Public API here is stable - draft.js,
// copy_assist.js, agent.js, profiles.js, inspiration.js, extract.js and the
// tests in test/ai*.test.js depend on these names.

import { PROVIDERS, ALL, getProvider, configuredProviders, providerWithCapability } from './providers/index.js';
import { resolveBin, make503 } from './providers/_cli.js';
import { parseClaudeEnvelope } from './providers/claude.js';
import { parseCodexStream } from './providers/codex.js';

/** Binary a CLI provider will run (env override > bundled app > PATH). */
function getBin(providerName) {
  const p = getProvider(providerName);
  if (!p || p.kind !== 'cli') return null;
  return resolveBin(p);
}

/**
 * @param {string} providerName  'claude' | 'codex' | 'grok' | ...
 * @param {{prompt: string, model?: string, budget?: string|number, timeoutMs?: number, fetchImpl?: typeof fetch}} params
 * @returns {Promise<string>} the model's raw text response
 * @throws {Error & {statusCode?: number}} 503 when the provider is missing,
 *   not configured, not logged in, or unknown.
 */
async function runDraft(providerName, { prompt, model, budget, tools, timeoutMs, fetchImpl } = {}) {
  const p = getProvider(providerName);
  if (!p) throw make503(`AI drafting unavailable: unknown provider "${providerName}"`);
  if (!p.isConfigured()) {
    throw make503(`AI drafting unavailable: ${p.label} is not configured (${p.loginCommand ? p.loginCommand() : 'see .env.example'}).`);
  }
  try {
    return await p.complete({ prompt, model, budget, tools, timeoutMs, fetchImpl });
  } catch (err) {
    if (err && err.statusCode) throw err; // already a clean provider error
    const fix = p.kind === 'cli'
      ? providerName === 'codex' ? 'run `codex login`' : 'sign in with the "Log in to Claude" button'
      : 'check the API key in config/.env';
    throw make503(
      `AI drafting unavailable: could not run ${providerName} (${err.code === 'ENOENT' ? 'not found on PATH' : err.message}) — ${fix}.`
    );
  }
}

/** Never throws. */
async function getAuthStatus(providerName) {
  const p = getProvider(providerName);
  if (!p) return { provider: providerName, installed: false, loggedIn: false, detail: 'unknown provider' };
  try {
    return { ...(await p.authStatus()), kind: p.kind };
  } catch (err) {
    return { provider: providerName, installed: false, loggedIn: false, detail: err.message, kind: p.kind };
  }
}

// /api/ai/providers hits this on every Composer render; auth probes spawn a
// CLI each. Cache briefly; `fresh` bypasses (Recheck button).
const STATUS_TTL_MS = 30_000;
let statusCache = { at: 0, rows: null };

/**
 * Full provider list for the UI: configured flag + auth status per provider.
 * Unconfigured providers (no API key) are included with configured:false so
 * Settings can explain how to enable them; the frontend hides them.
 */
async function listProviders({ fresh = false } = {}) {
  if (!fresh && statusCache.rows && Date.now() - statusCache.at < STATUS_TTL_MS) return statusCache.rows;
  const rows = await Promise.all(
    ALL.map(async (p) => ({
      name: p.name,
      label: p.label,
      kind: p.kind,
      configured: p.isConfigured(),
      capabilities: p.capabilities,
      defaultModel: p.defaultModel,
      status: p.isConfigured() ? await getAuthStatus(p.name) : { installed: false, loggedIn: false, detail: 'not configured', kind: p.kind },
    }))
  );
  statusCache = { at: Date.now(), rows };
  return rows;
}

function invalidateStatusCache() {
  statusCache = { at: 0, rows: null };
}

async function startLogin(providerName, opts = {}) {
  const p = getProvider(providerName);
  if (!p) {
    const err = new Error(`unknown provider "${providerName}"`);
    err.statusCode = 404;
    throw err;
  }
  const r = await p.login(opts);
  invalidateStatusCache();
  return r;
}

/** Name of the first configured provider that can read images (vision). */
function visionProviderName() {
  const p = providerWithCapability('vision');
  return p ? p.name : 'claude';
}

export {
  runDraft,
  PROVIDERS,
  parseClaudeEnvelope,
  parseCodexStream,
  getAuthStatus,
  startLogin,
  getBin,
  listProviders,
  invalidateStatusCache,
  configuredProviders,
  visionProviderName,
};
