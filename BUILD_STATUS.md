# PostDeck - Build Status

_Last updated: 2026-07-14. One-page state of the build. Full design: `SPEC.md`. History:
`CHANGELOG.md`._

## Where it stands

Local-first multi-brand social scheduler + content studio. Runs on `127.0.0.1:4520`
(`npm start`). **86/86 tests passing.** Dry-run is the hard default unless deliberately
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

## Security posture (reviewed 2026-07-15)

- Localhost-only (`127.0.0.1`), single operator, **no auth/CSRF by design**. Repo private.
- Secrets (`.env`, `config/accounts.seed.json`) gitignored + untracked; no hardcoded keys.
- Fixed: path-traversal on `/api/media/resize` + `/api/examples/extract-image` (now confined to
  `media/`). `execFile` (no shell injection), parameterized SQL, no `innerHTML`-with-data XSS.
- Watch: keep `agent_can_publish` OFF unless supervising (localhost CSRF + prompt-injection from
  ingested content could otherwise reach the publish path; DRY-RUN is the backstop). If the app
  is ever exposed beyond localhost, add auth + CSRF/Origin checks first.

## Pending / open loops

- **AI features need the `claude` CLI logged in** (verified 2026-07-15 - NOT a PATH issue; the
  service PATH already includes `/opt/homebrew/bin` where `claude` lives). Running the app's
  exact `claude -p ...` invocation returns `"Not logged in · Please run /login"`, so the agent,
  copy-assist, blog drafting, profile Generate, and screenshot-to-text all 503 gracefully. FIX:
  run `claude` + `/login` in a terminal (uses CB's existing subscription, no extra API cost),
  then confirm the launchd `com.postdeck` service can read those creds (file under `~/.claude`
  is picked up automatically; if creds are keychain-scoped the non-interactive service may need
  them made reachable). Test via the chat drawer once logged in. This is the master switch for
  all AI features.
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
- **launchd**: installer ships but is not auto-run - start it when ready
  (`scripts/install-launchd.sh`).
- **Repo公开**: private until a git-history squash before going public at MVP polish.

## Handy env flags (see `.env.example`)

`BLOTATO_DRY_RUN` (default 1/on), `POSTDECK_WORKER` (default 1/on), `POSTDECK_SYNC_ENABLED`,
`POSTDECK_CAPTURE_DIR`, `POSTDECK_RESEARCH_DIR`, `POSTDECK_IMAGE_REQ_DIR`, `POSTDECK_MEDIA_DIR`.
