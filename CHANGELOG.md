# PostDeck Changelog

Rolling changelog. Newest first. See `SPEC.md` for full design and `BUILD_STATUS.md` for
current state / what's pending.

## 2026-07-15 - Calendar: click a day to schedule

- Click an empty part of any day cell to jump to the Composer with "Publish at" prefilled to
  that date (09:00 local), carrying the calendar's brand filter. A subtle "+" appears on hover.
  Clicks on an existing post chip still open that post's detail.
- Day cells grow with content (min-height is a floor, not a cap), so days with several posts
  get taller instead of cramped.

## 2026-07-15 - Calendar: real month view + month navigation

- Calendar/Queue now defaults to a **proper month grid**: weekday column headers (Sun-Sat),
  the 1st aligned under its weekday, all days of the month plus muted leading/trailing days,
  and today highlighted. (Was a rolling 28-day strip.)
- Added period navigation: **‹ / Today / ›** (steps by month in Month view, by week in Week
  view) + a month/year label. Week view preserved; the Home-embedded calendar stays compact
  (Week). Local date keys used so posts land on the correct day (no UTC off-by-one).

## 2026-07-15 - B15 AI provider switcher (Claude / Codex)

- **Provider abstraction** (`src/ai.js`): registry (`claude`, `codex`) + `runDraft(provider, ...)`,
  so a new model is a config entry, not a rewrite. `claude` = `claude -p ... --output-format json`;
  `codex` = `codex exec --json <prompt>` (JSONL stream, take the final `agent_message`). BOTH via
  subscription CLI login, NO API keys. `draft.js`/`copy_assist.js` route through it (default
  `draft_provider` setting, else claude); scrub still runs regardless of provider.
