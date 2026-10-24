import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ServiceError, apiBase } from './client.js';

export const SIGN_IN_MESSAGE = 'Not signed in. Run npx tvijo-dshrem-mcp login or use tvijo_login_start.';

export function createTokenStore({ env = process.env, file = join(homedir(), '.config', 'tvijo', 'mcp-token.json'), now = () => Date.now() } = {}) {
  async function read() {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new ServiceError('token_store', 'Could not read the saved sign-in. Run npx tvijo-dshrem-mcp login.');
    }
  }

  async function get(base) {
    if (env.TVIJO_TOKEN?.trim()) return env.TVIJO_TOKEN.trim();
    const saved = await read();
    if (!saved || typeof saved.access_token !== 'string' || !saved.access_token || saved.api_base !== apiBase(base) || !Number.isFinite(Date.parse(saved.expires_at)) || Date.parse(saved.expires_at) <= now()) {
      throw new ServiceError('unauthorized', SIGN_IN_MESSAGE);
    }
    return saved.access_token;
  }

  async function save(value) {
    if (typeof value.access_token !== 'string' || !value.access_token || !Number.isFinite(Date.parse(value.expires_at))) throw new ServiceError('token_store', 'Cannot save an incomplete sign-in.');
    const record = { access_token: value.access_token, expires_at: value.expires_at, api_base: apiBase(value.api_base) };
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await chmod(dirname(file), 0o700);
    const temporary = `${file}.${randomUUID()}.tmp`;
    let handle;
    let created = false;
    try {
      handle = await open(temporary, 'wx', 0o600);
      created = true;
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
    } finally {
      await handle?.close();
      if (created) await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async function remove() {
    await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }

  return { file, read, get, save, remove };
}
