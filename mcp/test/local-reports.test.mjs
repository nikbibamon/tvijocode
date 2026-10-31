import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createLocalReports } from '../src/local-reports.js';
import { fakeApi, packageDir } from './helpers/fake-api.mjs';

const clock = Date.parse('2026-10-25T01:00:00Z');
const timestamp = '2026-10-25T00:59:00Z';
const baseNames = ['tvijo_account', 'tvijo_ask', 'tvijo_cancel_task', 'tvijo_catalog_get', 'tvijo_catalog_search', 'tvijo_login_poll', 'tvijo_login_start', 'tvijo_review', 'tvijo_task_status', 'tvijo_wiki_context', 'tvijo_wiki_search'];
const localNames = ['tvijo_local_repositories', 'tvijo_local_test_results', 'tvijo_local_execution_budget'];
const repositories = { as_of: timestamp, repositories: [{ id: 'aios', head: 'a'.repeat(40), worktree: 'dirty', allowed: true }] };
const tests = { as_of: timestamp, results: [{ repository: 'aios', suite: 'incremental-index', status: 'PASS', passed: 30, failed: 0, skipped: 0, not_run: 0, total: 30, duration_ms: 10 }] };
const unknown = { as_of: null, accounting: 'unknown', currency: 'USD', limit_usd: null, settled_usd: null, held_usd: null, available_usd: null, reason: 'unavailable' };
const frozen = { as_of: timestamp, accounting: 'frozen', currency: 'USD', limit_usd: null, settled_usd: 0.07541972592, held_usd: 0.0380892, available_usd: null, reason: 'uncertain_spend' };
const clone = (value) => structuredClone(value);
async function directory() { return mkdtemp(join(tmpdir(), 'local-reports-')); }
async function fixture() {
  const root = await directory();
  for (const [file, value] of [['repositories.json', repositories], ['test-results.json', tests], ['execution-budget.json', frozen]]) await writeFile(join(root, file), JSON.stringify(value));
  return { root, reports: createLocalReports({ TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: root }, () => clock) };
}
async function replace(root, name, value) { await writeFile(join(root, name), JSON.stringify(value)); }
async function stdio(t, env) {
  const home = await directory();
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(packageDir, 'bin/tvijo-dshrem-mcp.js')], cwd: packageDir, stderr: 'pipe', env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmpdir(), ...env } });
  const output = { stdout: '', stderr: '' };
  transport.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const start = transport.start.bind(transport);
  transport.start = async () => { await start(); transport._process.stdout.on('data', (chunk) => { output.stdout += chunk; }); };
  const client = new Client({ name: 'local-report-smoke', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(transport);
  return { client, output };
}

test('local tools require BOTH explicit exact flag and absolute root', () => {
  for (const env of [{}, { TVIJO_LOCAL_REPORTS: '1' }, { TVIJO_LOCAL_REPORT_ROOT: '/somewhere' }, { TVIJO_LOCAL_REPORTS: 'true', TVIJO_LOCAL_REPORT_ROOT: '/somewhere' }]) assert.equal(createLocalReports(env), null);
  for (const root of ['relative', '/', '/tmp/../outside', '/tmp/./report', '/tmp//report', '/tmp/report/', '/tmp/a\\b', '/tmp/a\0b']) assert.throws(() => createLocalReports({ TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: root }), { code: 'invalid_local_report_root' });
});

test('strict schemas return only documented fields and accounting exactly', async () => {
  const { root, reports } = await fixture();
  assert.deepEqual(await reports.read('repositories'), { ...repositories, freshness: 'fresh', authority: 'evidence_only' });
  assert.deepEqual(await reports.read('tests'), { ...tests, freshness: 'fresh', authority: 'evidence_only' });
  assert.deepEqual(await reports.read('budget'), { ...frozen, freshness: 'fresh', authority: 'evidence_only' });
  await replace(root, 'execution-budget.json', unknown);
  assert.deepEqual(await reports.read('budget'), { ...unknown, freshness: 'unknown', authority: 'evidence_only' });
});

test('stale timestamps stay stale, future/impossible times refused', async () => {
  const { root, reports } = await fixture();
  await replace(root, 'repositories.json', { ...repositories, as_of: '2026-10-24T00:00:00Z' });
  assert.equal((await reports.read('repositories')).freshness, 'stale');
  for (const as_of of ['2026-10-25T01:00:01Z', '2026-02-30T00:00:00Z', 'yesterday']) {
    await replace(root, 'repositories.json', { ...repositories, as_of });
    await assert.rejects(reports.read('repositories'), { code: 'invalid_local_snapshot' });
  }
});

test('caller paths, commands, traversal and unknown kinds are refused', async () => {
  const { reports } = await fixture();
  for (const kind of ['../repositories', '/etc/passwd', 'toString', '__proto__', 'repositories.json']) await assert.rejects(reports.read(kind), { code: 'invalid_local_snapshot' });
  for (const args of [{ path: '../outside' }, { command: 'pwd' }, { filename: '/etc/passwd' }, [], null]) await assert.rejects(reports.read('repositories', args), { code: 'invalid_local_snapshot' });
});

for (const [label, mutate] of [
  ['top-level token', (r) => { r.token = 'synthetic-do-not-leak'; }],
  ['nested password', (r) => { r.repositories[0].password = 'synthetic-do-not-leak'; }],
  ['secret-shaped identifier', (r) => { r.repositories[0].id = 'api-key-abcdefgh12345'; }],
  ['unknown nested field', (r) => { r.repositories[0].logs = 'raw-log'; }],
  ['unallowed repository', (r) => { r.repositories[0].allowed = false; }],
  ['arbitrary path field', (r) => { r.repositories[0].path = '/etc/passwd'; }],
  ['wrong head type', (r) => { r.repositories[0].head = 123; }]
]) test(`refuses ${label}`, async () => {
  const { root, reports } = await fixture(); const value = clone(repositories); mutate(value);
  await replace(root, 'repositories.json', value);
  await assert.rejects(reports.read('repositories'), (error) => error.code === 'invalid_local_snapshot' && !error.message.includes('synthetic-do-not-leak'));
});

for (const [label, mutate] of [
  ['negative money', (r) => { r.held_usd = -1; }],
  ['string money', (r) => { r.held_usd = '0.1'; }],
  ['huge money', (r) => { r.held_usd = 1e100; }],
  ['unknown as zero', (r) => { Object.assign(r, unknown, { held_usd: 0 }); }],
  ['frozen as available', (r) => { r.available_usd = 0; }],
  ['unknown keys', (r) => { r.cost_tokens = 99; }]
]) test(`budget refuses ${label}`, async () => {
  const { root, reports } = await fixture(); const value = clone(frozen); mutate(value);
  await replace(root, 'execution-budget.json', value); await assert.rejects(reports.read('budget'));
});

test('known budget, NOT_RUN summaries and numeric inconsistencies', async () => {
  const { root, reports } = await fixture();
  await replace(root, 'execution-budget.json', { ...frozen, accounting: 'known', reason: 'none', limit_usd: 1, settled_usd: 0.1, held_usd: 0.2, available_usd: 0.7 });
  assert.equal((await reports.read('budget')).accounting, 'known');
  const result = { repository: 'aios', suite: 'guard', status: 'NOT_RUN', passed: 0, failed: 0, skipped: 0, not_run: 1, total: 1, duration_ms: null };
  await replace(root, 'test-results.json', { as_of: null, results: [result] });
  assert.equal((await reports.read('tests')).results[0].status, 'NOT_RUN');
  for (const change of [{ total: 2 }, { passed: -1 }, { total: 1.5 }, { status: 'PASS' }, { duration_ms: '10' }]) {
    await replace(root, 'test-results.json', { as_of: timestamp, results: [{ ...result, ...change }] });
    await assert.rejects(reports.read('tests'));
  }
});

test('bad JSON, invalid UTF-8, missing file, directories and >64KiB refused', async () => {
  const { root, reports } = await fixture();
  for (const value of ['{', '{"as_of":null,"held_usd":1e999}', 'x'.repeat(65537), Buffer.from([0xff, 0xfe])]) {
    await writeFile(join(root, 'execution-budget.json'), value); await assert.rejects(reports.read('budget'));
  }
  const empty = await directory(); const reader = createLocalReports({ TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: empty });
  await assert.rejects(reader.read('tests'));
  await mkdir(join(empty, 'test-results.json')); await assert.rejects(reader.read('tests'));
});

test('root, file and parent symlink escape refused, including root replacement', async () => {
  const outside = await directory(); await replace(outside, 'repositories.json', repositories);
  const parent = await directory(); const link = join(parent, 'link'); await symlink(outside, link);
  for (const root of [link, join(parent, 'link', 'child'), join(parent, 'absent')]) {
    const reader = createLocalReports({ TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: root });
    await assert.rejects(reader.read('repositories'), { code: 'invalid_local_report_root' });
  }
  const safe = await directory(); await symlink(join(outside, 'repositories.json'), join(safe, 'repositories.json'));
  const reports = createLocalReports({ TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: safe });
  await assert.rejects(reports.read('repositories'));
  // The configured path may not exist at creation; every read reopens safe parents.
  const changed = join(parent, 'later'); const reader = createLocalReports({ TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: changed });
  await symlink(outside, changed); await assert.rejects(reader.read('repositories'));
});

test('real stdio default tools/list remains eleven for each incomplete opt-in', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No HTTP expected'); });
  const { root } = await fixture();
  for (const config of [{}, { TVIJO_LOCAL_REPORTS: '1' }, { TVIJO_LOCAL_REPORT_ROOT: root }]) {
    const { client } = await stdio(t, { TVIJO_API_BASE: api.base, ...config });
    assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name).sort(), [...baseNames].sort());
    await client.close();
  }
  assert.equal(api.requests.length, 0);
  t.diagnostic('STDIO_DEFAULT: eleven tools; three incomplete opt-ins; HTTP requests=0');
});

