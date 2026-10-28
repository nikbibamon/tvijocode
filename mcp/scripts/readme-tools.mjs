import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/server.js';

export const START = '<!-- tools:generated:start -->';
export const END = '<!-- tools:generated:end -->';

export async function registeredTools() {
  // Explicit environment: opt-in tools and the user's credentials cannot affect docs.
  const server = createMcpServer({ env: { TVIJO_API_BASE: 'http://127.0.0.1:1' } });
  const client = new Client({ name: 'readme-generator', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return (await client.listTools()).tools;
  } finally { await client.close(); await server.close(); }
}

export function toolTable(tools) {
  const cell = (value) => value.replace(/\|/g, '&#124;').replace(/\r?\n/g, ' ');
  return ['| Tool | Purpose |', '| --- | --- |', ...tools.map((tool) => `| \`${tool.name}\` | ${cell(tool.description)} |`)].join('\n');
}

export function replaceTable(readme, table) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start || readme.indexOf(START, start + 1) >= 0 || readme.indexOf(END, end + 1) >= 0) throw new Error('README must have exactly one generated tools block.');
  return readme.slice(0, start + START.length) + '\n' + table + '\n' + readme.slice(end);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = new URL('../README.md', import.meta.url);
  await writeFile(file, replaceTable(await readFile(file, 'utf8'), toolTable(await registeredTools())));
}
