// Existing customer service protocol. This module does not grant permissions,
// invoke a model, retry execution, or widen the public RemDesk mcp:read grant.
import { createHash } from 'node:crypto';
import { ServiceError } from './client.js';

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const RESOURCE = 'https://dsh.tvijo.com/api/dshrem/v1';
const UNKNOWN = new Set(['usage_unknown', 'charge_pending', 'usage_reconciliation_required', 'usage_recovery_unavailable']);
const STATES = new Set(['issued', 'running', 'completed', 'failed', 'cancelled', 'frozen', 'unknown', 'expired']);
const SETTLED_STATES = new Set(['completed', 'failed', 'cancelled', 'expired']);
const COST_STATUS = new Set(['reported', 'estimated']);
const COST_PROVENANCE = new Map([['provider:cost', 'reported'], ['provider:total_cost', 'reported'],
  ['provider:estimated_cost', 'estimated'], ['provider_rejected', 'reported']]);
// service_ledger.tariff emits pilot- + the first20 hex digits of its body hash.
const TARIFF = /^pilot-[a-f0-9]{20}$/;
const validId = value => typeof value === 'string' && ID.test(value) && !/[\r\n]/.test(value);
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const ident = value => {
  if (!validId(value)) throw new ServiceError('invalid_identity', 'A bounded service identifier is required.');
  return value;
};
const money = value => typeof value === 'string' && value.length <= 64 && !/\s/.test(value)
  && /^(?:0|[1-9]\d{0,19})(?:\.\d{1,28})?$/.test(value) ? value : null;
const micro = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function evidenceProjection(snapshot, projectId) {
  ident(projectId);
  if (!snapshot || snapshot.project_id !== projectId) throw new ServiceError('project_mismatch', 'The service did not confirm this task project.');
  const id = ident(snapshot.id);
  const costStatus = snapshot.byok?.provider_cost_status;
  const costSource = snapshot.byok?.provider_cost_source;
  const provenance = COST_STATUS.has(costStatus) && COST_PROVENANCE.get(costSource) === costStatus;
  const uncertain = UNKNOWN.has(snapshot.reason) || !SETTLED_STATES.has(snapshot.status) || !provenance;
  let providerCost = uncertain ? null : money(snapshot.byok?.provider_cost_usd);
  // An estimated zero is not an attested no-charge result. Keep all original
  // records, but require reported provenance before displaying a known zero.
  if (providerCost !== null && /^0(?:\.0+)?$/.test(providerCost) && costStatus !== 'reported') providerCost = null;
  if (providerCost !== null && costSource === 'provider_rejected' && !/^0(?:\.0+)?$/.test(providerCost)) providerCost = null;
  const receipt = snapshot.receipt || {};
  return {
    schema: 'tvijo.execution.evidence/1', task_id: id, project_id: projectId,
    status: STATES.has(snapshot.status) ? snapshot.status : 'unknown',
    cost: {
      // Service credits and the customer's provider invoice are different units.
      service_unit: 'micro_tvijo', debited: micro(receipt.debited_micro_tvijo), held: micro(receipt.held_micro_tvijo),
      provider_usd: providerCost,
      provider_cost_status: providerCost === null ? 'unknown' : costStatus,
      provider_cost_source: provenance ? costSource : null,
      invoice_usd: null,
    },
    verification: { status: 'not_independently_verified', reviewer: null },
    runtime_ack: 'UNKNOWN',
    source: { resource: RESOURCE, transport: 'authenticated_service_task_read', task_id: id },
  };
}

