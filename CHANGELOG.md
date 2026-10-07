# PostDeck Changelog

Rolling changelog. Newest first. See `SPEC.md` for full design and `BUILD_STATUS.md` for
current state / what's pending.

## 2026-10-07 - Website analytics: traffic, leads and search next to the work

Spec: `docs/WEB_ANALYTICS_SPEC.md` (build contract at the end). Suite **479 passing** (was 419).
Migration **v14** (`web_*` tables, daily aggregates only).

- **Analytics is now two tabs: Websites (new, default) and Social (unchanged).** Websites shows a
  plain-language read, one row per site (visitors, leads, lead rate, search clicks, change vs
  the previous period, 28-day sparkline, visitors right now), a day-by-day chart with PostDeck's
  own blog releases and social posts marked on it, where visitors came from (search, social by
  platform, AI assistants, referral, direct, email), pages (rising, falling, refresh candidate,
  no leads), Google searches with a striking-distance list and a **Write a post** button that
  opens the Blog editor with the query as the keyword, visits from your posts, and site health
  (404s with ready redirect lines, crawler hits, form outcomes, GA4 vs relay lead check).
- **Works today from server logs** (`src/web-logs.js` + `scripts/web/vps_log_summary.py`, piped
  over read-only SSH to the VPS; nothing is written there). Humans only: bots, scanners, assets
  and link-building referral spam are dropped. Leads = form relay deliveries.
- **Google Analytics 4 + Search Console when connected** (`src/google.js`, `src/web-google.js`):
  read-only service account, JWT signed with node:crypto, no new dependencies. The key is pasted
  or chosen in Settings > Websites, stored 0600 in `~/Library/Application Support/PostDeck/`,
  never returned by the API, never in the repo. Properties are found automatically.
- **CB's own visits are filtered out** (his call): server logs skip the Mac's own IP and any
  address that opened a `?pd_internal=on` link; Settings lists a "Mark this browser as you" link
  per site. Stopping GA4/Clarity counting in that browser needs a small script on the sites
  (spec "Own traffic", not yet on the sites).
- **Honest comparisons:** a "before" number, change arrow or rising/falling tag appears only when
  PostDeck has stored the whole previous period. Charts start where history starts.
- **Elsewhere:** Home gets a weekly line and alerts (tracking looks broken, traffic down 40%+, a
  sync failing for a day, new leads, form submissions the relay could not email). Blog view shows
  28-day views, search clicks and position per published post with a sort. The post drawer says
  "Sent N visits and M leads" for tagged posts. Planner has a Traffic toggle.
- **UTM tagging** now adds `utm_content=pd-<post id>` so each visit maps to the post that sent it.
- **Sync** runs inside the worker while PostDeck is open: logs hourly, GA4 every 6 h, Search
  Console every 12 h; Refresh forces it. `POSTDECK_WEB_SYNC=0` turns it off (tests, sandboxes).
- Security: every SSH argument is checked against strict patterns before it reaches the remote
  shell (test added); the key file pattern is in `.gitignore`.

## 2026-10-07 - Brand voices live with each website; CB's voice rebuilt

Suite **419 passing** (was 418).

- **Brand voice docs moved to each business's website branding folder** (CB's call), and every
  brand now points at them: `Website Projects/CHolmesIV/brand/brand-voice.md`,
  `Website Projects/Di-Hy/brand-voice.md`, `Website Projects/Lunula Supply/brand-voice.md`,
  `Website Projects/IVision Build Co/brand/brand-voice.md`,
  `PrimeWright/brand-package/primewright-2026/brand-voice.md` (stored relative to the Social Media
  folder). `scripts/apply-brand-voices.js` carries the new map and was applied to the live DB
  after a backup (`postdeck-pre-voices-2026-10-07.db`).
- **Settings > Brands > Voice can save to those files**: `writeBrandVoiceDoc` now accepts `.md`
  files anywhere under the Projects folder (the parent of the Social Media folder;
  `POSTDECK_PROJECTS_ROOT` overrides), not just inside Social Media. Test added.
