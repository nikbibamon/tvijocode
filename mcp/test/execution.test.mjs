import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { createExecutionClient, evidenceProjection } from '../src/execution.js';
import { createMcpServer } from '../src/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const base = 'https://dsh.tvijo.com/api/dshrem/v1';
const args = { project_id: 'project-a', thread_id: 'thread-a', idempotency_key: 'request-a', prompt: 'A bounded example.', max_micro_tvijo: 1000 };
function fixture(overrides = {}) {
  const calls = [];
  let posts = 0;
  const snapshot = { id: 'task-a', project_id: 'project-a', status: 'issued', receipt: { held_micro_tvijo: 1000, debited_micro_tvijo: 0 } };
  const api = createClient({ base, fetchImpl: async (url, options) => {
    const path = new URL(url).pathname.replace('/api/dshrem/v1', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body });
    if (options.method === 'POST' && path === '/tasks') {
      posts++;
      if (overrides.ambiguous) throw new Error('connection lost after commit');
      if (overrides.scopeDenied) return Response.json({ error: { code: 'project_key_scope_refused' } }, { status: 403 });
      return Response.json({ id: 'task-a' });
    }
    if (path === '/services/quote') return Response.json({ quote_id: 'quote-a', project_id: 'project-a', thread_id: 'thread-a', service_id: 'standard', tariff_version: 'pilot-' + 'a'.repeat(20), ceiling_micro_tvijo: 1000, expires_at: 200, ...overrides.quote });
    if (path === '/tasks/by-idempotency/request-a') {
      if (overrides.scopeDenied || overrides.lookupFails) return Response.json({}, { status: 404 });
      return Response.json({ id: 'task-a' });
    }
    if (path === '/tasks/task-a/cancel') { snapshot.status = 'cancelled'; return Response.json({ cancelled: true }); }
    if (path === '/tasks/task-a') return Response.json({ ...snapshot, ...overrides.task });
    if (path === '/services') return Response.json({ services: ['standard'] });
    throw new Error('unexpected path');
  } });
  return { api, client: createExecutionClient(api, { now: () => 100000 }), calls, posts: () => posts };
}

test('a quote binds project, thread, tariff and ceiling without a task or model request', async () => {
  const f = fixture(); const quote = await f.client.quote('synthetic-token', args);
  assert.equal(quote.execution_authorized, false);
  assert.equal(quote.uncertainty, 'ceiling_is_not_actual_provider_or_invoice_cost');
  assert.equal(quote.projection_sha256.length, 64);
  assert.equal(f.posts(), 0);
  assert.deepEqual(f.calls.map(c => c.path), ['/services/quote']);
});

test('explicit submission reserves once and fetches attributable project evidence', async () => {
  const f = fixture(); const quote = await f.client.quote('token', args);
  const receipt = await f.client.submit('token', quote);
  assert.equal(f.posts(), 1); assert.equal(receipt.project_id, 'project-a');
  assert.equal(receipt.model_request_sent, false); assert.equal(receipt.cost.provider_usd, null);
  assert.equal(receipt.runtime_ack, 'UNKNOWN'); assert.equal(receipt.verification.status, 'not_independently_verified');
});

test('ambiguous submit recovers the same identity without a POST retry or chat', async () => {
  const f = fixture({ ambiguous: true }); const q = await f.client.quote('token', args);
  const r = await f.client.submit('token', q);
  assert.equal(r.recovered, true); assert.equal(f.posts(), 1);
  assert.deepEqual(f.calls.slice(1).map(c => c.path), ['/tasks', '/tasks/by-idempotency/request-a', '/tasks/task-a']);
});

test('unresolved submission retains UNKNOWN and does not invent a free result', async () => {
  const f = fixture({ ambiguous: true, lookupFails: true }); const q = await f.client.quote('token', args);
  await assert.rejects(f.client.submit('token', q), e => e.code === 'submission_unknown');
  assert.equal(f.posts(), 1);
});

