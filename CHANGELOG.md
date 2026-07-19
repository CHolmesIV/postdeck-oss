# PostDeck Changelog

Rolling changelog. Newest first. See `SPEC.md` for full design and `BUILD_STATUS.md` for
current state / what's pending.

## 2026-07-19 - B19 flow wave: preview, review mode, calendar popover/agenda, icons, shortcuts

Eight features from CB's hands-on testing session + Blotato/Sprout inspiration. Spec:
`docs/B19_FLOW_WAVE_SPEC.md`. Suite 257 -> 268.

- **Network post preview (F1)**: feed-card mockup per platform (avatar, brand, platform
  icon) with a visible "see more" fold line - LinkedIn ~210 chars, FB ~477, IG ~125,
  Twitter hard-280 (overflow in red) - plus a live "Fold in N chars" counter while typing.
  In Quick Compose (Preview toggle), composer variant tabs, and the post modal. Hook-first
  enforcement: you see what survives above the fold before approving.
- **Review mode (F2)**: `#/review` - drafts one at a time (preview + editable copy +
  schedule/queue), Approve & next / Skip / Trash / Open in composer, keyboard-driven
  (A/S/arrows), progress + session summary. New `DELETE /api/posts/:id` (draft/canceled
  only). "Review drafts (N)" entry on Home.
- **Calendar popover (F7a, Blotato-inspired)**: chip click opens a compact anchored
  popover - time, 3-line copy, Reschedule inline / Move to drafts / Delete-or-Cancel /
  See more (full modal). Status-gated actions; `approved/scheduled_local -> draft`
  transition added.
- **Platform icons (F7b)**: hand-rolled SVG icon set (linkedin/facebook/instagram/x/
  tiktok/reddit/youtube/blog) across chips, strips, tabs, modals. Calendar/agenda chips
  are icon-only (platform name moved to tooltip - CB: "if you have the icon, you don't
  need the name").
- **Upcoming agenda view (F8)**: third calendar view - Unscheduled drafts group + posts
  grouped by Today/Tomorrow/day for 14 days; rows open the popover; filters respected.
- **Ideas -> calendar (F3)**: drag an idea card onto a day (or "Use in post") -> Quick
  Compose prefilled; on save the idea flips to done.
- **Duplicate / Copy to brand (F4)**: from popover + modal; `POST /api/posts/:id/duplicate`
  (tags copied, campaign dropped cross-brand, account auto-resolved); cross-brand copies
  auto re-voice through the target brand's tone via the AI path when available.
- **Shortcuts + Cmd+K (F5)**: C compose, R review, 1-4 views, ? cheat sheet; Cmd+K command
  palette (fuzzy nav/actions + post search by copy). "? shortcuts" in the nav rail.
- **Brand setup card (F6)**: per-brand Home checklist (account, queue slots, link
  tracking, profile currency, voice) with click-to-jump; 100% brands collapse to a ✓.
- Fixes along the way: `[hidden]` vs author-CSS display bug on new components; broad
  `pkill` in an agent cleanup took down the live app once (restarted; agents now kill by
  exact PID only).

## 2026-07-19 - Composer UX wave (CB testing feedback): Quick Compose + metrics import

- **Quick Compose modal**: the + button (and Home quick actions) now open a compact
  compose dialog instead of the full page - brand chips, account toggles, one big copy
  box with Draft-with-AI + tone directly above it, char counter, media row (library pick +
  Request image), schedule row (publish-at + Add to queue + best-time chips), Save draft /
  Save & approve / Open full composer (state carries over). CB: the old flow "doesn't seem
  like you're about to make a post for social media" - this is the fix.
- **Full composer**: Draft with AI moved up (AI-first workflow); EVERY section now
  independently collapsible (root cause: two sections never wired to makeCollapsible, two
  jammed in one wrapper) + drag-to-reorder via ⠿ handles, order persisted; autosizing
  textareas everywhere AI output lands.
- **Edit prompts**: quick-edit button next to Request image (both composers) opening the
  same image-prompt settings Settings edits.
- **Image request clarity**: 'requested' now shows "Waiting on Codex - run the image
  handoff" + pointer to docs/CODEX_IMAGE_HANDOFF.md (requests are fulfilled by Codex
  externally by design; they are NOT stuck).
- **Metrics quick-entry**: inline impressions/comments/shares inputs + ✓ right in the
  metrics-due rows (Enter saves, row clears).
