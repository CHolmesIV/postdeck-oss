# PostDeck — Design Pass (2026-07-20/21)

A density + app-feel redesign across the highest-traffic views. The app had grown
(many new views added by Codex) and read like a stack of long marketing-style
cards you had to scroll through. This pass made it feel like a tool: dense,
scannable, essentials above the fold. Each page was verified in-browser (desktop
+ narrow) and committed independently.

## What changed, per page

### Home
- Was: six full-width cards stacked vertically (Needs Attention, Setup, This
  Week, Platform Status, Analytics, an embedded Calendar) — long scroll on open.
- Now: a **bento grid**. Needs Attention is a slim strip (only when non-empty),
  then a 2-column grid: This Week + Platform Status, Analytics + Setup.
- **Setup** went from 5 brands × 5 checks as nested collapsible cards (~25 rows)
  to one **compact readiness matrix** (brand rows × dot columns: Blotato / Slots
  / Tracking / Profile / Voice). Click a dot to jump to the fix.
- **Removed the embedded calendar** from Home (it has its own page) — replaced
  with an "Open calendar →" link. Biggest single length reduction.

### Composer
- Was: one long single-column form (accounts → copy → preview → media → details
  → schedule → save → advanced), capped 980px. Scroll to write and schedule.
- Now: a **two-column workspace** (up to 1400px). Left = editor (brand/accounts,
  AI-draft tools, copy textarea, media). Right = **sticky** live Preview +
  compact metadata/scheduling (content type, pillar, tags, campaign, publish-at,
  queue, first-comment, Save/Approve). Write on the left, see preview + settings
  on the right — everything on one screen. Collapses to single column < 900px.
- Textarea min-height 168px → 120px; settings grouped compactly, no nested cards.

### Calendar / Queue
- Was: title + a controls row + a filters row + a brand-chips band = 3-4 rows of
  chrome before the grid.
- Now: title + all nav/mode/refresh/Send-to-Blotato on **one toolbar line**;
  Brand/Platform/Tag filters on **one slim line**; coverage chips as one slim
  row. Grid starts much higher — the whole month + its post chips fit.
- Month cells and chips tightened (min-height 114px → 84px, denser typography).
  Week/Upcoming modes inherit the tighter styling. Drag-reschedule intact.
- **Chip alignment fix** (follow-up): chips were `display:block` with the SVG
  platform icon jammed against the copy text (`inAI isn't…`), uneven heights,
  and a `border-left` gold side-stripe on every chip. Rewrote the chip as a flex
  row — leading brand/campaign color **dot** (replaces the banned side-stripe),
  platform icon, then a single truncating `.chip-text` span — all vertically
  centered, consistent height. Removed the inline status text badge (didn't fit
  narrow cells; status now shown via subtle chip styling + tooltip + popover) and
  suppressed the redundant per-day platform count-dot row in month mode (every
  post already renders as its own chip; no cap, so nothing to summarize).

### Analytics
- Was: led with "Metrics Due (8)" — a tall chore-list with cramped/truncated
  inputs — before any actual analytics; real rollups below the fold.
- Now: **analytics first** — per-brand rollups (compact stat strip, week-over-
  week, SVG charts, top-10 lists), tightened so more than one brand is visible.
  **Metrics Due demoted** to a collapsed panel (open state persists) as a dense
  table with readable, tab-through inputs.
- Deliberately avoided the big-number/gradient hero-metric cliché — plain,
  scannable stat tiles.

## Global fix
- The `main#view` entrance animation (`@keyframes viewIn`) started at
  `opacity: 0`, which left views rendered **dimmed** if a paint landed before the
  animation finished (a real reveal-gating anti-pattern; also broke headless
  screenshots). Fixed: the keyframe now animates transform only — content is
  visible by default, just slides in. Reduced-motion path untouched.

## Design system notes (for future passes)
- Reusable primitives introduced: `.home-grid` / `.home-panel` (the density
  panel style), the readiness-matrix dot pattern, the two-column composer grid.
  Reuse these when redesigning the remaining views.
- Dark operator theme throughout: Deep Ink bg, Ember Gold accent, Slate White
  text. No new palette introduced; all changes used existing tokens.
- Consistent rules applied: no nested cards, left-aligned, verify contrast,
  reveal enhances (never gates) visibility, no hero-metric template.

## Status — views still on the default (long-card) style
Not yet passed (candidates for the next session): **Review, Library, Images,
Ideas Board, Research, Inspiration, Profiles, Settings, Ops**. Home, Composer,
Calendar/Queue, and Analytics are done.

## Repo / security
- All work is in the **private** repo `CHolmesIV/postdeck`. Layout/CSS only — no
  credentials touched. Real Blotato account IDs remain in gitignored
  `config/accounts.seed.json`.
- Reminder (issue #7): before this repo goes public, squash git history first —
  the original v1 spec commit contains real account IDs. Do not just flip
  visibility.

## B22 publishing workflow follow-up (2026-08-12)

The earlier density pass improved the calendar's appearance but left the primary publishing
decision fragmented across a small popover, full detail page, raw date input, and several status
actions. B22 fixes the interaction architecture:

- Calendar review is now a right-side drawer, preserving calendar context while giving the post
  enough room to preview and edit comfortably.
- Draft, schedule, queue, and immediate publication are mutually exclusive delivery choices.
  Only the active choice gets a primary action.
- Rare or dangerous actions are collapsed under Advanced actions.
- Account selection uses larger labeled cards with visible connection and selection state.
- Typography favors a clear hierarchy: small uppercase section labels, 14px editing copy, compact
  metadata, and one full-width final action.
- Layout collapses cleanly to one column on narrow screens and preserves keyboard focus styles.

The result keeps PostDeck's Deep Ink and Ember Gold identity while adopting the useful workflow
discipline of Sprout Social and Hootsuite without copying their visual branding.

## Home attention follow-up (2026-08-12)

The `Needs attention` panel now treats each row as an actionable link with a separate, compact
close control. Dismiss all sits in the panel header for quick cleanup. Dismissals persist for the
exact condition, while new or changed conditions return automatically. This keeps Home calm
without turning it into a notification center or permanently muting operational warnings.
