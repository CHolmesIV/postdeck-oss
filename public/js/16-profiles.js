// Retired in D3: replaced by 60-settings.js (Settings > Brands > Profiles). Helpers below are still used by other views.
function humanizeKey(key) {
  return String(key || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function humanizePlatformName(platform) {
  return humanizeKey(platform);
}
function renderProfiles() { location.replace('#/settings/brands'); }
