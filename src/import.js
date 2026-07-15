// CLI CSV importers for the existing brand-system files.
//
// Usage:
//   node src/import.js clusters <path/to/content_clusters.csv>
//   node src/import.js posts    <path/to/posts.csv>
//   node src/import.js leads    <path/to/lead_signals.csv>
//
// Brand is inferred from the file path (contains "dihy" -> dihy, else cholmesiv).
// Re-running an importer against the same file updates existing rows (matched by
// external_id + brand) instead of duplicating them.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getDb, nowIso } from './db.js';

// ---------- tiny CSV parser (handles quoted fields, embedded commas/newlines, "" escapes) ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  // Normalize line endings but keep embedded \n inside quoted fields intact.
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else {
      if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\r') {
        // skip, \n handles the newline
      } else if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else {
        field += c;
      }
    }
  }
  // last field/row (file may or may not end with newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

function csvToObjects(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    header.forEach((h, idx) => {
      obj[h] = r[idx] !== undefined ? r[idx] : '';
    });
    return obj;
  });
}

function readCsvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return csvToObjects(text);
}

// ---------- helpers ----------

function inferBrandSlug(filePath) {
  return filePath.toLowerCase().includes('dihy') ? 'dihy' : 'cholmesiv';
}

function blank(v) {
  return v === undefined || v === null || v.trim() === '' ? null : v.trim();
}

function toInt(v) {
  const n = blank(v);
  if (n === null) return null;
  const parsed = parseInt(n, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

// Normalize free-text platform names from the CSVs to account/post platform slugs.
const PLATFORM_MAP = {
  linkedin: 'linkedin',
  'linkedin company page': 'linkedin',
  facebook: 'facebook',
  'facebook page': 'facebook',
  x: 'twitter',
  twitter: 'twitter',
  instagram: 'instagram',
  tiktok: 'tiktok',
  threads: 'threads',
  youtube: 'youtube',
  blog: 'blog',
};

function normalizePlatform(raw) {
  const v = blank(raw);
  if (!v) return null;
  return PLATFORM_MAP[v.toLowerCase()] || v.toLowerCase();
}

// Normalize free-text idea/post status values to the schema's status enums.
function normalizeIdeaStatus(raw) {
  const v = blank(raw);
  if (!v) return 'idea';
  const lower = v.toLowerCase();
  if (['idea', 'clustered', 'drafted', 'done', 'killed'].includes(lower)) return lower;
  if (lower === 'scheduled') return 'clustered';
  return 'idea';
}

function normalizePostStatus(raw) {
  const v = blank(raw);
  if (!v) return 'draft';
  const lower = v.toLowerCase();
  const known = ['draft', 'approved', 'scheduled_local', 'submitted', 'published', 'failed', 'canceled'];
  if (known.includes(lower)) return lower;
  if (lower === 'scheduled') return 'scheduled_local';
  return 'draft';
}

function combineDateTime(dateStr, timeStr) {
  const d = blank(dateStr);
  if (!d) return null;
  const t = blank(timeStr) || '00:00';
  const iso = `${d}T${t.length === 5 ? t + ':00' : t}`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function getBrand(db, slug) {
  const brand = db.prepare('SELECT * FROM brands WHERE slug = ?').get(slug);
  if (!brand) {
    throw new Error(`Brand '${slug}' not found - run "node src/seed.js" first.`);
  }
  return brand;
}

function findAccount(db, brandId, platform) {
  if (!platform) return null;
  return db
    .prepare('SELECT * FROM accounts WHERE brand_id = ? AND platform = ? AND active = 1 LIMIT 1')
    .get(brandId, platform);
}

// ---------- importers ----------

function importClusters(filePath) {
  const db = getDb();
  const brandSlug = inferBrandSlug(filePath);
  const brand = getBrand(db, brandSlug);
  const rows = readCsvFile(filePath);

  const findExisting = db.prepare('SELECT id FROM ideas WHERE brand_id = ? AND external_id = ?');
  const insert = db.prepare(`
    INSERT INTO ideas (brand_id, external_id, title, pillar, target_icp, source_material, notes, status, created_at, updated_at)
    VALUES (@brand_id, @external_id, @title, @pillar, @target_icp, @source_material, @notes, @status, @now, @now)
  `);
  const update = db.prepare(`
    UPDATE ideas SET title=@title, pillar=@pillar, target_icp=@target_icp, source_material=@source_material,
      notes=@notes, status=@status, updated_at=@now
    WHERE id=@id
  `);

  let inserted = 0;
  let updated = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      const externalId = blank(r.cluster_id);
      if (!externalId) continue;
      const now = nowIso();
      const payload = {
        brand_id: brand.id,
        external_id: externalId,
        title: blank(r.core_idea),
        pillar: blank(r.pillar),
        target_icp: blank(r.target_icp),
        source_material: blank(r.source_material),
        notes: [blank(r.notes), blank(r.raw_input_link) ? `raw_input_link: ${r.raw_input_link}` : null]
          .filter(Boolean)
          .join(' | ') || null,
        status: normalizeIdeaStatus(r.status),
        now,
      };
      const existing = findExisting.get(brand.id, externalId);
      if (existing) {
        update.run({ ...payload, id: existing.id });
        updated++;
      } else {
        insert.run(payload);
        inserted++;
      }
    }
  });
  run();
  return { brand: brandSlug, file: filePath, rows: rows.length, inserted, updated };
}