test('real stdio snapshots, annotations, redactor and no HTTP side effects', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No HTTP expected'); });
  const { root } = await fixture();
  const observedAt = new Date(Date.now() - 60_000).toISOString();
  for (const [file, value] of [['repositories.json', repositories], ['test-results.json', tests], ['execution-budget.json', frozen]]) await replace(root, file, { ...value, as_of: observedAt });
  const secret = 'synthetic-token-never-print';
  const { client, output } = await stdio(t, { TVIJO_API_BASE: api.base, TVIJO_TOKEN: secret, TVIJO_LOCAL_REPORTS: '1', TVIJO_LOCAL_REPORT_ROOT: root });
  const listed = (await client.listTools()).tools;
  assert.deepEqual(listed.map((tool) => tool.name).sort(), [...baseNames, ...localNames].sort());
  for (const name of localNames) {
    assert.deepEqual(listed.find((tool) => tool.name === name).annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    const result = await client.callTool({ name, arguments: {} }); assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.authority, 'evidence_only');
  }
  const budget = (await client.callTool({ name: 'tvijo_local_execution_budget', arguments: {} })).structuredContent;
  assert.equal(budget.accounting, 'frozen'); assert.equal(budget.available_usd, null); assert.equal(budget.held_usd, frozen.held_usd);
  const before = await readFile(join(root, 'execution-budget.json'));
  const denied = await client.callTool({ name: 'tvijo_local_execution_budget', arguments: { path: '../outside', command: 'pwd' } }); assert.equal(denied.isError, true);
  assert.deepEqual(await readFile(join(root, 'execution-budget.json')), before);
  await replace(root, 'repositories.json', { ...repositories, token: secret });
  assert.equal((await client.callTool({ name: 'tvijo_local_repositories', arguments: {} })).isError, true);
  await client.close();
  for (const line of output.stdout.trim().split('\n')) assert.equal(JSON.parse(line).jsonrpc, '2.0');
  assert.ok(!output.stdout.includes(secret)); assert.ok(!output.stderr.includes(secret)); assert.equal(output.stderr, ''); assert.equal(api.requests.length, 0);
  t.diagnostic(JSON.stringify({ receipt: 'STDIO_OPT_IN', tools: listed.length, local_tools: localNames, accounting: budget.accounting, held_usd: budget.held_usd, available_usd: budget.available_usd, freshness: budget.freshness, http_requests: api.requests.length, stdout_sha256: createHash('sha256').update(output.stdout).digest('hex') }));
});
