// Google access for Website Analytics (docs/WEB_ANALYTICS_SPEC.md). Service
// account only, no new dependencies: a JWT signed with node:crypto is traded
// for an access token, then GA4 Data/Admin and Search Console are plain REST.
// The private key stays inside this module: it is never logged, returned or
// put into an error message.
//
// Sections: key file -> token -> HTTP -> GA4 -> Search Console.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const SCOPE_GA4 = 'https://www.googleapis.com/auth/analytics.readonly';
export const SCOPE_GSC = 'https://www.googleapis.com/auth/webmasters.readonly';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GA4_DATA = 'https://analyticsdata.googleapis.com/v1beta';
const GA4_ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const GSC_BASE = 'https://www.googleapis.com/webmasters/v3';
const EARLY_MS = 60 * 1000;

let fetchImpl = (...args) => globalThis.fetch(...args);
const tokenCache = new Map(); // scope key -> { token, expiresAt }

// Tests swap the network out with this. Passing nothing restores real fetch.
export function setFetch(fn) {
  fetchImpl = fn || ((...args) => globalThis.fetch(...args));
  tokenCache.clear();
}

// ---------- key file ----------

function keyPath() {
  return (
    process.env.POSTDECK_GOOGLE_SA ||
    path.join(os.homedir(), 'Library/Application Support/PostDeck/google-service-account.json')
  );
}

// -> { key, present, error }. key is null unless it parses and is complete.
function readKey() {
  const p = keyPath();
  let text;
  try {
    text = fs.readFileSync(p, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { key: null, present: false, error: null };
    return { key: null, present: true, error: 'The Google key file could not be read.' };
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    return { key: null, present: true, error: 'The Google key file is not valid JSON.' };
  }
  if (!j || typeof j !== 'object' || !j.client_email || !j.private_key) {
    return { key: null, present: true, error: 'The Google key file is missing client_email or private_key.' };
  }
  return { key: { client_email: String(j.client_email), private_key: String(j.private_key) }, present: true, error: null };
}

// No network. connected = the key file parses and has what signing needs.
export function googleStatus() {
  const { key, present, error } = readKey();
  return {
    connected: !!key,
    key_present: present,
    client_email: key ? key.client_email : null,
    error: error || null,
  };
}

export function saveServiceAccountKey(jsonText) {
  let j;
  try {
    j = JSON.parse(String(jsonText || ''));
  } catch {
    throw new Error('That is not valid JSON. Paste the whole key file you downloaded from Google.');
  }
  if (!j || typeof j !== 'object' || j.type !== 'service_account') {
    throw new Error('That JSON is not a service account key (type must be service_account).');
  }
  if (!j.client_email || typeof j.client_email !== 'string') {
    throw new Error('The key is missing client_email.');
  }
  if (!j.private_key || typeof j.private_key !== 'string' || !j.private_key.includes('PRIVATE KEY')) {
    throw new Error('The key is missing private_key.');
  }
  try {
    crypto.createPrivateKey(j.private_key);
  } catch {
    throw new Error('The private_key in that file could not be read.');
  }
  const p = keyPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, p);
  tokenCache.clear();
  return { client_email: j.client_email };
}

export function deleteServiceAccountKey() {
  try {
    fs.unlinkSync(keyPath());
  } catch (e) {
    if (e.code !== 'ENOENT') throw new Error('The Google key file could not be removed.');
  }
  tokenCache.clear();
}

// ---------- token ----------

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function buildJwt(key, scopes, nowSec) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: key.client_email,
    scope: scopes.join(' '),
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.sign('RSA-SHA256', Buffer.from(input), key.private_key);
  return `${input}.${b64url(sig)}`;
}

export async function getAccessToken(scopes) {
  const list = (Array.isArray(scopes) ? scopes : [scopes]).filter(Boolean).map(String);
  if (!list.length) throw new Error('No Google scope was requested.');
  const cacheKey = [...list].sort().join(' ');
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt - EARLY_MS > Date.now()) return hit.token;

  const { key, present, error } = readKey();
  if (!key) {
    throw new Error(
      present ? error : 'Google is not connected. Add a service account key in Settings > Websites.',
    );
  }
  const jwt = buildJwt(key, list, Math.floor(Date.now() / 1000));
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  }).toString();
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    throw new Error('Could not reach Google to sign in. Check the internet connection.');
  }
  const j = await readJson(res);
  if (!res.ok || !j.access_token) {
    const why = j.error_description || j.error || `status ${res.status}`;
    throw new Error(`Google refused the service account sign-in: ${short(why)}`);
  }
  const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
  tokenCache.set(cacheKey, { token: j.access_token, expiresAt: Date.now() + ttl * 1000 });
  return j.access_token;
}

