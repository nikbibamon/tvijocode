"""Test the exact previously built Windows ZIP in fresh native CI; retain evidence."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess
import tempfile
import urllib.request
import zipfile

version = os.environ['RELEASE_VERSION']
artifact = Path('assets') / ('TvijoCode-win32-x64-' + version + '.zip')
assert artifact.is_file(), 'Expected exact portable ZIP'
artifact_sha_before=hashlib.sha256(artifact.read_bytes()).hexdigest()
lock = next(x for x in json.loads(Path('tvijo/extensions.lock.json').read_text()) if x['id'] == 'tvijo.tvijo-dshrem')
work = Path(tempfile.mkdtemp(prefix='tvijo-exe-smoke-', dir=os.environ['RUNNER_TEMP']))
with Path(os.environ['GITHUB_ENV']).open('a') as f:
    f.write('TVIJO_ZIP_SMOKE_WORK=' + str(work) + '\n')
destination = work / 'installed'
with zipfile.ZipFile(artifact) as archive:
    for item in archive.infolist():
        name=item.filename.replace('\\','/')
        assert not name.startswith('/') and '..' not in name.split('/') and ':' not in name, 'Unsafe ZIP path'
extracted=subprocess.run(['7z.exe','x','-y','-o'+str(destination),str(artifact.resolve())],capture_output=True,text=True,timeout=240)
(work/'extract.log').write_text(extracted.stdout+'\n'+extracted.stderr)
assert extracted.returncode==0, 'ZIP extraction failed'
binary = destination / 'Tvijo Code.exe'
assert binary.is_file(), 'Installed editor is missing'
package = destination / 'resources/app/extensions' / lock['dir']
vsix = work / 'pinned.vsix'
with urllib.request.urlopen(lock['url'], timeout=60) as response, vsix.open('xb') as target:
    while chunk := response.read(1024 * 1024): target.write(chunk)
assert hashlib.sha256(vsix.read_bytes()).hexdigest() == lock['sha256']
with zipfile.ZipFile(vsix) as z:
    files = {n[len('extension/'):]: n for n in z.namelist() if n.startswith('extension/') and not n.endswith('/')}
    actual = {p.relative_to(package).as_posix() for p in package.rglob('*') if p.is_file()}
    assert actual == set(files), 'Installed extension file set differs from pinned VSIX'
    for name, item in files.items():
        assert not (package / name).is_symlink()
        assert hashlib.sha256((package / name).read_bytes()).digest() == hashlib.sha256(z.read(item)).digest(), name
project = work / 'project'; project.mkdir()
probe = work / 'probe'; probe.mkdir()
(probe / 'package.json').write_text(json.dumps({'name':'tvijo-installer-probe','publisher':'local-smoke','version':'0.0.1','engines':{'vscode':'^1.90.0'},'main':'./extension.js','activationEvents':['*']}))
(probe / 'extension.js').write_text('exports.activate=()=>{};exports.deactivate=()=>{};\n')
(probe / 'test.js').write_text(r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vscode=require('vscode');
exports.run=async()=>{
  assert.equal(vscode.workspace.isTrusted,true);
  const ext=vscode.extensions.getExtension('tvijo.tvijo-dshrem');assert.ok(ext,'installed Tvijo is discoverable');
  assert.equal(ext.packageJSON.version,process.env.TVIJO_EXPECTED_EXTENSION);await ext.activate();assert.equal(ext.isActive,true);
  const commands=await vscode.commands.getCommands(true);assert.ok(commands.includes('tvijo.openLearningGuide'));
  await vscode.commands.executeCommand('tvijo.openLearningGuide');
  let guide=false;for(let i=0;i<30&&!guide;i++){guide=vscode.window.tabGroups.all.flatMap(g=>g.tabs).some(t=>t.input instanceof vscode.TabInputWebview&&['Tvijo · Learning guide','Tvijo · Учебник'].includes(t.label));if(!guide)await new Promise(r=>setTimeout(r,100));}
  assert.ok(guide,'offline guide opened');
  const root=vscode.workspace.workspaceFolders[0].uri.fsPath;
  const {createTools}=require(path.join(ext.extensionPath,'lib/local-tools'));
  const tools=createTools({root,allowShell:true,confirmRun:async()=>true,confirmWrite:async()=>true});
  const write=await tools.execute({tool:'write_file',path:'smoke.txt',content:'Tvijo native installer test\n'});assert.equal(write.ok,true);
  assert.equal(fs.readFileSync(path.join(root,'smoke.txt'),'utf8'),'Tvijo native installer test\n');
  const command=await tools.execute({tool:'run_command',command:'node --version'});assert.equal(command.ok,true);assert.equal(command.exitCode,0);
  fs.writeFileSync(process.env.TVIJO_INSTALLER_ACTIVATION,JSON.stringify({version:ext.packageJSON.version,active:ext.isActive,guide,write:true,commandExit:command.exitCode}),{flag:'wx'});
};
''')
user = work / 'user'; (user / 'User').mkdir(parents=True)
(user / 'User/settings.json').write_text(json.dumps({'security.workspace.trust.enabled':False,'telemetry.telemetryLevel':'off','extensions.autoUpdate':False,'extensions.autoCheckUpdates':False,'tvijo.orchestration.enabled':False,'tvijo.apiBase':'http://127.0.0.1:9/api/dshrem/v1'}))
activation = work / 'activation.json'
env = dict(os.environ, TVIJO_EXPECTED_EXTENSION=lock['version'], TVIJO_INSTALLER_ACTIVATION=str(activation))
for name in ('OPENAI_API_KEY','ANTHROPIC_API_KEY','ELECTRON_RUN_AS_NODE','GITHUB_TOKEN','GH_TOKEN'): env.pop(name,None)
args=[str(binary),str(project),'--user-data-dir',str(user),'--extensions-dir',str(work/'user-extensions'),'--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-gpu','--extensionDevelopmentPath='+str(probe),'--extensionTestsPath='+str(probe/'test.js')]
with (work/'extension-host.log').open('xb') as output:
    child=subprocess.Popen(args,env=env,stdout=output,stderr=subprocess.STDOUT)
    try:code=child.wait(timeout=180)
    except subprocess.TimeoutExpired:
        subprocess.run(['taskkill.exe','/PID',str(child.pid),'/T','/F'],check=False,capture_output=True)
        raise RuntimeError('Installed extension host timed out')
assert code==0 and activation.is_file(), 'Installed extension activation failed'
activated=json.loads(activation.read_text());assert activated['version']==lock['version'] and activated['active']
artifact_sha_after=hashlib.sha256(artifact.read_bytes()).hexdigest()
assert artifact_sha_before==artifact_sha_after, 'ZIP changed during native smoke'
result={'observed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed','kind':'windows-zip','source_commit':os.environ['TVIJO_SOURCE_SHA'],'verifier_commit':os.environ['GITHUB_SHA'],'editor_version':version,'artifact':artifact.name,'artifact_sha256':artifact_sha_after,'extension_version':lock['version'],'extension_sha256':lock['sha256'],'embedded_files':len(files),'activation':activated,'not_verified':['interactive sign-in','paid model','installer lifecycle','signing trust']}
with (work/'receipt.json').open('x') as f:json.dump(result,f,indent=2)
print(json.dumps(result,indent=2))
