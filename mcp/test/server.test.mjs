import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClient } from '../src/client.js';
import { createMcpServer, spendingCap } from '../src/server.js';
import { createTokenStore } from '../src/token-store.js';
import { completed, deviceResponse, fakeApi, packageDir, temporaryDirectory } from './helpers/fake-api.mjs';

const execFileAsync = promisify(execFile);
const bin = join(packageDir, 'bin/tvijo-dshrem-mcp.js');
const fakeToken = 'fake-secret-token-must-never-be-printed';

async function connectMemory(t, options) {
  const server = createMcpServer(options);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function connectStdio(t, env) {
  const transport = new StdioClientTransport({ command: process.execPath, args: [bin], cwd: packageDir, stderr: 'pipe', env: { PATH: process.env.PATH, HOME: await temporaryDirectory(), ...env } });
  const output = { stdout: '', stderr: '' };
  transport.stderr.on('data', (chunk) => { output.stderr += chunk; });
  // The SDK owns the child; capture the raw stdout bytes before initialization.
  const start = transport.start.bind(transport);
  transport.start = async () => {
    await start();
    transport._process.stdout.on('data', (chunk) => { output.stdout += chunk; });
  };
  const client = new Client({ name: 'stdio-test-client', version: '1.0.0' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  return { client, output };
}

function textOf(result) { return result.content.map((content) => content.text ?? '').join('\n'); }

test('spawned stdio server lists exactly eleven tools and never emits the token', async (t) => {
  const account = { label: 'Test account', balance: '12.50', limits: { daily: '5' }, access_token: fakeToken, echoed: `Bearer ${fakeToken}` };
  const api = await fakeApi(t, (req) => {
    assert.equal(req.authorization, `Bearer ${fakeToken}`);
    if (req.path.endsWith('/account')) return { body: account };
    return { status: 500, body: { error: { message: fakeToken } } };
  });
  const { client, output } = await connectStdio(t, { TVIJO_TOKEN: fakeToken, TVIJO_API_BASE: api.base });
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['tvijo_account', 'tvijo_ask', 'tvijo_cancel_task', 'tvijo_catalog_get', 'tvijo_catalog_search', 'tvijo_login_poll', 'tvijo_login_start', 'tvijo_review', 'tvijo_task_status', 'tvijo_wiki_context', 'tvijo_wiki_search']);
  assert.equal(tools.find((tool) => tool.name === 'tvijo_account').annotations.readOnlyHint, true);
  assert.equal(tools.find((tool) => tool.name === 'tvijo_task_status').annotations.readOnlyHint, true);
  const ask = tools.find((tool) => tool.name === 'tvijo_ask');
  assert.deepEqual(ask.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  assert.match(ask.description, /spends real money up to max_usd/);
  assert.ok(ask.inputSchema.required.includes('max_usd'));
  const result = await client.callTool({ name: 'tvijo_account', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.label, 'Test account');
  assert.equal(result.structuredContent.balance, '12.50');
  assert.equal(result.structuredContent.access_token, '[REDACTED]');
  assert.equal(result.structuredContent.echoed, 'Bearer [REDACTED]');
  assert.deepEqual(JSON.parse(textOf(result)), result.structuredContent);
  const failure = await client.callTool({ name: 'tvijo_task_status', arguments: { task_id: 'one' } });
  assert.equal(failure.isError, true);
  await client.close();
  assert.match(output.stdout, /jsonrpc/);
  assert.ok(!output.stdout.includes(fakeToken));
  assert.ok(!output.stderr.includes(fakeToken));
  assert.equal(output.stderr, '');
  assert.equal(api.requests.length, 2);
});

test('tvijo_ask through stdio sends exactly one task POST and one chat', async (t) => {
  const api = await fakeApi(t, (req) => ({ body: req.path.endsWith('/chat') ? { ...completed, task: completed } : { id: 'task-1' } }));
  const { client } = await connectStdio(t, { TVIJO_TOKEN: fakeToken, TVIJO_API_BASE: api.base });
  const result = await client.callTool({ name: 'tvijo_ask', arguments: { prompt: 'Explain the code', max_usd: 0.4 } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.task_id, 'task-1');
  assert.equal(result.structuredContent.answer, 'A useful answer.');
  assert.equal(result.structuredContent.spent_usd, '0.012');
  assert.equal(result.structuredContent.state.status, 'completed');
  assert.equal(api.requests.length, 2);
  assert.equal(api.requests[0].method, 'POST');
  assert.equal(api.requests[0].path, '/api/dshrem/v1/tasks');
  assert.equal(api.requests[0].body.max_usd, '0.4');
  assert.equal(api.requests[1].method, 'POST');
  assert.equal(api.requests[1].path, '/api/dshrem/v1/tasks/task-1/chat');
});

test('spawned stdio server lists exactly fourteen tools with both local-report settings', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No HTTP expected'); });
  const { client } = await connectStdio(t, { TVIJO_API_BASE: api.base, TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: await temporaryDirectory() });
  const { tools } = await client.listTools();
  assert.equal(tools.length, 14);
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ['tvijo_account', 'tvijo_ask', 'tvijo_cancel_task', 'tvijo_catalog_get', 'tvijo_catalog_search', 'tvijo_local_execution_budget', 'tvijo_local_repositories', 'tvijo_local_test_results', 'tvijo_login_poll', 'tvijo_login_start', 'tvijo_review', 'tvijo_task_status', 'tvijo_wiki_context', 'tvijo_wiki_search']);
  assert.equal(api.requests.length, 0);
});

for (const cap of [undefined, '0.10', '100']) {
  test(`tvijo_ask rejects over-cap before any network call (cap ${cap ?? 'default'})`, async (t) => {
    const api = await fakeApi(t, () => { throw new Error('No requests allowed'); });
    const env = { TVIJO_API_BASE: api.base, TVIJO_TOKEN: fakeToken, ...(cap === undefined ? {} : { TVIJO_MAX_USD_CAP: cap }) };
    const client = await connectMemory(t, { env });
    const result = await client.callTool({ name: 'tvijo_ask', arguments: { prompt: 'Question', max_usd: cap === '0.10' ? 0.11 : cap === '100' ? 5.01 : 1.01 } });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /spending_cap/);
    assert.equal(api.requests.length, 0);
  });
}

test('invalid spending caps fail closed', () => {
  for (const value of ['', 'bad', '0', '-1', 'Infinity']) assert.throws(() => spendingCap({ TVIJO_MAX_USD_CAP: value }), { code: 'invalid_cap' });
  assert.equal(spendingCap({}), 1);
  assert.equal(spendingCap({ TVIJO_MAX_USD_CAP: '7' }), 5);
});

test('schema rejects missing/zero budget, empty/oversized prompts and fractional max_tokens without HTTP', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No requests allowed'); });
  const client = await connectMemory(t, { env: { TVIJO_API_BASE: api.base, TVIJO_TOKEN: fakeToken } });
  for (const args of [{ prompt: 'Question' }, { prompt: 'Question', max_usd: 0 }, { prompt: '', max_usd: 1 }, { prompt: 'x'.repeat(20001), max_usd: 1 }, { prompt: 'Question', max_usd: 1, max_tokens: 1.5 }]) {
    const result = await client.callTool({ name: 'tvijo_ask', arguments: args });
    assert.equal(result.isError, true);
  }
  assert.equal(api.requests.length, 0);
});

test('unsigned account and paid tools give actionable errors with no requests', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No requests allowed'); });
  const store = createTokenStore({ env: {}, file: join(await temporaryDirectory(), 'absent.json') });
  const client = await connectMemory(t, { env: { TVIJO_API_BASE: api.base }, store });
  for (const [name, args] of [['tvijo_account', {}], ['tvijo_ask', { prompt: 'Question', max_usd: 0.1 }], ['tvijo_task_status', { task_id: 'one' }], ['tvijo_cancel_task', { task_id: 'one' }]]) {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    assert.match(textOf(result), /npx tvijo-dshrem-mcp login/);
    assert.match(textOf(result), /tvijo_login_start/);
  }
  assert.equal(api.requests.length, 0);
});