function importPosts(filePath) {
  const db = getDb();
  const brandSlug = inferBrandSlug(filePath);
  const brand = getBrand(db, brandSlug);
  const rows = readCsvFile(filePath);

  const findExisting = db.prepare('SELECT id FROM posts WHERE brand_id = ? AND external_id = ?');
  const findIdea = db.prepare('SELECT id FROM ideas WHERE brand_id = ? AND external_id = ?');

  const insertPost = db.prepare(`
    INSERT INTO posts (
      external_id, idea_id, brand_id, account_id, platform, copy, media, platform_fields,
      publish_at, status, blotato_submission_id, public_url, error_message, created_at, updated_at
    ) VALUES (
      @external_id, @idea_id, @brand_id, @account_id, @platform, @copy, @media, @platform_fields,
      @publish_at, @status, @blotato_submission_id, @public_url, @error_message, @now, @now
    )
  `);
  const updatePost = db.prepare(`
    UPDATE posts SET idea_id=@idea_id, account_id=@account_id, platform=@platform, copy=@copy,
      media=@media, platform_fields=@platform_fields, publish_at=@publish_at, status=@status,
      blotato_submission_id=@blotato_submission_id, public_url=@public_url, error_message=@error_message,
      updated_at=@now
    WHERE id=@id
  `);
  const insertMetric = db.prepare(`
    INSERT INTO metrics (post_id, captured_at, impressions, comments, shares, saves, profile_visits, follows, dms, leads, call_booked, notes)
    VALUES (@post_id, @captured_at, @impressions, @comments, @shares, @saves, @profile_visits, @follows, @dms, @leads, @call_booked, @notes)
  `);
  const deleteMetrics = db.prepare('DELETE FROM metrics WHERE post_id = ?');

  let inserted = 0;
  let updated = 0;
  let metricsWritten = 0;

  const run = db.transaction(() => {
    for (const r of rows) {
      const externalId = blank(r.post_id);
      if (!externalId) continue;
      const platform = normalizePlatform(r.platform);
      const account = findAccount(db, brand.id, platform);
      const idea = blank(r.cluster_id) ? findIdea.get(brand.id, blank(r.cluster_id)) : null;
      const now = nowIso();

      // Extract public_url from performance_notes if present (matches "Live URL: ..." convention).
      let publicUrl = null;
      const perfNotes = blank(r.performance_notes);
      if (perfNotes) {
        const m = perfNotes.match(/Live URL:\s*(\S+)/i);
        if (m) publicUrl = m[1];
      }

      const media = blank(r.visual_asset_link)
        ? JSON.stringify([{ path: r.visual_asset_link.trim(), altText: null }])
        : '[]';

      const platformFields = JSON.stringify({
        format: blank(r.format),
        hook: blank(r.hook),
        pain_point: blank(r.pain_point),
        cta_type: blank(r.cta_type),
        cta_destination: blank(r.cta_destination),
        lane: blank(r.lane),
        performance_notes: perfNotes,
      });

      const payload = {
        external_id: externalId,
        idea_id: idea ? idea.id : null,
        brand_id: brand.id,
        account_id: account ? account.id : null,
        platform: platform || 'unknown',
        copy: blank(r.post_copy),
        media,
        platform_fields: platformFields,
        publish_at: combineDateTime(r.publish_date, r.publish_time),
        status: normalizePostStatus(r.status),
        blotato_submission_id: blank(r.blotato_post_id),
        public_url: publicUrl,
        error_message: null,
        now,
      };

      const existing = findExisting.get(brand.id, externalId);
      let postId;
      if (existing) {
        updatePost.run({ ...payload, id: existing.id });
        postId = existing.id;
        updated++;
      } else {
        const info = insertPost.run(payload);
        postId = info.lastInsertRowid;
        inserted++;
      }

      // metrics: only write a row if at least one metric column has a value
      const metricCols = {
        impressions: toInt(r.impressions),
        comments: toInt(r.comments),
        shares: toInt(r.shares),
        saves: toInt(r.saves),
        profile_visits: toInt(r.profile_visits),
        follows: toInt(r.follows),
        dms: toInt(r.dms),
        leads: toInt(r.leads),
        call_booked: toInt(r.call_booked),
      };
      const hasMetrics = Object.values(metricCols).some((v) => v !== null);
      if (hasMetrics) {
        deleteMetrics.run(postId); // re-import is idempotent: replace prior snapshot from this CSV
        insertMetric.run({ post_id: postId, captured_at: now, notes: null, ...metricCols });
        metricsWritten++;
      }
    }
  });
  run();
  return { brand: brandSlug, file: filePath, rows: rows.length, inserted, updated, metricsWritten };
}

