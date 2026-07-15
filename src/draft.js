// "Draft with AI": shells out to the `claude` CLI (cheap model) to draft
// per-platform copy from an idea + brand voice + tone profile, then runs the
// mechanical hard-rules scrub (src/scrub.js) before the text ever reaches the
// composer. Never auto-approves - see SPEC.md "Draft with AI".

import { execFile } from 'node:child_process';
import { scrubDrafts } from './scrub.js';
import { runDraft as aiRunDraft } from './ai.js';

// Overridable for tests so we can point at a binary that doesn't exist
// without touching the real PATH / ANTHROPIC key. Read lazily (per call, not at
// import time) so tests/agents that set these env vars after import still take
// effect - matches copy_assist.js / extract.js and avoids the import-order trap.
const getClaudeBin = () => process.env.POSTDECK_CLAUDE_BIN || 'claude';
const getModel = () => process.env.POSTDECK_DRAFT_MODEL || 'claude-haiku-4-5-20251001';
const getMaxBudgetUsd = () => process.env.POSTDECK_DRAFT_BUDGET || '0.05';

const PLATFORM_LIMITS = {
  twitter: { text: 280 },
  linkedin: { text: 3000 },
  facebook: { text: 63206 },
  instagram: { text: 2200 },
  tiktok: { caption: 2200, title: 90 },
  blog: { text: null }, // no limit
};

function buildPrompt({ idea_text, brand, toneProfile, platforms }) {
  const limitsLines = platforms
    .map((p) => {
      const l = PLATFORM_LIMITS[p];
      if (!l) return `- ${p}: no known limit`;
      if (p === 'tiktok') return `- tiktok: caption <= ${l.caption} chars, title <= ${l.title} chars`;
      return `- ${p}: ${l.text == null ? 'no character limit' : `<= ${l.text} chars`}`;
    })
    .join('\n');

  const hardRules = JSON.stringify(JSON.parse(toneProfile.hard_rules || '{}'));

  return [
    `You are drafting social copy for the brand "${brand.name}".`,
    `Tone profile: ${toneProfile.name}.`,
    `Voice rules: ${toneProfile.voice_rules || '(none provided)'}`,
    `Hard rules (must also follow exactly, mechanically re-enforced after your output): ${hardRules}`,
    `Idea: ${idea_text}`,
    ``,
    `Write one draft per platform below, respecting each platform's character limit:`,
    limitsLines,
    ``,
    `Respond with STRICT JSON ONLY, no markdown fences, no commentary - an object`,
    `mapping each platform name to its draft text, e.g.:`,
    `{"twitter": "...", "linkedin": "..."}`,
    `Platforms to draft for: ${platforms.join(', ')}`,
  ].join('\n');
}

/**
 * Extract a JSON object from a claude CLI --output-format json response.
 * The outer wrapper is CLI metadata; `result` holds the model's raw text,
 * which itself should be the strict JSON we asked for.
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
    throw new Error(`claude CLI result was not strict JSON drafts: ${err.message}`);
  }
  return inner;
}

// Retained for back-compat / existing direct tests of the legacy claude-only
// shell (no longer on the runtime path - draftWithAi now routes through
// src/ai.js's provider registry, see below).
function runClaudeCli(prompt) {
  return new Promise((resolve, reject) => {
    execFile(
      getClaudeBin(),
      ['-p', prompt, '--model', getModel(), '--max-budget-usd', String(getMaxBudgetUsd()), '--output-format', 'json'],
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
 * resolves to) into the strict-JSON drafts object we asked for in the
 * prompt. This is the "inner" half of the old parseClaudeCliOutput, split
 * out so it can run on ai.js's already-unwrapped text regardless of which
 * provider produced it.
 */
function parseInnerJson(resultText) {
  const cleaned = String(resultText).trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`AI CLI result was not strict JSON drafts: ${err.message}`);
  }
}

/**
 * @param {{idea_text: string, brand: object, toneProfile: object, platforms: string[], provider?: 'claude'|'codex'}} params
 * @returns {Promise<{drafts: object, scrub_applied: string[]}>}
 * @throws {Error & {statusCode?: number}} 503-flagged error if the CLI is unavailable/errors.
 */
async function draftWithAi({ idea_text, brand, toneProfile, platforms, provider }) {
  const prompt = buildPrompt({ idea_text, brand, toneProfile, platforms });
  const chosenProvider = provider || 'claude';

  let resultText;
  try {
    resultText = await aiRunDraft(chosenProvider, { prompt, model: getModel(), budget: getMaxBudgetUsd() });
  } catch (err) {
    const wrapped = new Error(err.message || `AI drafting unavailable via ${chosenProvider}`);
    wrapped.statusCode = err.statusCode || 503;
    throw wrapped;
  }

  let rawDrafts;
  try {
    rawDrafts = parseInnerJson(resultText);
  } catch (err) {
    const wrapped = new Error(`AI drafting unavailable: ${err.message}`);
    wrapped.statusCode = 503;
    throw wrapped;
  }

  const hardRules = JSON.parse(toneProfile.hard_rules || '{}');
  return scrubDrafts(rawDrafts, hardRules);
}

export { draftWithAi, buildPrompt, parseClaudeCliOutput, PLATFORM_LIMITS };
