# PostDeck Website Analytics - Spec

> **Status: BUILT 2026-10-07** (suite 479). Live today on server logs; GA4 and Search Console switch on
> when CB adds the service account key. Site-side own-traffic script and lead events are still to
> do from each site's session (see BUILD_STATUS). Differences decided in the build: a "before" number
> appears only when the whole previous period is stored; referral spam is dropped; relay outcome
> names fold into delivered/tagged/blocked/honeypot/invalid/failed and "failed" raises a Home alert.
> Earlier status: **APPROVED 2026-10-07, building all phases.** CB: build everything; filter out his own
> traffic. The "Build contract" section at the end is binding for every builder and overrides the
> sketches above where they differ.

_CB, 2026-10-07: grow PostDeck a step and add a dashboard for website traffic. The data is
starting to come in. Like the blog add-on, this is an add-on done the right way: PostDeck reads
the numbers, it never changes the sites or the tracking._

## Why it belongs in PostDeck

GA4 can already show traffic. What it can't do is line traffic up with the work. PostDeck knows
every social post, every blog release, and the date and time of each. Put the two side by side and
CB gets the answer he actually wants: **did the work move visitors and leads?** That is the reason
to build this here instead of opening GA4.

Rule for every screen: one question per section, answered in a plain sentence first, chart second.

## What exists today (checked 2026-10-07)

| Site | Brand | Tracking on the site | Lead event |
|---|---|---|---|
| cholmesiv.com | CHolmesIV | GA4 `G-97XJH8721S` (via `GT-W6N2Q3C7`), GTM `GTM-T9LMP8SZ`, Clarity | `generate_lead` on blog form (`blog_post`). **Contact page has none yet.** |
| di-hy.com | Di-Hy | GA4 `G-957QEJY8VC`, Clarity | `generate_lead` on contact (`contact`) and blog (`blog_inline`) |
| lunulasupply.com | Lunula | GA4 `G-5GVQC5FMF0` (via `GT-KD7KZX5`), HubSpot | not confirmed |
| ivisionbuild.com | IVision | **none** (needs a GA4 property) | none |
| PrimeWright | PrimeWright | not checked; app, not a content site | n/a |

Also in place:
- **Server logs:** every vhost on the VPS logs in the `vhost` format, and the Agentic OS weekly
  traffic report (Mondays) already counts visitors, referrers, 404s and Googlebot per site.
- **Form relay:** `/submit` on the VPS logs each outcome (no personal data), so it is a second
  count of real leads that ad blockers can't hide.
- **PostDeck:** `src/utm.js` adds `utm_source={platform}&utm_medium=social&utm_campaign=...` to
  links on approve, but it is **off by default per brand**. Social Analytics (`13-analytics.js`,
  `metrics` table) is manual entry and only covers the social side.

Client sites (Akats, Five Oaks, Maricured, Amadou and so on) are out of scope. CB's brands only.

## Data sources, in build order

1. **GA4 Data API** (`runReport`, read-only). Visitors, sessions, engaged sessions, pageviews,
   `generate_lead` count, by day, page, channel and source/medium/campaign. 24 to 48 h lag on
   final numbers.
2. **Search Console API** (`searchanalytics.query`, read-only). Clicks, impressions, CTR and
   average position by page and query. About 2 to 3 days lag. Keeps 16 months.
3. **GA4 Realtime** (`runRealtimeReport`). "Active now" per site. Polled only while the
   Analytics view is open. This is what makes the page feel live.
4. **VPS logs + form relay** (read-only SSH, later phase). Ad-blocker-proof visitor counts, 404s
   worth a redirect, bot share and relay lead counts. Reuse the Agentic OS report's parsing. Never
   write on the box (co-tenant rule: PrimeWright runs there).
5. **Clarity** (optional, last). Its export API is limited to a few calls a day over the last 1 to
   3 days. Useful only for rage-click and dead-click counts on key pages.

### Credentials (CB does this once; Claude never handles the key)