test('insufficient existing scope cannot be upgraded by the quote', async () => {
  const f = fixture({ scopeDenied: true }); const q = await f.client.quote('token', args);
  await assert.rejects(f.client.submit('token', q), e => e.code === 'submission_unknown');
  assert.equal(f.posts(), 1);
});

for (const quote of [{ expires_at: 99 }, { project_id: 'project-other' }, { thread_id: 'thread-other' }, { ceiling_micro_tvijo: 1001 }, { billing_mode: 'byok' }]) {
  test('refuse unavailable or substituted quote ' + JSON.stringify(quote), async () => {
    const f = fixture({ quote }); await assert.rejects(f.client.quote('token', args)); assert.equal(f.posts(), 0);
  });
}

test('changed saved projection is refused before reservation', async () => {
  const f = fixture(); const q = await f.client.quote('token', args); q.ceiling_micro_tvijo = 1001;
  await assert.rejects(f.client.submit('token', q), e => e.code === 'quote_changed'); assert.equal(f.posts(), 0);
});

test('cross-project receipt cannot be read, reconnected or cancelled', async () => {
  const f = fixture({ task: { project_id: 'project-other' } });
  await assert.rejects(f.client.inspect('token', 'task-a', 'project-a'));
  await assert.rejects(f.client.cancel('token', 'task-a', 'project-a'));
  assert.equal(f.calls.filter(c => c.method === 'POST').length, 0);
});

test('reconnect is a GET and cancellation preserves unresolved provider outcome', async () => {
  const f = fixture({ task: { reason: 'usage_unknown', spent_usd: '0' } });
  const r = await f.client.reconnect('token', 'task-a', 'project-a');
  assert.equal(r.execution_repeated, false); assert.equal(r.cost.provider_usd, null);
  const cancelled = await f.client.cancel('token', 'task-a', 'project-a');
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.cost.provider_cost_status, 'unknown');
});

test('projection contains no arbitrary model text, secrets, paths or provider request body', () => {
  const r = evidenceProjection({ id: 'task-a', project_id: 'project-a', status: 'completed', prompt: 'api_key=synthetic-secret', answer: 'a path /private/data', receipt: { token: 'synthetic-token', held_micro_tvijo: 0 } }, 'project-a');
  const encoded = JSON.stringify(r); assert.ok(!encoded.includes('synthetic-')); assert.ok(!encoded.includes('/private/'));
  assert.equal(r.verification.status, 'not_independently_verified');
});

test('arbitrary endpoint substitution and tool-like identifiers fail before HTTP', async () => {
  assert.throws(() => createExecutionClient({ base: 'https://other.example/api' }), e => e.code === 'execution_endpoint_refused');
  const f = fixture(); await assert.rejects(f.client.inspect('token', '../account', 'project-a'));
  assert.equal(f.calls.length, 0);
  await assert.rejects(f.client.inspect('token', 'task-a\n', 'project-a'));
  assert.equal(f.calls.length, 0);
});

for (const key of ['idempotency_key', 'expires_at_ms', 'resource']) test('saved quote accidental binding change is refused: ' + key, async () => {
  const f = fixture(); const q = await f.client.quote('token', args);
  q[key] = key === 'expires_at_ms' ? 300000 : 'changed';
  await assert.rejects(f.client.submit('token', q)); assert.equal(f.posts(), 0);
});