test('MCP login returns pending then signed-in label and saves token without returning it', async (t) => {
  let polls = 0;
  const api = await fakeApi(t, (req) => {
    if (req.path.endsWith('/auth/device')) return { body: deviceResponse };
    if (req.path.endsWith('/account')) return { body: { label: 'Device test account', access_token: fakeToken } };
    if (++polls === 1) return { status: 428 };
    return { body: { access_token: fakeToken, expires_in: 3600 } };
  });
  let clock = Date.now();
  const file = join(await temporaryDirectory(), 'tvijo', 'mcp-token.json');
  const store = createTokenStore({ env: {}, file });
  const client = await connectMemory(t, { env: {}, client: createClient({ base: api.base }), store, now: () => clock });
  const start = await client.callTool({ name: 'tvijo_login_start', arguments: {} });
  assert.equal(start.structuredContent.user_code, deviceResponse.user_code);
  assert.equal(start.structuredContent.verification_uri, deviceResponse.verification_uri);
  assert.ok(!JSON.stringify(start).includes(deviceResponse.device_code));
  assert.equal(textOf(await client.callTool({ name: 'tvijo_login_poll', arguments: {} })), 'pending');
  assert.equal(api.requests.length, 1);
  clock += 1000;
  assert.equal(textOf(await client.callTool({ name: 'tvijo_login_poll', arguments: {} })), 'pending');
  clock += 1000;
  const result = await client.callTool({ name: 'tvijo_login_poll', arguments: {} });
  assert.equal(textOf(result), 'signed in as Device test account');
  assert.ok(!JSON.stringify(result).includes(fakeToken));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.access_token, fakeToken);
  const account = await client.callTool({ name: 'tvijo_account', arguments: {} });
  assert.equal(account.isError, undefined);
  assert.ok(!JSON.stringify(account).includes(fakeToken));
});