- **Endpoints**: `/api/draft` + `/api/copy-assist` take an optional `provider`; `POST /api/draft/compare`
  runs BOTH providers independently and returns `{claude:{result|error}, codex:{result|error}}`
  (one 503 doesn't fail the other); `/api/settings` round-trips `draft_provider`.
- **Frontend**: Claude/Codex switch in the composer (Draft-with-AI + copy-assist), a **Compare both**
  button showing Claude vs Codex side-by-side with "Use this" per column (graceful per-column error
  when a CLI isn't signed in), and a Settings default-model dropdown.
- **PrimeWright X/Twitter profile** added (drafted in CB's voice) to the seed + Profiles tab; a
  Desktop copy-paste sheet (`~/Desktop/PrimeWright-Social-Profiles.md`) covers all four platforms.
- Codex path is built + tested against a stub; **verify once the `codex` CLI is signed in**.
- Suite: **185 passing**.

## 2026-07-15 - Security review pass

- **Fixed a path-traversal / arbitrary-image-read**: `POST /api/media/resize` and
  `POST /api/examples/extract-image` accepted a client-supplied file path (absolute or `../`)
  without confining it to `media/`. On this localhost/no-auth app a malicious page hitting
  `127.0.0.1` could, via `sips`, copy an image from anywhere on disk into the publicly-served
  `/media/`. Added `resolveMediaPath()` (basename-flatten to `media/<name>` + boundary check),
  applied to both endpoints, with a regression test. Suite **165 passing**.
- **Reviewed clean**: secrets gitignored + untracked, no hardcoded keys, `.env.example`
  placeholders only, no creds in scripts/docs, repo private; `execFile` (no shell injection);
  parameterized SQL with allowlisted columns; binds `127.0.0.1` only; dashboard renders via
  `textContent` (no `innerHTML`-with-data XSS sink).
- **Advisories (by design)**: no auth/CSRF on the localhost app (keep `agent_can_publish` OFF
  unless supervising; DRY-RUN is the backstop); when the agent is armed, ingested content
  (redistributed blogs, example screenshots) is a prompt-injection surface - treat armed mode
  as deliberate + watched. No delete/cancel tools exist for the agent.

## 2026-07-15 - B14 image studio v2 + branding + agent publish authority

- **Image studio v2**: image brief now takes a CB-chosen `variant_count` (1..N, default 1,
  not hardcoded) + per-variant size/orientation/type hints; **Regenerate / more variants**
  button (`POST /api/image-requests/:id/regenerate`); brand `logo_path` + `colors` folded into
  the brief so Codex can brand the asset. Codex still generates (no API spend).
- **Auto-resize** (`src/resize.js`, macOS `sips`, no npm dep): `POST /api/media/resize`
  {source_path, platforms[]|dims[], post_id?} center-crops + resamples a chosen image to each
  platform's spec (verified live: IG 1080x1350, LinkedIn 1200x627). Degrades with
  `resize_unavailable` off macOS. `POSTDECK_SIPS_BIN` override for tests.
- **Branding in Settings**: migration v7 (`brands.logo_path`); `PATCH /api/brands/:id`
  (name/colors/logo_path/voice_doc_path) + `POST /api/brands/:id/logo` (multipart). Settings
  Branding section: logo upload+preview, color pickers, voice-doc field.
- **Agent publish authority, ARMED (default OFF)**: new setting `agent_can_publish` ('0'/'1',
  Settings toggle "Allow assistant to approve & publish"). `agent.js` gains `approve_post` +
  `publish_now` that ONLY run when armed (else refuse and point at the toggle), reuse the human
  validation + `submitNow` path, honor `BLOTATO_DRY_RUN`, and log `usage_events` kind
  `agent_publish`. cancel/delete remain permanently absent. Keeps the "no AI publishes" spine
  unless CB deliberately arms it.
- Suite: **164 passing** (sips resize exercised for real on CB's Mac). Verified live: branding
  persists, publish toggle defaults off, resize produces correct dims.

## 2026-07-15 - B13 brand profiles (source of truth + generate)

- **Profiles feature** (`src/profiles.js`, `profiles` table via migration v6,
  `GET /api/profiles`, `GET /api/profiles/:brand_id/:platform`, `PATCH /api/profiles/:id`,
  `POST /api/profiles/generate`): a canonical per-brand, per-platform store of profile fields
  (heading/subheading/bio + platform-standard fields) with `status` (draft/current/stale) and
  last-generated / last-reviewed timestamps.
- **Generate** drafts each field on a cheap `claude -p` call, grounded via `resolveVoice`
  (B12 global voice + brand tone) + `config/profile-specs.json` field limits + SEO notes, and
  scrubbed. 503-safe. Draft-only agent tool `generate_profile` added (no publish path).
- **Staleness**: mark reviewed / mark stale; stale profiles surface in the Home needs-attention
  panel ("<brand> <platform> profile marked stale - review it").
- **Frontend** (`#/profiles`): brand picker, a card per platform, editable fields with per-field
  **Copy** buttons, Save / Generate / Mark reviewed / Mark stale, status pills.
- **PrimeWright seeded live**: linkedin_company, facebook_page, reddit (from
  `config/profile-seed.primewright.json`), status draft, ready to copy-paste.
- Suite: **152 passing**. Verified live end-to-end (cards render, copy works, stale surfaces
  on Home, no em-dashes).

## 2026-07-15 - B12 settings & personalization (+ B13 profile prep)

- **Inheritance voice model** (`src/voice.js`): one global "CB" voice + global hard rules,
  inherited by every brand; per-brand tone profiles hold only light tweaks. `resolveVoice`
  merges global + tone and is wired into every generation path (`/api/draft`, `/api/copy-assist`,
  `redistribute.js`, `agent.js`) so the em-dash rule + global voice always apply.
- **Settings view** (`#/settings`): Personality (global voice), Global rules as on/off toggles
  (no em-dash [ON], no-emoji-on-LinkedIn, banned words), per-brand tone editors with Save /
  Reset-to-global, default-tone dropdown (drives the composer). Persisted server-side.
- **Action-center popover**: one corner button (stacked with the + and chat buttons), quick
  stats (drafts / scheduled / published / 30d engagement) on every view; reuses existing endpoints.
- Endpoints: `PATCH /api/tone-profiles/:id`, `POST /api/tone-profiles/:id/reset`,
  `GET /api/voice/resolve`; `/api/settings` round-trips `global_voice`/`global_hard_rules`.
- **Review fixes (strong pass)**: fixed `setGlobalHardRules` exploding a JSON-string arg into
  char-indexed keys (+ regression test); purged em-dashes from all rendered UI copy and from the
  15 seeded tone-profile placeholders + `seed.js` source (the app's own flagship rule now holds
  in its own chrome); `draft.js` env made lazy (done in B11).
- **B13 prep** (cheap model, no code): `config/profile-specs.json` (per-platform profile fields +
  limits + SEO) and `config/profile-seed.primewright.json` (PrimeWright LinkedIn/Reddit/Facebook
  drafts in CB's voice). Feed the B13 Profiles feature (building next).
- Suite: **138 passing**. Verified live: settings persist, resolver merges, popover shows stats.

## 2026-07-15 - B11 assisted-manual upgrade + blog redistribution

- **Generalized assisted-manual** (`src/worker.js` `isAssistedManual`): any account flagged
  `manual=1` OR any `blotato:false` platform (Reddit) is never auto-submitted to Blotato;
  routes through compose → copy → mark-posted. Per-account manual toggle in the composer
  (`PATCH /api/accounts/:id`). Generalizes the Reddit-only path to any platform.
- **Example grounding** (`src/examples.js`, `examples` table, `GET/POST/DELETE /api/examples`):
  paste an example post's text OR upload a screenshot; the screenshot is read to text ONCE by
  a cheap vision model (`src/extract.js` `extractFromImage`, `POSTDECK_VISION_MODEL`) and
  cached - never re-read. Examples auto-feed the copy assistant's grounding for that platform.
  `POST /api/examples/extract-image` returns a preview without saving.
- **Blog → social redistribution** (`src/redistribute.js`, `POST /api/redistribute`):
  fetch a blog URL, strip to markdown in plain code (`extractFromUrl`, no model), atomize into
  per-platform DRAFT posts (source_url recorded) + an image request. Human approves as always.
- Chat agent gains draft-only tools `redistribute_blog` + `add_example` (still no publish path).
- Migration **v5** (additive): `examples` table + `accounts.manual`.
- **draft.js**: env now read lazily per-call (matches copy_assist/extract) - fixes recurring
  test/agent import-order friction.
- Brands: added PrimeWright, Lunula Supply, IVision Build Co to the (gitignored) seed with full
  tone profiles; live brand set is now CHolmesIV, Di-Hy, PrimeWright, Lunula Supply, IVision.
- Tests: `extract`, `examples`, `redistribute`, `server.b11`. Suite: **115 passing**.

## 2026-07-15 - Blotato live-path fixes + account-mapping validation

- Fixed Blotato submission tracking to store `postSubmissionId` from `POST /v2/posts`
  responses instead of only looking for older guessed id fields. This unblocks verify-state
  tracking for real scheduled posts.
- Added `listSubaccounts(accountId)` helper in `src/blotato.js` so PostDeck can query the
  official pages/subaccounts surface instead of relying on guessed page mappings.
- Live validation result:
  - **Di-Hy X** submits successfully via connected account `18887`.
  - **Di-Hy LinkedIn** submits successfully when mapped as connected LinkedIn account
    `21735` plus company `pageId` `72992521`.
  - **Di-Hy Facebook** still fails with `Page / subaccount not found`, which means the
    top-level Facebook connection is present but the Di-Hy business page is not yet exposed
    as a valid Blotato page/subaccount target.

## 2026-07-14 - B10 Drive-it-fast + infra

### B10 - floating +, sticky brand, chat agent
- **Floating "+" button**: fixed bottom-right on every view (lives outside `#view` so the
  router's view-swap never removes it) → new post. Gold gradient + glow.
- **Sticky brand**: last-selected brand persists in `localStorage` (`pd_current_brand`);
  Home/Composer/Calendar/Research/Inspiration default to it (`getStickyBrand`/`setStickyBrand`).
- **In-app chat agent** (`src/agent.js`, `POST /api/agent`): a chat drawer where you talk and
  it acts - bounded 3-round `claude -p` loop with a **draft-only** tool catalog (query posts/
  ideas/usage/analytics, create/edit drafts, add ideas, draft copy, recommend content-type,
  request images, add research notes). **Hard boundary: no approve/publish/submit/cancel/
  delete tool exists** - anything it creates stays `status:'draft'`; publishing stays your
  click (matches the "no AI publishes" rule). Every copy string is scrubbed. `'agent'` added
  to usage tracking. Graceful 503 when the `claude` CLI is unavailable.
- Tests: `test/agent.test.js` (5) incl. proof that fabricated publish/approve/delete tool
  names are skipped and post status is unchanged. Suite: **86 passing**.

### Infra (deployment / launchers)
- `src/env.js` (.env loader), launcher scripts (`open-postdeck.command`,
  `install-desktop-launcher.sh`, `install-macos-app.sh`), `docs/ENGINEERING_WORKFLOW.md`,
  README delivery-rule section, `assets/` (app icon). PostDeck now runs as a `com.postdeck`
  launchd service. (`logs/` gitignored.)

## 2026-07-14 - B8 Content Studio + B9 Home command center + design pass

### B8 - Content Studio
- **Copy assistant** (`src/copy_assist.js`, `POST /api/copy-assist`): headline/hook
  variants, alt-text, and per-platform hashtags via local `claude -p` (Haiku, budget-capped),
  grounded in brand voice + tone + research notes + the brand's own top performers. Every
  returned string runs through the hard-rules scrub. Human still edits + Approves. 503-safe
  when the CLI is absent.
- **Content-type picker + recommender** (`src/recommend.js`, `GET /api/recommend/content-type`):
  new `posts.content_type` column; ranks static/carousel/image/text/video from the brand's
  own metrics when present, else platform best-practice defaults.
- **Distribution readout** in the composer (per-platform char limits on the account picker).
- **Image workflow**: multi-size preview (client-side, per-platform aspect ratios) + the
  Codex handoff loop - dashboard writes an `image-requests/req-<id>.json` brief, Codex drops
  variants into `image-requests/generated/`, a worker step imports them, and you pick a
  variant which attaches to the post. Contract in `docs/CODEX_IMAGE_HANDOFF.md`.
  (`src/imagespec.js`, `src/imagestudio.js`, `image_requests` table.)
- **Ops Stats tab** (`src/usage.js`, `GET /api/usage`, `#/ops`): posts by status/brand/
  platform, content-type mix, scheduled-this-week, drafts awaiting, published this month/
  all-time, plus usage counters (ai_draft/copy_assist/blotato_submit/image_request/
  image_generated) all-time vs last-7d, backed by a new `usage_events` table. Compact
  summary added to `social-state.json` for the AOS digest.
- **Research + inspiration ingestion** (`src/research.js`, `src/inspiration.js`,
  `research_notes` + `inspiration_profiles` tables): manual notes (Google Trends exports,
  Reddit findings, best-practice notes) with a `research-inbox/` drop folder; an inspiration
  board of like-minded profiles with an optional free web-search "suggest" (suggest-only,
  never auto-follows). No paid APIs - API seams stubbed for later.
- DB migration **v4** (additive). Hardened `POST /api/image-requests/:id/pick` to only
  attach a real generated variant.

### B9 - Home command center
- New default `#/home` view (`renderHome`): quick-create bar (**+ New Post** primary, Draft
  with AI, + Idea, Request image), needs-attention triage panel, this-week strip, platform
  status chips (scheduled count + last-published + health dot), mini-analytics with sparkline
  linking to the full Analytics tab, and the calendar embedded below. Calendar still at
  `#/calendar`.
- Fixed a pre-existing double-render bug in `bootstrap()`/`router()` (setting `location.hash`
  fired a second interleaved `router()` run) via a generation-token guard that builds into a
  detached view and only swaps in the latest run.

### Design pass
- Full visual system in `styles.css`: elevation/shadow scale, gradients (Ember Gold accents
  on Deep Ink), refined graded surfaces, rounded cards, focus rings, and subtle view/hover
  motion (respects `prefers-reduced-motion`). Inline SVG nav icons with a gold active state.
  No new dependencies.

### Tests
- Suite: **81 passing, 0 failing** (`npm test`). New: `usage`, `copy_assist`, `recommend`,
  `research`, `inspiration`, `imagestudio`, `server.b8`.

_Prior history (B1–B7) is in the git log and `SPEC.md`._
