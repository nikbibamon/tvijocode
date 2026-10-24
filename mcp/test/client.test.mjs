import test from 'node:test';
import assert from 'node:assert/strict';
import { apiBase, createClient, taskStateOf } from '../src/client.js';
import { completed, deviceResponse, fakeApi } from './helpers/fake-api.mjs';

const credentials = 'fake-client-token';
const question = { token: credentials, messages: [{ role: 'user', content: 'Explain this function.' }], maxUsd: 0.25, idempotencyKey: 'stable-key' };

for (const pending of [false, true]) {
  test(`device flow completes${pending ? ' after pending' : ''}`, async (t) => {
    let polls = 0;
    const api = await fakeApi(t, (req) => {
      if (req.path.endsWith('/auth/device')) return { body: deviceResponse };
      assert.equal(req.path, '/api/dshrem/v1/auth/token');
      assert.deepEqual(req.body, { device_code: deviceResponse.device_code });
      if (pending && ++polls === 1) return { status: 428, body: { error: { code: 'authorization_pending' } } };
      return { body: { access_token: credentials, expires_in: 3600 } };
    });
    let clock = 100000;
    const client = createClient({ base: api.base, now: () => clock, sleep: async (ms) => { clock += ms; } });
    const device = await client.startDeviceLogin();
    const saved = await client.pollDeviceLogin(device);
    assert.deepEqual(saved, { access_token: credentials, api_base: api.base, expires_at: new Date(clock + 3600000).toISOString() });
    assert.equal(api.requests.length, pending ? 3 : 2);
    assert.ok(api.requests.every((req) => req.authorization === undefined));
  });
}

test('device flow stops after denial', async (t) => {
  const api = await fakeApi(t, (req) => req.path.endsWith('/auth/device') ? { body: deviceResponse } : { status: 403, body: { error: { code: 'authorization_denied' } } });
  const client = createClient({ base: api.base, sleep: async () => {} });
  await assert.rejects(client.pollDeviceLogin(await client.startDeviceLogin()), { code: 'authorization_denied' });
  assert.equal(api.requests.length, 2);
});

test('device flow expires without sending a late poll', async (t) => {
  const api = await fakeApi(t, () => { throw new Error('No request expected'); });
  let clock = 0;
  const client = createClient({ base: api.base, now: () => clock, sleep: async (ms) => { clock += ms; } });
  await assert.rejects(client.pollDeviceLogin({ ...deviceResponse, expires_in: 1 }), { code: 'request_expired' });
  assert.equal(api.requests.length, 0);
});

test('ask sends one grant with string max_usd and one chat', async (t) => {
  const api = await fakeApi(t, (req) => ({ body: req.path.endsWith('/chat') ? { ...completed, task: completed } : { id: 'task-1' } }));
  const result = await createClient({ base: api.base }).ask({ ...question, title: 'Question', model: 'coding', mode: 'single', maxTokens: 123 });
  assert.deepEqual(api.requests.map(({ method, path }) => [method, path]), [
    ['POST', '/api/dshrem/v1/tasks'], ['POST', '/api/dshrem/v1/tasks/task-1/chat']
  ]);
  assert.deepEqual(api.requests[0].body, { title: 'Question', max_usd: '0.25', model: 'coding', mode: 'single', method: 'evidence-first', idempotency_key: 'stable-key' });
  assert.deepEqual(api.requests[1].body, { messages: question.messages, max_tokens: 123 });
  assert.ok(api.requests.every((req) => req.authorization === `Bearer ${credentials}`));
  assert.equal(result.task_id, 'task-1');
  assert.equal(result.answer, 'A useful answer.');
  assert.equal(result.spent_usd, '0.012');
  assert.equal(result.state.terminal, true);
  assert.equal(result.recovered, false);
});

