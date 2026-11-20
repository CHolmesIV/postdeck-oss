// Seeds brands + accounts from config/accounts.seed.json (gitignored, your real
// Blotato account ids) and creates the three tone_profiles (business/personal/casual)
// per brand. If that file is missing, falls back to config/accounts.seed.example.json
// and loads a few demo posts, so a fresh clone runs with no setup and no API key
// (BLOTATO_DRY_RUN=1 is the default).
//
// Voice docs are NOT read here, only their paths are stored as placeholder notes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, nowIso, DB_PATH } from './db.js';
import { seedProfilesFromFile } from './profiles.js';
import { importPosts, importClusters } from './import.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'config', 'accounts.seed.json');
const EXAMPLE_SEED_PATH = path.join(ROOT, 'config', 'accounts.seed.example.json');
// Optional drafted profile copy (LinkedIn/Facebook/Reddit), written against
// config/profile-specs.json. Skipped when the file is absent. Idempotent (upsert),
// and only applied if the brand from its brand_slug already exists.
const PROFILE_SEED_PATH = path.join(ROOT, 'config', 'profile-seed.json');

// Voice doc reference per brand slug: placeholder text pointing at the real doc.
// Add entries here (or set brands.voice_doc_path in Settings) to use your own docs.
const VOICE_DOC_PATHS = {};

const TONE_NAMES = ['business', 'personal', 'casual'];
const HARD_RULES_DEFAULT = JSON.stringify({ no_em_dash: true });

function voiceRulesPlaceholder(brandName, slug, tone) {
  const docPath = VOICE_DOC_PATHS[slug] || '(voice doc path not set)';
  return `Voice reference for ${brandName} (${tone} tone): see ${docPath}. ` +
    `Placeholder - populate with real style guidance extracted from that doc.`;
}

export function seed() {
  const demo = !fs.existsSync(SEED_PATH);
  const db = getDb();
  const seedData = JSON.parse(fs.readFileSync(demo ? EXAMPLE_SEED_PATH : SEED_PATH, 'utf8'));

  const insertBrand = db.prepare(`
    INSERT INTO brands (name, slug, colors, voice_doc_path, active, created_at, updated_at)
    VALUES (@name, @slug, @colors, @voice_doc_path, 1, @now, @now)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      voice_doc_path = excluded.voice_doc_path,
      updated_at = excluded.updated_at
  `);
  const getBrandBySlug = db.prepare('SELECT * FROM brands WHERE slug = ?');

  const insertAccount = db.prepare(`
    INSERT INTO accounts (brand_id, platform, blotato_account_id, target_fields, active, created_at, updated_at)
    VALUES (@brand_id, @platform, @blotato_account_id, @target_fields, 1, @now, @now)
  `);
  // blotato_account_id can be NULL (e.g. a reddit row, assisted-manual,
  // never connected in Blotato per SPEC.md). "= ?" never matches NULL in
  // SQLite, so use IS for that comparison; IS accepts bound params fine.
  const findAccountById = db.prepare(`
    SELECT * FROM accounts WHERE brand_id = ? AND platform = ? AND blotato_account_id = ?
  `);
  const findAccountNullId = db.prepare(`
    SELECT * FROM accounts WHERE brand_id = ? AND platform = ? AND blotato_account_id IS NULL
  `);
  function findAccount(brandId, platform, blotatoAccountId) {
    return blotatoAccountId == null
      ? findAccountNullId.get(brandId, platform)
      : findAccountById.get(brandId, platform, blotatoAccountId);
  }

  const insertTone = db.prepare(`
    INSERT INTO tone_profiles (brand_id, name, voice_rules, hard_rules, created_at, updated_at)
    VALUES (@brand_id, @name, @voice_rules, @hard_rules, @now, @now)
    ON CONFLICT(brand_id, name) DO UPDATE SET
      voice_rules = excluded.voice_rules,
      updated_at = excluded.updated_at
  `);

  const summary = { brands: 0, accounts: 0, tone_profiles: 0, profiles: 0, demo };

  const run = db.transaction(() => {
    for (const brandSeed of seedData.brands) {
      const now = nowIso();
      insertBrand.run({
        name: brandSeed.name,
        slug: brandSeed.slug,
        colors: JSON.stringify(brandSeed.colors || {}),
        voice_doc_path: VOICE_DOC_PATHS[brandSeed.slug] || null,
        now,
      });
      const brand = getBrandBySlug.get(brandSeed.slug);
      summary.brands++;

      for (const acct of brandSeed.accounts || []) {
        // Tolerate accounts with no Blotato connection yet (IG/TikTok not
        // connected; reddit never will be, it's assisted-manual). Their
        // blotato_account_id stays NULL rather than the string "null".
        const acctId = acct.blotato_account_id == null ? null : String(acct.blotato_account_id);
        const existing = findAccount(brand.id, acct.platform, acctId);
        if (existing) continue;
        insertAccount.run({
          brand_id: brand.id,
          platform: acct.platform,
          blotato_account_id: acctId,
          target_fields: JSON.stringify(acct.target_fields || {}),
          now,
        });
        summary.accounts++;
      }

      for (const tone of TONE_NAMES) {
        insertTone.run({
          brand_id: brand.id,
          name: tone,
          voice_rules: voiceRulesPlaceholder(brand.name, brand.slug, tone),
          hard_rules: HARD_RULES_DEFAULT,
          now,
        });
        summary.tone_profiles++;
      }
    }
  });

  run();

  // Optional drafted profile copy, if the seed file exists and its brand_slug
  // resolves to an already-seeded brand. Guarded + idempotent so it never breaks
  // the rest of seed() if the file is missing/malformed.
  if (fs.existsSync(PROFILE_SEED_PATH)) {
    try {
      summary.profiles += seedProfilesFromFile(db, PROFILE_SEED_PATH);
    } catch (err) {
      console.error('[seed] profile seed skipped:', err.message);
    }
  }

  if (demo) seedDemoContent(seedData.brands[0]?.slug);
  return summary;
}

