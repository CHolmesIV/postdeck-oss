# Codex Image Handoff - the contract

*Companion to SPEC.md "B8 - Content Studio", feature 4 (Image workflow). This is the
protocol a Codex session follows to turn a PostDeck image request into files PostDeck can
pick up automatically. PostDeck never generates images itself - this handoff is the only
bridge.*

## The flow, in one line

CB clicks "Request image" in PostDeck → PostDeck writes `image-requests/req-<id>.json` →
**you (Codex) read it, generate images, write `manifest.json`** → PostDeck's worker
(`importGeneratedImages` in `src/imagestudio.js`, runs every cycle) picks the files up,
moves them into `media/`, and marks the request `generated` so CB can pick a variant in the
dashboard.

## 1. What you read: `image-requests/req-<id>.json`

Written by `src/imagespec.js` when CB submits the request. Shape:

```json
{
  "request_id": 42,
  "created_at": "2026-07-14T18:30:00.000Z",
  "brand": 2,
  "platforms": ["instagram", "facebook"],
  "content_type": "static",
  "brief": {
    "platforms": [
      {
        "platform": "instagram",
        "dims": { "w": 1080, "h": 1350, "aspect": "4:5", "raw": "1080x1350 (best real estate)" },
        "format": "png",
        "max_mb": null,
        "aspect": "4:5",
        "safe_notes": "Reels = non-follower reach; carousels = saves/comments... Keep key subjects/text inside the middle ~80% of the frame (safe zone)..."
      },
      {
        "platform": "facebook",
        "dims": { "w": 1080, "h": 1350, "aspect": "4:5", "raw": "1080x1350 (4:5) preferred, 1080x1080 ok" },
        "format": "png",
        "max_mb": 30,
        "aspect": "4:5",
        "safe_notes": "All FB video shares as Reels since mid-2025... Keep key subjects/text inside the middle ~80% of the frame (safe zone)..."
      }
    ],
    "recommended_format": "png",
    "quality_notes": [
      "Text-heavy content_type - export lossless PNG to keep text/edges crisp (no JPEG compression artifacts on typography).",
      "Generate 2-3 variants per request so CB has a real choice at pick time."
    ],
    "prompt_settings": {
      "system": "Reusable production direction from Settings...",
      "negative": "Reusable things to avoid from Settings...",
      "brand": "Reusable brand-expression rules from Settings...",
      "layout": "Reusable composition and readability rules from Settings..."
    },
    "content_type": "static",
    "copy_context": "The actual post copy - read this for what the image needs to say/show.",
    "brand": 2
  },
  "instructions": "Generate 2-3 image variants at the exact dims/format specified per platform in `brief.platforms[]`. Respect `max_mb` and `safe_notes`. Drop the output files plus a manifest.json into image-requests/generated/req-42/ - see docs/CODEX_IMAGE_HANDOFF.md for the exact manifest.json shape PostDeck expects back.",
  "output_dir": "image-requests/generated/req-42/"
}
```

Key fields:

- `brief.platforms[].dims` - the exact pixel target. `{w, h}` is authoritative when
  present; `aspect` is the ratio; `raw` is the original platform-specs.json string in case
  you want the full context (e.g. "1080x1350 (4:5) preferred, 1080x1080 ok" - the first
  number pair is the one already extracted into `w`/`h`).
- `brief.platforms[].format` - `png` (text-heavy: static/text/carousel content_type) or
  `jpg` (photo/video-led). Follow it unless a platform's `formats` list disagrees - dims
  win over format when in doubt.
- `brief.platforms[].max_mb` - hard ceiling if present; keep well under it.
- `brief.platforms[].safe_notes` - platform-specific notes (crop/caption chrome, best
  practices) plus a standing safe-zone reminder. Read it; it can include a flag like "no
  image spec found... using default" if `platform-specs.json` didn't have an entry - treat
  that platform's dims as a rough placeholder and use judgment.
- `brief.copy_context` - the post copy. The image should support this copy, not repeat it
  verbatim as a caption unless the content_type calls for on-image text (static/carousel).
