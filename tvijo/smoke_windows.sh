#!/usr/bin/env bash
# Smoke test of the portable Windows zip on the CI runner, before release.
#
# Checks what a user would hit first: the app starts and reports a version,
# it is called Tvijo Code, it talks to Open VSX (not the Microsoft gallery),
# auto-update is off, the Tvijo extension is inside at the pinned version.

set -euo pipefail

TVIJO_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
ZIP="$( ls assets/"${APP_NAME}"-win32-"${VSCODE_ARCH}"-*.zip | head -1 )"
DIR="$( mktemp -d )"
echo "Native Windows smoke evidence retained in ${DIR}"

7z.exe x -y -o"${DIR}" "${ZIP}" > /dev/null

fail() { echo "SMOKE FAIL: $*" >&2; exit 1; }

PRODUCT="${DIR}/resources/app/product.json"
[[ -f "${PRODUCT}" ]] || fail "no product.json in ${ZIP}"

[[ "$( jq -r '.nameShort' "${PRODUCT}" )" == "Tvijo Code" ]] || fail "nameShort is $( jq -r '.nameShort' "${PRODUCT}" )"
[[ "$( jq -r '.applicationName' "${PRODUCT}" )" == "tvijocode" ]] || fail "applicationName"
jq -e '.extensionsGallery.serviceUrl | startswith("https://open-vsx.org/")' "${PRODUCT}" > /dev/null || fail "gallery is not Open VSX"
jq -e 'has("updateUrl") | not' "${PRODUCT}" > /dev/null || fail "updateUrl is set"
if grep -qiE 'vortex\.data\.microsoft\.com|dc\.services\.visualstudio\.com|mobile\.events\.data\.microsoft\.com' "${PRODUCT}"; then
  fail "Microsoft telemetry endpoint in product.json"
fi

mapfile -t ENTRIES < <( jq -c '.[]' "${TVIJO_DIR}/extensions.lock.json" )
for ENTRY in "${ENTRIES[@]}"; do
  EXT_DIR="$( jq -r '.dir' <<< "${ENTRY}" )"
  WANT="$( jq -r '.version' <<< "${ENTRY}" )"
  PKG="${DIR}/resources/app/extensions/${EXT_DIR}/package.json"
  [[ -f "${PKG}" ]] || fail "${EXT_DIR} is not embedded"
  [[ "$( jq -r '.version' "${PKG}" )" == "${WANT}" ]] || fail "${EXT_DIR} version $( jq -r '.version' "${PKG}" ) != ${WANT}"
done

[[ -f "${DIR}/Tvijo Code.exe" ]] || fail "no 'Tvijo Code.exe' at the zip root"

