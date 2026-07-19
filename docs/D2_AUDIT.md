# D2 Audit - Design Consistency Pass

Phase 0 audit. Walked all views at ~1400px in the browser (`BLOTATO_DRY_RUN=1 POSTDECK_WORKER=0 npm start`,
port 4520) plus read the matching render functions in `public/app.js` and `public/styles.css`.
Working doc per D2_CONSISTENCY_PASS_SPEC.md - temporary, feeds Phase 1 agents A/B.

No app code was changed for this audit.

---

## Global component inventory (R8)

Every distinct interactive-control style found, with source location.

### Buttons
| Style | Where defined | Height (approx, 13px font + padding) | Notes |
|---|---|---|---|
| `button` (default) | styles.css:223-250 | ~34px (8px+8px padding + 1px border x2 + line height) | Base for every unstyled button |
| `button.primary` | styles.css:252-259 | ~34px | Gold gradient, used for main CTAs |
| `button.danger` | styles.css:260-261 | ~34px | Red-tinted, used inconsistently (Ops "Mark stale" line 4270, calendar delete flows) |
| `.home-quickbar button` | styles.css:568-575 | ~44px (12px+12px padding) | Home only |
| `.home-quickbar .quickbar-primary` | styles.css:576-585 | ~47px (13px+13px) | Home "+ New Post", one-off size, doesn't match any other primary button height |
| `.cal-nav-btn` | styles.css:1341 | ~27px (6px+6px, 13px font) | Calendar prev/today/next |
| `.chip-btn` | styles.css:687-698 | ~24px (5px+5px, 12px font) | Composer tag/campaign chips, copy-assist chips |
| `.provider-switch button` | styles.css:712-726 | ~26px (6px+6px, 12px font) | AI provider toggle, no border-radius (square, breaks pill/button vocabulary) |
| `.profile-copy-btn` | styles.css:1171-1176 | ~20px (3px+3px, 11px font) | Profiles "Copy" - smaller than the 24px icon-button floor in R8 |
| `.account-remove` | styles.css:1458-1467 | ~20px (2px+2px, 12px font) | Composer/account row remove "✕" - under 24px touch target |
| `.modal-close` | styles.css:1504-1513 | ~22px | Under 24px floor |
| `.redraft-btn` | styles.css:1550-1554 | ~20px (2px+2px, 11px font) | Analytics winner rows |
| `.best-time-chip` | styles.css:1547 | ~22px (3px+3px, 11px font) | Composer/settings best-time nudge |
| `class:'btn-secondary'` (app.js:2080, 2358, 2366) | **no CSS rule exists** | falls back to plain `button` default | Dead class name - either a leftover from a prior refactor or a bug. Renders fine only because it inherits the bare `button` selector, but any future intent (e.g. distinct "secondary" look) is silently lost. |

Counted heights in actual use: **~20px, 22px, 24px, 26px, 27px, 34px, 44px, 47px** - at least 8 distinct button heights across the app, against spec's target of exactly 3 (sm 28 / md 36 / lg 44).

### Inputs / selects
- Base `select, input, textarea` all share one rule (styles.css:223-238, ~34px tall with 8px/11px padding) - this part is actually already consistent app-wide. Good baseline to build the size tiers from.
- Toolbar `<select>` elements (brand/platform/tag/view pickers) use the same base - fine.
- `.field-row input/select/textarea` forced to `width:100%` (composer, profiles, research) - consistent.
- `input[type=color]` swatches (Settings branding, styles.css:1219-1227) are a one-off 36x28px control, not part of any system.
- `.example-chip`, `.tag-pill`, `.pill.source-pill` etc. all separate one-off pill treatments layered on top of the shared `.pill` base - inconsistent padding (3px/10px pill base vs 5px/12px chip-btn vs 5px/6px/12px example-chip).

