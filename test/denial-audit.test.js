import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuditClient } from '../src/audit-client.js';
import { DenialAudit } from '../src/denial-audit.js';
import { GatewayApi } from '../src/http/gateway-api.js';
import { silentLog, testConfig, testRoutes } from './helpers.js';

const KEY = 'a'.repeat(40);

/** An AuditClient over a fake audit service that keeps every event it is sent. */
function fakeAudit(/** @type {{ status?: number }} */ o = {}) {
  /** @type {any[]} */ const events = [];
  /** @type {string[]} */ const auths = [];
  const fetchImpl = /** @type {typeof fetch} */ (async (_url, init) => {
    auths.push(String(/** @type {any} */ (init?.headers).authorization));
    if (o.status) return new Response('x', { status: o.status });
    events.push(...JSON.parse(String(init?.body)).events);
    return new Response('{}', { status: 202 });
  });
  const client = new AuditClient({ target: { url: 'http://audit', apiKey: KEY }, fetchImpl, sleep: async () => {}, logger: silentLog });
  return { client, events, auths };
}

test('config: AUDIT_URL and AUDIT_API_KEY come together; sampling window defaults to 10 s', () => {
  assert.equal(testConfig().audit, null);
  assert.deepEqual(testConfig({ AUDIT_URL: 'http://audit:3005/', AUDIT_API_KEY: KEY }).audit, { url: 'http://audit:3005', apiKey: KEY, sampleSec: 10 });
  assert.equal(testConfig({ AUDIT_URL: 'http://audit', AUDIT_API_KEY: KEY, AUDIT_SAMPLE_SEC: '0' }).audit?.sampleSec, 0);
  assert.throws(() => testConfig({ AUDIT_URL: 'http://audit' }), /set together/);
});

test('AuditClient: batches go to /v1/events/batch with the key, a rejected batch is dropped, an outage keeps the events', async () => {
  const a = fakeAudit();
  a.client.record({ action: 'x.y', outcome: 'denied' });
  a.client.record({ action: 'x.z' });
  await a.client.flush();
  assert.deepEqual([a.events.map((e) => e.action), a.auths[0], a.client.stats.sent, a.client.buffer.length], [['x.y', 'x.z'], `Bearer ${KEY}`, 2, 0]);
  const rejected = fakeAudit({ status: 400 });
  rejected.client.record({ action: 'a.b' });
  await rejected.client.flush();
  assert.deepEqual([rejected.client.stats.dropped, rejected.client.buffer.length], [1, 0]);
  const down = fakeAudit({ status: 503 });
  down.client.record({ action: 'a.b' });
  await down.client.flush();
  assert.deepEqual([down.client.stats.failed, down.client.buffer.length], [1, 1]);
  const off = new AuditClient({ target: null });
  assert.equal(off.record({ action: 'a.b' }), false);
  assert.match(off.metricLines().join('\n'), /audit_forward_enabled 0/);
});

test('DenialAudit: one event per route, reason and client per window, the next one counts what was left out', () => {
  const a = fakeAudit();
  let t = 1_000;
  const d = new DenialAudit(a.client, { sampleSec: 10, now: () => t });
  const req = (/** @type {string} */ ip) => ({ ip, id: 'req-1', headers: { 'user-agent': 'curl/8' } });
  const route = { id: 'media-api' };
  d.denied('unauthorized', req('198.51.100.1'), route, 401);
  for (let i = 0; i < 5; i += 1) d.denied('unauthorized', req('198.51.100.1'), route, 401);
  d.denied('unauthorized', req('198.51.100.2'), route, 401);
  d.denied('rate_limited', req('198.51.100.1'), route, 429);
  assert.equal(a.client.buffer.length, 3, 'one per client and per reason');
  t += 11_000;
  d.denied('unauthorized', req('198.51.100.1'), route, 401);
  const last = a.client.buffer.at(-1);
  assert.deepEqual([last?.action, last?.outcome, last?.actor, last?.target, last?.meta], ['atc-gateway.request.denied', 'denied', { type: 'ip', id: '198.51.100.1' }, { type: 'route', id: 'media-api' }, { reason: 'unauthorized', status: 401, suppressed: 5 }]);
  const unsampled = new DenialAudit(a.client, { sampleSec: 0, now: () => t });
  const before = a.client.buffer.length;
  unsampled.denied('too_large', req('198.51.100.9'), null, 413);
  unsampled.denied('too_large', req('198.51.100.9'), null, 413);
  assert.equal(a.client.buffer.length, before + 2, 'sampling can be switched off');
  d.reload(false, { error: 'bad json' });
  assert.deepEqual([a.client.buffer.at(-1)?.action, a.client.buffer.at(-1)?.outcome], ['atc-gateway.routes.reload', 'failure']);
  const quiet = new DenialAudit(new AuditClient({ target: null }), { sampleSec: 10 });
  quiet.denied('blocked', req('198.51.100.1'), route, 429);
  assert.equal(quiet.seen.size, 0, 'nothing is tracked while forwarding is off');
});

test('gateway: refused requests (401, 413, local 429) reach the audit trail, served ones do not', async () => {
  const a = fakeAudit();
  const config = testConfig();
  const denials = new DenialAudit(a.client, { sampleSec: 0 });
  const app = await new GatewayApi({ config, routes: testRoutes(), jwt: null, logger: silentLog, denials, audit: a.client }).build();
  await app.ready();
  try {
    assert.equal((await app.inject({ url: '/api/media/x', remoteAddress: '203.0.113.5', headers: { 'user-agent': 'scan/1' } })).statusCode, 401);
    assert.equal((await app.inject({ method: 'POST', url: '/api/auth/x', remoteAddress: '203.0.113.5', payload: 'x'.repeat(2_000_000), headers: { 'content-type': 'text/plain' } })).statusCode, 413);
    assert.equal((await app.inject({ url: '/nowhere/', remoteAddress: '203.0.113.5', headers: { host: 'other.test' } })).statusCode, 404, 'a missing route is not a denial');
    await a.client.flush();
    assert.deepEqual(a.events.map((e) => [e.action, e.meta.reason, e.meta.status, e.target?.id, e.ip]), [
      ['atc-gateway.request.denied', 'unauthorized', 401, 'media-api', '203.0.113.5'],
      ['atc-gateway.request.denied', 'too_large', 413, 'auth-api', '203.0.113.5'],
    ]);
    assert.equal(a.events[0].userAgent, 'scan/1');
    const limited = fakeAudit();
    const tight = await new GatewayApi({ config: testConfig({ RATE_LIMIT_MAX: '1' }), routes: testRoutes(), jwt: null, logger: silentLog, denials: new DenialAudit(limited.client, { sampleSec: 0 }) }).build();
    await tight.ready();
    await tight.inject({ url: '/files/a' });
    assert.equal((await tight.inject({ url: '/files/a' })).statusCode, 429);
    await limited.client.flush();
    assert.deepEqual(limited.events.map((e) => e.meta.reason), ['rate_limited']);
    await tight.close();
  } finally {
    await app.close();
  }
});
