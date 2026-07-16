# Task: make the Codex provider a first-class, signed-in draft option

**Owner:** Codex (handoff task)  **Status:** open  **Written:** 2026-07-15

This is a self-contained brief. Everything you need to implement the Codex side
of PostDeck's AI drafting is here. It mirrors the Claude implementation that
already shipped, so use that as the reference pattern.

## Context

PostDeck drafts social copy by shelling out to a **subscription CLI** (never an
API key). There are two providers in a small registry in `src/ai.js`:

- `claude` - fully working. Signed in via `claude auth login --claudeai`.
- `codex` - stubbed/untested. **`codex` is not installed on the build machine**,
  so this path has never run against a real login.

The UI (Composer -> "Draft with AI", and the "Compare both" button) already
lets the operator pick `claude` or `codex`. Right now choosing Codex fails.

## What "done" looks like

1. `codex` provider drafts copy end-to-end from the Composer, on the operator's
   Codex/ChatGPT subscription (NO API key).
2. An in-app **status pill + "Log in to Codex" button + Recheck**, exactly like
   the Claude one, so the operator never needs a terminal.
3. `Compare both` shows real Claude vs Codex output side by side.
4. Tests cover the Codex arg-building, stream parsing, auth status, and login.

## The Claude pattern to mirror (already in the repo)

### `src/ai.js`
- `PROVIDERS.claude.buildArgs()` - builds the CLI argv. **Critical lesson:**
  `claude -p` runs the *full agentic* CLI (tools, multi-turn) and blows the cost
  cap, so we pass `--tools ""` to force a single completion. **Check whether
  `codex exec` has the same agentic behavior** and needs an equivalent
  "no tools / single-shot" flag. Run `codex exec --help` once signed in.
- `PROVIDERS.codex.buildArgs(prompt)` currently returns `['exec','--json',prompt]`
  - **verify this against a real `codex --help`.** Add any needed sandbox /
  no-tools / model flag.
- `parseCodexStream()` - parses the JSONL event stream, takes the last
  `agent_message`. Verify the real event shapes match (`agent_message` bare, and
  `item.completed`-wrapped). Adjust if the real stream differs.
- `getAuthStatus('codex')` - currently only checks the binary exists (returns
  `loggedIn: null`). Implement a real check: find the equivalent of
  `claude auth status` (maybe `codex login status` or a config file). Return
  `{installed, loggedIn, detail}`.
- `startLogin('codex', ...)` - already opens a Terminal running `codex login`.
  Confirm that's the correct command and that it completes the OAuth.

### `src/draft.js`
- `parseInnerJson()` is provider-agnostic and tolerant (strips fences, extracts
  the first balanced `{...}`, and `draftWithAi` retries once on parse failure).
  You likely don't need to change it - Codex should also be told "JSON only" via
  the shared `buildPrompt()`. If Codex needs a different prompt shape, branch in
  `buildPrompt` on provider rather than duplicating.

### Server (`src/server.js`)
- `GET /api/ai/status` already returns `{claude, codex}` from `getAuthStatus`.
- `POST /api/ai/login` already takes `{provider}` and calls `startLogin`.
- `POST /api/draft` and `POST /api/draft/compare` already accept `provider`.
  Compare runs both providers; make sure a Codex failure degrades gracefully
  (the compare column already renders a per-provider error).

### Frontend (`public/app.js`)
- The Claude status pill/login lives in `renderComposer` -> `refreshAiStatus()`
  (search for `ai-status-host`). Extend it to also show a **Codex** pill + a
  **"Log in to Codex"** button when `status.codex.installed && !loggedIn`, and
  "Codex not installed" otherwise. Keep it provider-generic if clean.
- The provider switch is `providerSwitch(...)` / `AI_PROVIDERS`.

## Key gotchas (learned the hard way on the Claude side)

1. **`execFile` has NO `stdio` option** - to close stdin (avoid the ~3s
   "no stdin data received" hang) you must grab the child and call
   `child.stdin.end()`. See `runCli` in `src/ai.js`.
2. **Agentic default blows the budget.** Whatever disables tools for `claude`
   (`--tools ""`) probably has a `codex exec` equivalent - find it, or the draft
   will loop and cost/time out.
3. **Detect error envelopes.** Don't let a CLI error object get parsed as if it
   were the drafts. Mirror the `is_error` handling in `parseClaudeEnvelope`.
4. **Cheap models return prose sometimes.** The tolerant parser + retry already
   handle this; keep the "JSON only, no tools, no file access" prompt guardrails.

## Verify before calling it done

- `npm test` green (add Codex-specific tests alongside `test/ai.test.js` and
  `test/ai-auth.test.js`).
- From the Composer: log in to Codex via the button, pick Codex, draft for
  linkedin+twitter, confirm real copy populates. Then `Compare both` shows both.
- Run several drafts in a row - no intermittent failures (retry/tolerance work).

## Definition-of-done (repo convention)

Update `CHANGELOG.md`, `BUILD_STATUS.md`, bump the test count, and follow the
ship checklist in `CONTRIBUTING.md`. This is the private repo (`working` branch)
- it's the system of record; the public `postdeck-oss` snapshot is refreshed
separately by hand.
