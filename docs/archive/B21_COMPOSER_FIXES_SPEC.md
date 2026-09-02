# B21 - Draft variations, honest char counts, Post now

_Spec written 2026-08-10. Driven by CB using the composer to write a real post. Status:
SPEC → BUILT. Follows `B20_BULK_APPROVE_SPEC.md` (2026-08-02)._

---

## The complaint, verbatim

> "when I wanted to add my text to add the draft AI, I couldn't press it a couple times to
> add variations, and it kept saying the text is too long, which isn't true for LinkedIn.
> Also, when I press to just schedule the right away, there's no button to press just to post
> instantly. It has to do a couple things or add timing."

Three separate defects. All three confirmed in code, all three localized to **Quick Compose**
(the `+` modal) except P3, which is missing everywhere.

---

## P1 - "Draft with AI" destroys the idea it was given

Quick Compose's handler:

```js
const ideaText = copyArea.value.trim() || 'Write an engaging post';
...
copyArea.value = draft;              // <- output overwrites the input
```

The idea and the draft share **one** textarea. So:

1. Press once: your idea becomes a draft. **The idea is gone.**
2. Press twice: the *draft* is now the input. You get a rewrite of the rewrite, drifting
   further from what you meant with each press, and the previous draft is destroyed.

There is no history, no undo, and no way to ask for a second take on the original thought.
That is exactly the "couple times to add variations" that did not work.

**Note:** the FULL composer does not have the input-destruction half of this bug - it reads
`draftsByPlatform.default` as the seed and writes only platform keys, so the seed survives.
It still has no variant history. Fixing Quick Compose is the priority; the full composer gets
the variant strip too since the mechanism is shared.

### Fix

- **Split the seed from the output.** Quick Compose grows a small, persistent "Your idea"
  field above the copy box. `Draft with AI` always reads the seed, never the output.
- On first press, if the seed is empty, whatever is in the copy box is **moved** into the seed
  (so the existing muscle memory of typing into the big box still works).
- **Variant strip.** Every draft is pushed onto a per-render list and rendered as
  `v1 v2 v3 …` chips under the copy box. Clicking one swaps it into the copy box. The active
  variant is highlighted. Re-pressing `Draft with AI` always adds a variant, never replaces
  one.
- Hand-edits to the copy box update the active variant in place, so switching away and back
  does not silently lose typing.
- Variants are **render-scoped only**. Not persisted, not a DB migration. Closing the modal
  drops them, which is correct: an unsaved variant is not an asset.

## P2 - The character limit shown is the wrong platform's

```js
function mostRestrictiveLimit() {
  const limits = selectedPlatforms().map((p) => textLimitFor(p)).filter((n) => n != null);
  return limits.length ? Math.min(...limits) : null;   // <- X's 280 beats LinkedIn's 3000
}
```

Platform maxima: X **280**, Instagram 2200, LinkedIn **3000**, TikTok 4000, Facebook 63206.
With X selected next to LinkedIn, a normal 1,100-character LinkedIn post reads as wildly over
limit. LinkedIn's own spec value is correct at 3000; the number on screen was X's.

Confirmed harmless-but-misleading: the counter only toggles a CSS class. **No code anywhere
blocks save or approve on length.** It was lying, not blocking.

### Fix

One blended number cannot be honest when one box feeds several platforms, so stop blending.

- Render **one count chip per selected platform**: `LinkedIn 1132/3000`, `X 1132/280`.
- Only the platforms actually over their limit turn red, and they say which platform they are.
- Zero or one platform selected keeps the current single-count look.
- The full composer already gets this right (`refreshCopyHeader` uses the current tab's own
  platform limit) and is not touched.

## P3 - There is no way to post immediately

The composer offers `Save draft` and `Save & approve`. Neither publishes.
`canSendToBlotatoNow` requires status `approved`/`scheduled_local` **and** a `publish_at`.

So posting something right now is: invent a time you do not want → approve → open the post →
`Send to Blotato now`. Four steps for the simplest possible intent.

### Fix - `POST /api/posts/:id/publish-now`

One server-side action, because the client must not be trusted to sequence three calls and
leave a post half-approved when one fails.

```
→ { ok, post, dry_run, submitted }
```

Order of operations, refusing early rather than half-applying:

| Check | Result |
|---|---|
| post not found | 404 `not_found` |
| status not draft/approved/scheduled_local | 409 `wrong_status` |
| assisted-manual account or platform | 409 `assisted_manual`, pointing at Mark posted |
| TikTok missing required fields | 422 `tiktok_fields_missing` |

Then, in order: set `publish_at = now`, promote to `scheduled_local`, run the shared
`applyApproveUtm()` pass **only when crossing in from draft** (so a re-publish never
double-tags), then delegate to the existing `submitNow()`. Dry-run is honored by `submitNow`
untouched - in dry run nothing real is posted and the response says so.

### Fix - the button

`Post now` in Quick Compose and in the full composer's sticky action bar. It saves the post
first (so the copy on screen is what goes out), then calls `publish-now`.

**It must be confirmed, and the confirm must name the accounts and be explicit that this is
live and irreversible.** Blotato cannot delete. In dry-run mode the confirm says so instead,
so nobody learns to click through a real warning out of habit.

Styling: `destructive`, not `primary`. It is the one irreversible control in the composer and
should not sit next to Save draft looking like a peer.

## Tests

New `test/publish-now.test.js`:
1. a draft with no `publish_at` → publishes, ends `submitted`/`submitted_dry`, `publish_at` set
2. an assisted-manual account → 409, post untouched, never submitted
3. a published post → 409 `wrong_status`
4. a TikTok draft missing fields → 422, still a draft
5. unknown id → 404
6. UTM-enabled brand → copy tagged exactly once, and a second publish-now does not double-tag

Pure-function tests for the P2 count helper in the same file or `test/platform-specs.test.js`.

## Acceptance

- [ ] Pressing `Draft with AI` three times yields three variants, all reachable, seed intact
- [ ] A 1,100-character LinkedIn post with X also selected does not claim LinkedIn is over
- [ ] One button takes a draft to live, behind one confirm that names the accounts
- [ ] Suite green
