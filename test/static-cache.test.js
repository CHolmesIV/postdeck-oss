// The SPA's scripts must revalidate on every load so a restarted PostDeck never runs
// stale JS against a newer API (2026-10-07, D5).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.POSTDECK_DB_PATH = ':memory:';
process.env.BLOTATO_DRY_RUN = '1';
process.env.POSTDECK_WORKER = '0';
process.env.POSTDECK_SYNC_ENABLED = '0';
process.env.POSTDECK_WEB_SYNC = '0';

const { buildServer } = await import('../src/server.js');

test('app shell, scripts and styles are served with Cache-Control: no-cache', async () => {
  const app = buildServer();
  for (const url of ['/', '/js/99-main.js', '/css/foundation.css']) {
    const res = await app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, url);
    assert.equal(res.headers['cache-control'], 'no-cache', url);
  }
  await app.close();
});