- **Analytics import**: `src/metrics-import.js` + preview/apply endpoints + Analytics
  "Import analytics" modal - upload a LinkedIn/Meta CSV export, rows matched to posts by
  date+platform (exact/adjacent/ambiguous with candidate picker), preview then apply.
  XLSX intentionally unsupported (export CSV). Extra export fields preserved in notes JSON.
- Suite 210 -> 257 across this wave (metrics-import 10 + queue/tags/besttime/utm from
  B16-B18 earlier).

## 2026-07-18 - D2 design consistency pass (Seeds-informed) shipped

- Adopted Sprout Social's design-system discipline (their public "Seeds" system) while
  keeping PostDeck's ink/gold identity. Spec: `docs/D2_CONSISTENCY_PASS_SPEC.md`; full
  view-by-view audit that drove the work: `docs/D2_AUDIT.md`.
- **Component system**: one button system (sm 28px / md 36px / lg 44px x primary /
  secondary / ghost / destructive) with hover/active/focus-visible/disabled/pending states -
  collapsed 8 ad-hoc button heights onto 3; defined the dead `.btn-secondary` class; inputs/
  selects matched to button tiers; real toggle switches for all on/off settings; global
  focus ring; 24px minimum touch targets.
- **Shared primitives**: `pageHeader` (title + fixed action order, filters always
  rightmost), `formSection` (single-column labeled groups), `toast` (transient feedback),
  `inlineBanner` (persistent conditions), `emptyState` (message + one CTA) - swept across
  all views.
- **Composer**: reordered to Sprout's compose flow (distribution -> content -> media ->
  metadata -> scheduling -> AI tools in one collapsible); browser alert()s replaced with
  toasts; platform-tab selected style no longer collides with primary CTA gold.
- **Settings**: reorganized into three zones with anchor nav - Workspace / Brands
  (selector-driven: accounts, tones, branding, queues, link tracking) / Integrations & Ops.
- **Sweep fixes**: calendar toolbar to canonical order (nav left, filters rightmost); empty
  states everywhere incl. each kanban column; Ops "posts by status" chart x-label collision
  fixed (rotate + truncate + tooltip); Research/Inspiration duplicate brand pickers removed;
  Library title matches nav; analytics lists right-align numbers + end-of-list line.
- Suite 247/247 throughout; every view browser-walked after the sweep.

## 2026-07-18 - B17 + B18 shipped: tags/campaigns, gap-finding, best-time, redraft, UTM

- **Tags & campaigns (B17a)**: migration v9 (`tags` + `post_tags`), `src/tags.js`, CRUD
  routes + `PUT /api/posts/:id/tags` (max one campaign per post), tags included in all
  post payloads (batched, no N+1), analytics rollups accept `?tag_id=`. Composer gains a
  Tags & campaign card (chip pickers + create-inline); calendar chips get campaign-colored
  borders + a Tag filter; post modal shows tag chips; Analytics gains a campaign selector
  with scoped "Campaign performance" view.
- **Calendar gap-finding (B17b)**: month cells show per-platform count dots and future
  empty days get a dashed "gap" treatment; week headers show day counts; a brand coverage
  strip above the grid flags brands with zero scheduled posts (click -> composer with that
  brand). Pure frontend over existing data.
- **Best-time nudge (B18a)**: `src/besttime.js` + `GET /api/best-times` - engagement
  bucketing by day/hour band from YOUR metrics when >=8 published posts exist, else
  research-backed static defaults per platform (new `best_times` in platform-specs).
  Composer schedule section shows "Best window" + "last post N days ago" with
  click-to-apply chips; queue editor shows the window for the selected platform.
- **Redraft the winner (B18b)**: Analytics top-10 rows gain a Redraft button - opens the
  composer on that brand, stages the original as grounding + example, auto-runs Draft with
  AI framed as "fresh take, same idea, new hook". House content standards apply.
- **UTM auto-append (B18c)**: `src/utm.js` - per-brand Link tracking toggle + template in
  Settings (default `utm_source={platform}&utm_medium=social&utm_campaign={campaign}`),
  applied once at the approve gate (never drafts), idempotent, skips links that already
  carry utm_, `{campaign}` resolves to the post's campaign tag else brand slug. Strong
  review caught + fixed: the approve hook wasn't passing the post's campaign tag.
