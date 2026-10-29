import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const files=['windows','macos','linux'].map(x=>`.github/workflows/candidate-native-${x}.yml`);
test('native candidates are manual, pin one version and source, and cannot publish',()=>{
 for(const file of files){
  const text=readFileSync(file,'utf8');
  assert.match(text,/workflow_dispatch:\s*\{\}/,file);
  assert.match(text,/RELEASE_VERSION:\s*"1\.140\.07215"/,file);
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
 assert.equal(extension.version,'0.10.25');
 assert.equal(extension.sha256,'453d1fa8d6753de5009fdaec2d6d956b80aac678a4cff670b3d124d9d2a355ba');
 assert.match(extension.url,/tvijo-v0\.10\.25\/tvijo-dshrem-0\.10\.25\.vsix$/);
});
