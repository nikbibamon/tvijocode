import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createClient, ServiceError } from './client.js';
import { createTokenStore } from './token-store.js';

// One source of truth: the publish workflow checks the tag against package.json.
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const MUTATING = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

export function spendingCap(env = process.env) {
  const raw = env.TVIJO_MAX_USD_CAP ?? '1';
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new ServiceError('invalid_cap', 'TVIJO_MAX_USD_CAP must be a positive finite number.');
  return Math.min(value, 5);
}

// All outputs pass through this boundary, including service JSON and error text.
export function createRedactor(initialSecrets = []) {
  const secrets = new Set(initialSecrets.filter((value) => typeof value === 'string' && value));
  function redact(value) {
    if (typeof value === 'string') {
      for (const secret of secrets) value = value.split(secret).join('[REDACTED]');
      return value;
    }
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [redact(key), /^(?:access_token|refresh_token|authorization|token)$/i.test(key) ? '[REDACTED]' : redact(child)]));
    return value;
  }
  return { add: (secret) => { if (typeof secret === 'string' && secret) secrets.add(secret); }, redact };
}

export function accountLabel(account) {
  const value = account?.label ?? account?.account?.label ?? account?.email ?? account?.account?.email ?? account?.id;
  return typeof value === 'string' || typeof value === 'number' ? String(value) : 'Tvijo account';
}

export function createMcpServer({ env = process.env, client = createClient({ base: env.TVIJO_API_BASE }), store = createTokenStore({ env }), now = () => Date.now() } = {}) {
  const server = new McpServer({ name: 'tvijo-dshrem-mcp', version: VERSION });
  const { add, redact } = createRedactor([env.TVIJO_TOKEN, env.TVIJO_TOKEN?.trim()]);
  let activeLogin;
  let polling = false;

  async function token() {
    const value = await store.get(client.base);
    add(value);
    return value;
  }
  function json(value) {
    const clean = redact(value);
    return { content: [{ type: 'text', text: JSON.stringify(clean, null, 2) }], structuredContent: clean && typeof clean === 'object' && !Array.isArray(clean) ? clean : { data: clean } };
  }
  function text(value) { return { content: [{ type: 'text', text: redact(value) }] }; }
  const guarded = (handler) => async (args, extra) => {
    try { return await handler(args, extra); }
    catch (error) {
      const message = error instanceof ServiceError ? `${error.code}: ${error.message}` : 'Tvijo operation failed. Check configuration and local token-file permissions.';
      return { ...text(message), isError: true };
    }
  };

  server.registerTool('tvijo_account', {
    description: 'Read your Tvijo account, balance and limits.', inputSchema: {}, annotations: READ_ONLY
  }, guarded(async () => json(await client.account(await token()))));

  server.registerTool('tvijo_ask', {
    description: 'Ask Tvijo DSHREM. This spends real money up to max_usd from your Tvijo account. Requires an explicit positive max_usd within the configured spending cap; paid requests are never retried.',
    inputSchema: {
      prompt: z.string().min(1).max(20000),
      max_usd: z.number().positive(),
      title: z.string().min(1).max(120).optional(),
      model: z.string().min(1).max(100).describe('Service model alias; default coding. Availability is determined by the service.').optional(),
      mode: z.string().min(1).max(100).describe('Service workflow mode; default single.').optional(),
      max_tokens: z.number().int().positive().max(2147483647).optional()
    }, annotations: MUTATING
  }, guarded(async (args, extra) => {
    const cap = spendingCap(env);
    if (args.max_usd > cap) throw new ServiceError('spending_cap', `max_usd exceeds the configured cap of ${cap} USD (hard ceiling 5 USD). No request was sent.`);
    return json(await client.ask({ token: await token(), maxUsd: args.max_usd, messages: [{ role: 'user', content: args.prompt }], title: args.title, model: args.model, mode: args.mode, maxTokens: args.max_tokens, signal: extra?.signal }));
  }));

  server.registerTool('tvijo_task_status', {
    description: 'Read the current status and spending of an existing Tvijo task.',
    inputSchema: { task_id: z.string().min(1).max(256) }, annotations: READ_ONLY
  }, guarded(async ({ task_id }) => json(await client.task(await token(), task_id))));

  server.registerTool('tvijo_cancel_task', {
    description: 'Cancel an existing Tvijo task. Cancellation may not undo money already spent.',
    inputSchema: { task_id: z.string().min(1).max(256) }, annotations: MUTATING
  }, guarded(async ({ task_id }) => json(await client.cancel(await token(), task_id))));

  server.registerTool('tvijo_login_start', {
    description: 'Begin device sign-in. Open the returned verification URL and approve the user code, then call tvijo_login_poll.',
    inputSchema: {}, annotations: MUTATING
  }, guarded(async () => {
    if (polling) throw new ServiceError('login_busy', 'A login poll is already in progress.');
    const device = await client.startDeviceLogin();
    const interval = Math.max(1, Number(device.interval) || 5) * 1000;
    activeLogin = { device, deadline: now() + Math.max(1, Number(device.expires_in) || 600) * 1000, interval, nextPoll: now() + interval };
    return json({ verification_uri: device.verification_uri, user_code: device.user_code, expires_in: device.expires_in ?? 600, interval: interval / 1000 });
  }));

  server.registerTool('tvijo_login_poll', {
    description: 'Complete device sign-in and save the token privately. Returns signed-in status, pending or denied; never returns a token. Omit device_code to use the most recent challenge.',
    inputSchema: { device_code: z.string().min(1).max(4096).optional() }, annotations: MUTATING
  }, guarded(async ({ device_code }, extra) => {
    if (polling) return text('pending');
    if (device_code && device_code !== activeLogin?.device.device_code) {
      activeLogin = { device: { device_code }, deadline: now() + 600_000, interval: 5000, nextPoll: now() };
    }
    if (!activeLogin) throw new ServiceError('no_device_login', 'Use tvijo_login_start first.');
    if (now() >= activeLogin.deadline) {
      activeLogin = undefined;
      throw new ServiceError('request_expired', 'Device authorization expired. Use tvijo_login_start again.');
    }
    if (now() < activeLogin.nextPoll) return text('pending');
    activeLogin.nextPoll = now() + activeLogin.interval;
    polling = true;
    try {
      const saved = await client.pollDeviceOnce(activeLogin.device, { signal: extra?.signal });
      add(saved.access_token);
      await store.save(saved);
      activeLogin = undefined;
      let label = 'Tvijo account';
      try { label = accountLabel(await client.account(saved.access_token)); } catch { /* Sign-in is saved even when the account endpoint is unavailable. */ }
      return text(`signed in as ${label}`);
    } catch (error) {
      if (error.code === 'authorization_pending') return text('pending');
      if (error.code === 'authorization_denied') { activeLogin = undefined; return text('denied'); }
      if (error.code === 'request_expired') activeLogin = undefined;
      throw error;
    } finally { polling = false; }
  }));

  return server;
}

export async function startStdioServer(options) {
  const server = createMcpServer(options);
  await server.connect(new StdioServerTransport());
  return server;
}
