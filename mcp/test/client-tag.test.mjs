import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { clientTag, normalizeHost, VERSION } from '../src/client-tag.js';
import { completed, deviceResponse, fakeApi } from './helpers/fake-api.mjs';
import { connectMemory } from './helpers/mcp.mjs';

const hosts = ['claude-code', 'codex', 'vscode', 'cursor', 'windsurf', 'cline', 'claude-desktop', 'mcp-inspector'];
const tag = (host, offer = 'none') => `mcp/${VERSION}; host=${host}; caller=${host}; offer=${offer}`;
const question = { token: 'fake', maxUsd: 0.1, messages: [{ role: 'user', content: 'Question' }] };

test('host and offer values are allowlisted and all emitted values are bounded', () => {
  for (const host of hosts) {
    assert.equal(normalizeHost(host.toUpperCase()), host);
    assert.equal(normalizeHost(` ${host} `), host);
    assert.equal(clientTag(host, 'review'), tag(host, 'review'));
  }
  for (const value of [undefined, null, {}, 1, '', 'unknown', 'extension', 'a'.repeat(33), 'codex; offer=review', 'codex\r\nx: y', 'cоdex', 'CODEX\0']) {
    assert.equal(normalizeHost(value), 'other');
    assert.equal(clientTag(value), tag('other'));
  }
  for (const offer of ['ask', 'review', 'none', 'delegate', 'review\n', {}, null, 'x'.repeat(33)]) {
    const value = clientTag('codex', offer);
    assert.match(value, /^mcp\/[a-z0-9.-]{1,32}; host=[a-z0-9.-]{1,32}; caller=[a-z0-9.-]{1,32}; offer=(ask|review|none)$/);
  }
});

for (const host of [...hosts, 'malformed; host=codex\r\nx: y']) test(`MCP initialize supplies the header host: ${JSON.stringify(host)}`, async (t) => {
  const api = await fakeApi(t, () => ({ body: {} }));
  const client = await connectMemory(t, { env: { TVIJO_TOKEN: 'fake', TVIJO_API_BASE: api.base } }, host);
  await client.callTool({ name: 'tvijo_account', arguments: {} });
  assert.equal(api.requests[0].headers['x-tvijo-client'], tag(hosts.includes(host) ? host : 'other'));
});

test('every request path has a tag, including device login and unauthenticated CLI-style calls', async (t) => {
  const api = await fakeApi(t, (req) => {
    if (req.path.endsWith('/auth/device')) return { body: deviceResponse };
    if (req.path.endsWith('/auth/token')) return { body: { access_token: 'fake' } };
    if (req.path.endsWith('/chat')) return { body: completed };
    if (req.path.endsWith('/tasks')) return { body: { id: 'task-1' } };
    return { body: completed };
  });
  const client = createClient({ base: api.base });
  const device = await client.startDeviceLogin();
  await client.pollDeviceOnce(device);
  await client.account('fake');
  await client.task('fake', 'task-1');
  await client.taskState('fake', 'task-1');
  await client.lookupGrant('fake', 'key');
  await client.cancel('fake', 'task-1');
  await client.logout('fake');
  await client.ask(question);
  assert.equal(api.requests.length, 10);
  for (const [index, req] of api.requests.entries()) assert.equal(req.headers['x-tvijo-client'], tag('other', index >= 8 ? 'ask' : 'none'));
});

test('concurrent asks, reviews and account lookups retain their own offer on recovery', async (t) => {
  const api = await fakeApi(t, async (req) => {
    if (req.path.endsWith('/tasks')) return { body: { id: req.body.title } };
    if (req.path.endsWith('/chat')) return { action: 'timeout' };
    return { body: { ...completed, id: req.path.split('/').at(-1) } };
  });
  const client = createClient({ base: api.base, chatTimeoutMs: 100 });
  client.setClientNameProvider(() => 'cursor');
  await Promise.all([client.ask({ ...question, title: 'ask' }), client.ask({ ...question, title: 'review', offer: 'review' }), client.account('fake')]);
  assert.equal(api.requests.length, 7);
  for (const req of api.requests) {
    const offer = req.path.endsWith('/account') ? 'none' : req.body?.title ?? (req.path.includes('/review') ? 'review' : 'ask');
    assert.equal(req.headers['x-tvijo-client'], tag('cursor', offer));
  }
});

test('grant timeout lookup retains the ask offer and initialized host', async (t) => {
  const api = await fakeApi(t, (req) => req.method === 'POST' ? { action: 'timeout' } : { body: completed });
  const client = await connectMemory(t, { env: { TVIJO_TOKEN: 'fake' }, client: createClient({ base: api.base, timeoutMs: 100 }) }, 'claude-code');
  await client.callTool({ name: 'tvijo_ask', arguments: { prompt: 'Question', max_usd: 0.1 } });
  assert.deepEqual(api.requests.map((r) => r.method), ['POST', 'GET']);
  assert.ok(api.requests.every((r) => r.headers['x-tvijo-client'] === tag('claude-code', 'ask')));
});
