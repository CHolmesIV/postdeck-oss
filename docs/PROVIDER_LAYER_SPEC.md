# Provider layer spec - one entry point for every AI vendor

Written 2026-09-02 from `docs/AUDIT_2026-09-02.md` findings O1-O6. Status: **building**.

## Problem

`src/ai.js` is a registry that only two of six AI call sites use. Adding a third vendor today
touches `ai.js`, `server.js` (status + compare), `public/app.js` (two hardcoded lists), and
leaves the chat agent, profiles, inspiration and vision paths on Claude regardless of the
Settings switch. There is no adapter kind for an HTTP API vendor, which is what Grok is.

## Design

One module per provider under `src/providers/`, all exporting the same shape. `src/ai.js`
becomes a thin registry over them and keeps its existing public API so nothing downstream
changes signature.

```
src/providers/
  _cli.js               shared runCli/runCliWithRetry (execFile, stdin closed, retry on transient)
  _http.js              shared OpenAI-compatible chat-completions client (fetch, timeout, retry)
  claude.js             kind 'cli'  - `claude -p` subscription CLI (unchanged behavior)
  codex.js              kind 'cli'  - `codex exec --json` subscription CLI (unchanged behavior)
  grok.js               kind 'http' - xAI, OpenAI-compatible, XAI_API_KEY
  index.js              PROVIDERS map + ordering + listProviders()
```

### Provider contract

```js
export default {
  name: 'grok',                 // stable id used in settings + API
  label: 'Grok',                // UI label
  kind: 'http' | 'cli',
  capabilities: { json: true, vision: false },
  defaultModel: 'grok-4',       // overridable by env
  // CLI-only (kept for tests + getBin): binEnv, defaultBin, fallbackBins, buildArgs(prompt,{model,budget}), parse(stdout)
  async complete({ prompt, model, budget, timeoutMs }) -> string   // raw model text
  async authStatus() -> { provider, installed, loggedIn, detail, kind }
  async login({ platform }) -> { started, command } | throws { statusCode, manualCommand }
  isConfigured() -> boolean     // http: key present; cli: always true (bin may still be missing)
}
```

`runDraft(providerName, { prompt, model, budget })` in `ai.js` resolves the provider and calls
`complete`. `getAuthStatus`, `startLogin`, `getBin`, `PROVIDERS`, `parseClaudeEnvelope`,
`parseCodexStream` stay exported with identical behavior (test/ai.test.js, test/ai-auth.test.js
pin them).

### HTTP kind (Grok and anything OpenAI-compatible)

- `POST {base}/v1/chat/completions` with `Authorization: Bearer <key>`, body
  `{ model, messages:[{role:'user',content:prompt}], temperature, max_tokens, response_format? }`.
  Returns `choices[0].message.content`.
- Env: `XAI_API_KEY` (required to enable), `POSTDECK_GROK_MODEL` (default `grok-4`),
  `POSTDECK_GROK_BASE` (default `https://api.x.ai`).
- This is the one deliberate exception to "no API keys": xAI has no subscription CLI. The key
  lives in `.env`, is never sent to the browser, and the provider is simply absent from the UI
  when the key is unset. Any future OpenAI-compatible vendor (OpenAI, Ollama, OpenRouter) is a
  15-line file that sets name/label/env names and reuses `_http.js`.
- Retry: 2 retries on 429/5xx/network with backoff. Timeout 60 s. `budget` is ignored (no
  per-call cost cap in the API); `max_tokens` is capped at 4096.

### Migration of the four stragglers

`agent.js`, `profiles.js`, `inspiration.js`, `extract.js` drop their private `runClaudeCli`
and call `runDraft(provider, ...)`. Each keeps its exported parser for back-compat tests, but
the runtime path goes through the registry. Provider selection:

- drafting, copy-assist, profiles, inspiration: `draft_provider` setting (existing).
- chat agent: new `agent_provider` setting, default follows `draft_provider`.
- vision (`extract.js`): first provider with `capabilities.vision` (Claude today).

### API

- `GET /api/ai/providers` -> `[{name,label,kind,configured,capabilities,defaultModel,status:{installed,loggedIn,detail}}]`.
  Status is cached 30 s server-side; `?fresh=1` bypasses (Recheck button).
- `GET /api/ai/status` -> unchanged shape for claude/codex plus every other provider keyed by name.
- `POST /api/draft/compare` accepts optional `providers: string[]`; default is every configured
  provider. Response keyed by provider name (claude/codex keys unchanged).
- `PATCH /api/settings` accepts `agent_provider`.

### Frontend

`AI_PROVIDERS` is loaded from `/api/ai/providers` at bootstrap into `state.providers`; the
provider switch, compare grid, status pills and both Settings selects render from it. A
provider whose `configured` is false is not shown.

### Adding provider number four

1. Copy `src/providers/grok.js` to `src/providers/<name>.js`, change name/label/env names/base URL.
2. Add it to the array in `src/providers/index.js`.
3. Add its env var to `.env.example`.
That is the whole procedure. No server route, no frontend edit.

## Verification

- `npm test` green (existing 317 + new tests: grok complete via stubbed fetch, registry shape,
  providers route, compare with `providers[]`, agent honors `agent_provider`).
- Live: `/api/ai/providers` lists claude (logged in), codex, and grok only if `XAI_API_KEY` set.
- Composer: provider switch shows the same set; Compare runs them all.
