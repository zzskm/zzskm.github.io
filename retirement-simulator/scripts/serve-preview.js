import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json'};
createServer(async(req,res)=>{
 try{
  const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  let file;
  if(pathname==='/retirement_simulator.html')file=path.join(root,'../retirement_simulator.html');
  else if(pathname==='/retirement_favicon.svg')file=path.join(root,'../retirement_favicon.svg');
  else if(pathname.startsWith('/published-retirement-simulator/')){
   const relative=pathname.slice('/published-retirement-simulator/'.length)||'index.html';
   if(relative!=='index.html'&&!/^assets\/[^/]+$/.test(relative)){res.writeHead(404).end();return;}
   file=path.resolve(root,relative);
  }
  else if(pathname.startsWith('/retirement-simulator/')){
   const relative=pathname.slice('/retirement-simulator/'.length)||'index.html';
   file=path.resolve(root,'dist',relative);
   if(!file.startsWith(path.join(root,'dist')+path.sep)){res.writeHead(403).end();return;}
  }else{res.writeHead(404).end();return;}
  const body=await readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store'}).end(body);
 }catch{res.writeHead(404).end();}
}).listen(4173,'127.0.0.1',()=>console.log('Preview: http://127.0.0.1:4173/retirement-simulator/'));