### Toggles/checkboxes
- `settingsToggleRow()` helper (app.js:3526) - native checkbox + separate `.settings-toggle-state` ON/OFF pill. Used 4x in Settings (global rules x2, assistant authority, per-brand UTM). This is the closest thing to a "styled switch" today, but it's still a bare native checkbox, just paired with a redundant text pill - not an actual switch control.
- 7 other native checkboxes with **no** pill/label treatment at all: composer account-select (app.js:1986), composer manual-toggle (app.js:2009), image-resize platform picker (app.js:719, 4837), redistribute platform picker (app.js:171), queue slot active toggle (app.js:709), brand card toggle (app.js:4067). Each looks and behaves differently (some have a `manual-toggle-label` wrapper with 11px muted text, some have none).
- Net: three different checkbox presentations in the app today, none of them a true toggle/switch as R8 asks for.

### Status/tag pills
`.pill` base + 20 status-specific color modifiers (styles.css:276-296, 480-487) - this part is already a working, consistent system. Don't touch it in the sweep; just make sure new component work doesn't fork it further.

---

## Per-view checklist

### Home (`renderHome`, app.js:988)
- **R1**: No `pageHeader()` helper - hand-rolled `h1` + brand `<select>` in a plain `toolbar` div, then a second `home-quickbar` row of 5 buttons directly under it. Action buttons ("+ New Post", "Draft with AI", "+ Idea", "Request image (Codex)", "Redistribute blog post") aren't ordered per the R1 fixed order (date-range / share / filters rightmost) - they're a flat feature list with no hierarchy beyond primary=gold on the first one.
- **R2**: `main#view` default width, no `view-default` class system yet - fine visually at 1400px, but there's no explicit width tier applied anywhere in the codebase.
- **R8**: quickbar buttons are their own one-off size (44-47px, see inventory) not shared with any other view's buttons.
- **Compliant already**: card-based sections (Needs attention / This week / Platform status / Analytics) are visually consistent with each other and reuse `.card` + `.home-section` well. Attention rows have a clear color-coded dot (bad/warn/info) - good pattern to reuse elsewhere for state signaling (pairs color with position/icon per R7).
- **Empty state**: "Needs attention" shows "All clear." plain text (app.js:856) - no icon, no card change, acceptable but minimal. "This week" shows "Nothing scheduled in the next 7 days." (app.js:891) - good copy, no CTA button though. "Platform status" shows "No connected accounts." (app.js:907) - no CTA to go add one. Mini-analytics shows "No metrics yet - add some on published posts." (app.js:938/959) with a "View full analytics" link - best of the four, still no primary CTA button.
- **Feedback**: none of the home quick actions show pending/success state in place; they navigate to Composer/Ideas instead, so no direct save/delete feedback lives here.

### Calendar - month view (`renderCalendarInto`, app.js:522)
- **R1**: Toolbar order today is Brand → Platform → Tag → View(month/week) → prev/today/next/refresh → period label. That's almost the *opposite* of L4's target (nav left, refresh middle-right, filters rightmost) - brand/platform/tag filters currently sit leftmost, nav sits mid-right. Direct L4 violation.
- **L4**: Coverage strip (per-brand pills) renders below the toolbar, matches spec's intent structurally, but the "zero coverage" pills (`.cal-coverage-zero`) use color (red-tinted) as the only signal of "no posts" beyond the count text already printed inline - text does carry the info too, so this one's borderline-compliant (R7).
- **R6**: Day cells show 1-2 count dots (`.cal-count-dot`) with letter/number coding by platform - no legend visible in-view; a first-time user can't decode the dot colors without hovering. Not a strict R6 table violation (this isn't a table) but is a "color as the only signal" flag under R7 since the dots carry no text/tooltip confirmed in markup (only default browser title via el() attrs? not present here - worth checking in build).
- **Empty state**: empty days render as plain empty cal-day cells with a hover-only "+" affordance (styles.css:1344-1358) - acceptable, no giant blank void, but very quiet; a first-run brand with zero posts (e.g. Lunula Supply, CHolmesIV per the coverage pill counts seen live: "0 this week") gets no in-grid nudge, only the small red coverage pill above the grid.
- **Feedback**: drag-to-reschedule and click-to-open give no visible pending/saved toast; state changes rely on the calendar re-rendering after the fact (`currentCalendarReload`).

