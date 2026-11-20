# PostDeck

PostDeck is a local-first scheduler for people who run several brands on social media. It keeps
your content, schedule and brand voice in a SQLite database on your own machine, and hands posts
to [Blotato](https://www.blotato.com) when they are due. It exists because most schedulers are
hosted, per-seat, and bad at keeping many voices apart.

## Features

- Multiple brands, each with its own accounts, tone profiles and voice doc.
- Planner with week and month views, drag to reschedule, bulk approve, queue slots.
- Composer with per-platform limits and checks, first-comment links, UTM tagging on approve.
- AI drafting through the Claude or Codex CLIs (Grok optional), a compare view and a chat agent.
  Nothing is published without a human approving it.
- Hard rules enforced in code, not by prompt (for example, no em dashes).
- Image briefs, variants and auto-resize to each platform's spec.
- Metrics import, best-time suggestions, and a website traffic and search dashboard.
- Blog add-on for static-site blogs: draft, schedule and release.
- Dry-run by default, 127.0.0.1 only, daily SQLite backups.

## Quickstart

Needs Node 20 or newer. No API key is required: dry-run mode is the default, so nothing is
sent to Blotato until you turn it on.

```bash
npm install
cp .env.example .env && npm run seed
npm start
```

Open http://127.0.0.1:4520. The seed loads two demo brands (Acme Co and Northwind), their
accounts, and a handful of demo ideas and posts. Check it from a terminal with
`curl http://127.0.0.1:4520/api/health`.

## What needs a key

| Feature | Needs |
|---|---|
| Dashboard, planner, composer, demo data | nothing |
| AI drafting and chat agent | your own logged-in `claude` or `codex` CLI (subscription, no API key in PostDeck) |
| Grok as a provider | `XAI_API_KEY` in `.env` |
| Live posting | `BLOTATO_API_KEY` and `BLOTATO_DRY_RUN=0` |

Without a logged-in CLI the AI buttons report that drafting is unavailable and everything else
keeps working.

## Going live with Blotato

1. Copy `config/accounts.seed.example.json` to `config/accounts.seed.json` (gitignored) and put in
   your own brands and Blotato account ids (`GET /v2/users/me/accounts`). Seed a fresh database
   with `npm run seed`.
2. Set `BLOTATO_API_KEY` in `.env`.
3. Set `BLOTATO_DRY_RUN=0` and restart.
4. Schedule one throwaway post on your least visible account and confirm it appears in Blotato
   before trusting the pipe.

## Configuration

All in `.env`, commented in `.env.example`.

| Variable | Default | What it does |
|---|---|---|
| `BLOTATO_DRY_RUN` | `1` | Only `0` or `false` allows real Blotato calls. In dry-run the worker logs the payload and marks the post `submitted_dry`. |
| `POSTDECK_WORKER` | `1` | Set `0` to stop the in-process worker (handoff, verify, export every 5 minutes). |
| `POSTDECK_SYNC_ENABLED` | `0` in the example | Optional rsync of `state/social-state.json` to a remote host. |
| `POSTDECK_DRAFT_MODEL` | `claude-haiku-5-5` | Model passed to the `claude` CLI for drafting. |
| `POSTDECK_GROK_MODEL` | `grok-4` | Model used when Grok is enabled. |
| `POSTDECK_DB_PATH` | `./postdeck.db` | SQLite file. |
| `POSTDECK_BACKUP_DIR` | `~/Library/Application Support/PostDeck/backups` | Where the daily SQLite backup is written (keeps 14). |
| `PORT` | `4520` | The server always binds to 127.0.0.1. |

Quiet hours and the handoff window live in the `settings` table (`GET` and `PATCH /api/settings`).

## AI providers

Claude and Codex run through their subscription CLIs, so PostDeck reuses your existing login.
Grok is HTTP only and turns on when `XAI_API_KEY` is set. Every AI call goes through one provider
registry, see [`docs/PROVIDER_LAYER_SPEC.md`](./docs/PROVIDER_LAYER_SPEC.md). To add a provider,
copy `src/providers/grok.js`, register it in `src/providers/index.js`, and add its env var to
`.env.example`.

## Importing your own content (advanced)

PostDeck can import ideas, posts and leads from CSV. Samples are in `samples/`.

```bash
node src/import.js clusters samples/clusters.sample.csv --brand acme
node src/import.js posts    samples/posts.sample.csv    --brand acme
```

Imports are repeatable: rows are matched on `external_id` and updated, not duplicated. If you
leave out `--brand`, the brand is picked from the file path, else the first brand in the database.

## Tests

```bash
BLOTATO_DRY_RUN=1 POSTDECK_WORKER=0 POSTDECK_SYNC_ENABLED=0 npm test
```

491 tests on Node's built-in runner. The Blotato worker is tested against a local mock server and
never calls the real API. CI runs the same command.

## Architecture

Fastify API and SQLite (better-sqlite3) on the backend, a no-build vanilla JS frontend in
`public/`. A worker loop hands due posts to Blotato, verifies status and exports state.
[`SPEC.md`](./SPEC.md) has the data model, the worker and the design decisions;
[`docs/`](./docs) has the provider layer, blog add-on and web analytics specs.

Frontend scripts in `public/js/` load in a fixed order and share one global scope. `00-core.js`
has the shared helpers, `01-router.js` the router, `99-main.js` the route table. CSS is
`styles.css` plus one file per view in `public/css/`.

## Optional macOS launchers

`scripts/open-postdeck.command` starts the server if needed and opens the dashboard.
`scripts/install-launchd.sh` installs a login agent that keeps it running (`--uninstall` removes
it). `scripts/install-macos-app.sh` builds a double-clickable app from `assets/postdeck-icon.png`.

## License

MIT, see [`LICENSE`](./LICENSE).
