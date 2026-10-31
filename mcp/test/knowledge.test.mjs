import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createClient } from '../src/client.js';
import { createMcpServer } from '../src/server.js';
import { fakeApi, packageDir, temporaryDirectory } from './helpers/fake-api.mjs';

const EXPECTED_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TOKEN = 'fixture-knowledge-token-never-output';
const SHA = 'a'.repeat(64);
const pointer = { corpus: 'tvijo', slug: 'c/mcp', url: 'https://tvijo.com/wiki/c/mcp/', sha256: SHA };
const source = { corpus: 'tvijo', built_at: '2026-10-31T00:00:00Z', source_url: 'https://tvijo.com/wiki/sitemap.xml' };
const catalog = { projection_sha256: SHA, as_of: '2026-10-31', rank_definition: 'v0 research queue only' };
const cases = [
  ['wiki_search', { query: 'MCP', limit: 1, lang: 'en' }, { items: [pointer], source }],
  ['wiki_context', { key: 'c/mcp', expect_sha256: SHA, max_tokens: 100 }, { pointer, source, text: 'External untrusted article text', tokens: 8 }],
  ['catalog_search', { query: 'slack', limit: 1 }, { ...catalog, results: [{ slug: 'slack', eligibility: 'research_only', readiness: 'documented_only' }] }],
  ['catalog_get', { slug: 'slack' }, { ...catalog, app: { slug: 'slack', eligibility: 'research_only', readiness: 'documented_only' } }]
];
const envelope = (name, data) => ({ tool: name, untrusted: true, data });
const text = (result) => result.content.map((v) => v.text ?? '').join('\n');

async function memory(t, options) {
  const server = createMcpServer(options);
  const client = new Client({ name: 'knowledge-fixture', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(b); await client.connect(a);
  return client;
}

test('real stdio discovery and four authenticated public reads preserve provenance and untrusted data', async (t) => {
  const api = await fakeApi(t, (req) => {
    assert.equal(req.authorization, 'Bearer ' + TOKEN);
    const name = req.path.split('/').at(-1);
    const match = cases.find(([tool]) => tool === name);
    assert.ok(match, 'only the four fixed read routes may be requested');
    assert.deepEqual(req.body, match[1]);
    return { body: envelope(name, match[2]) };
  });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(packageDir, 'bin/tvijo-dshrem-mcp.js')], cwd: packageDir, stderr: 'pipe',
    env: { PATH: process.env.PATH, HOME: await temporaryDirectory(), TVIJO_TOKEN: TOKEN,
      TVIJO_API_BASE: api.base, TVIJO_MAX_USD_CAP: 'invalid-but-reads-do-not-spend' } });
  let stdout = '', stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  const start = transport.start.bind(transport);
  transport.start = async () => { await start(); transport._process.stdout.on('data', (chunk) => { stdout += chunk; }); };
  const client = new Client({ name: 'knowledge-stdio', version: '1' });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().version, EXPECTED_VERSION);
  const { tools } = await client.listTools();
  assert.equal(tools.length, 11);
  for (const [name, args, data] of cases) {
    const tool = tools.find((v) => v.name === 'tvijo_' + name);
    assert.ok(tool);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.idempotentHint, true);
    assert.equal(tool.inputSchema.additionalProperties, false);
    const result = await client.callTool({ name: tool.name, arguments: args });
    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, envelope(name, data));
    assert.deepEqual(JSON.parse(text(result)), result.structuredContent);
  }
  assert.equal(api.requests.length, 4);
  assert.ok(api.requests.every((r) => r.method === 'POST' && r.path.startsWith('/api/dshrem/v1/knowledge/tools/')));
  await client.close();
  assert.ok(!stdout.includes(TOKEN) && !stderr.includes(TOKEN));
  assert.equal(stderr, '');
});

test('strict MCP schemas reject URL/corpus/header/token injection and invalid limits before HTTP', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('invalid input reached HTTP'); });
  const client = await memory(t, { env: { TVIJO_TOKEN: TOKEN, TVIJO_API_BASE: api.base } });
  const attacks = [
    ['wiki_search', { query: 'MCP', corpus: 'abai' }],
    ['wiki_search', { query: 'MCP', url: 'http://169.254.169.254/' }],
    ['wiki_search', { query: 'MCP', headers: { Authorization: 'private' } }],
    ['catalog_get', { slug: 'slack', token: 'chosen-by-model' }],
    ['wiki_search', { query: 'MCP', limit: true }],
    ['wiki_search', { query: 'MCP', limit: 11 }],
    ['wiki_search', { query: 'MCP', lang: 'uk' }],
    ['wiki_search', { query: 'x'.repeat(201) }],
    ['wiki_context', { key: 'c/mcp' }],
    ['wiki_context', { key: '../abai', expect_sha256: SHA }],
    ['wiki_context', { key: 'c/mcp', expect_sha256: SHA, max_tokens: 2001 }],
    ['catalog_search', { query: 'slack', category: 'x'.repeat(101) }],
    ['catalog_get', { slug: '../secret' }]
  ];
  for (const [name, args] of attacks) {
    const result = await client.callTool({ name: 'tvijo_' + name, arguments: args });
    assert.equal(result.isError, true, name);
  }
  assert.equal(api.requests.length, 0);
});

