# D5 - Ease pass (CB feedback, 2026-10-07)

> Status: BUILT 2026-10-07 (suite 491). Review fixes after the build: summary chips show the count
> first with the words underneath, the Planner attention strip is one closable line, and a batch blog
> release reads as one line per site in Analytics. Known gaps: month chips show the brand as a dot;
> long brand tags truncate in narrow week columns (full name in the tooltip).
> Earlier status: BUILDING 2026-10-07. Contract for four parallel builders. `docs/DESIGN_WAVE_SPEC.md`
> still governs the look; this pass makes it easier to read and use.

## What CB said (paraphrased)

1. The app still doesn't feel easy to use.
2. "Needs attention" items on open: can't be closed, and they are far too long.
3. Planner: Di-Hy released 40 blog posts today and that day becomes a giant column. A busy day
   should show a number, not every item.
4. The popouts are unreadable: small text, no way to tell it is a blog post, no clear brand.
5. Blog view: "Needs your review" should be collapsible, items should open in a popout, and the
   list should be easier to read.
6. Analytics is missing the client sites he works on (Client One, Client Two, Client Three, ...). He wants
   to add sites and brands himself in Settings.
7. Spacing, surfaces and separation: nobody did a texture/separation pass. Cleaner on the eyes.

## A. Planner + popouts + Blog view (owner: agent P)
Files: `public/js/30-planner.js`, `public/js/31-post-drawer.js`, `public/js/70-blog.js`,
`public/css/planner.css`, `public/css/blog.css`.

- **Busy days collapse.** In every Planner view, a day shows at most 3 items (week) / 2 (month).
  Beyond that, items of the same kind and brand fold into ONE summary chip:
  "40 Di-Hy blog posts" (brand color dot + blog icon + count). Clicking it opens a popover list
  (native `<dialog>` or the existing overlay primitive, `registerOverlay`) with each item on its
  own readable row (time, type, brand, title, status) that opens the item. Social posts the same
  ("6 LinkedIn posts"). Published blog posts on the same day always fold when there are more
  than 2 of them.
- **Chips say what they are.** Every chip shows a type icon (blog / platform icon), the brand as
  a short colored tag (brand color from `brands.colors`, fallback neutral), and the title with
  enough width to read. No chip shows only the brand name.
- **Popout header** (social drawer and blog editor drawer): a clear header block with a type
  badge ("Blog post" / "LinkedIn post"), the brand name with its color, status pill, date/time,
  and for published items "View live". Title 20px+, body text 15px+, labels 13px+.
- **Published blog posts open read-first:** the blog drawer opens on a readable summary (title,
  description, keyword, word count, live link, 28-day views if `webBlogStats` data is available)
  with an "Edit" button that reveals the form. Unpublished posts open on the form as today.
- **Blog view lists:** each section (Needs your review, Scheduled, Published, Drafts) is a
  collapsible `<details>` with count in the summary; open state remembered per site in
  localStorage; Published collapsed by default when it has more than 10 items. Rows are readable:
  title 15px, second line with date, cluster, word count, review state; generous row height and
  a 1px separator. Clicking a row opens the drawer (popout). Keep existing keyboard support.

## B. Home "Needs you" (owner: agent H)
Files: `public/js/50-home.js`, `public/css/home.css` (and only the row-rendering part of the
`webHomeRows` / `blogHomeRows` hooks if they must change; prefer adapting in 50-home.js).

- Rows are one line: status pill, short reason (max ~70 chars, full text in `title`), brand +
  platform, one action button. No description excerpt line.
- Every row has a close (x) button with two choices in a small menu: "Hide for a day" and
  "Hide until it changes". Stored in localStorage key `pd_home_hidden` as
  `{ [rowKey]: { until: ISO|null, sig: string } }`; `sig` = status + updated_at (or alert text)
  so a changed item comes back. Undo toast after hiding.
- Show the 4 most important rows; the rest behind "Show N more". Group rows of the same kind
  ("3 posts not confirmed by Blotato") into one expandable row when there are 3+.
- A small "N hidden. Show" link restores hidden rows.
- The whole section can be collapsed (remembered).

## C. Analytics sites + brands (owner: agent S)
Files: `src/web.js`, `src/db.js` (migration v15 only), `src/server.js` (brand create route only),
`public/js/80-web.js`, `public/css/web.css`, `public/js/60-settings.js` (Brands "Add brand" only),
tests `test/web-api.test.js`, new `test/brands-create.test.js`.

- **Migration v15:** `ALTER TABLE web_sites ADD COLUMN name TEXT; ADD COLUMN kind TEXT NOT NULL
  DEFAULT 'own'` (`own` | `client`). Seed (insert if missing) the client sites on the VPS:
  client-one.example (Client One), client-two.example (Client Two), client-three.example (Client Three),
  client-four.example (Client Four), kind `client`, no brand. Find each one's GA4
  measurement id by grepping `Website Projects/<folder>/` for `G-` / `GT-` ids (read only;
  Client Two is `G-CLIENT0002`); leave null if unsure.
- **API:** `POST /api/web/sites` `{ domain, name?, kind?, brand_id?, ga4_measurement_id? }`
  (validate domain `^[a-z0-9.-]+\.[a-z]{2,}$`, lowercase, strip `www.` and scheme),
  `DELETE /api/web/sites/:id` (removes the site and its rows after confirm in UI), PATCH accepts
  `name`, `kind`. `GET /api/web/sites` and overview/site entries include `name`, `kind`.
  Picker filter: `brand_id`, or `group=own|client`, or `site_id`.
- **UI:** Analytics picker becomes: All sites / Your brands / Clients / then each brand / then
  each client site. Settings > Websites: "Add a site" form (domain, name, Your brand or Client,
  brand select when own), remove button per site (confirmDialog). Client rows read "Client" in
  place of a brand. Logs sync covers every active site automatically.
- **Add brand:** `POST /api/brands` `{ name, slug?, color? }` creates the brand (slug from name,
  unique) plus a default tone profile row like existing brands (copy what `seed.js` does for one
  brand, minimal). Settings > Brands gets an "Add brand" button (promptDialog for name). Test it.
- No long dashes in UI strings. Suite must stay green.

## D. Visual ease pass (owner: agent V)
Files: `public/css/foundation.css`, `public/css/settings.css`, `public/css/home.css` ONLY for
spacing tokens if agent H has not touched the same rules (coordinate by editing foundation
tokens, not page CSS), `public/index.html` only if a font link is needed (prefer not).

- Base body text 15px, line-height 1.5; small text never below 13px; headings with clear steps.
- Surfaces: three distinct levels (page, section surface, raised row/hover) with visible but
  quiet contrast; 1px separators at a consistent tone between rows; section spacing 32px,
  in-section spacing 16px, row padding 12-14px vertical.
- Comfortable max content width for reading views; tables with zebra-free 1px rules.
- Focus rings visible; contrast 4.5:1 for body and secondary text (raise muted grays if needed).
- Do it through tokens and shared components in foundation.css so every view benefits; no
  per-view overrides except where a view hard-codes a value that defeats the tokens (then fix
  the value in that view's css, minimal).
- No side-stripe borders, no gradients, no glassmorphism.

## Shared rules
- Classic scripts share one global scope: prefix new top-level names per file.
- QA only in a sandbox: port 4599 with a DB copy, `BLOTATO_DRY_RUN=1 POSTDECK_WORKER=0
  POSTDECK_SYNC_ENABLED=0 POSTDECK_WEB_SYNC=0`. Never port 4520, never `postdeck.db`.
- No commits. Report files changed and what you verified.