- Suite 219 -> 247 (tags 6, besttime 11, utm 16 incl. a trailing-`?` URL parsing bug found
  and fixed during testing). All features browser-verified; smoke-test data cleaned from
  the live DB.

## 2026-07-18 - B16 shipped: queue slots + left navigation rail

- **Queue slots (B16a)**: recurring weekly brand+platform posting slots. Migration v8
  (`queue_slots`), `src/queue.js` (slot CRUD + `nextOpenSlot` - walks active slots up to 2
  weeks out, skipping taken datetimes, quiet hours, and past same-day slots),
  `GET/POST/PATCH/DELETE /api/queue-slots`, and `POST /api/posts/:id/queue` (computes the
  next open slot, sets publish_at, transitions draft/approved -> scheduled_local; 422
  `no_open_slot` when no active slots). Settings gains a per-brand Queues editor (slot list
  with active toggle/delete, add-slot row, "Daily 12:00 LinkedIn + Facebook" seed button).
  Composer action bar gains **"Add to queue"** - saves the draft(s), queues each platform,
  shows "queued for <date>" per platform, links to Settings if no slots. 9 new tests
  (`test/queue.test.js`); suite 219/219.
- **Left navigation rail (B16b)**: the flat sidebar is now four collapsible groups - Plan
  (Home, Calendar, Ideas), Create (Composer, Library, Images), Grow (Analytics, Research,
  Inspiration), Setup (Profiles, Settings, Ops). Per-group collapse state persists
  (localStorage `pd_nav_*`); active-route highlight unchanged; below 900px the rail flattens
  to an icon-only strip with tooltips. Existing design tokens only, no new deps.
- Verified in-browser (desktop + narrow viewport, live queue round-trip). Smoke-test
  artifacts (2 empty posts + 14 seeded slots) removed from the live DB afterward.

## 2026-07-18 - B16-B18 competitive wave spec'd (Hootsuite/Sprout gap analysis)

- Ran a competitive analysis of Hootsuite + Sprout Social (2025-2026 feature sets) against
  the current PostDeck inventory. Result spec'd as three waves in
  `docs/B16_B18_COMPETITIVE_WAVE_SPEC.md`: **B16** queue slots (Sprout-style recurring
  time slots + "Add to queue") and a grouped left navigation rail; **B17** campaign/tag
  system + calendar gap-finding (per-day counts, empty-day treatment, brand coverage
  strip); **B18** best-time-to-post nudge in the composer, "Redraft the winner" from
  Analytics top posts, and per-brand UTM auto-append on approve. Also documents what was
  deliberately skipped (unified inbox, approval chains, enterprise listening, ads) and a
  parking lot (list view, streams-lite, queue re-flow, ICS export). Spec only - no code.

## 2026-07-16 - Calendar: click a post for a quick-view/edit modal

- Clicking a post chip (month or week view) now opens a **pop-out modal** instead of navigating
  to a full page. Shows platform, status, brand, publish time, and the copy. For still-editable
  posts (draft/approved/scheduled_local) the copy and publish time are editable with **Save
  changes** (PATCH); submitted/published posts show read-only. Also: Copy-to-clipboard, a link
  to the published post, and "Open full page" for the deep view. Close on X, click-outside, or
  Esc. Saving refreshes the calendar behind it. Verified in-browser incl. a real edit round-trip.

## 2026-07-16 - Calendar auto-refresh (fix stale-tab confusion)

- The SPA never live-updated, so a tab left open showed stale data (published posts
  missing, old statuses) and looked broken. Added a **manual refresh button (↻)** to the
  Calendar toolbar and **auto-refresh on tab focus / visibility** (guarded singleton so only
  the live calendar reloads - no listener leak). Returning to the app now re-fetches. Verified
  in-browser: focus fires /api/posts, published PrimeWright posts render on their day.

## 2026-07-15 - Persist PrimeWright design guidelines

- Added `docs/PRIMEWRIGHT_DESIGN_GUIDELINES.md` so PrimeWright UI/UX direction is stored in
  the repo instead of depending on chat history.
- Captures command-center posture, website hero standards, app/dashboard standards,
  explainable AI verdicts, compliance matrix expectations, color/contrast, typography,
  motion, accessibility, forms/errors, performance, and acceptance checklist.
- Linked the guidelines from `SPEC.md` and `BUILD_STATUS.md`.

