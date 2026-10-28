import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const VALUE = /^[a-z0-9.-]{1,32}$/;
const HOSTS = new Set(['claude-code', 'codex', 'vscode', 'cursor', 'windsurf', 'cline', 'claude-desktop', 'mcp-inspector']);
const bounded = (value) => typeof value === 'string' && VALUE.test(value) ? value : 'other';

export function normalizeHost(name) {
  const value = typeof name === 'string' ? name.trim().toLowerCase() : '';
  return HOSTS.has(bounded(value)) ? value : 'other';
}

// Self-reported counting metadata, never an authorisation decision.
export function clientTag(name, offer = 'none') {
  const host = normalizeHost(name);
  return `mcp/${bounded(VERSION)}; host=${host}; caller=${host}; offer=${['review', 'ask', 'none'].includes(offer) ? offer : 'none'}`;
}
