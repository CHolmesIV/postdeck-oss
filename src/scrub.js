// Mechanical hard-rules scrub - runs on every AI draft (and can be called
// standalone) to enforce hard_rules from a tone_profile in plain JS, no LLM
// round-trip. Deterministic, unit-testable.
//
// hard_rules shape (JSON on tone_profiles.hard_rules):
//   { "no_em_dash": true, "banned_words": ["foo", "bar"] }

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace em/en dashes with a plain-ASCII equivalent.
 * "word - word" (spaced) -> "word, word"
 * "word-word" (unspaced)  -> "word - word"
 */
function scrubEmDashes(text) {
  let changed = false;
  let out = text;

  // Spaced dash: " - " or " – " -> ", "
  if (/\s+[-–]\s+/.test(out)) {
    out = out.replace(/\s+[-–]\s+/g, ', ');
    changed = true;
  }
  // Any remaining unspaced dash: "word-word" -> "word - word"
  if (/[-–]/.test(out)) {
    out = out.replace(/[-–]/g, ' - ');
    changed = true;
  }
  return { text: out, changed };
}

/**
 * Remove banned words (whole-word, case-insensitive) and collapse the
 * whitespace/punctuation left behind.
 */
function scrubBannedWords(text, bannedWords) {
  let out = text;
  const hit = [];
  for (const word of bannedWords || []) {
    if (!word) continue;
    const re = new RegExp(`\\b${escapeRegExp(word)}\\b`, 'gi');
    if (re.test(out)) {
      hit.push(word);
      out = out.replace(re, '');
    }
  }
  if (hit.length) {
    out = out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([,.!?;:])/g, '$1')
      .replace(/\n[ \t]+/g, '\n')
      .trim();
  }
  return { text: out, hit };
}

/**
 * Apply hard_rules to a single string. Returns { text, applied: string[] }.
 */
function scrubText(text, hardRules = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text, applied: [] };
  }
  let out = text;
  const applied = [];

  if (hardRules.no_em_dash) {
    const r = scrubEmDashes(out);
    out = r.text;
    if (r.changed) applied.push('no_em_dash');
  }

  if (Array.isArray(hardRules.banned_words) && hardRules.banned_words.length) {
    const r = scrubBannedWords(out, hardRules.banned_words);
    out = r.text;
    for (const w of r.hit) applied.push(`banned_word:${w}`);
  }

  return { text: out, applied };
}

/**
 * Apply hard_rules across a { platform: text } drafts object.
 * Returns { drafts, scrub_applied } where scrub_applied is a flat, deduped
 * list of rule ids that fired across any platform.
 */
function scrubDrafts(drafts, hardRules = {}) {
  const outDrafts = {};
  const appliedSet = new Set();
  for (const [platform, text] of Object.entries(drafts || {})) {
    const { text: scrubbed, applied } = scrubText(text, hardRules);
    outDrafts[platform] = scrubbed;
    for (const a of applied) appliedSet.add(a);
  }
  return { drafts: outDrafts, scrub_applied: [...appliedSet] };
}

export { scrubText, scrubDrafts, scrubEmDashes, scrubBannedWords };