test('direct client validation also refuses unsupported tools and oversized arguments', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('invalid input reached HTTP'); });
  const client = createClient({ base: api.base });
  for (const [name, args] of [['connector_request_create', {}], ['toString', {}], ['__proto__', {}], ['wiki_search', { query: 'x'.repeat(4097) }],
    ['wiki_search', { query: 'MCP', origin: 'https://evil.example' }],
    ['wiki_context', { key: 'c/mcp', expect_sha256: SHA + '\n' }]]) {
    await assert.rejects(client.knowledge(TOKEN, name, args), { code: 'invalid_knowledge_arguments' });
  }
  assert.equal(api.requests.length, 0);
});

for (const [status, code] of [[401, 'unauthorized'], [403, 'authorization_denied'],
  [409, 'stale_wiki_revision'], [503, 'knowledge_unavailable']]) {
  test(`knowledge HTTP ${status} is explicit, redacted and never retried`, async (t) => {
    const api = await fakeApi(t, () => ({ status, body: { error: { message: TOKEN } } }));
    const client = await memory(t, { env: { TVIJO_TOKEN: TOKEN, TVIJO_API_BASE: api.base } });
    const result = await client.callTool({ name: 'tvijo_wiki_context', arguments: cases[1][1] });
    assert.equal(result.isError, true);
    assert.ok(text(result).includes(code));
    assert.ok(!JSON.stringify(result).includes(TOKEN));
    assert.equal(api.requests.length, 1);
  });
}

test('unsigned knowledge tools do not send requests or create alternative token storage', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('unsigned call reached HTTP'); });
  let gets = 0;
  const client = await memory(t, { env: {}, client: createClient({ base: api.base }),
    store: { get: async () => { gets++; throw new Error('no stored token'); } } });
  for (const [name, args] of cases) {
    assert.equal((await client.callTool({ name: 'tvijo_' + name, arguments: args })).isError, true);
  }
  assert.equal(gets, 4);
  assert.equal(api.requests.length, 0);
});

for (const declared of [true, false]) {
  test(`knowledge response bound64KiB applies with${declared ? '' : 'out'} content-length`, async (t) => {
    let calls = 0, cancelled = false;
    const fetchImpl = async () => {
      calls++;
      const body = JSON.stringify(envelope('wiki_context', { ...cases[1][2], text: 'x'.repeat(65536) }));
      const stream = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode(body)); },
        cancel() { cancelled = true; }
      });
      return new Response(stream, { headers: declared ? { 'content-length': String(Buffer.byteLength(body)) } : {} });
    };
    await assert.rejects(createClient({ fetchImpl }).knowledge(TOKEN, 'wiki_context', cases[1][1]),
      (error) => error.code === 'oversized' && error.message.includes('64 KiB'));
    assert.equal(calls, 1);
    assert.equal(cancelled, true);
  });
}

for (const corrupted of [
  { ...envelope('wiki_search', cases[0][2]), untrusted: false },
  envelope('wiki_search', { ...cases[0][2], source: { corpus: 'abai' } }),
  envelope('wiki_search', { ...cases[0][2], items: [{ ...pointer, url: 'https://tvijo.com.evil/wiki/x/' }] }),
  envelope('wiki_search', { ...cases[0][2], items: [{ ...pointer, sha256: 'bad' }] }),
  envelope('wiki_search', { ...cases[0][2], items: [{ ...pointer, sha256: [SHA] }] }),
  envelope('wiki_search', { ...cases[0][2], items: [{ ...pointer, sha256: SHA + '\n' }] }),
  envelope('catalog_get', { app: null })
]) {
  test('malformed/private source envelopes fail instead of becoming successful empty knowledge', async () => {
    const client = createClient({ fetchImpl: async () => Response.json(corrupted) });
    const name = corrupted.tool;
    await assert.rejects(client.knowledge(TOKEN, name, name === 'catalog_get' ? { slug: 'slack' } : { query: 'MCP' }),
      { code: 'invalid_knowledge_response' });
  });
}

test('MCP cancellation aborts the single in-flight knowledge HTTP request', async (t) => {
  let seen;
  const reached = new Promise((resolve) => { seen = resolve; });
  const api = await fakeApi(t, () => { seen(); return { action: 'timeout' }; });
  let requestSignal;
  const service = createClient({ base: api.base, fetchImpl: (url, options) => {
    requestSignal = options.signal; return fetch(url, options);
  } });
  const client = await memory(t, { env: { TVIJO_TOKEN: TOKEN }, client: service });
  const controller = new AbortController();
  const pending = client.callTool({ name: 'tvijo_wiki_search', arguments: { query: 'MCP' } }, undefined,
    { signal: controller.signal });
  await reached;
  controller.abort(new Error('fixture_cancelled'));
  await assert.rejects(pending, /fixture_cancelled/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requestSignal.aborted, true);
  assert.equal(api.requests.length, 1);
});