### Calendar - week view
- Same toolbar/header issues as month view (shared render path).
- Week columns show a per-day count ("· 2", "· 0") in the header - good, consistent, terse. Empty days ("· 0") render as plain cards with no chips and no "nothing scheduled" microcopy - silently blank, arguably needs the R4 emptyState pattern per-day-cell (or at least per week when the whole strip is empty).

### Calendar post modal (`openPostModal`, app.js:1315)
- **R7**: Esc-to-close is implemented (app.js:1323) - compliant, good reference implementation for other modals per spec's "verify others" note.
- **R5**: Uses ad-hoc `msg-banner msg-error`/`msg-ok` divs (app.js:1376, 1387, 1405) instead of the spec's shared `toast()`/`banner()` helpers (which don't exist yet in app.js - grepped, no `function toast(` or `function banner(` found anywhere). "Copied to clipboard." and "Could not load post" messages both render as static blocks - no auto-dismiss, no transient toast behavior.
- **R3**: Single field (Copy) + single date field, single column - already compliant.
- **R8**: "Save changes" is `.primary`, "Copy text" and "Open full page →" are bare buttons - no explicit secondary/ghost distinction, they just fall back to the default gradient button style, so visually "Copy text" and "Save changes" read with very similar weight despite different priority.
- Modal never shows a pending/"Saving…" state on submit (R5 requires in-place pending state on async buttons) - clicking "Save changes" gives no feedback until the modal closes or an error banner appears.

### Ideas Board (`renderIdeas`, app.js:1694)
- **R1**: No h1 action row beyond an inline add-idea form (title input + brand select + pillar input + "+ Add idea" button) directly under the h1 - functions as a toolbar but isn't distinguished from page content, no filters/overflow menu structure at all (there may not need to be one for this view, but it's worth deciding explicitly rather than by omission).
- **R4**: Each Kanban column (`Idea`/`Clustered`/`Drafted`/`Done`) renders with **zero** empty-state messaging when a column has no cards - confirmed live (all 4 columns render entirely blank, no "No ideas here yet" text at all). This is the flattest empty-state gap in the app: not even a one-line placeholder, just dead space.
- **R6**: N/A (kanban, not a table).
- **R3**: Add-idea row is 3 inputs + button in a single horizontal line, not the `formSection()` single-column pattern - small form, low priority, but technically in scope for the sweep.
- **Feedback**: no visible confirmation when adding an idea beyond the card appearing in the "Idea" column - no toast.

### Composer (`renderComposer`, app.js:1880) - **worst offender**
- **L3 order violation (major)**: DOM order today is: Brand picker → "Redistribute a blog post" toggle → **Distribute to (accounts)** (app.js:2057) → **Content type** (2104) → **Tags & campaign** (2130) → **Attached image** (line ~2200s, `imageBox`) → **AI tools** (`aiBox`) → **Composer / copy editor** (`composerBox`, the actual per-platform text) → **Publish at / scheduling** (`publishCard`) → **Image request options** (`imageOptsCard`) → Save row. Spec's target order is distribution → content → media → metadata → scheduling → AI-in-one-collapsible. Today the actual copy-writing surface (the thing the operator spends the most time on) is buried after distribution, content-type, tags, image, and AI sections - 5 cards deep. AI tooling is also split from "Image request options" (they're two separate un-adjacent cards) rather than grouped in one collapsible per spec.
- **R2**: Uses its own `.composer-grid` (2-col at desktop, collapses to 1 col only under 900px, styles.css:387-391, 1282-1286) - a per-view ad-hoc width/column system, not one of the three canonical R2 tiers.
- **R3**: Tags & campaign card mixes a labeled multi-chip picker with inline "+ tag"/"+ campaign" text inputs that create-on-Enter - clever, but it's exactly the kind of ad-hoc row pattern the spec calls out to replace with `formSection()`. Same for the account "Distribute to" rows (checkbox + label + manual-toggle + badge + remove button all inline, app.js:2049-2054) - dense single-line composite row, no `formSection` grouping/hint text.
- **R4**: "No accounts yet for this brand" (app.js:2062) is a real empty state with actionable next step text, but no button CTA (only the "+ add platform" select right below it happens to serve as the fix - decent, borderline compliant).
- **R5**: Account remove button uses a native `confirm()` dialog (app.js:2037) instead of any in-app banner/confirmation pattern; "manual" flag toggle failures use `alert()` (app.js:2021, 2044, 2094) - raw browser alerts, a hard violation of "no ad-hoc banner" since these aren't even the ad-hoc `.msg-banner`, they're worse (native browser chrome).
- **R8**: `.tabs button.active` (platform tabs) reuses the primary gold treatment identically to submit buttons - a selected tab and a "submit" CTA look the same, which is a state/priority collision R8 is meant to prevent.
- Multiple char-limit displays (`.char-count`, `.char-count.over`) - decent, color+text pairing already (R7 compliant there).

