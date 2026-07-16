# PostDeck — CB's personal multi-brand social scheduler

*Spec v1.3 — 2026-07-14 (B8 Content Studio added; see the B8 section at the end). Planned by Claude (strong model); built by Codex/cheap models against this doc. Working name "PostDeck" — rename at will, nothing depends on it.*

Implementation rule: meaningful work follows **spec -> plan -> build -> document -> commit -> deploy -> confirm**.
See `docs/ENGINEERING_WORKFLOW.md` for the standing workflow and shared-tree hygiene.

## What it is

A **local-first** "little Hootsuite" for one operator running multiple brands. One app on
CB's Mac: a database of content, a browser dashboard to compose/schedule/see everything,
and a thin worker that hands posts to the **Blotato API** (the only posting layer — we
never touch platform APIs directly). Content creation stays in Codex/Claude sessions
(especially images); this app is the **system of record + scheduler + face**.

Multi-brand from day one: CHolmesIV (personal) and Di-Hy now; future company brands are
**rows in a table, not new code** — the exact same flow gets copied for the company.

## Architecture (and the two decisions that shape it)

```
┌──────────────────────────── CB's Mac ────────────────────────────┐
│  Dashboard (browser, localhost) ── Fastify API ── SQLite DB      │
│                                        │                          │
│                                   worker (in-process cron)        │
│                                    ├─ handoff: submit due posts   │
│                                    ├─ verify: poll post status    │
│                                    └─ export: state → VPS         │
└───────────────┬───────────────────────────────┬──────────────────┘
                │ REST (scheduledTime)           │ rsync social.json
                ▼                                ▼
         Blotato API  ──publishes──▶      VPS /opt/agentic-os/state/
         (server-side schedule)           (Agentic OS reads → digest,
                                           on-road Telegram answers)
```

**Decision 1 — hold locally, hand off late.** Blotato schedules server-side
(`scheduledTime`, root-level — NOT nested in `post`, that publishes immediately), but its
API has **no delete**. So posts stay in the local DB — freely editable/cancelable — until
a **handoff window** (default 48h before publish), when the worker submits them to
Blotato. After handoff, edits mean going into Blotato's own dashboard by hand. If the Mac
is asleep at handoff time, the worker submits on next wake — the window is the slack. A
"submit now" button per post overrides the window (e.g., before a trip). Posting within
<48h just submits immediately.

**Decision 2 — REST, not MCP.** The Blotato MCP server is for interactive AI sessions and
doesn't expose scheduling/status-polling cleanly. The worker uses raw REST: full access to
`scheduledTime`, subaccounts, and `GET /posts/{id}` verification. (Claude/Codex sessions
may still use the MCP interactively; the app itself never does.)

## Stack

Deliberately boring, one runtime: **Node 20+, Fastify, better-sqlite3, single-page
dashboard (vanilla JS or Preact via one Vite build), no external services.** Media files
live on disk (`media/` folder), DB stores paths. Runs via `npm start` (or a launchd agent
so it's always up when the Mac is). `.env` for `BLOTATO_API_KEY` (+ optional rsync
target). No auth on the dashboard — localhost only, bound to 127.0.0.1.

## Data model (SQLite)

- **brands** — id, name, slug, colors/voice_doc_path, active
- **tone_profiles** — id, brand_id, name (`business` | `personal` | `casual`), voice_rules
  TEXT (style guidance fed to the drafting agent), hard_rules JSON (mechanically enforced,
  e.g. `{"no_em_dash": true, "banned_words": [...]}`). *Every brand ships with the three
  tones; rules seeded from the existing voice docs.*
- **accounts** — id, brand_id, platform, blotato_account_id, target_fields JSON
  (pageId etc.), active. *Real Blotato account IDs live in `config/accounts.seed.json`
  (gitignored) — see `config/accounts.seed.example.json` for the shape. The repo never
  contains real IDs (prep for going public at MVP).*
- **ideas** — id, brand_id, title, pillar, target_icp, source_material, notes, status
  (`idea → clustered → drafted → done/killed`), created_at. *The "content creation idea
  area." Imports content_clusters.csv.*
- **posts** — id, idea_id, brand_id, account_id, platform, tone_profile_id, copy, media
  JSON (paths + altText), platform_fields JSON (TikTok privacy flags, YT title, etc.),
  publish_at, status (`draft → approved → scheduled_local → submitted → published |
  failed | canceled`), blotato_submission_id, public_url, error_message, timestamps.
  *Imports posts.csv (schema maps ~1:1). `platform` includes `blog` (see Blog channel).*
