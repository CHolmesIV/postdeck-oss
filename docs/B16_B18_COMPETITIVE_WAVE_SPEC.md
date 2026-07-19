# B16–B18 - Competitive Wave Spec (Hootsuite/Sprout gap analysis, 2026-07-18)

Source: competitive research vs Hootsuite + Sprout Social (2025–2026 feature sets) crossed
against the current PostDeck inventory. Filter applied: local-first, single operator, Blotato
transport, no new paid APIs, no team/multi-user features. This doc is the build spec for the
three waves that came out of that analysis.

**Explicitly skipped (do not re-litigate):** unified social inbox / sentiment / cases
(needs platform APIs Blotato doesn't provide; built for teams), approval chains / employee
advocacy / multi-user anything (single operator by design), enterprise listening +
competitor benchmarking (deferred API spend), paid/ads integration.

---

## B16 - Queues + Navigation rail

The two highest-ROI items. Queue slots change the daily workflow; the nav rail fixes sprawl
(13 routes reached by ad-hoc links).

### B16a - Queue slots (Sprout's signature pattern)

Mental model shift: instead of hand-picking `publish_at` per post, define recurring weekly
slots per brand+platform and "Add to queue" - the post drops into the next open slot.

**DB (migration)**
- `queue_slots` table: `id, brand_id, platform, day_of_week (0-6), time_local (HH:MM),
  active (default 1), created_at`. No per-account granularity - slot is brand+platform;
  the composer's normal distribution picks accounts.
- No change to `posts`; a queued post is just a normal post whose `publish_at` was computed
  at add-time. (Keep it dumb: no live re-flow when slots change; a "re-flow queue" action can
  come later if wanted.)

**Backend (`src/queue.js` + `server.js`)**
- `GET/POST/PATCH/DELETE /api/queue-slots` (list per brand, create, toggle active, delete).
- `nextOpenSlot(brand_id, platform, from)` - walks slots in weekly order, skips datetimes
  already taken by a scheduled/submitted post for that brand+platform, respects quiet hours,
  returns the first open ISO datetime ≥ `from` (default now). Skip same-day slots already in
  the past.
- `POST /api/posts/:id/queue` - computes next open slot (per platform in the post's
  distribution; use the earliest across selected platforms as the single `publish_at`),
  sets it, returns the computed time so the UI can show "Queued for Tue 12:00pm".

**Frontend**
- Settings → new "Queues" collapsible per brand: weekly grid editor (add slot = day + time
  + platform), active toggle, delete. Seed suggestion button: "Daily 12:00 LinkedIn + Facebook".
- Composer action bar: **"Add to queue"** button next to Schedule - fills `publish_at` with
  the computed slot and shows it (still editable before save; approval gate unchanged).
- Calendar: queued posts render like any scheduled post (no special casing).

**Tests** - `queue.test.js`: slot CRUD; `nextOpenSlot` ordering, collision skip, quiet-hours
skip, past-slot skip, week rollover; `POST /:id/queue` contract.

### B16b - Left navigation rail (Sprout's flattened-nav rebuild)

- Persistent left rail in the app shell (outside the `#view` swap), grouped with collapsible
  headers (state in `localStorage pd_nav_*`):
  - **Plan**: Home, Calendar, Ideas
  - **Create**: Composer, Library, Images
  - **Grow**: Analytics, Research, Inspiration
  - **Setup**: Profiles, Settings, Ops
- Active-route highlight from the hash router; count badges where cheap (drafts awaiting on
  Composer? keep minimal - only "needs attention" count on Home).
- Collapses to icon-only under the existing responsive breakpoint; FAB/chat/action-center
  positions re-checked.
- Design language: existing tokens (Ink/Gold, `--grad-surface`, `.pill`), no new deps.

**Tests** - nav is DOM-only; extend any existing shell/render test to assert rail links map
to router table. Visual verify in-browser.

---

## B17 - Campaign tags + calendar gap-finding

Natural pair: tags give the calendar something to color/filter by; gap-finding makes the
calendar answer "where am I dark?"

### B17a - Tags & campaigns (Sprout's two-tier model, simplified)

**DB (migration)**
- `tags` table: `id, name, kind ('tag'|'campaign'), color, brand_id NULLABLE (null = global),
  created_at`. `post_tags` join: `post_id, tag_id`.

**Backend**
- `GET/POST/PATCH/DELETE /api/tags`; `PUT /api/posts/:id/tags` (replace set).
- Analytics: extend rollup queries to accept `?tag_id=` - per-tag totals + top posts
  (campaign ROI-lite, on the existing manual-metrics data).

**Frontend**
- Composer: tag picker chips (create-inline like Sprout's compose flow); campaign picker is
  the same control filtered to `kind='campaign'` (one campaign max per post, many tags).
- Calendar: chip left-border colored by campaign; filter dropdown gains tag/campaign filter;
  hover shows tag names (title attr is fine).
- Analytics: campaign selector → filtered rollup + "Campaign performance" card.

**Tests** - `tags.test.js`: CRUD, join replace, analytics rollup filtered by tag.

### B17b - Calendar gap-finding (Sprout month view + Hootsuite gap positioning)

- Month view: per-day post-count pill per platform (tiny colored dots + count); zero-post
  days get a subtle "empty" treatment (dashed cell tint) instead of blank.
- Week view: same per-day counts in the column header.
- **Coverage strip** above the grid: one row per active brand - "PrimeWright: 5 scheduled
  this week · Lunula: 0 ⚠". Click a warning → composer prefilled with that brand.
- Pure frontend over existing `GET /api/posts` data; no backend change expected (add a
  `?from=&to=` range param only if the current fetch is insufficient).

**Tests** - count/coverage computation extracted to pure helpers, unit-tested.

---

## B18 - Insight-at-decision-point + link tracking

Rides on data already in the system. Hootsuite's pattern: surface the analytics insight at
the exact moment of the decision, not in a separate tab.

### B18a - Best-time nudge (composer, inline)

- `src/besttime.js`: `bestTimes(brand_id, platform)` →
  1. If ≥ N (=8) published posts with metrics for that brand+platform: bucket engagement by
     day-of-week + hour band, return top 3 bands ("Tue–Thu 9–11am").
  2. Else fall back to static per-platform defaults in `config/platform-specs.json`
     (add a `best_times` key: research-backed defaults per platform).
- `GET /api/best-times?brand_id=&platform=`.
- Composer schedule section: inline hint line "Best window: Tue–Thu 9–11am (from your data
  | default)" + click-to-apply chips that set `publish_at` to the next matching datetime.
  Also: "Last post to this platform: X days ago" (from existing posts data).
- NOT ViralPost-style auto-scheduling - suggestion only; queue slots (B16) remain the
  automation. The nudge also shows on the Settings queue editor when creating slots.

**Tests** - `besttime.test.js`: bucketing math on fixture metrics, fallback path, next-
matching-datetime resolution.

### B18b - Redraft-the-winner (OwlyWriter's repurpose feature)

- Analytics top-posts lists gain a **"Redraft"** button per row → opens composer with the
  original as grounding: prompt = "fresh take on this proven post, same idea, new angle/hook"
  through the existing draft pipeline (provider switcher, scrub, hook-first + link-high
  content standards apply). Original copy lands in the Examples panel as grounding, not
  pasted into fields.
- No schema change; reuses `/api/draft` with an extra grounding param (or the examples
  mechanism directly).

**Tests** - extend draft tests: grounding included in prompt; scrub still applied.

### B18c - UTM auto-append

- Settings: per-brand "Link tracking" toggle + template
  (default `utm_source={platform}&utm_medium=social&utm_campaign={campaign|brand}`).
- On approve (not on draft - keep drafts clean): `src/utm.js` rewrites bare links in copy
  fields, appending params (skip links that already carry `utm_`; skip manual platforms?
  no - manual copy benefits too). Idempotent.
- Post-detail shows the final tracked link.

**Tests** - `utm.test.js`: append, idempotency, existing-utm skip, campaign substitution,
multiple links, anchors/query edge cases.

---

## Deferred / later (parking lot, from the same analysis)

- **List/agenda calendar view** - sortable upcoming-posts list with bulk actions. Worth it,
  but behind B16–B18.
- **Streams-lite** - per-brand board of saved links (own pages, competitors, hashtag
  searches) for a manual morning sweep. Formalizes inspiration profiles.
- **Queue re-flow** - recompute queued posts when slots change.
- **ICS export** of the calendar.

## Constraints (unchanged house rules)

- No new deps; vanilla JS + inline SVG; `claude -p --tools ""` pattern for any new CLI
  shell-out; approve→publish stays human; DRY_RUN backstop; no em-dashes in generated copy;
  hook-first + link-high standards baked into any new draft prompts.

## Build split (plan strong → build Sonnet parallel → review strong)

- **B16 wave**: agent M = migration + `src/queue.js` + endpoints + tests; agent N = nav rail
  (shell HTML/CSS/JS) - disjoint files, run parallel; strong review + browser smoke.
- **B17 wave**: agent O = tags migration + endpoints + analytics filter + tests; agent P =
  calendar gap-finding + tag UI (frontend) - parallel.
- **B18 wave**: agent Q = `besttime.js` + `utm.js` + endpoints + tests; agent R = composer
  nudge + redraft button + settings UI - parallel.
- Each wave: full `npm test` green, CHANGELOG + BUILD_STATUS updated, commit to `working`,
  push; public snapshot refresh at the end of the whole run (standard archive+scrub).
