# Fix Wave — Notification Dismiss + Image Review

_Captured 2026-07-22 from CB's airport punch-list. P1 shipped 2026-08-12. P2 remains a spec and
must not be built until approved._

Two problems from hands-on use. Both are UX/pipeline gaps, not regressions in shipped code.

---

## P1 — "Needs Attention" notifications can't be dismissed

**Status: shipped 2026-08-12.** Implemented with browser-local persistence for this
single-operator app, exact-state re-arming, per-row close controls, and Dismiss all.

### What CB sees
The Home "Needs Attention" panel shows condition rows (failed post, drafts to review, N
posts need metrics). There's no close/exit icon on any of them, so once something fires it
sits there permanently with no way to clear it.

### Root cause
- `attentionRow(label, href, kind)` (`public/app.js:1220`) renders an anchor = dot + label
  only. No dismiss affordance.
- `buildAttentionSection` (`public/app.js:1220`–~1310) **derives the rows from live state on
  every render**. So a naive "remove the DOM node" dismiss is useless — the row is
  recomputed and reappears on the next paint/route change.
- The existing `toast` primitive (`public/app.js:637`) auto-dismisses; it is explicitly NOT
  for these persistent/anchored conditions. So there's no reuse here.

### Proposed fix
1. Add a per-row **dismiss (×)** control to `attentionRow`, right-aligned, ghost-icon
   styling (matches D2 button system). Clicking it does NOT navigate (stop propagation on
   the anchor).
2. Persist dismissals so they survive re-render. Each attention condition already has a
   stable identity — give each a **dismiss key** (e.g. `failed:<post_id>`,
   `metrics-due:<hash-of-ids>`, `review-drafts:<count-bucket>`). Store dismissed keys in a
   small settings row (server: `dismissed_attention` JSON) or `localStorage` under
   `pd_attention_dismissed`. Prefer the settings row so it's consistent across the two
   surfaces CB uses, but localStorage is acceptable for v1 since this is single-operator.
3. `buildAttentionSection` filters out any condition whose current dismiss key is in the
   dismissed set before rendering.
4. **Re-arm on change:** the dismiss key must encode the underlying data so a *new*
   occurrence re-fires. Examples: a new failed post = new `post_id` = new key = shows again;
   metrics-due count changing from 12→14 changes the hash = shows again. Dismissing is
   "I've seen this exact state," not "mute this category forever."
5. Add a "Dismiss all" affordance on the panel header.

### Acceptance
- Each attention row has a working × that removes only that row.
- Dismissed row stays gone across route changes, reloads, and app restart.
- A genuinely new condition (new failure, changed count) reappears despite a prior dismiss.
- Dismiss never triggers the row's navigation.

### Scope guard
Do not turn this into a notification center. No history, no read/unread, no badges. Just
dismiss + re-arm.

---

## P2 — Codex-generated images are not reviewable anywhere

### What CB sees
Generated images in Codex's CLI, brought them over to the app, and now can't see them —
not in Composer, not in Images/Library. No way to review them.

### Root cause — the handoff contract is strict and there's only one hidden review surface
The pipeline (`docs/CODEX_IMAGE_HANDOFF.md`) only works one way:

1. PostDeck writes `image-requests/req-<id>.json`.
2. Codex must write generated files **plus a `manifest.json`** into
   `image-requests/generated/req-<id>/`.
3. Worker's `importGeneratedImages` (`src/imagestudio.js:49`) scans for that `manifest.json`,
   moves files into `media/`, flips the `image_requests` row to `status='generated'` with
   `variants[]`, and archives the subdir.
4. The **only** place variants surface for review is the "Waiting on Codex" placeholder tile
   **inside the specific post's Composer** (`public/app.js:~4465`–4620). It shows variants
   only when `pendingImageRequest.status === 'generated'`.

Failure modes that all produce "I can't see any images":
- **No manifest / wrong shape** → `importGeneratedImages` skips the subdir (it keys on
  `manifest.json`). Files just sit in `generated/` forever. **Most likely what happened** —
  "pasted the images in" ≠ wrote a manifest.
- **Wrong folder** → files dropped in `media/` directly, or anywhere other than
  `generated/req-<id>/`, are never associated with a request and never appear as variants.
- **No global surface** → even a *correct* import is only visible by reopening the exact
  post that made the request. There's no gallery of generated/pending image requests.
- (In my viewing instance the worker was off, so import never ran — not CB's real cause, but
  confirms: no worker cycle = no import.)

### Proposed fix — make review possible without a perfect handoff
Three layers, smallest-first; P2a is the real unblock.

**P2a — Global Image Requests review surface (the fix).**
Add a review view (extend the existing **Images** tab, `renderImages`) that lists every
`image_requests` row grouped by status: `pending` (awaiting Codex), `generated` (variants
ready to pick), `picked`, `canceled`. For `generated`, show the variant thumbnails with the
same pick action the composer uses (`POST /api/image-requests/:id/pick`). This means CB can
review/pick from one place instead of hunting through composers. Wire it to
`GET /api/image-requests` (already exists, `src/server.js:1437`).

**P2b — "Loose images" adopter (rescue path).**
For files already dropped into `generated/` (or a new `generated/inbox/`) **without** a
manifest: add a small importer that lists un-manifested image files and lets CB attach them
to an existing pending request (or a new standalone media item). Either:
- a "Attach files" button on a pending request in the P2a view that vacuums matching loose
  files, OR
- teach `importGeneratedImages` to synthesize a manifest when it finds a
  `generated/req-<id>/` dir with images but no `manifest.json` (log it, treat every image as
  a variant, best-effort dims). Lower-effort, catches the common case automatically.

**P2c — Direct upload to a request (no Codex at all).**
Add `POST /api/image-requests/:id/upload` (multipart, mirrors the existing `POST /api/media`
pattern at `src/server.js:994`) so CB can drag an image straight onto a request and have it
become a `generated` variant. Covers "I made it myself / grabbed it from somewhere" without
touching the Codex flow. Best long-term ergonomics.

### Acceptance
- One view lists all image requests by status with thumbnails; picking a variant there
  attaches it to the post exactly as the composer does.
- Images Codex produced (with a manifest) appear there within one worker cycle.
- At least one rescue path exists for images already dropped without a manifest (P2b) — CB
  is never stuck with invisible files on disk.
- (If P2c built) CB can upload an image directly to a request and pick it.

### Scope guard
Don't redesign the handoff contract or the Codex doc. The manifest path stays the primary,
worker-driven route; these additions are review visibility + rescue/manual paths around it.

---

## Remaining build order (when P2 is approved)
1. P2a (global review surface) — biggest unblock, pure read + reuse of existing pick route.
2. P2b (loose-file rescue) — auto-manifest in `importGeneratedImages` is the cheap win.
3. P2c (direct upload) — only if CB wants Codex-free image attach.

Delegate P2a/P1/P2b/P2c as parallel Sonnet build tasks; keep the manifest/worker changes
(P2b) reviewed on the strong model since they touch the live import path.
