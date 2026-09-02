# B20 - Bulk approve + draft-first detail page

_Spec written 2026-08-02. Driven by CB feedback while approving the first full week of
CHolmesIV drafts (6 posts, Aug 3-7). Status: SPEC → BUILD._

---

## The complaint, verbatim

> "now that I'm trying to click multiple things that are drafted, the app doesn't let me
> select multiple at a time, so I have to go into each one, which is kind of funky. And then
> also, when I open the full page, when it asks for the analytics and those three things,
> that's a lot to scroll through. It should be more intuitive that I can click it and submit
> it from draft."

This is the first time the app has been used to approve a **whole week at once**. Every
prior session approved posts one or two at a time, which is why none of this surfaced.

## Diagnosis (verified in code, not assumed)

| # | Finding | Evidence |
|---|---|---|
| P1 | **No multi-select exists anywhere in the app.** Zero checkboxes on any post list. | `public/app.js` - the only `input type=checkbox` is in an unrelated settings row |
| P2 | **The calendar/agenda popover cannot approve a draft.** Its actions are Save, Reschedule, Move to drafts, Delete, Cancel post, Duplicate, Copy to brand, See more. | `openPostPopover`, app.js ~2254-2440 |
| P3 | **The detail page renders Metrics + Status history above Edit, on posts that have never published.** Order is: card → actions → Metrics (8 number inputs) → Status history → Edit. | `renderPostDetail`, app.js ~3592-3860 |

`POST /api/posts/submit-batch` already exists but only accepts posts that are **already**
`approved`/`scheduled_local`. There is no bulk path from `draft`.

## Non-goals

- No new "select mode" toggle. Checkboxes are always present on agenda rows.
- Not touching Review mode (`#/review`). It already does one-at-a-time keyboard approval
  (A/S/E) correctly and stays the right tool for reading each post closely.
- No bulk edit of copy. Bulk actions are approve / reschedule / trash only.
- No change to the approve *semantics*. Bulk approve must be exactly N single approves.

---

## P2 - Approve in the popover

Add an **Approve** button to `openPostPopover`, shown only when `post.status === 'draft'`,
placed first in the actions row (before Reschedule).

Must reuse the detail page's approve behavior, including the **soft quiet-hours confirm**
(`GET /api/settings/quiet-hours-check`) which warns and asks, never blocks. Factored into a
shared `approvePostWithQuietHoursCheck(post)` helper so the popover, the detail page, and the
bulk bar cannot drift apart.

## P3 - Detail page ordering

Introduce `hasEverPublished(post)` = status is one of `submitted`, `published`,
`failed_verify` (a `failed_verify` post may well be live, so its metrics stay reachable).

When `hasEverPublished(post)` is false:
- **Metrics section is not rendered at all.** Entering impressions for a post that does not
  exist yet is meaningless. It returns automatically once the post publishes.
- **Status history collapses** behind a `<details>` summary.

Always:
- **Edit moves directly under the status actions**, above Metrics and Status history.

Order becomes: card → manual panel → actions → **Edit** → [Metrics if published] →
Status history (collapsed when unpublished).

## P1 - Multi-select + bulk action bar

### Backend: `POST /api/posts/approve-batch`

```
body: { post_ids: number[] }            // non-empty, else 400 invalid_body
→ { approved: [{id, status}], skipped: [{id, reason, message?}], dry_run }
```

Per-post, in one transaction-free loop (each post independent, a failure never blocks the
rest):

| Condition | reason |
|---|---|
| id not found | `not_found` |
| status is not `draft` | `wrong_status` |
| TikTok missing required `platform_fields` | `tiktok_fields_missing` |

An approved post lands on `approved`, or **`scheduled_local` when it already has a
`publish_at`** - identical to the single PATCH path.

**Shared-logic requirement.** The single-post PATCH approve gate does three things beyond a
status write: promotes to `scheduled_local`, validates TikTok fields, and **appends per-brand
UTM to `copy` and `first_comment`**. Bulk approve must do all three. To prevent drift, the
UTM block is extracted from the PATCH handler into `applyApproveUtm(db, existing, fields)` in
`src/utm.js`, and both call sites use it. The extraction must be behavior-preserving: the
existing `utm.test.js` suite has to pass untouched.

Quiet hours is deliberately **not** enforced server-side here, matching the single-post path
where it is a client-side soft confirm.

### Frontend: agenda rows

`agendaRow` currently returns a `<button>`. A checkbox cannot be nested inside a button, so
each row becomes:

```
div.agenda-row-wrap > [ input.agenda-check , button.agenda-row ]
```

The button keeps its existing popover click behavior untouched.

- Checkbox only rendered when the post is **actionable** (`draft`, `approved`,
  `scheduled_local`). Published/submitted rows get a spacer so rows stay aligned.
- Each day group and the unscheduled group get a **select-all** checkbox in its title row,
  reflecting indeterminate state.
- Selection lives in a `Set` scoped to the agenda render, cleared on reload.

### Frontend: the bulk bar

A sticky bar appears at the bottom of the agenda only when selection is non-empty:

> **N selected** · [Approve N] [Reschedule N…] [Trash N] · [Clear]

- **Approve N** - confirms, calls `approve-batch`, toasts
  `"Approved 5. Skipped 1 (wrong status)."`, reloads. Runs the quiet-hours check once against
  the earliest selected `publish_at` rather than N times.
- **Reschedule N…** - reveals one `datetime-local`; applies the **same** timestamp to all
  selected via existing per-post PATCH. Honest about what it does: this is "put these all at
  one time", not a spread. Bulk-spread is a parking-lot item.
- **Trash N** - hard delete via existing `DELETE /api/posts/:id`, only legal for
  `draft`/`canceled`; anything else comes back as skipped. Double-confirmed.

## Tests

New `test/bulk-approve.test.js`:
1. approve-batch on 3 drafts → all 3 approved
2. a draft with `publish_at` → `scheduled_local`; without → `approved`
3. mixed batch → published/submitted ids come back in `skipped` with `wrong_status`, drafts still approve
4. TikTok draft missing fields → `skipped` with `tiktok_fields_missing`, never approved
5. empty / missing `post_ids` → 400
6. unknown id → `not_found` in skipped, siblings unaffected
7. UTM-enabled brand → bulk approve appends UTM to copy, same as single PATCH

Plus: existing `utm.test.js` and `server.approve-gate.test.js` must pass unchanged (proves the
extraction was behavior-preserving).

## Acceptance

- [ ] Draft on the calendar or agenda can be approved without opening the full page
- [ ] A draft's detail page shows no Metrics section, and Edit is above the fold
- [ ] Six drafts can be selected and approved in one action
- [ ] Bulk approve produces byte-identical post rows to six single approves
- [ ] Suite green, no pre-existing test modified except for genuine behavior changes
