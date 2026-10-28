// Run against an installed tarball: node scripts/smoke-clients.mjs <install-dir>.
// The README commands resolve the local installed package with npm offline.
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cwd = process.argv[2];
assert.ok(cwd, 'Pass the directory containing the installed tarball package');
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const section = (name) => readme.split(`## ${name}\n`)[1].split('\n## ')[0];
const json = (name) => JSON.parse(section(name).match(/```json\n([\s\S]*?)\n```/)[1]);
const toml = section('Codex').match(/```toml\n([\s\S]*?)\n```/)[1];
const claude = section('Claude Code').match(/^claude mcp add tvijo -- (.+)$/m)[1].split(' ');
const configs = {
  vscode: json('VS Code').servers.tvijo,
  'claude-code': { command: claude[0], args: claude.slice(1) },
  codex: { command: JSON.parse(toml.match(/^command = (.+)$/m)[1]), args: JSON.parse(toml.match(/^args = (.+)$/m)[1]) },
  cursor: json('Cursor').mcpServers.tvijo
};
for (const [name, config] of Object.entries(configs)) {
  const transport = new StdioClientTransport({
    command: config.command, args: config.args, cwd, stderr: 'pipe',
    env: { PATH: process.env.PATH, HOME: await mkdtemp(join(tmpdir(), 'spec237-home-')), npm_config_cache: fileURLToPath(new URL('../.npm-cache', import.meta.url)), npm_config_offline: 'true', ...config.env, TVIJO_API_BASE: 'http://127.0.0.1:1' }
  });
  const client = new Client({ name, version: '0' });
  let stderr = '';
  transport.stderr.on('data', (chunk) => { stderr += chunk; });
  try {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    assert.equal(client.getServerVersion().version, '0.2.0');
    assert.equal(tools.length, 7);
    assert.ok(tools.some((tool) => tool.name === 'tvijo_review'));
    const account = await client.callTool({ name: 'tvijo_account', arguments: {} });
    assert.equal(account.isError, true);
    assert.match(account.content[0].text, /unauthorized/);
    assert.equal(stderr, '');
    process.stdout.write(`${name}: initialize=0.2.0, tools=7, unsigned account=unauthorized, stderr=empty\n`);
  } finally { await client.close(); }
}
