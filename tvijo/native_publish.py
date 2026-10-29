#!/usr/bin/env python3
"""Create a fresh, independently verified native preview; never replace assets.

Input is a JSON manifest of downloaded GitHub Actions artifact bundles, their
extracted candidate files and native receipts. Every bundle is checked against
GitHub's digest and run identity; every receipt is checked against its artifact.
No remote mutation occurs unless all selected channels pass. Failure preserves
the new tag, draft, uploads and all local evidence for explicit reconciliation.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time
import zipfile

REPO='nikbibamon/tvijocode'
VERSION='1.140.07215'
BUILDER='6495423a8ca97724e9f447883947d9361430b207'
ZIP_VERIFIER='6e8bfbfca245948c2a5569a305527c1973ef9951'
INSTALLER_VERIFIER='2e605f523e1fce5b30880567602e3c388d3513c5'
EXT_SHA='453d1fa8d6753de5009fdaec2d6d956b80aac678a4cff670b3d124d9d2a355ba'
RUNS={'windows-exe':40859929335,'windows-zip':40859929335,'macos-arm64':40859932911,'macos-x64':40859932911,'linux-tar':40859936491}
JOBS={'windows-exe':'build','macos-arm64':'build (macos-14, arm64)','macos-x64':'build (macos-15-intel, x64)','linux-tar':'smoke'}
NAMES={'windows-exe':f'TvijoCodeUserSetup-x64-{VERSION}.exe','windows-zip':f'TvijoCode-win32-x64-{VERSION}.zip','macos-arm64':f'TvijoCode-darwin-arm64-{VERSION}.zip','macos-x64':f'TvijoCode-darwin-x64-{VERSION}.zip','linux-tar':f'TvijoCode-linux-x64-{VERSION}.tar.gz'}

def sha(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()

def safe_file(path):
    p=Path(path)
    if p.is_symlink() or not p.is_file() or p.stat().st_size<=0:raise ValueError('unsafe or empty file: '+str(p))
    return p

def gh(*args,binary=False,input_data=None):
    exe=shutil.which('gh')
    if not exe:raise ValueError('GitHub CLI unavailable')
    return subprocess.run([exe,*args],capture_output=True,text=not binary,input=input_data,timeout=180,check=False)

def api(path,optional=False):
    r=gh('api',path)
    try:d=json.loads(r.stdout)
    except (ValueError,TypeError):d={}
    if r.returncode==0:return d
    if optional and d.get('status') in (404,'404') and d.get('message')=='Not Found':return None
    raise ValueError('GitHub read failed: '+path)

def run_info(run_id):
    r=gh('run','view',str(run_id),'--repo',REPO,'--json','databaseId,headSha,status,conclusion,jobs')
    if r.returncode:raise ValueError('cannot read workflow run '+str(run_id))
    d=json.loads(r.stdout)
    if d.get('databaseId')!=run_id or d.get('status')!='completed':raise ValueError('workflow run is incomplete')
    return d

def job_passed(run,name):
    jobs=[x for x in run.get('jobs',[]) if x.get('name')==name]
    return len(jobs)==1 and jobs[0].get('status')=='completed' and jobs[0].get('conclusion')=='success'

def validate_receipt(kind,artifact,receipt,builder,verifier=None,provenance=None):
    if kind not in NAMES or artifact.name!=NAMES[kind]:raise ValueError('unexpected native artifact name')
    if builder.get('databaseId')!=RUNS[kind] or builder.get('headSha')!=BUILDER or builder.get('status')!='completed':raise ValueError('builder identity mismatch')
    if receipt.get('status')!='passed' or receipt.get('editor_version',receipt.get('release_version'))!=VERSION:raise ValueError('native receipt/version not accepted')
    if receipt.get('extension_version')!='0.10.25' or receipt.get('extension_sha256')!=EXT_SHA:raise ValueError('embedded extension pin mismatch')
    digest=sha(artifact)
    if receipt.get('artifact')!=artifact.name or receipt.get('artifact_sha256')!=digest:raise ValueError('receipt does not bind artifact bytes')
    active=receipt.get('activation')
    if not isinstance(active,dict) or active.get('active') is not True or active.get('guide') is not True or active.get('write') is not True or active.get('commandExit')!=0:raise ValueError('native activation behavior missing')
    if kind=='windows-zip' or (kind=='windows-exe' and verifier):
        verifier_sha=ZIP_VERIFIER if kind=='windows-zip' else INSTALLER_VERIFIER
        if not verifier or verifier.get('headSha')!=verifier_sha or verifier.get('status')!='completed' or verifier.get('conclusion')!='success' or not job_passed(verifier,'verify'):raise ValueError('Windows verifier did not pass')
        if kind=='windows-zip' and (receipt.get('source_commit')!=BUILDER or receipt.get('verifier_commit')!=ZIP_VERIFIER):raise ValueError('ZIP receipt source mismatch')
        if not provenance or provenance.get('builder_run')!=RUNS[kind] or provenance.get('builder_source')!=BUILDER:raise ValueError('ZIP builder provenance missing')
        if any(provenance.get('steps',{}).get(x)!='success' for x in ('Build','Embed Tvijo extensions','Prepare assets','Upload installers')):raise ValueError('ZIP builder stages did not pass')
        if kind=='windows-exe' and (receipt.get('installer_exit')!=0 or receipt.get('uninstaller_exit')!=0):raise ValueError('installer lifecycle incomplete')
    else:
        if not job_passed(builder,JOBS[kind]):raise ValueError('native job did not pass')
        if kind=='windows-exe':
            if receipt.get('installer_exit')!=0 or receipt.get('uninstaller_exit')!=0:raise ValueError('installer lifecycle incomplete')
        else:
            if receipt.get('source_commit')!=BUILDER or receipt.get('platform')!=('linux' if kind=='linux-tar' else 'macos'):raise ValueError('native platform/source mismatch')
            if kind.startswith('macos'):
                allowed={'arm64','aarch64'} if kind=='macos-arm64' else {'x86_64','AMD64'}
                if receipt.get('host_arch') not in allowed:raise ValueError('macOS architecture mismatch')
    return {'kind':kind,'filename':artifact.name,'sha256':digest,'bytes':artifact.stat().st_size,'builder_run':RUNS[kind]}

def bundle_member(bundle,member_name,expected_sha,artifact_id,expected_run,expected_head):
    bundle=safe_file(bundle);meta=api(f'repos/{REPO}/actions/artifacts/{int(artifact_id)}')
    wr=meta.get('workflow_run') or {}
    if meta.get('expired') or wr.get('id')!=expected_run or wr.get('head_sha')!=expected_head or meta.get('digest')!='sha256:'+sha(bundle):raise ValueError('GitHub bundle provenance or digest mismatch')
    with zipfile.ZipFile(bundle) as z:
        matches=[i for i in z.infolist() if not i.is_dir() and Path(i.filename).name==member_name]
        if len(matches)!=1:raise ValueError('bundle member missing or ambiguous: '+member_name)
        h=hashlib.sha256()
        with z.open(matches[0]) as f:
            for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
        if h.hexdigest()!=expected_sha:raise ValueError('extracted file differs from authenticated bundle')

def write_new(path,data):
    with Path(path).open('xb') as f:f.write(data)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--manifest',required=True,type=Path);parser.add_argument('--out',required=True,type=Path);parser.add_argument('--publish',action='store_true');args=parser.parse_args()
    manifest=json.loads(args.manifest.read_text());entries=manifest.get('channels')
    if not isinstance(entries,list) or not entries:raise ValueError('no channels selected')
    kinds=[x.get('kind') for x in entries]
    if len(set(kinds))!=len(kinds) or any(k not in NAMES for k in kinds):raise ValueError('duplicate or unsupported channel')
    args.out.mkdir(mode=0o700,parents=False,exist_ok=False)
    checks=[];upload=[]
    for entry in entries:
        kind=entry['kind'];artifact=safe_file(entry['artifact']);receipt_file=safe_file(entry['receipt']);receipt=json.loads(receipt_file.read_text());builder=run_info(RUNS[kind])
        verifier=None;provenance=None;receipt_run=RUNS[kind];receipt_head=BUILDER
        if kind=='windows-zip' or (kind=='windows-exe' and 'verifier_run' in entry):
            receipt_run=int(entry['verifier_run']);verifier=run_info(receipt_run);receipt_head=ZIP_VERIFIER if kind=='windows-zip' else INSTALLER_VERIFIER
            provenance_file=safe_file(entry['provenance']);provenance=json.loads(provenance_file.read_text())
            provenance_name='tvijo-zip-provenance.json' if kind=='windows-zip' else 'tvijo-installer-provenance.json'
            bundle_member(entry['receipt_bundle'],provenance_name,sha(provenance_file),entry['receipt_bundle_id'],receipt_run,receipt_head)
        result=validate_receipt(kind,artifact,receipt,builder,verifier,provenance)
        bundle_member(entry['asset_bundle'],artifact.name,result['sha256'],entry['asset_bundle_id'],RUNS[kind],BUILDER)
        bundle_member(entry['receipt_bundle'],receipt_file.name,sha(receipt_file),entry['receipt_bundle_id'],receipt_run,receipt_head)
        checksum=args.out/(artifact.name+'.sha256');write_new(checksum,(result['sha256']+'  '+artifact.name+'\n').encode())
        evidence=args.out/('SMOKE-'+kind+'.json');write_new(evidence,receipt_file.read_bytes())
        upload.extend([artifact,checksum,evidence]);checks.append(result)
    names=[p.name for p in upload]
    if len(set(names))!=len(names):raise ValueError('duplicate publication filename')
    summary={'schema':'tvijo.native-publication-plan/v1','version':VERSION,'source_commit':BUILDER,'extension_sha256':EXT_SHA,'channels':checks,'created_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    plan=args.out/'BUILD_RECEIPT.json';write_new(plan,(json.dumps(summary,indent=2)+'\n').encode());upload.append(plan)
    print(json.dumps(summary,indent=2))
    if not args.publish:return
    api_root='repos/'+REPO
    if api(api_root+'/releases/tags/'+VERSION,optional=True) is not None or api(api_root+'/git/ref/tags/'+VERSION,optional=True) is not None:raise ValueError('version already exists; preserve it')
    expected={p.name:{'sha256':sha(p),'bytes':p.stat().st_size} for p in upload}
    notes='Tvijo Code '+VERSION+' preview. Published channels: '+', '.join(kinds)+'. Each included artifact passed its own native smoke.\n\n'
    notes+='Extension 0.10.25 is embedded. Interactive sign-in and live paid-model tasks are unverified. macOS notarization and Windows publisher signing trust are not verified; Linux package installers are not covered by the desktop tar test. Existing releases are preserved.\n'
    notes+='\nРусский: предварительная версия Tvijo Code '+VERSION+'. Опубликованные варианты: '+', '.join(kinds)+'. Каждый включённый файл прошёл собственную проверку на соответствующей платформе.\n\n'
    notes+='Встроено расширение 0.10.25. Интерактивный вход и реальные задачи с платными моделями не проверялись. Нотаризация macOS и доверие к подписи издателя Windows не подтверждены; проверка Linux tar не распространяется на пакетные установщики. Предыдущие релизы сохранены.\n'
    tag=gh('api','--method','POST',api_root+'/git/refs','-f','ref=refs/tags/'+VERSION,'-f','sha='+BUILDER)
    if tag.returncode:raise ValueError('fresh tag reservation failed; inspect remote state')
    write_new(args.out/'tag-created.json',tag.stdout.encode())
    draft=gh('api','--method','POST',api_root+'/releases','--input','-',input_data=json.dumps({'tag_name':VERSION,'target_commitish':BUILDER,'draft':True,'prerelease':True,'name':'Tvijo Code '+VERSION+' preview','body':notes}))
    if draft.returncode:raise ValueError('draft creation failed or ambiguous; preserve tag')
    created=json.loads(draft.stdout);release_id=created.get('id')
    if not isinstance(release_id,int) or not created.get('draft') or created.get('tag_name')!=VERSION:raise ValueError('unexpected draft identity')
    write_new(args.out/'draft-created.json',draft.stdout.encode())
    def assets():
        release=api(api_root+'/releases/'+str(release_id))
        if not release.get('draft') or release.get('tag_name')!=VERSION:raise ValueError('draft changed')
        rows=release.get('assets',[]);out={x['name']:x for x in rows}
        if len(out)!=len(rows) or set(out)-set(expected):raise ValueError('unexpected remote assets')
        return out
    verified={}
    for item in upload:
        if item.name in assets():raise ValueError('new draft already contains an asset; preserve it')
        result=gh('release','upload',VERSION,str(item),'--repo',REPO)
        remote=assets().get(item.name)
        if remote is None:raise ValueError('upload failed or ambiguous; preserve draft')
        if remote.get('size')!=expected[item.name]['bytes'] or remote.get('state')!='uploaded':raise ValueError('remote upload metadata mismatch')
        download=args.out/('authenticated-'+str(remote['id']))
        with download.open('xb') as target:
            get=subprocess.run([shutil.which('gh'),'api',api_root+'/releases/assets/'+str(remote['id']),'-H','Accept: application/octet-stream'],stdout=target,stderr=subprocess.PIPE,timeout=180)
        if get.returncode or sha(download)!=expected[item.name]['sha256']:raise ValueError('remote draft bytes differ; preserve draft')
        verified[item.name]=remote['id']
    final=assets()
    if set(final)!=set(expected) or any(final[n].get('id')!=verified[n] or final[n].get('size')!=expected[n]['bytes'] for n in expected):raise ValueError('draft asset state changed')
    if (api(api_root+'/git/ref/tags/'+VERSION).get('object') or {}).get('sha')!=BUILDER:raise ValueError('tag changed')
    result=gh('release','edit',VERSION,'--repo',REPO,'--draft=false','--prerelease')
    if result.returncode:raise ValueError('publication response failed; inspect preserved release')
    public=api(api_root+'/releases/'+str(release_id))
    if public.get('draft') or public.get('tag_name')!=VERSION:raise ValueError('publication readback mismatch')
    write_new(args.out/'published-before-anonymous.json',(json.dumps({'status':'published_anonymous_verification_pending','release_id':release_id,'version':VERSION,'url':public.get('html_url'),'artifacts':expected},indent=2)+'\n').encode())
    observed=[]
    for name,want in expected.items():
        url='https://github.com/'+REPO+'/releases/download/'+VERSION+'/'+name
        dest=args.out/('anonymous-'+name)
        with dest.open('xb') as f:r=subprocess.run(['curl','-fsSL','--max-time','180',url],stdout=f,stderr=subprocess.PIPE,timeout=190)
        if r.returncode or dest.stat().st_size!=want['bytes'] or sha(dest)!=want['sha256']:raise ValueError('anonymous download verification failed: '+name)
        observed.append({'name':name,'sha256':want['sha256'],'bytes':want['bytes'],'url':url})
    result={'status':'published','version':VERSION,'source_commit':BUILDER,'url':public.get('html_url'),'anonymous':observed,'observed_utc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
    write_new(args.out/'publication.json',(json.dumps(result,indent=2)+'\n').encode());print(json.dumps(result,indent=2))

if __name__=='__main__':
    try:main()
    except Exception as e:print('NATIVE RELEASE REFUSED: '+str(e),file=sys.stderr);raise SystemExit(1)
