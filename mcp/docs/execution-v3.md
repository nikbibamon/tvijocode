# Scoped execution tools — candidate, not released

Requested GPT-6.1 Sol; served model unknown. Programme TVIJO-PROGRAMME-V3-20261110, 10 November 2026.

`TVIJO_EXECUTION_ROUTES=1` enables a bounded canary in the existing customer service-token MCP client. The default is off. Existing login/token storage and output redaction remain in use. This does not expand the separate public RemDesk OAuth `mcp:read` grant or its file-only tool allowlist.

Quote/submission tools also require an explicit positive integer `TVIJO_MAX_MICRO_TVIJO` (at most50000000). Missing or insufficient service-unit authority refuses before HTTP. This is a service-credit cap, not a conversion of the legacy `TVIJO_MAX_USD_CAP` or a provider invoice guarantee. No provider/model request is sent by these tools.

The added tools list capabilities, create a project/thread-bound quote, reserve that saved quote, fetch a receipt, and reconnect through a read-only lookup. The existing `tvijo_cancel_task` remains the cancellation entry. Reservation and cancellation require the server's existing task permissions; a model or tool description cannot grant them. Quote creation neither reserves a task nor invokes a model. Submission may reserve customer service credit but sends no model call. It does not imply independent acceptance. There is no automatic paid fallback or new subscription proxy.

The service remains authoritative for quote issuer, project membership, key scope/revocation, expiry, credit reservation and idempotency. A local projection hash detects accidental changes and is not a signature or an authorization credential. Service credits (`micro_tvijo`) and provider/invoice USD are separate fields. Unknown invoice, provider cost, actual model identity and runtime ACK are not converted to zero or success.

After an ambiguous submission, only the same idempotency lookup and task read occur. Reconnect does not resume execution. Actual interrupted-runtime resume is unavailable in this client until the existing executor supplies a fenced, authorized resume mechanism. Cancellation cannot refund a provider call already sent.

The execution canary accepts only the fixed Tvijo service resource. A loopback constructor option exists solely for isolated tests and is not exposed in tool arguments or environment configuration. The server still owns provider endpoint allowlists. Customer-local BYOK and subscription credentials are not uploaded by these tools. Existing managed BYOK facilities require their separate connection consent, credential reference, rotation/revocation and live validation; this managed-service-only canary does not claim that workflow.

Validation, independent review and an actual customer workflow are separate gates. A fixture transport pass is not a production or model-quality claim. No VSIX/npm release or public deployment is implied by this source candidate.
