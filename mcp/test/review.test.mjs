import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/client.js';
import { diffFiles, reviewOutputSchema, reviewResult } from '../src/review.js';
import { completed, fakeApi } from './helpers/fake-api.mjs';
import { connectMemory } from './helpers/mcp.mjs';

const diff = 'diff --git a/src/a.js b/src/a.js\n--- a/src/a.js\n+++ b/src/a.js\n@@ -1 +1 @@\n-return value;\n+return value.trim();\n';
const args = { diff, base_sha: 'a'.repeat(40), head_sha: 'b'.repeat(40), max_usd: 0.1 };
const reviewed = { base_sha: args.base_sha, head_sha: args.head_sha, files: ['src/a.js'], diff_chars: diff.length };
const finding = { file: 'src/a.js', line: 1, severity: 'high', issue: 'Null input throws.', evidence: '+return value.trim();' };
const opinion = (change = {}) => ({ outcome: 'findings', reviewed, findings: [finding], answer: 'Null input is an edge case.', receipt: { task_id: 'pending', spent_usd: null }, ...change });
const response = (answer) => ({ ...completed, choices: [{ message: { content: answer } }] });
const resultOf = (answer, spent_usd = '0.012') => reviewResult({ task_id: 'task-1', answer, spent_usd }, reviewed);

