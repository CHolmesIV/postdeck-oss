// Blog add-on backend (docs/BLOG_ADDON_SPEC.md). PostDeck is the control panel
// for the HTML blog programs under Website Projects/<Site>/blog/. It never
// edits the sites' scripts, never calls release.py --allow-unreviewed, and
// writes only <site>/blog/content/*.md (atomic, mtime-checked).
//
// Sections: helpers -> discovery -> front matter -> posts/schema -> actions
// (create/patch/approve/schedule/...) -> release runner + scheduler phase ->
// preview -> AI draft -> settings -> routes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { getSetting, setSetting } from './settings.js';
import { normalizeDashes, withGlobalVoice, getRawSetting } from './voice.js';
import { scrubText } from './scrub.js';
import { runDraft as aiRunDraft } from './ai.js';
import { parseInnerJson } from './draft.js';
import { recordUsage } from './usage.js';
import { nowIso } from './db.js';

// ---------- helpers ----------

class BlogError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const SHARED_REQUIRED = ['title', 'description', 'slug', 'cluster', 'tier', 'primary_keyword', 'publish_date', 'status'];
const LIST_KEYS = new Set(['related', 'tags', 'secondary_keywords']);
const LONG_KEYS = new Set(['description', 'excerpt', 'dek', 'cta_body', 'disclaimer']);
const DATE_KEYS = new Set(['publish_date', 'updated_date', 'live_from']);
const MANAGED_KEYS = new Set(['status', 'needs_cb_review']);
const OUT_TAIL = 20 * 1024;

const websitesRoot = () =>
  process.env.POSTDECK_WEBSITES_ROOT || path.join(os.homedir(), 'Desktop/AI/Projects/Website Projects');
const pythonBin = () => process.env.POSTDECK_PYTHON || 'python3';

// Same rule as worker.js isDryRun (kept local: worker.js imports this module).
function isDryRun() {
  const v = process.env.BLOTATO_DRY_RUN;
  if (v === undefined || v === null || v === '') return true;
  return !['0', 'false'].includes(String(v).toLowerCase());
}

const pad2 = (n) => String(n).padStart(2, '0');
function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}
function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + n));
}
function dueAtIso(date, time) {
  if (!isValidDate(date)) return null;
  const t = TIME_RE.test(time || '') ? time : '00:00';
  const d = new Date(`${date}T${t}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function slugify(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}
const wordCount = (s) => (String(s || '').match(/\S+/g) || []).length;
const tail = (s, n = OUT_TAIL) => (s.length > n ? s.slice(-n) : s);

function execFileP(file, args, opts) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
    if (child.stdin) child.stdin.end();
  });
}

// ---------- discovery ----------

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function toolSources(root) {
  const dir = path.join(root, 'blog', 'tools');
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.py')).sort();
  } catch {
    return [];
  }
  // build_blog.py first: it is the canonical declaration site.
  names.sort((a, b) => (a === 'build_blog.py' ? -1 : b === 'build_blog.py' ? 1 : 0));
  return names.map((n) => ({ name: n, text: readText(path.join(dir, n)) || '' }));
}

function parseLiveUrl(sources) {
  for (const { text } of sources) {
    const m = /^SITE\s*=\s*["'](https?:\/\/[^"']+)["']/m.exec(text);
    if (m) return m[1].replace(/\/+$/, '');
  }
  for (const { text } of sources) {
    const m = /^DOMAIN\s*=\s*["']([^"']+)["']/m.exec(text);
    if (m) return (/^https?:\/\//.test(m[1]) ? m[1] : `https://${m[1]}`).replace(/\/+$/, '');
  }
  return null;
}

/** Top-level string keys of `NAME = { ... }` in python source (balanced scan). */
function parseDictKeys(text, name) {
  const m = new RegExp(`^${name}\\s*=\\s*\\{`, 'm').exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  const keys = [];
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let lit = '';
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        lit += text[j] ?? '';
        j++;
      }
      if (depth === 1 && /^\s*:/.test(text.slice(j + 1, j + 8))) keys.push(lit);
      i = j + 1;
      continue;
    }
    if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    i++;
  }
  return keys.length ? keys : null;
}

