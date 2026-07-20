# B19 - Flow wave: preview, review mode, idea-drag, duplicate, shortcuts, setup card (2026-07-19)

CB-approved final pass of the Hootsuite/Sprout-inspired work. Six features, spec'd together,
built after the composer-fix wave lands. No GitHub pushes until the whole batch (composer
fixes + B19) ships and verifies - then one close-out: private push, public snapshot + scrub,
docs.

House rules apply throughout: no new deps, D2 primitives + button system, ink/gold identity,
hook-first + link-high + no-em-dash content standards, approve stays human.

---

## F1 - Network post preview (priority 1)

Render the post as it will look in-feed, per platform. The point: CB sees what survives
above the fold BEFORE approving (hook-first enforcement).

- `src/preview-specs.js` OR extend `config/platform-specs.json` with per-platform preview
  rules: feed truncation point (linkedin ~210 chars / 3 lines, facebook ~477 chars,
  twitter 280 hard, instagram ~125 for caption fold, tiktok caption ~1000), name/avatar
  layout, link-card behavior note.
- Frontend `renderPostPreview(platform, {copy, media, brand})`: a feed-card mockup - brand
  avatar (brand logo if set, else initial-letter disc), brand/page name, the copy with a
  visual **"…see more" fold line** at the platform's truncation point (content below the
  fold dimmed), attached image thumb at platform aspect. Pure CSS/DOM, approximate is fine;
  it's a judgment aid, not a pixel clone.
- Where it appears: Quick Compose (toggle button "Preview" swaps the textarea column, or
  renders beside it if width allows), full composer per-platform variant tabs (preview under
  each variant editor), Review mode (F2, always on), post detail/modal.
