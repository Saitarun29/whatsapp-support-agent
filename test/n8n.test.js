import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../n8n/whatsapp-support-agent.n8n.json', import.meta.url), 'utf8');
const wf = JSON.parse(raw);
const names = new Set(wf.nodes.map((n) => n.name));

test('n8n: valid workflow with a sticky note and no embedded credentials', () => {
  assert.ok(Array.isArray(wf.nodes) && wf.nodes.length > 15);
  assert.ok(wf.nodes.some((n) => n.type === 'n8n-nodes-base.stickyNote'));
  assert.ok(wf.nodes.every((n) => !('credentials' in n)));
  assert.doesNotMatch(raw, /EAA[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|hooks\.slack\.com\/services\/T/);
  assert.equal(new Set(wf.nodes.map((n) => n.id)).size, wf.nodes.length);
});

test('n8n: webhook verify GET and message POST on the same path', () => {
  const hooks = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  assert.deepEqual(hooks.map((h) => h.parameters.httpMethod).sort(), ['GET', 'POST']);
  assert.ok(hooks.every((h) => h.parameters.path === 'whatsapp'));
  assert.match(raw, /hub\.verify_token/);
  assert.match(raw, /graph\.facebook\.com\/v21\.0/);
});

test('n8n: every connection points at a real node and the reply node is reachable', () => {
  for (const [from, c] of Object.entries(wf.connections)) {
    assert.ok(names.has(from), from);
    for (const out of c.main) for (const e of out) assert.ok(names.has(e.node), `${from} -> ${e.node}`);
  }
  const incoming = Object.values(wf.connections).flatMap((c) => c.main.flat()).filter((e) => e.node === 'Send WhatsApp Reply');
  assert.ok(incoming.length >= 5);
  const sw = wf.nodes.find((n) => n.type === 'n8n-nodes-base.switch');
  assert.deepEqual(sw.parameters.rules.values.map((r) => r.outputKey), ['faq', 'order', 'appointment', 'handoff']);
});