- One Google Cloud service account with the **Google Analytics Data API** and **Search Console
  API** enabled. CB downloads its JSON key to
  `~/Library/Application Support/PostDeck/google-service-account.json` (path override:
  `POSTDECK_GOOGLE_SA`). It lives outside the repo and is never sent to the browser.
- Add the service account's email as **Viewer** on each GA4 property and as a **Restricted**
  user on each Search Console property.
- PostDeck signs the token itself with Node `crypto` (JWT, RS256). Scopes
  `analytics.readonly` and `webmasters.readonly` only. No `googleapis` dependency.
- Settings > Websites shows each site's connection state and the exact missing step in plain
  words ("Add postdeck@... as a Viewer on the Di-Hy GA4 property").

## Data model (migration v14)

All tables hold daily aggregates. No visitor-level data is ever stored.

| Table | Key | Columns |
|---|---|---|
| `web_sites` | `id` | `brand_id`, `domain`, `ga4_property_id` (numeric, not the G- id), `gsc_property` (`sc-domain:x.com`), `blog_site_id` (links to the blog add-on), `active`, `last_sync_at`, `last_sync_error` |
| `web_daily` | `site_id, date` | `users`, `new_users`, `sessions`, `engaged_sessions`, `pageviews`, `avg_engagement_s`, `leads` |
| `web_channels_daily` | `site_id, date, channel, source, medium, campaign` | `sessions`, `engaged_sessions`, `leads` |
| `web_pages_daily` | `site_id, date, path` | `views`, `users`, `entrances`, `leads` (top 200 paths per day) |
| `web_search_daily` | `site_id, date, path, query` | `clicks`, `impressions`, `position` (top 1,000 rows per day) |
| `web_sync_runs` | `id` | `site_id`, `source`, `started_at`, `finished_at`, `ok`, `rows`, `error` |

`channel` is GA4's default channel group, plus one PostDeck group: **AI assistants** (referrers
`chatgpt.com`, `perplexity.ai`, `gemini.google.com`, `copilot.microsoft.com`, `claude.ai`). That
group is growing and GA4 hides it inside Referral.

### Sync

- Runs as a worker phase, like the blog scheduler. On app open, if the last sync is more than 6 h
  old, then every 6 h while PostDeck is open. A **Refresh** button forces it.
- Re-pull the last 4 days every time (GA4 and GSC both revise recent days). Older days are final.
- First connect backfills 90 days of GA4 and 16 months of Search Console.
- A failed sync keeps the old numbers on screen with "as of <time>" and the error in plain words.
  It never blanks the page.
- One sync per site at a time. Quotas are not a concern at this size (GA4 allows 200k tokens a
  day per property).

## What CB sees

### Analytics view becomes two tabs: **Websites** (default) and **Social**

Social is today's page, unchanged. Websites is new. One brand picker at the top (All brands, or one
brand) and one range picker (7 days, 28 days, 90 days, 12 months), each compared to the period
before.

**1. The read (top of page).** Three to five plain sentences built from the numbers, not AI:
- "Di-Hy: 412 visitors this week, up 18%. Google search brought 61% of them."
- "3 leads this week: 2 from blog posts, 1 from the contact page."
- "Your Tuesday blog post 'Missed call cost' got 140 visits in its first 3 days."
- Warnings go first: "cholmesiv.com reported 0 visits for 2 days. Tracking may be broken."

**2. Numbers row.** Per site: visitors, leads, lead rate, search clicks, Active now. Each with a
small change arrow and a 28-day sparkline. Compact row, not big hero tiles.

**3. Trend chart.** Daily visitors (line) and leads (dots) for the range, with **markers for
PostDeck's own work**: a blog icon on each release day, a small tick for each social post that
linked to the site. Hover a marker to see the post. This is the chart GA4 can't draw.

**4. Where visitors came from.** Channels as a bar list: Search, Social (split by platform),
Direct, Referral, AI assistants, Email. Each with sessions, share, and leads.

**5. Pages.** Top pages, with views, search clicks, average position and leads. Tags:
- **Rising** / **Falling**: more than 30% change over the prior period on real volume.
- **Refresh candidate**: average position 8 to 20 with real impressions. Page 2 of Google is
  where a rewrite pays fastest.
