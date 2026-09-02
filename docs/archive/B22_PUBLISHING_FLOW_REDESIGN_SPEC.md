# B22 - Publishing flow redesign

_Spec written 2026-08-12 after CB used a real PrimeWright image post. Status: SHIPPED 2026-08-12._

## Shipped result

- Calendar and agenda posts now open in a right-side review drawer instead of the small action
  popover.
- The drawer keeps platform preview, editable copy, link placement, delivery choice, scheduling,
  and the final action together.
- Delivery is expressed as `Keep draft`, `Schedule`, `Add to queue`, or `Post now`. Only the
  selected action receives the primary button.
- Scheduling has one-click presets for later today, tomorrow at 9 AM, and Friday at noon, plus
  the existing date/time input.
- PrimeWright link placement is visible during review, with a safe `Move link higher` action that
  moves the existing URL below the hook without rewriting the post.
- Quick Compose uses the same delivery language and shows only the action that matches the chosen
  delivery mode.
- Full Composer now says `Schedule post` instead of `Save & approve` and requires a publish time;
  its other final action remains `Save draft`.
- Account selection is a scan-friendly card grid with connected/manual state, selected checks,
  `Select all`, and `Clear`.
- Early handoff is renamed `Send schedule to Blotato early` and lives under Advanced actions.
- Any local post can be reconciled with `Mark as posted manually` and a live URL without calling
  Blotato. The action confirms that the post already exists and records a `manual_publish` usage
  event for the audit trail.

Browser QA used a separate temporary database with `POSTDECK_WORKER=0`,
`POSTDECK_SYNC_ENABLED=0`, and `BLOTATO_DRY_RUN=1`. No production posts were changed or sent.

## The complaint

CB manually published the post because the local app did not make the ordinary action feel
ordinary:

- There was no obvious one-click way to publish an existing draft immediately.
- Clicking the calendar item led toward a full-page view instead of a compact review-and-send
  workflow.
- Changing the scheduled time required opening controls manually and using a raw date/time field.
- There was no quick dropdown for common choices such as now, later today, tomorrow, or a
  recommended time.
- The difference between `Post now`, `Approve`, and `Send to Blotato now` was not clear from the
  user's point of view.

The workflow was technically possible. It was not smooth.

## What the current code actually does

The app already has `POST /api/posts/:id/publish-now`, and Quick Compose plus the full Composer
have a `Post now` button. That does not solve the experienced workflow:

1. An existing draft opened from the Calendar gets a compact popover with `Approve`,
   `Reschedule`, and `See more`.
2. That popover does not offer `Post now` for a draft.
3. The detail page offers `Approve`, but `Submit now` only appears after the post is approved.
4. `Send to Blotato now` means "hand off now but publish at the existing scheduled time," which
   sounds too similar to `Post now` even though the result is different.
5. Rescheduling uses an expanding raw `datetime-local` input. It has no fast presets and gives
   little scheduling context.

This is an interaction-architecture problem, not primarily a color, spacing, or button-size
problem. The earlier Sprout-inspired consistency pass improved components, but it did not make
the delivery decision simple enough.

## Product principle

The interface should ask what CB wants to happen, not ask CB to manage PostDeck's internal state
machine.

Every review surface should present the same four delivery choices:

1. **Post now** - publish immediately after one irreversible-action confirmation.
2. **Schedule** - choose a specific date and time, then approve it for delivery.
3. **Add to queue** - use the next configured open slot.
4. **Keep as draft** - save for review; a date may place it on the planning calendar, but a draft
   never publishes.

Internal transitions such as `draft -> scheduled_local -> submitted` remain implementation
details. They should be visible as status, not required knowledge.

## Reference patterns

This direction follows the useful parts of the public Sprout Social and Hootsuite publishing
flows without copying their visual identity:

- Sprout centralizes draft, manual schedule, queue, and publish choices in one publishing
  workspace.
- Sprout treats a dated draft as calendar planning, not permission to publish.
- Sprout exposes recommended send times in Compose.
- Hootsuite emphasizes a unified calendar, direct composer access, and drag-and-drop schedule
  changes.
- Both reduce tab-hopping by keeping creation, timing, and delivery decisions close together.

Sources reviewed 2026-08-12:

- https://support.sproutsocial.com/hc/en-us/articles/360000576466-Introduction-to-Publishing
- https://support.sproutsocial.com/hc/en-us/articles/360000575103-Drafts
- https://seeds.sproutsocial.com/patterns/
- https://www.hootsuite.com/platform/publishing

## Proposed experience

### 1. Replace the existing calendar popover with a review drawer

Clicking a calendar card opens a right-side drawer without leaving the Calendar. The drawer
contains:

- Real platform preview and all attached images in order.
- Editable caption.
- Account and status.
- Delivery control.
- Primary action area.
- Secondary actions such as duplicate and delete.

