import copy
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

import native_publish as m

class NativePublicationGuards(unittest.TestCase):
    def setUp(self):
        parent=Path(os.environ['TVIJO_NATIVE_TEST_TMP']);assert parent.is_absolute()
        self.root=Path(tempfile.mkdtemp(prefix='publisher-fixture-',dir=parent))
        self.artifact=self.root/m.NAMES['windows-exe'];self.artifact.write_bytes(b'synthetic installer')
        self.digest=hashlib.sha256(self.artifact.read_bytes()).hexdigest()
        self.receipt={'status':'passed','editor_version':m.VERSION,'artifact':self.artifact.name,'artifact_sha256':self.digest,'extension_version':'0.10.25','extension_sha256':m.EXT_SHA,'installer_exit':0,'uninstaller_exit':0,'activation':{'active':True,'guide':True,'write':True,'commandExit':0}}
        self.run={'databaseId':m.RUNS['windows-exe'],'headSha':m.BUILDER,'status':'completed','jobs':[{'name':'build','status':'completed','conclusion':'success'}]}

    def test_exact_installer_and_successful_job_are_accepted(self):
        got=m.validate_receipt('windows-exe',self.artifact,self.receipt,self.run)
        self.assertEqual(got['sha256'],self.digest)

    def test_wrong_bytes_source_or_failed_native_job_block(self):
        for change in ('digest','source','job','uninstall','activation'):
            r,j=copy.deepcopy(self.receipt),copy.deepcopy(self.run)
            if change=='digest':r['artifact_sha256']='0'*64
            if change=='source':j['headSha']='0'*40
            if change=='job':j['jobs'][0]['conclusion']='failure'
            if change=='uninstall':r['uninstaller_exit']=1
            if change=='activation':r['activation']['write']=False
            with self.subTest(change=change),self.assertRaises(ValueError):m.validate_receipt('windows-exe',self.artifact,r,j)

    def test_unbound_zip_is_not_accepted(self):
        artifact=self.root/m.NAMES['windows-zip'];artifact.write_bytes(b'synthetic zip')
        r=copy.deepcopy(self.receipt);r.update(artifact=artifact.name,artifact_sha256=hashlib.sha256(artifact.read_bytes()).hexdigest())
        with self.assertRaises(ValueError):m.validate_receipt('windows-zip',artifact,r,self.run)

    def test_authenticated_bundle_must_match_remote_digest_and_member(self):
        bundle=self.root/'bundle.zip'
        with zipfile.ZipFile(bundle,'x') as z:z.write(self.artifact,'assets/'+self.artifact.name)
        meta={'expired':False,'workflow_run':{'id':m.RUNS['windows-exe'],'head_sha':m.BUILDER},'digest':'sha256:'+m.sha(bundle)}
        with patch.object(m,'api',return_value=meta):m.bundle_member(bundle,self.artifact.name,self.digest,123,m.RUNS['windows-exe'],m.BUILDER)
        with patch.object(m,'api',return_value={**meta,'digest':'sha256:'+'0'*64}),self.assertRaises(ValueError):m.bundle_member(bundle,self.artifact.name,self.digest,123,m.RUNS['windows-exe'],m.BUILDER)
        with patch.object(m,'api',return_value=meta),self.assertRaises(ValueError):m.bundle_member(bundle,self.artifact.name,'0'*64,123,m.RUNS['windows-exe'],m.BUILDER)

    def test_duplicate_bundle_basename_is_refused(self):
        bundle=self.root/'duplicate.zip'
        with zipfile.ZipFile(bundle,'x') as z:
            z.write(self.artifact,'a/'+self.artifact.name);z.write(self.artifact,'b/'+self.artifact.name)
        meta={'expired':False,'workflow_run':{'id':m.RUNS['windows-exe'],'head_sha':m.BUILDER},'digest':'sha256:'+m.sha(bundle)}
        with patch.object(m,'api',return_value=meta),self.assertRaises(ValueError):m.bundle_member(bundle,self.artifact.name,self.digest,123,m.RUNS['windows-exe'],m.BUILDER)

    def manifest(self):
        receipt=self.root/'receipt.json';receipt.write_text(json.dumps(self.receipt))
        manifest=self.root/'manifest.json';manifest.write_text(json.dumps({'channels':[{'kind':'windows-exe','artifact':str(self.artifact),'receipt':str(receipt),'asset_bundle':'unused','asset_bundle_id':1,'receipt_bundle':'unused','receipt_bundle_id':2}]}))
        return manifest

    def test_existing_release_stops_before_any_mutation(self):
        manifest=self.manifest();calls=[]
        def api(path,optional=False):return {'id':1} if '/releases/tags/' in path else None
        with patch.object(sys,'argv',['native_publish','--manifest',str(manifest),'--out',str(self.root/'out'),'--publish']),patch.object(m,'run_info',return_value=self.run),patch.object(m,'bundle_member'),patch.object(m,'api',side_effect=api),patch.object(m,'gh',side_effect=lambda *a,**k:calls.append(a)),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError,'already exists'):m.main()
        self.assertEqual(calls,[])

    def test_existing_tag_stops_before_any_mutation(self):
        manifest=self.manifest();calls=[]
        def api(path,optional=False):return {'ref':'occupied'} if '/git/ref/tags/' in path else None
        with patch.object(sys,'argv',['native_publish','--manifest',str(manifest),'--out',str(self.root/'out'),'--publish']),patch.object(m,'run_info',return_value=self.run),patch.object(m,'bundle_member'),patch.object(m,'api',side_effect=api),patch.object(m,'gh',side_effect=lambda *a,**k:calls.append(a)),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError,'already exists'):m.main()
        self.assertEqual(calls,[])

    def test_auth_or_network_failure_is_not_a_missing_release(self):
        for body in ('{"message":"Forbidden","status":"403"}','', 'not json'):
            with self.subTest(body=body),patch.object(m,'gh',return_value=SimpleNamespace(returncode=1,stdout=body)),self.assertRaisesRegex(ValueError,'GitHub read failed'):
                m.api('repos/example/releases/tags/version',optional=True)
        with patch.object(m,'gh',return_value=SimpleNamespace(returncode=1,stdout='{"message":"Not Found","status":"404"}')):
            self.assertIsNone(m.api('repos/example/releases/tags/version',optional=True))

    def test_failed_upload_retains_draft_without_publish_or_delete(self):
        manifest=self.manifest();calls=[]
        def api(path,optional=False):
            if '/releases/tags/' in path or '/git/ref/tags/' in path:return None
            if path.endswith('/releases/17'):return {'id':17,'draft':True,'tag_name':m.VERSION,'assets':[]}
            raise AssertionError(path)
        def gh(*args,**kwargs):
            calls.append(args)
            if args[:3]==('api','--method','POST') and args[3].endswith('/git/refs'):return SimpleNamespace(returncode=0,stdout='{"ref":"new"}')
            if args[:3]==('api','--method','POST') and args[3].endswith('/releases'):return SimpleNamespace(returncode=0,stdout=json.dumps({'id':17,'draft':True,'tag_name':m.VERSION}))
            if args[:2]==('release','upload'):return SimpleNamespace(returncode=1,stdout='',stderr='upload failed')
            raise AssertionError(args)
        with patch.object(sys,'argv',['native_publish','--manifest',str(manifest),'--out',str(self.root/'out'),'--publish']),patch.object(m,'run_info',return_value=self.run),patch.object(m,'bundle_member'),patch.object(m,'api',side_effect=api),patch.object(m,'gh',side_effect=gh),contextlib.redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(ValueError,'upload failed'):m.main()
        self.assertTrue((self.root/'out'/'draft-created.json').exists())
        self.assertFalse(any(x[:2] in (('release','edit'),('release','delete')) for x in calls))

if __name__=='__main__':unittest.main()
