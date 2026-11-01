import { test } from 'node:test';
import assert from 'node:assert/strict';
import chat, { validate } from '../api/chat.js';
import status from '../api/status.js';
import businesses from '../api/businesses.js';

delete process.env.GEMINI_API_KEY;

function call(handler, { method = 'POST', body, ip = '10.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200, headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o, headers: this.headers }); return this; },
    };
    handler({ method, body, headers: { 'x-forwarded-for': ip } }, res);
  });
}

test('chat: demo turn returns the full contract', async () => {
  const r = await call(chat, { body: { business: 'glow', message: 'Where is my order GLW-20418?' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'demo');
  for (const k of ['intent', 'confidence', 'probs', 'trace', 'reply', 'outcome', 'state', 'latency_ms']) assert.ok(k in r.body, k);
  assert.equal(r.body.intent, 'order_status');
  assert.ok(r.body.trace.length >= 5);
});

test('chat: method, validation and size guards', async () => {
  assert.equal((await call(chat, { method: 'GET' })).status, 405);
  assert.equal((await call(chat, { body: { business: 'nope', message: 'hi' } })).status, 400);
  assert.equal((await call(chat, { body: { business: 'glow', message: '   ' } })).status, 400);
  assert.equal((await call(chat, { body: { business: 'glow', message: 'x'.repeat(601) } })).status, 413);
  assert.equal((await call(chat, { body: '{bad json' })).status, 400);
  assert.ok(validate({ business: 'glow', message: 'hi', reply_id: 'slot:d1-1100' }) === null);
  assert.ok(validate({ business: 'glow', message: 'hi', reply_id: '<script>' }));
});

test('chat: per-IP rate limit', async () => {
  let last;
  for (let i = 0; i < 45; i++) last = await call(chat, { body: { business: 'glow', message: 'hi' }, ip: '10.9.9.9' });
  assert.equal(last.status, 429);
  assert.ok(last.headers['retry-after']);
});

test('status and businesses: GET only, no secrets, no other customers', async () => {
  const s = await call(status, { method: 'GET' });
  assert.equal(s.body.mode, 'demo');
  assert.equal((await call(status, { method: 'POST' })).status, 405);
  const b = await call(businesses, { method: 'GET' });
  assert.equal(b.body.businesses.length, 3);
  const raw = JSON.stringify(b.body);
  assert.doesNotMatch(raw, /919123456789|Arjun/);
  assert.ok(b.body.businesses.every((x) => x.kb.length >= 5 && x.scenarios.length >= 6));
});