// ---------- HTTP ----------

function short(s, n = 160) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
}

async function readJson(res) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    return {};
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

// label names the thing being read, for the error sentence: "GA4 property 123".
async function gcall(method, url, scopes, label, body) {
  const token = await getAccessToken(scopes);
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new Error(`Could not reach Google while reading ${label}. Check the internet connection.`);
  }
  const j = await readJson(res);
  if (res.ok) return j;
  const msg = (j.error && (j.error.message || j.error.status)) || `status ${res.status}`;
  if (res.status === 401) {
    tokenCache.clear();
    throw new Error(`Google rejected the sign-in while reading ${label}. Try again, or re-upload the key.`);
  }
  if (res.status === 403 && /has not been used|is disabled|not enabled|SERVICE_DISABLED/i.test(msg)) {
    throw new Error(`The Google API needed for ${label} is not enabled on the service account's project.`);
  }
  if (res.status === 403) {
    const how = /^GA4/.test(label)
      ? 'add the service account as a Viewer'
      : 'add the service account as a user in Search Console';
    throw new Error(`Google refused access to ${label}: ${how}`);
  }
  if (res.status === 404) throw new Error(`Google could not find ${label}.`);
  if (res.status === 429) throw new Error(`Google is rate limiting requests for ${label}. Try again later.`);
  throw new Error(`Google could not read ${label} (${res.status}): ${short(msg)}`);
}

// ---------- GA4 ----------

export function ga4RunReport(propertyId, body) {
  const id = encodeURIComponent(String(propertyId));
  return gcall('POST', `${GA4_DATA}/properties/${id}:runReport`, [SCOPE_GA4], `GA4 property ${propertyId}`, body || {});
}

export function ga4Realtime(propertyId) {
  const id = encodeURIComponent(String(propertyId));
  return gcall(
    'POST',
    `${GA4_DATA}/properties/${id}:runRealtimeReport`,
    [SCOPE_GA4],
    `GA4 property ${propertyId}`,
    { metrics: [{ name: 'activeUsers' }] },
  );
}

// -> [{ property_id, display_name, measurement_ids: [] }]
export async function listGa4Properties() {
  const props = [];
  let pageToken = '';
  for (let i = 0; i < 20; i++) {
    const qs = `pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const j = await gcall('GET', `${GA4_ADMIN}/accountSummaries?${qs}`, [SCOPE_GA4], 'the GA4 account list');
    for (const acct of j.accountSummaries || []) {
      for (const p of acct.propertySummaries || []) {
        const m = /^properties\/(\d+)$/.exec(p.property || '');
        if (m) props.push({ property_id: m[1], display_name: p.displayName || '', measurement_ids: [] });
      }
    }
    pageToken = j.nextPageToken || '';
    if (!pageToken) break;
  }
  for (const p of props) {
    let tok = '';
    for (let i = 0; i < 10; i++) {
      const qs = `pageSize=200${tok ? `&pageToken=${encodeURIComponent(tok)}` : ''}`;
      let j;
      try {
        j = await gcall('GET', `${GA4_ADMIN}/properties/${p.property_id}/dataStreams?${qs}`, [SCOPE_GA4], `GA4 property ${p.property_id}`);
      } catch {
        break; // one unreadable property must not hide the others
      }
      for (const s of j.dataStreams || []) {
        const mid = s.webStreamData && s.webStreamData.measurementId;
        if (mid && !p.measurement_ids.includes(mid)) p.measurement_ids.push(mid);
      }
      tok = j.nextPageToken || '';
      if (!tok) break;
    }
  }
  return props;
}

// ---------- Search Console ----------

// -> [{ site_url, permission_level }]
export async function listGscSites() {
  const j = await gcall('GET', `${GSC_BASE}/sites`, [SCOPE_GSC], 'the Search Console site list');
  return (j.siteEntry || []).map((s) => ({ site_url: s.siteUrl, permission_level: s.permissionLevel || '' }));
}

export function gscQuery(siteUrl, body) {
  const u = `${GSC_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  return gcall('POST', u, [SCOPE_GSC], `Search Console site ${siteUrl}`, body || {});
}
