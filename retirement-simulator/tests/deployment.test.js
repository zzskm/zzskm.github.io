import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {publishBuild} from '../scripts/publish-build.js';
const root=fileURLToPath(new URL('../',import.meta.url));
const published=readFileSync(path.join(root,'index.html'),'utf8');
assert.doesNotMatch(published,/src\/main\.jsx|text\/babel/);
const modules=[...published.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]);
assert.ok(modules.length>0);
for(const src of modules){assert.match(src,/^\.\/assets\/[^/]+\.js$/);assert.ok(existsSync(path.join(root,src)));}
const temp=mkdtempSync(path.join(os.tmpdir(),'retirement-publish-'));
try {
 const dist=path.join(temp,'dist'),target=path.join(temp,'site');
 mkdirSync(path.join(dist,'assets'),{recursive:true});mkdirSync(path.join(target,'src'),{recursive:true});mkdirSync(path.join(target,'assets'));
 const html='<script type="module" src="./assets/app-test.js"></script>';
 writeFileSync(path.join(dist,'index.html'),html);writeFileSync(path.join(dist,'assets/app-test.js'),'console.log("built")');
 writeFileSync(path.join(target,'src/main.jsx'),'source stays');writeFileSync(path.join(target,'assets/old.js'),'obsolete');writeFileSync(path.join(temp,'other-app.html'),'other app stays');
 publishBuild(dist,target);
 assert.equal(readFileSync(path.join(target,'index.html'),'utf8'),html);assert.ok(!existsSync(path.join(target,'assets/old.js')));
 assert.equal(readFileSync(path.join(target,'src/main.jsx'),'utf8'),'source stays');assert.equal(readFileSync(path.join(temp,'other-app.html'),'utf8'),'other app stays');
 writeFileSync(path.join(dist,'index.html'),'<script type="module" src="./src/main.jsx"></script>');
 assert.throws(()=>publishBuild(dist,target),/compiled JavaScript/);assert.equal(readFileSync(path.join(target,'index.html'),'utf8'),html);
}finally{rmSync(temp,{recursive:true,force:true});}
console.log('Pages entry and scoped static publication valid');
