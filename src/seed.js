// Seeds brands + accounts from config/accounts.seed.json (real, gitignored),
// and creates the three tone_profiles (business/personal/casual) per brand.
//
// Voice docs are NOT read here - only their paths are stored as placeholder notes,
// per SPEC.md ("Draft with AI" loads them at generation time later).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getDb, nowIso } from './db.js';
import { seedProfilesFromFile } from './profiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SEED_PATH = path.join(ROOT, 'config', 'accounts.seed.json');
// B13: PrimeWright's drafted profile copy (LinkedIn/Facebook/Reddit), written
// against config/profile-specs.json. Optional - guarded, idempotent (upsert),
// and only applied if the brand from its brand_slug already exists.
const PROFILE_SEED_PATH = path.join(ROOT, 'config', 'profile-seed.primewright.json');

// Voice doc reference per brand slug - placeholder text pointing at the real doc.
const VOICE_DOC_PATHS = {
  cholmesiv: 'docs/brand-voice-reference.md',
  dihy: 'brands/dihy/dihy-social-content-system.md',
};

const TONE_NAMES = ['business', 'personal', 'casual'];
const HARD_RULES_DEFAULT = JSON.stringify({ no_em_dash: true });

function voiceRulesPlaceholder(brandName, slug, tone) {
  const docPath = VOICE_DOC_PATHS[slug] || '(voice doc path not set)';
  return `Voice reference for ${brandName} (${tone} tone): see ${docPath}. ` +
    `Placeholder - populate with real style guidance extracted from that doc.`;
}

export function seed() {
  if (!fs.existsSync(SEED_PATH)) {
    throw new Error(
      `Seed file not found: ${SEED_PATH}\n` +
      `Copy config/accounts.seed.example.json to config/accounts.seed.json and fill in real Blotato account IDs.`
    );
  }

  const db = getDb();
  const seedData = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));

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
  // blotato_account_id can be NULL (e.g. a reddit row - assisted-manual,
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

  const summary = { brands: 0, accounts: 0, tone_profiles: 0, profiles: 0 };

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
        // connected; reddit never will be - it's assisted-manual). Their
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

  // B13: PrimeWright's drafted profile copy, if the seed file exists (it's
  // committed content, unlike accounts.seed.json's real Blotato ids) and
  // its brand_slug resolves to an already-seeded brand. Guarded + idempotent
  // so it never breaks the rest of seed() if the file is missing/malformed.
  if (fs.existsSync(PROFILE_SEED_PATH)) {
    try {
      summary.profiles += seedProfilesFromFile(db, PROFILE_SEED_PATH);
    } catch (err) {
      console.error('[seed] profile seed skipped:', err.message);
    }
  }

  return summary;
}

// CLI entry point
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    const summary = seed();
    console.log('[seed] done:', summary);
  } catch (err) {
    console.error('[seed] failed:', err.message);
    process.exit(1);
  }
}
