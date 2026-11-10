import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createFixtureClient } from '../src/execution.js';
import { connectMemory } from './helpers/mcp.mjs';

const flag = { TVIJO_CUSTOMER_FIXTURE_V3: 'public-fixture/v1' };

test('fixture tools are default-off and do not widen the generic execution flag', async t => {
  const client = await connectMemory(t, { env: { TVIJO_EXECUTION_ROUTES: '1' } });
  const { tools } = await client.listTools();
  assert.ok(tools.some(tool => tool.name === 'tvijo_submit_task'));
  assert.ok(!tools.some(tool => tool.name.startsWith('tvijo_fixture_v3_')));
});

test('fixture endpoint substitution cannot send a token', () => {
  for (const base of ['https://other.example/api/dshrem/v1', 'http://localhost/api/dshrem/v1',
    'http://127.0.0.1/api/other', 'http://127.0.0.1/api/dshrem/v1?next=evil']) {
    assert.throws(() => createFixtureClient({ base }, { allowLocalTest: true }), e => e.code === 'execution_endpoint_refused');
  }
  assert.throws(() => createFixtureClient({ base: 'http://127.0.0.1/api/dshrem/v1' }), e => e.code === 'execution_endpoint_refused');
});

const repo = process.env.TVIJO_FIXTURE_AIOS_SOURCE;
test('actual stdio MCP tools/call to authenticated Workspace HTTP and existing Worker', { skip: !repo, timeout: 55_000 }, async t => {
  const fixture = spawn(process.env.TVIJO_FIXTURE_PYTHON || 'python3', ['-c',
    "import runpy; runpy.run_path('tests/test_customer_fixture_v3.py', run_name='__main__')", '--serve-http-fixture'],
    { cwd: repo, env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: '1', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = once(fixture, 'exit');
  let diagnostics = '';
  fixture.stderr.on('data', chunk => { diagnostics += chunk.toString(); });
  t.after(async () => { fixture.kill('SIGTERM'); await stopped; });
  const lines = createInterface({ input: fixture.stdout });
  const ready = await Promise.race([once(lines, 'line').then(([line]) => JSON.parse(line)),
    stopped.then(([code]) => { throw new Error('Local fixture HTTP did not start: ' + code + ' ' + diagnostics); })]);
  lines.close();

  async function connect(token) {
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [fileURLToPath(new URL('../bin/tvijo-dshrem-mcp.js', import.meta.url))],
      env: { ...flag, TVIJO_API_BASE: ready.base, TVIJO_FIXTURE_LOCAL_TEST: '1', TVIJO_TOKEN: token }, stderr: 'pipe' });
    const client = new Client({ name: 'tvijo-fixed-fixture-roundtrip', version: '1' });
    t.after(() => client.close());
    await client.connect(transport);
    return client;
  }
  const client = await connect(ready.token);
  const { tools } = await client.listTools();
  assert.equal(tools.filter(tool => tool.name.startsWith('tvijo_fixture_v3_')).length, 5);
  assert.ok(!tools.some(tool => tool.name === 'tvijo_submit_task'));
  const call = (operation, args, target = client) => target.callTool({ name: 'tvijo_fixture_v3_' + operation, arguments: args });
  const good = async (...args) => {
    const r = await call(...args);
    assert.ok(!r.isError, JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes(ready.token));
    assert.ok(!JSON.stringify(r).includes(ready.artifact_directory));
    return r.structuredContent;
  };
  const project_id = ready.project;
  const quote = await good('quote', { project_id, idempotency_key: 'mcp-actual' });
  const identity = { project_id, task_id: quote.quote_id };
  assert.equal(quote.execution_authorized, false);
  assert.equal((await good('inspect', identity)).status, 'quoted');
  const result = await good('submit', { quote });
  assert.equal(result.status, 'completed');
  assert.equal(result.model_request_sent, false);
  assert.equal(result.customer_model_workflow, 'NOT_RUN');
  assert.equal(result.launch_intent_count, 1);
  assert.equal(result.process_count, 1);
  assert.equal(result.local_outbox_ack, true);
  assert.equal(result.runtime_ack, 'UNKNOWN');
  assert.equal(result.verification.status, 'not_independently_verified');
  assert.deepEqual(await good('submit', { quote }), result);
  await client.close();
  const fresh = await connect(ready.token);
  assert.deepEqual(await good('reconnect', identity, fresh), result);
  const foreign = await connect(ready.foreign_token);
  assert.equal((await call('inspect', identity, foreign)).isError, true);
  assert.equal((await call('submit', { quote }, foreign)).isError, true);
  assert.equal((await call('inspect', { ...identity, project_id: ready.foreign_project }, foreign)).isError, true);
  assert.equal((await call('quote', { project_id, idempotency_key: 'spoof', endpoint: 'https://invalid.example' }, fresh)).isError, true);
  const cancelQuote = await good('quote', { project_id, idempotency_key: 'mcp-cancel' }, fresh);
  const cancelled = await good('cancel', { project_id, task_id: cancelQuote.quote_id }, fresh);
  assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.process_count, 0);
  assert.deepEqual(await good('submit', { quote: cancelQuote }, fresh), cancelled);
  const unknownQuote = await good('quote', { project_id, idempotency_key: 'mcp-unknown' }, fresh);
  const injected = await fetch(new URL('/_fixture_test/restart/' + unknownQuote.quote_id, ready.base), {
    method: 'POST', headers: { authorization: 'Bearer ' + ready.token }, redirect: 'error',
  });
  assert.equal(injected.status, 200);
  const unknown = await good('reconnect', { project_id, task_id: unknownQuote.quote_id }, fresh);
  assert.equal(unknown.status, 'unknown'); assert.equal(unknown.launch_intent_count, 1); assert.equal(unknown.process_count, 0);
  assert.deepEqual(await good('submit', { quote: unknownQuote }, fresh), unknown);
  if (process.env.TVIJO_FIXTURE_RECEIPT_PATH) await writeFile(process.env.TVIJO_FIXTURE_RECEIPT_PATH,
    JSON.stringify(result) + '\n', { flag: 'wx', mode: 0o600 });
  t.diagnostic(JSON.stringify({ source: 'MCP stdio → loopback Workspace HTTP → Agentroy Worker',
    receipt: result.projection_sha256, status: result.status, deterministic_fixture: result.deterministic_fixture,
    launch_intent_count: result.launch_intent_count, process_count: result.process_count, reconnect: 'same receipt',
    cancel: 'before process', injected_unknown: 'no rerun', model_request_sent: false, customer_model_workflow: 'NOT_RUN' }));
});