- **No leads**: high traffic, zero leads. Check the form and the offer on that page.

**6. Search (Search Console).** Top queries and **striking distance**: queries in position 5 to 20
with impressions but few clicks. Each row has **Write a post** (opens the Blog editor with AI draft,
the query as primary keyword) or **Refresh post** (opens the ranking post). This closes the loop
between data and the blog add-on.

**7. Social to site.** For each social post with a tagged link: visits, engaged visits, leads.
Platform totals ("LinkedIn sent 96 visits and 2 leads this month"). Needs UTMs on (below).

**8. Site health (phase 4).** Top 404s with hit counts, each with "add a redirect" copy ready for
the site's redirect file. Bot share. Form relay leads compared to GA4 leads; a big gap means the
lead event is broken or blocked.

### Elsewhere in PostDeck

- **Home > Needs you:** tracking looks broken (0 visits for 2 days on a site that usually has
  some), traffic down more than 40% week over week, a sync failing for a day, a new lead.
- **Home summary line:** "This week: 1,180 visitors across your sites, 5 leads."
- **Blog view:** each published post shows 28-day views, search clicks and position. Sort by them.
- **Post drawer (published social post):** "Sent 18 visits, 1 lead" when it had a tagged link.
- **Planner:** optional "show traffic" layer that tints each day by visitors.
- **Settings > Websites:** sites, linked brand, GA4 property id, Search Console property,
  connection state, last sync, the UTM switch per brand, a Sync now button.

## Measurement fixes to make on the sites (outside PostDeck, separate site sessions)

These decide whether the dashboard can be trusted. Do them first; each is small.

1. **Turn on UTMs for every brand with a site** (PostDeck Settings). Without them, social traffic
   shows as "Direct" or a bare referrer and the Social to site section is empty.
2. **cholmesiv.com contact page:** add the `generate_lead` event (`form_type: contact`), like Di-Hy.
3. **Lunula:** confirm a `generate_lead` event fires on its forms; add one if not.
4. **Mark `generate_lead` as a Key event** in each GA4 property so it counts as a conversion.
5. **IVision:** create a GA4 property and add the tag (open since the cutover).
6. **Search Console:** confirm each domain is verified as a Domain property (`sc-domain:`).
7. **Akats:** two GA4 tags were found on it before and Di-Hy's was removed. Keep Di-Hy's numbers
   clean of client traffic.
8. Exclude CB's own visits: a GA4 internal-traffic rule for his home IP, or he can accept the noise.