function parseRequiredKeys(sources) {
  const re = /for\s+\w+\s+in\s*\(\s*((?:["'][a-z_]+["']\s*,\s*)+["'][a-z_]+["']\s*,?\s*)\)\s*:\s*\n\s*if\s+not\s+\w+/g;
  for (const { text } of sources) {
    let m;
    while ((m = re.exec(text))) {
      const keys = [...m[1].matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1]);
      if (keys.includes('slug') && keys.includes('title')) return keys;
    }
  }
  return null;
}

function slugifyId(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const compact = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function brandIdFor(db, siteId) {
  const stored = getSetting(db, `blog_site_brand:${siteId}`, undefined);
  if (stored === null || stored === '') return null;
  if (stored !== undefined) {
    const n = Number(stored);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const sc = compact(siteId);
  for (const b of db.prepare('SELECT id, name, slug FROM brands ORDER BY id').all()) {
    for (const cand of [compact(b.slug), compact(b.name)]) {
      if (cand && (sc === cand || sc.startsWith(cand) || cand.startsWith(sc))) return b.id;
    }
  }
  return null;
}

function discoverSites(db) {
  const root = websitesRoot();
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const sites = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const siteRoot = path.join(root, e.name);
    try {
      if (!fs.statSync(path.join(siteRoot, 'blog', 'tools', 'release.py')).isFile()) continue;
      if (!fs.statSync(path.join(siteRoot, 'blog', 'content')).isDirectory()) continue;
    } catch {
      continue;
    }
    const id = slugifyId(e.name);
    if (!id) continue;
    sites.push({
      id,
      name: e.name,
      root: siteRoot,
      contentDir: path.join(siteRoot, 'blog', 'content'),
      live_url: parseLiveUrl(toolSources(siteRoot)),
      brand_id: brandIdFor(db, id),
    });
  }
  sites.sort((a, b) => a.name.localeCompare(b.name));
  return sites;
}

function getSite(db, id) {
  const s = discoverSites(db).find((x) => x.id === id);
  if (!s) throw new BlogError(404, 'site_not_found', `No blog site "${id}"`);
  return s;
}

// ---------- front matter ----------
// A file is kept as raw text. Parsing only locates key lines; edits replace
// individual lines so everything untouched stays byte-identical.

function splitFile(raw) {
  const open = /^---[ \t]*\r?\n/.exec(raw);
  if (!open) throw new BlogError(422, 'no_front_matter', 'File has no front matter');
  const lines = [];
  let pos = open[0].length;
  while (pos <= raw.length) {
    const nl = raw.indexOf('\n', pos);
    const end = nl === -1 ? raw.length : nl + 1;
    const line = raw.slice(pos, end);
    if (line.replace(/\r?\n$/, '').trimEnd() === '---') {
      return { open: open[0], lines, close: line, body: raw.slice(end), eol: /\r\n$/.test(open[0]) ? '\r\n' : '\n' };
    }
    if (nl === -1) break;
    lines.push(line);
    pos = end;
  }
  throw new BlogError(422, 'no_front_matter', 'Front matter is not closed');
}

const KEY_LINE = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/;

function unquote(s) {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s[s.length - 1] === s[0]) return s.slice(1, -1);
  return s;
}

function parseValue(key, rawVal) {
  const v = rawVal.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    return v.slice(1, -1).split(',').map((x) => unquote(x.trim())).filter(Boolean);
  }
  if (LIST_KEYS.has(key)) {
    return unquote(v) === '' ? [] : unquote(v).split(',').map((x) => x.trim()).filter(Boolean);
  }
  const low = v.toLowerCase();
  if (low === 'true' || low === 'false') return low === 'true';
  return unquote(v);
}

/** Ordered key entries with line indexes (first occurrence of a key wins). */
function entriesOf(parts) {
  const out = [];
  const seen = new Set();
  parts.lines.forEach((line, idx) => {
    const m = KEY_LINE.exec(line.replace(/\r?\n$/, ''));
    if (!m || line.trimStart().startsWith('#') || seen.has(m[1])) return;
    seen.add(m[1]);
    out.push({ key: m[1], raw: m[2].trim(), value: parseValue(m[1], m[2]), idx });
  });
  return out;
}

const sameValue = (a, b) =>
  Array.isArray(a) && Array.isArray(b) ? a.length === b.length && a.every((x, i) => x === b[i]) : a === b;

function needsQuote(s) {
  if (s === '') return false;
  return (
    /: /.test(s) ||
    /:$/.test(s) ||
    / #/.test(s) ||
    /^["'[\]{}&*!|>%@`#]/.test(s) ||
    /^[-?]\s/.test(s) ||
    /^\s|\s$/.test(s)
  );
}

function formatValue(value, prevRaw) {
  const prev = prevRaw === undefined ? undefined : prevRaw.trim();
  if (Array.isArray(value)) {
    const items = value.map((x) => normalizeDashes(String(x)).replace(/\s+/g, ' ').replace(/,/g, ' ').trim()).filter(Boolean);
    if (prev && !prev.startsWith('[')) return items.join(', ');
    return `[${items.join(', ')}]`;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value === null || value === undefined) return '';
  let s = normalizeDashes(String(value)).replace(/[\r\n]+/g, ' ').trim();
  const prevQuote = prev && prev.length >= 2 && (prev[0] === '"' || prev[0] === "'") && prev[prev.length - 1] === prev[0] ? prev[0] : null;
  if (s === '') return '';
  if (prevQuote || needsQuote(s)) {
    // The sites' parsers strip only the outer quote pair (no unescaping), so
    // inner quotes are kept as typed.
    const q = prevQuote && !s.includes(prevQuote) ? prevQuote : '"';
    return `${q}${s}${q}`;
  }
  return s;
}

/** Apply { key: value } to raw file text. Untouched lines stay byte-identical. */
function setKeys(raw, changes) {
  const parts = splitFile(raw);
  const entries = entriesOf(parts);
  const lines = [...parts.lines];
  const inserts = [];
  for (const [key, value] of Object.entries(changes)) {
    const cur = entries.find((e) => e.key === key);
    const incoming = typeof value === 'string' ? value.trim() : value;
    if (cur && sameValue(cur.value, incoming)) continue;
    const text = formatValue(value, cur ? cur.raw : undefined);
    const line = text === '' ? `${key}:` : `${key}: ${text}`;
    if (cur) {
      const old = lines[cur.idx];
      const term = /\r?\n$/.exec(old);
      lines[cur.idx] = line + (term ? term[0] : '');
    } else {
      inserts.push(line + parts.eol);
    }
  }
  return parts.open + lines.join('') + inserts.join('') + parts.close + parts.body;
}

function setBody(raw, body) {
  const parts = splitFile(raw);
  let b = normalizeDashes(String(body ?? ''));
  if (b !== '' && !b.endsWith('\n')) b += parts.eol;
  return parts.open + parts.lines.join('') + parts.close + b;
}

// ---------- posts / schema ----------

function contentPath(site, slug) {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) throw new BlogError(400, 'bad_slug', 'Invalid slug');
  const p = path.join(site.contentDir, `${slug}.md`);
  if (path.dirname(p) !== site.contentDir) throw new BlogError(400, 'bad_slug', 'Invalid slug');
  try {
    const real = fs.realpathSync(p);
    if (path.dirname(real) !== fs.realpathSync(site.contentDir)) throw new BlogError(400, 'bad_path', 'Path escapes the content folder');
  } catch (err) {
    if (err instanceof BlogError) throw err;
    // not existing yet: fine
  }
  return p;
}

function writeAtomic(p, text) {
  const tmp = path.join(path.dirname(p), `.${path.basename(p)}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, p);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function loadPostFile(site, slug) {
  const p = contentPath(site, slug);
  let raw;
  let st;
  try {
    raw = fs.readFileSync(p, 'utf8');
    st = fs.statSync(p);
  } catch (err) {
    if (err.code === 'ENOENT') throw new BlogError(404, 'post_not_found', `No post "${slug}"`);
    throw err;
  }
  return { slug, path: p, raw, mtime: st.mtimeMs, parts: splitFile(raw) };
}

function buildPost(site, defaultTime, file, withBody) {
  const entries = entriesOf(file.parts);
  const fields = {};
  for (const e of entries) fields[e.key] = e.value;
  const status = String(fields.status || '').toLowerCase();
  const publish_time = typeof fields.publish_time === 'string' && TIME_RE.test(fields.publish_time) ? fields.publish_time : null;
  const post = {
    slug: file.slug,
    mtime: file.mtime,
    fields,
    title: String(fields.title || file.slug),
    status,
    publish_date: String(fields.publish_date || ''),
    publish_time,
    needs_review: fields.needs_cb_review === true,
    word_count: wordCount(file.parts.body),
    due_at: dueAtIso(String(fields.publish_date || ''), publish_time || defaultTime),
    released: status === 'published',
    live_url: status === 'published' && site.live_url ? `${site.live_url}/blog/${file.slug}/` : null,
  };
  if (withBody) post.body_md = file.parts.body;
  return post;
}

function defaultTimeOf(db) {
  const t = getSetting(db, 'blog_default_time', '09:00');
  return TIME_RE.test(String(t)) ? String(t) : '09:00';
}

function listFiles(site) {
  let names = [];
  try {
    names = fs.readdirSync(site.contentDir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
    const slug = n.slice(0, -3);
    if (!SLUG_RE.test(slug)) continue;
    try {
      out.push(loadPostFile(site, slug));
    } catch {
      // unreadable / malformed front matter: skip (the site's own QA reports it)
    }
  }
  return out;
}

function listPosts(db, site, { withBody = false } = {}) {
  const dt = defaultTimeOf(db);
  return listFiles(site)
    .map((f) => buildPost(site, dt, f, withBody))
    .sort((a, b) => (a.publish_date < b.publish_date ? 1 : a.publish_date > b.publish_date ? -1 : a.slug.localeCompare(b.slug)));
}

function getPost(db, site, slug) {
  return buildPost(site, defaultTimeOf(db), loadPostFile(site, slug), true);
}

function deriveSchema(site, files) {
  const sources = toolSources(site.root);
  const dated = files
    .map((f) => ({ f, entries: entriesOf(f.parts) }))
    .map((x) => ({ ...x, date: String(x.entries.find((e) => e.key === 'publish_date')?.value || '') }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const model = dated[0];
  const keys = model ? model.entries.map((e) => e.key) : [...SHARED_REQUIRED, 'updated_date', 'needs_cb_review', 'related'];
  if (!keys.includes('publish_time')) keys.push('publish_time');

  const bracketed = new Set();
  const distinct = { cluster: new Set(), tier: new Set() };
  for (const { entries } of dated) {
    for (const e of entries) {
      if (e.raw.startsWith('[')) bracketed.add(e.key);
      if (e.key === 'cluster' || e.key === 'tier') if (typeof e.value === 'string' && e.value) distinct[e.key].add(e.value);
    }
  }
  let clusters = null;
  let tiers = null;
  for (const { text } of sources) {
    clusters = clusters || parseDictKeys(text, 'CLUSTERS');
    tiers = tiers || parseDictKeys(text, 'TIERS') || parseDictKeys(text, 'TIER_FLOOR');
  }
  const required = new Set(parseRequiredKeys(sources) || SHARED_REQUIRED);
  const optionsFor = {
    cluster: clusters || [...distinct.cluster],
    tier: tiers || [...distinct.tier],
    status: ['draft', 'scheduled', 'published'],
  };
  const fields = keys.map((key) => {
    let kind = 'text';
    if (DATE_KEYS.has(key)) kind = 'date';
    else if (key === 'needs_cb_review') kind = 'bool';
    else if (LIST_KEYS.has(key) || bracketed.has(key)) kind = 'list';
    else if (optionsFor[key]) kind = 'select';
    else if (LONG_KEYS.has(key)) kind = 'long';
    const f = { key, kind, required: required.has(key) };
    if (kind === 'select') f.options = optionsFor[key];
    return f;
  });
  return { fields };
}

function getSchema(site) {
  return deriveSchema(site, listFiles(site));
}

function buildSiteSummary(db, site) {
  const posts = listPosts(db, site);
  const today = localDate();
  const counts = { draft: 0, needs_review: 0, scheduled: 0, published: 0 };
  let nextDue = null;
  // Disjoint buckets matching the Blog view's lists: anything unpublished that
  // still needs CB's review counts once, under needs_review, draft or not.
  for (const p of posts) {
    if (p.status === 'published') counts.published++;
    else if (p.needs_review) counts.needs_review++;
    else if (p.status === 'draft') counts.draft++;
    else if (p.status === 'scheduled') {
      {
        counts.scheduled++;
        if (p.due_at && (!nextDue || p.due_at < nextDue.at)) nextDue = { slug: p.slug, title: p.title, at: p.due_at };
      }
    }
  }
  return {
    id: site.id,
    name: site.name,
    live_url: site.live_url,
    brand_id: site.brand_id,
    default_time: defaultTimeOf(db),
    paused: isPaused(db),
    counts,
    next_due: nextDue,
    blocked: blockedPosts(posts, today),
    releasing: inflight.has(site.id),
    last_release: lastRelease(db, site.id),
  };
}

// ---------- create / patch / actions ----------

function normalizeFieldValue(field, v) {
  if (field.kind === 'list') {
    if (Array.isArray(v)) return v.map(String);
    return String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  }
  if (field.kind === 'bool') return v === true || v === 'true';
  return v === null || v === undefined ? '' : String(v);
}

function validateSelectOptions(schema, values) {
  for (const f of schema.fields) {
    if (f.key !== 'cluster' || values[f.key] === undefined) continue;
    if (f.options && f.options.length && !f.options.includes(values[f.key])) {
      throw new BlogError(400, 'bad_cluster', `Unknown cluster "${values[f.key]}". Allowed: ${f.options.join(', ')}`);
    }
  }
}

function usedScheduleDates(posts) {
  return new Set(posts.filter((p) => p.status === 'scheduled').map((p) => p.publish_date));
}

function nextFreeDate(posts, from = localDate()) {
  const taken = usedScheduleDates(posts);
  let d = addDays(from, 1);
  for (let i = 0; i < 2000 && taken.has(d); i++) d = addDays(d, 1);
  return d;
}

function createPost(db, site, body = {}) {
  const input = body.fields && typeof body.fields === 'object' ? body.fields : {};
  const files = listFiles(site);
  const schema = deriveSchema(site, files);
  const known = new Set(schema.fields.map((f) => f.key));
  const posts = files.map((f) => buildPost(site, defaultTimeOf(db), f, false));

  const values = {};
  for (const f of schema.fields) {
    if (input[f.key] !== undefined && !MANAGED_KEYS.has(f.key)) values[f.key] = normalizeFieldValue(f, input[f.key]);
  }
  for (const k of Object.keys(input)) {
    if (!known.has(k) && !MANAGED_KEYS.has(k)) throw new BlogError(400, 'unknown_field', `Unknown field "${k}"`);
  }
  // Convenience: headline/seo_title default to the title when a site requires them.
  for (const alias of ['headline', 'seo_title']) {
    if (known.has(alias) && !values[alias] && values.title) values[alias] = values.title;
  }
  const slug = String(values.slug || slugify(values.title || '')).trim();
  if (!slug || !SLUG_RE.test(slug)) throw new BlogError(400, 'bad_slug', 'Could not derive a valid slug; give the post a title or slug');
  const target = contentPath(site, slug);
  if (fs.existsSync(target)) throw new BlogError(400, 'slug_taken', `A post with slug "${slug}" already exists`);

  const date = values.publish_date ? String(values.publish_date) : nextFreeDate(posts);
  if (!isValidDate(date)) throw new BlogError(400, 'bad_date', 'publish_date must be YYYY-MM-DD');
  values.slug = slug;
  values.publish_date = date;
  values.updated_date = isValidDate(String(values.updated_date || '')) ? values.updated_date : date;
  values.status = 'draft';
  values.needs_cb_review = true;
  if (values.publish_time !== undefined && values.publish_time !== '' && !TIME_RE.test(values.publish_time)) {
    throw new BlogError(400, 'bad_time', 'publish_time must be HH:MM');
  }

  const missing = schema.fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === '' || (Array.isArray(values[f.key]) && !values[f.key].length)));
  if (missing.length) throw new BlogError(400, 'missing_required', `Missing required: ${missing.map((f) => f.key).join(', ')}`, { missing: missing.map((f) => f.key) });
  validateSelectOptions(schema, values);

  let text = '---\n';
  for (const f of schema.fields) {
    if (f.key === 'publish_time' && !values.publish_time) continue;
    let v = values[f.key];
    if (v === undefined) v = f.kind === 'list' ? [] : f.kind === 'bool' ? false : '';
    const formatted = formatValue(v);
    text += formatted === '' ? `${f.key}:\n` : `${f.key}: ${formatted}\n`;
  }
  text += '---\n';
  let b = normalizeDashes(String(body.body_md || ''));
  if (b !== '' && !b.endsWith('\n')) b += '\n';
  text += b;
  writeAtomic(target, text);
  return getPost(db, site, slug);
}

function patchPost(db, site, slug, body = {}) {
  if (body.mtime === undefined || body.mtime === null) throw new BlogError(400, 'mtime_required', 'mtime is required');
  const file = loadPostFile(site, slug);
  if (Number(body.mtime) !== file.mtime) throw new BlogError(409, 'changed_on_disk', 'This post changed on disk since you loaded it. Reload before saving.', { mtime: file.mtime });
  const schema = deriveSchema(site, listFiles(site));
  const known = new Set(schema.fields.map((f) => f.key));
  const current = buildPost(site, defaultTimeOf(db), file, false);
  const incoming = body.fields && typeof body.fields === 'object' ? body.fields : {};

  const changes = {};
  let newSlug = null;
  for (const [k, v] of Object.entries(incoming)) {
    if (!known.has(k)) throw new BlogError(400, 'unknown_field', `Unknown field "${k}"`);
    const field = schema.fields.find((f) => f.key === k);
    const val = normalizeFieldValue(field, v);
    if (k === 'slug') {
      if (val === current.slug) continue;
      if (current.status === 'published') throw new BlogError(400, 'slug_locked', 'The slug of a published post cannot change');
      if (!SLUG_RE.test(val)) throw new BlogError(400, 'bad_slug', 'Invalid slug');
      newSlug = val;
      changes.slug = val;
      continue;
    }
    if (MANAGED_KEYS.has(k)) {
      if (!sameValue(current.fields[k], val)) throw new BlogError(400, 'managed_field', `${k} is changed with the approve/schedule/unschedule actions`);
      continue;
    }
    if (k === 'publish_date' && !isValidDate(val)) throw new BlogError(400, 'bad_date', 'publish_date must be YYYY-MM-DD');
    if (k === 'publish_time' && val !== '' && !TIME_RE.test(val)) throw new BlogError(400, 'bad_time', 'publish_time must be HH:MM');
    changes[k] = val;
  }
  validateSelectOptions(schema, changes);
  for (const f of schema.fields) {
    if (f.required && f.key in changes && (changes[f.key] === '' || (Array.isArray(changes[f.key]) && !changes[f.key].length))) {
      throw new BlogError(400, 'missing_required', `${f.key} is required`);
    }
  }
  let target = file.path;
  if (newSlug) {
    target = contentPath(site, newSlug);
    if (fs.existsSync(target)) throw new BlogError(400, 'slug_taken', `A post with slug "${newSlug}" already exists`);
  }
  let text = file.raw;
  if (Object.keys(changes).length) text = setKeys(text, changes);
  if (body.body_md !== undefined) {
    if (typeof body.body_md !== 'string') throw new BlogError(400, 'bad_body', 'body_md must be a string');
    // Unchanged bodies are not rewritten, so a no-op save keeps the file byte-identical.
    if (body.body_md !== file.parts.body) text = setBody(text, body.body_md);
  }
  if (text !== file.raw) writeAtomic(file.path, text);
  if (newSlug) fs.renameSync(file.path, target);
  return getPost(db, site, newSlug || slug);
}

function mutateKeys(db, site, slug, changes) {
  const file = loadPostFile(site, slug);
  const text = setKeys(file.raw, changes);
  if (text !== file.raw) writeAtomic(file.path, text);
  return getPost(db, site, slug);
}

function approvePost(db, site, slug) {
  return mutateKeys(db, site, slug, { needs_cb_review: false });
}

function schedulePost(db, site, slug, body = {}) {
  const file = loadPostFile(site, slug);
  const cur = buildPost(site, defaultTimeOf(db), file, false);
  if (cur.status === 'published') throw new BlogError(409, 'published', 'Post is already published');
  const date = body.publish_date ?? cur.publish_date;
  if (!isValidDate(date)) throw new BlogError(400, 'bad_date', 'publish_date must be YYYY-MM-DD');
  const time = body.publish_time || cur.publish_time || defaultTimeOf(db);
  if (!TIME_RE.test(time)) throw new BlogError(400, 'bad_time', 'publish_time must be HH:MM');
  return mutateKeys(db, site, slug, { status: 'scheduled', publish_date: date, publish_time: time, updated_date: date });
}

function unschedulePost(db, site, slug) {
  const cur = getPost(db, site, slug);
  if (cur.status === 'published') throw new BlogError(409, 'published', 'A published post cannot be unscheduled');
  return mutateKeys(db, site, slug, { status: 'draft' });
}

// ---------- release runner ----------

const inflight = new Set();
const lastAutoKey = new Map(); // siteId -> signature of the last scheduled attempt (dedupe)

function isPaused(db) {
  const v = getSetting(db, 'blog_paused', false);
  return v === true || v === 'true' || v === 1 || v === '1';
}

function blockedPosts(posts, today) {
  return posts
    .filter((p) => p.status === 'scheduled' && p.needs_review && p.publish_date && p.publish_date <= today)
    .map((p) => ({ slug: p.slug, title: p.title, publish_date: p.publish_date }));
}

// Read the options release.py actually declares (add_argument("--x")), not
// any mention in comments or help text: Lunula's script has no date option and
// deploys with --go, Di-Hy's takes --today, CHolmesIV's takes --date/--deploy.
// An undeclared flag would make argparse refuse, so this only ever fails safe.
const toolFlags = (site) => {
  const text = readText(path.join(site.root, 'blog', 'tools', 'release.py')) || '';
  const declared = new Set([...text.matchAll(/add_argument\(\s*["'](--[a-z-]+)["']/g)].map((m) => m[1]));
  return {
    date: declared.has('--date') ? '--date' : declared.has('--today') ? '--today' : null,
    deploy: declared.has('--deploy') ? '--deploy' : declared.has('--go') ? '--go' : null,
  };
};

function rowToRun(r) {
  if (!r) return null;
  let released = [];
  try { released = JSON.parse(r.released || '[]'); } catch { /* ignore */ }
  return {
    id: r.id,
    site_id: r.site_id,
    trigger: r.trigger,
    mode: r.mode,
    started_at: r.started_at,
    finished_at: r.finished_at,
    exit_code: r.exit_code,
    ok: r.exit_code === 0,
    released,
    summary: r.summary || '',
    output: r.output || '',
  };
}

function lastRelease(db, siteId) {
  return rowToRun(db.prepare('SELECT * FROM blog_releases WHERE site_id = ? ORDER BY id DESC LIMIT 1').get(siteId));
}

function listReleases(db, siteId, limit = 20) {
  return db.prepare('SELECT * FROM blog_releases WHERE site_id = ? ORDER BY id DESC LIMIT ?').all(siteId, limit).map(rowToRun);
}

/**
 * Run the site's release.py once. Returns { run } on completion, or
 * { error: 'blocked', blocked } / { error: 'in_flight' } without running.
 * NEVER passes --allow-unreviewed; --deploy only outside dry-run mode.
 */
async function runRelease(db, site, { trigger = 'manual', dry = false, now = new Date() } = {}) {
  if (inflight.has(site.id)) return { error: 'in_flight' };
  const today = localDate(now);
  const blocked = blockedPosts(listPosts(db, site), today);
  if (blocked.length) return { error: 'blocked', blocked };
  inflight.add(site.id);
  const startedAt = nowIso();
  try {
    const deploy = !isDryRun() && !dry;
    const flags = toolFlags(site);
    const args = ['blog/tools/release.py'];
    if (flags.date) args.push(flags.date, today);
    if (deploy && !flags.deploy) {
      // No recognizable deploy option: never guess one against a live site.
      throw new BlogError(409, 'no_deploy_flag', `${site.name}'s release.py declares no --deploy or --go option`);
    }
    if (deploy) args.push(flags.deploy);
    const timeout = Number(process.env.POSTDECK_BLOG_RELEASE_TIMEOUT_MS) || 10 * 60 * 1000;
    const { err, stdout, stderr } = await execFileP(pythonBin(), args, { cwd: site.root, timeout });
    let exitCode = 0;
    let output = stdout + (stderr ? (stdout && !stdout.endsWith('\n') ? '\n' : '') + stderr : '');
    if (err) {
      exitCode = typeof err.code === 'number' ? err.code : -1;
      if (typeof err.code !== 'number') output += `\n[postdeck] ${err.killed ? 'release timed out or was killed: ' : ''}${err.message}`;
    }
    const released = [...output.matchAll(/^(?:published|would publish):\s*(\S+)/gm)].map((m) => m[1].replace(/\.md$/, ''));
    const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    // The script's last line is an instruction to a human ("Re-run with
    // --deploy to ship"), so successful runs get a plain sentence instead.
    const n = released.length;
    const posts = `${n} post${n === 1 ? '' : 's'}`;
    const summary = exitCode === 0
      ? (deploy
        ? (n ? `Released ${posts}. Site rebuilt and uploaded.` : 'Site rebuilt and uploaded. No new posts were due.')
        : (n ? `Dry run passed: would release ${posts}. Nothing was uploaded.` : 'Dry run passed. No posts were due. Nothing was uploaded.'))
      : (lines[lines.length - 1] || 'Release failed.').slice(0, 300);
    const finishedAt = nowIso();
    const info = db
      .prepare(
        `INSERT INTO blog_releases (site_id, "trigger", mode, started_at, finished_at, exit_code, released, summary, output)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(site.id, trigger, deploy ? 'deploy' : 'dry', startedAt, finishedAt, exitCode, JSON.stringify(released), summary, tail(output));
    return { run: rowToRun(db.prepare('SELECT * FROM blog_releases WHERE id = ?').get(info.lastInsertRowid)) };
  } finally {
    inflight.delete(site.id);
  }
}

async function releaseNow(db, site, slug, { dry = false } = {}) {
  const post = getPost(db, site, slug);
  if (post.status === 'published') throw new BlogError(409, 'published', 'Post is already published');
  if (post.needs_review) throw new BlogError(409, 'not_approved', 'Approve the post before releasing it');
  if (inflight.has(site.id)) throw new BlogError(409, 'in_flight', 'A release is already running for this site');
  const today = localDate();
  const blocked = blockedPosts(listPosts(db, site), today).filter((b) => b.slug !== slug);
  if (blocked.length) throw new BlogError(409, 'blocked', 'Other due posts still need review', { blocked });
  const changes = { status: 'scheduled' };
  if (!isValidDate(post.publish_date) || post.publish_date > today) {
    changes.publish_date = today;
    changes.updated_date = today;
  }
  if (!post.publish_time) changes.publish_time = defaultTimeOf(db);
  mutateKeys(db, site, slug, changes);
  const res = await runRelease(db, site, { trigger: 'manual', dry });
  if (res.error) throw new BlogError(409, res.error, 'Release did not run', res.blocked ? { blocked: res.blocked } : {});
  return { run: res.run, post: getPost(db, site, slug) };
}

/** Worker phase: release approved posts whose date+time has passed. Never throws. */
async function runBlogPhase(db, { now = new Date() } = {}) {
  let ran = 0;
  try {
    if (isPaused(db)) return 0;
    for (const site of discoverSites(db)) {
      try {
        if (inflight.has(site.id)) continue;
        const posts = listPosts(db, site);
        const due = posts.filter((p) => p.status === 'scheduled' && !p.needs_review && p.due_at && new Date(p.due_at) <= now);
        if (!due.length) {
          lastAutoKey.delete(site.id);
          continue;
        }
        const today = localDate(now);
        const blocked = blockedPosts(posts, today);
        const key = `${isDryRun() ? 'dry' : 'deploy'}|${blocked.map((b) => b.slug).join(',')}|${due.map((p) => p.slug).sort().join(',')}`;
        // One automatic attempt per distinct situation: avoids re-logging the
        // same block, re-running a dry run (dry runs never flip status) or
        // hammering a failing deploy every cycle. Release now retries by hand.
        if (lastAutoKey.get(site.id) === key) continue;
        lastAutoKey.set(site.id, key);
        if (blocked.length) {
          console.log(`[blog] ${site.id}: release blocked, ${blocked.length} due post(s) need review: ${blocked.map((b) => b.slug).join(', ')}`);
          continue;
        }
        const res = await runRelease(db, site, { trigger: 'schedule', now });
        if (res.run) {
          ran++;
          if (!res.run.ok) console.error(`[blog] ${site.id}: scheduled release failed (exit ${res.run.exit_code}): ${res.run.summary}`);
        }
      } catch (err) {
        console.error(`[blog] ${site.id}: scheduler error: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('[blog] scheduler phase error', err);
  }
  return ran;
}

function _resetBlogState() {
  lastAutoKey.clear();
  inflight.clear();
}

// ---------- preview ----------

const PREVIEW_TTL_MS = 30 * 60 * 1000;
const PREVIEW_MAX = 10;
const previews = new Map(); // token -> { dir, out, siteId, slug, at }
const COPY_EXCLUDE = new Set(['preview', 'archive', 'research', '.release-dryrun', '__pycache__']);

function dropPreview(token) {
  const p = previews.get(token);
  previews.delete(token);
  if (p) fs.rmSync(p.dir, { recursive: true, force: true });
}

function sweepPreviews() {
  const now = Date.now();
  for (const [t, p] of [...previews]) if (now - p.at > PREVIEW_TTL_MS) dropPreview(t);
  while (previews.size >= PREVIEW_MAX) dropPreview(previews.keys().next().value);
}

process.on('exit', () => {
  for (const p of previews.values()) {
    try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function parseQaLines(stdout, slug) {
  const all = [];
  let header = '';
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(FAIL|WARN)\s+(.*)$/.exec(line);
    if (m) all.push({ level: m[1], message: m[2].trim(), header });
    else if (line && !/^\s/.test(line) && !/^(Checked|SUMMARY)/.test(line)) header = line.trim();
  }
  const mine = all.filter((x) => x.header.includes(slug) || x.message.includes(slug));
  const picked = mine.length ? mine : all.filter((x) => x.level === 'FAIL');
  return picked.map(({ level, message }) => ({ level, message }));
}

async function buildPreview(db, site, slug) {
  loadPostFile(site, slug); // validates slug + existence
  const blogSrc = path.join(site.root, 'blog');
  const builder = path.join(blogSrc, 'tools', 'build_blog.py');
  if (!fs.existsSync(builder)) {
    return { url: null, qa: [], build_error: 'This site has no blog/tools/build_blog.py, so PostDeck cannot build a preview for it.' };
  }
  sweepPreviews();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'postdeck-blog-preview-'));
  const siteCopy = path.join(dir, 'site');
  const out = path.join(dir, 'out');
  try {
    fs.mkdirSync(siteCopy, { recursive: true });
    fs.cpSync(blogSrc, path.join(siteCopy, 'blog'), {
      recursive: true,
      filter: (src) => {
        const rel = path.relative(blogSrc, src);
        if (!rel) return true;
        const parts = rel.split(path.sep);
        return !COPY_EXCLUDE.has(parts[0]) && !parts.includes('__pycache__');
      },
    });
    const realDist = path.join(site.root, 'dist');
    if (fs.existsSync(realDist)) fs.symlinkSync(realDist, path.join(siteCopy, 'dist'), 'dir');
    const copyFile = path.join(siteCopy, 'blog', 'content', `${slug}.md`);
    const copyRaw = fs.readFileSync(copyFile, 'utf8');
    const forced = setKeys(copyRaw, { status: 'scheduled' });
    if (forced !== copyRaw) fs.writeFileSync(copyFile, forced, 'utf8');

    const build = await execFileP(pythonBin(), ['blog/tools/build_blog.py', '--preview', '--out', out], { cwd: siteCopy, timeout: 60_000 });
    const page = path.join(out, 'blog', slug, 'index.html');
    if (build.err || !fs.existsSync(page)) {
      const msg = build.err ? tail((build.stderr || build.stdout || build.err.message).trim(), 4000) : `Build finished but blog/${slug}/index.html was not produced.`;
      fs.rmSync(dir, { recursive: true, force: true });
      return { url: null, qa: [], build_error: msg };
    }
    let qa = [];
    const qaScript = path.join(siteCopy, 'blog', 'tools', 'qa.py');
    if (fs.existsSync(qaScript)) {
      const r = await execFileP(pythonBin(), ['blog/tools/qa.py', '--preview', '--tree', out], { cwd: siteCopy, timeout: 60_000 });
      qa = parseQaLines(r.stdout, slug);
    }
    const token = crypto.randomBytes(12).toString('hex');
    previews.set(token, { dir, out, siteId: site.id, slug, at: Date.now() });
    return { url: `/api/blog/preview/${token}/blog/${slug}/index.html`, qa, build_error: null };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    if (err instanceof BlogError) throw err;
    return { url: null, qa: [], build_error: err.message };
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function rewriteHtml(html, token) {
  const prefix = `/api/blog/preview/${token}/`;
  return html
    .replace(/(\b(?:href|src|poster|action)\s*=\s*)(["'])\/(?!\/)/gi, `$1$2${prefix}`)
    .replace(/(\bsrcset\s*=\s*)(["'])([^"']*)\2/gi, (_m, a, q, list) =>
      `${a}${q}${list.split(',').map((c) => c.replace(/^(\s*)\/(?!\/)/, `$1${prefix}`)).join(',')}${q}`)
    .replace(/url\(\s*(["']?)\/(?!\/)/gi, `url($1${prefix}`);
}

function servePreviewFile(token, rel) {
  sweepPreviews();
  const p = previews.get(token);
  if (!p) throw new BlogError(404, 'preview_expired', 'Preview expired. Build it again.');
  if (typeof rel !== 'string' || rel.includes('\0')) throw new BlogError(400, 'bad_path', 'Bad path');
  let decoded;
  try { decoded = decodeURIComponent(rel); } catch { throw new BlogError(400, 'bad_path', 'Bad path'); }
  const root = fs.realpathSync(p.out);
  let abs = path.resolve(root, decoded);
  const inside = (x) => x === root || x.startsWith(root + path.sep);
  if (!inside(abs)) throw new BlogError(404, 'not_found', 'Not found');
  try {
    if (fs.statSync(abs).isDirectory()) abs = path.join(abs, 'index.html');
    const real = fs.realpathSync(abs);
    if (!inside(real)) throw new BlogError(404, 'not_found', 'Not found');
    abs = real;
  } catch (err) {
    if (err instanceof BlogError) throw err;
    throw new BlogError(404, 'not_found', 'Not found');
  }
  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  if (ext === '.html') return { type, body: rewriteHtml(fs.readFileSync(abs, 'utf8'), token) };
  if (ext === '.css') return { type, body: rewriteHtml(fs.readFileSync(abs, 'utf8'), token) };
  return { type, body: fs.readFileSync(abs) };
}

// ---------- AI draft ----------

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

function buildBlogPrompt({ brandName, voice, hardRules, schemaKeys, target, examples, input }) {
  const extra = ['headline', 'seo_title', 'dek'].filter((k) => schemaKeys.includes(k));
  const jsonKeys = ['title', ...extra, 'description', 'primary_keyword', 'body_md'];
  return [
    `You are drafting a blog post for ${brandName || 'the site owner'}'s own blog.`,
    `IMPORTANT: You have NO access to files, the internet, or any tools. Work only from this message. Output ONLY the JSON object described below, no preamble.`,
    `Voice rules: ${voice || '(none provided)'}`,
    `Hard rules (mechanically re-enforced after your output): ${hardRules}`,
    ``,
    `Blog rules:`,
    `- Markdown body, structured with H2 (##) sections. Do not repeat the title as an H1.`,
    `- Target length about ${target} words.`,
    `- Put the primary keyword naturally in the first 100 words.`,
    `- No em dashes or en dashes anywhere. Use a plain hyphen or rewrite.`,
    `- Do not invent facts, statistics, quotes, clients or numbers. If you lack a fact, write around it or flag it with [CB: verify].`,
    `- description is a plain sentence of 120-160 characters.`,
    ``,
    ...examples.map((e, i) => `Style example ${i + 1} (title: ${e.title}):\n${e.excerpt}\n`),
    `Post to write:`,
    input.title ? `Title / working title: ${input.title}` : '',
    input.idea ? `Idea: ${input.idea}` : '',
    input.primary_keyword ? `Primary keyword: ${input.primary_keyword}` : '',
    input.notes ? `Notes / outline from the author:\n${input.notes}` : '',
    ``,
    `Respond with STRICT JSON ONLY, no markdown fences: an object with keys ${jsonKeys.map((k) => `"${k}"`).join(', ')}. body_md is the full post as a markdown string.`,
  ].filter((l) => l !== '').join('\n');
}

async function draftBlogPost(db, body = {}) {
  const site = getSite(db, String(body.site || ''));
  const title = String(body.title || '').trim();
  const idea = String(body.idea || '').trim();
  if (!title && !idea) throw new BlogError(400, 'bad_request', 'title or idea is required');
  const files = listFiles(site);
  const schema = deriveSchema(site, files);
  const keys = schema.fields.map((f) => f.key);
  const dt = defaultTimeOf(db);
  const published = files
    .map((f) => buildPost(site, dt, f, true))
    .filter((p) => p.status === 'published')
    .sort((a, b) => (a.publish_date < b.publish_date ? 1 : -1));
  const med = median(published.map((p) => p.word_count).filter((n) => n > 50));
  const target = med ? Math.round(med / 50) * 50 : 1200;
  const examples = published.slice(0, 2).map((p) => ({ title: p.title, excerpt: p.body_md.trim().slice(0, 1500) }));

  const brandId = site.brand_id;
  const brand = brandId ? db.prepare('SELECT * FROM brands WHERE id = ?').get(brandId) : null;
  const effective = withGlobalVoice(db, { brand_id: brandId });
  let hardRulesObj = {};
  try { hardRulesObj = JSON.parse(effective.hard_rules || '{}'); } catch { /* ignore */ }
  const prompt = buildBlogPrompt({
    brandName: brand ? brand.name : site.name,
    voice: effective.voice_rules,
    hardRules: JSON.stringify(hardRulesObj),
    schemaKeys: keys,
    target,
    examples,
    input: { title, idea, notes: String(body.notes || '').trim(), primary_keyword: String(body.primary_keyword || '').trim() },
  });

  const provider = body.provider || getRawSetting(db, 'draft_provider') || 'claude';
  const model = process.env.POSTDECK_BLOG_DRAFT_MODEL || process.env.POSTDECK_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
  let raw;
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text;
    try {
      text = await aiRunDraft(provider, { prompt, model, budget: process.env.POSTDECK_BLOG_DRAFT_BUDGET || '0.30', timeoutMs: 240_000 });
    } catch (err) {
      throw new BlogError(err.statusCode || 503, 'ai_unavailable', err.message || 'AI drafting unavailable');
    }
    try {
      raw = parseInnerJson(text);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr || !raw || typeof raw !== 'object') throw new BlogError(503, 'ai_unavailable', `AI drafting unavailable: ${lastErr ? lastErr.message : 'empty result'}`);

  const clean = (s) => normalizeDashes(scrubText(String(s ?? ''), hardRulesObj).text).trim();
  const fields = {};
  const t = clean(raw.title) || title || idea;
  fields.title = t;
  for (const k of ['headline', 'seo_title']) if (keys.includes(k)) fields[k] = clean(raw[k]) || t;
  if (keys.includes('dek')) fields.dek = clean(raw.dek);
  fields.description = clean(raw.description);
  fields.primary_keyword = clean(raw.primary_keyword) || String(body.primary_keyword || '').trim();
  const body_md = normalizeDashes(scrubText(String(raw.body_md ?? raw.body ?? ''), hardRulesObj).text).trim() + '\n';
  recordUsage(db, { kind: 'ai_draft', brand_id: brandId });
  return { fields, body_md, provider };
}

// ---------- settings (blog_paused, blog_default_time, blog_site_brand:<id>) ----------

function getBlogSettings(db) {
  const out = { blog_paused: isPaused(db), blog_default_time: defaultTimeOf(db) };
  for (const s of discoverSites(db)) out[`blog_site_brand:${s.id}`] = s.brand_id;
  return out;
}

function updateBlogSettings(db, patch = {}) {
  if (patch.blog_paused !== undefined) setSetting(db, 'blog_paused', patch.blog_paused === true || patch.blog_paused === 'true' || patch.blog_paused === 1 || patch.blog_paused === '1');
  if (patch.blog_default_time !== undefined && TIME_RE.test(String(patch.blog_default_time))) setSetting(db, 'blog_default_time', String(patch.blog_default_time));
  for (const [k, v] of Object.entries(patch)) {
    if (!k.startsWith('blog_site_brand:')) continue;
    const id = k.slice('blog_site_brand:'.length);
    if (!/^[a-z0-9-]+$/.test(id)) continue;
    if (v === null || v === '') setSetting(db, k, null);
    else if (Number.isInteger(Number(v)) && db.prepare('SELECT id FROM brands WHERE id = ?').get(Number(v))) setSetting(db, k, Number(v));
  }
}

// ---------- routes ----------

function registerBlogRoutes(app, db) {
  const wrap = (fn) => async (req, reply) => {
    try {
      return await fn(req, reply);
    } catch (err) {
      if (err instanceof BlogError) {
        reply.code(err.status);
        return { error: err.code, message: err.message, ...err.extra };
      }
      app.log.error(err);
      reply.code(500);
      return { error: 'internal', message: err.message };
    }
  };
  const site = (req) => getSite(db, req.params.site);
  const base = '/api/blog/sites/:site';

  app.get('/api/blog/sites', wrap(async () => discoverSites(db).map((s) => buildSiteSummary(db, s))));
  app.get(`${base}/schema`, wrap(async (req) => getSchema(site(req))));
  app.get(`${base}/posts`, wrap(async (req) => listPosts(db, site(req))));
  app.get(`${base}/posts/:slug`, wrap(async (req) => getPost(db, site(req), req.params.slug)));
  app.post(`${base}/posts`, wrap(async (req, reply) => {
    const post = createPost(db, site(req), req.body || {});
    reply.code(201);
    return post;
  }));
  app.patch(`${base}/posts/:slug`, wrap(async (req) => patchPost(db, site(req), req.params.slug, req.body || {})));
  app.post(`${base}/posts/:slug/approve`, wrap(async (req) => approvePost(db, site(req), req.params.slug)));
  app.post(`${base}/posts/:slug/schedule`, wrap(async (req) => schedulePost(db, site(req), req.params.slug, req.body || {})));
  app.post(`${base}/posts/:slug/unschedule`, wrap(async (req) => unschedulePost(db, site(req), req.params.slug)));
  app.post(`${base}/posts/:slug/release-now`, wrap(async (req) => releaseNow(db, site(req), req.params.slug, { dry: !!(req.body && req.body.dry) })));
  app.post(`${base}/release`, wrap(async (req, reply) => {
    const res = await runRelease(db, site(req), { trigger: 'manual', dry: !!(req.body && req.body.dry) });
    if (res.error) {
      reply.code(409);
      return { error: res.error, ...(res.blocked ? { blocked: res.blocked } : {}) };
    }
    return { run: res.run };
  }));
  app.get(`${base}/releases`, wrap(async (req) => listReleases(db, site(req).id)));
  const previewHandler = wrap(async (req) => buildPreview(db, site(req), req.params.slug));
  app.post(`${base}/posts/:slug/preview`, previewHandler);
  app.get(`${base}/posts/:slug/preview`, previewHandler);
  app.get('/api/blog/preview/:token/*', wrap(async (req, reply) => {
    const { type, body } = servePreviewFile(req.params.token, req.params['*'] || '');
    reply.header('Content-Type', type);
    reply.header('Cache-Control', 'no-store');
    reply.header('Content-Security-Policy', "script-src 'none'; object-src 'none'; base-uri 'none'");
    return reply.send(body);
  }));
  app.post('/api/blog/draft', wrap(async (req) => draftBlogPost(db, req.body || {})));
}

export {
  registerBlogRoutes,
  runBlogPhase,
  runRelease,
  getBlogSettings,
  updateBlogSettings,
  discoverSites,
  parseValue,
  setKeys,
  setBody,
  splitFile,
  entriesOf,
  formatValue,
  slugify,
  localDate,
  BlogError,
  _resetBlogState,
};