## 2026-07-15 - PrimeWright social went LIVE (dry-run off) + scheduling gotchas

Operational, not code. Documenting the fixes/corrections made while getting PrimeWright's
first posts out (per CB: log the churn):
- **Env loading was misdiagnosed.** I wrongly reported the Blotato key "not in .env" - it is
  in `Social Media/config/.env`, loaded by `src/env.js` (imported first in server.js). Key +
  live posting were fine all along. Do NOT create `postdeck/.env` (it shadows config/.env).
- **listAccounts parse bug (my check, not shipped):** Blotato returns accounts under `items`,
  not `data`. Resolved the real account map: FB `<redacted-id>`, LinkedIn `<redacted-id>`,
  Twitter `<redacted-id>`, with per-brand page subaccounts.
- **PrimeWright accounts wired:** LinkedIn #8 -> acct `<redacted-id>` / page `<redacted-id>`;
  Facebook #9 -> acct `<redacted-id>` / page `<redacted-id>`; both manual=0 (worker-eligible).
- **Flipped `BLOTATO_DRY_RUN=0`** in config/.env -> posting is LIVE.
- **Scheduling window gotcha:** the worker only hands a post to Blotato within 48h of its
  publish_at. Posts scheduled >48h out show NOTHING in Blotato's upcoming until then - which
  looked like "nothing pushed through." Rescheduled PrimeWright's 12 from a week-out block to
  **daily starting now** (topic1 pushed live to LinkedIn+Facebook via submitNow, verified real
  Blotato submission IDs; topics 2-6 at noon ET Jul 16-20, auto-handoff).
- SPA does not live-refresh; a tab open before posts were created needs a reload to show them.

## 2026-07-15 - Constrain the Codex draft path (single-turn, read-only)

- Codex drafting (`codex exec`) is agentic by default. Verified against codex-cli
  0.144.2: an unconstrained call reads stdin and can loop. Now passes
  `-s read-only --skip-git-repo-check --ephemeral` for a single ~4s completion that
  never writes files, and relies on runCli closing stdin (else codex blocks on
  "Reading additional input from stdin..."). Verified a real Codex draft end-to-end.
  Parallels the Claude `--tools ""` fix. +1 test. Suite 210.

## 2026-07-15 - Editable image prompts + UI design pass

- Added an editable **Image prompt system** in Settings. The app now stores reusable system,
  negative, brand, and layout prompt text under `/api/settings`, so CB can tune how Codex
  image briefs are written without editing code.
- Every image request path now carries those prompt settings into the handoff spec:
  Composer, chat agent `create_image_request`, and blog redistribution.
- Image handoff specs now include `brief.prompt_settings`, alongside exact dimensions,
  format, safe-zone notes, brand logo, colors, copy context, and variant instructions.
- Composer now links directly to the prompt editor from "Image request options".
- Design pass: tightened the app shell, cards, typography, contrast, mobile layout,
  settings prompt editor, and image-request affordances so PostDeck feels more like a
  serious local command center.
- Tests: `209/209` passing.

## 2026-07-15 - Codex CLI discovery fix for desktop installs

- PostDeck's Codex provider could falsely report **"codex CLI not installed"** even when Codex
  was present on the Mac, because the app process only tried `codex` on PATH. On this machine
  the real binary lives inside the ChatGPT app bundle at
  `/Applications/ChatGPT.app/Contents/Resources/codex`.
- Fixed `src/ai.js` to auto-discover known bundled Codex locations (while still honoring
  `POSTDECK_CODEX_BIN` first), and updated `scripts/open-postdeck.command` to put the ChatGPT
  app resources on PATH for Finder/Desktop launches.
- Result: the in-app Codex status/drafting flow no longer depends on a separately-installed
  shell alias just to find the binary.
- Follow-up UI fix: the Composer's Draft-with-AI panel now shows a **Codex status row + Log in
  to Codex button + Recheck**, instead of only showing the Claude status controls.
- Follow-up auth fix: Codex status now uses the real `codex login status` command, so the pill
  flips to **logged in** after a successful in-app sign-in instead of staying stuck at
  "installed".

## 2026-07-15 - Chat agent: apply the same agentic-mode fix (it could schedule but was broken)

