# PostDeck - Build Status

_Last updated: 2026-07-19. One-page state of the build. Full design: `SPEC.md`. History:
`CHANGELOG.md`._

## Where it stands

Local-first multi-brand social scheduler + content studio. Runs on `127.0.0.1:4520`
(`npm start`). **300/300 tests passing.** Dry-run is the hard default unless deliberately
flipped.

## Built (done)

| Wave | What | State |
|---|---|---|
| B1 | Fastify + SQLite skeleton, migrations, seed, CSV importers | ✅ |
| B2 | Dashboard read views (calendar, detail, ideas, library) | ✅ |
| B3 | Composer + post lifecycle, media upload, AI drafting + scrub | ✅ |
| B4 | Blotato worker (48h handoff, verify, dry-run, submit-now) | ✅ |
| B5 | Agentic OS bridge (state export + rsync), idea capture inbox | ✅ |
| B6 | Drag-reschedule, quiet hours, launchd installer, cosmetic fields | ✅ |
| B7 | Analytics portal (engagement rollups, top posts, SVG charts) | ✅ |
| B8 | Content Studio (copy assist, content-type, image handoff, ops stats, research/inspiration) | ✅ |
| B9 | Home command center + double-render fix | ✅ |
| - | Design pass (elevation/gradients/icons/motion) | ✅ |
| B10 | Floating + button, sticky brand, in-app chat agent (draft-only) | ✅ |
| - | Launcher/deploy infra (env.js, launchd service, launchers, workflow doc) | ✅ |
| B11 | Assisted-manual (any platform) + example grounding (text/screenshot) + blog→social redistribution | ✅ |
| B12 | Settings & personalization (global voice + rules, per-brand tones, action-center popover) | ✅ |
| B13 | Brand profiles (source of truth + per-platform generate + staleness) - PrimeWright seeded | ✅ |
| B14 | Image studio v2 (variant count/regenerate/sips resize), branding in Settings, armed agent publish authority | ✅ |
| B15 | AI provider switcher (Claude/Codex) for copy drafting + compare-both button; both via subscription CLIs | ✅ (Codex path verify-on-signin) |
| - | Editable image prompt system + settings UI + design pass refresh | ✅ |
| - | PrimeWright design guidelines persisted in `docs/PRIMEWRIGHT_DESIGN_GUIDELINES.md` | ✅ |
| B16 | Queue slots (recurring brand+platform slots, "Add to queue", Settings editor) + grouped left nav rail | ✅ |
| B17 | Tags & campaigns (composer picker, calendar filter/colors, scoped analytics) + calendar gap-finding (count dots, empty-day, coverage strip) | ✅ |
| B18 | Best-time nudge (data-driven + defaults), Redraft-the-winner, per-brand UTM auto-append at approve | ✅ |
| D2 | Design consistency pass (Seeds-informed): button/input/toggle system, pageHeader/formSection/toast/banner/emptyState primitives, composer reorder, Settings zones, full-view sweep | ✅ |
| - | Composer UX wave (CB feedback): Quick Compose modal on +, collapsible/drag-reorder sections, Edit-prompts button, Waiting-on-Codex status, metrics quick-entry + CSV analytics import | ✅ |
| B19 | Flow wave: network post preview w/ fold line, Review mode (#/review), calendar popover + Upcoming agenda view, platform icon set, idea-drag to calendar, duplicate/copy-to-brand w/ re-voice, shortcuts + Cmd+K palette, brand setup card | ✅ |
| - | Composer v3 (single dense form, image placeholder tile, day popover) + send controls (per-post/bulk send-now, sync-now, status pill), startup catch-up + missed-window flagging, manual-account badges, All-Brands identity, image auto-fit pipeline, first-comment (auto on X/threads, reminder on LinkedIn/FB), alt text | ✅ |

## Security posture (reviewed 2026-07-15)

- Localhost-only (`127.0.0.1`), single operator, **no auth/CSRF by design**. Repo private.
- Secrets (`.env`, `config/accounts.seed.json`) gitignored + untracked; no hardcoded keys.
- Fixed: path-traversal on `/api/media/resize` + `/api/examples/extract-image` (now confined to
  `media/`). `execFile` (no shell injection), parameterized SQL, no `innerHTML`-with-data XSS.
- Watch: keep `agent_can_publish` OFF unless supervising (localhost CSRF + prompt-injection from
  ingested content could otherwise reach the publish path; DRY-RUN is the backstop). If the app
  is ever exposed beyond localhost, add auth + CSRF/Origin checks first.

## Pending / open loops

- **B16–B18 ALL SHIPPED 2026-07-18** (suite 247). Parking lot from the competitive spec
  (list view, streams-lite, queue re-flow, ICS export) remains in
  `docs/B16_B18_COMPETITIVE_WAVE_SPEC.md`. Queues + UTM start OFF/empty - CB defines slots
  in Settings → Queues and flips Link tracking per brand when ready.
- **D2 SHIPPED 2026-07-18** (rules R1–R8 + layout moves; see CHANGELOG). Leftover polish
  candidates: fold remaining `.msg-banner` divs onto `inlineBanner`, custom confirm dialog
  to replace native confirm() on destructive actions, L1 icon-rail hover-expand polish.

- **Run PostDeck in your logged-in session, not as a background service** (resolved 2026-07-15).
  Root cause of the AI-features 503: Claude Code stores its subscription login in the macOS
  **Keychain**, which a **background launchd agent cannot reliably read** - so `claude -p`
  returned "Not logged in" under the service. This is local-by-design (no API keys, no cloud),
  so the fix is to run it in-session: the `com.postdeck` launchd agent was **removed**; launch
  via `~/Desktop/PostDeck.command` / `PostDeck.app` (or `scripts/open-postdeck.command`, or
  `npm start` in Terminal). In your GUI session `claude` (and `codex`) reach the Keychain, so
  all AI features work on your subscription. If AI still shows unavailable, run `claude` +
  `/login` (and `codex login`) once in Terminal, then relaunch. Trade-off: it runs while you
  have it open, not 24/7 (fine - the point is local, on your machine).
- **Codex CLI discovery** (resolved 2026-07-15): desktop/Finder launches could miss Codex even
  when it was installed, because the bundled binary lived at
  `/Applications/ChatGPT.app/Contents/Resources/codex` instead of a normal PATH location.
  PostDeck now auto-detects known bundled Codex paths and the launcher prepends the ChatGPT app
  resources dir to PATH before starting the app.
- **Facebook page/subaccount mapping**: live posting is now proven on X and LinkedIn, but
  Di-Hy Facebook still returns `Page / subaccount not found`. The top-level Facebook account
  is connected, but the Di-Hy page itself still needs to appear as a valid Blotato
  page/subaccount target before Facebook business posting is considered live-ready.
- **Blog deploy hook**: blog channel renders/previews only; wiring publish → static-site
  deploy waits on the wp-to-static migration completing.
- **Native Reddit adapter**: Reddit is assisted-manual by design; a native OAuth submit is a
  tracked follow-up only if volume justifies it.
- **Real API seams (deferred, no spend now)**: SEO metrics (Ahrefs/DataForSEO) and social
  listening are stubbed - `research_notes` + inspiration `source` fields are the manual-now /
  API-later boundary. Codex image generation runs in the Codex app (no PostDeck API cost).
  Image prompt settings are now editable in Settings and carried into every handoff spec.
- **PrimeWright design source**: `docs/PRIMEWRIGHT_DESIGN_GUIDELINES.md` is now the persisted
  UI/UX direction for PrimeWright website/app passes.
- **launchd**: installer ships but is not auto-run - start it when ready
  (`scripts/install-launchd.sh`).
- **Repo公开**: private until a git-history squash before going public at MVP polish.

## Handy env flags (see `.env.example`)

`BLOTATO_DRY_RUN` (default 1/on), `POSTDECK_WORKER` (default 1/on), `POSTDECK_SYNC_ENABLED`,
`POSTDECK_CAPTURE_DIR`, `POSTDECK_RESEARCH_DIR`, `POSTDECK_IMAGE_REQ_DIR`, `POSTDECK_MEDIA_DIR`.
