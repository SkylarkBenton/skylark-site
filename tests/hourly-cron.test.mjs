import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

process.env.SUPABASE_URL = 'https://rywomhsgcaighcwnftoa.supabase.co';
process.env.SUPABASE_ANON_KEY = 'test-anon-jwt';
process.env.CRON_SECRET = 'test-cron-secret';

const { GET } = await import('../api/cron/hourly.js');

const src = readFileSync(resolve(import.meta.dirname, '../api/cron/hourly.js'), 'utf8');

function cronRequest() {
  return new Request('https://www.skylarkbenton.com/api/cron/hourly', {
    headers: { 'x-cron-secret': 'test-cron-secret' },
  });
}

test('hourly cron source targets the live sync-airbnb-ts function', () => {
  assert.match(src, /invoke\('sync-airbnb-ts'\)/);
  assert.match(src, /Authorization: `Bearer \$\{ANON\}`/);
  assert.match(src, /apikey: ANON/);
  assert.doesNotMatch(src, /sync-airbnb-ical/);
  assert.doesNotMatch(src, /expire-pending-holds/);
  assert.doesNotMatch(src, /Bearer \$\{CRON/);
  assert.match(src, /sync\.status < 400/);
});

test('invokes sync-airbnb-ts with the anon JWT, not CRON_SECRET', async () => {
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ created: 3, updated: 3, cancelled: 3, total_in_feed: 6 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    const res = await GET(cronRequest());
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.sync.name, 'sync-airbnb-ts');
    assert.equal(body.sync.status, 200);
    assert.equal(body.expire, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://rywomhsgcaighcwnftoa.supabase.co/functions/v1/sync-airbnb-ts');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-anon-jwt');
    assert.equal(calls[0].init.headers.apikey, 'test-anon-jwt');
    assert.notEqual(calls[0].init.headers.Authorization, 'Bearer test-cron-secret');
  } finally {
    mock.restoreAll();
  }
});

test('treats sync HTTP 404 as a cron failure', async () => {
  mock.method(globalThis, 'fetch', async () => new Response('Function not found', { status: 404 }));
  try {
    const res = await GET(cronRequest());
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.sync.status, 404);
  } finally {
    mock.restoreAll();
  }
});
