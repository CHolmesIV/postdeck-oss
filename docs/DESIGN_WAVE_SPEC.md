# PostDeck Design Wave (D3) - Spec

> **Status: SHIPPED 2026-10-07.** Browser QA on the sandbox at 1440x900 and 1280x800: all routes
> render with zero console errors; idea -> scheduled on LinkedIn + Facebook in 3 clicks after
> typing; drag reschedule with Undo; failed / not-confirmed / check-before-resending posts
> resolvable from the drawer; no Loading swap after actions; Esc and navigation keep unsaved work;
> no native dialogs left. Deviations: no bulk "Schedule selected" in List view; metrics entry
> stays in Analytics; Cancel post confirms instead of Undo (canceled is final); legacy wrappers
> `07-quick-compose.js` and `14-ops.js` remain (thin redirects), the other replaced files were
> deleted.

_Written 2026-10-07. Source: `docs/AUDIT_2026-10-07.md` (findings, competitor patterns, target
shape). This doc is the build contract: what changes, who owns which files, the API contract
between backend and frontend, and the acceptance checks._

## Goal

CB should be able to open PostDeck, see what's going out and what needs him, and get an idea
scheduled across a brand's accounts in under a minute, without wondering which button does what.
It should feel like Buffer/Publer: things update where you clicked, nothing blanks to "Loading…",
nothing is lost, every failure says what happened and what to do.

## Design direction

**Scene.** CB at his MacBook, usually evenings after running his other businesses, a 10-20
minute posting session across five brands. Dark ink + gold is his established CHolmesIV identity
and suits evening use. Keep it. The problem is decoration and structure, not the palette.

**Register:** product UI. The tool disappears into the task. Familiar affordances, dense where
useful, consistent components everywhere.

**Color strategy: restrained.** Tinted dark neutrals; gold is the only accent and is used only for
the primary action, current selection and focus (well under 10% of any screen). Status colors are
semantic and fixed:

| Status (user-facing) | Internal statuses | Tone |
|---|---|---|
| Draft | draft | neutral |
| Scheduled | approved, scheduled_local | gold |
| Sending | submitted, submitted_dry ("Sent to Blotato" / "Dry run") | blue |
| Posted | published | green |
| Needs attention | failed, failed_verify, needs_check, scheduled_local + missed_window | red |
| Canceled | canceled | muted |

Raw internal names (`scheduled_local`, `failed_verify`, `submitted_dry`) never appear in the UI.

**Remove (absolute bans / product bans):** gradient-clipped logo text, gradient buttons, page
background gradients, glow shadows, the 3px side-stripe on nav items, uppercase tracked eyebrows
on every panel (`NEEDS ATTENTION`, `THIS WEEK`...), the `viewIn` slide replaying on every refresh.

**Type:** one system sans (`-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Inter,
sans-serif`). Fixed scale: 12 / 13 / 14 (base UI) / 15 (editor copy) / 17 / 20 / 24. Panel
headings are sentence case, 15px semibold. Numbers use `font-variant-numeric: tabular-nums`.

**Space:** 4px grid tokens (`--s-1` 4px ... `--s-8` 32px). **Radius:** 6 / 8 / 12. **Z-index
scale:** `--z-sticky 10, --z-dropdown 20, --z-drawer 30, --z-modal 40, --z-toast 50, --z-tooltip
60`. Never raw 999s.

**Motion:** 150-200ms, ease-out-quart, state only (drawer slide, toast in/out, row insert/remove,
chip drag). No page-entrance animation on refresh. `prefers-reduced-motion`: crossfade/instant.

**Every interactive component** has default, hover, focus-visible, active, disabled, loading and
error states. Loading = skeleton rows on first paint of a view, never a centered spinner and never
a "Loading…" text swap of the live view.

## Information architecture

| Nav item | Route | What it is | Replaces |
|---|---|---|---|
| Home | `#/home` | Today: needs attention, coming up (7 days), drafts waiting, one "New post" | Home |
| Planner | `#/planner` | Week (default) / Month / List, status filter, drafts tray, brand filter, drag to reschedule, click an empty slot to create; one post drawer for everything | Calendar/Queue, Review, agenda, quick-view modal, post detail as an editor |
| Analytics | `#/analytics` | As today, restyled | - |
| Settings | `#/settings` | Tabs: Brands (voice, tones, accounts, queue slots, profiles, branding), AI, System (Blotato, live/dry-run, worker, backups) | Settings, Profiles, Ops Stats |
| Labs | `#/labs` | Collapsed nav group: Research, Inspiration, Ideas, Library, Images, Redistribute blog, Ask PostDeck (chat) | those routes |

