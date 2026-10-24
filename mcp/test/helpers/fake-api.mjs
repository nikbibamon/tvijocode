import { createServer } from 'node:http';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export const packageDir = fileURLToPath(new URL('../../', import.meta.url));

export async function temporaryDirectory() {
  const parent = join(packageDir, '.test-tmp');
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, 'run-'));
}

export async function fakeApi(t, handler) {
  const requests = [];
  const errors = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      const request = { method: req.method, path: req.url, authorization: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined };
      requests.push(request);
      const result = await handler(request, requests);
      if (result?.action === 'timeout') return;
      if (result?.action === 'disconnect') { req.socket.destroy(); return; }
      res.writeHead(result?.status ?? 200, { 'content-type': 'application/json', ...result?.headers });
      res.end(result?.raw ?? JSON.stringify(result?.body ?? {}));
    } catch (error) {
      errors.push(error);
      res.writeHead(500);
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  return { base: `http://127.0.0.1:${server.address().port}/api/dshrem/v1`, requests };
}

export const deviceResponse = { device_code: 'private-device-code', user_code: 'ABCD-EFGH', verification_uri: 'https://example.invalid/device', interval: 1, expires_in: 600 };
export const completed = { id: 'task-1', status: 'completed', spent_usd: '0.012', held_usd: '0', choices: [{ message: { content: 'A useful answer.' } }] };