- **CB's voice card rebuilt** (`Social Media/docs/charles-voice-reference.md`, 3.4k chars so the
  whole card fits the 4,000-character prompt cap): influences Hormozi, Gary Vee, Robbins, Cardone,
  grounded in his own writing and profile. The global voice seeds from it on next launch (the live
  global voice is still empty and unsaved). Verified on a DB copy: every brand's composed voice
  has the card plus its brand doc, no placeholder text, no long dashes.

## 2026-10-07 - Blog add-on: PostDeck runs the HTML blog programs

Spec: `docs/BLOG_ADDON_SPEC.md`. Suite **418 passing** (was 388). Migration **v13**
(`blog_releases`).

- **New Blog view** (`#/blog`, nav item after Planner). PostDeck finds every site under
  `Website Projects/` that has `blog/tools/release.py` (today CHolmesIV, Di-Hy, Lunula Supply) and
  drives each site's own scripts. It never edits those scripts and never passes
  `--allow-unreviewed`.
- **Write, paste or draft with AI.** New blog post opens an editor whose fields come from that
  site's own format (Lunula's `dek`, Di-Hy's `seo_title`, CHolmesIV's `headline`, the allowed
  clusters). Body is a big markdown box. Draft with AI uses the site's brand voice plus two of its
  recent posts as style examples. Edits autosave; a file changed on disk by another session is
  detected (no silent overwrite). Long dashes are normalized on save.
- **Preview in the real site design** with the site's QA checks, built from a temporary copy so
  the real `dist/` and content are untouched. Preview needs `build_blog.py` (CHolmesIV today; Di-Hy
  and Lunula use other builder names, so their preview shows a build note instead).
- **Approve, schedule a date and time, or Release now.** Approved posts release at their time
  while PostDeck is open (checked every worker cycle); Release now runs it immediately. Release is
  by day (the sites' scripts publish everything due by today). If any due post still needs review,
  the site's script would refuse the whole run, so PostDeck shows "Release blocked" with Approve /
  Move date instead of running. One release per site at a time; every run logged with its output.
- **Dry run is honored:** in dry-run mode the release runs the build and QA and uploads nothing.
  Deploy flags are read from what each script declares (`--deploy` for CHolmesIV and Di-Hy,
  `--go` for Lunula; `--date` vs `--today`), and a script with no deploy option is never guessed.
- **Planner and Home:** blog posts on their dates with a Blog filter chip; Home shows posts needing
  review, blocked or failed releases, and upcoming releases. **Settings > Blogs:** brand voice per
  site, default release time, Pause blog releases, recent release logs.
- Tested on copies of the real sites in dry-run mode: CHolmesIV's "How to Buy a Small Business"
  previewed in the real template (0 problems), approved, and released as a dry run (build + QA
  passed, nothing uploaded). Real site files untouched.
- **Known gaps:** Planner List view doesn't show blog posts (Week and Month do); Lunula's live
  links point at `/blog/` but its posts live under `/insights/`; preview only for sites with
  `build_blog.py`; release is per day, not per post time.

## 2026-10-07 - Paste your own brand voice; no long dashes anywhere in voice text

Suite **388 passing** (was 382).

- **Settings > Brands > Voice is now a paste box.** Paste or write a brand's voice and Save: it is
  written to that brand's voice doc (`Social Media/brands/<slug>/voice.md`, created if the brand
  had none) and the next draft uses it. Shows the character count and warns past the 4,000
  characters drafting reads. CHolmesIV's voice is your personal card, so that brand links to
  Settings > AI instead (one source, every brand stays in sync). New routes:
  `GET/PUT /api/brands/:id/voice`; writes are confined to `.md` files inside the Social Media
  folder. The old free-text "voice doc path" field is gone from the UI (the path shows as a note).
- **Long dashes are stripped from every voice source.** `normalizeDashes()` (`src/voice.js`)
  runs when the global voice, a brand voice or a tone tweak is saved, when the global voice is
  seeded, and on the assembled draft prompt, so pasted text can't teach the model to use them. A
  rule that names the character ("No em dashes (—)") reads as "(the long dash)". The output scrub
  already converted em and en dashes in AI drafts. Global voice shows the cleaned text after Save.