export function createExecutionClient(api, { now = () => Date.now(), allowLocalTest = false } = {}) {
  const base = new URL(api.base);
  const local = allowLocalTest && base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname);
  if (api.base !== RESOURCE && !local) throw new ServiceError('execution_endpoint_refused', 'Execution tools require the configured Tvijo service resource.');
  async function inspect(token, taskId, projectId) {
    const value = await api.request('/tasks/' + ident(taskId), { token });
    if (value?.id !== taskId || value.project_id !== ident(projectId)) throw new ServiceError('project_mismatch', 'The service did not confirm this task project.');
    return evidenceProjection(value, projectId);
  }
  function validateQuote(quote) {
    if (!quote || quote.resource !== api.base || !validId(quote.quote_id) || !validId(quote.project_id)
        || !validId(quote.thread_id) || !validId(quote.idempotency_key)
        || quote.service_id !== 'standard' || !Number.isSafeInteger(quote.ceiling_micro_tvijo)
        || quote.ceiling_micro_tvijo <= 0 || quote.ceiling_micro_tvijo > 50000000
        || !Number.isFinite(quote.expires_at_ms) || quote.expires_at_ms <= now()
        || quote.execution_authorized !== false || typeof quote.tariff_version !== 'string'
        || quote.tariff_version.length !== 26 || !TARIFF.test(quote.tariff_version)
        || quote.projection_sha256 !== sha(quote.projection)) {
      throw new ServiceError('quote_unavailable', 'The saved quote is invalid or expired. No task was reserved.');
    }
    for (const key of ['quote_id', 'project_id', 'thread_id', 'service_id', 'tariff_version', 'ceiling_micro_tvijo', 'resource', 'idempotency_key', 'expires_at_ms']) {
      if (quote[key] !== quote.projection[key]) throw new ServiceError('quote_changed', 'The saved quote binding changed.');
    }
    return quote;
  }
  return {
    async capabilities(token) {
      const value = await api.request('/services', { token });
      return { resource: api.base, services: value, route_policy: 'existing_service_quote',
        quote_is_authorization: false, automatic_paid_fallback: false,
        model_execution: 'requires_existing_task_authorization', execution_resume: 'unavailable',
        subscription_customer_proxy: 'unavailable', runtime_ack: 'UNKNOWN' };
    },
    async quote(token, args) {
      for (const key of ['project_id', 'thread_id', 'idempotency_key']) ident(args[key]);
      if (!Number.isSafeInteger(args.max_micro_tvijo) || args.max_micro_tvijo <= 0 || args.max_micro_tvijo > 50000000
          || typeof args.prompt !== 'string' || !args.prompt || Buffer.byteLength(args.prompt) > 20000) {
        throw new ServiceError('invalid_quote_request', 'A bounded prompt and explicit positive service-unit ceiling are required.');
      }
      const value = await api.request('/services/quote', { token, method: 'POST', body: {
        service_id: 'standard', project_id: args.project_id, thread_id: args.thread_id,
        idempotency_key: args.idempotency_key, title: 'MCP execution quote',
        messages: [{ role: 'user', content: args.prompt }], max_tokens: 2048,
        method: 'evidence-first', max_micro_tvijo: args.max_micro_tvijo,
      } });
      const expiry = typeof value?.expires_at === 'number' ? value.expires_at * 1000 : Date.parse(value?.expires_at);
      if (value?.project_id !== args.project_id || value?.thread_id !== args.thread_id || value?.billing_mode === 'byok'
          || value?.ceiling_micro_tvijo > args.max_micro_tvijo) throw new ServiceError('invalid_quote_response', 'The service quote scope or payer did not match.');
      const projection = Object.fromEntries(['quote_id', 'project_id', 'thread_id', 'service_id', 'tariff_version', 'ceiling_micro_tvijo'].map(key => [key, value[key]]));
      Object.assign(projection, { resource: api.base, idempotency_key: args.idempotency_key, expires_at_ms: expiry });
      const quote = { ...projection,
        projection, projection_sha256: sha(projection), execution_authorized: false,
        uncertainty: 'ceiling_is_not_actual_provider_or_invoice_cost' };
      return validateQuote(quote);
    },
    async submit(token, quote) {
      validateQuote(quote);
      try {
        const value = await api.request('/tasks', { token, method: 'POST', body: {
          quote_id: quote.quote_id, service_id: quote.service_id, idempotency_key: quote.idempotency_key,
        } });
        return { ...await inspect(token, ident(value?.id), quote.project_id), recovered: false, model_request_sent: false };
      } catch (error) {
        // A network/local failure cannot establish whether reservation committed.
        // Read the same identity, never issue another POST or fresh quote.
        try {
          const value = await api.request('/tasks/by-idempotency/' + quote.idempotency_key, { token });
          return { ...await inspect(token, ident(value?.id), quote.project_id), recovered: true, model_request_sent: false };
        } catch {
          throw new ServiceError('submission_unknown', 'Reservation outcome is unknown. Inspect the same idempotency key; no model request or paid retry was sent.');
        }
      }
    },
    inspect,
    reconnect: async (token, taskId, projectId) => ({ ...await inspect(token, taskId, projectId), reconnect: 'read_only', execution_repeated: false }),
    async cancel(token, taskId, projectId) {
      await inspect(token, taskId, projectId);
      await api.request('/tasks/' + ident(taskId) + '/cancel', { token, method: 'POST' });
      return inspect(token, taskId, projectId);
    },
  };
}
