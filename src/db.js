// SQLite init + versioned migrations (plain SQL, tracked via PRAGMA user_version).
// Single shared connection, WAL mode, foreign keys on.

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DB_PATH = process.env.POSTDECK_DB_PATH || path.join(ROOT, 'postdeck.db');

let dbInstance = null;

// Each migration is applied once, in order, when user_version < its index+1.
const MIGRATIONS = [
  // v1 - initial schema
  `
  CREATE TABLE IF NOT EXISTS brands (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    colors TEXT,               -- JSON: {primary, accent, ...}
    voice_doc_path TEXT,       -- path/note pointing at the brand voice doc
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tone_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    name TEXT NOT NULL,         -- business | personal | casual
    voice_rules TEXT,           -- free text style guidance for the drafting agent
    hard_rules TEXT NOT NULL DEFAULT '{}',  -- JSON, mechanically enforced
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(brand_id, name)
  );

  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    blotato_account_id TEXT,
    target_fields TEXT NOT NULL DEFAULT '{}',  -- JSON: pageId etc.
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    external_id TEXT,          -- e.g. cluster_id from content_clusters.csv
    title TEXT,                -- core_idea
    pillar TEXT,
    target_icp TEXT,
    source_material TEXT,
    notes TEXT,
    status TEXT NOT NULL DEFAULT 'idea',  -- idea -> clustered -> drafted -> done/killed
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    external_id TEXT,           -- e.g. post_id from posts.csv
    idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
    platform TEXT NOT NULL,      -- includes 'blog'
    tone_profile_id INTEGER REFERENCES tone_profiles(id) ON DELETE SET NULL,
    copy TEXT,
    media TEXT NOT NULL DEFAULT '[]',           -- JSON: [{path, altText}]
    platform_fields TEXT NOT NULL DEFAULT '{}', -- JSON: TikTok flags, YT title, hook, cta, etc.
    publish_at TEXT,
    status TEXT NOT NULL DEFAULT 'draft',  -- draft -> approved -> scheduled_local -> submitted -> published | failed | canceled
    blotato_submission_id TEXT,
    public_url TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    captured_at TEXT NOT NULL,
    impressions INTEGER,
    comments INTEGER,
    shares INTEGER,
    saves INTEGER,
    profile_visits INTEGER,
    follows INTEGER,
    dms INTEGER,
    leads INTEGER,
    call_booked INTEGER,
    notes TEXT
  );

  CREATE TABLE IF NOT EXISTS lead_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT,
    person_name TEXT,
    platform TEXT,
    company TEXT,
    role TEXT,
    signal_type TEXT,
    pain_mentioned TEXT,
    post_that_triggered_it TEXT,
    follow_up_needed TEXT,
    status TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_posts_brand ON posts(brand_id);
  CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
  CREATE INDEX IF NOT EXISTS idx_posts_publish_at ON posts(publish_at);
  CREATE INDEX IF NOT EXISTS idx_ideas_brand ON ideas(brand_id);
  CREATE INDEX IF NOT EXISTS idx_accounts_brand ON accounts(brand_id);
  CREATE INDEX IF NOT EXISTS idx_tone_profiles_brand ON tone_profiles(brand_id);
  `,
  // v2 - B4 Blotato worker: retry/verify bookkeeping columns on posts.
  // blotato_submission_id, public_url, error_message already exist from v1;
  // only retry_count and verify_attempts are new.
  `
  ALTER TABLE posts ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE posts ADD COLUMN verify_attempts INTEGER NOT NULL DEFAULT 0;
  `,
  // v3 - B5 idea capture importer: track where an idea came from
  // (manual dashboard entry vs. capture-inbox files vs. telegram-capture).
  `
  ALTER TABLE ideas ADD COLUMN source TEXT NOT NULL DEFAULT 'manual';
  `,
  // v4 - B8 Content Studio: content_type on posts + new tables for image
  // handoff, research/inspiration ingestion, and usage tracking.
  `
  ALTER TABLE posts ADD COLUMN content_type TEXT;

  CREATE TABLE IF NOT EXISTS image_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER REFERENCES posts(id) ON DELETE SET NULL,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    platforms TEXT NOT NULL DEFAULT '[]',   -- JSON array
    content_type TEXT,
    brief TEXT NOT NULL DEFAULT '{}',       -- JSON
    status TEXT NOT NULL DEFAULT 'requested', -- requested -> generated -> picked | canceled
    variants TEXT NOT NULL DEFAULT '[]',    -- JSON: [{path, platform, dims, notes}]
    chosen_path TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS research_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    source TEXT NOT NULL DEFAULT 'manual',  -- google_trends | reddit | best_practice | web | manual
    title TEXT,
    url TEXT,
    body TEXT,
    tags TEXT NOT NULL DEFAULT '[]',        -- JSON array
    captured_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inspiration_profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    handle TEXT,
    platform TEXT,
    name TEXT,
    url TEXT,
    niche TEXT,
    why_relevant TEXT,
    tags TEXT NOT NULL DEFAULT '[]',        -- JSON array
    source TEXT NOT NULL DEFAULT 'manual',  -- manual | ai_suggested
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,                     -- ai_draft | copy_assist | blotato_submit | image_request | image_generated
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    meta TEXT NOT NULL DEFAULT '{}',        -- JSON
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_usage_events_kind ON usage_events(kind);
  CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at);
  CREATE INDEX IF NOT EXISTS idx_image_requests_status ON image_requests(status);
  CREATE INDEX IF NOT EXISTS idx_research_brand ON research_notes(brand_id);
  `,
  // v5 - B11 assisted-manual upgrade + blog redistribution: per-account
  // "assisted-manual" flag, and an `examples` table (pasted text or a
  // screenshot's cached extraction) used to ground the copy assistant/agent.
  `
  ALTER TABLE accounts ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE IF NOT EXISTS examples (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER REFERENCES brands(id) ON DELETE SET NULL,
    platform TEXT,
    source TEXT NOT NULL DEFAULT 'paste',   -- paste | screenshot
    text TEXT,
    image_path TEXT,
    tags TEXT NOT NULL DEFAULT '[]',        -- JSON array
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_examples_brand_platform ON examples(brand_id, platform);
  `,
  // v6 - B13 Brand profiles: canonical store of each brand's per-platform
  // profile fields (heading/bio/etc.), generated in CB's voice or edited by
  // hand, with a lightweight draft/current/stale status for staleness
  // tracking (see src/profiles.js).
  `
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    brand_id INTEGER REFERENCES brands(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    fields TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'draft',
    last_generated_at TEXT,
    last_reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(brand_id, platform)
  );

  CREATE INDEX IF NOT EXISTS idx_profiles_brand ON profiles(brand_id);
  `,
  // v7 - B14 branding: brand logo path, used by the Settings Branding
  // section and folded into the image-request brief so Codex can brand the
  // generated asset (see src/imagespec.js buildBrief).
  `
  ALTER TABLE brands ADD COLUMN logo_path TEXT;
  `,
];

function applyMigrations(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let v = current; v < MIGRATIONS.length; v++) {
    const migration = MIGRATIONS[v];
    const run = db.transaction(() => {
      db.exec(migration);
      db.pragma(`user_version = ${v + 1}`);
    });
    run();
    console.log(`[db] applied migration v${v + 1}`);
  }
}

export function getDb() {
  if (dbInstance) return dbInstance;
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  dbInstance = db;
  return dbInstance;
}

export function nowIso() {
  return new Date().toISOString();
}

export { DB_PATH };