- **Voice card cleaned.** `Social Media/docs/charles-voice-reference.md`: title, a heading and the
  sample line "doesn't build trust — it just pushes the sale" (now two sentences). The models
  imitate samples, so that one mattered. Only the line stating the rule still shows the character.
- Tone previews moved behind "See the full voice the AI gets" (they printed the whole composed
  voice under each tone). The Analytics campaign banner lost its em dash.
- `test/brand-voice-editor.test.js` (6 tests): create/overwrite/read, global-voice refusal, path
  confinement, dash normalization on every path into a prompt.

## 2026-10-07 - D3 redesign: Planner, post drawer, New post sheet, Home, Settings

Spec: `docs/DESIGN_WAVE_SPEC.md`. Frontend 9.2k -> 7.6k lines. Suite **382 passing**.

- **Navigation** is Home, Planner, Analytics, Settings, plus a collapsed Labs group. One corner
  button (New post). Shortcuts: `C` new post, `D` drafts, `1-4` the four views, `Cmd+K` palette.
  Old routes redirect (`#/calendar`, `#/review` -> Planner; `#/composer` -> New post; `#/ops`,
  `#/profiles` -> Settings).
- **Planner** (`#/planner`): week (default) / month / list, filter chips with counts (All,
  Drafts, Scheduled, Posted, Needs attention), brand filter, drafts tray, "+ New post" on an empty
  day (prefills brand and date), drag to reschedule with Undo, a needs-attention strip.
- **Post drawer**: the one editor for existing posts. Copy autosaves; one delivery choice drives
  one button; recovery panels for failed, not confirmed, check-before-resending and missed-time
  posts. `#/post/:id` opens it over the Planner.
- **New post sheet**: brand first, its accounts preselected, idea box + Draft with AI, one post
  box with optional per-network versions (AI fills each network), live preview, Draft / Schedule
  (best-time chips) / Next open slot / Post now. Saves are idempotent (one post id per account
  for the life of the sheet), buttons lock while saving, unsaved work is kept on close or
  navigation and offered back ("Start over" to drop it). Idea to scheduled on two networks: three
  clicks after typing.
- **Home**: Needs you (plain reasons, Review button), drafts waiting, Coming up (7 days),
  Recently posted. Down to three requests from ~35.
- **Settings**: Brands (completeness checklist, voice, accounts, queue slots, profiles, branding,
  link tracking), AI (global voice and rules, providers, assistant authority, image prompts),
  System (live/dry-run, worker, account health, backups, usage). Fixes the section links that
  sent you to Home.
- **Live feel**: saves refresh in place (no "Loading..." swap, scroll kept); live views refresh
  on focus and every minute unless you're typing; a route change closes drawers and modals;
  Undo toasts for reversible actions; in-app dialogs replace every browser confirm/alert/prompt;
  unhandled API failures show a toast.
- **Look**: flat dark + gold tokens (`public/css/foundation.css`), no gradients, glows,
  side-stripes or tracked uppercase headings; one system font; plain-language statuses; Blotato
  errors translated into what happened and what to do.
- **Fixes found in QA**: the New post sheet now saves unsaved work when you navigate away
  (snapshot ran after the sheet was already marked closed); "Images null" / "Advanced null"
  labels; Recently posted text clipped at the start; seed placeholder tone text shown as real
  rules in Settings.
- **Known gaps**: no bulk "Schedule selected" in List view; metrics entry moved off the post page
  (use Analytics > Metrics due); Cancel post confirms (no Undo, canceled is final).

## 2026-10-07 - Trust fixes T2/T6/T7/T9/T10 + per-brand voices

Suite **382 passing**. Migration **v12** (runs on next launch).

- **Failed posts are no longer dead ends (T2).** `failed` and `failed_verify` can move to draft or
  canceled. New `POST /api/posts/:id/recheck` polls Blotato once and resolves the post (published
  with URL, failed with message, or back into verification). Verification reads Blotato's
  `publicUrl` (every Blotato-published post had a null URL before), keeps polling for 24h from the
  first poll instead of quitting after ~25 minutes, records `last_remote_state`, and gives up with
  a message that says the post may be live. Posts 19, 21 and 42 were abandoned by the old rule
  while Blotato still said "in-progress".
