// Fastify API - localhost only (127.0.0.1).
// B1: read-only skeleton. B2/B3 add the dashboard (public/) + write/lifecycle
// endpoints (posts, ideas, media, metrics, AI drafting, blog preview).

import './env.js';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { getDb, nowIso } from './db.js';
import { draftWithAi, PLATFORM_LIMITS } from './draft.js';
import { markdownToHtml, escapeHtml } from './md.js';
import { startWorker, submitNow, getWorkerStatus } from './worker.js';
import { buildSocialState } from './export.js';
import { validateTiktokFields } from './validate.js';
import { getAllSettings, updateSettings, isWithinQuietHours } from './settings.js';
import { loadPlatformSpecs } from './platforms.js';
import { buildAnalytics } from './analytics.js';
import { recordUsage, buildUsageStats } from './usage.js';
import { copyAssist } from './copy_assist.js';
import { recommendContentType } from './recommend.js';
import { runAgent } from './agent.js';
import { extractFromImage } from './extract.js';
import { listExamples, createExample, deleteExample, examplesGrounding } from './examples.js';
import { redistributeFromUrl } from './redistribute.js';
import { listProfiles, getProfile, getProfileById, upsertProfile, generateProfile } from './profiles.js';
import {
  resolveVoice,
  withGlobalVoice,
  getGlobalVoice,
  setGlobalVoice,
  getGlobalHardRules,
  setGlobalHardRules,
  seedGlobalVoiceIfMissing,
  getRawSetting,
  setRawSetting,
} from './voice.js';
import {
  listResearch,
  createResearchNote,
  updateResearchNote,
  deleteResearchNote,
  importResearchText,
  groundingForBrand,
} from './research.js';
import {
  listInspiration,
  createInspiration,
  updateInspiration,
  deleteInspiration,
  suggestProfiles,
} from './inspiration.js';
import {
  buildBrief,
  createImageRequest,
  regenerateImageRequest,
  listImageRequests,
  getImageRequest,
  pickVariant,
  cancelImageRequest,
} from './imagespec.js';
import { resizeToDims, resizeForPlatforms, sipsAvailable } from './resize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const MEDIA_DIR = process.env.POSTDECK_MEDIA_DIR || path.join(ROOT, 'media');
const PUBLIC_DIR = path.join(ROOT, 'public');

