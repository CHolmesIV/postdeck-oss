// Copy assistant (B8 — SPEC.md "Copy assistant"). Extends Draft-with-AI from
// one blob to pickable pieces: headlines, alt_text, hashtags, or all three.
// Same `claude -p` shell as draft.js (env overrides, --output-format json
// envelope, 60s timeout, 503 when the CLI is unavailable) and the same
// mechanical scrub.js pass on every returned string. Never auto-fills a
// composer field — the human picks a variant and Approves (SPEC.md).

import { execFile } from 'node:child_process';
import { scrubText } from './scrub.js';
import { getPlatformSpec } from './platforms.js';
import { runDraft as aiRunDraft } from './ai.js';

// Overridable for tests so we can point at a binary that doesn't exist
// without touching the real PATH / ANTHROPIC key. Mirrors draft.js's env
// overrides, but read lazily (per-call, not at module-import time) so tests
// can swap POSTDECK_CLAUDE_BIN between cases within the same process.
function claudeBin() {
  return process.env.POSTDECK_CLAUDE_BIN || 'claude';
}
function draftModel() {
  return process.env.POSTDECK_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
}
function maxBudgetUsd() {
  return process.env.POSTDECK_DRAFT_BUDGET || '0.05';
}

const MODES = ['headlines', 'alt_text', 'hashtags', 'all'];

function brandVoiceBlock({ brand, toneProfile, grounding }) {
  const hardRules = JSON.stringify(JSON.parse(toneProfile?.hard_rules || '{}'));
  const lines = [
    `Brand: "${brand?.name ?? '(unknown brand)'}".`,
    `Tone profile: ${toneProfile?.name ?? '(none)'}.`,
    `Voice rules: ${toneProfile?.voice_rules || '(none provided)'}`,
    `Hard rules (must also follow exactly, mechanically re-enforced after your output): ${hardRules}`,
  ];
  if (grounding) {
    lines.push(
      `Grounding (research notes / this brand's own top-performing posts — use to inform choices, do not quote verbatim unless natural): ${grounding}`
    );
  }
  return lines.join('\n');
}

