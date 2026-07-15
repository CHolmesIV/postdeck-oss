import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(ROOT, '..');

const ENV_PATHS = [
  path.join(ROOT, '.env'),
  path.join(PROJECT_ROOT, 'config', '.env'),
];

let loaded = false;

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, valueRaw] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(valueRaw.trim());
  }
  return true;
}

function loadEnv() {
  if (loaded) return;
  loaded = true;
  for (const envPath of ENV_PATHS) {
    if (loadEnvFile(envPath)) break;
  }
}

loadEnv();

export { loadEnv, ENV_PATHS };