The in-app chat agent (create drafts, set publish_at across days, request images,
etc.) had its OWN copy of the `claude -p` shell that never got the drafting fix, so
it hit the same `error_max_budget_usd` failure. Applied the same fixes to `src/agent.js`:
`--tools ""` (single-shot, no agentic loop), close stdin (no 3s hang), prefer the JSON
envelope on non-zero exit, detect `is_error` / not-logged-in as clean 503s, and a
tolerant `parseAgentOutput` (fences/prose -> first balanced `{...}`). Budget headroom
0.10. Verified end-to-end: "draft 3 LinkedIn posts and schedule one per day from Jul 17
9am" created 3 dated drafts correctly. +3 tests. Suite 203.

## 2026-07-15 - Draft with AI now actually works (agentic-mode was the killer)

Even after logging in, drafting failed. Root causes, all fixed:
- **`claude -p` runs the full AGENTIC Claude Code** (reads files, web-searches, loops
  multiple turns). The prompt referenced a voice-doc path, so the model burned turns trying
  to read it and blew past `--max-budget-usd` (`error_max_budget_usd`). Fix: pass `--tools ""`
  so drafting is a single, cheap, in-budget completion (1 turn, ~$0.02).
- **Error envelopes were parsed as drafts.** `parseClaudeEnvelope` now detects `is_error`
  (incl. `error_max_budget_usd`) and throws a clean, actionable message.
- **Prose instead of JSON.** Cheap models sometimes wrapped JSON in fences/prose or said
  "I need to read that file." Hardened the prompt (no tools/files, JSON-only), made the
  parser tolerant (extracts the first balanced `{...}`), and added a parse-failure retry.
- **3s stdin hang** on every call: `execFile` has no `stdio` option, so the earlier fix was
  a no-op. Now the child's stdin is `end()`-ed. Also added CLI-level retry for transient
  API hiccups. Verified end-to-end in the browser (real drafts populate reliably).
- Tests: +4 (`--tools` args, `is_error` -> 503, tolerant `parseInnerJson`). Suite 200.

## 2026-07-15 - Composer redesign + two bug fixes (accounts, AI login)

- **UX: collapsible, reordered sections.** The Composer was one long always-open
  scroll. Each section is now a collapsible card (chevron header, open/closed state
  persisted per-section in localStorage). Reordered so the primary output is reachable
  without scrolling: Accounts -> Image -> Image request -> Draft with AI -> Platform
  variants, with Content type + Schedule collapsed by default. Save draft / Request image
  now live in a **sticky action bar** at the bottom.
- **Bug: duplicate/malformed accounts.** Di-Hy showed two LinkedIns and two Facebooks -
  duplicate rows whose `blotato_account_id` was actually a pageId (from an earlier
  seed/parallel write). Added `DELETE /api/accounts/:id` and a per-row **remove (x)**
  button, and cleaned the two junk rows.
- **Bug: Draft with AI failed ("could not run claude CLI").** Root cause: the `claude`
  CLI wasn't logged in. Added an **AI status pill** + one-click **"Log in to Claude"**
  button (opens `claude auth login --claudeai` in Terminal - subscription, no API key) +
  **Recheck**, backed by `GET /api/ai/status` (`claude auth status`) and
  `POST /api/ai/login`. Also fixed a 3-second per-draft stdin hang (stdin now closed so
  `claude -p` doesn't wait on input it never gets).
- Tests: +6 (`test/ai-auth.test.js`, DELETE cases). Suite now 196.

## 2026-07-15 - Composer: add a platform to any brand (fix account dead-end)

- Brands seeded without a Blotato connection (PrimeWright, Lunula, IVision) dead-ended in the
  Composer: nothing to distribute to, so drafting was blocked. Added `POST /api/accounts` and a
  "+ add platform" control in the Composer's Distribute-to box. New accounts default to
  **manual** (assisted copy & paste, no live connection); a live Blotato connection can be
  attached later. Guards: 400 on missing brand/platform, 404 on unknown brand, 409 on a dupe
  platform for the same brand.
- Fixed account checkboxes not reflecting the persisted selection after a re-render (they
  looked unchecked though the account was selected) - the "won't let me select it sometimes"
  bug. Checkbox now mirrors `selectedAccounts`.
- Tests: +5 (`test/server.accounts-create.test.js`). Suite now 190.

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
  - **Di-Hy X** submits successfully via connected account `<redacted-id>`.
  - **Di-Hy LinkedIn** submits successfully when mapped as connected LinkedIn account
    `<redacted-id>` plus company `pageId` `<redacted-id>`.
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
