// UTM auto-append (B18c — docs/B16_B18_COMPETITIVE_WAVE_SPEC.md). On approve
// (never on draft — keep drafts clean), rewrites bare http(s) links in a
// post's copy, appending
//   utm_source={platform}&utm_medium=social&utm_campaign={campaign|brand-slug}
// Skips links that already carry a utm_ param. Idempotent — safe to run
// against copy that's already been through this once.
//
// Per-brand `utm_enabled` toggle + optional `utm_template` override are
// stored on the generic `settings` key/value table (mirrors src/voice.js's
// getRawSetting/setRawSetting pattern — brands don't have a dedicated
// settings table/column, and voice.js already established this as the
// convention for brand/global toggles that don't need a fixed DEFAULTS
// whitelist like settings.js's quiet-hours shape).

import { getRawSetting, setRawSetting } from './voice.js';

const DEFAULT_TEMPLATE = 'utm_source={platform}&utm_medium=social&utm_campaign={campaign}';

function utmSettingKey(brandId) {
  return `utm:${brandId}`;
}

/** { enabled: boolean, template: string|null } for a brand. Defaults to
 * disabled / no override. */
function getBrandUtmSettings(db, brandId) {
  const raw = getRawSetting(db, utmSettingKey(brandId));
  if (raw === undefined || raw === null) return { enabled: false, template: null };
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: Boolean(parsed?.enabled),
      template: typeof parsed?.template === 'string' && parsed.template.trim() ? parsed.template : null,
    };
  } catch {
    return { enabled: false, template: null };
  }
}

function setBrandUtmSettings(db, brandId, patch = {}) {
  const existing = getBrandUtmSettings(db, brandId);
  const merged = {
    enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
    template:
      patch.template !== undefined ? (patch.template && String(patch.template).trim()) || null : existing.template,
  };
  setRawSetting(db, utmSettingKey(brandId), JSON.stringify(merged));
  return merged;
}

// Matches bare http(s) URLs. Stops at whitespace or a small set of trailing
// punctuation/closing brackets that are almost always sentence
// punctuation rather than part of the URL (mirrors common link-detection
// heuristics — good enough for social copy, not a full URL grammar).
const URL_RE = /https?:\/\/[^\s<>]+/g;
// Deliberately excludes '?' — a trailing '?' on a URL is an (empty) query
// string separator, not sentence punctuation, so it must stay part of the URL.
const TRAILING_PUNCT_RE = /[.,!;:)\]}'"]+$/;

function splitTrailingPunctuation(url) {
  const match = url.match(TRAILING_PUNCT_RE);
  if (!match) return { url, trailing: '' };
  return { url: url.slice(0, url.length - match[0].length), trailing: match[0] };
}

function renderTemplate(template, { platform, campaign, brand }) {
  const campaignValue = campaign || brand || 'general';
  return template
    .replace(/\{platform\}/g, encodeURIComponent(platform || ''))
    .replace(/\{campaign\|brand-slug\}/g, encodeURIComponent(campaignValue))
    .replace(/\{campaign\|brand\}/g, encodeURIComponent(campaignValue))
    .replace(/\{campaign\}/g, encodeURIComponent(campaignValue))
    .replace(/\{brand\}/g, encodeURIComponent(brand || ''));
}

function appendParamsToUrl(url, paramString) {
  if (!paramString) return url;
  const hasQuery = url.includes('?');
  // Trailing '?' with nothing after it, or a trailing '&', still counts as
  // "has a query string" for join-character purposes.
  if (hasQuery) {
    const needsAmp = !url.endsWith('?') && !url.endsWith('&');
    return `${url}${needsAmp ? '&' : ''}${paramString}`;
  }
  return `${url}?${paramString}`;
}

/**
 * Rewrite bare http(s) links in `text`, appending the UTM template. Skips any
 * link that already contains `utm_` anywhere in its query string (idempotent
 * — a second pass over already-tagged copy is a no-op). Handles multiple
 * links, existing query strings (both `?` and `&` join points), and trailing
 * sentence punctuation (the punctuation is preserved after the rewritten
 * URL, not swallowed into it).
 *
 * @param {string} text
 * @param {{platform?: string, campaign?: string, brand?: string, template?: string}} opts
 * @returns {string}
 */
function appendUtm(text, { platform, campaign, brand, template } = {}) {
  if (!text) return text;
  const tmpl = template || DEFAULT_TEMPLATE;
  return text.replace(URL_RE, (match) => {
    const { url, trailing } = splitTrailingPunctuation(match);
    if (/[?&]utm_/i.test(url)) {
      return match; // already tagged — leave untouched
    }
    const paramString = renderTemplate(tmpl, { platform, campaign, brand });
    return appendParamsToUrl(url, paramString) + trailing;
  });
}

export {
  appendUtm,
  getBrandUtmSettings,
  setBrandUtmSettings,
  DEFAULT_TEMPLATE,
};
