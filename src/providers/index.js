// Provider registry. Order here is display order. Adding a vendor = one file
// in this folder + one line below (see docs/PROVIDER_LAYER_SPEC.md).

import claude from './claude.js';
import codex from './codex.js';
import grok from './grok.js';

const ALL = [claude, codex, grok];
const PROVIDERS = Object.fromEntries(ALL.map((p) => [p.name, p]));

function getProvider(name) {
  return PROVIDERS[name] || null;
}

/** Providers that can be offered to the operator right now. */
function configuredProviders() {
  return ALL.filter((p) => p.isConfigured());
}

/** First configured provider with the given capability (e.g. 'vision'). */
function providerWithCapability(cap) {
  return configuredProviders().find((p) => p.capabilities && p.capabilities[cap]) || null;
}

export { ALL, PROVIDERS, getProvider, configuredProviders, providerWithCapability };