**Create** is not a page: it is a sheet (full-height right panel, 960px max) that opens over
whatever you are looking at, from the FAB, `C`, Home "New post", or an empty Planner slot (brand,
date and time prefilled). `#/create` opens Planner with the sheet open, so it is linkable.

Old routes redirect: `calendar`, `review` -> `planner`; `composer` -> `create`; `post/:id` ->
`planner` with that post's drawer open; `profiles` -> `settings/brands`; `ops` ->
`settings/system`; `research`, `inspiration`, `ideas`, `library`, `images` keep working under Labs.

**Labs policy (CB, 2026-10-07):** Research, Inspiration, Ideas, blog redistribution and the chat
agent are hidden under Labs. If still unused on **2026-11-07**, delete them (code, routes, tables).
Chat agent stays draft-only.

Floating buttons: one FAB (New post). Quick-stats and chat toggles are removed from the corner.
The live/dry-run pill stays in the nav footer and is the one place that says whether posting is
real.

## Core interactions

1. **Post drawer (single editor for existing posts).** Opened from Planner, Home, search,
   `#/post/:id`. Shows preview, copy (autosaves 800ms after typing stops for draft/scheduled
   posts), time (presets: Later today, Tomorrow 9 AM, next weekday slot), and one primary action
   whose label follows the choice: Save draft / Schedule / Add to queue (only if the brand has
   slots) / Post now. Esc or route change with unsaved edits -> custom confirm, never silent loss.
   Recovery panels by status:
   - `needs_check`: existing panel (Mark as posted with URL / It didn't post - move to draft).
   - `failed`: the error in plain words, then Fix and reschedule (moves to draft, keeps copy),
     Cancel post.
   - `failed_verify`: "Blotato never confirmed this. It may be live." Recheck now
     (`POST /api/posts/:id/recheck`), Mark as posted with URL, Move to draft.
   - missed window (scheduled, time passed while the app was closed): Send now / Pick a new time.
2. **Create sheet.** Brand chips first (sticky brand preselected). Selecting a brand preselects
   all its active connected accounts (deselect to remove). One "What's the post about?" box; Draft
   with AI writes into the post box below it and keeps v1/v2/v3 chips; the idea stays put. "Customize
   per network" toggle reveals per-account tabs, each seeded from the main copy; AI drafts fill
   each network's own draft (no more discarding the second network). Live preview beside the
   editor. Image: attach from library / upload / request from Codex (collapsed row). Advanced
   (tags, campaign, first comment, alt text) collapsed. Delivery: Draft / Schedule (3 time
   chips + picker, quiet-hours warning inline) / Next open slot (only when the brand has slots) /
   Post now (confirm names the accounts and says LIVE or DRY RUN). **One save creates the posts
   once; every later save PATCHes the same ids. Buttons disable while a request is in flight.**
   Unsaved sheet content is kept in localStorage per brand and restored on reopen.
3. **Planner.** Week view default, Month and List toggles. Status filter chips: All, Drafts,
   Scheduled, Posted, Needs attention (with counts). Brand filter (sticky, and it prefills Create).
   Drafts tray on the right: unscheduled drafts; drag one onto a day/time to schedule it. Hover an
   empty slot -> "+" -> Create prefilled. Drag a chip to reschedule (optimistic move, revert on
   error with a toast). Days are local days (`postDayKey`).
4. **Live feel (foundation, applies everywhere).**
   - `refreshView()` re-renders the current route in place: no "Loading…" swap, scroll and focus
     kept. Called after any mutation and on window focus.
   - Route change: closes drawers/sheets/popovers/modals, scrolls to top, runs registered view
     cleanups (intervals, listeners).
   - `confirmDialog({title, body, confirmLabel, tone})` -> Promise<boolean> (native `<dialog>`).
     Replaces every `confirm()`, `alert()`, `prompt()`.
   - `toast(msg, {tone, action: {label, onClick}, duration})`; destructive-but-reversible actions
     (move to draft, cancel, trash a draft) use an Undo toast instead of a confirm.
   - `api()` failures surface a toast unless the caller handles them; no swallowed errors.
   - Status shown via `statusPill(post)` / `humanStatus(post)` only.

## Ownership (parallel build)

Frontend is classic scripts in `public/js/` sharing one global scope (order in `index.html`).
Each owner edits only their files. New CSS goes in the owner's own file under `public/css/`.

| Owner | Files | Work |
|---|---|---|
| Foundation (lead) | `00-core.js`, `01-router.js`, `20-chrome.js`, `21-palette-main.js`, `99-main.js`, `index.html`, `styles.css` | tokens, shell, nav, router, refreshView, confirmDialog, toast+undo, statusPill/humanStatus, Labs route, redirects |
| Backend (agent) | `src/**`, `test/**` except voice files | API contract below + trust fixes T2, T6, T7, T9, T10 |
| Planner (agent) | `02-calendar.js`, `04-calendar-grid.js`, `05-post-actions.js`, `08-review.js`, `09-post-detail.js` -> `30-planner.js`, `31-post-drawer.js`, `css/planner.css` | Planner + drawer + recovery panels |
| Create (agent) | `07-quick-compose.js`, `12-composer.js`, `06-image-prompts.js` -> `40-create.js`, `css/create.css` | Create sheet |
| Home + Settings (agent) | `03-home.js`, `14-ops.js`, `15-settings.js`, `16-profiles.js` -> `50-home.js`, `60-settings.js`, `css/home.css`, `css/settings.css` | Home, Settings tabs, Labs index page |
| Voices (agent) | `src/voice.js`, `src/draft.js` (voice lines only), `test/voice.test.js`, `../brands/<slug>/voice.md`, `scripts/apply-brand-voices.js` | per-brand voice docs + drafting reads them |

## API contract (backend, consumed by Planner/Home)

- `PATCH /api/posts/:id` transitions add: `failed -> draft | canceled`, `failed_verify -> draft |
  canceled`. Moving to draft may clear `publish_at`.
- `POST /api/posts/:id/recheck` (for `failed_verify`, or `submitted` with a submission id): one
  Blotato status poll. Published -> `published` (+ `public_url`); failed -> `failed` (+ message);
  still in progress -> back to `submitted` with verify counters reset. Returns
  `{ post, blotato_state }`. No submission id -> 409 `{ error: 'no_submission_id' }`.
- `GET /api/posts` rows gain `last_remote_state` (Blotato's last reported status, nullable) and
  `missed_window` (boolean, derived).
- `publish_at` is always returned as UTC ISO with milliseconds and `Z`.
- Unchanged: `/mark-posted`, `/publish-now`, `/queue`, `/submit`, `approve-batch`.

Backend trust fixes in the same pass:
- **T2** verify reads `publicUrl` (and `public_url`/`url`); polls with backoff for up to 24h from
  the first verify attempt (migration: `verify_started_at`, `last_remote_state`); gives up with a
  real `error_message`.
- **T6** normalize `publish_at` to UTC ISO on every write path; migration normalizes existing rows;
  compare as dates, never strings (worker windows, queue slot taken-check).
- **T7** missed-window flag only after a 15-minute grace; approving a post due within 10 minutes
  hands it off immediately (worker enabled only); the flag never overwrites a real handoff error.
- **T9** origin guard rejects `Origin: null` and `Sec-Fetch-Site: cross-site|same-site` on
  state-changing requests.
- **T10** queue route and agent approve run the same approve gate (TikTok fields, UTM) as PATCH.
- Launcher scripts append to the log instead of truncating it.

## Acceptance

- `npm test` green; new tests for every backend item.
- Browser QA on the sandbox (port 4599, snapshot DB, dry-run, worker/sync off), 1440x900 and
  1280x800: every route renders with zero console errors; idea -> scheduled on LinkedIn + Facebook
  in <= 4 clicks after typing; reschedule by drag; failed / failed_verify / needs_check posts each
  resolvable from the drawer; no "Loading…" swap after any action; Esc never loses edits silently;
  no native dialogs left (`grep -n "confirm(\|alert(\|prompt(" public/js` returns only
  `confirmDialog`).
- CHANGELOG, BUILD_STATUS, SPEC updated; this doc marked shipped.
