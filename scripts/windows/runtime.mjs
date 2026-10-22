import {createServer} from 'node:net';
import {randomUUID} from 'node:crypto';
import {readFile,writeFile,rename,rm,mkdir} from 'node:fs/promises';
import {dirname,join,resolve,relative,isAbsolute} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {safePath} from './manager.mjs';

const installDir=await safePath(process.argv[2]);
const versionDir=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const marker=JSON.parse(await readFile(join(installDir,'install.json'),'utf8'));
if(marker.product!=='Salem'||resolve(marker.installDir)!==installDir||resolve(installDir,'versions',marker.current)!==versionDir)throw new Error('La identidad de instalación cambió antes del inicio.');
const {resolveLaunch}=await import(pathToFileURL(join(versionDir,'app','dist','src','local','main.js')));
const {startLocalServer}=await import(pathToFileURL(join(versionDir,'app','dist','src','local','server.js')));
const {atomicJson}=await import(pathToFileURL(join(versionDir,'app','dist','src','state-store.js')));
const preferencesDir=await safePath(marker.dataDir);
const launch=await resolveLaunch([],preferencesDir);
const dataDir=await safePath(launch.dataDir);
const contains=(root,path)=>{const value=relative(root,path);return value===''||(!value.startsWith('..')&&!isAbsolute(value));};
if(contains(installDir,dataDir)||contains(dataDir,installDir))throw new Error('La carpeta de datos debe estar separada de la instalación.');
let app,pipeServer,closing=false;
const runningFile=join(installDir,'running.json');
const token=randomUUID(),pipe=`\\\\.\\pipe\\salem-${randomUUID()}`;
async function close(){
 if(closing)return;closing=true;
 await app?.close();
 await new Promise(resolveClose=>{if(!pipeServer)return resolveClose();pipeServer.close(resolveClose);});
 try{const running=JSON.parse(await readFile(runningFile,'utf8'));if(running.pid===process.pid&&running.token===token)await rm(runningFile);}catch(e){if(e.code!=='ENOENT')console.error(e.message);}
}
try{
 app=await startLocalServer({...launch,dataDir,staticDir:join(versionDir,'app','web-dist')});
 await atomicJson(join(preferencesDir,'launch.json'),{dataDir:app.store.root});
 pipeServer=createServer(socket=>{
  let input='';socket.setTimeout(5000,()=>socket.destroy());
  socket.on('error',()=>{});
  socket.on('data',chunk=>{
   input+=chunk;if(input.length>4096){socket.destroy();return;}if(!input.includes('\n'))return;
   let request;try{request=JSON.parse(input.trim());}catch{socket.destroy();return;}
   socket.removeAllListeners('data');
   if(request.token!==token){socket.end(JSON.stringify({error:'Control local no autorizado.'})+'\n');return;}
   if(request.command==='status'){socket.end(JSON.stringify({pid:process.pid,url:app.url,dataDir:app.store.root,version:marker.current})+'\n');return;}
   if(request.command==='stop'){
    // Close the authenticated control socket before closing the pipe listener,
    // but only acknowledge after app.close has joined its own agent processes.
    socket.setTimeout(0);
    if(closing){socket.end(JSON.stringify({error:'Salem ya se está cerrando.'})+'\n');return;}
    closing=true;
    void app.close().then(async()=>{
     try{const running=JSON.parse(await readFile(runningFile,'utf8'));if(running.pid===process.pid&&running.token===token)await rm(runningFile);}catch(e){if(e.code!=='ENOENT')throw e;}
     socket.end(JSON.stringify({closed:true,pid:process.pid})+'\n');pipeServer.close();
    }).catch(error=>{console.error(error.message);socket.end(JSON.stringify({error:error.message})+'\n');process.exitCode=1;pipeServer.close();});
    return;
   }
   socket.end(JSON.stringify({error:'Comando de control desconocido.'})+'\n');
  });
 });
 await new Promise((ready,reject)=>{pipeServer.once('error',reject);pipeServer.listen(pipe,ready);});
 await atomicJson(runningFile,{pid:process.pid,token,pipe,url:app.url,dataDir:app.store.root,version:marker.current});
 console.log(`${new Date().toISOString()} Salem ${marker.current}: ${app.url}; datos: ${app.store.root}`);
 process.on('SIGINT',()=>{void close().catch(error=>{console.error(error.message);process.exitCode=1;});});
 process.on('SIGTERM',()=>{void close().catch(error=>{console.error(error.message);process.exitCode=1;});});
}catch(error){console.error(error.message);await app?.close();pipeServer?.close();process.exitCode=1;}
