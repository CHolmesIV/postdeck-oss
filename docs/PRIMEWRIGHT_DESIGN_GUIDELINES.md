# PrimeWright Design Guidelines

Source: distilled from the PrimeWright design-research conversation and saved here so future PostDeck/PrimeWright work does not depend on chat history.

## Core Direction

PrimeWright should feel like a serious bid-operations command center, not a generic AI SaaS landing page.

The design should communicate:

- Federal bid operators can find, evaluate, price, and prepare opportunities faster.
- AI supports the workflow, but does not remove human control.
- Evidence, deadlines, risk, source documents, and approval gates matter more than visual novelty.
- Users should understand the next action without opening every detail page.

Avoid:

- Abstract AI hype visuals.
- Generic glowing gradients, robots, or "AI brain" imagery.
- False certainty in AI recommendations.
- Decorative animation that competes with task work.
- Low-contrast gray text or color-only status indicators.

## Foundation Standards

- Use an 8px spacing system.
- Keep marketing-page containers around 1120-1280px.
- Keep text-heavy sections around 720-840px.
- Use 44-48px practical tap targets for important controls.
- Meet WCAG 2.2 AA as the minimum accessibility standard.
- Use color, label, icon, and explanation together for statuses.
- Use `prefers-reduced-motion` and keep motion functional.

Recommended spacing tokens:

| Token | Size | Use |
|---|---:|---|
| `space-1` | 4px | Tiny icon/text gaps |
| `space-2` | 8px | Tight inner spacing |
| `space-3` | 12px | Label/input spacing |
| `space-4` | 16px | Default component padding |
| `space-5` | 20px | Compact card padding |
| `space-6` | 24px | Standard card/section gaps |
| `space-8` | 32px | Major layout gaps |
| `space-10` | 40px | Section subspacing |
| `space-12` | 48px | Mobile section padding |
| `space-16` | 64px | Desktop section padding |
| `space-20` | 80px | Big page breaks |
| `space-24` | 96px | Hero/major section rhythm |

## Typography

Recommended font direction:

- Primary recommendation: IBM Plex Sans.
- Acceptable alternatives: Inter, Source Sans 3, Roboto Flex, Manrope, DM Sans.
- Use one primary family across website and app where practical.
- Use 2-4 weights max: 400, 500, 600, 700.
- Use tabular numbers for dashboards, prices, award amounts, counts, and tables.

Avoid:

- Thin weights below 400.
- Decorative serif fonts.
- All-caps paragraphs.
- More than two font families.
- Poppins, Montserrat, or Raleway as dense body/UI fonts.

Type scale:

| Token | Desktop | Mobile | Use |
|---|---:|---:|---|
| Display | 64-72px | 40-44px | Homepage H1 only |
| H1 | 48-56px | 34-40px | Page titles |
| H2 | 36-44px | 28-34px | Major sections |
| H3 | 24-30px | 22-26px | Feature blocks |
| H4 | 18-20px | 18-20px | Cards/modules |
| Body large | 18-20px | 17-18px | Hero/subheads |
| Body | 16px | 16px | Default copy |
| Small | 14px | 14px | Metadata |
| Caption | 12-13px | 12-13px | Labels, tags |

## Color And Contrast

Use a restrained, high-trust palette:

- Background: near-white, slate, very light gray.
- Text: deep navy or charcoal.
- Primary: federal blue, deep indigo, or steel blue.
- Status accents: green for viable/success, amber for caution, red for risk.
- Surfaces: white/off-white cards.
- Borders: cool gray/slate.
- Optional app dark mode: navy/charcoal, not pure black.

Minimum contrast:

| Element | Minimum |
|---|---:|
| Normal text | 4.5:1 |
| Large text | 3:1 |
| UI controls, borders, states, icons | 3:1 |

Status design standard:

- Label: `Viable`, `Candidate`, `Risky`, `Skip`, etc.
- Icon: check, alert, block, review.
- Color: semantic but not the only signal.
- Explanation: one short reason near the badge.

Example:

`Risky` with an amber warning icon and supporting text: `Bonding requirement appears above your current threshold.`

## Website Standards

Homepage hero should answer within five seconds:

1. What is this?
2. Who is it for?
3. What outcome does it create?
4. What does the AI actually do?
5. Where does the human stay in control?

Recommended hero pattern:

- Eyebrow: `AI bid pipeline for federal contractors`
- H1: `Run your federal bid pipeline without living inside SAM.gov.`
- Subhead: `PrimeWright finds matching opportunities, reads the documents, scores the bid, checks award history, and prepares the next action. You decide what gets signed and submitted.`
- Primary CTA: `Start free`
- Secondary CTA: `See how it works`
- Trust line: `Human approval required before signing or submission.`

Hero visual standard:

- Use product UI or a credible product mockup.
- Show pipeline stages: `Pulled -> Analyzed -> Priced -> Ready for Review -> Human Gate`.
- Show proof details like document count, risk flag, award-history range, and human approval.
- Avoid abstract hero art unless it is secondary to real product UI.

