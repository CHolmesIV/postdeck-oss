// Grok via xAI's OpenAI-compatible chat-completions API. The one deliberate
// exception to "subscription CLI only": xAI has no CLI. Enabled only when
// XAI_API_KEY is set; otherwise absent from /api/ai/providers and the UI.
//
// To add another OpenAI-compatible vendor, copy this file, change name/label,
// the three env names and the default base URL, and list it in ./index.js.

import { chatComplete } from './_http.js';

const provider = {
  name: 'grok',
  label: 'Grok',
  kind: 'http',
  capabilities: { json: true, vision: false },
  get defaultModel() {
    return process.env.POSTDECK_GROK_MODEL || 'grok-4';
  },
  get base() {
    return process.env.POSTDECK_GROK_BASE || 'https://api.x.ai';
  },
  apiKey() {
    return process.env.XAI_API_KEY || '';
  },

  isConfigured() {
    return Boolean(provider.apiKey());
  },

  async complete({ prompt, model, timeoutMs, fetchImpl } = {}) {
    return chatComplete({
      base: provider.base,
      apiKey: provider.apiKey(),
      model: model || provider.defaultModel,
      prompt,
      timeoutMs,
      fetchImpl,
      label: 'Grok (xAI)',
    });
  },

  async authStatus() {
    const configured = provider.isConfigured();
    return {
      provider: 'grok',
      installed: configured,
      loggedIn: configured,
      detail: configured ? `API key configured (${provider.defaultModel})` : 'XAI_API_KEY not set',
    };
  },

  loginCommand() {
    return 'Set XAI_API_KEY in config/.env and restart PostDeck';
  },
  async login() {
    const err = new Error('Grok uses an API key. Set XAI_API_KEY in config/.env and restart PostDeck.');
    err.statusCode = 400;
    err.manualCommand = provider.loginCommand();
    throw err;
  },
};

export default provider;
