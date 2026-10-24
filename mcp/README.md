# Tvijo DSHREM MCP

Run Tvijo DSHREM as a Model Context Protocol server over stdio. Ask questions with an explicit spending limit, inspect your account and tasks, and cancel tasks from an MCP client.

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

Add this to `.vscode/mcp.json`. VS Code prompts for the token using a password input:

```json
{
  "inputs": [
    {
      "type": "promptString",
      "id": "tvijo-token",
      "description": "Tvijo access token",
      "password": true
    }
  ],
  "servers": {
    "tvijo": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "tvijo-dshrem-mcp"],
      "env": {
        "TVIJO_TOKEN": "${input:tvijo-token}",
        "TVIJO_MAX_USD_CAP": "1"
      }
    }
  }
}
```

For device login, omit `inputs` and `TVIJO_TOKEN`, then run the login command under the same operating-system user as the MCP server.

## Terminal clients

For a terminal client that supports `mcp add`, replace `YOUR_MCP_CLIENT` with its executable:

```sh
YOUR_MCP_CLIENT mcp add tvijo -- npx -y tvijo-dshrem-mcp
```

Run the device login command first, or use the login tools after connecting. With no arguments, `npx -y tvijo-dshrem-mcp` starts the stdio server. `npx -y tvijo-dshrem-mcp --version` prints the package version.

## Cursor

Add this entry to `~/.cursor/mcp.json`, then run the device login command:

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

Restart or reconnect your client after changing environment variables.

## Tools

| Tool | Purpose |
| --- | --- |
| `tvijo_account` | Read account, balance and limits. |
| `tvijo_ask` | Spend up to an explicit `max_usd` to answer a prompt. |
| `tvijo_task_status` | Read a task by `task_id`. |
| `tvijo_cancel_task` | Cancel a task by `task_id`; money already spent may still be charged. |
| `tvijo_login_start` | Begin device sign-in; return a verification URL and user code. |
| `tvijo_login_poll` | Check approval and save the token privately. |

`tvijo_ask` requires `prompt` (1–20,000 characters) and a positive numeric `max_usd`. Optional inputs are `title` (up to 120 characters), `model` (default `coding`), `mode` (default `single`), and positive integer `max_tokens` (default `2048`). The service determines which model aliases and modes are available. The request method is `evidence-first`.

Example tool arguments:

```json
{ "prompt": "Explain how to make this function easier to test.", "max_usd": 0.25 }
```

Results include `task_id`, `answer`, `spent_usd`, `state`, and `recovered`. Account and task results include both JSON text and structured content.

## Spending cap and request recovery

**`tvijo_ask` spends real money up to `max_usd` from your Tvijo account.** You must supply `max_usd` for each call. `TVIJO_MAX_USD_CAP` defaults to `1` USD per call, with an absolute ceiling of `5` USD. Values above `5` are clamped to `5`; invalid or nonpositive cap settings reject calls. A request exceeding the effective cap is rejected before any network request. This is a per-call cap; several separate calls can spend more in total. Account limits still apply.

A normal ask sends one task creation and one chat request. Each task creation uses a fresh idempotency key. Paid requests are never automatically retried. If task creation is ambiguous, the server performs one read-only lookup by idempotency key and returns the task without dispatching a chat. If chat is ambiguous, it reads the existing task status. A recovered response may have `answer: null` or `spent_usd: null` when those values are unavailable; this does not mean no money was spent. Inspect the task before asking again. If lookup fails too, the error includes the known task ID or idempotency key for review.

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
npm pack --dry-run
```

Tests use a local fake HTTP server, including real stdio MCP exchanges, and make no requests to the production API. Registry metadata is validated with the downloaded 2025-12-11 schema under `test/schema/`. The published package includes only the executable, source, this README, the MIT license, and registry metadata (plus npm's required package metadata).

MIT © 2026 Tvijo.
