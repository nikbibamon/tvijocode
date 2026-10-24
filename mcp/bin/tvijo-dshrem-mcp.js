#!/usr/bin/env node
import { createClient, ServiceError } from '../src/client.js';
import { createTokenStore } from '../src/token-store.js';
import { accountLabel, createRedactor, startStdioServer, VERSION } from '../src/server.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) { await startStdioServer(); return; }
  if (args.length === 1 && args[0] === '--version') { process.stdout.write(`${VERSION}\n`); return; }
  if (args.length !== 1 || !['login', 'logout'].includes(args[0])) throw new ServiceError('usage', 'Usage: tvijo-dshrem-mcp [login|logout|--version]');
  const client = createClient();
  const store = createTokenStore();
  const redactor = createRedactor([process.env.TVIJO_TOKEN, process.env.TVIJO_TOKEN?.trim()]);
  const log = (message) => process.stderr.write(`${redactor.redact(message)}\n`);
  if (args[0] === 'login') {
    const device = await client.startDeviceLogin();
    log(`Open ${device.verification_uri}\nUser code: ${device.user_code}`);
    const saved = await client.pollDeviceLogin(device);
    redactor.add(saved.access_token);
    await store.save(saved);
    let label = 'Tvijo account';
    try { label = accountLabel(await client.account(saved.access_token)); } catch { /* The token was saved successfully. */ }
    log(`signed in as ${label}`);
  } else {
    let failure;
    try {
      const saved = await store.read();
      const token = process.env.TVIJO_TOKEN?.trim() || (saved?.api_base === client.base ? saved.access_token : undefined);
      if (typeof token === 'string' && token) {
        redactor.add(token);
        await client.logout(token);
      }
    } catch (error) { if (error.code !== 'unauthorized') failure = error; }
    await store.remove();
    if (failure) throw new ServiceError('logout_failed', 'Saved token removed, but remote revocation could not be confirmed.');
    log('Signed out. Saved token removed. If TVIJO_TOKEN is set, remove it from your environment too.');
  }
}

main().catch((error) => {
  const message = error instanceof ServiceError ? error.message : 'Tvijo operation failed. Check configuration and local token-file permissions.';
  const { redact } = createRedactor([process.env.TVIJO_TOKEN, process.env.TVIJO_TOKEN?.trim()]);
  process.stderr.write(`${redact(message)}\n`);
  process.exitCode = 1;
});