// Demo ideas and posts with dates relative to today, so the calendar is never empty.
function seedDemoContent(slug) {
  if (!slug) return;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-demo-'));
  try {
    const clusters = path.join(dir, 'clusters.csv');
    fs.copyFileSync(path.join(ROOT, 'samples', 'clusters.sample.csv'), clusters);
    importClusters(clusters, slug);
    const posts = path.join(dir, 'posts.csv');
    const rows = [
      'post_id,cluster_id,platform,post_copy,publish_date,publish_time,status',
      `D1,C1,linkedin,"We shipped 14 small releases last month. Here is what changed in how we plan.",${day(1)},09:00,draft`,
      `D2,C2,twitter,"Launch week checklist: freeze scope, test the rollback, write the support macro, sleep.",${day(2)},12:30,draft`,
      `D3,C3,facebook,"You asked, we built it. Three requests that made the roadmap this quarter.",${day(4)},10:00,draft`,
      `D4,C1,linkedin,"Small releases beat big launches. A short note on why.",${day(6)},09:00,draft`,
    ];
    fs.writeFileSync(posts, rows.join('\n') + '\n');
    importPosts(posts, slug);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// CLI entry point
// Audit 2026-09-02 guard: seeding is an upsert that overwrites brand names,
// voice_doc_path, tone voice_rules and seeded profile fields. Running it by
// accident against a populated live DB silently discards hand edits made in
// Settings. Refuse unless the DB is empty, or --force is passed explicitly.
function assertSafeToSeed() {
  if (process.argv.includes('--force')) return;
  const db = getDb();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM brands').get();
  if (n > 0) {
    console.error(
      `[seed] refusing: this database already has ${n} brand(s) (${DB_PATH}). ` +
        'Seeding overwrites brand names, voice docs, tone voice_rules and seeded profiles. ' +
        'Re-run with --force if that is what you want.'
    );
    process.exit(2);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  assertSafeToSeed();
  try {
    const summary = seed();
    console.log('[seed] done:', summary);
  } catch (err) {
    console.error('[seed] failed:', err.message);
    process.exit(1);
  }
}
