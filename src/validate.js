// Mechanical validation for per-platform required fields (B6 polish).
// Currently covers TikTok, whose Blotato payload requires a fixed set of
// "cosmetic" flags CB flagged as a gap in B3. Called from the PATCH
// /api/posts/:id Approve gate in src/server.js - never silently drops data,
// just refuses the status transition with a clear 422 message.

import { getTiktokRequiredFields } from './platforms.js';

// Required field NAMES now come from config/platform-specs.json (single
// source of truth - see SPEC.md "Platform lineup"). This constant is kept
// as a fallback only if the config file is ever missing/malformed.
const FALLBACK_TIKTOK_REQUIRED_FIELDS = [
  'privacyLevel',
  'disabledComments',
  'disabledDuet',
  'disabledStitch',
  'isBrandedContent',
  'isYourBrand',
  'isAiGenerated',
];

function tiktokRequiredFields() {
  const fromConfig = getTiktokRequiredFields();
  return fromConfig.length ? fromConfig : FALLBACK_TIKTOK_REQUIRED_FIELDS;
}

// These must specifically be booleans (not just "truthy") - Blotato's API
// rejects strings like "true"/"false" for these flags.
const TIKTOK_BOOLEAN_FIELDS = [
  'disabledComments',
  'disabledDuet',
  'disabledStitch',
  'isBrandedContent',
  'isYourBrand',
  'isAiGenerated',
];

const TIKTOK_PRIVACY_LEVELS = [
  'PUBLIC_TO_EVERYONE',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'SELF_ONLY',
];

/**
 * Validate a post's platform_fields against TikTok's required flag set.
 * @param {object} platformFields - already-parsed JS object (not a JSON string)
 * @returns {{ok: boolean, missing: string[]}}
 */
function validateTiktokFields(platformFields = {}) {
  const fields = platformFields || {};
  const missing = [];
  for (const key of tiktokRequiredFields()) {
    const val = fields[key];
    if (val === undefined || val === null || val === '') {
      missing.push(key);
      continue;
    }
    if (TIKTOK_BOOLEAN_FIELDS.includes(key) && typeof val !== 'boolean') {
      missing.push(key);
      continue;
    }
    if (key === 'privacyLevel' && !TIKTOK_PRIVACY_LEVELS.includes(val)) {
      missing.push(key);
    }
  }
  return { ok: missing.length === 0, missing };
}

export {
  validateTiktokFields,
  tiktokRequiredFields,
  tiktokRequiredFields as TIKTOK_REQUIRED_FIELDS_FN, // callable alias, since the list is now dynamic
  FALLBACK_TIKTOK_REQUIRED_FIELDS,
  TIKTOK_BOOLEAN_FIELDS,
  TIKTOK_PRIVACY_LEVELS,
};
