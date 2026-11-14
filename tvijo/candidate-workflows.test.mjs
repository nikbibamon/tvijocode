import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const files=['windows','macos','linux'].map(x=>`.github/workflows/candidate-native-${x}.yml`);
test('native candidates are manual, pin one version and source, and cannot publish',()=>{
 for(const file of files){
  const text=readFileSync(file,'utf8');
  assert.match(text,/workflow_dispatch:\s*\{\}/,file);
  assert.match(text,/RELEASE_VERSION:\s*"1\.140\.07216"/,file);
  assert.match(text,/github\.sha/,file);
  assert.doesNotMatch(text,/contents:\s*write/,file);
  assert.doesNotMatch(text,/run:\s*\.\/release\.sh\s*$/m,file);
  assert.match(text,/actions\/upload-artifact@/,file);
 }
});
test('each proposed platform tests its own final artifact',()=>{
 const [win,mac,linux]=files.map(p=>readFileSync(p,'utf8'));
 assert.match(win,/smoke_windows\.sh/);assert.match(win,/smoke_windows_installer\.py/);
 assert.match(mac,/smoke_unix_candidate\.py macos/);
 assert.match(linux,/smoke_unix_candidate\.py linux/);
 assert.match(linux,/xvfb-run/);
 const lock=JSON.parse(readFileSync('tvijo/extensions.lock.json','utf8'));
 const extension=lock.find(x=>x.id==='tvijo.tvijo-dshrem');
 assert.equal(extension.version,'0.10.28');
 assert.equal(extension.sha256,'b0c983a7ac12d2f47fadc24c570cf406a22f0b548ee015d323f01beb3dee7e70');
 assert.match(extension.url,/tvijo-v0\.10\.28\/tvijo-dshrem-0\.10\.28\.vsix$/);
});