// Confine a client-supplied media path (e.g. "media/123-file.png") to MEDIA_DIR.
// Returns the resolved absolute path, or null if it escapes MEDIA_DIR (absolute
// path elsewhere, or ../ traversal). Endpoints that hand a caller-provided path
// to sips/the vision model MUST use this - otherwise a request (e.g. from a
// malicious page hitting localhost) could read arbitrary image files off disk.
function resolveMediaPath(clientPath) {
  if (typeof clientPath !== 'string' || !clientPath) return null;
  const candidate = path.resolve(MEDIA_DIR, path.basename(clientPath));
  // basename() alone drops any directory component, so the result is always a
  // direct child of MEDIA_DIR. Double-check the boundary defensively.
  const rel = path.relative(MEDIA_DIR, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return candidate;
}

const PORT = Number(process.env.PORT) || 4520;
const HOST = '127.0.0.1'; // localhost only - never bind 0.0.0.0 (see SPEC.md)

// draft -> approved -> canceled only, in this phase (no Blotato yet).
const ALLOWED_POST_TRANSITIONS = {
  draft: ['approved', 'canceled'],
  approved: ['canceled'],
  // scheduled_local is 'approved' + a publish_at (see merge logic below) - the
  // dashboard already offers Cancel for it (public/app.js renderPostDetail),
  // so it needs the same escape hatch.
  scheduled_local: ['canceled'],
};

// B6: publish_at (drag-to-reschedule, or any manual date edit) may only
// change while a post hasn't been handed off to Blotato yet. Once it's
// submitted, edits happen in Blotato's own dashboard (see SPEC.md Decision 1).
const RESCHEDULABLE_STATUSES = ['draft', 'approved', 'scheduled_local'];

function buildServer() {
  const app = Fastify({ logger: true });
  const db = getDb();
  seedGlobalVoiceIfMissing(db);

  fs.mkdirSync(MEDIA_DIR, { recursive: true });

  app.register(fastifyMultipart, {
    limits: { fileSize: 50 * 1024 * 1024 },
  });

  // Serve the media library at /media/<file>
  app.register(fastifyStatic, {
    root: MEDIA_DIR,
    prefix: '/media/',
    decorateReply: false,
  });

  // Serve the dashboard SPA (vanilla JS, no build step) at /
  app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    prefix: '/',
    decorateReply: true,
  });

  function parseJsonColumns(row, columns) {
    if (!row) return row;
    const out = { ...row };
    for (const col of columns) {
      if (out[col] != null) {
        try {
          out[col] = JSON.parse(out[col]);
        } catch {
          // leave as raw string if it's not valid JSON
        }
      }
    }
    return out;
  }

  // ---------- health ----------
  app.get('/api/health', async () => {
    return { ok: true, time: new Date().toISOString(), db: 'connected' };
  });

  // ---------- brands ----------
  app.get('/api/brands', async () => {
    const rows = db.prepare('SELECT * FROM brands ORDER BY id').all();
    return rows.map((r) => parseJsonColumns(r, ['colors']));
  });

  // ---------- B14: branding (logo/colors/voice-doc) in Settings ----------
  app.patch('/api/brands/:id', async (req, reply) => {
    const existing = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const now = nowIso();
    const merged = {
      name: b.name !== undefined ? b.name : existing.name,
      colors:
        b.colors !== undefined ? (typeof b.colors === 'string' ? b.colors : JSON.stringify(b.colors)) : existing.colors,
      logo_path: b.logo_path !== undefined ? b.logo_path : existing.logo_path,
      voice_doc_path: b.voice_doc_path !== undefined ? b.voice_doc_path : existing.voice_doc_path,
      now,
      id: req.params.id,
    };
    db.prepare(
      `UPDATE brands SET name = @name, colors = @colors, logo_path = @logo_path, voice_doc_path = @voice_doc_path,
       updated_at = @now WHERE id = @id`
    ).run(merged);
    const row = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
    return parseJsonColumns(row, ['colors']);
  });

  // Multipart logo upload - mirrors POST /api/media, but also stamps
  // brands.logo_path so the image brief + Settings preview pick it up.
  app.post('/api/brands/:id/logo', async (req, reply) => {
    const existing = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const data = await req.file();
    if (!data) {
      reply.code(400);
      return { error: 'no file uploaded (expected multipart field "file")' };
    }
    const safeName = `${Date.now()}-logo-${data.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const dest = path.join(MEDIA_DIR, safeName);
    await pipeline(data.file, fs.createWriteStream(dest));
    const logoPath = `media/${safeName}`;
    db.prepare('UPDATE brands SET logo_path = ?, updated_at = ? WHERE id = ?').run(logoPath, nowIso(), req.params.id);
    const row = db.prepare('SELECT * FROM brands WHERE id = ?').get(req.params.id);
    reply.code(201);
    return parseJsonColumns(row, ['colors']);
  });

  // ---------- accounts ----------
  app.get('/api/accounts', async (req) => {
    const { brand } = req.query;
    let rows;
    if (brand) {
      rows = db
        .prepare(`
          SELECT a.* FROM accounts a
          JOIN brands b ON b.id = a.brand_id
          WHERE b.slug = ? OR a.brand_id = ?
          ORDER BY a.id
        `)
        .all(brand, brand);
    } else {
      rows = db.prepare('SELECT * FROM accounts ORDER BY id').all();
    }
    return rows.map((r) => parseJsonColumns(r, ['target_fields']));
  });

  // ---------- B11: toggle assisted-manual per account ----------
  // accounts.manual=1 means "assisted-manual" - the worker handoff must
  // never submit this account to Blotato (SPEC.md "Assisted-manual upgrade").
  // Tolerant of a minimal payload: only `manual` is required to change here.
  app.patch('/api/accounts/:id', async (req, reply) => {
    const existing = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const now = nowIso();
    const merged = {
      manual: b.manual !== undefined ? (b.manual ? 1 : 0) : existing.manual,
      target_fields: b.target_fields !== undefined ? JSON.stringify(b.target_fields) : existing.target_fields,
      active: b.active !== undefined ? (b.active ? 1 : 0) : existing.active,
      now,
      id: req.params.id,
    };
    db.prepare(
      `UPDATE accounts SET manual = @manual, target_fields = @target_fields, active = @active, updated_at = @now WHERE id = @id`
    ).run(merged);
    const row = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.id);
    return parseJsonColumns(row, ['target_fields']);
  });

  // ---------- ideas ----------
  app.get('/api/ideas', async (req) => {
    const { brand, status } = req.query;
    const clauses = [];
    const params = [];
    let sql = `
      SELECT i.* FROM ideas i
      LEFT JOIN brands b ON b.id = i.brand_id
      WHERE 1=1
    `;
    if (brand) {
      clauses.push('(b.slug = ? OR i.brand_id = ?)');
      params.push(brand, brand);
    }
    if (status) {
      clauses.push('i.status = ?');
      params.push(status);
    }
    if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
    sql += ' ORDER BY i.id';
    const rows = db.prepare(sql).all(...params);
    return rows;
  });

  // ---------- posts ----------
  app.get('/api/posts', async (req) => {
    const { brand, status, from, to } = req.query;
    const clauses = [];
    const params = [];
    let sql = `
      SELECT p.* FROM posts p
      LEFT JOIN brands b ON b.id = p.brand_id
      WHERE 1=1
    `;
    if (brand) {
      clauses.push('(b.slug = ? OR p.brand_id = ?)');
      params.push(brand, brand);
    }
    if (status) {
      clauses.push('p.status = ?');
      params.push(status);
    }
    if (from) {
      clauses.push('p.publish_at >= ?');
      params.push(from);
    }
    if (to) {
      clauses.push('p.publish_at <= ?');
      params.push(to);
    }
    if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
    sql += ' ORDER BY p.publish_at IS NULL, p.publish_at';
    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => parseJsonColumns(r, ['media', 'platform_fields']));
  });

  app.get('/api/posts/:id', async (req, reply) => {
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const post = parseJsonColumns(row, ['media', 'platform_fields']);
    post.metrics = db
      .prepare('SELECT * FROM metrics WHERE post_id = ? ORDER BY captured_at DESC')
      .all(req.params.id);
    return post;
  });

  // ---------- posts: create / edit / lifecycle ----------
  app.post('/api/posts', async (req, reply) => {
    const b = req.body || {};
    if (!b.platform) {
      reply.code(400);
      return { error: 'platform is required' };
    }
    const now = nowIso();
    const info = db
      .prepare(
        `
        INSERT INTO posts (
          external_id, idea_id, brand_id, account_id, platform, tone_profile_id,
          copy, media, platform_fields, content_type, publish_at, status, created_at, updated_at
        ) VALUES (
          @external_id, @idea_id, @brand_id, @account_id, @platform, @tone_profile_id,
          @copy, @media, @platform_fields, @content_type, @publish_at, 'draft', @now, @now
        )
      `
      )
      .run({
        external_id: b.external_id || null,
        idea_id: b.idea_id || null,
        brand_id: b.brand_id || null,
        account_id: b.account_id || null,
        platform: b.platform,
        tone_profile_id: b.tone_profile_id || null,
        copy: b.copy || '',
        media: JSON.stringify(b.media || []),
        platform_fields: JSON.stringify(b.platform_fields || {}),
        content_type: b.content_type || null,
        publish_at: b.publish_at || null,
        now,
      });
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(info.lastInsertRowid);
    reply.code(201);
    return parseJsonColumns(row, ['media', 'platform_fields']);
  });

  app.patch('/api/posts/:id', async (req, reply) => {
    const existing = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const now = nowIso();

    let nextStatus = existing.status;
    if (b.status && b.status !== existing.status) {
      const allowed = ALLOWED_POST_TRANSITIONS[existing.status] || [];
      if (!allowed.includes(b.status)) {
        reply.code(409);
        return {
          error: 'invalid_transition',
          message: `Cannot move post from '${existing.status}' to '${b.status}'. Allowed: ${allowed.join(', ') || '(none)'}`,
        };
      }
      nextStatus = b.status;
    }

    // scheduled_local supersedes a plain 'approved' status when a publish_at
    // is already set at approve time (see SPEC.md worker/handoff section).
    const publishAt = b.publish_at !== undefined ? b.publish_at : existing.publish_at;
    if (nextStatus === 'approved' && publishAt) {
      nextStatus = 'scheduled_local';
    }

    // ---- B6: drag-to-reschedule guard ----
    // Any change to publish_at (calendar drag included) is only allowed while
    // the post is still local - draft/approved/scheduled_local.
    if (b.publish_at !== undefined && b.publish_at !== existing.publish_at) {
      if (!RESCHEDULABLE_STATUSES.includes(existing.status)) {
        reply.code(409);
        return {
          error: 'not_reschedulable',
          message: `Cannot change publish_at for a post in status '${existing.status}'. Only draft/approved/scheduled_local posts can be rescheduled locally - edit in Blotato's dashboard instead.`,
        };
      }
    }

    // ---- B6: TikTok cosmetic-field validation on the Approve gate ----
    // Fires when a post is crossing INTO approved/scheduled_local from a
    // status that wasn't already there (i.e. the human Approve action).
    const enteringApprovedGate =
      ['approved', 'scheduled_local'].includes(nextStatus) &&
      !['approved', 'scheduled_local'].includes(existing.status);
    if (enteringApprovedGate && existing.platform === 'tiktok') {
      let pf = existing.platform_fields;
      if (b.platform_fields !== undefined) {
        pf = b.platform_fields;
      } else {
        try {
          pf = JSON.parse(pf || '{}');
        } catch {
          pf = {};
        }
      }
      const { ok, missing } = validateTiktokFields(pf || {});
      if (!ok) {
        reply.code(422);
        return {
          error: 'tiktok_fields_missing',
          message: `TikTok post is missing required fields: ${missing.join(', ')}`,
          missing,
        };
      }
    }

    const merged = {
      copy: b.copy !== undefined ? b.copy : existing.copy,
      media: b.media !== undefined ? JSON.stringify(b.media) : existing.media,
      platform_fields:
        b.platform_fields !== undefined ? JSON.stringify(b.platform_fields) : existing.platform_fields,
      content_type: b.content_type !== undefined ? b.content_type : existing.content_type,
      publish_at: publishAt,
      account_id: b.account_id !== undefined ? b.account_id : existing.account_id,
      tone_profile_id: b.tone_profile_id !== undefined ? b.tone_profile_id : existing.tone_profile_id,
      status: nextStatus,
      now,
      id: req.params.id,
    };

    db.prepare(
      `
      UPDATE posts SET
        copy = @copy, media = @media, platform_fields = @platform_fields,
        content_type = @content_type, publish_at = @publish_at, account_id = @account_id,
        tone_profile_id = @tone_profile_id, status = @status, updated_at = @now
      WHERE id = @id
    `
    ).run(merged);

    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    return parseJsonColumns(row, ['media', 'platform_fields']);
  });

  // ---------- posts: manual metrics entry ----------
  app.post('/api/posts/:id/metrics', async (req, reply) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const now = nowIso();
    const info = db
      .prepare(
        `
        INSERT INTO metrics (
          post_id, captured_at, impressions, comments, shares, saves,
          profile_visits, follows, dms, leads, call_booked, notes
        ) VALUES (
          @post_id, @captured_at, @impressions, @comments, @shares, @saves,
          @profile_visits, @follows, @dms, @leads, @call_booked, @notes
        )
      `
      )
      .run({
        post_id: req.params.id,
        captured_at: b.captured_at || now,
        impressions: b.impressions ?? null,
        comments: b.comments ?? null,
        shares: b.shares ?? null,
        saves: b.saves ?? null,
        profile_visits: b.profile_visits ?? null,
        follows: b.follows ?? null,
        dms: b.dms ?? null,
        leads: b.leads ?? null,
        call_booked: b.call_booked ?? null,
        notes: b.notes || null,
      });
    reply.code(201);
    return db.prepare('SELECT * FROM metrics WHERE id = ?').get(info.lastInsertRowid);
  });

  // ---------- posts: reddit "Post now" manual flow ----------
  // Reddit is assisted-manual (SPEC.md "Platform lineup") - the worker never
  // submits it to Blotato. CB copies title/body, opens the subreddit, posts
  // by hand, then marks it posted with the resulting URL. This is the only
  // way a reddit post ever reaches 'published'.
  app.post('/api/posts/:id/mark-posted', async (req, reply) => {
    const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!post) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    if (!b.public_url) {
      reply.code(400);
      return { error: 'public_url is required' };
    }
    const now = nowIso();
    db.prepare(
      `UPDATE posts SET status = 'published', public_url = @public_url, error_message = NULL, updated_at = @now WHERE id = @id`
    ).run({ public_url: b.public_url, now, id: req.params.id });
    return db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
  });

  // ---------- posts: blog long-form render preview ----------
  app.get('/api/posts/:id/preview', async (req, reply) => {
    const row = db.prepare('SELECT * FROM posts WHERE id = ?').get(req.params.id);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const post = parseJsonColumns(row, ['media', 'platform_fields']);
    const title = post.platform_fields?.title || '(untitled)';
    const heroPath = post.platform_fields?.hero;
    const bodyMd = post.platform_fields?.body || post.copy || '';
    const bodyHtml = markdownToHtml(bodyMd);
    const heroHtml = heroPath
      ? `<img src="${escapeHtml(heroPath)}" alt="" style="max-width:100%;">`
      : '';

    reply.type('text/html');
    return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body>
<article>
<h1>${escapeHtml(title)}</h1>
${heroHtml}
${bodyHtml}
</article>
</body></html>`;
  });

  // ---------- tone profiles (read) ----------
  // Not in the original B1 read set, but the composer's "Draft with AI" needs
  // to resolve a tone_profile_id from (brand_id, tone name) - added here as a
  // small, additive read endpoint rather than hardcoding ids in the client.
  app.get('/api/tone-profiles', async (req, reply) => {
    const { brand_id, name } = req.query;
    if (brand_id && name) {
      const row = db
        .prepare('SELECT * FROM tone_profiles WHERE brand_id = ? AND name = ?')
        .get(brand_id, name);
      if (!row) {
        reply.code(404);
        return { error: 'not_found' };
      }
      return row;
    }
    const clauses = [];
    const params = [];
    let sql = 'SELECT * FROM tone_profiles WHERE 1=1';
    if (brand_id) {
      clauses.push('brand_id = ?');
      params.push(brand_id);
    }
    if (clauses.length) sql += ' AND ' + clauses.join(' AND ');
    sql += ' ORDER BY id';
    return db.prepare(sql).all(...params);
  });

  // ---------- ideas: create / update ----------
  app.post('/api/ideas', async (req, reply) => {
    const b = req.body || {};
    if (!b.title) {
      reply.code(400);
      return { error: 'title is required' };
    }
    const now = nowIso();
    const info = db
      .prepare(
        `
        INSERT INTO ideas (
          brand_id, external_id, title, pillar, target_icp, source_material,
          notes, status, created_at, updated_at
        ) VALUES (
          @brand_id, @external_id, @title, @pillar, @target_icp, @source_material,
          @notes, @status, @now, @now
        )
      `
      )
      .run({
        brand_id: b.brand_id || null,
        external_id: b.external_id || null,
        title: b.title,
        pillar: b.pillar || null,
        target_icp: b.target_icp || null,
        source_material: b.source_material || null,
        notes: b.notes || null,
        status: b.status || 'idea',
        now,
      });
    reply.code(201);
    return db.prepare('SELECT * FROM ideas WHERE id = ?').get(info.lastInsertRowid);
  });

  app.patch('/api/ideas/:id', async (req, reply) => {
    const existing = db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const now = nowIso();
    const merged = {
      title: b.title !== undefined ? b.title : existing.title,
      pillar: b.pillar !== undefined ? b.pillar : existing.pillar,
      target_icp: b.target_icp !== undefined ? b.target_icp : existing.target_icp,
      source_material: b.source_material !== undefined ? b.source_material : existing.source_material,
      notes: b.notes !== undefined ? b.notes : existing.notes,
      status: b.status !== undefined ? b.status : existing.status,
      now,
      id: req.params.id,
    };
    db.prepare(
      `
      UPDATE ideas SET title=@title, pillar=@pillar, target_icp=@target_icp,
        source_material=@source_material, notes=@notes, status=@status, updated_at=@now
      WHERE id=@id
    `
    ).run(merged);
    return db.prepare('SELECT * FROM ideas WHERE id = ?').get(req.params.id);
  });

  // ---------- media library ----------
  app.get('/api/media', async () => {
    const files = fs.readdirSync(MEDIA_DIR, { withFileTypes: true }).filter((d) => d.isFile() && d.name !== '.gitkeep');
    return files.map((d) => {
      const full = path.join(MEDIA_DIR, d.name);
      const stat = fs.statSync(full);
      return {
        filename: d.name,
        path: `media/${d.name}`,
        url: `/media/${d.name}`,
        size: stat.size,
        modified_at: stat.mtime.toISOString(),
      };
    });
  });

  app.post('/api/media', async (req, reply) => {
    const data = await req.file();
    if (!data) {
      reply.code(400);
      return { error: 'no file uploaded (expected multipart field "file")' };
    }
    const safeName = `${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const dest = path.join(MEDIA_DIR, safeName);
    await pipeline(data.file, fs.createWriteStream(dest));
    const stat = fs.statSync(dest);
    reply.code(201);
    return {
      filename: safeName,
      path: `media/${safeName}`,
      url: `/media/${safeName}`,
      size: stat.size,
    };
  });

  // ---------- B14: auto-resize to platform specs (src/resize.js, macOS sips) ----------
  app.post('/api/media/resize', async (req, reply) => {
    const b = req.body || {};
    if (!b.source_path) {
      reply.code(400);
      return { error: 'source_path is required' };
    }
    const srcAbsPath = resolveMediaPath(b.source_path);
    if (!srcAbsPath) {
      reply.code(400);
      return { error: 'invalid_source_path', message: 'source_path must be a file inside media/.' };
    }
    if (!fs.existsSync(srcAbsPath)) {
      reply.code(404);
      return { error: 'source_not_found' };
    }
    if (!(await sipsAvailable())) {
      reply.code(503);
      return {
        error: 'resize_unavailable',
        message: 'sips is not available on this machine - auto-resize needs macOS. Resize the image manually and attach it instead.',
      };
    }

    let files = [];
    let skipped = [];
    try {
      if (Array.isArray(b.dims) && b.dims.length) {
        for (const d of b.dims) {
          const out = await resizeToDims(srcAbsPath, { width: d.width, height: d.height, outDir: MEDIA_DIR });
          files.push({ ...out, dims: `${d.width}x${d.height}` });
        }
      }
      if (Array.isArray(b.platforms) && b.platforms.length) {
        const perPlatform = await resizeForPlatforms(srcAbsPath, b.platforms, {
          outDir: MEDIA_DIR,
          content_type: b.content_type || null,
        });
        files = files.concat(perPlatform.results);
        skipped = skipped.concat(perPlatform.skipped);
      }
    } catch (err) {
      if (err.code === 'resize_unavailable') {
        reply.code(503);
        return { error: 'resize_unavailable', message: err.message };
      }
      reply.code(500);
      return { error: 'resize_failed', message: err.message };
    }

    if (b.post_id) {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(b.post_id);
      if (post) {
        let media = [];
        try {
          media = JSON.parse(post.media || '[]');
        } catch {
          media = [];
        }
        for (const file of files) {
          media.push({ path: file.path, altText: '', platform: file.platform || null });
        }
        db.prepare('UPDATE posts SET media = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(media), nowIso(), b.post_id);
      }
    }

    return { files, skipped };
  });

  // ---------- AI drafting ----------
  // B15: optional `provider` ('claude'|'codex') in the body; falls back to
  // the `draft_provider` setting (default 'claude') when omitted.
  app.post('/api/draft', async (req, reply) => {
    const b = req.body || {};
    const { idea_text, brand_id, tone_profile_id, platforms, provider } = b;
    if (!idea_text || !brand_id || !tone_profile_id || !Array.isArray(platforms) || !platforms.length) {
      reply.code(400);
      return { error: 'idea_text, brand_id, tone_profile_id, and platforms[] are required' };
    }
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id);
    const toneProfile = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(tone_profile_id);
    if (!brand || !toneProfile) {
      reply.code(404);
      return { error: 'brand or tone_profile not found' };
    }
    const effectiveTone = withGlobalVoice(db, { brand_id, toneProfile });
    const chosenProvider = provider || getRawSetting(db, 'draft_provider') || 'claude';
    try {
      const result = await draftWithAi({ idea_text, brand, toneProfile: effectiveTone, platforms, provider: chosenProvider });
      recordUsage(db, { kind: 'ai_draft', brand_id });
      return result;
    } catch (err) {
      reply.code(err.statusCode || 503);
      return { error: 'ai_unavailable', provider: chosenProvider, message: err.message };
    }
  });

  // B15: run the same draft through BOTH providers independently - one 503
  // must never fail the other. Not gated behind the `draft_provider`
  // setting (it's an explicit "compare both" action from the composer).
  app.post('/api/draft/compare', async (req, reply) => {
    const b = req.body || {};
    const { idea_text, brand_id, tone_profile_id, platforms } = b;
    if (!idea_text || !brand_id || !tone_profile_id || !Array.isArray(platforms) || !platforms.length) {
      reply.code(400);
      return { error: 'idea_text, brand_id, tone_profile_id, and platforms[] are required' };
    }
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id);
    const toneProfile = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(tone_profile_id);
    if (!brand || !toneProfile) {
      reply.code(404);
      return { error: 'brand or tone_profile not found' };
    }
    const effectiveTone = withGlobalVoice(db, { brand_id, toneProfile });

    async function tryProvider(providerName) {
      try {
        const result = await draftWithAi({ idea_text, brand, toneProfile: effectiveTone, platforms, provider: providerName });
        recordUsage(db, { kind: 'ai_draft', brand_id });
        return { result };
      } catch (err) {
        return { error: 'ai_unavailable', message: err.message };
      }
    }

    const [claudeOut, codexOut] = await Promise.all([tryProvider('claude'), tryProvider('codex')]);
    return { claude: claudeOut, codex: codexOut };
  });

  app.get('/api/platform-limits', async () => PLATFORM_LIMITS);

  // ---------- platform specs (B7): single source of truth for the composer ----------
  app.get('/api/platform-specs', async () => loadPlatformSpecs());

  // ---------- analytics (B7) ----------
  app.get('/api/analytics', async () => buildAnalytics(db));

  // ---------- B8: copy assistant ----------
  app.post('/api/copy-assist', async (req, reply) => {
    const b = req.body || {};
    const { mode, idea_text, copy, brand_id, tone_profile_id, platforms, image_path, pillar, tag, provider } = b;
    if (!mode || !brand_id) {
      reply.code(400);
      return { error: 'mode and brand_id are required' };
    }
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id);
    if (!brand) {
      reply.code(404);
      return { error: 'brand not found' };
    }
    let toneProfile = null;
    if (tone_profile_id) {
      toneProfile = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(tone_profile_id);
      if (!toneProfile) {
        reply.code(404);
        return { error: 'tone_profile not found' };
      }
    }
    const groundingTag = tag || pillar || null;
    let grounding = groundingTag ? groundingForBrand(db, { brand_id, tag: groundingTag }) : '';
    // B11: also fold in any saved example posts for the target platform(s) -
    // additive to research grounding, graceful (empty string) if none exist.
    const targetPlatform = Array.isArray(platforms) && platforms.length ? platforms[0] : undefined;
    const exGrounding = examplesGrounding(db, { brand_id, platform: targetPlatform });
    if (exGrounding) {
      grounding = grounding ? `${grounding}\n\n${exGrounding}` : exGrounding;
    }

    const effectiveTone = withGlobalVoice(db, { brand_id, toneProfile });
    const chosenProvider = provider || getRawSetting(db, 'draft_provider') || 'claude';
    try {
      const result = await copyAssist({
        mode,
        idea_text,
        copy,
        brand,
        toneProfile: effectiveTone,
        platforms,
        image_path,
        grounding,
        provider: chosenProvider,
      });
      recordUsage(db, { kind: 'copy_assist', brand_id });
      return result;
    } catch (err) {
      reply.code(err.statusCode || 503);
      return { error: 'ai_unavailable', provider: chosenProvider, message: err.message };
    }
  });

  // ---------- B11: example posts (ground the copy assistant/agent) ----------
  app.get('/api/examples', async (req) => {
    const { brand_id, platform } = req.query;
    const opts = {};
    if (brand_id !== undefined) opts.brand_id = brand_id;
    if (platform !== undefined) opts.platform = platform;
    return listExamples(db, opts);
  });

  app.post('/api/examples', async (req, reply) => {
    const b = req.body || {};
    const row = await createExample(db, {
      brand_id: b.brand_id ?? null,
      platform: b.platform ?? null,
      source: b.source || 'paste',
      text: b.text ?? null,
      image_path: b.image_path ?? null,
      tags: b.tags || [],
    });
    reply.code(201);
    return row;
  });

  app.delete('/api/examples/:id', async (req, reply) => {
    const ok = deleteExample(db, req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: 'not_found' };
    }
    reply.code(204);
    return null;
  });

  // Preview-only: extract text from an uploaded screenshot OR an existing
  // media/ path, WITHOUT saving an example row, so CB can eyeball the result
  // before deciding to save it (SPEC.md B11 "Endpoints").
  app.post('/api/examples/extract-image', async (req, reply) => {
    let imagePath = null; // absolute, passed to extractFromImage
    let returnedPath = null; // relative "media/<file>" for consistency with POST /api/media
    const isMultipart = req.isMultipart && req.isMultipart();
    try {
      if (isMultipart) {
        const data = await req.file();
        if (!data) {
          reply.code(400);
          return { error: 'no file uploaded (expected multipart field "file")' };
        }
        const safeName = `${Date.now()}-${data.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const dest = path.join(MEDIA_DIR, safeName);
        await pipeline(data.file, fs.createWriteStream(dest));
        imagePath = dest;
        returnedPath = `media/${safeName}`;
      } else {
        const b = req.body || {};
        if (!b.image_path) {
          reply.code(400);
          return { error: 'image_path is required' };
        }
        imagePath = resolveMediaPath(b.image_path);
        if (!imagePath) {
          reply.code(400);
          return { error: 'invalid_image_path', message: 'image_path must be a file inside media/.' };
        }
        returnedPath = `media/${path.basename(imagePath)}`;
      }

      const { text } = await extractFromImage(imagePath);
      return { text, image_path: returnedPath };
    } catch (err) {
      reply.code(err.statusCode || 503);
      return { error: 'ai_unavailable', message: err.message };
    }
  });

  // ---------- B11: blog redistribution ----------
  app.post('/api/redistribute', async (req, reply) => {
    const b = req.body || {};
    if (!b.url) {
      reply.code(400);
      return { error: 'url is required' };
    }
    try {
      const result = await redistributeFromUrl(db, {
        url: b.url,
        brand_id: b.brand_id ?? null,
        platforms: b.platforms || [],
        make_images: b.make_images !== undefined ? b.make_images : true,
      });
      return result;
    } catch (err) {
      reply.code(400);
      return { error: 'fetch_failed', message: err.message };
    }
  });

  // ---------- B8: research notes ----------
  app.get('/api/research', async (req) => {
    const { brand_id, tag } = req.query;
    const opts = {};
    if (brand_id !== undefined) opts.brand_id = brand_id;
    if (tag) opts.tag = tag;
    return listResearch(db, opts);
  });

  app.post('/api/research', async (req, reply) => {
    const b = req.body || {};
    reply.code(201);
    return createResearchNote(db, b);
  });

  app.patch('/api/research/:id', async (req, reply) => {
    const row = updateResearchNote(db, req.params.id, req.body || {});
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return row;
  });

  app.delete('/api/research/:id', async (req, reply) => {
    const ok = deleteResearchNote(db, req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: 'not_found' };
    }
    reply.code(204);
    return null;
  });

  app.post('/api/research/import', async (req, reply) => {
    const b = req.body || {};
    reply.code(201);
    return importResearchText(db, b);
  });

  // ---------- B8: inspiration board ----------
  app.get('/api/inspiration', async (req) => {
    const { brand_id, platform } = req.query;
    const opts = {};
    if (brand_id !== undefined) opts.brand_id = brand_id;
    if (platform) opts.platform = platform;
    return listInspiration(db, opts);
  });

  app.post('/api/inspiration', async (req, reply) => {
    const b = req.body || {};
    reply.code(201);
    return createInspiration(db, b);
  });

  app.patch('/api/inspiration/:id', async (req, reply) => {
    const row = updateInspiration(db, req.params.id, req.body || {});
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return row;
  });

  app.delete('/api/inspiration/:id', async (req, reply) => {
    const ok = deleteInspiration(db, req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: 'not_found' };
    }
    reply.code(204);
    return null;
  });

  app.post('/api/inspiration/suggest', async (req, reply) => {
    const b = req.body || {};
    const { brand_id, niche, platforms } = b;
    if (!brand_id) {
      reply.code(400);
      return { error: 'brand_id is required' };
    }
    const brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(brand_id);
    if (!brand) {
      reply.code(404);
      return { error: 'brand not found' };
    }
    try {
      // suggest-only convenience - never persists anything (SPEC.md B8 feature 6).
      return await suggestProfiles({ brand: brand.name, niche, platforms });
    } catch (err) {
      reply.code(err.statusCode || 503);
      return { error: 'ai_unavailable', message: err.message };
    }
  });

  // ---------- B8: image requests (Codex handoff) ----------
  app.get('/api/image-requests', async (req) => {
    const { status, post_id } = req.query;
    return listImageRequests(db, { status, post_id });
  });

  app.get('/api/image-requests/:id', async (req, reply) => {
    const row = getImageRequest(db, req.params.id);
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return row;
  });

  app.post('/api/image-requests', async (req, reply) => {
    const b = req.body || {};
    const platforms = b.platforms || [];
    let brand = null;
    if (b.brand_id) {
      brand = db.prepare('SELECT * FROM brands WHERE id = ?').get(b.brand_id);
    }
    let brandColors = null;
    if (brand && brand.colors) {
      try {
        brandColors = JSON.parse(brand.colors);
      } catch {
        brandColors = brand.colors;
      }
    }
    // B14: CB picks variant_count + per-variant hints; brand logo/colors ride
    // along in the brief so Codex can brand the generated asset.
    const brief = b.brief || buildBrief({
      platforms,
      content_type: b.content_type || null,
      copy: b.copy || '',
      brand: brand ? brand.name : null,
      variant_count: b.variant_count ?? 1,
      hints: b.hints || [],
      logo_path: brand ? brand.logo_path || null : null,
      colors: brandColors,
    });
    const row = createImageRequest(db, {
      post_id: b.post_id || null,
      brand_id: b.brand_id || null,
      platforms,
      content_type: b.content_type || null,
      brief,
      variant_count: b.variant_count,
      hints: b.hints,
    });
    recordUsage(db, { kind: 'image_request', brand_id: b.brand_id || null });
    reply.code(201);
    return row;
  });

  // B14: "Regenerate / more variants" - appends another image-request round
  // for the same post/brand/platforms without CB re-typing the brief.
  app.post('/api/image-requests/:id/regenerate', async (req, reply) => {
    const b = req.body || {};
    try {
      const row = regenerateImageRequest(db, {
        source_request_id: req.params.id,
        variant_count: b.variant_count,
        hints: b.hints,
      });
      recordUsage(db, { kind: 'image_request', brand_id: row.brand_id, meta: { regenerated_from: Number(req.params.id) } });
      reply.code(201);
      return row;
    } catch (err) {
      reply.code(err.statusCode || 500);
      return { error: 'regenerate_failed', message: err.message };
    }
  });

  app.post('/api/image-requests/:id/pick', async (req, reply) => {
    const b = req.body || {};
    if (!b.chosen_path) {
      reply.code(400);
      return { error: 'chosen_path is required' };
    }
    const existing = getImageRequest(db, req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    // chosen_path must be one of this request's generated variants - don't let an
    // arbitrary path get attached to a post.
    const variants = Array.isArray(existing.variants) ? existing.variants : [];
    if (!variants.some((v) => v.path === b.chosen_path || v.url === b.chosen_path)) {
      reply.code(400);
      return { error: 'chosen_path_not_a_variant' };
    }
    const row = pickVariant(db, req.params.id, b.chosen_path);
    if (existing.post_id) {
      const post = db.prepare('SELECT * FROM posts WHERE id = ?').get(existing.post_id);
      if (post) {
        let media = [];
        try {
          media = JSON.parse(post.media || '[]');
        } catch {
          media = [];
        }
        media.push({ path: b.chosen_path, altText: '' });
        db.prepare('UPDATE posts SET media = ?, updated_at = ? WHERE id = ?').run(
          JSON.stringify(media),
          nowIso(),
          existing.post_id
        );
      }
    }
    return row;
  });

  app.post('/api/image-requests/:id/cancel', async (req, reply) => {
    const existing = getImageRequest(db, req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return cancelImageRequest(db, req.params.id);
  });

  // ---------- B8: content-type recommender ----------
  app.get('/api/recommend/content-type', async (req) => {
    const { brand_id, pillar, platform } = req.query;
    return recommendContentType(db, { brand_id, pillar, platform });
  });

  // ---------- B8: ops/usage stats ----------
  app.get('/api/usage', async () => buildUsageStats(db));

  // ---------- B10: in-app chat agent (draft-and-prepare authority only -
  // no approve/publish/submit/cancel/delete tools exist, see src/agent.js) ----------
  app.post('/api/agent', async (req, reply) => {
    const b = req.body || {};
    const { message, history, brand_id } = b;
    if (!message) {
      reply.code(400);
      return { error: 'message is required' };
    }
    try {
      const result = await runAgent(db, { message, history: history || [], brand_id: brand_id ?? null });
      return result;
    } catch (err) {
      reply.code(err.statusCode || 503);
      return { error: 'ai_unavailable', message: err.message };
    }
  });

  // ---------- Blotato worker (B4): submit-now + status ----------
  app.post('/api/posts/:id/submit', async (req, reply) => {
    const result = await submitNow(req.params.id);
    if (result.error === 'not_found') {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (!result.ok && result.error) {
      reply.code(422);
      return { error: 'submit_failed', message: result.error };
    }
    return result;
  });

  app.get('/api/worker/status', async () => getWorkerStatus());

  // ---------- Agentic OS bridge (B5): state export ----------
  app.get('/api/export/social-state', async () => buildSocialState(db));

  // ---------- settings (B6): quiet hours + handoff window ----------
  // B12: global_voice / global_hard_rules are also just settings keys, but
  // they live outside settings.js's fixed DEFAULTS whitelist (voice.js owns
  // their read/write directly on the settings table) - merged in here so
  // GET/PATCH /api/settings round-trips them alongside quiet hours etc.
  app.get('/api/settings', async () => ({
    ...getAllSettings(db),
    global_voice: getGlobalVoice(db),
    global_hard_rules: getGlobalHardRules(db),
    // B14: "Allow assistant to approve & publish" toggle - default OFF ('0').
    // Lives outside settings.js's fixed DEFAULTS whitelist (same pattern as
    // global_voice/global_hard_rules above), read/written raw via voice.js's
    // getRawSetting/setRawSetting.
    agent_can_publish: getRawSetting(db, 'agent_can_publish') ?? '0',
    // B15: default AI provider for copy drafting ('claude'|'codex'), same
    // raw-settings-table pattern, default 'claude'.
    draft_provider: getRawSetting(db, 'draft_provider') ?? 'claude',
  }));

  app.patch('/api/settings', async (req) => {
    const b = req.body || {};
    const { global_voice, global_hard_rules, agent_can_publish, draft_provider, ...rest } = b;
    const updated = updateSettings(db, rest);
    if (global_voice !== undefined) setGlobalVoice(db, global_voice);
    if (global_hard_rules !== undefined) setGlobalHardRules(db, global_hard_rules);
    if (agent_can_publish !== undefined) setRawSetting(db, 'agent_can_publish', String(agent_can_publish));
    if (draft_provider !== undefined) setRawSetting(db, 'draft_provider', String(draft_provider));
    return {
      ...updated,
      global_voice: getGlobalVoice(db),
      global_hard_rules: getGlobalHardRules(db),
      agent_can_publish: getRawSetting(db, 'agent_can_publish') ?? '0',
      draft_provider: getRawSetting(db, 'draft_provider') ?? 'claude',
    };
  });

  // ---------- B12: tone-profile edit/reset + voice resolver preview ----------
  app.patch('/api/tone-profiles/:id', async (req, reply) => {
    const existing = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const now = nowIso();
    const merged = {
      voice_rules: b.voice_rules !== undefined ? b.voice_rules : existing.voice_rules,
      hard_rules:
        b.hard_rules !== undefined
          ? typeof b.hard_rules === 'string'
            ? b.hard_rules
            : JSON.stringify(b.hard_rules || {})
          : existing.hard_rules,
      now,
      id: req.params.id,
    };
    db.prepare('UPDATE tone_profiles SET voice_rules = @voice_rules, hard_rules = @hard_rules, updated_at = @now WHERE id = @id').run(
      merged
    );
    return db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(req.params.id);
  });

  app.post('/api/tone-profiles/:id/reset', async (req, reply) => {
    const existing = db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const now = nowIso();
    db.prepare("UPDATE tone_profiles SET voice_rules = '', hard_rules = '{}', updated_at = @now WHERE id = @id").run({
      now,
      id: req.params.id,
    });
    return db.prepare('SELECT * FROM tone_profiles WHERE id = ?').get(req.params.id);
  });

  // Convenience preview for the Settings UI + tests: the exact merged
  // { voice, hardRules } every generation path (draft/copy-assist/
  // redistribute/agent) will use for this (brand_id, tone) pair.
  app.get('/api/voice/resolve', async (req) => {
    const { brand_id, tone } = req.query;
    return resolveVoice(db, { brand_id: brand_id != null ? Number(brand_id) : null, tone: tone || null });
  });

  // ---------- B13: brand profiles (source of truth + generate) ----------
  // Human copy-pastes every field into the actual platform - nothing here
  // publishes/posts anything.
  app.get('/api/profiles', async (req) => {
    const { brand_id } = req.query;
    return listProfiles(db, { brand_id: brand_id != null ? Number(brand_id) : undefined });
  });

  app.get('/api/profiles/:brand_id/:platform', async (req, reply) => {
    const { brand_id, platform } = req.params;
    const row = getProfile(db, { brand_id: Number(brand_id), platform });
    if (!row) {
      reply.code(404);
      return { error: 'not_found' };
    }
    return row;
  });

  app.patch('/api/profiles/:id', async (req, reply) => {
    const existing = getProfileById(db, req.params.id);
    if (!existing) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const b = req.body || {};
    const fields = b.fields !== undefined ? { ...existing.fields, ...b.fields } : existing.fields;
    const status = b.status !== undefined ? b.status : existing.status;
    return upsertProfile(db, { brand_id: existing.brand_id, platform: existing.platform, fields, status });
  });

  app.post('/api/profiles/generate', async (req, reply) => {
    const b = req.body || {};
    const { brand_id, platform } = b;
    if (!brand_id || !platform) {
      reply.code(400);
      return { error: 'brand_id and platform are required' };
    }
    try {
      const row = await generateProfile(db, { brand_id, platform });
      return row;
    } catch (err) {
      reply.code(err.statusCode || 503);
      const errKey = err.statusCode === 404 ? 'not_found' : err.statusCode === 400 ? 'bad_request' : 'ai_unavailable';
      return { error: errKey, message: err.message };
    }
  });

  // Soft quiet-hours check for the Approve confirm dialog - never a hard
  // block (see SPEC.md B6). UI can also compute this itself from /api/settings.
  app.get('/api/settings/quiet-hours-check', async (req) => {
    const { publish_at } = req.query;
    const settings = getAllSettings(db);
    return {
      within_quiet_hours: isWithinQuietHours(publish_at, settings.quiet_start, settings.quiet_end),
      quiet_start: settings.quiet_start,
      quiet_end: settings.quiet_end,
    };
  });

  return app;
}

async function start() {
  const app = buildServer();
  try {
    await app.listen({ port: PORT, host: HOST });
    startWorker();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  start();
}

export { buildServer };
