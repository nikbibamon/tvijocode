import { randomUUID } from 'node:crypto';
import { clientTag } from './client-tag.js';

export const DEFAULT_API_BASE = 'https://dsh.tvijo.com/api/dshrem/v1';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const KNOWLEDGE_KEYS = {
  wiki_search: ['query', 'limit', 'lang'], wiki_context: ['key', 'expect_sha256', 'max_tokens'],
  catalog_search: ['query', 'limit', 'category'], catalog_get: ['slug']
};
const SHA256 = /^[a-f0-9]{64}$/;
const isSha256 = (value) => typeof value === 'string' && value.length === 64 && SHA256.test(value);
function knowledgeArguments(name, args) {
  const keys = Object.hasOwn(KNOWLEDGE_KEYS, name) ? KNOWLEDGE_KEYS[name] : undefined;
  const fail = () => { throw new ServiceError('invalid_knowledge_arguments', 'Invalid public knowledge tool arguments.'); };
  if (!keys || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some((key) => !keys.includes(key))) fail();
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > 4096) fail();
  const text = (key, max) => {
    const value = args[key];
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) fail();
  };
  const integer = (key, low, high) => {
    if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < low || args[key] > high)) fail();
  };
  if (name.endsWith('_search')) {
    text('query', 200); integer('limit', 1, 10);
    if (name === 'wiki_search' && args.lang !== undefined && !['en', 'ru'].includes(args.lang)) fail();
    if (args.category !== undefined) text('category', 100);
  } else if (name === 'wiki_context') {
    text('key', 160); text('expect_sha256', 64); integer('max_tokens', 100, 2000);
    if (!/^[a-z0-9]+(?:[-/][a-z0-9]+)*$/.test(args.key) || !isSha256(args.expect_sha256)) fail();
  } else {
    text('slug', 81);
    if (!/^[a-z0-9][a-z0-9-]{0,80}$/.test(args.slug)) fail();
  }
}
function publicWikiPointer(pointer) {
  return pointer && isSha256(pointer.sha256) && typeof pointer.url === 'string'
    && /^https:\/\/tvijo\.com\/wiki\/[a-z0-9]+(?:[-/][a-z0-9]+)*\/$/.test(pointer.url);
}
const TERMINAL = new Set(['completed', 'complete', 'succeeded', 'failed', 'cancelled', 'canceled', 'expired']);
const HTTP_ERRORS = {
  400: ['bad_request', 'The service refused the request as invalid.'],
  401: ['unauthorized', 'Sign-in is required or has expired. Run npx tvijo-dshrem-mcp login or use tvijo_login_start.'],
  402: ['insufficient_credit', 'The account has no available credit for a new task.'],
  403: ['authorization_denied', 'Authorization was denied by the account owner.'],
  409: ['conflict', 'The task grant expired or the service restarted. Check the task before asking again.'],
  410: ['request_expired', 'The authorization request or task has expired.'],
  413: ['context_limit', 'The question is too large for one task.'],
  428: ['authorization_pending', 'Authorization is still pending.'],
  429: ['rate_limited', 'The service rate limit was reached. No retry was attempted.']
};
const REFUSAL_MESSAGES = {
  preview_context_limit: 'This request exceeds the remaining preview token allowance. Reduce the prompt or output limit.',
  charge_pending: 'The task has an unresolved charge. Check the task before sending another request; no automatic retry was made.',
  model_request_failed: 'The model request failed. Check the task result and spending before sending again.',
  usage_recovery_unavailable: 'Usage could not be verified. The task remains held for reconciliation; no automatic retry was made.',
  usage_reconciliation_required: 'Task usage needs reconciliation. Check the task before sending another request.',
  previous_task_not_settled: 'Another task on this account is unresolved. Inspect its status and spending.',
  preview_choose_flash_or_devstral: 'Choose an available preview model.',
  free_preview_exhausted: 'The free preview has ended. Review account credit terms.',
  operator_allowance_exhausted: 'The account total allowance or daily limit is exhausted. Check account usage. A total allowance does not renew automatically.',
  credits_or_daily_cap_exhausted: 'The credit or daily account limit is exhausted. Review usage and limits.',
  insufficient_credit: 'Available credit cannot cover this task reservation.',
  preview_daily_pool_exhausted: 'The shared daily preview allowance is exhausted. No task was created.',
  model_unavailable: 'The selected model is unavailable. Choose an activated model.',
  council_route_unavailable: 'A council model is unavailable. Choose a supported workflow.'
};

