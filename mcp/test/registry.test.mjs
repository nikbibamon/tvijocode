import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const readJson = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

test('registry manifest validates against the downloaded 2025-12-11 schema', async () => {
  const schema = await readJson('./schema/server.schema.json');
  const manifest = await readJson('../server.json');
  const pkg = await readJson('../package.json');
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  assert.equal(validate(manifest), true, JSON.stringify(validate.errors));
  assert.equal(manifest.$schema, schema.$id);
  assert.equal(manifest.name, pkg.mcpName);
  assert.ok(manifest.description.length <= 100);
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.packages[0].identifier, pkg.name);
  assert.equal(manifest.packages[0].version, pkg.version);
  for (const version of Object.values({ ...pkg.dependencies, ...pkg.devDependencies })) assert.match(version, /^\d+\.\d+\.\d+$/);
});