function headlinesPrompt(ctx) {
  return [
    brandVoiceBlock(ctx),
    ``,
    `Idea/copy context: ${ctx.idea_text || ctx.copy || '(none provided)'}`,
    ``,
    `Write 3-5 distinct hook/headline variants for this content (short, punchy, thumb-stopping).`,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary:`,
    `{"headlines": ["...", "..."]}`,
  ].join('\n');
}

function altTextPrompt(ctx) {
  const filename = ctx.image_path ? ctx.image_path.split('/').pop() : '(no image path provided)';
  return [
    brandVoiceBlock(ctx),
    ``,
    `Copy context: ${ctx.copy || ctx.idea_text || '(none provided)'}`,
    `Image file name (you cannot see the actual image): ${filename}`,
    ``,
    `Write ONE concise, accessible alt-text description for the image attached to this post.`,
    `NOTE: you cannot see the image itself — infer a plausible, generic-but-useful description`,
    `from the file name and copy context only. Do not invent specific visual details you can't`,
    `justify from that context (no fabricated people, brands, or text-in-image claims).`,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary:`,
    `{"alt_text": "..."}`,
  ].join('\n');
}

function hashtagsPrompt(ctx) {
  const platforms = ctx.platforms && ctx.platforms.length ? ctx.platforms : [];
  const countLines = platforms
    .map((p) => {
      const spec = getPlatformSpec(p);
      const best = spec?.text?.hashtags_best;
      if (!best || (best[0] === 0 && best[1] === 0)) {
        return `- ${p}: no hashtags (not applicable/best-practice is zero)`;
      }
      return `- ${p}: ${best[0]}-${best[1]} hashtags`;
    })
    .join('\n');
  return [
    brandVoiceBlock(ctx),
    ``,
    `Copy context: ${ctx.copy || ctx.idea_text || '(none provided)'}`,
    ``,
    `Suggest hashtags per platform, respecting each platform's best-practice count:`,
    countLines || '(no platforms specified)',
    ``,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary — an object mapping`,
    `each platform to an array of hashtag strings (each starting with #):`,
    `{"hashtags": {"instagram": ["#a", "#b"]}}`,
    `Platforms: ${platforms.join(', ') || '(none)'}`,
  ].join('\n');
}

function allPrompt(ctx) {
  const filename = ctx.image_path ? ctx.image_path.split('/').pop() : '(no image path provided)';
  const platforms = ctx.platforms && ctx.platforms.length ? ctx.platforms : [];
  const countLines = platforms
    .map((p) => {
      const spec = getPlatformSpec(p);
      const best = spec?.text?.hashtags_best;
      if (!best || (best[0] === 0 && best[1] === 0)) {
        return `- ${p}: no hashtags (not applicable/best-practice is zero)`;
      }
      return `- ${p}: ${best[0]}-${best[1]} hashtags`;
    })
    .join('\n');

  return [
    brandVoiceBlock(ctx),
    ``,
    `Idea/copy context: ${ctx.idea_text || ctx.copy || '(none provided)'}`,
    ``,
    `Produce THREE things in one response:`,
    `1. headlines: 3-5 distinct hook/headline variants for this content (short, punchy).`,
    `2. alt_text: ONE concise, accessible alt-text description for the attached image`,
    `   (file name: ${filename}). NOTE: you cannot see the image itself — infer a`,
    `   plausible, generic-but-useful description from the file name and copy context`,
    `   only. Do not invent specific visual details you can't justify from that context.`,
    `3. hashtags: per-platform hashtag suggestions, respecting each platform's`,
    `   best-practice count:`,
    countLines || '   (no platforms specified)',
    ``,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary — a single object`,
    `combining all three shapes:`,
    `{"headlines": ["...", "..."], "alt_text": "...", "hashtags": {"instagram": ["#a"]}}`,
    `Platforms: ${platforms.join(', ') || '(none)'}`,
  ].join('\n');
}

/**
 * Build the mode-specific prompt. Exported for testability.
 * @param {{mode: string, idea_text?: string, copy?: string, brand?: object,
 *   toneProfile?: object, platforms?: string[], image_path?: string,
 *   grounding?: string}} ctx
 */
function buildCopyAssistPrompt(ctx) {
  const mode = ctx?.mode;
  if (!MODES.includes(mode)) {
    throw new Error(`copy_assist: unknown mode "${mode}" (expected one of ${MODES.join(', ')})`);
  }
  if (mode === 'headlines') return headlinesPrompt(ctx);
  if (mode === 'alt_text') return altTextPrompt(ctx);
  if (mode === 'hashtags') return hashtagsPrompt(ctx);
  return allPrompt(ctx);
}

/**
 * Extract a JSON object from a claude CLI --output-format json response.
 * The outer wrapper is CLI metadata; `result` holds the model's raw text,
 * which itself should be the strict JSON we asked for. Identical shape to
 * draft.js's parseClaudeCliOutput, duplicated here to keep this module
 * dependency-free of draft.js (per B8 build-split, these are independent
 * Wave-1 modules).
 */
function parseClaudeCliOutput(stdout) {
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

// Retained for back-compat / existing direct tests of the legacy claude-only
// shell (no longer on the runtime path — copyAssist now routes through
// src/ai.js's provider registry, see below).
function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      claudeBin(),
      ['-p', prompt, '--model', draftModel(), '--max-budget-usd', String(maxBudgetUsd()), '--output-format', 'json'],
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
 * Strip markdown fences (if any) and JSON.parse the model's raw text (the
 * already-unwrapped-from-CLI-envelope text that src/ai.js's runDraft
 * resolves to). This is the "inner" half of the old parseClaudeCliOutput,
 * split out so it can run on ai.js's already-unwrapped text regardless of
 * which provider produced it.
 */
function parseInnerJson(resultText) {
  const cleaned = String(resultText).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`AI CLI result was not strict JSON: ${err.message}`);
  }
}

/**
 * Run scrub.js hard-rules scrubbing over every string value the result
 * contains, regardless of mode/shape. Returns { result, scrub_applied }.
 */
function scrubResult(raw, hardRules) {
  const appliedSet = new Set();

  function scrubValue(value) {
    if (typeof value === 'string') {
      const { text, applied } = scrubText(value, hardRules);
      for (const a of applied) appliedSet.add(a);
      return text;
    }
    if (Array.isArray(value)) {
      return value.map(scrubValue);
    }
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = scrubValue(v);
      return out;
    }
    return value;
  }

  const result = scrubValue(raw);
  return { result, scrub_applied: [...appliedSet] };
}

/**
 * @param {{mode: 'headlines'|'alt_text'|'hashtags'|'all', idea_text?: string,
 *   copy?: string, brand?: object, toneProfile?: object, platforms?: string[],
 *   image_path?: string, grounding?: string, provider?: 'claude'|'codex'}} params
 * @returns {Promise<{result: object, scrub_applied: string[]}>}
 * @throws {Error & {statusCode?: number}} 503-flagged error if the CLI is unavailable/errors.
 */
async function copyAssist(params) {
  const prompt = buildCopyAssistPrompt(params);
  const chosenProvider = params.provider || 'claude';

  let resultText;
  try {
    resultText = await aiRunDraft(chosenProvider, { prompt, model: draftModel(), budget: maxBudgetUsd() });
  } catch (err) {
    const wrapped = new Error(err.message || `Copy assist unavailable via ${chosenProvider}`);
    wrapped.statusCode = err.statusCode || 503;
    throw wrapped;
  }

  let raw;
  try {
    raw = parseInnerJson(resultText);
  } catch (err) {
    const wrapped = new Error(`Copy assist unavailable: ${err.message}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }

  const hardRules = JSON.parse(params.toneProfile?.hard_rules || '{}');
  return scrubResult(raw, hardRules);
}

export { copyAssist, buildCopyAssistPrompt, parseClaudeCliOutput, MODES };