- **One time format (T6).** `publish_at` is normalized to UTC ISO on every write (`src/time.js`);
  v12 rewrites existing rows; the worker and queue compare epoch milliseconds instead of strings,
  which also fixes queue slots double-booking across formats.
- **Short-notice posts go out (T7).** The missed-window flag waits 15 minutes past the time and
  never overwrites a real error. Approving a post due within 10 minutes hands it to Blotato right
  away instead of waiting for the 5-minute sweep.
- **Tighter request guard (T9).** Writes with `Origin: null` or `Sec-Fetch-Site: cross-site /
  same-site` are refused.
- **One approve gate (T10).** Queue, approve-batch, publish-now and the chat agent's approve run the
  same TikTok-field and UTM checks as a normal approve (`src/approve.js`).
- **Launcher log** appends instead of being wiped each start.
- **Brand voices.** Drafting now combines CB's global voice, the brand's voice doc
  (`brands.voice_doc_path`, absolute or relative to the Social Media folder) and the tone's rules.
  Seed placeholder tone rules are ignored. New voice docs: `Social Media/brands/{dihy,primewright,
  lunula,ivision}/voice.md` (CHolmesIV uses `docs/charles-voice-reference.md`).
  `scripts/apply-brand-voices.js` points each brand at its doc (refuses without an explicit
  `POSTDECK_DB_PATH`; `--apply` to write). Open questions for CB are listed at the top of the
  ivision doc and in the audit doc.

## 2026-10-07 - Double-post guard + needs_check recovery (audit T1)

Suite **341 passing** (was 333).

