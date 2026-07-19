# D2 - Design Consistency Pass (Seeds-informed, 2026-07-18)

Source: Sprout Social's public design system "Seeds" (seeds.sproutsocial.com) + their app
layout conventions, distilled 2026-07-18. Goal: adopt Sprout's *discipline and layout
patterns*, NOT their visual style. PostDeck keeps its identity (Ink #0D0D0D / Gold #C8902A
tokens, existing card/pill/chip language). This pass sweeps all 13 views onto a small set of
canonical primitives so the app stops reading as 15 build-waves stitched together.

Runs AFTER B16–B18 ship. No new deps, vanilla JS + CSS only.

---

## Canonical rules (the system)

### R1 - Page header, fixed action order
Every view gets the same header structure: **Page title (required, h1) → primary context
control (brand picker where applicable) → actions**. Action order is FIXED across views
(Seeds rule): date-range control leftmost (where one exists), share/export next, **filters
rightmost**, overflow `…` for low-priority actions. One shared `pageHeader()` helper in
app.js renders it; views stop hand-rolling their own toolbars.

### R2 - Content width tiers
Three tiers only (CSS classes on the view root): `view-flush` (calendar grid - full width),
`view-default` (max-width 1400px, centered, 16px pad - most views), `view-narrow`
(max-width 736px - settings, composer? test both). Kill ad-hoc per-view widths.

### R3 - Single-column forms + FormSection primitive
All forms single column. Related fields grouped in a `formSection(label, hint, rows...)`
helper (labeled group + optional one-line description) - replaces the per-wave ad-hoc rows
(add-slot row, tag creator, brand settings, UTM row, etc.). Labels always visible, sentence
case, click-to-focus. Placeholders only for format examples, never as labels; persistent
hint text under the field instead. Validation on submit, never disable the submit button;
error line under the field: one sentence, what's wrong + how to fix.

### R4 - Three named data states
Shared helpers: `loadingState()`, `emptyState(message, cta)`, and (where async jobs run)
`workingState(etaText)`. Every list/section that can be empty gets an empty state with ONE
clear CTA ("No queue slots yet - add your first slot" + button), not a blank section.
Consistent container so no layout jump between states.

### R5 - Toast vs banner
One `toast(msg)` helper (transient, one-off outcomes: saved, queued, deleted) and one
`banner(el, msg, kind)` helper (persistent conditions anchored to the object: "AI not
logged in", "no open slot"). Sweep existing ad-hoc `.msg-banner` / inline text feedback
onto these two. Buttons that fire async work show in-place pending state ("Saving…").

### R6 - Tables/lists
Text left, numbers right; header weight 600 / body 400; default sort dates+metrics desc,
text asc; explicit end-of-list line instead of silent stop. Applies to Analytics tables,
Ops stats, Library list, metrics-due queue.

### R7 - Accessibility floor
Focus ring on all interactive elements (one shared mixin/class); Esc closes every modal
(post modal already does - verify others); min 24px touch targets on icon buttons; color
never the only state signal (pair icon/text with the color).

### R8 - Component-level UI spec (buttons, inputs, controls)
Per CB: don't stop at layout - the component details are in scope too.
- **Button system**: exactly three sizes (sm 28px / md 36px / lg 44px heights) and three
  variants (primary gold, secondary surface, ghost/text) + a destructive style. One
  `.button` base class, size/variant modifiers; sweep every hand-rolled button/chip-button
  onto it. Consistent padding scale, icon+label spacing, and border radius from the
  existing token scale.
- **Interaction states, all controls**: defined hover, active/pressed, focus-visible,
  disabled, and pending states for buttons, chips, pills, inputs, selects, toggles. No
  control changes ONLY color on state (pair with elevation/border/icon).
- **Input system**: one input height per size tier matching buttons (so form rows line
  up), consistent border/focus treatment, same select and date/time input styling
  everywhere.
- **Icon buttons**: min 24px touch target (Seeds floor), consistent hit area even when
  the glyph is small (padding, not glyph size).
- **Spacing scale**: audit to the existing radius/space tokens; kill one-off pixel values
  in favor of the scale (add missing steps to :root rather than inlining).
- **Toggle/checkbox**: one styled switch pattern for on/off settings (utm_enabled, slot
  active, agent authority, hard rules) instead of mixed native checkboxes.

## Layout moves (Sprout-inspired, adapted)

### L1 - Nav rail refinement
Keep the B16 grouped rail; tighten to Seeds proportions: icon rail ~64px collapsed with
labels on hover/expand at wide viewports; active-route treatment consistent with tokens.
(Only if cheap - the B16 rail is new and working; this is polish, not rebuild.)

### L2 - Settings reorganized by scope
Sprout splits settings Account / Global / Feature. PostDeck equivalent - reorganize the
Settings view into three labeled zones (anchor links at top):
1. **Workspace** - global voice, hard rules, AI provider + login, agent publish authority,
   handoff window, export/sync, importers.
2. **Brands** - per-brand: accounts, tones, branding, queues, UTM/link tracking, profiles
   link. (Brand selector at the zone top; all per-brand sections react to it - today's
   behavior, but visually contained in one zone.)
3. **Integrations/Ops** - Blotato key status (masked), dry-run state, worker state,
   launchd/launcher notes, danger zone.

### L3 - Composer discipline (Sprout compose order)
Reorder to Sprout's flow: **distribution (profiles) → content (copy + per-platform
variants) → media → metadata (tags/campaign, content-type) → scheduling (publish-at +
queue + best-time nudge) → AI tools grouped in one collapsible**. Sticky action bar stays.
Progressive disclosure: advanced/per-platform field editors (tiktok/reddit/blog) collapsed
unless that platform is selected (may already be true - verify and enforce).

### L4 - Calendar toolbar
Apply R1 order to the calendar: month/week toggle + date nav left, refresh + (future
export) middle-right, filters (brand/platform/tag) rightmost, coverage strip below the
toolbar. List view stays in the parking lot (separate feature, not this pass).

## Writing sweep (cheap, high-visibility)
Sentence case on all labels/buttons; error messages rewritten to the R3 formula; empty
states get reassuring one-liners. No em-dashes in any UI copy (house rule).

## Execution plan

Phase 0 (strong): audit pass - walk all 13 views in the browser, inventory violations of
R1–R7 per view into a checklist (docs/D2_AUDIT.md, temporary working doc).
Phase 1 (Sonnet, sequential on shared files or carefully split):
- Agent A: primitives - pageHeader/formSection/toast/banner/empty-state helpers + CSS,
  applied to 2 pilot views (Settings zones L2 + Composer L3, the two worst offenders).
- Agent B (after A lands): sweep remaining views onto the primitives (Home, Calendar+L4,
  Ideas, Library, Analytics, Ops, Research, Inspiration, Images, Profiles, post detail).
Phase 2 (strong): review, browser walk of every view, suite green, ship.

Tests: suite stays green throughout; helpers are DOM-side (not unit-testable in current
harness) - browser verification per view is the gate.

## Non-goals
No visual rebrand, no new nav structure beyond L1 polish, no list-view feature, no new
functionality at all - pure consistency + layout. Feature parking lot stays in
B16_B18_COMPETITIVE_WAVE_SPEC.md.
