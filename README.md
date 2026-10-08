# PostDeck

Local-first multi-brand social scheduler + content studio. Full architecture, data model,
and build plan live in [`SPEC.md`](./SPEC.md) — read that first; current state is in
[`BUILD_STATUS.md`](./BUILD_STATUS.md) and history in [`CHANGELOG.md`](./CHANGELOG.md).
Shipped through **B22.1 + B23**: Fastify + SQLite, dashboard, Blotato worker, Agentic OS bridge,
analytics, Content Studio, image sizing + Codex handoff, chat agent, brand/profile settings,
a provider-registry AI layer (Claude/Codex/Grok) covering every AI call path, editable image
prompts, a designed local command-center UI, and a security/dependency audit wave (see
CHANGELOG **B23**).

## Delivery rule

PostDeck's standing implementation order is:

1. Spec
2. Plan
3. Build
4. Document
5. Commit
6. Deploy
7. Confirm

See [`docs/ENGINEERING_WORKFLOW.md`](./docs/ENGINEERING_WORKFLOW.md) for the
full workflow, GitHub/source-of-truth rule, and parallel worktree hygiene.

## Quickstart

```bash
npm install

# 1. real Blotato account IDs — copy the example and fill it in (gitignored)
cp config/accounts.seed.example.json config/accounts.seed.json
# edit config/accounts.seed.json with real IDs

# 2. env — copy and fill in at least BLOTATO_API_KEY
cp .env.example .env
# optional: set XAI_API_KEY to enable Grok as a drafting/chat provider (see "AI providers" below)

# 3. create the DB + tables (runs automatically on first use, or explicitly:)
npm run migrate

# 4. seed brands, accounts, tone profiles
node src/seed.js

# 5. import existing brand-system CSVs (repeatable — matches on external_id)
node src/import.js clusters "/path/to/brand-system/content_clusters.csv"
node src/import.js posts    "/path/to/brand-system/posts.csv"
node src/import.js leads    "/path/to/brand-system/lead_signals.csv"

# 6. run the API + in-process worker (127.0.0.1:4520 only)
npm start
```

Open `http://127.0.0.1:4520` for the dashboard (Calendar, Ideas, Library, Composer).

## Desktop launcher

If you want a click-to-open launcher instead of terminal steps:

```bash
chmod +x scripts/open-postdeck.command
./scripts/open-postdeck.command
```

That script:
- checks whether PostDeck is already running on `127.0.0.1:4520`
- starts `npm start` in the background if needed
- opens the dashboard in your default browser
- prepends Homebrew and the ChatGPT app resources path to `PATH`, so Finder
  launches can still find `npm`, `claude`, and the bundled `codex` CLI

To place a double-clickable launcher on the macOS Desktop:

```bash
chmod +x scripts/install-desktop-launcher.sh
./scripts/install-desktop-launcher.sh
```

That installs `~/Desktop/PostDeck.command`, which can be pinned in the Dock if
you want a more app-like entry point. If you also install the `launchd` agent
below, the Desktop launcher becomes mostly an "open the dashboard" button.

For a true macOS app launcher with a custom icon:

```bash
chmod +x scripts/install-macos-app.sh
./scripts/install-macos-app.sh
```

By default that looks for `assets/postdeck-icon.png`, builds an `.icns`, and
creates `~/Desktop/PostDeck.app`.

## Tests

```bash
npm test
# or directly:
node --test test/*.test.js
```

Covers: hard-rules scrub (`scrub.test.js`), the Blotato worker against a local
mock server (`blotato.mock.test.js` — never hits the real API), the Agentic OS
export shape (`export.test.js`), TikTok cosmetic-field validation
(`validate.test.js`), and the Approve-gate/reschedule-guard/quiet-hours API
surface end-to-end via Fastify `.inject()` (`server.approve-gate.test.js`).

## AI providers

