# PostDeck - Build Status

_Last updated: 2026-10-07. One-page state of the build. Full design: `SPEC.md`. History:
`CHANGELOG.md`._

## Where it stands

Local-first multi-brand social scheduler + content studio. Runs on `127.0.0.1:4520`
(`npm start`). **491 passing.** Current audit + plan: `docs/AUDIT_2026-10-07.md`; UI contract:
`docs/DESIGN_WAVE_SPEC.md`.

> ⚠️ **`BLOTATO_DRY_RUN=0` in `../config/.env` - posting is LIVE.** Dry-run is the *code*
> default but the running instance is deliberately flipped to live. Approving a post whose
> `publish_at` is inside 48h hands it to Blotato on the next worker cycle (~5 min), and
> **Blotato cannot delete.** Check the DRY RUN / live pill in the nav rail before approving.

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
| B20 | Bulk approve (`approve-batch` + agenda multi-select + sticky bulk bar), Approve in the calendar popover, draft-first detail page (Edit above Metrics; Metrics hidden until published) | ✅ |
| B21 | Draft-with-AI seed field + variant strip (v1/v2/v3), per-platform char counts (no more blended minimum), `publish-now` endpoint + confirmed `Post now` button | ✅ |
| B22 | Publishing workflow redesign: review drawer, one delivery choice, quick scheduling, account cards, link-high guidance, manual-post reconciliation | ✅ |
| B22.1 | Home `Needs attention` per-item dismiss, Dismiss all, persistent exact-state re-arm | ✅ |
| B23 | Audit wave: Fastify 5 / dep upgrade (0 vulns), Origin/Host request guard, in-process submit claim, migration v11 (`metrics.post_id` index), daily SQLite backups, provider-layer AI registry (Claude/Codex/Grok) | ✅ |
| B24 | Oct audit fixes: voice seeding path, scheduling time bugs, double-post guard + `needs_check`, failed/failed_verify recovery + `/recheck`, 24h verify + `publicUrl`, UTC `publish_at` (migration v12), short-notice handoff, tighter origin guard, one approve gate, per-brand voice docs | ✅ |
| D4 | Blog add-on: Blog view over the Website Projects HTML blog programs (write/paste/AI draft, real-template preview + QA, approve, schedule with time, Release now, scheduled release while open, release log), Planner/Home/Settings integration, migration v13 | ✅ |
| W1 | Website analytics: Analytics > Websites (server logs now, GA4 + Search Console when the key is added), own-traffic filter, Home/Blog/drawer/Planner hooks, Settings > Websites, UTM `pd-<id>`, migration v14. Spec `docs/WEB_ANALYTICS_SPEC.md` | ✅ |
| D5 | Ease pass from CB's feedback: closable/compact Home alerts, Planner busy-day folding, readable drawers (type, brand, read-first blog), collapsible Blog lists, client sites + add site/brand, visual spacing/contrast pass, no-cache app files, migration v15. Spec `docs/D5_EASE_PASS_SPEC.md` | ✅ |
| D3.1 | Paste-your-own brand voice in Settings (writes the brand voice doc), long-dash normalization on every voice source | ✅ |
| D3 | Redesign: 4-item nav + Labs, Planner (week/month/list, filters, drafts tray, drag), one post drawer with recovery panels, New post sheet (idempotent, autosaved), Home, Settings tabs, in-place refresh, in-app dialogs, flat dark+gold tokens, `public/js/` split | ✅ |

## Security posture (reviewed 2026-09-02, updated 2026-10-07)

- Localhost-only (`127.0.0.1`), single operator. Repo is private on GitHub - not published for
  broader visibility.
- Secrets (`.env`, `config/accounts.seed.json`) gitignored + untracked; no hardcoded keys.
- Fixed: path-traversal on `/api/media/resize` + `/api/examples/extract-image` (now confined to
  `media/`). `execFile` (no shell injection), parameterized SQL, no `innerHTML`-with-data XSS.
- **New (B23): Origin/Host guard** on state-changing routes closes the CSRF / DNS-rebinding gap
  the audit flagged - a stray web page open in the browser can no longer `fetch()` the local API.
- **New (B23): in-process submit claim** stops "Submit now" from racing the 5-minute handoff
  sweep into a double-post against Blotato.
