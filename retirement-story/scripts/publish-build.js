import {cpSync,existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const appRoot=fileURLToPath(new URL('../',import.meta.url));
export function publishBuild(dist=path.join(appRoot,'dist'),target=appRoot) {
 const html=readFileSync(path.join(dist,'index.html'),'utf8');
 const scripts=[...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map(m=>m[1]);
 if(!scripts.length||scripts.some(src=>!/^\.\/assets\/[^/]+\.js$/.test(src)))throw new Error('Expected compiled JS bundle in relative assets/');
 for(const src of scripts)if(!existsSync(path.join(dist,src)))throw new Error('Missing bundle '+src);
 if(path.resolve(dist)===path.resolve(target))throw new Error('Cannot publish into dist');
 mkdirSync(target,{recursive:true});
 rmSync(path.join(target,'assets'),{recursive:true,force:true});
 cpSync(path.join(dist,'assets'),path.join(target,'assets'),{recursive:true});
 writeFileSync(path.join(target,'index.html'),html);
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) publishBuild();