Claude and Codex run as subscription CLIs (no API key needed - PostDeck reads your
existing `claude`/`codex` login). Grok is the one deliberate exception: it is an
HTTP-only vendor with no subscription CLI, so it's enabled by setting `XAI_API_KEY`
in `.env`. Every AI call path (drafting, copy-assist, chat agent, profiles,
inspiration, vision) routes through the same provider registry - see
[`docs/PROVIDER_LAYER_SPEC.md`](./docs/PROVIDER_LAYER_SPEC.md) for the full design.

`GET /api/ai/providers` lists whichever providers are configured; the frontend
provider switch, compare grid, and Settings selects render from that response, so a
provider with no key/login simply doesn't show up.

Adding provider number four:

1. Copy `src/providers/grok.js` to `src/providers/<name>.js`, change name/label/env
   names/base URL.
2. Add it to the array in `src/providers/index.js`.
3. Add its env var to `.env.example`.

## Backups

A daily SQLite backup of `postdeck.db` runs in-process and writes to
`~/Library/Application Support/PostDeck/backups/`, keeping the last 14.

## Worker env flags (all in `.env`, see `.env.example` for full comments)

| Flag | Default | What it does |
|---|---|---|
| `BLOTATO_DRY_RUN` | `1` (ON) | **Hard safety default.** Only `0`/`false` makes the worker place real create-post/media-upload calls against Blotato. In dry-run, handoff logs what it *would* submit and marks the post `submitted_dry` instead of `submitted` — nothing ever touches the real API. |
| `POSTDECK_WORKER` | `1` (ON) | Only `0`/`false` stops the in-process worker (handoff + verify + export, every 5 min) from starting with the server. |
| `POSTDECK_SYNC_ENABLED` | `1` (ON) | Only `0`/`false` disables the rsync of `state/social-state.json` to the Agentic OS VPS. |
| `BLOTATO_API_BASE` | `https://backend.blotato.com` | REST base — never the MCP server (see SPEC.md Decision 2). |
| `POSTDECK_CAPTURE_DIR` | `./capture-inbox/` | Watched once per worker cycle for `.md`/`.txt` idea drops (see below). |

`handoff_window_hours` (default 48) and the new **quiet hours** (`quiet_start`
`22:00`, `quiet_end` `07:00`) are NOT env vars — they live in the `settings`
table, readable/writable via `GET`/`PATCH /api/settings`.

### Dry-run explained

Every worker cycle runs HANDOFF (submit posts inside the handoff window) then
VERIFY (poll submitted posts for publish status) then EXPORT (write + rsync
`social-state.json`). With `BLOTATO_DRY_RUN=1` (the default, and what ships in
`.env.example`), HANDOFF never calls `POST /v2/media` or `POST /v2/posts` — it
logs the exact payload it would send and flips the post to `submitted_dry`.
VERIFY is a no-op for `submitted_dry` posts (nothing to poll). This lets you
run the whole app, including real scheduling UI flows, with zero risk of an
accidental real post until you deliberately flip the flag.

## B6 polish (this pass)

