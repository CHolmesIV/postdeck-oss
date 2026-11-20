# Changelog

## 0.1.0 (first public release)

- Multi-brand scheduler: brands, per-platform accounts, ideas, posts, tone profiles.
- Local dashboard: planner (week and month), composer, post drawer, ideas board, library.
- Blotato worker with dry-run as the default: hands posts off inside a configurable window,
  verifies publish status, recovers failed or unverified posts.
- AI layer: provider registry (Claude and Codex through their CLIs, Grok over HTTP), drafting,
  compare view, copy assist, in-app chat agent that can draft but cannot publish unless armed.
- Voice rules: one global voice, per-brand voice docs, mechanical hard-rule scrub (no dashes).
- Content studio: image briefs, variants, auto-resize to platform specs, platform limits.
- Analytics: post metrics import, best-time suggestions, website traffic and search dashboard.
- Blog add-on: control panel for static-site blog programs (draft, schedule, release).
- Safety: binds to 127.0.0.1 only, daily SQLite backups, approve gates, UTM tagging.
- 491 tests, run in CI.