## API

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/web/sites` | sites, connection state, last sync, Active now |
| PATCH | `/api/web/sites/:id` | brand, property ids, active |
| POST | `/api/web/sync` | `{ site_id? }` sync now |
| GET | `/api/web/overview?brand_id&range` | the read, numbers row, trend + PostDeck markers |
| GET | `/api/web/channels?site_id&range` | channel breakdown |
| GET | `/api/web/pages?site_id&range` | pages with tags |
| GET | `/api/web/search?site_id&range` | queries, striking distance |
| GET | `/api/web/social?brand_id&range` | per-post and per-platform site visits from UTMs |
| GET | `/api/web/realtime` | Active now, cached 60 s |

All under the existing origin guard. All read-only toward Google.

## Phases

| Phase | Ships | Needs from CB |
|---|---|---|
| **W0** | Measurement fixes 1 to 4 and 6 above | Approve; site sessions do the edits |
| **W1** | Service account auth, `web_*` tables, GA4 sync, Websites tab (read, numbers row, trend with PostDeck markers, channels, pages), Settings > Websites, Home warnings | The service account key and Viewer access |
| **W2** | Search Console sync, Search section, striking distance with Write a post / Refresh post, Blog view numbers | Search Console access for the same account |
| **W3** | Social to site: UTM attribution per post and platform, post drawer line, Social tab gets real link-click and lead numbers instead of manual entry where possible | UTMs on |
| **W4** | Active now (realtime), VPS log + form relay pull over read-only SSH, 404 list, lead cross-check | OK to read logs over SSH |
| **W5** | Weekly digest on Home (optional AI summary through `src/ai.js`), Planner traffic layer | none |

## Acceptance

- Tests with Google stubbed (no network): JWT signing, sync upsert and 4-day re-pull, backfill,
  failed sync keeps old data, AI assistants channel mapping, rising/falling/refresh tags,
  striking-distance filter, UTM attribution to post ids, "tracking looks broken" rule, the read
  sentences contain no long dashes.
- Sandbox QA on a DB copy (`POSTDECK_DB_PATH`), `BLOTATO_DRY_RUN=1`, worker on only for the web
  phase. Never against the live DB.
- The key file is never logged, never in an API response, never in the repo.
- Docs: CHANGELOG, BUILD_STATUS rows W0 to W5, SPEC "Analytics portal" section points here,
  README endpoints.

## Decisions

- CB's own traffic is filtered out (2026-10-07). See "Own traffic" in the build contract.
- PrimeWright and client sites are not included (no CB answer; default to brands with a content site).

---

# Build contract (binding, 2026-10-07)

## Data reality

- **Server logs work today** (no Google setup). The VPS (`ssh my-vps`, root) writes
  `/var/log/nginx/access.log*` (14 days kept, rotated daily, `.gz` after day 2) in the `vhost`
  format: `$host $remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent
  "$http_referer" "$http_user_agent"`. The form relay logs JSON lines to journald
  (`journalctl -u form-relay -o cat`): `{"evt":"form","ts":ISO,"site":"di-hy.com","ip":hash,
  "ua":"desktop|mobile|script","outcome":"delivered|tagged|blocked|honeypot|invalid",...}`.
  The Agentic OS script `/opt/agentic-os/reports/traffic_report.py` already parses these; reuse its
  bot/scanner/asset regexes (copied into our script, not imported).
- **Google (GA4 + Search Console)** works only once CB adds the service account key. Until then
  every Google path returns `connected: false` and the UI says so with the setup steps.
- So the dashboard is **logs first, Google when connected**. Per site, a number's `source` is
  `ga4` when that site has GA4 rows for the range, else `logs`.

## Sites (seeded on first boot into `web_sites` if missing; editable in Settings)

| domain | brand slug | blog_site_id | ga4_measurement_id |
|---|---|---|---|
| cholmesiv.com | cholmesiv | cholmesiv | G-97XJH8721S |
| di-hy.com | dihy | di-hy | G-957QEJY8VC |
| lunulasupply.com | lunula | lunula-supply | G-5GVQC5FMF0 |
| ivisionbuild.com | ivision | (none) | (none) |

`ga4_property_id` (numeric) and `gsc_property` are filled by discovery (Admin API
`accountSummaries` + `dataStreams` matching the measurement id; Search Console `sites.list`
matching `sc-domain:<domain>` or `https://<domain>/`). Settings can override.

## Own traffic (CB's rule: filter it out)

1. **On the sites:** a tiny inline script at the top of `<head>` on every page. Visiting any page
   with `?pd_internal=on` stores `localStorage.pd_internal = '1'` (`off` clears it). While set, it
   sets `window['ga-disable-<G-id>'] = true` (and the GT- id) and `window.__pdInternal = true`; the
   Clarity loader is wrapped in `if (!window.__pdInternal)`. CB does this once per browser and phone;
   Settings > Websites lists the links.
