"""Validate an exact macOS ZIP or Linux desktop TAR in a native CI runner."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import platform
import signal
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile

kind, artifact_name = sys.argv[1:]
assert kind in ('macos', 'linux')
assert (kind == 'macos' and sys.platform == 'darwin') or (kind == 'linux' and sys.platform.startswith('linux'))
if kind == 'linux': assert os.geteuid() != 0, 'Desktop smoke must run without root'
artifact = Path(artifact_name).resolve(); assert artifact.is_file()
work = Path(tempfile.mkdtemp(prefix='tvijo-native-smoke-', dir=os.environ['RUNNER_TEMP']))
with Path(os.environ['GITHUB_ENV']).open('a') as f: f.write('TVIJO_NATIVE_SMOKE_WORK=' + str(work) + '\n')
unpacked = work/'unpacked'; unpacked.mkdir()
if kind == 'macos':
    with zipfile.ZipFile(artifact) as z:
        assert all(not Path(i.filename).is_absolute() and '..' not in Path(i.filename).parts for i in z.infolist())
    subprocess.run(['ditto','-x','-k',str(artifact),str(unpacked)],check=True,timeout=120)
    apps=list(unpacked.glob('*.app')); assert len(apps)==1
    app=apps[0]; subprocess.run(['codesign','--verify','--deep','--strict',str(app)],check=True,timeout=60)
    executables=[p for p in (app/'Contents/MacOS').iterdir() if p.is_file() and os.access(p,os.X_OK)]
    assert len(executables)==1, 'Ambiguous macOS executable'
    binary=executables[0]; extension=app/'Contents/Resources/app/extensions/tvijo-dshrem'; launcher=app/'Contents/Resources/app/bin/tvijocode'
    notarization=subprocess.run(['spctl','--assess','--type','execute',str(app)],capture_output=True,text=True,timeout=60)
    trust={'spctl_exit':notarization.returncode,'note':'Ad-hoc signature is not evidence of Apple notarization.'}
else:
    with tarfile.open(artifact,'r:gz') as t:
        members=t.getmembers()
        for m in members:
            assert not Path(m.name).is_absolute() and '..' not in Path(m.name).parts
            assert not m.isdev() and not m.isfifo()
            if m.issym() or m.islnk():
                assert not Path(m.linkname).is_absolute() and '..' not in Path(m.linkname).parts
        t.extractall(unpacked,members=members)
    binary=unpacked/'tvijocode';launcher=unpacked/'bin/tvijocode';extension=unpacked/'resources/app/extensions/tvijo-dshrem'
    trust={'note':'Linux desktop tar; system package lifecycle is a separate check.'}
assert binary.is_file() and launcher.is_file() and extension.is_dir()
lock=next(x for x in json.loads(Path('tvijo/extensions.lock.json').read_text()) if x['id']=='tvijo.tvijo-dshrem')
vsix=work/'pinned.vsix'
with urllib.request.urlopen(lock['url'],timeout=60) as response,vsix.open('xb') as dest:
    while chunk:=response.read(1024*1024):dest.write(chunk)
assert hashlib.sha256(vsix.read_bytes()).hexdigest()==lock['sha256']
with zipfile.ZipFile(vsix) as z:
    files={n[len('extension/'):]:n for n in z.namelist() if n.startswith('extension/') and not n.endswith('/')}
    actual={x.relative_to(extension).as_posix() for x in extension.rglob('*') if x.is_file()}
    assert actual==set(files), 'Embedded extension file set differs'
    for name,item in files.items():
        assert not (extension/name).is_symlink()
        assert hashlib.sha256((extension/name).read_bytes()).digest()==hashlib.sha256(z.read(item)).digest(),name
cli=subprocess.run([str(launcher),'--version'],capture_output=True,text=True,timeout=30)
assert cli.returncode==0 and cli.stdout.strip(), 'Native CLI version failed'
project=work/'project'; project.mkdir(); probe=work/'probe'; probe.mkdir(); user=work/'user'; (user/'User').mkdir(parents=True)
(user/'User/settings.json').write_text(json.dumps({'security.workspace.trust.enabled':False,'telemetry.telemetryLevel':'off','extensions.autoUpdate':False,'extensions.autoCheckUpdates':False,'tvijo.orchestration.enabled':False,'tvijo.apiBase':'http://127.0.0.1:9/api/dshrem/v1'}))
(probe/'package.json').write_text(json.dumps({'name':'tvijo-native-probe','publisher':'local-smoke','version':'0.0.1','engines':{'vscode':'^1.90.0'},'main':'./extension.js','activationEvents':['*']}))
(probe/'extension.js').write_text('exports.activate=()=>{};exports.deactivate=()=>{};\n')
(probe/'test.js').write_text(r'''
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vscode=require('vscode');
exports.run=async()=>{
 assert.equal(vscode.workspace.isTrusted,true);const ext=vscode.extensions.getExtension('tvijo.tvijo-dshrem');assert.ok(ext);
 assert.equal(ext.packageJSON.version,process.env.TVIJO_EXPECTED_EXTENSION);await ext.activate();assert.equal(ext.isActive,true);
 const commands=await vscode.commands.getCommands(true);assert.ok(commands.includes('tvijo.openLearningGuide'));
 await vscode.commands.executeCommand('tvijo.openLearningGuide');
 let guide=false;for(let i=0;i<30&&!guide;i++){guide=vscode.window.tabGroups.all.flatMap(g=>g.tabs).some(t=>t.input instanceof vscode.TabInputWebview&&['Tvijo · Learning guide','Tvijo · Учебник'].includes(t.label));if(!guide)await new Promise(r=>setTimeout(r,100));}assert.ok(guide);
 const root=vscode.workspace.workspaceFolders[0].uri.fsPath,{createTools}=require(path.join(ext.extensionPath,'lib/local-tools'));
 const tools=createTools({root,allowShell:true,confirmRun:async()=>true,confirmWrite:async()=>true});
 const write=await tools.execute({tool:'write_file',path:'smoke.txt',content:'Native candidate smoke\n'});assert.equal(write.ok,true);assert.equal(fs.readFileSync(path.join(root,'smoke.txt'),'utf8'),'Native candidate smoke\n');
 const result=await tools.execute({tool:'run_command',command:'node --version'});assert.equal(result.ok,true);assert.equal(result.exitCode,0);
 fs.writeFileSync(process.env.TVIJO_ACTIVATION_RECEIPT,JSON.stringify({version:ext.packageJSON.version,active:true,guide,write:true,commandExit:result.exitCode}),{flag:'wx'});
};
''')
activation=work/'activation.json'
allowed=('PATH','HOME','TMPDIR','DISPLAY','XAUTHORITY','LANG','LC_ALL','SHELL','XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS')
env={k:os.environ[k] for k in allowed if k in os.environ};env.update(TVIJO_EXPECTED_EXTENSION=lock['version'],TVIJO_ACTIVATION_RECEIPT=str(activation))
args=[str(binary),str(project),'--user-data-dir',str(user),'--extensions-dir',str(work/'user-extensions'),'--skip-welcome','--skip-release-notes','--disable-workspace-trust','--disable-gpu','--extensionDevelopmentPath='+str(probe),'--extensionTestsPath='+str(probe/'test.js')]
if kind=='linux':args.insert(1,'--no-sandbox')
with (work/'extension-host.log').open('xb') as out:
    child=subprocess.Popen(args,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
    try:code=child.wait(timeout=180)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid,signal.SIGTERM);child.wait(timeout=10);raise RuntimeError('Native activation timed out')
assert code==0 and activation.is_file(), 'Native extension activation failed'
result={'observed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'passed','platform':kind,'host_arch':platform.machine(),'source_commit':os.environ['TVIJO_SOURCE_SHA'],'editor_version':os.environ['RELEASE_VERSION'],'artifact':artifact.name,'artifact_sha256':hashlib.sha256(artifact.read_bytes()).hexdigest(),'extension_version':lock['version'],'extension_sha256':lock['sha256'],'embedded_files':len(files),'native_cli':cli.stdout.strip(),'activation':json.loads(activation.read_text()),'trust':trust,'not_verified':['interactive sign-in','paid model','other artifacts']}
with (work/'receipt.json').open('x') as f:json.dump(result,f,indent=2)
print(json.dumps(result,indent=2))
