import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parent = process.env.TVIJO_RELEASE_TEST_TMP;
assert.ok(parent && path.isAbsolute(parent), 'Set TVIJO_RELEASE_TEST_TMP to an owned artifact directory');
const stub = `import sys,json,os,base64
from pathlib import Path
p=Path(os.environ['FAKE_GH_STATE']); s=json.loads(p.read_text()); a=sys.argv[1:]; s['calls'].append(a)
def finish(value=None,code=0,binary=None):
 p.write_text(json.dumps(s))
 if binary is not None: sys.stdout.buffer.write(binary)
 elif value is not None: print(json.dumps(value))
 sys.exit(code)
def absent(): finish({'message':'Not Found','status':'404'},1)
mode=s['mode']
if a[0]=='api':
 if '--method' in a:
  if any(x.endswith('/git/refs') for x in a):
   if mode=='tag-race': finish({'message':'Reference already exists'},1)
   s['tag']=True; finish({'ref':'new'})
  if any(x.endswith('/releases') for x in a):
   s['created_request']=json.loads(sys.stdin.read());s['exists']=True;s['draft']=True
   if mode=='create-response-lost': finish({'message':'Response lost'},1)
   finish({'id':1,'tag_name':os.environ['RELEASE_VERSION'],'draft':True,'assets':[]})
 endpoint=a[1]
 if mode=='forbidden': finish({'message':'Forbidden','status':'403'},1)
 if '/releases/assets/' in endpoint:
  asset=next(v for v in s['assets'] if str(v['id'])==endpoint.rsplit('/',1)[1]); finish(binary=base64.b64decode(asset['content']))
 if '/git/ref/tags/' in endpoint:
  if s['tag']: finish({'ref':'existing','object':{'sha':os.environ['TVIJO_SOURCE_SHA'] if mode!='moved-tag' else '0'*40}})
  absent()
 if '/releases/' in endpoint:
  if not s['exists']: absent()
  if mode=='draft-tag-404' and '/releases/tags/' in endpoint and s['draft']: absent()
  finish({'id':1,'tag_name':os.environ['RELEASE_VERSION'],'draft':s['draft'],'html_url':'https://example.test/release','assets':[{k:v for k,v in x.items() if k!='content'} for x in s['assets']]})
if a[:2]==['release','create']:
 s['exists']=True;s['draft']=True;finish({'created':True})
if a[:2]==['release','upload']:
 f=Path(a[3]);n=f.name;s['attempts'][n]=s['attempts'].get(n,0)+1
 if mode=='retry' and s['attempts'][n]==1 and n.endswith('.exe'): finish({'retry':True},1)
 if mode=='exhausted': finish({'retry':True},1)
 content=f.read_bytes()
 if mode=='corrupt' and n.endswith('.exe'): content=b'X'*len(content)
 s['assets'].append({'id':len(s['assets'])+10,'name':n,'size':len(content),'state':'uploaded','content':base64.b64encode(content).decode()})
 if mode=='response-lost' and n.endswith('.exe'): finish({'lost':True},1)
 finish({'uploaded':True})
if a[:2]==['release','edit']:
 s['draft']=False;s['published']=True;finish({'published':True})
finish({'unsupported':a},3)
`;

