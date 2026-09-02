// Shared OpenAI-compatible chat-completions client for HTTP-kind providers
// (xAI/Grok today; OpenAI, OpenRouter, Ollama are the same 15-line file).
// Key comes from env only, is never logged, never reaches the browser.

import { make503, sleep } from './_cli.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

/**
 * @param {{base: string, apiKey: string, model: string, prompt: string,
 *   temperature?: number, maxTokens?: number, json?: boolean, timeoutMs?: number,
 *   fetchImpl?: typeof fetch, label?: string}} opts
 * @returns {Promise<string>} the assistant message text
 */
async function chatComplete({
  base,
  apiKey,
  model,
  prompt,
  temperature = 0.7,
  maxTokens = 4096,
  json = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
  label = 'provider',
}) {
  if (!apiKey) throw make503(`AI drafting unavailable: ${label} API key is not configured.`);
  const url = `${String(base).replace(/\/+$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    temperature,
    max_tokens: Math.min(maxTokens, 4096),
  };
  if (json) body.response_format = { type: 'json_object' };

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      lastErr = make503(`AI drafting unavailable: ${label} network error (${err.message}).`);
      if (attempt < MAX_ATTEMPTS) await sleep(600 * attempt);
      continue;
    }
    clearTimeout(timer);

    if (res.status === 401 || res.status === 403) {
      throw make503(`AI drafting unavailable: ${label} rejected the API key (${res.status}).`);
    }
    if (res.status === 429 || res.status >= 500) {
      const text = await res.text().catch(() => '');
      lastErr = make503(`AI drafting unavailable: ${label} returned ${res.status}${text ? ` (${text.slice(0, 120)})` : ''}.`);
      if (attempt < MAX_ATTEMPTS) await sleep(800 * attempt);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const err = new Error(`${label} API error ${res.status}: ${text.slice(0, 300)}`);
      err.statusCode = 502;
      throw err;
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw make503(`AI drafting unavailable: ${label} returned no message content.`);
    }
    return content;
  }
  throw lastErr || make503(`AI drafting unavailable: ${label} failed after ${MAX_ATTEMPTS} attempts.`);
}

export { chatComplete };