export class ServiceError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'ServiceError';
    this.code = code;
    this.status = status;
  }
}

export function apiBase(value) {
  const raw = (value || '').trim() || DEFAULT_API_BASE;
  let parsed;
  try { parsed = new URL(raw); } catch { throw new ServiceError('bad_api_base', 'TVIJO_API_BASE must be an HTTPS URL.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) throw new ServiceError('bad_api_base', 'TVIJO_API_BASE must use HTTPS (HTTP only for localhost).');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new ServiceError('bad_api_base', 'TVIJO_API_BASE cannot contain credentials, query or fragment.');
  return parsed.toString().replace(/\/$/, '');
}

async function readBounded(response, maximum = MAX_RESPONSE_BYTES) {
  const message = `Service response exceeded ${maximum === MAX_RESPONSE_BYTES ? '2 MiB' : '64 KiB'}.`;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel();
    throw new ServiceError('oversized', message);
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new ServiceError('oversized', message);
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks, size).toString('utf8');
  if (!text) return null;
  try { return JSON.parse(text); } catch { throw new ServiceError('invalid_json', 'Service returned invalid JSON.'); }
}

export function taskStateOf(snapshot) {
  const rawCost = snapshot?.budget?.spent_usd ?? snapshot?.task?.budget?.spent_usd ?? snapshot?.spent_usd ?? snapshot?.task?.spent_usd;
  const debited = snapshot?.receipt?.debited_micro_tvijo ?? snapshot?.task?.receipt?.debited_micro_tvijo;
  const costKnown = ((typeof rawCost === 'number' || (typeof rawCost === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rawCost))) && Number.isFinite(Number(rawCost)) && Number(rawCost) >= 0) || (Number.isSafeInteger(debited) && debited >= 0);
  const status = String(snapshot?.status ?? snapshot?.task?.status ?? '').toLowerCase();
  if (['usage_unknown', 'charge_pending', 'usage_reconciliation_required', 'usage_recovery_unavailable'].includes(snapshot?.reason ?? snapshot?.task?.reason)) return { status, terminal: false, held: null, costKnown: false };
  if ((snapshot?.byok || snapshot?.task?.byok)?.provider_cost_status === 'unknown') return { status, terminal: false, held: null };
  const serviceHeld = snapshot?.receipt?.held_micro_tvijo ?? snapshot?.task?.receipt?.held_micro_tvijo;
  if (serviceHeld !== undefined) return { status, costKnown, terminal: TERMINAL.has(status), held: Number.isSafeInteger(serviceHeld) && serviceHeld >= 0 ? serviceHeld / 1000000 : null, heldUnit: 'TT' };
  const heldValue = snapshot?.held_usd ?? snapshot?.task?.held_usd ?? snapshot?.budget?.held_usd ?? snapshot?.task?.budget?.held_usd;
  const validHeld = typeof heldValue === 'number' || (typeof heldValue === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(heldValue));
  const held = validHeld ? Number(heldValue) : null;
  return { status, costKnown, terminal: TERMINAL.has(status), held: Number.isFinite(held) ? held : null };
}

function answerOf(taskId, response, recovered = false) {
  const content = response?.choices?.[0]?.message?.content;
  return {
    task_id: taskId,
    answer: typeof content === 'string' ? content : null,
    spent_usd: response?.task?.spent_usd ?? response?.task?.budget?.spent_usd ?? response?.spent_usd ?? response?.budget?.spent_usd ?? null,
    state: taskStateOf(response),
    usage: response?.usage ?? null,
    cost: response?.task ?? null,
    recovered,
    ...(recovered ? { notice: 'Recovered by a read-only lookup. No paid request was repeated. Check task status before sending another request.' } : {})
  };
}