Recommended homepage section order:

1. Hero: clear promise + UI preview.
2. Trust strip: SAM.gov, USAspending.gov, human approval, BYOK/security.
3. Problem: federal bid search is manual, scattered, and easy to miss.
4. Product loop: Pull -> Analyze -> Price -> Prepare -> Human Gate.
5. UI preview: pipeline board.
6. AI analysis card: verdict + reason + extracted requirements.
7. Price-to-win preview: award history, incumbent, competition.
8. Human control section: what PrimeWright will and will not do.
9. Security/trust section.
10. Pricing preview.
11. Final CTA.

## App UI Standards

The app should answer: `What needs my attention today?`

Core screens that need strong UX standards:

- Dashboard / command center.
- Opportunity pipeline board.
- Opportunity detail page.
- AI analysis result.
- Compliance matrix.
- Price-to-win / award history.
- Document viewer.
- Quote preparation.
- Human approval gate.
- Settings / NAICS / PSC lanes.
- BYOK / API key settings.
- Usage and cost dashboard.
- Team / roles / org settings.
- Audit log.

Dashboard modules should include:

- New opportunities pulled today.
- Bids requiring review.
- High-value viable bids.
- Risky bids needing decision.
- Upcoming deadlines.
- Cost/usage summary.
- Human approval queue.
- Recent AI analysis jobs.
- Errors or blocked items.

Pipeline card standard:

- Solicitation number.
- Agency.
- Due date.
- NAICS/PSC.
- Estimated value or award history.
- AI verdict.
- Risk flag.
- Next action.
- Document count.
- Last updated.

AI verdict card standard:

- Verdict: Viable / Candidate / Risky / Skip.
- Confidence level.
- Top 3 reasons.
- Disqualifiers.
- Missing data.
- Relevant extracted requirement.
- `Why this verdict?` expandable explanation.
- `Mark wrong` or `Adjust` feedback control.

Compliance matrix standard:

- Sticky header.
- Sticky first column if wide.
- Search/filter.
- Requirement category.
- Source document reference.
- Requirement text.
- Status.
- Owner.
- Due date.
- Evidence.
- Notes.
- Export.

Price-to-win standard:

- Award history range.
- Median award.
- Similar contracts.
- Incumbent if known.
- Competitor count.
- Confidence / data freshness.
- Source links.
- `Not enough comparable data` state.

Avoid false precision. A price estimate without uncertainty can create misplaced trust.

## Forms, Errors, And Empty States

Forms:

- Use labels above fields.
- Keep placeholders as examples only.
- Group related fields.
- Show required/optional clearly.
- Validate after input is complete, not before.
- Keep errors near the field.
- Preserve user input after errors.
- Use plain English.

Error message standard:

- Bad: `Invalid input.`
- Good: `Enter a valid UEI. It should be 12 characters.`

Empty states should:

- Explain why the view is empty.
- Provide the next action.
- Avoid blaming the user.
- Avoid fake optimism when data is missing.

## Motion Standards

Use motion only when it improves understanding.

Good motion:

- Button press feedback.
- Loading state.
- Pipeline item moving stages.
- Card expansion/collapse.
- Toast entrance/exit.
- Modal/sheet open/close.
- AI analysis progress.
- Skeleton loaders.

Avoid:

- Parallax hero motion.
- Auto-rotating carousels.
- Constant moving gradients.
- Long page-load animations.
- Decorative floating elements.
- Animated numbers that delay readability.
- Spinners with no progress or explanation.
- Motion after every scroll.

Timing:

| Motion | Duration |
|---|---:|
| Hover/press | 100-150ms |
| Tooltip/popover | 120-180ms |
| Card expand | 180-250ms |
| Modal/sheet | 200-300ms |
| Page transition | 200-350ms |

## Performance And Polish

Design-related performance rules:

- Optimize hero images/mockups.
- Avoid large video backgrounds.
- Use SVG icons.
- Lazy-load below-fold images.
- Reserve image dimensions to avoid layout shift.
- Keep animations lightweight.
- Avoid loading many font weights.
- Test mobile first.

Targets:

- LCP under 2.5s.
- INP under 200ms.
- CLS under 0.1.

## Build Acceptance Checklist

Use this checklist before calling a PrimeWright design pass done:

- H1 says what PrimeWright does in plain language.
- Above-the-fold visual shows product workflow or credible product state.
- Human approval is visible before any submission/signing implication.
- Statuses use label + color + icon + explanation.
- AI verdicts show reason, uncertainty, source, and correction affordance.
- Deadlines and next actions are visible on cards.
- Tables are scan-friendly, filterable, and not over-styled.
- Contrast passes WCAG 2.2 AA.
- Important tap targets are 44-48px.
- Motion is functional and respects reduced-motion.
- Forms have labels, useful errors, and preserved input.
- Security, BYOK, auditability, and human control are not buried.
- No em-dashes in public copy or UI copy.
- No fake customer logos, fake government data, or fake certainty.