- **A network blip could publish the same post up to 5 times.** `request()` retried timeouts,
  dropped connections and 5xx on every method, including `POST /v2/posts`. If Blotato had already
  accepted the first one, every retry was another live post (Blotato can't delete). Post creation
  is now `idempotent: false`: one attempt, and an uninterpretable failure (timeout, dropped
  connection, 5xx) throws an `ambiguous` error instead of retrying. 429 still retries (rejected
  before it ran); media upload and GETs keep their retries (a duplicate upload is invisible).
- **New status `needs_check`.** The worker parks an ambiguous create there, and also any 2xx that
  returns no submission id (previously marked `submitted` with a null id, so verify polled
  `/v2/posts/null`). The sweep only picks up `scheduled_local`, so `needs_check` is never resent.
  Allowed exits: `draft` (time cleared) or `canceled`, or `mark-posted` with the live URL. A
  straight approve is refused, so there's no one-click resend.
- **UI:** `Check before resending` rows lead Home's Needs attention; the post page and calendar
  drawer show a panel explaining the post may be live, with `Mark as posted` (inline URL field)
  and `It didn't post - move to draft`. Home's "This week - N scheduled" now counts only posts
  actually going out (it was counting drafts, failures and cancellations). State export counts
  `needs_check` with failures.
- `test/no-double-post.test.js` (8 tests) against a local mock Blotato: dropped connection, 502,
  no-id, 429-then-ok, flaky media, and the recovery routes. Four of them fail on the previous
  code (the dropped-connection case sent the post 5 times).

## 2026-10-07 - Audit + voice fix + scheduling time bugs

New audit and plan: `docs/AUDIT_2026-10-07.md`. Suite **333 passing** (was 328).

- **AI drafts had no voice.** `seedGlobalVoiceIfMissing` looked for
  `charles-voice-reference.md` in `postdeck/docs/`; it lives in `Social Media/docs/`. It wrote
  `''` and never retried, so every draft ran with an empty global voice. Now reads the project
  doc (`POSTDECK_VOICE_REF` overrides), never stores `''` on a missing file, and re-seeds an empty
  voice unless the operator saved it in Settings (`global_voice_user_set`). The live DB heals on
  next launch.
- **Saving a scheduled post moved it 4-5 hours later.** The detail page (and the Composer queue
  result) put the UTC string into a local `datetime-local` input, then saved it back as local.
  Now uses `isoToLocalInput()`.
- **Calendar filed evening posts under the next day.** Month/week/agenda grouping, dot counts and
  brand coverage keyed days by the UTC date string. New `postDayKey()` keys by local day.
- **Rescheduling from the calendar drawer always failed (409).** The drawer's Schedule sends
  `status: 'approved'`; scheduled posts are stored as `scheduled_local`, and that "transition"
  was refused. `PATCH /api/posts/:id` now treats it as the same state (re-derived from
  `publish_at`, approve gate not re-run). Also fixes Review "Add to queue" then "Approve & next".
- Browser QA on a sandbox copy (port 4599, dry-run, worker/sync off): evening post lands on the
  right day, drawer reschedule saves, detail-page save leaves the time unchanged.

## 2026-09-02 - Full audit: `docs/AUDIT_2026-09-02.md`

Ran a full strong-model audit (security, agent orchestrator, speed, UI/UX, data/ops, docs/repo)
against the running instance and the `working` vs `main` git state. It found the two issues
fixed in B23 below plus the docs/repo drift cleaned up in this pass. Full findings and the
build plan live in the audit doc; the provider-layer redesign it called for has its own spec,
`docs/PROVIDER_LAYER_SPEC.md`.

## 2026-09-02 - B23: audit wave (security, deps, provider layer)

- **Origin/Host request guard.** State-changing routes now reject any request whose `Origin`
  is present and not the app's own, or whose `Host` isn't `127.0.0.1`/`localhost` - closes the
  CSRF / DNS-rebinding gap the audit flagged (S1).
- **In-process submit claim.** `submitNow()` and the 5-minute handoff sweep now share a claim
  around `handoffOne`, plus a status re-read right before the network call, so a "Submit now"
  click racing the sweep can't double-post the same item to Blotato (S2).
- **Dependency upgrade, 0 vulnerabilities.** `fastify` 4 -> 5, `@fastify/static` 6 -> 10,
  `@fastify/multipart` 8 -> 10. `npm audit` is clean. Full suite green: 328 (see `npm test`).
- **Migration v11**: index on `metrics(post_id)` - every analytics rollup joins on it.
- **Daily SQLite backup** of `postdeck.db` to
  `~/Library/Application Support/PostDeck/backups/`, keeping the last 14. New
  `POSTDECK_BACKUP_DIR` (override) and `POSTDECK_BACKUP_KEEP` (default 14) env vars.
- **Provider layer**, per `docs/PROVIDER_LAYER_SPEC.md`: new `src/providers/` registry.
  Grok added as an HTTP-only provider (`XAI_API_KEY`). The chat agent, profile generation,
  inspiration, and vision paths now route through the registry instead of each keeping a
  private CLI-calling copy, so the Settings AI-provider switch actually covers every AI call
  site. New `GET /api/ai/providers`, `POST /api/draft/compare` accepts any provider set,
  30 s server-side status cache (`?fresh=1` bypass), new `agent_provider` setting.
- **Frontend**: providers now render from `/api/ai/providers` instead of a hardcoded list,
  thumbnails load lazily, and `bootstrap()` fetches brands/accounts/platform-specs in
  parallel instead of serially.
- **`node src/seed.js` is now guarded.** It refuses to run against a database that already has
  brands unless `--force` is passed, because the seed is an upsert that overwrites brand names,
  `voice_doc_path`, tone `voice_rules` and the seeded PrimeWright profile fields. Added after
  the audit session ran it against the live DB by mistake (2026-09-02 18:44 UTC): accounts,
  posts, metrics, colors, logos, hard rules and settings were untouched; brand names /
  voice-doc paths / tone voice_rules / PrimeWright profile drafts were reset to seed values.
  If any of those had been hand-edited in Settings > Brands / Tones or Profiles, re-enter them.
- **Repo**: GitHub `main` was 53 commits behind `working`; `working` is pushed and `main`
  fast-forwarded to it.

## 2026-08-12 - Home attention items can be dismissed

- Added a close control to every Home `Needs attention` row and a `Dismiss all` action in the
  panel header.
- Dismissals persist in the browser across navigation, reloads, and app restarts.
- Dismissal keys include the exact underlying condition, so a new failed post, another draft,
  a changed handoff gap, or a changed metrics set appears again instead of being muted forever.
- Closing an item does not open its linked post or page.
- This ships P1 from `docs/FIX_WAVE_NOTIF_IMAGES_SPEC.md`. The P2 image-request review work remains
  separate and unbuilt.

## 2026-08-12 - B22: publishing workflow redesign

CB's real PrimeWright posting session exposed that the app had the necessary endpoints but made
the normal decision too hard to complete. The redesign consolidates the state-machine actions
into a calmer review-first workflow. Suite **317 passing** (was 315).

- Calendar and agenda posts open in a full-height right-side review drawer with the platform
  preview, editable copy, timing, and delivery choice visible together.
- One delivery control now drives one primary action: `Save draft`, `Schedule post`, `Add to
  queue`, or `Post now`. Approval is part of scheduling instead of a competing button.
- Added quick schedule presets for later today, tomorrow at 9 AM, and Friday at noon.
- Quick Compose uses the same delivery language, exposes only the matching final action, and uses
  account cards with connection state, selection checks, Select all, and Clear.
- Full Composer replaces the internal `Save & approve` wording with `Schedule post` and requires a
  date/time for that action. Saving without delivery remains an explicit draft.
- Added a link-placement indicator and `Move link higher` helper. PrimeWright's documented default
  is hook, link, then explanation.
- Renamed the ambiguous `Send to Blotato now` control to `Send schedule to Blotato early`, clarified
  that it does not publish immediately, and moved it under Advanced actions.
- Generalized `Mark as posted manually` to connected platforms so a post published directly in
  LinkedIn can be reconciled without calling Blotato or leaving a duplicate draft. The action
  requires the live URL, confirms the post already exists, and records a `manual_publish` event.
- Added an Analytics source notice: Blotato's web app now displays analytics, but no engagement
  endpoint appears in its documented public API. CSV import remains the reliable bridge.
- Browser QA ran against a temporary dry-run database with worker and sync disabled. Production
  PostDeck data and social accounts were untouched.

## 2026-08-10 - B21: draft variations, honest char counts, Post now

Three defects found by CB writing a real post in Quick Compose. Spec:
`docs/archive/B21_COMPOSER_FIXES_SPEC.md`. Suite **315 passing** (was 309).

- **"Draft with AI" no longer eats the idea it was given.** The idea and the draft shared one
  textarea, and the handler did `copyArea.value = draft`. So the first press destroyed the
  idea, and every press after that fed the previous *draft* back in as the prompt: a rewrite
  of a rewrite, drifting further each time, with no history and no undo. The seed now lives in
  its own "Your idea" field which `Draft with AI` always reads from. If the seed is empty and
  the operator typed straight into the big box (the old muscle memory), that text is **moved**
  into the seed rather than consumed.
- **Variant strip.** Every draft is appended, never substituted, and rendered as `v1 v2 v3…`
  chips under the copy box; clicking one swaps it in, and hand-edits stay attached to the
  version they were made on. Pressing the button again is now additive. Render-scoped only, no
  migration: an unsaved variant is not an asset.
- **Character counts stopped lying.** `mostRestrictiveLimit()` took `Math.min()` across every
  selected platform and showed that single number, so a normal 1,100-character LinkedIn post
  with X also selected reported as wildly over limit - that was X's 280, not LinkedIn's 3000.
  One blended figure cannot be honest when one box feeds several platforms, so the counter now
  renders **one chip per selected platform** (`Linkedin 1132/3000`, `Twitter 1132/280`), and
  only the platforms actually over turn red. Verified against CB's exact case. The full
  composer already scoped its count to the active tab and was left alone.
  Worth recording: the old counter only toggled a CSS class. **Nothing anywhere blocked save
  or approve on length.** It was misleading, never blocking.
- **`POST /api/posts/:id/publish-now`** - posting immediately used to mean inventing a
  `publish_at` you didn't want, approving, opening the post, then Send to Blotato now. Four
  steps for the simplest intent. This is one server-side action on purpose: the client must not
  sequence approve-then-submit and leave a post half-approved when the second call fails. Every
  refusal (`not_found` / `wrong_status` / `assisted_manual` / `tiktok_fields_missing`) happens
  **before anything is written**, so a rejected publish-now leaves the row exactly as found.
  UTM is applied only on the draft crossing, so a re-publish never double-tags. Dry-run is
  honored by the existing `submitNow`.
- **`Post now` button** in Quick Compose, styled `destructive` rather than `primary` because it
  is the one irreversible control in the modal and shouldn't look like a peer of Save draft. It
  confirms first, names the target accounts, and **tells the truth about the mode** - the
  dry-run confirm says nothing will publish, so nobody learns to click through a real warning
  out of habit. If every target fails the modal stays open rather than closing over orphaned
  drafts, matching the queue flow's rule.
- New `test/publish-now.test.js` (6): happy path sets `publish_at` and submits, assisted-manual
  refused with the row untouched, wrong status, the TikTok gate, unknown id, and UTM applied
  exactly once.

## 2026-08-02 - B20: bulk approve + draft-first detail page

First session that loaded and approved a **whole week** of drafts at once (6 CHolmesIV posts,
Aug 3-7). That exposed three things one-or-two-post sessions never did. Spec:
`docs/archive/B20_BULK_APPROVE_SPEC.md`. Suite **309 passing** (was 300).

- **Bulk approve** - new `POST /api/posts/approve-batch` taking `{post_ids}` and returning
  `{approved, skipped, dry_run}`. It is N single approves, not a shortcut past the gate: each
  post independently gets the `scheduled_local` promotion when it has a `publish_at`, the
  TikTok required-fields check, and the approve-gate UTM pass. One bad post never blocks its
  siblings - it comes back in `skipped` with a reason (`not_found`, `wrong_status`,
  `tiktok_fields_missing`). Quiet hours stays a client-side soft confirm, matching the
  single-post path, and the frontend runs it **once per batch** instead of N times.
- **`applyApproveUtm()` extracted to `src/utm.js`** and called from both the PATCH handler and
  the new batch route, so the two approve paths cannot drift. Behavior-preserving: the
  existing `utm.test.js` + `server.approve-gate.test.js` pass untouched, and a new test asserts
  bulk-approved and PATCH-approved posts come out byte-identical.
- **Multi-select on the agenda** (Calendar -> Upcoming). Rows became
  `div.agenda-row-wrap > [checkbox, button.agenda-row]` (a checkbox cannot live inside a
  `<button>`); the row button keeps its popover behavior. Checkboxes appear only on
  bulk-actionable posts (draft/approved/scheduled_local), with a spacer keeping published rows
  aligned. Each day group and the unscheduled group gets a select-all with proper
  indeterminate state. Selection is scoped to the render and cleared on reload, so a stale id
  can never reach a bulk action.
- **Sticky bulk action bar**: `N selected · Approve N · Reschedule N… · Trash N · Clear`.
  Reschedule applies **one** timestamp to everything selected and says so - a spread is a
  parking-lot item, not something to fake. Trash reuses the existing hard-delete endpoint, so
  only draft/canceled can go.
- **Approve from the calendar/agenda popover** (`openPostPopover`) when a post is a draft. This
  was the actual friction: the only Approve button in the app lived on the full detail page,
  so reviewing a week meant opening every post.
- **Detail page is draft-first now.** `Edit` moved directly under the status actions. Metrics
  is **not rendered at all** for a post that has never been handed off (asking for impressions
  on a post that does not exist yet was pure scroll) and returns automatically once it
  publishes; `failed_verify` counts as may-be-live and keeps its metrics. Status history
  collapses into a `<details>` for unpublished posts.
- Shared `approvePost()` / `confirmQuietHours()` helpers in `public/app.js` so the detail page,
  the popover, and the bulk bar run one approve implementation.
- Fixed in passing: `drawAgenda` early-returned when there were no scheduled days, which would
  have skipped the bulk bar whenever only unscheduled drafts existed.
- New `test/bulk-approve.test.js` (7): happy path, scheduled_local vs approved promotion,
  mixed-status skipping, the TikTok gate, 400 on empty/malformed body, unknown ids, and
  UTM parity with the single-post path.

## 2026-07-19 (night) - Composer v3, manual send controls, reliability + image pipeline

Driven by CB's live testing (the composer verdict: "you don't want to use this to create
a post") and a real incident: scheduled posts silently never reached Blotato.

- **Composer v3 - single dense form**: replaced the card-stack composer entirely. Accounts
  row -> copy card (Default + per-platform tabs, tone + Draft-with-AI ON the box, char +
  fold counters, live preview) -> media strip (library picker, Request image with an
  immediate **"Waiting on Codex" placeholder tile** that polls and becomes the picked
  image) -> one details line (content type, pillar, tags, campaign) -> one schedule line ->
  sticky action bar. Everything for a normal post visible with ZERO expanding; the only
  collapsed region is Advanced (tiktok/reddit/blog fields, examples, redistribute).
  Image requests auto-save the draft first so they always carry a post_id. Fresh installs
  default to the first brand (no more blank page). Calendar day-click now opens a **day
  popover** (that day's posts + "New post on <date>" -> Quick Compose) instead of dumping
  into the full page.
- **Incident: posts silently skipped.** CB's CHolmesIV LinkedIn account had `manual=1`
  (flipped mid-rework 7/18) - the worker deliberately never hands manual accounts to
  Blotato and wrote NO error. Flag cleared; post handed off (submission b8abf2a9). Fix
  class shipped: **manual-account badges** ("won't auto-post") on chips/popover/review,
  and missed-window flagging.
- **Send controls (CB: "I just don't have a button")**: per-post **"Send to Blotato now"**
  (popover, modal, review; hands off early, still publishes at the scheduled time),
  **bulk "Send to Blotato"** on the calendar (current view scope, preview + confirm with
  per-reason skip breakdown), and a **Sync now** action. New endpoints:
  POST /api/posts/submit-batch (+preview), POST /api/worker/run-now (409 when busy).
- **Computer-was-off catch-up**: the worker now runs a full sweep seconds after app
  launch; posts whose time passed while the machine was off get flagged
  ('missed_window...') instead of silently posting late - surfaced with a resend button.
- **Live/sync status pill** (nav rail): green Live / amber Dry run / red Worker off;
  popover with last/next sync, submitted/waiting/error counts, Sync now.
- **All Brands calendar identity**: brand-colored accent + initial disc on chips/rows
  when no single brand is filtered.
- **Image auto-fit pipeline** (`src/imagefit.js`): every image is normalized to the
  target platform at handoff time (resize within dims, format convert, quality-step
  under the platform's size cap) via sips derivatives - originals never touched; Codex
  imports pre-generate fits per platform; POST /api/media/fit for manual runs. Fixes
  "Codex makes images too big for Blotato".
- **Link in first comment** (mig v10, `posts.first_comment`): composer + Quick Compose
  toggle; UTM applies to the comment link at approve. Verified against Blotato docs:
  additionalPosts auto-chains ONLY on twitter/bluesky/threads (flat {text, mediaUrls}
  entries - review caught the agent's wrong shape) - on those it posts automatically;
  on linkedin/facebook the app shows a **"paste as first comment" reminder + copy
  button** on the live post instead.
- **Alt text** input + AI suggest on composer media tiles.
- Suite 268 -> 300. Blotato payload shape verified against help.blotato.com llms-full.txt.

## 2026-07-19 - B19 flow wave: preview, review mode, calendar popover/agenda, icons, shortcuts

Eight features from CB's hands-on testing session + Blotato/Sprout inspiration. Spec:
`docs/archive/B19_FLOW_WAVE_SPEC.md`. Suite 257 -> 268.

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
  keeping PostDeck's ink/gold identity. Spec: `docs/archive/D2_CONSISTENCY_PASS_SPEC.md`; full
  view-by-view audit that drove the work: `docs/archive/D2_AUDIT.md`.
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
  `docs/archive/B16_B18_COMPETITIVE_WAVE_SPEC.md`: **B16** queue slots (Sprout-style recurring
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
  not `data`. Resolved the real account map: FB `41416`, LinkedIn `21735`, Twitter `18887`,
  with per-brand page subaccounts (see SOCIAL_STATUS.md).
- **PrimeWright accounts wired:** LinkedIn #8 -> acct 21735 / page 142893330; Facebook #9 ->
  acct 41416 / page 1223593834169963; both manual=0 (worker-eligible).
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