test('MCP login poll reports denial and forgets the challenge', async (t) => {
  const api = await fakeApi(t, (req) => req.path.endsWith('/auth/device') ? { body: deviceResponse } : { status: 403 });
  let clock = Date.now();
  const client = await connectMemory(t, { env: {}, client: createClient({ base: api.base }), now: () => clock });
  await client.callTool({ name: 'tvijo_login_start', arguments: {} });
  clock += 1000;
  assert.equal(textOf(await client.callTool({ name: 'tvijo_login_poll', arguments: {} })), 'denied');
  assert.equal((await client.callTool({ name: 'tvijo_login_poll', arguments: {} })).isError, true);
  assert.equal(api.requests.length, 2);
});

test('task status and cancel use the correct routes and escape task ids', async (t) => {
  const api = await fakeApi(t, () => ({ body: { id: 'id/with space', status: 'cancelled' } }));
  const client = await connectMemory(t, { env: { TVIJO_TOKEN: fakeToken, TVIJO_API_BASE: api.base } });
  for (const name of ['tvijo_task_status', 'tvijo_cancel_task']) assert.equal((await client.callTool({ name, arguments: { task_id: 'id/with space' } })).isError, undefined);
  assert.deepEqual(api.requests.map((req) => `${req.method} ${req.path}`), [
    'GET /api/dshrem/v1/tasks/id%2Fwith%20space', 'POST /api/dshrem/v1/tasks/id%2Fwith%20space/cancel'
  ]);
});

test('CLI version matches package.json without HTTP or sign-in', async () => {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = await execFileAsync(process.execPath, [bin, '--version'], { env: { PATH: process.env.PATH, HOME: await temporaryDirectory() } });
  assert.equal(result.stdout, `${version}\n`);
  assert.equal(result.stderr, '');
});

test('CLI device login writes private token; logout revokes and removes it', async (t) => {
  const home = await temporaryDirectory();
  const env = { PATH: process.env.PATH, HOME: home };
  const api = await fakeApi(t, (req) => {
    if (req.path.endsWith('/auth/device')) return { body: deviceResponse };
    if (req.path.endsWith('/auth/token')) return { body: { access_token: fakeToken, expires_in: 3600 } };
    if (req.path.endsWith('/auth/logout')) return { status: 204 };
    return { body: { label: `CLI test account ${fakeToken}` } };
  });
  env.TVIJO_API_BASE = api.base;
  const login = await execFileAsync(process.execPath, [bin, 'login'], { env });
  assert.equal(login.stdout, '');
  assert.match(login.stderr, /https:\/\/example.invalid\/device/);
  assert.match(login.stderr, /ABCD-EFGH/);
  assert.match(login.stderr, /signed in as CLI test account \[REDACTED\]/);
  assert.ok(!login.stderr.includes(fakeToken));
  const file = join(home, '.config', 'tvijo', 'mcp-token.json');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const logout = await execFileAsync(process.execPath, [bin, 'logout'], { env });
  assert.equal(logout.stdout, '');
  assert.ok(!logout.stderr.includes(fakeToken));
  assert.equal(api.requests.at(-1).path, '/api/dshrem/v1/auth/logout');
  assert.equal(api.requests.at(-1).authorization, `Bearer ${fakeToken}`);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});

test('CLI logout revokes an expired saved token before removing it', async (t) => {
  const home = await temporaryDirectory();
  const api = await fakeApi(t, () => ({ status: 204 }));
  const file = join(home, '.config', 'tvijo', 'mcp-token.json');
  await createTokenStore({ env: {}, file }).save({ access_token: fakeToken, expires_at: '2000-01-01T00:00:00Z', api_base: api.base });
  const result = await execFileAsync(process.execPath, [bin, 'logout'], { env: { PATH: process.env.PATH, HOME: home, TVIJO_API_BASE: api.base } });
  assert.equal(result.stdout, '');
  assert.equal(api.requests.length, 1);
  assert.equal(api.requests[0].path, '/api/dshrem/v1/auth/logout');
  assert.equal(api.requests[0].authorization, `Bearer ${fakeToken}`);
  await assert.rejects(stat(file), { code: 'ENOENT' });
});
