// Extraction helpers (B11 — SPEC.md "Assisted-manual upgrade + blog
// redistribution"). Two independent extraction paths, deliberately routed to
// different "costs":
//   - extractFromUrl: pure fetch + string work, NO model call. Strips a page
//     down to readable markdown-ish text for redistribution drafting.
//   - extractFromImage: EXACTLY ONE `claude -p` vision call (cheap model via
//     POSTDECK_VISION_MODEL), for turning a screenshot into text ONCE. The
//     caller (src/examples.js) is responsible for caching the result so the
//     image is never re-read. Same CLI shell/env-override/503 contract as
//     copy_assist.js and draft.js.

import { execFile } from 'node:child_process';

// ---------- extractFromUrl (pure code, no model) ----------

const MAX_MARKDOWN_CHARS = 12_000;

const ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

function decodeEntities(str) {
  return str.replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITY_MAP[m] ?? m);
}

/** Remove <script>, <style>, and <head> blocks (tags + their content). */
function stripNonContentBlocks(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/** Pull out the first match of a tag's inner HTML, non-greedy, single tag name. */
function extractTag(html, tagName) {
  const re = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const m = html.match(re);
  return m ? m[1] : null;
}

function extractTitle(html) {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const t = decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    const t = decodeEntities(h1Match[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (t) return t;
  }
  return null;
}

/**
 * Convert a body-ish HTML fragment to markdown-ish plain text, line by line
 * (not one giant greedy regex over the whole blob):
 *  - h1-h3 -> "# " prefix (heading markers, all treated as one level here —
 *    good enough for a redistribution-drafting prompt, not a full renderer)
 *  - li -> "- " prefix
 *  - p/br/div -> newline breaks
 *  - all other tags stripped
 */
function htmlFragmentToMarkdown(fragment) {
  let work = fragment;

  // Headings -> "# heading text" on their own line.
  work = work.replace(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi, (_, inner) => `\n# ${stripTags(inner)}\n`);
  // List items -> "- item text" on their own line.
  work = work.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, inner) => `\n- ${stripTags(inner)}\n`);
  // Block-level separators become newlines.
  work = work.replace(/<\/(p|div|section|article)>/gi, '\n');
  work = work.replace(/<br\s*\/?>/gi, '\n');

  work = stripTags(work);
  work = decodeEntities(work);

  // Collapse runs of 3+ newlines (with optional whitespace between) to 2.
  work = work.replace(/\n[ \t]*(\n[ \t]*){2,}/g, '\n\n');
  // Collapse runs of spaces/tabs.
  work = work.replace(/[ \t]{2,}/g, ' ');
  // Trim trailing spaces on each line.
  work = work
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n');

  return work.trim();
}

function stripTags(str) {
  return str.replace(/<[^>]+>/g, '');
}

/**
 * Fetch a URL and reduce it to `{ title, markdown }`. Pure string work, no
 * model call. Throws a clear Error on a non-OK response or a fetch failure.
 * Output is capped at ~12000 chars (with a truncation note appended).
 */
async function extractFromUrl(url) {
  let response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw new Error(`extractFromUrl: failed to fetch "${url}": ${err.message}`);
  }
  if (!response.ok) {
    throw new Error(`extractFromUrl: "${url}" returned HTTP ${response.status} ${response.statusText || ''}`.trim());
  }

  const html = await response.text();
  const title = extractTitle(html);

  const cleaned = stripNonContentBlocks(html);
  const contentHtml =
    extractTag(cleaned, 'article') ?? extractTag(cleaned, 'main') ?? extractTag(cleaned, 'body') ?? cleaned;

  let markdown = htmlFragmentToMarkdown(contentHtml);

  if (markdown.length > MAX_MARKDOWN_CHARS) {
    markdown = `${markdown.slice(0, MAX_MARKDOWN_CHARS).trim()}\n\n… (truncated, original content was longer)`;
  }

  return { title, markdown };
}

// ---------- extractFromImage (ONE claude -p vision call) ----------

// Overridable for tests, mirroring copy_assist.js's lazy per-call env reads
// so tests can swap POSTDECK_CLAUDE_BIN between cases within one process.
function claudeBin() {
  return process.env.POSTDECK_CLAUDE_BIN || 'claude';
}
function visionModel() {
  return process.env.POSTDECK_VISION_MODEL || 'claude-haiku-4-5-20251001';
}
function maxBudgetUsd() {
  return process.env.POSTDECK_VISION_BUDGET || '0.05';
}

/**
 * Build the vision-extraction prompt. Exported for testability.
 * The `claude -p` CLI reads an image referenced by an absolute file path
 * placed in the prompt text (same convention as Claude Code's own file
 * references) — so we put the path on its own line and instruct the model
 * to read/view that image file, then return strict JSON.
 */
function buildImageExtractPrompt(imagePath) {
  return [
    `Read the social post in this image and return its text content as clean markdown.`,
    `Image file: ${imagePath}`,
    ``,
    `Return STRICT JSON ONLY, no markdown fences, no commentary:`,
    `{"text": "..."}`,
  ].join('\n');
}

/**
 * Extract a JSON object from a claude CLI --output-format json response.
 * Same envelope shape/parsing as copy_assist.js / draft.js, duplicated here
 * to keep this module dependency-free of those (independent Wave-1 module).
 */
function parseImageExtractOutput(stdout) {
  let outer;
  try {
    outer = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude CLI did not return valid JSON envelope: ${err.message}`);
  }
  const resultText = typeof outer.result === 'string' ? outer.result : stdout;
  const cleaned = resultText.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  let inner;
  try {
    inner = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`claude CLI result was not strict JSON: ${err.message}`);
  }
  return inner;
}

function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      ['-p', prompt, '--model', visionModel(), '--max-budget-usd', String(maxBudgetUsd()), '--output-format', 'json'],
      { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(new Error(stderr || err.message), { cause: err }));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

/**
 * ONE `claude -p` vision call that reads a screenshot and returns its text
 * content as markdown. Do NOT call this more than once per image — callers
 * (src/examples.js) must cache the result.
 * @param {string} imagePath absolute path to the image file
 * @returns {Promise<{text: string}>}
 * @throws {Error & {statusCode?: number}} 503-flagged error if the CLI is unavailable/errors.
 */
async function extractFromImage(imagePath) {
  const prompt = buildImageExtractPrompt(imagePath);

  let stdout;
  try {
    stdout = await runClaudeCli(prompt);
  } catch (err) {
    const wrapped = new Error(
      `Image extraction unavailable: could not run claude CLI (${err.code === 'ENOENT' ? 'not found on PATH' : err.message})`
    );
    wrapped.statusCode = 503;
    throw wrapped;
  }

  let parsed;
  try {
    parsed = parseImageExtractOutput(stdout);
  } catch (err) {
    const wrapped = new Error(`Image extraction unavailable: ${err.message}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }

  return { text: typeof parsed.text === 'string' ? parsed.text : '' };
}

export { extractFromUrl, extractFromImage, buildImageExtractPrompt, parseImageExtractOutput };