export function createClient({ base = process.env.TVIJO_API_BASE, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now = () => Date.now(), timeoutMs = 30_000, chatTimeoutMs = 210_000 } = {}) {
  const root = apiBase(base);
  let clientName = () => undefined;

  async function request(path, { token, method = 'GET', body, signal, offer = 'none', timeoutMs: limit = timeoutMs, maxResponseBytes = MAX_RESPONSE_BYTES } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), limit);
    const relay = () => controller.abort();
    if (signal) { if (signal.aborted) relay(); else signal.addEventListener('abort', relay, { once: true }); }
    try {
      const response = await fetchImpl(root + path, {
        method,
        headers: { 'X-Tvijo-Client': clientTag(clientName(), offer), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
        redirect: 'error'
      });
      if (!response.ok) {
        // Never expose a raw error body: it may echo credentials or private prompts.
        const [code, message] = HTTP_ERRORS[response.status] || ['remote_http_error', `Service returned HTTP ${response.status}.`];
        let serverCode;
        try {
          const value = await readBounded(response, maxResponseBytes);
          if (typeof value?.error?.code === 'string' && Object.hasOwn(REFUSAL_MESSAGES, value.error.code)) serverCode = value.error.code;
        } catch { /* An unreadable error remains ambiguous. */ }
        throw new ServiceError(serverCode || code, REFUSAL_MESSAGES[serverCode] || message, response.status);
      }
      return response.status === 204 ? null : await readBounded(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof ServiceError) throw error;
      if (signal?.aborted) throw new ServiceError('interrupted', 'Request was cancelled.');
      if (controller.signal.aborted) throw new ServiceError('timeout', `Request timed out after ${Math.round(limit / 1000)} s.`);
      throw new ServiceError('unreachable', 'Could not read the service response.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', relay);
    }
  }

  async function startDeviceLogin() {
    const device = await request('/auth/device', { method: 'POST', body: {} });
    if (!device?.device_code || !device?.user_code || !device?.verification_uri) throw new ServiceError('incomplete', 'Service returned an incomplete device authorization.');
    return device;
  }

  async function pollDeviceOnce(device, { signal } = {}) {
    const token = await request('/auth/token', { method: 'POST', body: { device_code: device.device_code }, signal });
    if (typeof token?.access_token !== 'string' || !token.access_token) throw new ServiceError('incomplete', 'Service returned an incomplete login response.');
    return { access_token: token.access_token, expires_at: new Date(now() + (Number(token.expires_in) || 3600) * 1000).toISOString(), api_base: root };
  }

  async function pollDeviceLogin(device, { signal } = {}) {
    const interval = Math.max(1, Number(device.interval) || 5) * 1000;
    const deadline = now() + Math.max(1, Number(device.expires_in) || 600) * 1000;
    while (now() < deadline) {
      if (signal?.aborted) throw new ServiceError('interrupted', 'Sign-in was cancelled.');
      await sleep(interval);
      if (now() >= deadline) break;
      try { return await pollDeviceOnce(device, { signal }); }
      catch (error) { if (error.code !== 'authorization_pending') throw error; }
    }
    throw new ServiceError('request_expired', 'Device authorization expired. Sign in again.');
  }

  async function task(token, taskId, offer = 'none') {
    const snapshot = await request(`/tasks/${encodeURIComponent(taskId)}`, { token, offer });
    if (!snapshot || (snapshot.id && snapshot.id !== taskId) || (snapshot.task?.id && snapshot.task.id !== taskId)) throw new ServiceError('incomplete', 'Task response identity mismatch.');
    return snapshot;
  }

  async function knowledge(token, name, args, { signal } = {}) {
    knowledgeArguments(name, args);
    let reply;
    try {
      reply = await request(`/knowledge/tools/${name}`, {
        token, method: 'POST', body: args, signal, maxResponseBytes: 64 * 1024
      });
    } catch (error) {
      if (error.status === 409) throw new ServiceError('stale_wiki_revision', 'Wiki revision changed. Search again before requesting context.', 409);
      if (error.status === 503) throw new ServiceError('knowledge_unavailable', 'Public knowledge is unavailable. No retry was attempted.', 503);
      throw error;
    }
    const data = reply?.data;
    const invalid = () => { throw new ServiceError('invalid_knowledge_response', 'Service returned an invalid public knowledge response.'); };
    if (reply?.tool !== name || reply?.untrusted !== true || !data || typeof data !== 'object' || Array.isArray(data)) invalid();
    if (name.startsWith('wiki_')) {
      if (data.source?.corpus !== 'tvijo') invalid();
      if (name === 'wiki_search') {
        if (!Array.isArray(data.items) || !data.items.every(publicWikiPointer)) invalid();
      } else if (data.pointer?.corpus !== 'tvijo' || !publicWikiPointer(data.pointer)
                 || data.pointer.sha256 !== args.expect_sha256 || typeof data.text !== 'string') invalid();
    } else if (!isSha256(data.projection_sha256) || typeof data.as_of !== 'string'
               || typeof data.rank_definition !== 'string') invalid();
    return reply; // Structured, untrusted data; never injected into a system prompt.
  }

  async function ask({ maxUsd = 1, token, messages, idempotencyKey = randomUUID(), title = 'MCP', maxTokens = 2048, model = 'coding', mode = 'single', method = 'evidence-first', signal, offer = 'ask', lookupOnTimeoutOnly = false }) {
    if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new ServiceError('invalid_amount', 'max_usd must be a positive finite number.');
    if (!Array.isArray(messages) || messages.length < 1 || messages.length > 80) throw new ServiceError('invalid_messages', 'Conversation must have 1-80 messages.');
    if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > 110 * 1024) throw new ServiceError('context_limit', 'Conversation exceeds the per-task context bound.');
    let grant;
    try {
      grant = await request('/tasks', { method: 'POST', token, signal, offer, body: { title: title.slice(0, 120), max_usd: String(maxUsd), model, mode, method, idempotency_key: idempotencyKey } });
      if (!grant?.id) throw new ServiceError('incomplete', 'Service returned a task without an id.');
    } catch (error) {
      // Even HTTP failures can be ambiguous. Only GET is allowed after dispatch.
      if (lookupOnTimeoutOnly && error.code !== 'timeout') throw new ServiceError(error.code, `${error.message} Idempotency key: ${idempotencyKey}. No paid request was repeated; inspect this key before asking again.`, error.status);
      try {
        const recovered = await request(`/tasks/by-idempotency/${encodeURIComponent(idempotencyKey)}`, { token, offer });
        if (!recovered?.id) throw new ServiceError('incomplete', 'Lookup returned no task id.');
        return answerOf(recovered.id, recovered, true);
      } catch {
        throw new ServiceError(error.code, `${error.message} Task creation could not be resolved. Idempotency key: ${idempotencyKey}. No paid request was repeated; inspect this key before asking again.`, error.status);
      }
    }
    try {
      const response = await request(`/tasks/${encodeURIComponent(grant.id)}/chat`, { method: 'POST', token, signal, offer, timeoutMs: chatTimeoutMs, body: { messages, max_tokens: maxTokens } });
      if (typeof response?.choices?.[0]?.message?.content !== 'string') throw new ServiceError('no_output', 'Service returned no assistant text.');
      return answerOf(grant.id, response);
    } catch (error) {
      if (lookupOnTimeoutOnly && error.code !== 'timeout') throw new ServiceError(error.code, `${error.message} Check task ${grant.id} with tvijo_task_status. No paid request was repeated.`, error.status);
      try { return answerOf(grant.id, await task(token, grant.id, offer), true); }
      catch { throw new ServiceError(error.code, `${error.message} Check task ${grant.id} with tvijo_task_status. No paid request was repeated.`, error.status); }
    }
  }

  return {
    setClientNameProvider: (provider) => { clientName = provider; },
    base: root, request, startDeviceLogin, pollDeviceOnce, pollDeviceLogin, ask, task, knowledge,
    taskState: async (token, taskId) => taskStateOf(await task(token, taskId)),
    lookupGrant: (token, key) => request(`/tasks/by-idempotency/${encodeURIComponent(key)}`, { token }),
    cancel: (token, taskId) => request(`/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', token }),
    account: (token) => request('/account', { token }),
    logout: (token) => request('/auth/logout', { method: 'POST', token })
  };
}