function importLeads(filePath) {
  const db = getDb();
  const rows = readCsvFile(filePath);

  const insert = db.prepare(`
    INSERT INTO lead_signals (
      date, person_name, platform, company, role, signal_type, pain_mentioned,
      post_that_triggered_it, follow_up_needed, status, notes, created_at
    ) VALUES (
      @date, @person_name, @platform, @company, @role, @signal_type, @pain_mentioned,
      @post_that_triggered_it, @follow_up_needed, @status, @notes, @now
    )
  `);

  let inserted = 0;
  const run = db.transaction(() => {
    for (const r of rows) {
      // skip fully-empty rows (e.g. header-only CSVs with a trailing blank line)
      if (Object.values(r).every((v) => blank(v) === null)) continue;
      insert.run({
        date: blank(r.date),
        person_name: blank(r.person_name),
        platform: blank(r.platform),
        company: blank(r.company),
        role: blank(r.role),
        signal_type: blank(r.signal_type),
        pain_mentioned: blank(r.pain_mentioned),
        post_that_triggered_it: blank(r.post_that_triggered_it),
        follow_up_needed: blank(r.follow_up_needed),
        status: blank(r.status),
        notes: blank(r.notes),
        now: nowIso(),
      });
      inserted++;
    }
  });
  run();
  return { file: filePath, rows: rows.length, inserted };
}

// ---------- CLI ----------

function main() {
  const [, , command, filePath] = process.argv;
  if (!command || !filePath) {
    console.error('Usage: node src/import.js <clusters|posts|leads> <path/to.csv>');
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    console.error(`File not found: ${resolved}`);
    process.exit(1);
  }

  let result;
  switch (command) {
    case 'clusters':
      result = importClusters(resolved);
      break;
    case 'posts':
      result = importPosts(resolved);
      break;
    case 'leads':
      result = importLeads(resolved);
      break;
    default:
      console.error(`Unknown importer: ${command} (expected clusters|posts|leads)`);
      process.exit(1);
  }
  console.log(`[import:${command}]`, result);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}

export { importClusters, importPosts, importLeads, parseCsv, csvToObjects };
