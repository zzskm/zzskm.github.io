import assert from 'node:assert/strict';
import {readdirSync,readFileSync,statSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const files=[];
function walk(dir){for(const name of readdirSync(dir)){const file=path.join(dir,name);if(statSync(file).isDirectory())walk(file);else if(/\.(?:js|jsx)$/.test(name))files.push(file);}}
walk(path.join(root,'src'));
for(const file of files){
 const source=readFileSync(file,'utf8');
 for(const match of source.matchAll(/from\s+["'](\.[^"']+)["']/g)){
  const target=path.resolve(path.dirname(file),match[1]);assert.ok(statSync(target).isFile(),`${path.relative(root,file)} imports missing ${match[1]}`);
  const imported=match[0].match(/\{([^}]+)\}/)?.[1];
  if(imported){const exports=readFileSync(target,'utf8').match(/export\s*\{([^}]+)\}/g)?.flatMap(x=>[...x.matchAll(/export\s*\{([^}]+)\}/g)].flatMap(y=>y[1].split(',').map(z=>z.trim().split(/\s+as\s+/)[0])))??[];
   for(const raw of imported.split(',')){const name=raw.trim().split(/\s+as\s+/)[0];assert.ok(exports.includes(name),`${path.relative(root,file)} imports missing named export ${name} from ${path.relative(root,target)}`);}
  }
 }
}
const html=readFileSync(path.join(root,'index.html'),'utf8');
assert.match(html,/type="module"/);assert.doesNotMatch(html,/text\/babel|esm\.sh|cdn\.tailwindcss/);
console.log(`Static import graph: ${files.length} modules valid`);