- **Cosmetic fields wired end-to-end**: TikTok's required Blotato flags
  (`privacyLevel`, `disabledComments`, `disabledDuet`, `disabledStitch`,
  `isBrandedContent`, `isYourBrand`, `isAiGenerated`) and blog fields
  (`title`, `slug` auto-derived from title, `hero` image picked from the
  Library) now persist into `posts.platform_fields` on save and reload on
  edit (Composer + Post Detail's new "Edit" card). Approving a TikTok post
  missing any required flag returns `422 tiktok_fields_missing` with the
  specific missing keys (`src/validate.js`).
- **Drag-to-reschedule**: drag a calendar chip to another day (week or month
  view) to `PATCH publish_at`, keeping the time-of-day and swapping the date.
  Only chips in `draft`/`approved`/`scheduled_local` are draggable in the UI;
  the server independently rejects any `publish_at` change once a post is
  `submitted`+ with `409 not_reschedulable` (`src/server.js`).
- **Quiet hours**: `GET/PATCH /api/settings` exposes `quiet_start`/`quiet_end`
  (default `22:00`/`07:00`, wraps midnight). Approving a post scheduled inside
  that window shows a `confirm()` dialog in the dashboard — a soft warning,
  never a hard block. `GET /api/settings/quiet-hours-check?publish_at=<iso>`
  backs it.
- **launchd agent**: `scripts/install-launchd.sh` installs
  `~/Library/LaunchAgents/com.postdeck.plist` (`RunAtLoad` + `KeepAlive`,
  runs `node src/server.js` with `WorkingDirectory` set to the repo, logs to
  `logs/postdeck.{out,err}.log`). Run `--uninstall` to tear it down. This repo
  only ships and syntax-checks the script (`bash -n scripts/install-launchd.sh`)
  — installing it is a standing background process, so run it yourself when
  ready:
  ```bash
  chmod +x scripts/install-launchd.sh   # already executable in the repo
  ./scripts/install-launchd.sh          # install + load
  launchctl list | grep com.postdeck    # verify it's running
  ./scripts/install-launchd.sh --uninstall
  ```

## Going live with real Blotato calls — checklist

1. **Regenerate the Blotato API key.** The one on file currently 401s.
   Generate a fresh one in the Blotato dashboard and drop it into `.env` as
   `BLOTATO_API_KEY`.
2. **Flip `BLOTATO_DRY_RUN=0`** in `.env` once the key is confirmed good (curl
   a cheap Blotato GET endpoint with it first).
3. **First real post: supervised, lowest-stakes account.** Schedule a single
   throwaway post to whichever connected account matters least (a burner or
   your least-visible page), watch the worker log the HANDOFF, and confirm in
   Blotato's own dashboard that it actually went out before trusting anything
   else through the pipe.
4. **Restart the server** after any `.env` change — dry-run/worker/sync flags
   are read at process start (mostly; `isDryRun()`/`workerEnabled()` do
   re-read `process.env` per-call, but a full restart is the reliable way to
   pick up `.env` file edits since nothing auto-reloads the file itself).
5. Only after a real post round-trips cleanly: schedule normally.

## Idea capture from the road (usage)

No new plumbing — CB texts the Agentic OS Telegram bot ("idea: ..."), AOS
drops a `.md`/`.txt` file into `capture-inbox/` (path configurable via
`POSTDECK_CAPTURE_DIR`), and the worker's `importCapturedIdeas` step
(`src/capture.js`) picks it up on the next 5-minute cycle, creating an
`ideas` row with `status: 'idea'`, `source: 'telegram-capture'`, and moving
the file into `capture-inbox/processed/` so it isn't re-imported. At-desk
capture: the "+ Add idea" quick-add box on the Ideas Board does the same
thing synchronously via `POST /api/ideas`.

## Endpoints (current)

Read (B1/B2):
- `GET /api/health`, `GET /api/brands`, `GET /api/accounts?brand=<slug>`
- `GET /api/ideas?brand=&status=`, `GET /api/posts?brand=&status=&from=&to=`
- `GET /api/posts/:id` (includes `metrics[]`), `GET /api/posts/:id/preview` (blog render)
- `GET /api/tone-profiles?brand_id=&name=`, `GET /api/platform-limits`
- `GET /api/media`, `GET /api/export/social-state`, `GET /api/worker/status`
- `GET /api/settings`, `GET /api/settings/quiet-hours-check?publish_at=`

Write/lifecycle (B3+):
- `POST /api/posts`, `PATCH /api/posts/:id` (copy/media/platform_fields/publish_at/status)
- `POST /api/posts/:id/metrics`, `POST /api/posts/:id/submit` (submit-now, B4)
- `POST /api/ideas`, `PATCH /api/ideas/:id`
- `POST /api/media` (multipart upload), `POST /api/draft` (AI drafting)
- `PATCH /api/settings` (quiet hours, handoff window)

Recovery (2026-10-07):
- `POST /api/posts/:id/recheck` (one Blotato status poll for `failed_verify` / `submitted`)
- `POST /api/posts/:id/mark-posted` (record a live URL; resolves `needs_check` too)
- `PATCH /api/posts/:id` accepts `failed` / `failed_verify` / `needs_check` -> `draft` | `canceled`

Blog add-on (`docs/BLOG_ADDON_SPEC.md`):
- `GET /api/blog/sites`, `GET /api/blog/sites/:site/schema`, `GET|POST /api/blog/sites/:site/posts`,
  `GET|PATCH /api/blog/sites/:site/posts/:slug` (PATCH needs `mtime`; 409 `changed_on_disk`)
- `POST /api/blog/sites/:site/posts/:slug/{approve,schedule,unschedule,release-now,preview}`
- `POST /api/blog/sites/:site/release`, `GET /api/blog/sites/:site/releases`, `GET /api/blog/preview/:token/*`
- `POST /api/blog/draft` (AI). Env: `POSTDECK_WEBSITES_ROOT`, `POSTDECK_PYTHON`.

Voice:
- `GET /api/brands/:id/voice`, `PUT /api/brands/:id/voice` `{ text }` (brand voice doc; `.md` files under the
  Projects folder, e.g. each site's `brand-voice.md`; 409 for the brand whose doc is the global voice card)
- `GET /api/voice/resolve?brand_id=&tone=` (the exact voice text a draft gets)

Website analytics (`docs/WEB_ANALYTICS_SPEC.md`):
- `GET /api/web/{status,sites,overview,channels,pages,search,social,health,realtime,home,blog-stats,daily}`,
  `GET /api/web/post/:id` (query: `brand_id`, `site_id`, `range` = 7|28|90|365)
- `POST /api/web/sites`, `DELETE /api/web/sites/:id`, `group=own|client` filter on read endpoints; `POST /api/brands` `{ name, slug?, color? }`
- `PATCH /api/web/sites/:id`, `POST /api/web/sync` `{ site_id?, source? }`, `POST /api/web/digest` (AI summary)
- `POST|DELETE /api/web/google-key` (service account key; stored 0600 outside the repo, never echoed)
- Env: `POSTDECK_WEB_SYNC=0` (no background sync), `POSTDECK_GOOGLE_SA` (key path),
  `POSTDECK_VPS_HOST` (ssh host alias for the read-only server-log pull)

## Architecture

See [`SPEC.md`](./SPEC.md) for the full picture (Blotato handoff model, worker, every build
wave). Current state: [`BUILD_STATUS.md`](./BUILD_STATUS.md). Latest audit and plan:
[`docs/AUDIT_2026-10-07.md`](./docs/AUDIT_2026-10-07.md); UI contract:
[`docs/DESIGN_WAVE_SPEC.md`](./docs/DESIGN_WAVE_SPEC.md).

**Frontend** (`public/`, no build step): `index.html` loads classic scripts from `public/js/`
in a fixed order; they share one global scope (a later file's same-named function overrides
an earlier one; a duplicate top-level `const`/`let` breaks the whole file). `00-core.js` holds
the shared primitives (`el`, `api`, `toast` with Undo, `confirmDialog`/`promptDialog`,
`humanStatus`/`statusPill`, overlay + view-cleanup registries), `01-router.js` the router
(same-hash calls refresh in place), `99-main.js` the route table and boot. Views: `30-planner.js`
(Planner), `31-post-drawer.js` (the one editor for existing posts), `40-create.js` (New post
sheet), `50-home.js`, `60-settings.js`, plus Analytics and the Labs tools. CSS: `styles.css`
(legacy base), `css/foundation.css` (tokens + shared components), one file per view.