### Library (`renderLibrary`, app.js:1756)
- **R1**: Page title renders as "Media Library" (app.js, h1) while the nav item is labeled "Library" - inconsistent naming between nav and page title, a direct violation of the R1 contract that page title matches its own identity (users can't be sure they're on the right page from title alone).
- Upload row (`Choose File` + `Upload` button) is a native unstyled file input directly next to a styled gold button - glaring visual mismatch, no shared input treatment (R8).
- **R4**: No empty state code path was exercised (library has 2 files seeded) - worth verifying in Phase 1 that an empty library shows a real emptyState with a CTA rather than just a blank grid.
- Media cards showing "file" as the visible label for non-image files (the .txt file rendered as literal text "file", styles.css `.media-card .meta`) - acceptable minimal treatment, no icon differentiation between file types.

### Images (`renderImages`, app.js:4895)
- **R1**: Static instructional banner ("Codex drops generated variants into...") sits where a page-context action row would normally go - fine content-wise, but there's no actual action row (no "+ new request" button up top; requests are presumably created from Composer only) - worth confirming this is intentional in Phase 1.
- **R6**: Request cards list variants as plain text lines per platform (`linkedin: 1200x627...`) - text-only rows, no explicit end-of-list marker, though the list is short enough it's not ambiguous today.
- Status pills (`CANCELED`, `REQUESTED`) reuse the shared `.pill.status-*` system - compliant.
- "Cancel" button uses the `.danger` variant appropriately (destructive action, red-bordered) - good example of correct semantic button use to reuse elsewhere.

### Analytics (`renderAnalytics`, app.js:3241)
- **R1 (major)**: No page-level action row at all beyond a single "Campaign" filter dropdown - no date-range control, no export, no overflow. Filter sits leftmost (should be rightmost per R1). "Metrics due" queue cards are effectively a to-do list competing for top-of-page real estate with the actual analytics.
- **R6**: Metrics-due list items render as plain link-plus-text rows (`#7 - PrimeWright - linkedin  published Jul 15, 09:09 PM`, app.js area ~3260-3296) - no explicit end-of-list line, text-left/meta-right ordering isn't formalized (date currently trails inline, not right-aligned).
- Period toggle (7d/30d/90d/All-time) styled as a button group reusing `.primary`-like active state - same tab/button collision as Composer's platform tabs (R8).
- Per-brand stat rows (Posts/Impressions/Engagement/Follows/DMs/Leads) are numeric-only tiles in a row, not a table - but if/when this becomes a real sortable table it should follow R6 (numbers right-aligned, desc sort by default).
- **Empty state**: not exercised live (data present), but "No metrics yet" messaging exists elsewhere (Home) so likely mirrored here - verify in Phase 1.
- `redraft-btn` on top-10 rows is a tiny 20px pill-button, under the 24px icon-button floor (R8/R7 touch-target).