- **New (B24): post creation is never auto-retried.** An ambiguous failure parks the post in
  `needs_check` instead of resending (Blotato can't delete). Writes with `Origin: null` or
  `Sec-Fetch-Site: cross-site|same-site` are refused.
- **Fastify 5**, `@fastify/static` 10, `@fastify/multipart` 10 - `npm audit` reports 0
  vulnerabilities.
- Watch: keep `agent_can_publish` OFF unless supervising (prompt-injection from ingested content
  could otherwise reach the publish path; DRY-RUN is the backstop). If the app is ever exposed
  beyond localhost, add auth first.

## Pending / open loops

- **Website analytics: built 2026-10-07, two steps left for CB.** (1) Google: create the read-only
  service account and paste the key in Settings > Websites (steps are on that page). Until then
  the dashboard runs on server logs only. (2) The sites still need the own-traffic script and the
  missing lead events (cholmesiv.com contact page; Lunula unconfirmed). That edit was not made
  from this session because those website folders hold other sessions' unsaved work; do it from
  each site's own session (spec "Own traffic" and "Measurement fixes"). Also: mark
  `generate_lead` as a Key event in each GA4 property, create a GA4 property for IVision.
- **Brand voices: settled 2026-10-07.** CB asked for them to be written for him, built on his
  voice (influences Hormozi, Gary Vee, Robbins, Cardone), and kept with each website's branding
  docs. Files: `Website Projects/<Site>/.../brand-voice.md` and
  `PrimeWright/brand-package/primewright-2026/brand-voice.md` (untracked in the PrimeWright repo,
  which another agent shares; commit it from there). Edit any of them in Settings > Brands > Voice.
- **Labs review 2026-11-07:** delete whatever under Labs is still unused (Research, Inspiration,
  Ideas, Library, Images, Redistribute, chat agent). Check `usage_events` + table row counts.
- **Facebook pages:** Di-Hy Facebook 422s "Page / subaccount not found" and the CHolmesIV
  Facebook account has no pageId. Connect the pages in Blotato, then set the page target per
  account (`listSubaccounts` in `src/blotato.js` exists for this).
- **Old "Not confirmed" posts 19, 21, 42 (and Di-Hy 1):** open each in the Planner and use
  "Check again" or "Mark as posted". They are probably live.
- **Blog add-on follow-ups:** Planner List view should show blog posts; Lunula live links should
  use `/insights/` (its posts don't live under `/blog/`); preview for Di-Hy and Lunula (their
  builders aren't named `build_blog.py`); optional auto-release setting (CB, later). CHolmesIV's
  35 posts are drafts awaiting review: approve and schedule them in the Blog view.
- **Small UI follow-ups:** bulk "Schedule selected" in Planner List view; metrics entry from the
  post drawer (today: Analytics > Metrics due).

- **Blotato analytics API seam:** Blotato now shows analytics in its own web app, but its public API
  documentation did not expose engagement metrics when checked 2026-08-12. PostDeck keeps its
  LinkedIn/Meta CSV import as the supported bridge. Revisit when Blotato documents an analytics
  endpoint or stable export contract.

- **⚠️ PARTIALLY BUILT — Fix wave: notification dismiss + image review**
  (`docs/FIX_WAVE_NOTIF_IMAGES_SPEC.md`, captured 2026-07-22). P1 shipped 2026-08-12:
  `Needs attention` rows now have persistent per-item dismiss and Dismiss all controls, with
  exact-state keys that re-arm when a condition changes. P2 remains unbuilt: Codex-generated
  images are unreviewable — the handoff requires a
  `manifest.json` in `image-requests/generated/req-<id>/`, the worker's `importGeneratedImages`
  only imports via that manifest, and the ONLY review surface is the "Waiting on Codex" tile
  inside a specific post's composer. Fix = global Image Requests review view (P2a),
  loose-file/auto-manifest rescue (P2b), optional direct upload (P2c). Build order + acceptance
  in the spec. P2 awaits CB go.
- **B16–B18 ALL SHIPPED 2026-07-18** (suite 247). Parking lot from the competitive spec
  (list view, streams-lite, queue re-flow, ICS export) remains in
  `docs/archive/B16_B18_COMPETITIVE_WAVE_SPEC.md`. Queues + UTM start OFF/empty — CB defines slots
  in Settings → Queues and flips Link tracking per brand when ready.
- **D2 SHIPPED 2026-07-18** (rules R1–R8 + layout moves; see CHANGELOG). Leftover polish
  candidates: fold remaining `.msg-banner` divs onto `inlineBanner`, custom confirm dialog
  to replace native confirm() on destructive actions (done in D3), L1 icon-rail hover-expand polish.

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
- **Repo:** private `CHolmesIV/postdeck`, `main` fast-forwarded to `working` (2026-10-07, CI green). Public snapshot `CHolmesIV/postdeck-oss` refreshed 2026-10-07 from private `4748944` (scrubbed: no VPS host or ssh alias, no key names, no personal paths or IPs, no SOCIAL_STATUS, no Codex task brief; remote tree and full history re-checked clean). Refresh it by hand after future work, same scrub.
  for that reason alone.
- **Per-brand timezone** - queue slots and best-times are machine-local. The Mac reported
  America/Chicago on 2026-10-07; Tampa is Eastern, so after the move every local slot shifts one
  hour (audit D3). Stored `publish_at` is UTC and is not affected.
- **`sync.js` host/key defaults should move to `.env`** - hostname and key path are currently
  hardcoded in source (audit S5).

## Handy env flags (see `.env.example`)

`BLOTATO_DRY_RUN` (default 1/on), `POSTDECK_WORKER` (default 1/on), `POSTDECK_SYNC_ENABLED`,
`POSTDECK_CAPTURE_DIR`, `POSTDECK_RESEARCH_DIR`, `POSTDECK_IMAGE_REQ_DIR`, `POSTDECK_MEDIA_DIR`.