for (const action of ['timeout', 'disconnect', 'invalid-json', 'http-error']) {
  test(`ambiguous chat ${action} is resolved with GET and no extra POSTs`, async (t) => {
    const api = await fakeApi(t, (req) => {
      if (req.path.endsWith('/chat')) {
        if (action === 'invalid-json') return { raw: '{broken' };
        if (action === 'http-error') return { status: 502, body: { message: credentials } };
        return { action };
      }
      return { body: req.method === 'POST' ? { id: 'task-1' } : completed };
    });
    const result = await createClient({ base: api.base, chatTimeoutMs: 250 }).ask(question);
    assert.equal(result.recovered, true);
    assert.equal(result.answer, 'A useful answer.');
    assert.equal(result.spent_usd, '0.012');
    assert.deepEqual(api.requests.map((req) => `${req.method} ${req.path}`), [
      'POST /api/dshrem/v1/tasks', 'POST /api/dshrem/v1/tasks/task-1/chat', 'GET /api/dshrem/v1/tasks/task-1'
    ]);
  });
}

for (const action of ['timeout', 'disconnect', 'invalid-json', 'http-error', 'missing-id']) {
  test(`ambiguous grant ${action} uses idempotency lookup without chat or repeat`, async (t) => {
    const api = await fakeApi(t, (req) => {
      if (req.method === 'GET') return { body: completed };
      if (action === 'invalid-json') return { raw: '{broken' };
      if (action === 'http-error') return { status: 502 };
      if (action === 'missing-id') return { body: {} };
      return { action };
    });
    const result = await createClient({ base: api.base, timeoutMs: 500 }).ask(question);
    assert.equal(result.task_id, 'task-1');
    assert.equal(result.recovered, true);
    assert.deepEqual(api.requests.map((req) => `${req.method} ${req.path}`), [
      'POST /api/dshrem/v1/tasks', 'GET /api/dshrem/v1/tasks/by-idempotency/stable-key'
    ]);
  });
}

test('failed grant lookup leaves an explicit unresolved error and never repeats POST', async (t) => {
  const api = await fakeApi(t, (req) => req.method === 'POST' ? { action: 'disconnect' } : { status: 404 });
  await assert.rejects(createClient({ base: api.base }).ask(question), (error) => error.code === 'unreachable' && error.message.includes('stable-key') && error.message.includes('No paid request was repeated'));
  assert.deepEqual(api.requests.map((req) => req.method), ['POST', 'GET']);
});

test('failed chat lookup preserves the task id and never repeats chat', async (t) => {
  const api = await fakeApi(t, (req) => req.path.endsWith('/chat') ? { action: 'disconnect' } : req.method === 'GET' ? { status: 503 } : { body: { id: 'task-1' } });
  await assert.rejects(createClient({ base: api.base }).ask(question), (error) => error.message.includes('task-1') && error.message.includes('No paid request was repeated'));
  assert.equal(api.requests.filter((req) => req.path.endsWith('/chat')).length, 1);
});

test('new turns have distinct idempotency keys', async (t) => {
  const api = await fakeApi(t, (req) => ({ body: req.path.endsWith('/chat') ? completed : { id: 'task-1' } }));
  const client = createClient({ base: api.base });
  const args = { ...question, idempotencyKey: undefined };
  await client.ask(args);
  await client.ask(args);
  const keys = api.requests.filter((req) => req.path.endsWith('/tasks')).map((req) => req.body.idempotency_key);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.ok(keys.every((key) => /^[0-9a-f-]{36}$/.test(key)));
});

test('request errors map unauthorized status without exposing private bodies', async (t) => {
  const api = await fakeApi(t, () => ({ status: 401, body: { error: { message: credentials } } }));
  await assert.rejects(createClient({ base: api.base }).account(credentials), (error) => error.code === 'unauthorized' && !error.message.includes(credentials) && error.message.includes('tvijo_login_start'));
});

test('unsafe API bases are rejected before fetch', () => {
  for (const base of ['http://example.com', 'https://user:password@example.com', 'https://example.com?secret=yes', 'https://example.com/#secret']) assert.throws(() => apiBase(base), { code: 'bad_api_base' });
  assert.equal(apiBase('http://127.0.0.1:123/'), 'http://127.0.0.1:123');
});

test('unresolved charges remain nonterminal even with completed status', () => {
  assert.deepEqual(taskStateOf({ status: 'completed', reason: 'charge_pending', spent_usd: '0.1' }), { status: 'completed', terminal: false, held: null, costKnown: false });
});