async function connect(t, f, env) {
  const server = createMcpServer({ client: f.api, env: { TVIJO_TOKEN: 'synthetic-token', ...env }, now: () => 100000 });
  const client = new Client({ name: 'scoped-execution-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

test('actual MCP SDK exposes the canary only by opt-in and preserves tool annotations', async t => {
  const f = fixture(); const client = await connect(t, f, { TVIJO_EXECUTION_ROUTES: '1', TVIJO_MAX_MICRO_TVIJO: '1000' });
  const { tools } = await client.listTools();
  assert.equal(tools.find(x => x.name === 'tvijo_execution_evidence').annotations.readOnlyHint, true);
  assert.equal(tools.find(x => x.name === 'tvijo_submit_task').annotations.readOnlyHint, false);
  const quote = await client.callTool({ name: 'tvijo_quote_task', arguments: args });
  assert.equal(quote.isError, undefined);
  const result = await client.callTool({ name: 'tvijo_submit_task', arguments: { quote: quote.structuredContent } });
  assert.equal(result.structuredContent.project_id, args.project_id); assert.equal(f.posts(), 1);
  const reconnect = await client.callTool({ name: 'tvijo_reconnect_task', arguments: { task_id: 'task-a', project_id: 'project-a' } });
  assert.equal(reconnect.structuredContent.execution_repeated, false); assert.equal(f.posts(), 1);
  assert.ok(!JSON.stringify(result).includes('synthetic-token'));
});

test('missing or lower service-unit cap stops the MCP tool before any request', async t => {
  for (const cap of [undefined, '999']) {
    const f = fixture(); const client = await connect(t, f, { TVIJO_EXECUTION_ROUTES: '1', ...(cap ? { TVIJO_MAX_MICRO_TVIJO: cap } : {}) });
    const r = await client.callTool({ name: 'tvijo_quote_task', arguments: args });
    assert.equal(r.isError, true); assert.equal(f.calls.length, 0);
  }
});

for (const status of ['reported', 'estimated']) test('actual gateway BYOK field preserves Decimal cost and provenance: ' + status, () => {
  const r = evidenceProjection({ id:'task-a', project_id:'project-a', status:'completed',
    byok:{ provider_cost_usd:'0.123456789', provider_cost_status:status, provider_cost_source:status==='reported' ? 'provider:cost' : 'provider:estimated_cost' } }, 'project-a');
  assert.equal(r.cost.provider_usd,'0.123456789'); assert.equal(r.cost.provider_cost_status,status);
  assert.equal(r.cost.invoice_usd,null);
});
test('Decimal provider precision is preserved without rounding to service units', () => {
  const r=evidenceProjection({id:'task-a',project_id:'project-a',status:'completed',byok:{provider_cost_usd:'0.0000000001234',provider_cost_status:'reported'}},'project-a');
  assert.equal(r.cost.provider_usd,'0.0000000001234');
});

for (const status of ['unknown','unrecognized-state','running','frozen',undefined]) test('unknown or unsettled outcome cannot turn supplied zero into a known total: ' + status, () => {
  const r=evidenceProjection({id:'task-a',project_id:'project-a',status,byok:{provider_cost_usd:'0',provider_cost_status:'reported'}},'project-a');
  assert.equal(r.cost.provider_usd,null); assert.equal(r.cost.provider_cost_status,'unknown');
});

test('unsupported cost provenance remains unknown; supported final zero is distinct', () => {
  for (const status of ['unknown','not_dispatched','invented',undefined]) {
    const r=evidenceProjection({id:'task-a',project_id:'project-a',status:'completed',byok:{provider_cost_usd:'0',provider_cost_status:status}},'project-a');
    assert.equal(r.cost.provider_usd,null);
  }
  const zero=evidenceProjection({id:'task-a',project_id:'project-a',status:'completed',byok:{provider_cost_usd:'0',provider_cost_status:'reported',provider_cost_source:'provider_rejected'}},'project-a');
  assert.equal(zero.cost.provider_usd,'0'); assert.equal(zero.cost.provider_cost_source,'provider_rejected');
});

for (const tariff_version of ['sk-synthetic-private-key-value','pilot-'+ 'a'.repeat(21),'pilot-not-a-hash','v1','pilot-'+ 'a'.repeat(20)+'\n']) test('service-supplied tariff text must match actual server format: ' + JSON.stringify(tariff_version), async () => {
  const f=fixture({quote:{tariff_version}});await assert.rejects(f.client.quote('token',args));assert.equal(f.posts(),0);
});