function run(mode, args = []) {
  const dir = fs.mkdtempSync(path.join(parent, 'release-safety-'));
  fs.mkdirSync(path.join(dir, 'bin'));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.mkdirSync(path.join(dir, 'tvijo'));
  fs.mkdirSync(path.join(dir, 'upstream'));
  for (const file of ['release.sh', 'release_notes.md', 'tvijo/extensions.lock.json', 'upstream/stable.json']) {
    fs.copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const cmd = (a) => {
    const r = spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  cmd(['init', '-q']); cmd(['add', 'release.sh']);
  cmd(['-c', 'user.name=Release Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const source = cmd(['rev-parse', 'HEAD']);
  const version = '1.140.07199';
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'tvijo/extensions.lock.json')))[0];
  fs.writeFileSync(path.join(dir, 'assets', `TvijoCodeUserSetup-x64-${version}.exe`), 'fixture installer bytes');
  fs.writeFileSync(path.join(dir, 'assets', `TvijoCode-win32-x64-${version}.zip`), 'fixture zip bytes');
  const smoke = path.join(dir, 'smoke.json');
  fs.writeFileSync(smoke, JSON.stringify({ status: 'passed', source_commit: source, release_version: version,
    extension_version: lock.version, extension_sha256: lock.sha256, activation: 'passed' }));
  fs.writeFileSync(path.join(dir, 'bin', 'gh-stub.py'), stub);
  fs.writeFileSync(path.join(dir, 'bin', 'gh'), '#!/usr/bin/env python3\n' + stub, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'bin', 'gh.cmd'), '@echo off\r\npython "%~dp0gh-stub.py" %*\r\n');
  const statePath = path.join(dir, 'state.json');
  const state = { mode, calls: [], exists: mode === 'existing-release', tag: mode === 'existing-tag',
    assets: [], attempts: {}, draft: false, published: false };
  fs.writeFileSync(statePath, JSON.stringify(state));
  const env = { ...process.env, PATH: path.join(dir, 'bin') + path.delimiter + process.env.PATH,
    GH_TOKEN: 'offline-fixture', GITHUB_TOKEN: '', ASSETS_REPOSITORY: 'example/editor', RELEASE_VERSION: version,
    TVIJO_SOURCE_SHA: source, OS_NAME: 'windows', VSCODE_ARCH: 'x64', TVIJO_SMOKE_RECEIPT: smoke,
    TMPDIR: dir, FAKE_GH_STATE: statePath };
  delete env.OPENAI_API_KEY; delete env.ANTHROPIC_API_KEY;
  if (process.platform === 'win32') env.PATHEXT = '.CMD;.EXE;.BAT;.COM';
  const result = spawnSync('bash', ['release.sh', ...args], { cwd: dir, env, encoding: 'utf8', timeout: 45000 });
  const final = JSON.parse(fs.readFileSync(statePath));
  assert.ok(!final.calls.some(a => a.includes('delete') || a.includes('--clobber')), 'No destructive GitHub command');
  return { result, state: final, dir };
}

for (const mode of ['existing-release', 'existing-tag', 'forbidden']) {
  test(`${mode}: refuses without any mutation`, () => {
    const { result, state } = run(mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.ok(state.calls.every(a => a[0] === 'api' && !a.includes('--method')));
    assert.equal(state.published, false);
  });
}
test('new version publishes only after downloading and verifying all exact assets', () => {
  const { result, state } = run('normal');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.published, true);
  assert.equal(state.assets.length, 6);
  assert.equal(state.calls.filter(a => a[0] === 'api' && a[1].includes('/releases/assets/')).length, 6);
  assert.equal(state.created_request.draft, true);
  assert.match(state.created_request.target_commitish, /^[a-f0-9]{40}$/);
});
for (const mode of ['response-lost', 'retry']) {
  test(`${mode}: accepted bytes survive, missing upload retries are bounded`, () => {
    const { result, state } = run(mode);
    assert.equal(result.status, 0, result.stderr);
    const attempts = Object.entries(state.attempts).find(([n]) => n.endsWith('.exe'))[1];
    assert.equal(attempts, mode === 'response-lost' ? 1 : 2);
    assert.equal(state.published, true);
  });
}
for (const mode of ['corrupt', 'exhausted', 'tag-race', 'moved-tag', 'create-response-lost']) {
  test(`${mode}: preserves evidence and refuses publication`, () => {
    const { result, state } = run(mode);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(state.published, false);
    if (mode === 'corrupt') assert.ok(state.assets.length > 0);
    if (mode === 'exhausted') assert.equal(Math.max(...Object.values(state.attempts)), 3);
    if (mode === 'create-response-lost') {
      assert.equal(state.draft, true);
      assert.equal(state.assets.length, 0);
      assert.equal(state.calls.filter(a => a.includes('--method') && a.some(x => x.endsWith('/releases'))).length, 1);
    }
  });
}
test('draft tag endpoint returns 404: creation ID is used for every draft read', () => {
  const { result, state } = run('draft-tag-404');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.published, true);
  assert.equal(state.calls.filter(a => a[0] === 'api' && a[1].includes('/releases/tags/')).length, 1);
  assert.ok(state.calls.some(a => a[0] === 'api' && a[1].endsWith('/releases/1')));
});
test('preflight checks availability without creating a tag or release', () => {
  const { result, state } = run('normal', ['--preflight']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.tag, false); assert.equal(state.exists, false);
});
test('workflow pins selected source and never invokes release pruning', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/publish-stable-windows.yml'), 'utf8');
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /EXPECTED_SOURCE_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /prune_releases|KEEP_RELEASES|GITHUB_BRANCH: main/);
  assert.match(workflow, /release\.sh --preflight/);
  const notes = fs.readFileSync(path.join(root, 'release_notes.md'), 'utf8');
  const downloads = [...notes.matchAll(/\]\((https:[^)]+\/releases\/download\/[^)]+)\)/g)].map(m => m[1]);
  assert.equal(downloads.length, 4);
  assert.ok(downloads.every(u => /\.(exe|zip|json)$/.test(u)));
});
