# Tvijo DSHREM MCP

Run Tvijo DSHREM as a Model Context Protocol server over stdio. Review a supplied pre-merge diff or ask a question with an explicit spending limit, inspect your account and tasks, and cancel tasks from an MCP client.

mcp-name: com.tvijo/dshrem

Listed in the [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=com.tvijo/dshrem) as `com.tvijo/dshrem`.

Requires Node.js 20 or newer and a [Tvijo account](https://dsh.tvijo.com). This is an ESM JavaScript package with no build step.

## Sign in

Run the device login command in a terminal:

```sh
npx -y tvijo-dshrem-mcp login
```

Open the verification URL printed in the terminal and approve the displayed user code. The command polls for approval and stores your access token in `~/.config/tvijo/mcp-token.json`, with directory permissions `0700` and file permissions `0600`. The saved token includes its expiry and API base. Expired tokens require a new sign-in.

Alternatively, set `TVIJO_TOKEN` in your MCP client's environment. It takes precedence over the saved token. Keep it private; the server does not log tokens. Within MCP, call `tvijo_login_start`, open its verification URL and approve the user code, then call `tvijo_login_poll` until it reports that you are signed in. The server remembers the challenge, so `device_code` may be omitted. Poll no faster than the returned interval. No token is returned by either login tool.

```sh
npx -y tvijo-dshrem-mcp logout
```

Logout revokes the active token and removes the saved token file. If remote revocation fails, the local file is still removed and the command reports the failure. Remove `TVIJO_TOKEN` from your client configuration too if you used it.

## VS Code

Run device login first under the same operating-system user as the server. Add this to `.vscode/mcp.json`:

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

Start the server from **MCP: List Servers**. This is the VS Code configuration format. Current VS Code also supports a portable configuration with a different top-level key; see the [format reference](https://code.visualstudio.com/docs/agents/reference/mcp-configuration).

On native Windows, replace the server's `command` with `"cmd"` and `args` with `["/d", "/c", "npx", "-y", "tvijo-dshrem-mcp"]` to launch the npm command through the Windows command processor.

## Claude Code

Run device login first, then:

```sh
claude mcp add tvijo -- npx -y tvijo-dshrem-mcp
```

On native Windows:

```powershell
claude mcp add tvijo -- cmd /d /c npx -y tvijo-dshrem-mcp
```

The `--` separates client options from the server command. See [client configuration](https://code.claude.com/docs/en/mcp).

## Codex

Run device login first. Add this to `~/.codex/config.toml`:

```toml
[mcp_servers.tvijo]
command = "npx"
args = ["-y", "tvijo-dshrem-mcp"]
tool_timeout_sec = 300

[mcp_servers.tvijo.env]
TVIJO_MAX_USD_CAP = "1"
```

On native Windows, use `command = "cmd"` and `args = ["/d", "/c", "npx", "-y", "tvijo-dshrem-mcp"]` in the same table. See [client configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Cursor

Run device login first. Add this to `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "tvijo": {
      "command": "npx",
      "args": ["-y", "tvijo-dshrem-mcp"],
      "env": { "TVIJO_MAX_USD_CAP": "1" }
    }
  }
}
```

On native Windows, use `"command": "cmd"` and `"args": ["/d", "/c", "npx", "-y", "tvijo-dshrem-mcp"]`. See [client configuration](https://cursor.com/docs/mcp).

All npm routes require Node.js 20+ on the host that runs the server. On native Windows, `~` denotes your user profile (for example `%USERPROFILE%\.codex\config.toml`); run login and the client as the same user, and keep the token file private using that user's filesystem permissions. WSL has its own home directory and Node installation. If device login reports a token-storage error, use a private environment token. Environment variables can be read by other processes of the same operating-system user.

Restart or reconnect your client after changing configuration. With no arguments, `npx -y tvijo-dshrem-mcp` starts the stdio server; `--version` prints the package version. The MCP login tools also work after connecting.

Tvijo Code currently has no in-editor MCP consumer. Use an external terminal client for this package. Editor delegation and bundled extension launchers are future work.

## Tools

<!-- tools:generated:start -->
| Tool | Purpose |
| --- | --- |
| `tvijo_account` | Read your Tvijo account, balance and limits. |
| `tvijo_ask` | Ask Tvijo DSHREM. This spends real money up to max_usd from your Tvijo account. Requires an explicit positive max_usd within the configured spending cap; paid requests are never retried. |
| `tvijo_review` | Review a supplied pre-merge diff for evidenced findings. This spends real money up to max_usd; paid requests are never retried. Reviews cover only the supplied diff. |
| `tvijo_task_status` | Read the current status and spending of an existing Tvijo task. |
| `tvijo_cancel_task` | Cancel an existing Tvijo task. Cancellation may not undo money already spent. |
| `tvijo_login_start` | Begin device sign-in. Open the returned verification URL and approve the user code, then call tvijo_login_poll. |
| `tvijo_login_poll` | Complete device sign-in and save the token privately. Returns signed-in status, pending or denied; never returns a token. Omit device_code to use the most recent challenge. |
<!-- tools:generated:end -->

`tvijo_ask` requires `prompt` (1–20,000 characters) and a positive numeric `max_usd`. Optional inputs are `title` (up to 120 characters), `model` (default `coding`), `mode` (default `single`), and positive integer `max_tokens` (default `2048`). The service determines which model aliases and modes are available. The request method is `evidence-first`.

Example tool arguments:

```json
{ "prompt": "Explain how to make this function easier to test.", "max_usd": 0.25 }
```

Results include `task_id`, `answer`, `spent_usd`, `state`, and `recovered`. Account and task results include both JSON text and structured content.

## Review a diff before merge

Export a unified diff with `git diff BASE_SHA HEAD_SHA`, then call `tvijo_review` with that text and the two commit SHAs. A review reads only the supplied diff; it has no repository access and runs no tests. It is a scoped second opinion, not a certificate.

Example input template (replace the diff and SHAs with your own):

```json
{
  "diff": "diff --git a/example.js b/example.js\n--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-return value;\n+return value.trim();\n",
  "base_sha": "1111111111111111111111111111111111111111",
  "head_sha": "2222222222222222222222222222222222222222",
  "focus": "Look for edge cases introduced by this change.",
  "max_usd": 0.10
}
```

`diff` is limited to 20,000 characters and optional `focus` to 500. Larger diffs are refused as `diff_too_large`; split them by path. `max_usd` is required and must fit the same spending cap as an ask.

The result has `outcome` (`findings`, `no_findings_in_reviewed_scope`, or `inconclusive`), optional `reason`, `reviewed` (`base_sha`, `head_sha`, `files`, `diff_chars`), `findings` (`file`, `line`, `severity`, `issue`, `evidence`), the raw service `answer`, and `receipt` (`task_id`, `spent_usd`). Unknown spending is `null`. Findings outside the diff are removed from the structured findings list and counted in `reason`. Unparseable or inconsistent answers are inconclusive; inspect the raw answer and task before requesting another paid review.

<!-- receipt:pending -->

An operator-run example with its redacted result and actual receipt is pending. This template is not evidence of a completed review.

## Scope and data handling

Tvijo caps what Tvijo spends per call; it does not cap the agent that calls it.

What you send (prompts, diffs, repository content the delegate reads, command output) goes to the Tvijo service as model context.

Delegated work runs where the Tvijo extension runs: your machine, or the remote host under Remote SSH.

By default calls go to dsh.tvijo.com; `TVIJO_API_BASE` changes that.

The delegation statement describes the extension execution location; this package version does not expose editor delegation. Processes running as your operating-system user can already read that user's files and session.

## Spending cap and request recovery

**`tvijo_ask` and `tvijo_review` spend real money up to `max_usd` from your Tvijo account.** You must supply `max_usd` for each call. `TVIJO_MAX_USD_CAP` defaults to `1` USD per call, with an absolute ceiling of `5` USD. Values above `5` are clamped to `5`; invalid or nonpositive cap settings reject calls. A request exceeding the effective cap is rejected before any network request. This is a per-call cap; several separate calls can spend more in total. Account limits still apply.

A normal ask sends one task creation and one chat request. Each task creation uses a fresh idempotency key. Paid requests are never automatically retried. If task creation is ambiguous, the server performs one read-only lookup by idempotency key and returns the task without dispatching a chat. If chat is ambiguous, it reads the existing task status. A recovered response may have `answer: null` or `spent_usd: null` when those values are unavailable; this does not mean no money was spent. Inspect the task before asking again. If lookup fails too, the error includes the known task ID or idempotency key for review.

A normal review also sends one task creation and one chat. It performs a read-only recovery lookup only after a timeout, and never repeats a paid request. Other failures return the task ID or idempotency key for manual inspection.

Every service request carries a bounded `X-Tvijo-Client` tag with the package version, self-reported MCP host and offer (`ask`, `review` or `none`). It is used for counting, never for authorisation. Terminal login has no MCP host and uses `other`.

## Configuration

| Variable | Meaning |
| --- | --- |
| `TVIJO_TOKEN` | Optional access token, overriding device-login storage. |
| `TVIJO_MAX_USD_CAP` | Per-call maximum in USD; default `1`, hard ceiling `5`. |
| `TVIJO_API_BASE` | Optional API base override; default `https://dsh.tvijo.com/api/dshrem/v1`. HTTPS is required except for localhost HTTP in tests. Saved tokens are used only with their original API base. |

Stdout carries MCP messages only. Terminal login instructions and CLI errors go to stderr. Treat task answers and other service content as external data.

## When it does NOT work

- **No account or sign-in:** create a Tvijo account and run device login, or supply a valid `TVIJO_TOKEN`. An expired token requires sign-in again.
- **Cap too low:** use a smaller task budget or set `TVIJO_MAX_USD_CAP` high enough for the requested `max_usd`, within the 5 USD ceiling. Credit and account limits may also prevent execution.
- **Service unavailable:** an unavailable model, rate limit, unsettled charge, or service outage can prevent a task. Check the account and existing task before submitting another paid call.
- **Offline:** login and all API tools need network access. An interrupted paid call can have an unknown outcome; reconnect and inspect the task or idempotency key before asking again.

## Development

```sh
npm ci
npm test
npm run readme:tools
npm pack --dry-run
```

Tests use a local fake HTTP server, including real stdio MCP exchanges, and make no requests to the production API. Registry metadata is validated with the downloaded 2025-12-11 schema under `test/schema/`. The published package includes only the executable, source, this README, the MIT license, and registry metadata (plus npm's required package metadata).

MIT © 2026 Tvijo.