2. **In server logs:** excluded IPs = every IP in `web_self_ips` seen in the last 30 days, plus the
   IP the SSH session comes from (`$SSH_CLIENT`, recorded as `how='ssh'`, which is CB's Mac), plus
   any IP that requested a URL containing `pd_internal=` in the window (`how='optout'`).
   The summary script reports which IPs it saw so PostDeck can record them.

## Module ownership

| Module | Owner | Exports |
|---|---|---|
| `src/db.js` v14 | lead (done) | tables above |
| `src/google.js` | agent G | `googleStatus()`, `getAccessToken(scopes)`, `ga4RunReport(propertyId, body)`, `ga4Realtime(propertyId)`, `listGa4Properties()`, `listGscSites()`, `gscQuery(siteUrl, body)`, `saveServiceAccountKey(jsonText)`; `setFetch(fn)` for tests |
| `src/web-google.js` | agent G | `discoverGoogle(db)`, `syncGa4(db, site, { days })`, `syncGsc(db, site, { days })`, `ga4ActiveNow(db, site)` |
| `scripts/web/vps_log_summary.py` + `src/web-logs.js` | agent L | `sshStatus()`, `syncLogs(db, sites, { days })`, `logsActiveNow(db, sites)`; `setRunner(fn)` for tests |
| `src/web.js` | agent W | seeding, range math, all read endpoints, the read sentences, alerts, worker phase `runWebPhase(db)`, `registerWebRoutes(app, db)`, UTM changes in `src/utm.js` |
| `public/js/80-web.js`, `public/css/web.css` + hooks | agent F | Analytics hub, Settings > Websites, Home, Blog, drawer, Planner hooks |
| Website Projects sites | agent S | own-traffic snippet, missing lead events. Local edits only; lead deploys |

Each sync function writes its own rows with `INSERT ... ON CONFLICT DO UPDATE` (upsert), logs one
`web_sync_runs` row, and never throws to the caller (returns `{ ok, rows, error }`). `web.js`
writes `web_sites.last_sync_at` / `last_sync_error` from those results.

### Channel names (`web_channels_daily.channel`)

`search`, `social`, `ai`, `referral`, `direct`, `email`, `paid`, `other`. For `social` the
platform goes in `src` (`linkedin`, `facebook`, `instagram`, `x`, `threads`, `tiktok`,
`youtube`, `bluesky`, `pinterest`, `reddit`). GA4: map `sessionDefaultChannelGroup` (Organic Search
-> search, Organic Social/Paid Social -> social, Referral -> referral or `ai` when `sessionSource`
is an AI assistant, Direct -> direct, Email -> email, Paid* -> paid, else other). Logs: referrer
host -> channel (google/bing/duckduckgo/yahoo/baidu/yandex/ecosia/brave -> search; linkedin.com,
lnkd.in, facebook.com, l.facebook.com, m.facebook.com, instagram.com, t.co, x.com, twitter.com,
threads.net, tiktok.com, youtube.com, bsky.app, pinterest.com, reddit.com -> social; chatgpt.com,
chat.openai.com, perplexity.ai, gemini.google.com, copilot.microsoft.com, claude.ai, you.com ->
ai; webmail hosts -> email; empty -> direct; else referral) **but UTM params win when present**
(`utm_medium=social` -> social with `src=utm_source`, `utm_medium=email` -> email). `content` =
`utm_content` (PostDeck writes `pd-<postId>`), `campaign` = `utm_campaign`. In logs a "session" =
the landing hit (first human pageview of a visitor-day); attribute it to that hit's referrer/UTM.

### Leads

GA4: `eventCount` where `eventName = generate_lead`. Logs: form relay `outcome = delivered`
(stored in `web_forms_daily` and copied into `web_daily.leads` for source `logs`). Lead
attribution to pages/channels exists only with GA4.

### Ranges

`range` = 7 | 28 | 90 | 365 days ending **yesterday** for GA4/GSC-backed numbers, ending
**today** for logs-only sites; the previous period is the same length right before it. Server
returns both `start`/`end` and `prev_start`/`prev_end`. Dates are local `YYYY-MM-DD`.

## API (all JSON, under the origin guard)

```
GET  /api/web/status
  -> { google: { connected, key_present, client_email, error },
       ssh: { ok, host, error, self_ip },
       last_sync: { logs, ga4, gsc } (ISO|null), syncing: bool }
GET  /api/web/sites
  -> { sites: [ { id, domain, brand_id, brand_name, brand_slug, blog_site_id,
        ga4_measurement_id, ga4_property_id, gsc_property, active,
        last_sync_at, last_sync_error,
        checklist: [ { id, done, text } ]  // plain-language setup steps, e.g.
                                            // "Add <email> as Viewer on the GA4 property for di-hy.com"
      } ],
       self: { ips: [ { ip, how, last_seen } ],
               optout_links: [ { domain, on_url, off_url } ] } }
PATCH /api/web/sites/:id   { brand_id?, ga4_property_id?, gsc_property?, active? } -> site
POST  /api/web/google-key  { json: "<service account key file text>" }
  -> { ok, client_email }  // stored 0600 at the key path, never echoed back
DELETE /api/web/google-key -> { ok }
POST  /api/web/sync        { site_id?, source? ('logs'|'ga4'|'gsc'|'all') }
  -> { ok, results: [ { site_id, source, ok, rows, error } ] }

GET /api/web/overview?brand_id=&range=28
  -> { range: { days, start, end, prev_start, prev_end },
       as_of,                 // newest last_sync_at among included sites
       google_connected,
       read: [ { level: 'warn'|'good'|'info', text, site_id?, href? } ],
       totals: { visitors, visitors_prev, leads, leads_prev, search_clicks, search_clicks_prev },
       sites: [ { id, domain, brand_id, brand_name, source: 'ga4'|'logs'|'none',
                  visitors, visitors_prev, pageviews, leads, leads_prev, lead_rate,
                  search_clicks, search_clicks_prev, avg_position,
                  spark: [ { date, visitors } ],     // last 28 days, always
                  last_sync_at, error } ],
       trend: { days: [ { date, visitors, leads } ],
                markers: [ { date, kind: 'blog'|'social', title, platform?, href } ] } }
   // markers: blog posts published in range (from blog add-on post lists, status published,
   // publish_date) for the sites' blog_site_id, and PostDeck posts with status published whose
   // brand matches and whose copy contains a link to the site's domain. href = '#/blog?...' or
   // the app's existing post-open route.

GET /api/web/channels?site_id=&brand_id=&range=
  -> { source, rows: [ { channel, label, sessions, sessions_prev, share, leads,
                         breakdown: [ { src, label, sessions, leads } ] } ] }
GET /api/web/pages?site_id=&brand_id=&range=&limit=50
  -> { source, rows: [ { site_id, domain, path, url, views, views_prev, search_clicks,
                         impressions, position, leads,
                         tags: [ 'rising'|'falling'|'refresh'|'no_leads' ],
                         blog: { site_id, slug, title } | null } ] }
   // rising/falling: |change| >= 30% and max(views, views_prev) >= 20 (range 28; scale by days/28)
   // refresh: GSC position 8..20 and impressions >= 50 in range
   // no_leads: GA4 only, views >= 100 and leads = 0 and path is not a blog index/legal page
GET /api/web/search?site_id=&brand_id=&range=
  -> { connected, queries: [ { query, clicks, impressions, ctr, position, path } ],
       striking: [ { query, impressions, clicks, position, path, site_id,
                     blog: { site_id, slug, title } | null } ] }
   // striking: position 5..20, impressions >= 30 (scaled), sorted by impressions desc
GET /api/web/social?brand_id=&range=
  -> { utm: [ { brand_id, brand_name, enabled } ],
       platforms: [ { platform, sessions, leads } ],
       posts: [ { post_id, platform, brand_id, snippet, published_at, sessions, leads } ] }
   // posts from channel rows with content 'pd-<id>' joined to posts
GET /api/web/health?site_id=&brand_id=&range=
  -> { not_found: [ { site_id, domain, path, hits, redirect_line } ],
       bots: [ { site_id, domain, search_bot_hits, ai_bot_hits } ],
       forms: [ { site_id, domain, delivered, tagged, blocked, honeypot, invalid } ],
       lead_check: [ { site_id, domain, ga4_leads, relay_delivered, text } ] }
   // redirect_line: nginx line in the style of wp-to-static/infra/nginx/redirects:
   // "location = /old-path { return 301 /; }" (target "/" placeholder, CB edits)
GET /api/web/realtime?brand_id=
  -> { sites: [ { site_id, domain, active_now, window: '30m', source: 'ga4'|'logs' } ] }
   // cached 60 s (ga4) / 120 s (logs); logs = distinct human visitors in the last 30 min
GET /api/web/home
  -> { line: "This week: 1,180 visitors across your sites, 5 leads." | null,
       alerts: [ { level: 'warn'|'info', text, href } ],
       week: { visitors, visitors_prev, leads, leads_prev, top_post: { title, href, visitors } | null } }
   // alerts: tracking looks broken (source ga4 and 0 users for the last 2 complete days while the
   // prior 14-day average >= 5); traffic down > 40% week over week (prior week >= 50); a sync
   // failing for > 24 h; new leads since yesterday (relay delivered or GA4)
POST /api/web/digest { brand_id? } -> { text }   // optional AI summary via src/ai.js, CB voice off,
                                                 // plain operator summary, no long dashes
GET /api/web/blog-stats?blog_site_id=&range=28
  -> { posts: { "<slug>": { views, search_clicks, position } } }
   // blog post path = the site's live URL pattern; match by trailing "/<slug>/" segment
GET /api/web/post/:id   -> { sessions, leads, source } | { sessions: null }
GET /api/web/daily?brand_id=&start=&end= -> { days: [ { date, visitors } ] }
```

## UTM (agent W, `src/utm.js`)

- New template variable `{post_id}`. Default template becomes
  `utm_source={platform}&utm_medium=social&utm_campaign={campaign}&utm_content=pd-{post_id}`.
- `applyApproveUtm` passes the post id. Existing tests updated, not deleted.
- The lead turns UTMs on for brands with a site in the live DB (backup first). Not code.

## Sync schedule (`runWebPhase`, called from the worker cycle like the blog phase)

- logs: when the last logs sync is older than 60 min; days = 14 on first run, else 2.
- ga4: when connected and older than 6 h; days = 90 first run (per site), else 4.
- gsc: when connected and older than 12 h; days = 90 on first run (page + query), else 5. Rows
  limited to the top 1,000 per day by impressions.
- Discovery runs before the first Google sync and whenever a site lacks property ids (max once per hour).
- Skipped entirely when `POSTDECK_WEB_SYNC=0` (tests, sandboxes). One run at a time (in-process lock).
- Each phase is isolated in try/catch; a web failure never affects posting.

## Frontend (agent F)

- Route `#/analytics` renders `renderAnalyticsHub` (new, `80-web.js`): tabs **Websites** (default)
  and **Social** (calls the existing `renderAnalytics` from `13-analytics.js` into the tab panel).
  `#/analytics?tab=social` opens Social. Update the route table in `99-main.js`.
- Websites tab layout, top to bottom: brand picker + range picker + Refresh + "as of" stamp +
  source note; the read; numbers row (one row per site, sparkline, change arrows, Active now pill
  polled every 60 s while visible, cleaned up with `onViewCleanup`); trend chart (hand-built SVG,
  visitors line + lead dots + markers with hover cards); channels; pages (with tags and
  Write/Refresh actions); search (striking distance with **Write a post** -> opens the Blog editor
  for that site prefilled with the query as primary keyword, and **Refresh post**); social to site;
  site health (404s with copy-able redirect lines, bots, forms, lead check). Sections with no data
  show one plain line saying why and what unlocks it (for example "Connect Google in Settings >
  Websites to see search queries").
- Settings > **Websites** tab: Google connection (paste/upload key, client email, the per-site
  checklist), sites table (brand, GA4 property, Search Console, active), "Mark this browser as you"
  links per domain (open in a new tab) and the recorded self IPs, Sync now, UTM switch per brand
  (existing per-brand UTM settings endpoint).
- Home: the `line` under the existing summary; `alerts` into Needs you.
- Blog view: published rows show 28-day views, search clicks, position (from blog-stats).
- Post drawer: published post with a tagged link shows "Sent N visits, M leads".
- Planner: a "Traffic" toggle tints each day cell by visitors (`/api/web/daily`).
- Follow `docs/DESIGN_WAVE_SPEC.md` and `public/css/foundation.css` tokens. No new libraries.
  No long dashes in any UI text.