test('review makes one grant and one chat with bounded title, JSON instruction, scope and real receipt', async (t) => {
  const raw = JSON.stringify(opinion({ reviewed: { ...reviewed, head_sha: 'forged', files: ['forged'] }, receipt: { task_id: 'forged', spent_usd: 999 } }));
  const api = await fakeApi(t, (req) => ({ body: req.path.endsWith('/chat') ? response(raw) : { id: 'task-1' } }));
  const client = await connectMemory(t, { env: { TVIJO_TOKEN: 'fake', TVIJO_API_BASE: api.base } });
  const result = await client.callTool({ name: 'tvijo_review', arguments: { ...args, focus: 'Edge cases' } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(api.requests.map((r) => `${r.method} ${r.path}`), ['POST /api/dshrem/v1/tasks', 'POST /api/dshrem/v1/tasks/task-1/chat']);
  assert.equal(api.requests[0].body.title, `review ${args.head_sha.slice(0, 12)}`);
  assert.equal(api.requests[0].body.max_usd, '0.1');
  assert.ok(api.requests[0].body.idempotency_key);
  const messages = api.requests[1].body.messages;
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /JSON only/);
  assert.deepEqual(JSON.parse(messages[1].content), { reviewed, focus: 'Edge cases', diff });
  assert.deepEqual(result.structuredContent, { outcome: 'findings', reviewed, findings: [finding], answer: raw, receipt: { task_id: 'task-1', spent_usd: 0.012 } });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.ok(api.requests.every((r) => r.headers['x-tvijo-client'].endsWith('offer=review')));
});

for (const stage of ['grant', 'chat']) test(`review ${stage} timeout permits only a lookup after dispatch`, async (t) => {
  const api = await fakeApi(t, (req) => {
    if (req.method === 'GET') return { body: response(JSON.stringify(opinion())) };
    if (stage === 'grant' || req.path.endsWith('/chat')) return { action: 'timeout' };
    return { body: { id: 'task-1' } };
  });
  const client = await connectMemory(t, { env: { TVIJO_TOKEN: 'fake' }, client: createClient({ base: api.base, timeoutMs: 100, chatTimeoutMs: 100 }) });
  const result = await client.callTool({ name: 'tvijo_review', arguments: args });
  assert.equal(result.structuredContent.outcome, 'findings');
  assert.deepEqual(api.requests.map((r) => r.method), stage === 'grant' ? ['POST', 'GET'] : ['POST', 'POST', 'GET']);
  assert.match(api.requests.at(-1).path, stage === 'grant' ? /\/by-idempotency\// : /\/tasks\/task-1$/);
  assert.ok(api.requests.every((r) => r.headers['x-tvijo-client'].endsWith('offer=review')));
});

for (const stage of ['grant', 'chat']) test(`review ${stage} non-timeout failure does not trigger a lookup or retry`, async (t) => {
  const api = await fakeApi(t, (req) => stage === 'grant' || req.path.endsWith('/chat') ? { status: 502 } : { body: { id: 'task-1' } });
  const client = await connectMemory(t, { env: { TVIJO_TOKEN: 'fake', TVIJO_API_BASE: api.base } });
  const result = await client.callTool({ name: 'tvijo_review', arguments: args });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, stage === 'grant' ? /Idempotency key:/ : /task-1/);
  assert.deepEqual(api.requests.map((r) => r.method), stage === 'grant' ? ['POST'] : ['POST', 'POST']);
});

test('review refuses over-cap, oversize and malformed inputs before token reads or HTTP', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No requests allowed'); });
  const client = await connectMemory(t, { env: { TVIJO_API_BASE: api.base }, store: { get: () => { throw new Error('No token read allowed'); } } });
  for (const [change, message] of [
    [{ max_usd: 1.01 }, /spending_cap/], [{ diff: 'x'.repeat(20001) }, /diff_too_large.*Split by path/s],
    [{ max_usd: 0 }, /./], [{ max_usd: -1 }, /./], [{ max_usd: '0.1' }, /./],
    [{ max_usd: undefined }, /./], [{ diff: '' }, /./], [{ focus: 'x'.repeat(501) }, /./],
    [{ base_sha: '' }, /./], [{ head_sha: 'main' }, /./]
  ]) {
    const result = await client.callTool({ name: 'tvijo_review', arguments: { ...args, ...change } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
  }
  assert.equal(api.requests.length, 0);
});

test('20,000-character diff and 500-character focus are accepted at the cap', async (t) => {
  const api = await fakeApi(t, (req) => ({ body: req.path.endsWith('/chat') ? response(JSON.stringify(opinion())) : { id: 'task-1' } }));
  const client = await connectMemory(t, { env: { TVIJO_TOKEN: 'fake', TVIJO_API_BASE: api.base, TVIJO_MAX_USD_CAP: '0.1' } });
  const result = await client.callTool({ name: 'tvijo_review', arguments: { ...args, diff: diff.padEnd(20000, ' '), focus: 'x'.repeat(500) } });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.reviewed.diff_chars, 20000);
  assert.equal(api.requests.length, 2);
});

test('all three outcomes parse, with strict nested schemas and raw fallback', () => {
  for (const outcome of ['findings', 'no_findings_in_reviewed_scope', 'inconclusive']) {
    const raw = JSON.stringify(opinion({ outcome, findings: outcome === 'findings' ? [finding] : [] }));
    const result = resultOf(raw);
    assert.equal(result.outcome, outcome);
    assert.equal(result.answer, raw);
    assert.ok(reviewOutputSchema.safeParse(result).success);
    assert.doesNotMatch(JSON.stringify(result), /\bPASS\b|\bcorrect\b|safe to merge/i);
  }
  for (const raw of ['not JSON', '```json\n{}\n```', '{}', 'null', '[]', JSON.stringify(opinion({ extra: true })), JSON.stringify(opinion({ outcome: 'approved' })), JSON.stringify(opinion({ findings: [{ ...finding, severity: 'critical' }] })), JSON.stringify(opinion({ findings: [{ ...finding, line: '1' }] })), JSON.stringify(opinion({ findings: [{ ...finding, extra: true }] }))]) {
    const result = resultOf(raw);
    assert.equal(result.outcome, 'inconclusive');
    assert.equal(result.answer, raw);
    assert.deepEqual(result.findings, []);
    assert.match(result.reason, /schema/);
  }
});

test('out-of-diff findings are dropped and counted; empty or inconsistent findings are inconclusive', () => {
  const outside = { ...finding, file: 'not-in-diff.js' };
  const result = resultOf(JSON.stringify(opinion({ findings: [finding, outside] })));
  assert.deepEqual(result.findings, [finding]); assert.match(result.reason, /Dropped 1/);
  for (const change of [{ findings: [outside] }, { findings: [] }, { outcome: 'no_findings_in_reviewed_scope' }]) assert.equal(resultOf(JSON.stringify(opinion(change))).outcome, 'inconclusive');
});

test('missing answers and unknown or invalid spending stay null, while known zero stays zero', () => {
  for (const value of [null, '', 'unknown', -1, false, 'Infinity']) assert.equal(resultOf(null, value).receipt.spent_usd, null);
  assert.equal(reviewResult({ task_id: 'task-1', answer: null }, reviewed).receipt.spent_usd, null);
  assert.equal(reviewResult({ task_id: 'task-1', answer: null, spent_usd: '0.1', state: { costKnown: false } }, reviewed).receipt.spent_usd, null);
  assert.equal(resultOf(null, 0).receipt.spent_usd, 0);
  assert.equal(resultOf(null).answer, null);
  assert.equal(resultOf(null).outcome, 'inconclusive');
});

test('a certifying verdict is replaced but its findings are kept; raw diagnostic evidence is retained', () => {
  for (const claim of ['PASS', 'LGTM', 'The change is correct', 'Looks good', 'safe to merge']) {
    const raw = JSON.stringify(opinion({ reason: claim }));
    const result = resultOf(raw);
    assert.equal(result.outcome, opinion().outcome);
    assert.deepEqual(result.findings, opinion().findings);
    assert.doesNotMatch(result.reason, /\bPASS\b|\bLGTM\b|\bcorrect\b|safe to merge|looks good/i);
    assert.match(result.reason, /certifies nothing/);
    assert.equal(result.answer, raw);
  }
});

test('a finding may describe the correct fix without voiding the paid review', () => {
  const fix = { ...finding, issue: 'Off-by-one: the correct index is i - 1.' };
  const result = resultOf(JSON.stringify(opinion({ findings: [fix] })));
  assert.equal(result.outcome, 'findings');
  assert.deepEqual(result.findings, [fix]);
});

test('invalid caps and the hard ceiling refuse review without any network requests', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No HTTP expected'); });
  for (const [cap, max_usd, code] of [['100', 5.01, 'spending_cap'], ['0', 0.1, 'invalid_cap'], ['invalid', 0.1, 'invalid_cap']]) {
    const client = await connectMemory(t, { env: { TVIJO_API_BASE: api.base, TVIJO_MAX_USD_CAP: cap } });
    const result = await client.callTool({ name: 'tvijo_review', arguments: { ...args, max_usd } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, new RegExp(code));
  }
  assert.equal(api.requests.length, 0);
});

test('diff paths handle additions, deletions, renames, binary files, spaces and Git quoting', () => {
  assert.deepEqual(diffFiles(diff), ['src/a.js']);
  assert.deepEqual(diffFiles('--- /dev/null\n+++ b/new file.js\n@@ -0,0 +1 @@\n+x\n--- a/old.js\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'), ['new file.js', 'old.js']);
  assert.deepEqual(diffFiles('diff --git a/old.js b/new.js\nsimilarity index 100%\nrename from old.js\nrename to new.js\ndiff --git a/logo.png b/logo.png\nBinary files differ\n'), ['new.js', 'logo.png']);
  assert.deepEqual(diffFiles('diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"\n--- "a/caf\\303\\251.js"\n+++ "b/caf\\303\\251.js"\n'), ['café.js']);
  assert.deepEqual(diffFiles('--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n--- a/fake.js\n+++ b/fake.js\n'), ['a.js']);
});
