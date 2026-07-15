// Single source of truth for per-platform limits/specs (config/platform-specs.json).
// See SPEC.md "Platform lineup" - refresh the JSON when platforms change their
// rules; this module just loads/serves it (server) and the composer/drafting
// agent consume it via GET /api/platform-specs instead of hardcoding limits.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SPECS_PATH = process.env.POSTDECK_PLATFORM_SPECS_PATH || path.join(ROOT, 'config', 'platform-specs.json');

let cached = null;

/**
 * Load (and cache) config/platform-specs.json. Pass { fresh: true } to force
 * a re-read from disk (tests that swap the file, or a future "reload specs"
 * button).
 */
function loadPlatformSpecs({ fresh = false } = {}) {
  if (cached && !fresh) return cached;
  const raw = fs.readFileSync(SPECS_PATH, 'utf8');
  cached = JSON.parse(raw);
  return cached;
}

function getPlatformSpec(platform) {
  const specs = loadPlatformSpecs();
  return specs[platform] || null;
}

function getTextLimit(platform) {
  const spec = getPlatformSpec(platform);
  return spec?.text?.max ?? null;
}

/** TikTok's required_fields array from the spec file - the mechanical list
 * used by validate.js instead of a hardcoded duplicate. */
function getTiktokRequiredFields() {
  const spec = getPlatformSpec('tiktok');
  return spec?.required_fields || [];
}

export { loadPlatformSpecs, getPlatformSpec, getTextLimit, getTiktokRequiredFields, SPECS_PATH };