No `See more` should be required for normal review, schedule, or send work. The full detail page
can remain for metrics, history, and uncommon settings.

### 2. Use one delivery control

Label: **When should this publish?**

Options:

- `Now`
- `Later today`
- `Tomorrow`
- `Next queue slot`
- `Best time`
- `Choose date & time`

Selecting `Choose date & time` opens an actual calendar plus a separate time dropdown. Show the
active timezone beside the control. Do not make a raw browser `datetime-local` field the primary
experience.

Suggested quick times should be large click targets:

- 9:00 AM
- 12:00 PM
- 3:00 PM
- 6:00 PM

The exact recommendations can come from brand/account best-time settings later. The first pass
can use existing configured defaults.

### 3. Use one clear primary action

The button label changes with delivery intent:

| Delivery choice | Primary button |
|---|---|
| Now | `Post now` |
| Specific time | `Schedule post` |
| Queue | `Add to queue` |
| Draft | `Save draft` |

Do not show `Approve`, `Submit now`, and `Send to Blotato now` as competing user-facing actions.
Approval should be part of `Schedule post`; immediate handoff should be part of `Post now`.

The irreversible confirmation for `Post now` must name the account and say that Blotato cannot
delete the resulting post.

### 4. Clarify handoff language

If the existing early-handoff control remains available for travel/offline use, rename it:

`Send schedule to Blotato early`

Helper text:

`Blotato receives it now and publishes it at the scheduled time.`

This control belongs under an overflow or advanced menu. It is not a primary publishing action.

### 5. Make calendar editing direct

- Dragging a card to another day continues to preserve its time.
- Clicking the displayed time opens the same time dropdown inline.
- A card overflow menu offers `Post now`, `Move`, `Duplicate`, and `Delete` without a page change.
- After any action, the card updates in place and shows a plain-language confirmation.

### 6. Protect the review-first workflow

- A dated draft stays a draft and never hands off automatically.
- `Schedule post` is the explicit approval boundary.
- Codex-created content enters as a draft, even when it has a proposed date.
- Only CB's explicit `Post now`, `Schedule post`, or early-handoff action can create external
  state.

### 7. Reconcile a post published outside PostDeck

CB sometimes opens LinkedIn and publishes manually even though the account is connected to
Blotato. The current `Mark posted` flow is limited to assisted-manual accounts, so PostDeck can
be left holding a duplicate draft after the real post is already live.

Add `Mark as posted manually` to the overflow menu for any local `draft`, `approved`, or
`scheduled_local` post. It should:

- Require confirmation that the post already exists on the social platform.
- Accept the live post URL when available.
- Move the local record to `published` without calling Blotato.
- Record that the publication source was manual in status history or a usage event.
- Never infer manual publication merely because a scheduled time passed.

## Recommended implementation order

### B22.1 - Existing-draft quick actions

- Add `Post now` to the calendar drawer/popover for eligible drafts.
- Add schedule presets and a timezone label.
- Rename early handoff to `Send schedule to Blotato early`.
- Keep the current endpoints and status model.

### B22.2 - Review drawer

- Replace the small calendar popover with the right-side review drawer.
- Edit caption, media order, and delivery choice without leaving Calendar.
- Make the primary action dynamic.

### B22.3 - Composer convergence

- Reuse the same delivery control and action language in Quick Compose and full Composer.
- Remove duplicate scheduling concepts and competing button labels.
- Keep advanced metadata available but visually secondary.

### B22.4 - Manual publication reconciliation

- Generalize `Mark posted` beyond assisted-manual accounts.
- Expose it from the review drawer and post overflow menu.
- Preserve the public URL and manual-source audit trail.

## Acceptance criteria

- From a dated LinkedIn draft on Calendar, CB can publish now in two clicks: `Post now`, then the
  irreversible confirmation.
- From the same draft, CB can change it to tomorrow at noon in no more than three clicks.
- Neither action opens the full detail page.
- Drafts never publish merely because they have a date.
- `Post now` always means immediate publication.
- Early Blotato handoff is clearly labeled as different from immediate publication.
- The same delivery terms appear in Calendar, Quick Compose, full Composer, and post detail.
- Media and caption remain visible while choosing timing.
- A post published directly on LinkedIn can be marked posted in PostDeck without calling
  Blotato or leaving a duplicate draft behind.

## Deferred after this pass

- Direct Blotato analytics sync. Blotato now displays analytics in its web app, but its documented
  public API did not expose engagement metrics when checked on 2026-08-12. PostDeck retains its
  LinkedIn/Meta CSV import until Blotato publishes an analytics endpoint or export contract.
- Reworking brand colors or logo treatment.
- Replacing the database status model.
- Adding team approval roles.
- Copying Sprout or Hootsuite branding.
