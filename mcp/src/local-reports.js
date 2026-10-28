import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import { ServiceError } from './client.js';

const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 15 * 60 * 1000;
const sensitive = /(?:password|passwd|secret|token|authorization|credential|api[-_]?key|bearer|private[-_]?key|\b(?:gh[pousr]_|sk-|AKIA|ASIA|eyJ))/i;
const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/).refine((value) => !sensitive.test(value));
const count = z.number().int().min(0).max(1_000_000_000);
const money = z.number().finite().min(0).max(1_000_000_000).nullable();
const asOf = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')).nullable();
const schemas = {
  repositories: z.strictObject({
    as_of: asOf,
    repositories: z.array(z.strictObject({ id, head: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/).nullable(),
      worktree: z.enum(['clean', 'dirty', 'unknown']), allowed: z.literal(true) })).max(100)
  }).refine((value) => new Set(value.repositories.map((repo) => repo.id)).size === value.repositories.length),
  tests: z.strictObject({
    as_of: asOf,
    results: z.array(z.strictObject({ repository: id, suite: id, status: z.enum(['PASS', 'FAIL', 'NOT_RUN']),
      passed: count, failed: count, skipped: count, not_run: count, total: count,
      duration_ms: count.nullable() }).refine((r) => r.total === r.passed + r.failed + r.skipped + r.not_run &&
        (r.status === 'PASS' ? r.failed === 0 && r.not_run === 0 && r.passed > 0 :
          r.status === 'FAIL' ? r.failed > 0 : r.passed === 0 && r.failed === 0 && r.not_run > 0))).max(100)
  }),
  budget: z.strictObject({
    as_of: asOf, accounting: z.enum(['known', 'unknown', 'frozen']), currency: z.literal('USD'),
    limit_usd: money, settled_usd: money, held_usd: money, available_usd: money,
    reason: z.enum(['none', 'uncertain_spend', 'unreconciled', 'unavailable'])
  }).refine((r) => {
    const values = [r.limit_usd, r.settled_usd, r.held_usd, r.available_usd];
    if (r.accounting === 'unknown') return values.every((v) => v === null) && r.reason !== 'none';
    if (r.accounting === 'frozen') return r.available_usd === null && ['uncertain_spend', 'unreconciled'].includes(r.reason);
    return r.as_of !== null && values.every((v) => v !== null) && r.reason === 'none' &&
      r.available_usd <= Math.max(0, r.limit_usd - r.settled_usd - r.held_usd) + 1e-9;
  })
};
const files = Object.freeze({ repositories: 'repositories.json', tests: 'test-results.json', budget: 'execution-budget.json' });
function refuse(code = 'invalid_local_snapshot') {
  return new ServiceError(code, 'Local report refused. Use an authorized regular snapshot with the documented schema and safe root.');
}

function rootParts(root) {
  if (typeof root !== 'string' || !isAbsolute(root) || root === '/' || root.includes('\\') || root.includes('\0')) throw refuse('invalid_local_report_root');
  const parts = root.slice(1).split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw refuse('invalid_local_report_root');
  return parts;
}

// Linux descriptor-relative traversal pins each parent and refuses ALL symlinks,
// including root ancestors. No lexical-prefix containment checks or shell calls.
async function openRoot(parts) {
  let current;
  try {
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    current = await open('/', flags);
    for (const part of parts) {
      const next = await open(`/proc/self/fd/${current.fd}/${part}`, flags);
      await current.close();
      current = next;
    }
    return current;
  } catch {
    await current?.close();
    throw refuse('invalid_local_report_root');
  }
}

async function readSnapshot(parts, filename) {
  const dir = await openRoot(parts);
  let file;
  try {
    file = await open(`/proc/self/fd/${dir.fd}/${filename}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_BYTES) throw refuse();
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length > MAX_BYTES || length !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw refuse();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)));
  } catch { throw refuse(); }
  finally { await file?.close(); await dir.close(); }
}

export function createLocalReports(env = process.env, now = () => Date.now()) {
  // A flag alone or a root alone cannot expose the tools.
  if (env.TVIJO_LOCAL_REPORTS !== '1' || !env.TVIJO_LOCAL_REPORT_ROOT) return null;
  const parts = rootParts(env.TVIJO_LOCAL_REPORT_ROOT);
  return {
    async read(kind, args = {}) {
      if (!Object.hasOwn(files, kind) || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length) throw refuse();
      const raw = await readSnapshot(parts, files[kind]);
      const parsed = schemas[kind].safeParse(raw);
      if (!parsed.success) throw refuse();
      const value = parsed.data;
      const current = now();
      if (!Number.isFinite(current) || (value.as_of !== null && Date.parse(value.as_of) > current)) throw refuse();
      const freshness = value.as_of === null ? 'unknown' : current - Date.parse(value.as_of) > MAX_AGE_MS ? 'stale' : 'fresh';
      // Parsed strict objects whitelist every field and type; no raw logs/errors.
      return { ...value, freshness, authority: 'evidence_only' };
    }
  };
}