- **metrics** — post_id, captured_at, impressions, comments, shares, saves, follows, dms,
  leads, notes. *Manual entry in v1 (Blotato doesn't return analytics); the posts.csv
  metric columns land here.*
- **lead_signals** — straight import of lead_signals.csv schema; simple table + form.
- **settings** — handoff_window_hours (48), export config, quiet hours, etc.

## Worker (single in-process scheduler, checks every ~5 min while app runs)

1. **Handoff**: posts `approved` with `publish_at - now <= handoff_window` → upload media
   (`POST /v2/media`), then `POST /v2/posts` with root-level `scheduledTime` →
   `submitted`, store `blotato_submission_id`. Respect rate limits (30/min — irrelevant at
   CB's volume). On 422/429/network error: retry with backoff, then `failed` + surface.
2. **Verify**: for `submitted` posts past `publish_at`, `GET /posts/{id}` →
   `published` (+ `public_url`) or `failed` (+ `errorMessage`). Poll a few times over the
   first hour, then give up and flag.
3. **Export**: on any state change + nightly, write `social-state.json` (next 14 days of
   scheduled posts per brand, unsubmitted-approved count, failures, last-export timestamp)
   and rsync to the VPS → `/opt/agentic-os/state/social.json`. **This is how the Agentic
   OS knows what's going on**: the morning digest gets a social line; on-road Telegram
   questions answer from this snapshot "as of <last export>". Export is one-way, read-only
   on the VPS side. Failures also land here → the AOS alerts CB on Telegram (the app never
   needs its own Telegram wiring).

## Dashboard (localhost web UI — the whole point)

PrimeWright-specific marketing/app design standards live in
`docs/PRIMEWRIGHT_DESIGN_GUIDELINES.md`. Use that file as the design source of truth for any
PrimeWright website or app pass: command-center posture, human approval gates, explainable AI
verdicts, WCAG 2.2 AA, 44-48px tap targets, and no AI-hype visuals.

1. **Calendar / Queue** (home) — week + month views, posts color-coded by brand, status
   badges (draft/approved/submitted/published/failed). Drag to reschedule (only until
   handoff). Filter by brand/platform. "What goes out this week" at a glance.
2. **Composer** — pick brand → accounts auto-filter; write per-platform variants side by
   side (one idea → LinkedIn/FB/X versions); char counters + image-dimension hints from
   the platform-specs table (imported from the content-system doc §7); attach media
   (drag-drop → `media/`, preview); set publish_at; per-platform required fields appear
   contextually (TikTok flags, YT title...). Save as draft → **Approve** (explicit human
   gate, mirrors the pipeline's checkpoint) → scheduled.
   **"Draft with AI"**: type/pick an idea, choose brand + tone (business/personal/casual)
   → the app calls `claude -p` locally (cheap model) with the brand's voice doc + tone
   profile + platform specs loaded → per-platform drafts land IN the composer fields,
   editable — never to clipboard, never straight to Blotato. Hard rules (`no_em_dash`,
   banned words) are enforced twice: in the prompt AND a mechanical post-generation scrub
   that strips/flags violations before the text ever reaches the field. The human Approve
   gate is unchanged — AI drafts, CB decides.
3. **Ideas board** — kanban columns by status; an idea opens into "generate drafts" (v1:
   copy a prefilled prompt for the Stage-1/Stage-2 agents to clipboard; v2: invoke
   `claude -p` with the pipeline prompts and drop results into drafts for review).
4. **Library** — media browser (`media/` grid), assets tagged by brand; shows the four
   HTML template references for Codex image work.
5. **Post detail** — full lifecycle: copy, media, status history, submission id,
   public_url link, error message, manual metrics entry form.
6. **Settings** — brands & accounts CRUD, handoff window, export target, import buttons
   (one-time CSV importers for the existing brand-system files).

Design: clean, dense, dark-mode default, brand colors as accents (Deep Ink #0D0D0D /
Ember Gold #C8902A / Slate White #F5F4F0). It's an operator console, not a marketing site.

## Platform lineup (CB, 2026-07-11)

Target platforms: **Facebook, Instagram, TikTok, Reddit, X** (+ **blog**; LinkedIn stays
wired since accounts exist). More later. Current per-platform limits/specs live in
`config/platform-specs.json` (single source of truth for composer counters, validation,
and the drafting agent) — refresh it when platforms change their rules.

**Reddit is NOT supported by Blotato** (confirmed against their target schema: twitter,
linkedin, facebook, instagram, pinterest, tiktok, threads, bluesky, youtube, webhook).
Decision: v1 treats Reddit as an **assisted-manual channel** — compose in PostDeck
(subreddit + title + body fields), it validates against subreddit norms you set, and at
publish time it's a "copy & open subreddit" flow with the post tracked like any other
(manual "mark posted" + paste URL). This is deliberately not a downgrade: Reddit's karma
culture and per-subreddit rules punish automated posting — assisted-manual IS the best
practice there. A native Reddit API adapter (OAuth, direct submit) is a tracked follow-up
if volume ever justifies it; the worker's adapter interface should keep Blotato as one
adapter among possible others, not the hardcoded only path.

## Analytics portal

Blotato returns no analytics, so PostDeck owns its own lightweight portal fed by the
`metrics` table (manual entry per post in v1, CSV import for bulk):
- **Analytics view** in the dashboard: per-brand and per-platform rollups over time
  (posts published, impressions, engagement = comments+shares+saves, follows, DMs, leads,
  calls booked); top-10 posts by impressions and by leads; format performance (carousel vs
  single vs video); simple week-over-week deltas. Charts hand-rolled (inline SVG bars/
  lines — no chart library, keeps the no-dependency rule).
- **Entry workflows**: quick metrics form on post detail (exists); a "metrics due" queue
  view listing published posts older than 48h with no metrics yet — the nudge that keeps
  the data real. Optional bulk CSV import matching the old posts.csv metric columns.
- **Grounding for the agent**: the analytics rollup is included in `social-state.json`
  (last-30-days summary per brand) so on-road questions like "how's content performing"
  get real numbers.
- Platform-API analytics ingestion (Meta insights etc.) is explicitly deferred — manual
  entry first, prove the habit, then automate the fetch if it sticks.

## Blog channel (designed now, wired later)

CB's sites are migrating to static HTML on the VPS (wp-to-static). A blog post is just
another `posts` row with `platform: "blog"`, `target_fields: {site: "di-hy.com"}`, and
long-form fields (title, slug, body markdown, hero image). The composer gets a long-form
mode for it; the drafting agent works the same way (brand voice + tone). **Publishing**
= render body → HTML via the site's template → hand off to the existing Tier-3 gated
deploy pipeline (Agentic OS deploy adapter or manual), NOT Blotato. V1 ships draft/store/
render-preview only; the deploy hook lands once the wp-to-static migration completes.
Social posts promoting a blog post can link to it (idea → blog post + social variants is
the natural cluster flow).

## Idea capture from the road

No new plumbing: CB texts the Agentic OS Telegram bot ("idea: ...") → AOS capture inbox →
PostDeck's importer picks up inbox items tagged as ideas on next app open and creates
`ideas` rows (status `idea`, source `telegram-capture`). Quick-add box in the dashboard
covers at-desk capture.

## What this app does NOT do (scope fence)

- **Copy** drafting/assist happens inside the app via a local `claude -p` cheap-model call
  (see "Draft with AI" and B8 copy assistant); **images** stay external — Codex generates
  them, the app only specs the request and files the result (B8 image handoff). No image
  generation inside the app.
- No direct platform APIs, ever — Blotato only.
- No auto-posting without the explicit Approve step. No AI decides what publishes.
- No analytics scraping in v1 — metrics are manual entry (revisit later).
- No multi-user/auth/cloud — one operator, one Mac, localhost. VPS migration only when a
  brand's volume earns it (same trigger philosophy as everything else).
- No deleting via API (impossible) — the handoff window is the safety; post-handoff
  changes happen in Blotato's UI.

## Build plan (for the Codex build sessions)

- **B1 — Skeleton + DB**: Fastify app, SQLite schema + migrations, brands/accounts seeded,
  CSV importers (clusters, posts, lead_signals), `.env` handling. *Exit: data visible via
  a raw JSON endpoint.*
- **B2 — Dashboard read views**: Calendar/Queue, Post detail, Ideas board (read-only),
  Library. *Exit: CB can SEE everything scheduled and every idea.*
- **B3 — Composer + lifecycle**: create/edit/approve/cancel posts, media upload, platform
  field validation. *Exit: full local scheduling without Blotato.*
- **B4 — Blotato worker**: handoff + verify + retries against the real API (test with a
  post scheduled to a burner/low-stakes account first), "submit now". *Exit: a real post
  published end-to-end.*
- **B5 — Agentic OS bridge**: state export + rsync, AOS routine reads social.json into
  digest, failure alerts via AOS Telegram. *Exit: "what's going out this week?" answered
  from CB's phone.*
- **B6 — Polish**: drag-reschedule, metrics entry, quiet-hours guard, launchd agent.

Each B-step is one cheap-model session against this spec. Review gate: Codex (or Claude)
reads the diff before merge; real Blotato calls only in B4+ and only after B1–B3 pass.

---

## B8 — Content Studio (spec v1.3, 2026-07-14)

*CB's second wave of ideas. Turns PostDeck from scheduler into a content studio: it helps
draft, decide format, spec the image, choose the distribution, and learn from CB's own
results — Blotato is just the pipe at the end. **Hard constraint: no paid APIs, no new
recurring spend.** Grounding = CB's own metrics + manually-ingested research + free
`claude -p` (already used by Draft-with-AI). Every "external data" surface ships as a
manual-ingest + AI-suggest v1 with a clearly-stubbed seam so a real API can slot in later
without a rewrite.*

### B8 features

1. **Copy assistant** (`src/copy_assist.js`, `POST /api/copy-assist`). Extends Draft-with-AI
   from one blob to pickable pieces. Modes: `headlines` (3–5 hook/headline variants),
   `alt_text` (accessible alt text for an attached image, given the image path + copy
   context), `hashtags` (per-platform set, count from `platform-specs.json`
   `text.hashtags_best`), `all`. Same `claude -p` shell as `draft.js` (Haiku, budget cap),
   same mechanical `scrub.js` pass on every returned string. Grounding fed into the prompt:
   brand voice doc + tone profile + relevant `research_notes` (by pillar/tag) + the brand's
   own top-performing posts from the analytics rollup ("for this brand, question-hooks and
   carousels outperform"). Returns strict JSON; human still edits + Approves. Never
   auto-fills without CB clicking a variant.

2. **Content-type picker + recommender.** New `posts.content_type` column
   (`static | carousel | image | text | video`, nullable). Composer gets a dropdown.
   Recommender (`src/recommend.js`, `GET /api/recommend/content-type?brand_id=&pillar=&platform=`)
   returns a ranked suggestion with a one-line reason, computed from (a) the brand's own
   format performance in `analytics.js` when metrics exist, else (b) platform best-practice
   defaults from `platform-specs.json`/notes. Pure/heuristic — no AI call needed.

3. **Distribution selector.** The composer already creates one post per selected account
   (checkboxes, `renderComposer`). B8 formalizes it into an explicit "Distribute to"
   section with per-platform char/limit readouts, and makes "add a platform/account" a
   Settings action (accounts are rows, not code — no schema change). Content-type + copy
   assistant are distribution-aware (hashtag counts, limits per selected platform).

4. **Image workflow — sizing preview + Codex handoff.**
   - *Multi-size preview* (frontend only, `public/app.js`): attach/select one image → a
     canvas panel renders it framed at every target platform's aspect ratio (dims read from
     `platform-specs.json` `image.*`), flagging crops/letterboxing. No backend.
   - *Codex handoff* (`src/imagespec.js` + `src/imagestudio.js`, `image_requests` table,
     `image-requests/` on-disk folder mirroring `capture-inbox/`). Flow:
     1. CB clicks "Request image" on a post/idea → dashboard builds a **brief** from the
        selected platforms + content_type + copy context, and recommends quality settings
        (format PNG for text-heavy, exact px per platform, max file size, safe zones).
        The reusable image prompt system is editable in Settings and is included under
        `brief.prompt_settings` for every request. CB can edit the one-off brief/input gate
        before `POST /api/image-requests`.
     2. The request is written as a spec file `image-requests/req-<id>.json` (the outbound
        analogue of capture-inbox) AND persisted as an `image_requests` row (status
        `requested`). **This is the Codex contract** — Codex reads the JSON, generates
        2–3 variants at the specified dims, and drops them into
        `image-requests/generated/req-<id>/` with a `manifest.json`
        (`{request_id, variants:[{file, platform, dims, notes}]}`).
     3. A worker step `importGeneratedImages` (in `imagestudio.js`, called each cycle like
        `importCapturedIdeas`) scans `generated/`, moves variant files into `media/`,
        updates the row to status `generated` with `variants[]`, and archives the manifest.
     4. Dashboard "Images" view shows requests + their variants side by side. CB picks one
        (`POST /api/image-requests/:id/pick`) → chosen image attaches to the post at the
        right size, row → `picked`.
   - **Spec-file protocol is documented in `docs/CODEX_IMAGE_HANDOFF.md`** so a Codex
     session knows exactly what to read and produce.

5. **Ops-stats tab** (`src/usage.js`, `GET /api/usage`, `#/ops` view). Distinct from the
   engagement Analytics tab. Shows operational/inventory numbers: posts by status, by
   brand, by platform; scheduled this week; drafts awaiting approval; published this
   month/all-time; content-type mix; and *usage counters* — AI drafts, copy-assist calls,
   Blotato submissions, image requests/generations — recorded in a new lightweight
   `usage_events` table (append a row wherever those actions happen). Answers "how much am
   I using / how many have I made / what's scheduled." A compact version of these counts is
   added to `social-state.json` for the AOS digest.

6. **Research + inspiration ingestion (manual now, API-seam later).**
   - *Research notes* (`src/research.js`, `research_notes` table, `GET/POST /api/research`,
     `PATCH/DELETE /api/research/:id`, `POST /api/research/import`). CB drops in Google
     Trends CSV exports, Reddit findings, best-practice notes — tagged to brand/pillar.
     `import` accepts a file/paste and stores it; the copy assistant and recommender read
     these as grounding. A `research-inbox/` folder + worker step mirrors capture-inbox for
     drop-and-forget ingestion.
   - *Inspiration board* (`src/inspiration.js`, `inspiration_profiles` table,
     `GET/POST /api/inspiration`, `PATCH/DELETE`). Like-minded people/accounts in CB's
     field: handle, platform, name, url, niche, why_relevant, tags, source
     (`manual | ai_suggested`). v1 = manual add + an **optional** `POST /api/inspiration/suggest`
     that uses free web search via `claude -p` to propose profiles to go check (clearly a
     suggest-only convenience, never auto-follows anything). The seam: a `source` field and
     an adapter boundary so a real social API could populate it later.

### B8 data model additions (migration v4, plain SQL in `db.js`)

- `ALTER TABLE posts ADD COLUMN content_type TEXT;`
- `image_requests` — id, post_id (FK nullable), brand_id, platforms TEXT (JSON array),
  content_type TEXT, brief TEXT (JSON), status TEXT DEFAULT 'requested'
  (`requested → generated → picked | canceled`), variants TEXT DEFAULT '[]' (JSON:
  [{path, platform, dims, notes}]), chosen_path TEXT, created_at, updated_at.
- `research_notes` — id, brand_id (nullable), source TEXT
  (`google_trends | reddit | best_practice | web | manual`), title, url, body TEXT,
  tags TEXT (JSON array of pillars/keywords), captured_at, created_at.
- `inspiration_profiles` — id, brand_id (nullable), handle, platform, name, url, niche,
  why_relevant, tags TEXT (JSON array), source TEXT DEFAULT 'manual', created_at.
- `usage_events` — id, kind TEXT (`ai_draft | copy_assist | blotato_submit | image_request
  | image_generated`), brand_id (nullable), meta TEXT (JSON), created_at.

### B8 constraints for the build

- No new npm dependencies (no chart lib, no image lib) — canvas preview is browser-native,
  charts stay hand-rolled SVG, image files are moved with `fs`.
- Every `claude -p` call reuses the `draft.js` shell pattern (binary/model/budget env
  overrides, 503 on unavailable) and the `scrub.js` output pass. Copy assist must degrade
  gracefully when the CLI is absent (same 503 contract), so the rest of the app works.
- All new AI/web features are additive and behind an explicit CB click — nothing runs on a
  timer, nothing posts or follows automatically. Approve gate unchanged.
- Tests (node:test, no runner dep) for every new module: `usage.test.js`,
  `copy_assist.test.js` (mock the CLI like `blotato.mock`), `recommend.test.js`,
  `research.test.js`, `inspiration.test.js`, `imagestudio.test.js` (temp dirs), and an
  API-surface test extending `server.approve-gate` style for the new endpoints.

### B8 build split (parallel cheap-model agents, then wire)

- Wave 1 (independent new modules + unit tests, no edits to server.js/app.js):
  A = `db.js` migration v4 + `src/usage.js`; B = `src/copy_assist.js` + `src/recommend.js`;
  C = `src/research.js` + `src/inspiration.js`; D = `src/imagespec.js` +
  `src/imagestudio.js` + `docs/CODEX_IMAGE_HANDOFF.md`.
- Wave 2: E = wire all new endpoints into `server.js` + the two new worker steps into
  `worker.js` + usage_events recording at action sites + `export.js` usage summary +
  integration test; F = frontend (`public/app.js`, `index.html`, `styles.css`) — new views
  (`#/ops`, `#/research`, `#/inspiration`, `#/images`) + composer enhancements
  (content-type dropdown, distribution readout, copy-assist buttons, multi-size preview,
  "Request image").
- Review (strong model): read full diff, run `npm test`, smoke the server, then commit +
  push + update README + this spec's status + the Second-Brain mirror.

---

## B9 — Home command center (spec, 2026-07-14)

*CB's homepage feedback: the current home is just the Calendar/Queue — read-only-feeling,
no "New Post" button, no action/analytics center. Target feel = a bit of Hootsuite
(the scheduling calendar), Sprout Social (at-a-glance analytics + platform health), and a
smooth "start creating" flow. Turn the home route into an operator cockpit; the calendar
becomes one section of it, not the whole thing. Frontend-only where possible (reuses B7/B8
endpoints) — `public/app.js`, `index.html`, `styles.css`.*

New home view (`renderHome`, becomes the default `#/` / `#/home` route; Calendar stays
reachable at `#/calendar` and is embedded below the cockpit):

1. **Quick-create bar** (top, always visible) — prominent **+ New Post** button → Composer
   (prefilled brand = current filter), plus **Draft with AI**, **+ Idea**, and
   **Request image (Codex)** quick actions. This is the missing create entry point.
2. **Needs-attention panel** — the operator's triage list, each row clickable to the item:
   failed posts, posts inside/near the handoff window still missing media or required
   platform fields, drafts awaiting approval, and the "metrics due" count (from the B7
   analytics queue). Empty state = "all clear."
3. **This-week strip** — count scheduled next 7 days + a compact timeline of the next N
   posts (chip → post detail), per brand color.
4. **Platform status chips** — one chip per connected account/platform: scheduled count,
   last-published, and a health dot (recent failure flagged). Answers "what's each channel
   doing." Data from `/api/accounts` + `/api/posts` + `/api/usage`.
5. **Mini analytics** — top-line 30-day numbers (impressions, engagement) with a sparkline
   (reuse `svgLineChart`), linking through to the full Analytics tab. From `/api/analytics`.
6. **Interactive calendar** below — the existing calendar, but chips clearly clickable
   (→ detail) and drag-reschedule intact; brand/platform filters wired.

Constraints: no new deps; reuse existing endpoints (`/api/usage`, `/api/analytics`,
`/api/posts`, `/api/accounts`); everything additive; verify each view renders exactly once
(the bootstrap double-render fix must be in first). Build as its own pass AFTER the B8
frontend (Wave 2-F) merges, to avoid concurrent edits to `app.js`.

---

## B10 — Drive-it-fast: floating + button, sticky brand, chat agent (spec, 2026-07-14)

*CB: pressing "New Post" isn't discoverable, brand keeps resetting, and he'd rather talk to
the app than click around. Three additive features. Same constraints: no new deps, local
`claude -p` only (budget-capped, no new subscription), human Approve gate untouched.*

### 1. Floating "+" button (FAB)
A fixed bottom-right `+` button, present on EVERY view. Lives in the app shell
(`index.html`, as a sibling of `#view`) so `router()`'s view-swap never removes it. Click →
`#/composer` (prefilled with the sticky brand). Pure frontend (`index.html` + `styles.css`,
tiny `app.js` wire-up for the click). Round, gold gradient, `--glow-gold`, subtle hover
lift; hidden behind `prefers-reduced-motion` only for animation, not presence.

### 2. Sticky brand (memory state)
A persisted "current brand" so views default to it instead of "All brands". Store in
`localStorage` under `pd_current_brand` via small helpers `getStickyBrand()`/
`setStickyBrand(id)` in `app.js`. Every brand `<select>` (Home, Composer, Calendar,
Research, Inspiration) initializes from it and writes back on change. Supersedes the
one-off `sessionStorage` composer prefill (keep that working, but source its default from
the sticky value). "All brands" (empty) is a valid remembered state.

### 3. In-app chat agent (draft-and-prepare authority)
A chat panel (toggle button in the shell → slide-in drawer, present on every view) where CB
talks and the app acts. Backend `src/agent.js` + `POST /api/agent`.

**Authority (hard boundary — CB's decision + the app's "no AI publishes" rule):** the agent
may create/edit **drafts**, write/rewrite copy, add ideas, set `publish_at`/`content_type`,
request images, and answer questions from the data. It may NOT approve, schedule-live,
submit, publish, cancel, or delete — those stay a human click. Any post the agent
creates/edits stays `status: 'draft'`. Tools that would cross that line simply aren't
exposed; if asked, the agent replies that it's a human action and points at the Approve
button.

**Loop (reuses the `draft.js` `claude -p` shell — same env overrides, `--output-format json`,
budget cap, 503 contract):** bounded agent loop, max 3 rounds. Each round the model gets the
user message + short history + a tool catalog + current context (brands/accounts, sticky
brand) and returns STRICT JSON: `{ "reply": string, "actions": [{ "tool": string, "args": {} }] }`.
The server executes each action against internal functions, appends results, and if the
model requested actions, does one more round feeding results back so it can chain
(e.g. draft copy → create draft post → request image for it). Stops when the model returns
no actions or after 3 rounds. Every copy string the agent writes runs through `scrub.js`.
Records `recordUsage(kind:'agent')` per request (add `'agent'` to `usage.js` USAGE_KINDS +
buildUsageStats).

**Tool catalog (all map to existing modules/DB; read + draft-only):**
`query_posts`, `get_post`, `list_ideas`, `list_brands_accounts`, `get_usage`,
`get_analytics`, `create_draft_post` (status forced to `draft`), `update_draft_post`
(refuses if the post is past `draft`), `create_idea`, `draft_copy` (via copy_assist/draft),
`suggest_content_type`, `create_image_request`, `create_research_note`. NO approve/publish/
submit/cancel/delete tools exist.

**API contract:** `POST /api/agent { message, history?: [{role, content}], brand_id? }` →
`{ reply, actions: [{ tool, args, summary, link? }], history }`. `link` is an in-app hash
(e.g. `#/post/123`) when an action created/changed something, so the chat can deep-link it.
503 `{error:'ai_unavailable'}` when the CLI is absent (panel shows a friendly note).

**Frontend:** chat drawer renders the conversation, streams nothing (single response per
send is fine), shows each action as a small "did: created draft #123 →" chip linking into
the app, and refreshes the underlying view if the current view's data changed.

### B10 constraints / tests
- No new deps. Local `claude -p` only. Approve→publish stays human everywhere.
- Tests: `agent.test.js` — mock the CLI (stub bin echoing a canned `{actions:[...]}` envelope
  like `copy_assist.test.js`); assert the loop executes a `create_draft_post` action and the
  created post is `status:'draft'`; assert a request that would "publish" is refused (no such
  tool) and answered as human-only; assert the 503 contract. Extend the API-surface test for
  `POST /api/agent`. Full `npm test` stays green.

### B10 build split (parallel Sonnet, disjoint files)
- G = backend: `src/agent.js` + `POST /api/agent` in `server.js` + `'agent'` usage kind in
  `usage.js` + `test/agent.test.js`.
- H = frontend: FAB + sticky-brand helpers + chat drawer in `public/app.js`,
  `index.html`, `styles.css`; build the drawer against the `/api/agent` contract above.
- Review (strong): read diff, `npm test`, smoke server (FAB on every view, brand persists,
  chat creates a draft and refuses to publish), then commit to `working` + update docs.

## Open items (answer before/while building)

1. **Multi-brand under one Blotato key** — docs don't confirm workspace scoping; current
   setup already runs both brands under one account, so likely fine. Verify when adding
   company brands.
2. Complete Blotato error-code table isn't public — B4 handles errors generically
   (log + flag + alert), refine later.
3. Instagram/TikTok/Threads not yet connected in Blotato — connect in their dashboard when
   ready; then they're just new `accounts` rows.
4. YouTube stays manual/out of scope (matches current practice).

---

## B15 — AI provider switcher (Claude / Codex) for copy drafting (spec, 2026-07-15)

*CB: switch which model drafts copy, with a "compare both" review button. Claude = thinking/
text, Codex = images (unchanged); text drafting is where you switch. Extensible for future
providers. **Both via subscription CLIs, never API keys.** Scope = copy drafting only (agent /
profile-gen / etc. stay on Claude); build the abstraction so scope can widen later.*

### Provider abstraction (`src/ai.js`)
- A small provider registry keyed by name → `{ binEnv, buildArgs(prompt, {model,budget}), parse(stdout) }`,
  so a new provider is a config entry, not a rewrite. `runDraft(provider, {prompt, model?, budget?})`
  → the model's raw text (503-flagged error when the CLI is missing OR not logged in).
  - **claude**: `claude -p <prompt> --model <m> --max-budget-usd <b> --output-format json`;
    parse the `.result` envelope (same as today). Subscription login (`claude` / `/login`).
  - **codex**: `codex exec --json <prompt>` run in a read-only/scratch context (it must NOT
    execute tools or touch files — pure text response); parse the JSONL event stream and take
    the final `item.type === "agent_message"` `.text`. Bin via `POSTDECK_CODEX_BIN` (default
    `codex`). Reuses saved Codex CLI login (ChatGPT/subscription) — **no API key**. Treat
    "not logged in"/missing bin as a 503 like the claude path.
- `draft.js` `draftWithAi` and `copy_assist.js` `copyAssist` take an optional `provider`
  (default the `draft_provider` setting, else `'claude'`) and route through `src/ai.js`; the
  hard-rules scrub still runs on output regardless of provider. Signatures stay backward-compatible.

### Setting + endpoints
- Setting `draft_provider` ('claude' | 'codex', default 'claude'). Round-tripped via `/api/settings`.
- `/api/draft` and `/api/copy-assist` accept an optional `provider`.
- `POST /api/draft/compare` {idea_text, brand_id, tone_profile_id, platforms} → runs the draft
  through BOTH providers and returns `{ claude: {result|error}, codex: {result|error} }` (each
  provider independent — one 503 doesn't fail the other; 2 subscription calls).

### Frontend
- Composer Draft-with-AI + copy-assist: a **provider switch** (Claude / Codex), defaulting to
  the setting, passed as `provider`. A **"Compare both"** button → `/api/draft/compare` →
  shows Claude vs Codex side-by-side; pick one to fill the fields. Per-provider error notes if
  one isn't logged in.
- Settings: a **default drafting model** dropdown (`draft_provider`).

### Constraints / honesty
- Both providers via subscription CLIs, no API keys. Claude path testable now (once logged in);
  **Codex path is built against `codex exec --json` but CANNOT be verified until CB signs into
  the Codex CLI** — ship it wired + tested against a stub, mark verify-on-signin.
- Tests: `ai.test.js` (registry + both parsers via stub bins echoing a claude envelope / a codex
  JSONL stream; 503 when a bin is missing), draft-compare shape, provider round-trip. Full suite green.

### Build split (parallel Sonnet, disjoint files)
- **U** = backend: `src/ai.js` + route `draft.js`/`copy_assist.js` through it + `draft_provider`
  setting + `/api/draft`/`/api/copy-assist` provider param + `POST /api/draft/compare` + tests.
- **V** = frontend: composer provider switch + Compare-both view + Settings default-model dropdown.

---

## B14 — Image studio v2 + branding + agent publish authority (spec, 2026-07-15)

*CB's final batch. Confirmed: image variants via a multi-option Codex brief with a
CB-chosen count + regenerate + auto-resize-to-platform (no paid API); branding (logo/colors/
voice-doc) editable in Settings; the chat agent gains approve/publish authority BEHIND an
arming switch (default OFF) with DRY-RUN as the hard backstop. No new npm deps (resize uses
macOS `sips`).*

### 1. Image studio v2 (extends B8 handoff)
- The image-request brief gains `variant_count` (CB picks: 1..N, default 1) and per-variant
  hints (size/orientation: vertical 9:16 / square 1:1 / portrait 4:5 / landscape; type:
  thumbnail / feed post / story). The content-type recommender seeds sensible defaults per
  platform. Codex still generates (no API spend); CB picks from the returned grid.
- **Regenerate / more variants**: a button that appends another image-request round for the
  same post/idea (bumps the brief, writes a new `req-<id>.json`) so CB can ask for more
  without re-typing.
- **Auto-resize to platform specs** (`src/resize.js`, macOS `sips`, no dep): given a chosen
  image + a set of target platforms, produce correctly-sized copies (dims from
  `platform-specs.json` `image.*`) into `media/`, center-crop to the target aspect. Endpoint
  `POST /api/media/resize` {source_path, platforms[] | dims[]}. Degrades with a clear message
  if `sips` is unavailable (non-macOS). Attaches the resized file to the post on request.

### 2. Branding in Settings (migration v7)
- `ALTER TABLE brands ADD COLUMN logo_path TEXT;` (+ reuse existing `colors`, `voice_doc_path`).
- `PATCH /api/brands/:id` (name/colors/logo_path/voice_doc_path), `POST /api/brands/:id/logo`
  (multipart upload → `media/`, sets logo_path). Settings gets a **Branding** section per
  brand: logo upload/preview, color pickers (writes `colors`), voice-doc path field.
- The image brief includes the brand's `logo_path` + `colors` so Codex can brand the asset.

### 3. Agent publish authority (armed, default OFF)
- New setting `agent_can_publish` (default `'0'`). Settings toggle: "Allow assistant to
  approve & publish."
- `agent.js` gains tools `approve_post`, `schedule_live`, `publish_now` that ONLY execute when
  `agent_can_publish==='1'`; otherwise they refuse with a message telling CB to arm it in
  Settings. Even when armed, they honor `BLOTATO_DRY_RUN` (dry-run = no real post) and reuse
  the existing worker submit path — the agent never bypasses validation (TikTok fields, quiet
  hours, reschedule guards). Every agent publish/approve records a `usage_events` row
  (kind `agent_publish`) for an audit trail. The default-OFF switch keeps the app's "no AI
  publishes" spine intact unless CB deliberately arms it.

### Build split (parallel Sonnet, disjoint files)
- **R** = backend: `src/resize.js` (sips) + `imagespec.js` brief v2 (variant_count, hints,
  regenerate) + db.js migration v7 (`brands.logo_path`) + `server.js` endpoints (media/resize,
  brands PATCH + logo upload, image-request count/regenerate) + `agent.js` (armed publish
  tools + `agent_can_publish` gate) + tests.
- **S** = frontend: Images UI (count selector, Regenerate, per-platform Resize buttons),
  Settings Branding section (logo upload/preview, color pickers, voice-doc field) + the
  "Allow assistant to approve & publish" toggle.
- Review (strong): diff + `npm test` + smoke (set count/regenerate/resize with a test image;
  edit branding; arm the toggle and confirm the agent's publish tool refuses when off /
  works+dry-run when on) → commit `working` + docs.

---

## B13 — Brand profiles (source of truth + generate) (spec, 2026-07-15)

*CB: keep a canonical store of each brand's platform profile info (heading, subheading, bio,
+ platform-standard fields) so when the business changes he knows which profiles are stale
and need updating; a "Generate" button drafts each field in his voice for copy-paste; the
agent can use it too. Cheap model. SEO best practices. PrimeWright first, then standardize.*

### Data model (migration v6, additive)
- `profiles` — id, brand_id, platform, fields TEXT (JSON: `{heading, subheading, bio, ...
  platform-standard fields}`), status TEXT DEFAULT 'draft' (`draft | current | stale`),
  last_generated_at, last_reviewed_at, created_at, updated_at. UNIQUE(brand_id, platform).

### Profile field specs (`config/profile-specs.json`, researched, cheap-model)
Per platform: the standard fields + char limits + SEO guidance, e.g.
- **linkedin_company**: name, tagline (≤120), about/overview (≤2000), industry, website,
  specialties, location. (personal variant: headline ≤220, about ≤2600.)
- **facebook_page**: page name, username, category, short description (≤255), about/story,
  website, CTA button.
- **reddit**: display name, bio (≤200), social links. (Best practice: authentic account, not
  salesy — Reddit punishes promo; note this.)
Reused by the generate prompt + the UI field list. Refresh when platforms change.

### Backend
- `src/profiles.js`: `listProfiles(db,{brand_id})`, `getProfile(db,{brand_id,platform})`,
  `upsertProfile(db,{brand_id,platform,fields,status})`, `markReviewed`/`markStale`,
  `generateProfile(db,{brand_id,platform})` — cheap `claude -p` (reuse the shell) that, given
  the platform's field spec + `resolveVoice` (B12 global voice + brand tone) + SEO guidance,
  returns each field as strict JSON; scrubbed; saved with status 'draft', last_generated_at.
- Endpoints: `GET /api/profiles?brand_id=`, `GET /api/profiles/:brand_id/:platform`,
  `PATCH /api/profiles/:id` (manual edits + status), `POST /api/profiles/generate`
  {brand_id, platform}. Agent gets a draft-only `generate_profile` tool.
- **Staleness v1**: manual `mark stale` / `mark reviewed` + `last_reviewed_at`; a "needs
  review" flag surfaced in the Needs-attention panel / action center. (Auto-detecting that a
  business fact changed = v2.)

### Frontend
- A **Profiles** section (in Settings or its own view): per brand, a card per platform showing
  the fields, a **Generate** button (→ POST generate, fills the fields, cheap model), editable
  fields, per-field **Copy** buttons, and a status chip (draft/current/stale) with mark-reviewed/
  mark-stale. Copy-paste is the whole point — every field individually copyable.
- Stale profiles surface in the Home needs-attention panel ("PrimeWright LinkedIn profile may
  be out of date").

### Now (this session, cheap agent, no code conflict): PrimeWright content + specs
Research `config/profile-specs.json` and draft PrimeWright's LinkedIn / Reddit / Facebook
profile copy (heading, subheading, bio, standard fields) in CB's voice (no em-dashes, direct,
operator, no fluff), SEO-optimized for GovCon/bid-management, into a seed file the B13 build
imports as PrimeWright's initial `profiles` rows (status 'draft').

### Constraints / tests
No new deps. Cheap model for generation. Human copy-pastes (nothing auto-posts a profile).
`profiles.test.js` (upsert/get/status), API-surface tests, generate 503-safe. Built AFTER B12
commits (shares backend/frontend files). Suite stays green.

---

## B12 — Settings & personalization (spec, 2026-07-15)

*CB: an in-app Settings tab + a global "me" voice that everything inherits, per-brand light
tweaks, rules as visible checkmark toggles I can flip without messaging, and a quick-analytics
action center in a corner popover reachable from any screen. Confirmed: inheritance model;
action center = one corner button → compact popover. Same rules: local `claude -p`, no paid
APIs, human Approve gate untouched.*

### The model — inheritance (global → brand → tone)
- **One global voice = "CB."** Stored once in `settings` (`global_voice` TEXT, seeded from
  `docs/charles-voice-reference.md`). Every brand inherits it.
- **Global rules** in `settings` (`global_hard_rules` JSON), enforced everywhere:
  `{ no_em_dash: true (default ON — CB's flagship global rule), no_emoji_platforms: ["linkedin"],
  banned_words: [] }`.
- **Per-brand tone profiles** (existing `tone_profiles`: business/personal/casual) hold only
  the *light per-business optimization* layered on the global voice — not a from-scratch voice.
- **Effective profile at draft/scrub time** = `global_voice` + brand tone `voice_rules`;
  effective hard_rules = `global_hard_rules` merged with the tone's `hard_rules`. A resolver
  `src/voice.js` `resolveVoice(db, {brand_id, tone})` → `{ voice, hardRules }` is the single
  source consumed by `draft.js`, `copy_assist.js`, `redistribute.js`, and `agent.js`. The
  em-dash strip already runs in `scrub.js`; this just guarantees the global rule is always in
  the merged set regardless of tone.

### Backend
- `settings` keys (via existing `GET/PATCH /api/settings`): `global_voice`, `global_hard_rules`
  (JSON), and per-brand default tone `brand_<id>_default_tone`.
- `src/voice.js`: `resolveVoice(db,{brand_id,tone})` (merge, above); `getGlobalVoice(db)` /
  `getGlobalHardRules(db)` with sane defaults if unset (`{no_em_dash:true}`). Wire the
  resolver into draft/copy_assist/redistribute/agent grounding + the scrub's rule source
  (merge global into the hard_rules passed to `scrubDrafts`).
- `PATCH /api/tone-profiles/:id` — edit a tone's `voice_rules` / `hard_rules` in-app.
  `POST /api/tone-profiles/:id/reset` — clear the brand tweak so it inherits the global voice.
- Seed `global_voice` from the voice-reference doc on first run if unset (don't overwrite an
  edited value).

### Frontend
- **`#/settings` view** (new nav link + route):
  - **Personality**: a textarea for the global voice ("this is me"), plus per-brand tweak
    boxes (pick a brand → edit its 3 tones' `voice_rules`).
  - **Rules** (checkmark toggles, the visible controls CB asked for): no em-dashes (ON), no
    emojis on LinkedIn, banned-words list. Writes `global_hard_rules`.
  - **Per-brand**: brand picker → default-tone dropdown (`brand_<id>_default_tone`), a
    **Reset to global** button per tone, and **Save** — all persisted server-side so they
    stick across devices (not just localStorage).
- **Action-center popover**: ONE corner button (distinct from the + and chat buttons; lives in
  the shell so it's on every view) → a compact popover with quick stats (drafts awaiting,
  scheduled this week, published this month, 30-day engagement) from `/api/usage` +
  `/api/analytics`. Read-only glance; "Open Ops / Analytics →" links through. No new numbers —
  reuses existing endpoints.
- The composer's tone dropdown defaults to the brand's saved default tone.

### Constraints / tests
- No new deps. Approve gate untouched. Global rules always applied (em-dash can be seen +
  toggled but ships ON). `voice.test.js` (merge precedence: global ∪ tone; defaults when
  unset; em-dash always present), plus API-surface tests for tone-profile PATCH/reset and the
  settings round-trip. Full `npm test` stays green.

### Build split (parallel Sonnet, disjoint files)
- **M** = backend: `src/voice.js` + wire resolver into `draft.js`/`copy_assist.js`/
  `redistribute.js`/`agent.js`/scrub source + `server.js` (tone-profile PATCH/reset,
  settings seeding) + `voice.test.js` + API tests.
- **N** = frontend: `#/settings` view + action-center corner popover (`app.js`, `index.html`,
  `styles.css`), against the endpoints above.
- Review (strong): diff + `npm test` + smoke (edit global voice, toggle em-dash, popover shows
  stats, brand default tone drives composer) → commit `working` + docs.

---

## B11 — Assisted-manual upgrade + blog redistribution (spec, 2026-07-15)

*CB: for platforms the API can't (or shouldn't) auto-post — Reddit today, more later — help
write the post well and hand it over to copy-paste; let me ground a draft on an example post
(pasted text OR a screenshot); and let me drop a blog URL and get a batch of social drafts +
image requests out of it. Same rules: no paid APIs, local `claude -p`, human Approve gate.*

**Model routing (CB's explicit ask — don't burn tokens reading images repeatedly):** a
screenshot is converted to text/markdown EXACTLY ONCE by a cheap vision model, the text is
cached on the example row, and everything downstream uses that text. Blog URLs are fetched +
stripped to markdown in plain code (no model). Drafting stays on the existing Haiku budget.
Env `POSTDECK_VISION_MODEL` (default the cheap vision model) for the one-time image pass.

### Data model (migration v5, additive)
- `examples` — id, brand_id (nullable), platform (nullable, e.g. `reddit`), source
  (`paste | screenshot`), text TEXT (pasted text, or the cached extraction of a screenshot),
  image_path TEXT (nullable), tags TEXT (JSON), created_at.
- `ALTER TABLE accounts ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;` — per-account
  "assisted-manual" flag. An account/platform is assisted-manual if `accounts.manual=1` OR
  its platform is `blotato:false` in platform-specs (Reddit). Generalizes the existing Reddit
  channel to any platform CB flags.

### Modules
- `src/extract.js` (no new deps):
  - `extractFromUrl(url)` → `{ title, markdown }`. Fetch the URL, strip scripts/styles/tags
    (prefer `<article>`/`<main>`/`<body>`), collapse whitespace to readable markdown-ish text.
    Pure fetch + string work. Guard against huge pages (cap length).
  - `extractFromImage(imagePath)` → `{ text }`. ONE `claude -p` vision call (cheap model via
    `POSTDECK_VISION_MODEL`, `--output-format json`, budget-capped, 503 contract) that
    returns the post's text as markdown. Callers cache the result — never call twice for the
    same image.
- `src/examples.js`: `listExamples(db,{brand_id,platform})`, `createExample(db,{brand_id,
  platform,source,text?,image_path?,tags?})` — if `source:'screenshot'` and no `text`, call
  `extractFromImage` ONCE and store the returned text (image_path kept for reference only),
  `deleteExample(db,id)`, `examplesGrounding(db,{brand_id,platform,limit=3})` → a short text
  digest fed into the copy assistant / agent as "match the style/format of these examples."
- `src/redistribute.js`: `redistributeFromUrl(db,{url,brand_id,platforms,make_images=true})` —
  `extractFromUrl`, then for each platform draft copy (reuse `copy_assist`/`draft`, grounded
  in brand voice + the article), create a DRAFT post per platform (status `draft`), and if
  `make_images` create one `image_requests` brief from the article's themes. Returns
  `{ source:{title,url}, drafts:[...], image_requests:[...] }`. Human approves as always.

### Endpoints (`server.js`)
- `GET/POST /api/examples`, `DELETE /api/examples/:id`, `POST /api/examples/extract-image`
  (accepts an uploaded image or a `media/` path → returns extracted text preview WITHOUT
  saving, so CB can eyeball before saving).
- `POST /api/redistribute` `{url, brand_id, platforms[], make_images}` → the cluster.
- `PATCH /api/accounts/:id` to toggle `manual`.
- Copy assistant (`/api/copy-assist`) and the agent pull `examplesGrounding` for the target
  platform into their grounding when examples exist.

### Worker + agent
- `worker.js` handoff must NEVER submit assisted-manual accounts/platforms to Blotato (skip
  `accounts.manual=1` and `blotato:false` platforms — Reddit already skipped; generalize).
- `agent.js` gains draft-only tools: `redistribute_blog({url,brand_id,platforms,make_images})`
  and `add_example({brand_id,platform,source,text?,image_path?})`. Still no publish/approve.

### Frontend (`app.js`, `index.html`, `styles.css`)
- **Assisted-manual affordance generalized**: for a manual account/platform, the composer/
  post-detail shows the compose → **Copy** → **Open platform** → **Mark posted** (+paste URL)
  flow (Reddit already has this — extend it to any manual account). A small "manual" toggle
  per account in the composer's Distribute-to list.
- **Examples panel** in the composer (per active platform): paste example text OR upload a
  screenshot (screenshot → `/api/examples/extract-image` preview → save). Saved examples show
  as chips; they feed the copy assistant's grounding automatically.
- **Redistribute-from-blog** input (Home quick-create + Composer): paste a blog URL, pick
  platforms, toggle "make images" → `POST /api/redistribute` → the created drafts appear
  (route to the calendar/home). Also reachable by asking the chat agent.

### Tests / constraints
- No new deps. Local `claude -p` only. Approve→publish stays human. Screenshot read ONCE.
- `extract.test.js` (URL strip on a fixture HTML string; image extract 503 contract with a
  stubbed/absent CLI), `examples.test.js` (CRUD, screenshot→cached-text via a stubbed vision
  bin, grounding digest), `redistribute.test.js` (stub the drafting CLI; assert N platform
  drafts created as `status:'draft'` + image requests when `make_images`), and API-surface
  tests for the new endpoints. Full `npm test` stays green.

### Build split (parallel Sonnet, disjoint files)
- Wave 1: **I** = migration v5 (`db.js`) + `src/extract.js` + `src/examples.js` + unit tests.
- Wave 2 (parallel): **K** = `src/redistribute.js` + wire all endpoints (`server.js`) +
  worker manual-skip (`worker.js`) + agent tools (`agent.js`) + integration tests;
  **L** = frontend (manual affordance + examples panel + redistribute input).
- Review (strong): diff + `npm test` + smoke (paste example grounds a draft; a blog URL
  yields platform drafts; manual account never auto-submits), then commit to `working` + docs.
