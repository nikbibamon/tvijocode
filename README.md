# Tvijo Code

Tvijo Code is a code editor built from the open-source VS Code sources (Code - OSS),
with the [Tvijo DSHREM](https://dsh.tvijo.com) extension built in.

> **A funded Tvijo account is required for paid MCP tasks.** The MIT-licensed
> `tvijo-dshrem-mcp` client is free to install, but `tvijo_ask` and `tvijo_review`
> spend real money from your Tvijo balance or credits, up to the explicit
> per-call `max_usd`. Read-only tools require a signed-in Tvijo account and spend
> nothing.

It is built by this repository's GitHub Actions from the official `microsoft/vscode` tag,
using the [VSCodium](https://github.com/VSCodium/vscodium) build scripts:

- Microsoft telemetry is removed at build time (VSCodium patches).
- Extensions come from [Open VSX](https://open-vsx.org), not the Microsoft Marketplace.
- Auto-update is off; new versions are published on the [Releases](https://github.com/nikbibamon/tvijocode/releases) page.
- The Tvijo DSHREM extension is embedded as a built-in at a pinned version and SHA-256
  ([`tvijo/extensions.lock.json`](tvijo/extensions.lock.json)).

This repository also hosts the **Tvijo DSHREM MCP server** in [`mcp/`](mcp/)
(`npm i -g tvijo-dshrem-mcp`, registry name `com.tvijo/dshrem`) — see
[Tvijo DSHREM MCP server](#tvijo-dshrem-mcp-server) below.

## Tvijo DSHREM MCP server

The server in [`mcp/`](mcp/) is published to npm as `tvijo-dshrem-mcp`
(MIT, Node.js 20+, stdio transport) and to the open MCP Registry as
`com.tvijo/dshrem`. This repository is its single source; the npm package is
built from this directory, not from a second copy.

It lets an MCP client — VS Code, Claude Code, Codex, Cursor or any other stdio
client — run a bounded Tvijo task, review a pre-merge diff, and read account and
task state without leaving the chat. Every paid call carries an explicit
spending limit.

### Capabilities

| Tool | Kind | What it does |
| --- | --- | --- |
| `tvijo_ask` | paid, capped | Ask Tvijo DSHREM; spends at most an explicit `max_usd`. |
| `tvijo_review` | paid, capped | Review a supplied unified diff for evidenced findings; no repository access. |
| `tvijo_account` | read-only | Account, balance and limits. |
| `tvijo_task_status` | read-only | Status and spending of an existing task. |
| `tvijo_cancel_task` | destructive | Cancel a task; money already spent may still be charged. |
| `tvijo_wiki_search`, `tvijo_wiki_context` | free read | Search and read the public Tvijo wiki, with page revisions. |
| `tvijo_catalog_search`, `tvijo_catalog_get` | free read | Public connector research catalog, with projection hashes. |
| `tvijo_login_start`, `tvijo_login_poll` | auth | OAuth device sign-in; no token is returned to the model. |
| `tvijo_local_repositories`, `tvijo_local_test_results`, `tvijo_local_execution_budget` | opt-in, read-only | Bounded local evidence snapshots; the budget snapshot is evidence, never permission to spend. |

Full tool schemas, per-client setup and failure behaviour:
[`mcp/README.md`](mcp/README.md).

### Setup

Requires Node.js 20 or newer and a Tvijo account.

```sh
npx -y tvijo-dshrem-mcp login   # OAuth device flow; token stored 0700/0600
npx -y tvijo-dshrem-mcp         # starts the stdio server
```

VS Code — add to `.vscode/mcp.json` and start the server from
**MCP: List Servers**:

```json
{
  "servers": {
    "tvijo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tvijo-dshrem-mcp"],
      "env": { "TVIJO_MAX_USD_CAP": "1" }
    }
  }
}
```

Claude Code: `claude mcp add tvijo -- npx -y tvijo-dshrem-mcp`. Codex, Cursor,
terminal clients and the native Windows variants are documented in
[`mcp/README.md`](mcp/README.md).

### Configuration

| Variable | Meaning |
| --- | --- |
| `TVIJO_TOKEN` | Optional access token; overrides the saved device-login token. |
| `TVIJO_MAX_USD_CAP` | Per-call spending cap in USD; default `1`, hard ceiling `5`. |
| `TVIJO_API_BASE` | Optional API base; default `https://dsh.tvijo.com/api/dshrem/v1`. |

### Spending safety

- Every paid call needs an explicit `max_usd`; a request above the effective cap
  is rejected before any network call.
- `TVIJO_MAX_USD_CAP` defaults to 1 USD per call, with an absolute ceiling of 5 USD.
- Paid requests are never retried automatically. After a timeout the server only
  performs read-only lookups by idempotency key or task id, and `spent_usd: null`
  means unknown, never zero.
- The device-flow token is stored with `0600` permissions, is never returned by a
  tool and is redacted from output. Provider API credentials stay on the Tvijo
  service.

### Ownership and support

The MCP Registry record publishes this server as `com.tvijo/dshrem` under the
DNS-verified `tvijo.com` namespace. The project identity is **Tvijo, maintained by Nik Bibamon**
([`@nikbibamon`](https://github.com/nikbibamon)).

- Issues and feature requests: <https://github.com/nikbibamon/tvijocode/issues>
- Official support: [admin@tvijo.com](mailto:admin@tvijo.com)
- Product feedback: <https://dsh.tvijo.com/feedback>
- Product and documentation: <https://dsh.tvijo.com> ·
  <https://dsh.tvijo.com/docs>
- Security reports: email [admin@tvijo.com](mailto:admin@tvijo.com) privately
  rather than opening a public issue.

## Download

[Preview 1.140.07215](https://github.com/nikbibamon/tvijocode/releases/tag/1.140.07215)
embeds Tvijo DSHREM 0.10.25. It includes a portable Windows x64 ZIP and per-user
EXE installer, macOS ZIPs for Apple silicon and Intel, and a Linux x64 desktop
TAR. Each published file has a SHA-256 and an individual native smoke receipt;
the Windows EXE was also installed and uninstalled in Windows CI.

The macOS builds use ad-hoc signatures and are not verified as notarized. Windows
publisher signing trust, interactive sign-in and paid-model tasks were not
verified. Linux DEB/RPM installers and the standalone CLI are not included in
this preview. Previous releases remain available.

**Русский:** [предварительный выпуск 1.140.07215](https://github.com/nikbibamon/tvijocode/releases/tag/1.140.07215)
содержит Windows ZIP и EXE, macOS для Apple silicon и Intel и Linux x64 TAR со
встроенным Tvijo DSHREM 0.10.25. Для каждого файла опубликованы SHA-256 и отчёт
нативной проверки. Нотаризация macOS и доверие к подписи издателя Windows не
подтверждены; вход и задачи с платными моделями не проверялись. Пакетные
установщики Linux и отдельный CLI в этот выпуск не входят.

## When it does NOT work

- You rely on Microsoft-only extensions (Remote - SSH, Live Share, the Microsoft C# and
  Python language servers, Copilot). Their licenses allow them only in Microsoft builds;
  they are not on Open VSX.
- You need signed installers for managed or corporate machines. Wait for signed builds.
- You need auto-update. Install new versions from Releases by hand for now.

## How the build is organised

Everything Tvijo-specific lives in [`tvijo/`](tvijo/); upstream VSCodium files are left
as they are except one hook line in `prepare_vscode.sh`:

| File | Purpose |
|---|---|
| `tvijo/product.json` | Name, application id, installer GUIDs, URLs (merged over VSCodium's) |
| `tvijo/brand.sh` | Applies the branding inside the `vscode/` tree during `prepare_vscode.sh` |
| `tvijo/make_icons.py` | Regenerates every icon and installer image from one glyph (Pillow) |
| `tvijo/embed_extensions.sh` | Downloads pinned extensions, checks SHA-256, embeds them as built-ins |
| `tvijo/smoke_windows.sh` | CI check of the portable zip: name, gallery, update off, extension, `--version` |

Updating to a new VS Code version = merge the matching VSCodium tag, keep the hook line,
run the workflows.

## License

MIT, see [LICENSE](LICENSE). Tvijo Code is based on VSCodium (MIT) and Code - OSS (MIT).
"Visual Studio Code" and "VS Code" are trademarks of Microsoft; this project is not
affiliated with or endorsed by Microsoft or the VSCodium project.
