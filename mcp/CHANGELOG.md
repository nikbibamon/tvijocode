# Changelog

## 0.2.1 — prepared 31 October 2026

Status: prepared; npm and MCP Registry publication are pending.

- Add `tvijo_wiki_search`, `tvijo_wiki_context`, `tvijo_catalog_search` and `tvijo_catalog_get` through the existing authenticated gateway.
- Keep the public Tvijo corpus fixed on the service; reject caller-selected URLs, corpus selectors and headers. Bound request payloads to 4 KiB and replies to 64 KiB.
- Preserve page revisions, projection hashes, source dates and untrusted-data markers. Propagate cancellation and make no automatic retries.
- Retain the 0.2.0 pre-merge diff review, spending caps, client tags and opt-in local evidence tools. Default discovery lists 11 tools; explicit local-report opt-in lists 14.

This package does not activate vendor connections or execute catalog actions.
