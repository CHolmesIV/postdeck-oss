# PostDeck Blog Add-on - Spec

> **Status: SHIPPED 2026-10-07** (suite 418). Verified on copies of the real sites in dry-run mode.
> Differences from the text below, decided during the build: preview is POST + token URL; counts are
> disjoint (anything unpublished awaiting review counts as needs_review); deploy/date flags come
> from the options each `release.py` declares (Lunula: `--go`, no date option; Di-Hy: `--today`);
> the scheduler makes one automatic attempt per situation (a failed or blocked release waits for
> Release now); preview serves pages with scripts disabled. Gaps: see BUILD_STATUS "Pending".

_Written 2026-10-07. CB: "adding on to the social media ... not as big, an add-on feature, done
the right way." PostDeck becomes the control panel for the HTML blog programs in
`Desktop/AI/Projects/Website Projects/<Site>/blog/`. It does not replace them._

## What exists (the contract PostDeck drives)

Every site blog follows the shared `Website Projects/BLOG-PROGRAM-PROMPT.md` template:

- `blog/content/<slug>.md`: one post per file. Front matter between `---` lines, `key: value`,
  lists as `[a, b]`, strings optionally quoted. Body is markdown. File name must equal `slug`.
- Fields differ per site (CHolmesIV: `headline`, `secondary_keywords`; Di-Hy: `seo_title`,
  `tags`, `excerpt`; Lunula: `dek`, `disclaimer`, `cta_heading`, `cta_body`). Shared: `title`,
  `description`, `slug`, `cluster`, `tier`, `primary_keyword`, `publish_date` (YYYY-MM-DD),
  `updated_date`, `status`, `needs_cb_review`, `related`. `build_blog.py` refuses a post missing
  its required keys or using a `cluster` not in its `CLUSTERS` list.
- `status`: `draft` (never rendered) | `scheduled` | `published`. A post renders when status is
  scheduled/published and `publish_date <= today`.
- `blog/tools/build_blog.py [--date D] [--preview] [--out DIR]`: builds into `dist/`; with
  `--preview --out DIR` renders every non-draft post (future dates too) into DIR.
- `blog/tools/qa.py [--preview] [--tree DIR]`: exit 1 on any FAIL (dashes, lengths, links...).
- `blog/tools/release.py [--date D] [--deploy] [--allow-unreviewed]`: flips due `scheduled` posts
  to `published`, builds, QAs; refuses if any due post has `needs_cb_review: true`; dry run by
  default; `--deploy` backs up the server, rsyncs `dist/` to the VPS, checks md5 drift, prepends
  the site's `CHANGELOG.md`. Release is by DATE, not time.
- Each site folder is its own git repo. Sites today: CHolmesIV (35 scheduled, all awaiting
  review, twice weekly from 2026-11-03), Di-Hy (46 published), Lunula Supply (38 published),
  Akats (being set up in another session).

PostDeck never edits these scripts and never calls `--allow-unreviewed`.

## What CB gets

1. **Blog view** (`#/blog`, nav item "Blog" after Planner): site tabs; per site three lists:
   Needs your review, Scheduled, Published (newest first), plus Drafts. Each row: title, publish
   date + time, status, review state. Buttons: New blog post, Release now (when something is due).