# The .cmd launcher runs the CLI under Electron-as-node, which prints to stdout.
VERSION_OUT="$( cmd.exe //c "$( cygpath -w "${DIR}/bin/${BINARY_NAME}.cmd" )" --version | tr -d '\r' )"
echo "${VERSION_OUT}"
[[ "$( head -1 <<< "${VERSION_OUT}" )" =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "--version did not print a version"

echo "SMOKE OK: ${ZIP}"

# Compare every runtime file to the exact pinned VSIX, then activate Tvijo in a
# fresh native extension host. No account, model request or provider key is used.
export TVIJO_SMOKE_APP="$( cygpath -w "${DIR}" )"
export TVIJO_SMOKE_LOCK="$( cygpath -w "${TVIJO_DIR}/extensions.lock.json" )"
export TVIJO_SMOKE_VERSION_OUT="${VERSION_OUT}"
python3 - <<'PY_SMOKE'
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess
import urllib.request
import zipfile

app = Path(os.environ['TVIJO_SMOKE_APP'])
locks = json.loads(Path(os.environ['TVIJO_SMOKE_LOCK']).read_text())
lock = next(x for x in locks if x['id'] == 'tvijo.tvijo-dshrem')
work = app.parent / (app.name + '-activation')
work.mkdir(exist_ok=False)
if os.environ.get('GITHUB_ENV'):
    with Path(os.environ['GITHUB_ENV']).open('a') as target:
        target.write('TVIJO_SMOKE_WORK=' + str(work) + '\n')
vsix = work / 'pinned.vsix'
with urllib.request.urlopen(lock['url'], timeout=60) as response, vsix.open('xb') as target:
    while chunk := response.read(1024 * 1024):
        target.write(chunk)
assert hashlib.sha256(vsix.read_bytes()).hexdigest() == lock['sha256'], 'Pinned VSIX checksum'
extension = app / 'resources/app/extensions' / lock['dir']
with zipfile.ZipFile(vsix) as archive:
    files = {i.filename[len('extension/'):]: i for i in archive.infolist()
             if i.filename.startswith('extension/') and not i.is_dir()}
    actual = {p.relative_to(extension).as_posix(): p for p in extension.rglob('*') if p.is_file()}
    assert set(actual) == set(files), 'Embedded extension exact file set'
    for name, info in files.items():
        assert not actual[name].is_symlink(), 'No embedded runtime symlink'
        assert hashlib.sha256(actual[name].read_bytes()).digest() == hashlib.sha256(archive.read(info)).digest(), name

fixture = work / 'fixture'
fixture.mkdir()
(fixture / 'jsconfig.json').write_text(json.dumps({'compilerOptions': {'checkJs': True}, 'include': ['*.js']}))
(fixture / 'source.js').write_text('export function increment(value) {\n  return value + 1;\n}\n')
(fixture / 'consumer.js').write_text("import { increment } from './source.js';\nexport const answer = increment(41);\n")
probe = work / 'probe'
probe.mkdir()
(probe / 'package.json').write_text(json.dumps({'name': 'tvijo-native-smoke', 'publisher': 'tvijo', 'version': '0.0.0',
    'engines': {'vscode': '^1.90.0'}, 'main': './extension.js', 'activationEvents': ['*']}))
(probe / 'extension.js').write_text('exports.activate = () => {};\n')
(probe / 'test.js').write_text(r'''
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
exports.run = async () => {
  const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
  assert.equal(vscode.workspace.isTrusted, true, 'isolated fixture is trusted');
  const tvijo = vscode.extensions.getExtension('tvijo.tvijo-dshrem');
  assert.ok(tvijo, 'packaged Tvijo extension is discovered');
  await tvijo.activate();
  assert.equal(tvijo.isActive, true);
  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes('tvijo.openChat'), 'real Tvijo commands registered');
  assert.ok(commands.includes('tvijo.openLearningGuide'), 'offline guide command registered');
  await vscode.commands.executeCommand('tvijo.openLearningGuide');
  let guideTab;
  for (let attempt = 0; attempt < 20; attempt++) {
    guideTab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
      tab.input instanceof vscode.TabInputWebview &&
      ['Tvijo · Learning guide','Tvijo · Учебник'].includes(tab.label));
    if (guideTab) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(guideTab, 'offline learning guide opens a native webview tab');
  const ts = vscode.extensions.getExtension('vscode.typescript-language-features');
  assert.ok(ts, 'built-in JavaScript/TypeScript language provider');
  await ts.activate();
  for (const file of ['source.js', 'consumer.js']) {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, file)));
    await vscode.window.showTextDocument(document);
  }
  const { inspect } = require(path.join(tvijo.extensionPath, 'lib/code-intelligence'));
  const { createTools } = require(path.join(tvijo.extensionPath, 'lib/local-tools'));
  const tools = createTools({root, codeIntelligence:(action,{signal}) => inspect({vscode,root,action,
    guard:async()=>{},signal,timeoutMs:5000})});
  const results = {};
  async function check(operation, file, line, column, predicate) {
    let result;
    for (let attempt = 0; attempt < 6; attempt++) {
      result = await tools.execute({tool:'code_intelligence',operation,path:file,line,column},{planMode:true});
      if (result.ok && result.source === 'editor_language_provider' && predicate(result.results || [])) {
        results[operation] = result;
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Native provider ' + operation + ' failed: ' + JSON.stringify(result));
  }
  await check('symbols','source.js',undefined,undefined,items=>items.some(x=>x.name==='increment'));
  await check('definition','consumer.js',2,'export const answer = '.length+1,
    items=>items.some(x=>x.path==='source.js' && x.line===1));
  await check('references','source.js',1,'export function '.length+1,
    items=>items.some(x=>x.path==='consumer.js' && x.line===2));
  fs.writeFileSync(process.env.TVIJO_ACTIVATION_RECEIPT, JSON.stringify({activation:'passed',
    extension_version:tvijo.packageJSON.version,commands:['tvijo.openChat','tvijo.openLearningGuide'],
    learning_guide:{opened:true,title:guideTab.label},code_intelligence:results},null,2),{flag:'wx'});
};
''', encoding='utf-8')
user = work / 'user-data'
(user / 'User').mkdir(parents=True)
(user / 'User/settings.json').write_text(json.dumps({'tvijo.apiBase': 'http://127.0.0.1:9/api/dshrem/v1',
    'tvijo.orchestration.enabled': False, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': False, 'extensions.autoCheckUpdates': False, 'workbench.startupEditor': 'none'}))
receipt_path = work / 'activation.json'
env = dict(os.environ, TVIJO_ACTIVATION_RECEIPT=str(receipt_path))
for key in list(env):
    if key in ('OPENAI_API_KEY','ANTHROPIC_API_KEY','ELECTRON_RUN_AS_NODE'):
        env.pop(key)
args = [str(app / 'Tvijo Code.exe'), str(fixture), '--user-data-dir', str(user),
        '--extensions-dir', str(work / 'user-extensions'), '--skip-welcome', '--skip-release-notes',
        '--disable-workspace-trust', '--disable-gpu', '--extensionDevelopmentPath=' + str(probe),
        '--extensionTestsPath=' + str(probe / 'test.js')]
with (work / 'extension-host.log').open('xb') as log:
    child = subprocess.Popen(args, env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        code = child.wait(timeout=180)
    except subprocess.TimeoutExpired:
        subprocess.run(['taskkill.exe','/PID',str(child.pid),'/T','/F'],check=False,capture_output=True)
        raise RuntimeError('Owned native extension host timed out; retained evidence: ' + str(work))
assert code == 0, 'Extension host failed; see ' + str(work / 'extension-host.log')
activation = json.loads(receipt_path.read_text())
assert activation['extension_version'] == lock['version']
receipt = {**activation, 'status': 'passed', 'observed_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'source_commit': os.environ['TVIJO_SOURCE_SHA'], 'release_version': os.environ['RELEASE_VERSION'],
    'extension_sha256': lock['sha256'], 'embedded_file_count': len(files),
    'native_cli_version': os.environ['TVIJO_SMOKE_VERSION_OUT'],
    'checks': ['product_identity','open_vsx','updates_disabled','embedded_exact_bytes','native_cli','extension_activation','offline_learning_guide','native_symbols_definition_references'],
    'not_verified': ['interactive sign-in','paid model response','complete coding task']}
with Path(os.environ['TVIJO_SMOKE_RECEIPT']).open('x') as target:
    json.dump(receipt, target, indent=2)
print('NATIVE SMOKE OK: activation and provider-backed symbols/definition/references')
PY_SMOKE