### Ops Stats (`renderOps`, app.js:3427)
- **R1**: No h1 action row - page is pure read-only stats, no filters/date-range at all (may be fine for this view, but should be a documented decision not an accident since every other data view has some filter).
- **R6 (bug, not just style)**: "Posts by status" bar chart x-axis labels visually overlap/collide at 1400px - confirmed live: "scheduled_lo\|cal" and "submitted_dr\|y" labels overlap the adjacent bar's label (see screenshot captured during audit). This reads as a real rendering bug, likely CSS label rotation/spacing missing for 8-category bar charts, not just a taste nit.
- Bar charts (`.ops-tile`, custom SVG/DOM bars) are three different in-house charts (posts-by-status, posts-by-brand, posts-by-platform) with no shared axis-label truncation, no explicit end-of-chart markers, and no empty-state fallback verified for brand-new installs (all-zero state not exercised).
- Ops tiles (`DRAFTS AWAITING`, `SCHEDULED THIS WEEK`, etc.) are visually solid and consistent with each other - a good reusable stat-tile pattern, worth promoting into the shared system rather than reworking.

### Research (`renderResearch`, app.js:4444)
- **R1**: Page-level "Brand:" selector at top, but the "Add note" form *also* has its own independent brand `<select>` defaulting to "(no brand)" - two brand pickers on one page that can disagree with each other, confusing and duplicative. Same duplication pattern likely exists in Inspiration (see below) - worth a single shared-brand-context fix in the sweep, not just cosmetic.
- **R4**: Empty state is the flattest text treatment in the app: "No research notes yet." - a single muted line, no icon, no CTA button (the Add Note form below serves as the de facto CTA, but it's not framed as one).
- **R3**: "Add note" form is single-column, labeled, with sentence-case labels (Brand/Source/Title/URL/Tags/Body) - already compliant with formSection() intent, good candidate to become the literal formSection() reference implementation.
- Two overlapping card patterns on one page ("Add note" manual form vs. "Paste / Import" bulk form below it) - both well-organized individually but not visually distinguished by priority/frequency of use.

### Inspiration (`renderInspiration`, app.js:4609)
- Same dual-brand-picker issue as Research (page-level "Brand:" + form-level "(no brand)" selector).
- **R4**: Empty state here is better than Research's: "No profiles yet - add one below, or ask AI to suggest some." - includes a next step hint. Still no button-style CTA, just prose.
- "Add profile" form (Brand/Platform/Name/Handle/URL/Niche/Why relevant/Tags) is single-column and labeled - same good formSection() candidate as Research.

### Settings (`renderSettings`, app.js:3547) - **worst offender (tied with Composer)**
- **L2 (major, confirmed unimplemented)**: Settings today is a flat, un-zoned stack of 8 `.settings-section` cards in this order: Personality → Global rules → Assistant authority → Default drafting model → Image prompt system → Per-brand (accounts/tones/queues/branding/UTM all inside one giant per-brand card) → Branding. There is no Workspace/Brands/Integrations zoning, no anchor links, and "Queues" + "Link tracking (UTM)" are nested deep inside the single "Per-brand" card (queuesCard at app.js:487 offset ≈ 4033, utmToggle at app.js:3915) rather than being their own discoverable sections - exactly the sprawl L2 exists to fix. Grepped: no "Integrations/Ops" zone exists at all today (Blotato key status / dry-run / worker state currently live on the separate Ops Stats + Calendar views, not in Settings, so L2's zone 3 doesn't even have a current home to reorganize).
- **R8**: Global-rules toggles use `settingsToggleRow()` (checkbox + redundant ON/OFF text pill) - the closest thing to a styled switch in the app, but still a native checkbox underneath, and it's the *only* view using this pattern (Composer's manual-toggle and resize-platform checkboxes look completely different, see inventory above).
- **R3**: "Personality" (Global voice textarea) and "Global rules" (checkboxes + banned-words input) are reasonably form-shaped already; "Per-brand" mega-card is the opposite - an unbounded stack of unrelated sub-forms (accounts, tone profiles, queue slots, branding colors, UTM) with no `formSection()` boundaries between them, making it the single densest, least scannable card in the whole app.
- Two separate "Save" actions studied: "Save voice" and "Save rules" both render immediately below their respective textareas - good proximity pattern, but no pending-state text on click (R5).