2. **Blog post editor** (drawer, same look as the social post drawer): fields generated from the
   site's schema (below); body as a large markdown box (paste or write); "Draft with AI";
   preview (the real site template, built by the site's own builder); actions: Save,
   Approve (sets `needs_cb_review: false`), Schedule (date + time), Unschedule (back to draft),
   Release now, View live (published only). Autosaves edits like the social drawer.
3. **Planner**: blog posts appear on their date with a blog icon; a "Blog" filter chip. Click
   opens the blog editor. Drag to another day changes `publish_date` (not for published posts).
4. **Home**: "N blog posts need your review", "Blog release due on <site>" with a Release button,
   failed or blocked releases in Needs you.
5. **Settings > Blogs**: discovered sites, which brand voice each uses (CHolmesIV -> CHolmesIV,
   Di-Hy -> Di-Hy, Lunula Supply -> Lunula, others none), default release time (09:00), last
   release result.

## Scheduling and release rules

- **Schedule** = `status: scheduled` + `publish_date` + PostDeck's `publish_time` front matter
  key (HH:MM, local; the site builder ignores unknown keys). Default time from Settings.
- **Approved** = `needs_cb_review: false`. Only approved posts ever release through PostDeck.
- **Scheduled release (while PostDeck is open):** each worker cycle, per site: if an approved
  scheduled post's `publish_date + publish_time` has passed and no release for that site is in
  flight, run `release.py --date <today> --deploy`. CB's approval plus the time he picked is
  the consent. Release is per day: if two posts share a date, the earlier time releases both;
  the editor warns when a date already has a post.
- **Blocked:** if any post due by today still needs review, `release.py` refuses the whole run.
  PostDeck checks this first, does not run, and shows "Release blocked" listing those posts
  with Approve / Move date buttons. It never edits other posts on its own.
- **Release now** (approved post): sets `publish_date` to today if it is in the future,
  `status: scheduled`, then runs the release immediately (same block check). Confirm dialog
  names the site and says LIVE or DRY RUN.
- **Dry run:** when PostDeck runs in dry-run mode (`BLOTATO_DRY_RUN` not 0) blog releases run
  without `--deploy`: the full build + QA runs and nothing is uploaded or written.
- **Missed while closed:** if PostDeck was closed at the release time, the release runs on the
  next worker cycle after it opens (same as today's manual practice, just remembered for CB).
  Global setting "Pause blog releases" (default off) stops the scheduler.
- One release per site at a time (in-process lock). Every run (dry or live, manual or
  scheduled) is logged: table `blog_releases` (migration v13: id, site_id, trigger
  'manual'|'schedule', mode 'dry'|'deploy', started_at, finished_at, exit_code, released (JSON
  list of slugs), output (last 20 KB)). Exit code 0 = success.

## Creating and editing posts

- **Schema per site** (`GET /api/blog/sites/:site/schema`): key order and kinds taken from the
  site's most recently dated post (date, bool, list, text, long text for `description`/
  `excerpt`/`dek`/`cta_body`); `cluster` and `tier` options from the `CLUSTERS` constant in
  `build_blog.py` when parseable, else the distinct values across posts; required = the keys
  `build_blog.py` lists in `read_post` (parse the tuple; fallback to the shared set above).
- **New post:** slug from title (kebab, unique in the folder); writes `<slug>.md` with every
  schema key in order, `status: draft`, `needs_cb_review: true`, `publish_date` = next free
  release day, `updated_date` = publish_date. Body from paste or AI.
- **Edit:** only keys in the schema plus `publish_time`; values written back in the file's own
  style (lists as `[a, b]`, quote only when needed); body replaced as a whole; untouched keys
  and comments keep their exact text. Slug is read-only once published (renaming breaks URLs).
  All writes normalize long dashes (`normalizeDashes`, CB rule) in every field and the body.
- **File safety:** writes confined to `<site>/blog/content/*.md` of a discovered site; atomic
  write (temp + rename); refuse if the file changed on disk since it was loaded (send `mtime`
  back, 409 `changed_on_disk`), because other sessions edit these files too.
- **AI draft** (`POST /api/blog/draft`): input title (or idea), optional notes/outline and
  primary keyword. Prompt = brand voice (site's linked brand, via `withGlobalVoice`) + blog rules
  (H2 structure, target length = median word count of the site's published posts, primary
  keyword in the first 100 words, no em dashes, no invented facts or numbers) + two recent posts
  from the same site as style examples (first ~1,500 chars each). Returns JSON
  `{ title, headline-or-equivalent, description, primary_keyword, body_md }` mapped onto the
  site's schema. Goes through `src/ai.js` (the Settings drafting provider). Output scrubbed by
  the hard rules.
- **Preview** (`POST /api/blog/sites/:site/posts/:slug/preview`, served from `/api/blog/preview/:token/`): copy `blog/` (content,
  templates, tools) to a temp dir, symlink the real `dist/` read-only as the copy's source,
  force this post to `status: scheduled` in the copy, run `build_blog.py --preview --out <tmp>`,
  return the URL of `<tmp>/blog/<slug>/index.html` under the token path; the built pages use
  root-absolute links, so HTML responses are rewritten to the token prefix. Also run
  `qa.py --preview --tree <tmp>` and return its FAIL/WARN lines for this post. Never writes the
  real site.

## API (all JSON; mounted under the existing origin guard)

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/blog/sites` | discovered sites + settings + counts + last release + blocked state |
| GET | `/api/blog/sites/:site/schema` | field list for the editor |
| GET | `/api/blog/sites/:site/posts` | all posts (front matter + word count + mtime, no body) |
| GET | `/api/blog/sites/:site/posts/:slug` | one post incl. `body_md`, `mtime` |
| POST | `/api/blog/sites/:site/posts` | create (fields + body) |
| PATCH | `/api/blog/sites/:site/posts/:slug` | update fields/body (requires `mtime`) |
| POST | `/api/blog/sites/:site/posts/:slug/approve` | `needs_cb_review: false` |
| POST | `/api/blog/sites/:site/posts/:slug/schedule` | `{ publish_date, publish_time }` -> scheduled |
| POST | `/api/blog/sites/:site/posts/:slug/unschedule` | -> draft (not for published) |
| POST | `/api/blog/sites/:site/posts/:slug/release-now` | see rules |
| POST | `/api/blog/sites/:site/release` | `{ dry: bool }` release whatever is due |
| GET | `/api/blog/sites/:site/releases` | recent runs |
| POST | `/api/blog/sites/:site/posts/:slug/preview` | build a preview; returns `{ url, qa, build_error }` |
| GET | `/api/blog/preview/:token/*` | serves that preview build; root-absolute links in HTML rewritten to the token path; tokens expire after 30 min (max 10) |
| POST | `/api/blog/draft` | AI draft |
| PATCH | `/api/settings` keys | `blog_paused`, `blog_default_time`, `blog_site_brand:<site>` |

Site discovery root: `POSTDECK_WEBSITES_ROOT` (default `~/Desktop/AI/Projects/Website Projects`);
a site = a direct child folder with `blog/tools/release.py` and `blog/content/`. Site id = folder
name slugified (`cholmesiv`, `di-hy`, `lunula-supply`, `akats`). Python: `python3` on PATH
(`POSTDECK_PYTHON` override). Subprocesses use `execFile` (no shell), cwd = site root, timeouts
(preview 60s, release 10 min).

## Ownership (parallel build)

| Owner | Files |
|---|---|
| Backend agent | new `src/blog.js` (discovery, front matter read/write, schema, preview, release runner, scheduler phase), routes in `src/server.js` (one block), worker hook in `src/worker.js` (one call), migration v13 in `src/db.js`, `test/blog*.test.js` |
| Frontend agent | new `public/js/70-blog.js`, `public/css/blog.css`; Planner/Home integration via small hooks in `30-planner.js` and `50-home.js`; Settings > Blogs section in `60-settings.js` |
| Lead | nav item + route + script/css tags (`index.html`, `99-main.js`), review, sandbox QA, docs |

## Acceptance

- Tests: front matter round trip preserves untouched lines byte-for-byte; schema per site;
  create/edit/approve/schedule/unschedule; mtime conflict 409; path confinement; dash
  normalization; blocked release detection; scheduler releases only approved + time-passed
  posts, never with `--allow-unreviewed`, never `--deploy` in dry-run mode; release lock;
  release log row. Subprocesses stubbed in tests (fake site folder with tiny python scripts).
- Sandbox QA against COPIES of the real site folders (`POSTDECK_WEBSITES_ROOT` -> scratch),
  dry-run mode: create a post by paste, draft one with AI, preview renders in the real template,
  approve, schedule, Release now runs build + QA and reports, Planner and Home show blog items.
- Docs: CHANGELOG, BUILD_STATUS, SPEC, README endpoints; this spec marked shipped.
