import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { registeredTools, replaceTable, toolTable } from '../scripts/readme-tools.mjs';

const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const manifest = JSON.parse(await readFile(new URL('../server.json', import.meta.url), 'utf8'));

test('README generated table equals registered tools/list exactly', async () => {
  const tools = await registeredTools();
  assert.equal(tools.length, 7);
  assert.equal(readme, replaceTable(readme, toolTable(tools)), 'Run npm run readme:tools');
});

test('README contains the four D8 sentences verbatim and reserves a real receipt', () => {
  for (const sentence of [
    'Tvijo caps what Tvijo spends per call; it does not cap the agent that calls it.',
    'What you send (prompts, diffs, repository content the delegate reads, command output) goes to the Tvijo service as model context.',
    'Delegated work runs where the Tvijo extension runs: your machine, or the remote host under Remote SSH.',
    'By default calls go to dsh.tvijo.com; `TVIJO_API_BASE` changes that.'
  ]) assert.ok(readme.includes(sentence), sentence);
  assert.match(readme, /## Review a diff before merge/);
  assert.match(readme, /<!-- receipt:pending -->/);
  assert.doesNotMatch(readme, /(?:delegat\w+.{0,40}(?:guaranteed|immutable|hard) (?:spend|budget|cap)|caps? (?:the )?delegat\w+.{0,20}spend)/i);
});

test('public docs and registry description omit pilot tools and vendor/model names', () => {
  for (const text of [readme, JSON.stringify(manifest)]) {
    assert.doesNotMatch(text, /tvijo_local_|TVIJO_LOCAL_REPORT|local[- ]reports|snapshot tools/i);
    // Client names required for installation are allowed; model suppliers and model names are not.
    assert.doesNotMatch(text, /\b(?:OpenAI|Anthropic|DeepSeek|Gemini|Devstral|Opus|GPT-\d|Sonnet)\b/i);
  }
  assert.ok(manifest.description.length <= 100);
  assert.match(manifest.description, /review/i);
});

// Syntax checked against current primary docs on 2026-10-28:
// VS Code: https://code.visualstudio.com/docs/agents/reference/mcp-configuration
// Claude Code: https://code.claude.com/docs/en/mcp#option-3-add-a-local-stdio-server
// Codex: https://developers.openai.com/codex/mcp/ (redirects to https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
// Cursor: https://cursor.com/docs/mcp
// Native Windows cmd wrapper is an invocation choice, not a claim that every host requires it.
export function clientExamples(markdown = readme) {
  const section = (name) => markdown.split(`## ${name}\n`)[1]?.split('\n## ')[0] ?? '';
  const json = (name) => JSON.parse(section(name).match(/```json\n([\s\S]*?)\n```/)[1]);
  const vscode = json('VS Code').servers.tvijo;
  const cursor = json('Cursor').mcpServers.tvijo;
  const codexSection = section('Codex');
  const toml = codexSection.match(/```toml\n([\s\S]*?)\n```/)[1];
  const command = JSON.parse(toml.match(/^command = (.+)$/m)[1]);
  const args = JSON.parse(toml.match(/^args = (.+)$/m)[1]);
  const claudeLine = section('Claude Code').match(/^claude mcp add tvijo -- (.+)$/m)[1].split(' ');
  return { vscode, 'claude-code': { command: claudeLine[0], args: claudeLine.slice(1) }, codex: { command, args }, cursor };
}

test('per-client examples use the documented config structures and native Windows commands', () => {
  for (const example of Object.values(clientExamples())) {
    assert.equal(example.command, 'npx');
    assert.deepEqual(example.args, ['-y', 'tvijo-dshrem-mcp']);
  }
  assert.match(readme, /\[mcp_servers\.tvijo\]/);
  assert.match(readme, /~\/\.codex\/config\.toml/);
  assert.match(readme, /Node\.js 20/);
  for (const name of ['VS Code', 'Claude Code', 'Codex', 'Cursor']) {
    const section = readme.split(`## ${name}\n`)[1].split('\n## ')[0];
    assert.match(section, /native Windows/);
    assert.match(section, name === 'Claude Code' ? /cmd \/d \/c npx -y tvijo-dshrem-mcp/ : /"\/d", "\/c", "npx", "-y", "tvijo-dshrem-mcp"/);
  }
});