- Above-the-fold indicator: chars-remaining-to-fold counter near the copy box ("Fold in 34
  chars") - reinforces the hook standard while typing.

## F2 - Review mode (priority 1)

Batch approval for AI-drafted posts: one at a time, full preview, act, next.

- Entry: "Review drafts (N)" button on Home needs-attention + Analytics-adjacent nav spot;
  route `#/review`.
- Screen: centered card = F1 preview + editable copy textarea (edits save on action) +
  schedule line (publish_at or "Add to queue" inline) + actions: **Approve** (primary),
  **Approve & next**, **Skip** (next, no change), **Trash** (destructive; existing
  cancel/delete semantics), **Open in composer** (ghost). Progress "3 of 12". Keyboard:
  A approve, S skip, arrow keys next/prev, E focus editor.
- Queue = all `draft` posts filtered by the sticky brand (brand switcher chip row at top;
  "all brands" option). Approving respects the existing approve-gate logic (UTM hook etc.
  fires server-side as today).
- No backend changes expected (PATCH status + existing endpoints); if trash needs a proper
  delete endpoint, add `DELETE /api/posts/:id` guarded to draft/canceled only + test.

## F3 - Drag ideas onto the calendar

- Ideas board cards become draggable (reuse calendar chip drag pattern); Calendar accepts
  an idea-card drop on a day cell → opens Quick Compose prefilled: idea text as copy
  seed (or as the AI prompt seed), idea's brand, publish_at = that day at next queue-slot
  time if one exists else 09:00. On successful save, idea status moves to its "used"
  state (check ideas schema for the right status value; add one only if none fits).
- Smaller win, same pattern: an "Use in post" button on each idea card (same prefill, no
  drag needed) for touch/small screens.

## F4 - Duplicate / copy to brand

- Post detail + post modal + review mode overflow: **Duplicate** (same brand, new draft,
  copy + media + platform prefilled, no publish_at) and **Copy to brand →** (brand list;
  creates a draft for target brand and, when AI available, auto-redrafts the copy through
  the target brand's voice via the existing draft path with the original as grounding - falls back to verbatim copy + a "re-voice with AI" button if CLI not available).
- Backend: `POST /api/posts/:id/duplicate` {brand_id?} → new draft post (server-side copy
  keeps media refs + platform; strips publish_at/status history). Test.

## F5 - Keyboard shortcuts + command palette

- Global keys (ignored while typing in inputs): **C** = Quick Compose, **G then D/C/I/A** =
  go Home/Calendar/Ideas/Analytics (or simpler: single keys 1-4), **R** = review mode,
  **?** = shortcut cheat-sheet modal.
- **Cmd+K palette**: fuzzy list of (a) navigation targets, (b) actions (New post, Review
  drafts, Import analytics, Request image), (c) post search by copy substring (existing
  GET /api/posts client-side filter is fine at CB's volume). Arrow keys + Enter. Esc closes.
  One overlay component, D2 modal styling.
- Discoverability: "?" hint in the nav rail footer; shortcuts listed in Help/README.

## F6 - Brand setup completeness card

- Home card (one row per brand): checks = Blotato account(s) connected ✓, queue slots
  defined ✓, UTM link tracking on ✓ (or explicitly "off" as a neutral state, not a warning - it's optional), brand profile status current ✓, voice/tone set ✓. Each item click-jumps
  to the exact Settings zone/section. Collapsed by default once a brand is 100%.
- Pure frontend over existing endpoints (accounts, queue-slots, brands utm fields,
  profiles staleness, settings) - no backend changes expected.

## F7 - Calendar popover + platform icons (Blotato-inspired, CB request 2026-07-19)

- **Post popover on the calendar**: clicking a chip opens a compact anchored popover (not
  the full modal): platform icon + brand, scheduled date/time, first ~3 lines of copy, and
  three quick actions - **Reschedule** (inline datetime picker, saves via existing PATCH),
  **Move to drafts** (status → draft, clears publish_at), **Delete** (destructive; drafts
  hard-delete via the F2 DELETE endpoint, scheduled posts use existing cancel semantics) - plus **See more** which opens the existing full quick-view modal. Esc/click-outside
  closes. Position near the chip, flip when near viewport edges.
- **Platform icons**: inline SVG icon set (linkedin, facebook, instagram, twitter/x,
  tiktok, reddit, youtube, blog) as a `platformIcon(name)` helper - used on calendar chips,
  account/platform toggle chips (quick compose + composer), platform tabs, coverage strip,
  and the F1 preview header. Single-color (currentColor) so they inherit the theme; no
  brand-color logos needed. No deps - hand-rolled simple paths.

## F8 - Upcoming Posts agenda view (graduates from the parking lot)

- Calendar gets a third view toggle: **Month / Week / Upcoming**. Upcoming = vertical
  agenda list grouped by day ("Today", "Tomorrow", then dates), each row: platform icon,
  time, brand pill, copy first line, status badge; row click opens the F7 popover (or the
  modal). Covers the next 14 days + an "Unscheduled drafts" group at top. Respects
  brand/platform/tag filters. This is the high-volume scheduler's working view.

---

## Execution

Order: F1+F2 first (the daily-quality pair - F2 embeds F1), then F7+F8 (calendar set),
then F3+F4, then F5+F6.
Build split (Sonnet, sequential on public/ since all share app.js; backend bits are tiny):
- Agent 1: F1 preview component + fold counter + placements (quick compose, full composer,
  post modal) - plus preview rules data + the platformIcon SVG helper (F7 dependency).
- Agent 2: F2 review mode (+ DELETE /api/posts/:id endpoint guarded to draft/canceled,
  with test) - consumes F1.
- Agent 3: F7 popover + icons applied everywhere + F8 Upcoming agenda view.
- Agent 4: F3 + F4 (drag/prefill + duplicate endpoint + test).
- Agent 5: F5 + F6 (shortcuts/palette + setup card).
Strong review + full browser walk + suite green after each agent; docs (CHANGELOG,
BUILD_STATUS, SPEC.md) at the end of the wave; NO pushes until the entire batch is done,
then the single close-out (private push → public snapshot+scrub → repo description/README).