### Profiles (`renderProfiles`, app.js:4376)
- **R2**: Uses `.profile-cards` grid (`repeat(auto-fit, minmax(320px,1fr))`, styles.css:1145-1150) - another per-view ad-hoc width system, not one of the R2 tiers (though arguably fine since it's a card-grid, not a content-width concern).
- Per-platform-field rows are consistently laid out with a "Copy" button beside every field (`.profile-copy-btn`, 20px tall - under the 24px floor, see inventory) - repeated ~8x per card, so this one undersized button is the single most-repeated touch-target violation in the app by instance count.
- Each platform card footer has Generate / Save / "Mark reviewed" / "Mark stale" actions - four different verbs of different priority (create, persist, approve, deprecate) all rendered as same-weight buttons with only "Mark stale" getting `.danger` treatment; "Save" isn't visually distinguished as primary vs. "Generate"/"Mark reviewed" (R8: no priority differentiation).
- Status pill ("DRAFT") reuses the shared `.pill.status-*` system - compliant.

---

## Priority ranking

Ranked by (rule-violation count) × (how central the view is to daily operator use - Home/Composer/Calendar are used every session; Research/Inspiration/Images are occasional).

1. **Composer** - worst violation density (L3 major reorder, R2 ad-hoc grid, R3 dense unlabeled rows, R5 native `alert()`/`confirm()` instead of any banner, R8 tab/button collision) **and** the single most-used view in the app (every post goes through it). Highest-leverage fix in the whole pass.
2. **Settings** - L2 completely unimplemented (flat 8-card stack, UTM/Queues buried), R8's only toggle pattern lives here alone, R3 mega-card sprawl in "Per-brand." Used less often per-session than Composer but touched by every operator onboarding and every brand-config change, and it's explicitly called out in the spec (L2) as one of the two intended pilots.
3. **Calendar (month/week + modal)** - L4 toolbar order is backwards from spec, R7 color-only day-count dots, no toast on modal save, but the core grid/chip system is otherwise sound and heavily used daily.
4. **Home** - R1 hand-rolled header/quickbar, weak empty-state CTAs across 4 sections, but structurally the cleanest view today (good card patterns) and used constantly, so a quick primitive-application win once pageHeader()/emptyState() exist.
5. **Analytics** - R1 has no action row/date-range/export at all (biggest structural gap of any view), R6 list formatting loose, but used in bursts (metrics day) rather than continuously.
6. **Ops Stats** - real chart-label collision bug (not just polish) plus no filters, but pure read-only/occasional-glance view.
7. **Ideas Board** - flattest R4 gap (zero empty-state text in any kanban column) but low daily usage.
8. **Profiles / Research / Inspiration** - all three share the dual-brand-picker bug and undersized copy buttons; lowest usage frequency of the writing/setup views.
9. **Library / Images** - smallest, least-violated views; Library's title/nav-label mismatch is the one must-fix.

### Phase 1 recommendation
- **Agent A (primitives + 2 pilots)**: build `pageHeader()`, `formSection()`, `toast()`/`banner()`, `emptyState()`/`loadingState()`/`workingState()`, the 3-tier button/input system, and a real toggle/switch component. Apply to **Composer** (L3 reorder + R3/R5/R8 fixes) and **Settings** (L2 zoning + R8 toggle consolidation) - matches the spec's own call-out of these two as "the two worst offenders," confirmed by this audit.
- **Agent B (sweep, after A lands)**: apply the landed primitives in this order - **Calendar** (L4 toolbar reorder is the biggest single win), **Home** (quick primitive swap-in, low risk), **Analytics** (add the missing R1 action row + toast), **Ops Stats** (fix the chart-label collision bug alongside the primitive sweep), **Ideas Board** (add per-column empty states), **Research/Inspiration/Profiles** (fix the shared dual-brand-picker bug once, then sweep all three together since they're structurally similar), **Library/Images** last (smallest surface area, Library title fix is a one-line change).

## Non-findings worth preserving
Do not touch or "improve away" during the sweep - these already work and are referenced above as reuse candidates: the shared `.pill.status-*` system, the base `select/input/textarea` sizing (already one height), the Home attention-row color+icon pairing, `openPostModal`'s Esc-to-close handling, and the Ops stat-tile visual pattern.