- `brief.prompt_settings` - CB-editable reusable prompt guidance from Settings. Treat these
  as the standing production rules for image generation. `system` describes the job,
  `negative` lists things to avoid, `brand` describes brand expression, and `layout`
  describes composition/readability expectations.
- `output_dir` - where your output goes. Always `image-requests/generated/req-<id>/`
  relative to the PostDeck repo root.

## 2. What you produce

Create the directory named in `output_dir` (`image-requests/generated/req-<id>/`) and put
in it:

1. **The image files** - one per variant, any filename you choose (no spaces recommended;
   they get renamed on import anyway). Generate 2-3 variants total across the requested
   platforms/dims, per `quality_notes`.
2. **`manifest.json`** - the exact shape PostDeck expects back:

```json
{
  "request_id": 42,
  "variants": [
    { "file": "variant-a-instagram.png", "platform": "instagram", "dims": "1080x1350", "notes": "Portrait crop, logo top-left, headline in bottom third." },
    { "file": "variant-b-facebook.png", "platform": "facebook", "dims": "1080x1350", "notes": "Same composition, slightly higher contrast for FB feed." }
  ]
}
```

- `request_id` - must match the id from the spec file / the `req-<id>` directory name.
  If it doesn't match any real `image_requests` row, PostDeck's importer skips the whole
  directory (logs it, leaves it untouched) rather than guessing - get this right.
- `variants[].file` - filename relative to this same directory (the file must actually be
  sitting next to `manifest.json`).
- `variants[].platform` - which platform this variant targets (matches one of
  `brief.platforms[].platform`).
- `variants[].dims` - the actual pixel dims you rendered at, as a plain string (doesn't
  need the parenthetical aspect note).
- `variants[].notes` - anything CB should know when picking (crop choice, what changed
  between variants, anything you couldn't fully honor from the brief).

Do not write anywhere else, and do not touch the `image_requests` table or any other
PostDeck file - the worker owns the import step.

## 3. What happens after you drop the files

`importGeneratedImages()` (in `src/imagestudio.js`) runs every worker cycle:

1. Finds your `req-<id>/manifest.json`.
2. Moves each listed variant file into PostDeck's `media/` library (renamed with a
   timestamp prefix, same convention as a manual upload).
3. Updates the `image_requests` row: `status: 'generated'`, `variants: [...]` (now pointing
   at the moved `media/...` paths + `/media/...` URLs).
4. Archives your `manifest.json` (and anything left in the directory) to
   `image-requests/generated/processed/req-<id>/` so `generated/` doesn't pile up.

CB then sees the request in the dashboard's Images view, picks a variant
(`POST /api/image-requests/:id/pick`), and it attaches to the post - request status becomes
`picked`.

## Worked example

**Request** (`image-requests/req-42.json`, abbreviated): brand 2, platforms
`["instagram", "facebook"]`, content_type `static`, both platforms resolved to 1080x1350
(4:5), format `png`.

**Codex output**:

```
image-requests/generated/req-42/
├── manifest.json
├── variant-a.png   (1080x1350, headline top, product bottom)
└── variant-b.png   (1080x1350, same layout, alt color treatment)
```

`manifest.json`:

```json
{
  "request_id": 42,
  "variants": [
    { "file": "variant-a.png", "platform": "instagram", "dims": "1080x1350", "notes": "Primary layout - headline top third, product bottom two-thirds." },
    { "file": "variant-b.png", "platform": "facebook", "dims": "1080x1350", "notes": "Same layout, warmer color treatment for FB feed contrast." }
  ]
}
```

**After import**: `image_requests` row 42 → `status: 'generated'`, with:

```json
[
  { "path": "media/1752521400000_1-variant-a.png", "url": "/media/1752521400000_1-variant-a.png", "platform": "instagram", "dims": "1080x1350", "notes": "Primary layout - headline top third, product bottom two-thirds." },
  { "path": "media/1752521400000_2-variant-b.png", "url": "/media/1752521400000_2-variant-b.png", "platform": "facebook", "dims": "1080x1350", "notes": "Same layout, warmer color treatment for FB feed contrast." }
]
```

`image-requests/generated/req-42/` is now gone; its manifest lives at
`image-requests/generated/processed/req-42/manifest.json` for reference.
