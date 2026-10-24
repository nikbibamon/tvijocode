import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createTokenStore } from '../src/token-store.js';
import { temporaryDirectory } from './helpers/fake-api.mjs';

const base = 'http://127.0.0.1:123/api/dshrem/v1';
const saved = { access_token: 'fake-saved-token', expires_at: '2099-01-01T00:00:00.000Z', api_base: base };

test('token store writes 0600 file in 0700 directory atomically', async () => {
  const file = join(await temporaryDirectory(), 'tvijo', 'mcp-token.json');
  const store = createTokenStore({ env: {}, file });
  await store.save({ ...saved, ignored: 'not persisted' });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), saved);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(dirname(file))).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dirname(file)), ['mcp-token.json']);
  assert.equal(await store.get(base), saved.access_token);
  await store.save({ ...saved, access_token: 'rotated-fake-token' });
  assert.equal(await store.get(base), 'rotated-fake-token');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('environment token has precedence even when the file is absent', async () => {
  const file = join(await temporaryDirectory(), 'absent.json');
  const store = createTokenStore({ env: { TVIJO_TOKEN: ' env-fake-token ' }, file });
  assert.equal(await store.get(base), 'env-fake-token');
});

test('missing, expired or different-base saved tokens require sign-in', async () => {
  const file = join(await temporaryDirectory(), 'tvijo', 'mcp-token.json');
  const store = createTokenStore({ env: {}, file });
  await assert.rejects(store.get(base), { code: 'unauthorized' });
  await store.save(saved);
  await assert.rejects(store.get('http://127.0.0.1:456'), { code: 'unauthorized' });
  await store.save({ ...saved, expires_at: '2000-01-01T00:00:00Z' });
  await assert.rejects(store.get(base), (error) => error.code === 'unauthorized' && error.message.includes('npx tvijo-dshrem-mcp login'));
});

test('logout removes saved token and is safe when it is already absent', async () => {
  const file = join(await temporaryDirectory(), 'tvijo', 'mcp-token.json');
  const store = createTokenStore({ env: {}, file });
  await store.save(saved);
  await store.remove();
  await store.remove();
  assert.equal(await store.read(), null);
});
