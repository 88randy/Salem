import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readdir,readFile,writeFile,rename,lstat,realpath,cp,rm,open} from 'node:fs/promises';
import {resolve,join,relative,isAbsolute,dirname,basename,parse} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {connect} from 'node:net';

const ownDir=dirname(fileURLToPath(import.meta.url));
const sha=value=>createHash('sha256').update(value).digest('hex');
const identity=(files,metadata)=>sha(JSON.stringify({files,sourceRevision:metadata.sourceRevision??null,sourceTreeHash:metadata.sourceTreeHash??null,nodeVersion:metadata.nodeVersion??null,provisional:metadata.provisional??false})).slice(0,16);
const exists=async p=>{try{await lstat(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const inside=(root,path)=>{const rel=relative(root,path);return rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
const same=(a,b)=>resolve(a).toLowerCase()===resolve(b).toLowerCase();
const quote=value=>`'${value.replaceAll("'","''")}'`;
async function json(path){return JSON.parse(await readFile(path,'utf8'));}
async function atomic(path,value){const temp=`${path}.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value,null,2));await rename(temp,path);}
async function replaceLauncher(path,contents){
 const validate=async()=>{await safePath(path);if(await exists(path)){const info=await lstat(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1)throw new Error('Lanzador con enlace/hardlink o archivo no regular; no se actualiza.');}};
 await validate();const temp=`${path}.${randomUUID()}.tmp`;
 await writeFile(temp,contents,{flag:'wx',mode:0o600});
 try{await validate();await rename(temp,path);}finally{await rm(temp,{force:true});}
}
export async function safePath(input){
 const target=resolve(input);if(target===parse(target).root)throw new Error('Selecciona una carpeta de instalación, no la raíz del disco.');
 let path=parse(target).root;
 for(const part of target.slice(path.length).split(/[\\/]/).filter(Boolean)){
  path=join(path,part);
  if(await exists(path)){const info=await lstat(path);if(info.isSymbolicLink()||!same(await realpath(path),path))throw new Error('Ruta con enlace o junction no permitida.');}
 }
 return target;
}
async function inventory(root,prefix=''){
 const files={};
 for(const entry of (await readdir(join(root,prefix),{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
  const name=(prefix?`${prefix}/`:'')+entry.name;
  if(name==='manifest.json')continue;
  if(entry.isSymbolicLink())throw new Error('El paquete contiene un enlace no permitido.');
  if(entry.isDirectory())Object.assign(files,await inventory(root,name));
  else if(entry.isFile())files[name]=sha(await readFile(join(root,name)));
  else throw new Error('Tipo de archivo no admitido en el paquete.');
 }
 return files;
}
export async function createManifest(root,metadata){
 const files=await inventory(root);
 const buildId=`${metadata.version}-${identity(files,metadata)}`;
 if(!/^[a-zA-Z0-9.-]+$/.test(buildId))throw new Error('Versión inválida.');
 return {product:'Salem',schemaVersion:1,...metadata,buildId,files};
}
export async function verifyPackage(root){
 await safePath(root);const manifest=await json(join(root,'manifest.json'));
 if(manifest.product!=='Salem'||manifest.schemaVersion!==1||!manifest.files||!/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?-[a-f0-9]{16}$/.test(manifest.buildId))throw new Error('Manifest de paquete inválido.');
 for(const [name,hash] of Object.entries(manifest.files))if(!name||name.includes('\\')||name.includes(':')||name.split('/').some(p=>!p||p==='.'||p==='..')||!inside(root,resolve(root,name))||!/^[a-f0-9]{64}$/.test(hash))throw new Error('Ruta o checksum inválido en manifest.');
 const actual=await inventory(root);
 if(JSON.stringify(Object.entries(actual).sort())!==JSON.stringify(Object.entries(manifest.files).sort()))throw new Error('La integridad/checksum del paquete no coincide; no se instala.');
 if(`${manifest.version}-${identity(actual,manifest)}`!==manifest.buildId)throw new Error('Identidad de build inválida.');
 return manifest;
}
function alive(pid){if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(e){if(e.code==='ESRCH')return false;throw new Error('No se pudo confirmar que Salem esté cerrado.');}}
async function refuseRunning(root){
 if(await exists(join(root,'running.json'))){const value=await json(join(root,'running.json'));if(alive(value.pid))throw new Error('Salem está en ejecución (o el PID no puede identificarse). Usa Salir de Salem y espera a sus trabajos antes de actualizar/desinstalar. No se mata ningún proceso.');}
 if(process.platform==='win32'&&await exists(join(root,'install.json'))){
  // Detect users invoking the packaged CLI manually, without our receipt. Only
  // the count is returned: never expose unrelated process command lines/logs.
  const prefix=root.replaceAll('/','\\').replace(/\\$/,'')+'\\';
  const count=ps(`$ErrorActionPreference='Stop'; $prefix=${quote(prefix)}; $ownedNodes=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop | Where-Object { $_.ProcessId -ne ${process.pid} -and (([string]$_.ExecutablePath).Replace('/','\\').StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase) -or ([string]$_.CommandLine).Replace('/','\\').IndexOf($prefix,[StringComparison]::OrdinalIgnoreCase) -ge 0) }); Write-Output $ownedNodes.Count`);
  if(count!=='0')throw new Error('Hay un proceso Node en ejecución desde esta instalación. Ciérralo de forma normal y espera a sus trabajos antes de actualizar/desinstalar. No se mata ningún proceso.');
 }
}
async function marker(root){
 const value=await json(join(root,'install.json'));
 if(value.product!=='Salem'||value.schemaVersion!==1||!same(value.installDir,root)||typeof value.dataDir!=='string'||!/^\d+\.\d+\.\d+(?:[-.][a-zA-Z0-9.-]+)?-[a-f0-9]{16}$/.test(value.current))throw new Error('No se pudo verificar la identidad de instalación de Salem.');
 await safePath(value.dataDir);
 if(same(root,value.dataDir)||inside(root,value.dataDir)||inside(value.dataDir,root))throw new Error('Los datos y la instalación deben estar en carpetas separadas.');
 return value;
}
async function operation(root,fn){
 await mkdir(root,{recursive:true});const path=join(root,'.operation.lock');
 let handle;try{handle=await open(path,'wx');}catch(e){if(e.code!=='EEXIST')throw e;let lock;try{lock=await json(path);}catch{throw new Error('Lock de instalación no verificable; conserva la carpeta para revisión.');}if(alive(lock.pid))throw new Error('Otra operación de Salem está en curso.');await rm(path);handle=await open(path,'wx');}
 await handle.writeFile(JSON.stringify({pid:process.pid}));
 try{return await fn();}finally{await handle.close();await rm(path,{force:true});}
}
function ps(script){const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});if(result.status!==0)throw new Error(result.stderr||result.error?.message||'No se pudo verificar la operación de Windows.');return result.stdout.trim();}
async function shortcuts(info,remove=false){
 if(process.platform!=='win32'||!info.shortcutDir)return;
 await safePath(info.shortcutDir);await mkdir(info.shortcutDir,{recursive:true});
 const icon=join(info.installDir,'versions',info.current,'app','web-dist','salem.ico');
 const iconSetting=await exists(icon)?` $l.IconLocation=${quote(icon+',0')};`:'';
 for(const [name,file] of [['Salem','Launch.vbs'],['Salir de Salem','Stop.vbs'],['Desinstalar Salem','Uninstall.vbs']]){
  const target=join(info.installDir,file),link=join(info.shortcutDir,`${name}.lnk`);
  if(remove){ps(`$w=New-Object -ComObject WScript.Shell; $p=${quote(link)}; if(Test-Path -LiteralPath $p){$l=$w.CreateShortcut($p); if($l.Arguments -eq ${quote('"'+target+'"')}){Remove-Item -LiteralPath $p -Force}}`);}
  else ps(`$w=New-Object -ComObject WScript.Shell; $l=$w.CreateShortcut(${quote(link)}); $l.TargetPath="$env:WINDIR\\System32\\wscript.exe"; $l.Arguments=${quote('"'+target+'"')}; $l.WorkingDirectory=${quote(info.installDir)}; $l.Description=${quote(name)};${iconSetting} $l.Save()`);
 }
}
export async function installPackage(payload,options={}){
 const manifest=await verifyPackage(payload);
 const local=process.env.LOCALAPPDATA;if(!options.installDir&&!local)throw new Error('LOCALAPPDATA no está disponible; indica --install-dir.');
 const installDir=await safePath(options.installDir??join(local,'Programs','Salem'));
 const dataDir=await safePath(options.dataDir??join(local,'Salem'));
 if(same(installDir,dataDir)||inside(installDir,dataDir)||inside(dataDir,installDir))throw new Error('La carpeta de datos debe estar separada de la instalación.');
 if(same(payload,dataDir)||inside(payload,dataDir))throw new Error('La carpeta de datos debe estar fuera del paquete temporal de instalación.');
 if(inside(payload,installDir)||inside(installDir,payload)||same(payload,installDir))throw new Error('El origen y la instalación deben estar separados.');
 return operation(installDir,async()=>{
  let previous;
  if(await exists(join(installDir,'install.json')))previous=await marker(installDir);
  else if((await readdir(installDir)).some(n=>n!=='.operation.lock'))throw new Error('La carpeta de instalación debe estar vacía o pertenecer a Salem; no se modifica una carpeta ajena.');
  await refuseRunning(installDir);
  const selectedData=previous?.dataDir??dataDir;
  if(previous&&options.dataDir&&!same(previous.dataDir,dataDir))throw new Error('Una actualización conserva la carpeta de datos original.');
  const versions=join(installDir,'versions');await mkdir(versions,{recursive:true});await safePath(versions);
  const destination=join(versions,manifest.buildId);
  if(await exists(destination)){await verifyPackage(destination);}
  else {const stage=join(versions,`.staging-${randomUUID()}`);await cp(payload,stage,{recursive:true,errorOnExist:true,force:false,dereference:false});await verifyPackage(stage);await rename(stage,destination);}
  const info={product:'Salem',schemaVersion:1,installDir,dataDir:selectedData,current:manifest.buildId,previous:previous&&previous.current!==manifest.buildId?previous.current:previous?.previous??null,shortcutDir:previous?.shortcutDir??options.shortcutDir??(process.env.APPDATA?join(process.env.APPDATA,'Microsoft','Windows','Start Menu','Programs','Salem'):null),installedAt:new Date().toISOString()};
  for(const file of ['Launch.ps1','Uninstall.ps1'])await replaceLauncher(join(installDir,file),await readFile(join(ownDir,file)));
  for(const [file,script,args] of [['Launch.vbs','Launch.ps1',''],['Stop.vbs','Launch.ps1',' -Mode stop'],['Uninstall.vbs','Uninstall.ps1','']]){
   const command=`powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${join(installDir,script)}"${args}`;
   await replaceLauncher(join(installDir,file),`Set shell = CreateObject("WScript.Shell")\r\ncode = shell.Run("${command.replaceAll('"','""')}", 0, True)\r\n`);
  }
  await atomic(join(installDir,'install.json'),info);
  await shortcuts(info);
  return info;
 });
}
export async function prepareUninstall(input){
 const root=await safePath(input),info=await marker(root);await refuseRunning(root);
 // Recursive deletion is delegated to native PowerShell only after checking the
 // exact root and all descendants. Junctions are rejected rather than followed.
 async function check(dir){for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);await safePath(p);if(e.isDirectory())await check(p);}}
 await check(root);await shortcuts(info,true);
 return {installDir:root,dataDir:info.dataDir,product:'Salem',preserveData:true};
}
export async function requestRuntime(root,command){
 const running=await json(join(root,'running.json'));
 if(!alive(running.pid))throw new Error('El proceso de Salem ya no está activo.');
 return new Promise((resolveReply,reject)=>{
  const socket=connect(running.pipe);let text='',settled=false;
  const finish=(error,result)=>{if(settled)return;settled=true;socket.setTimeout(0);socket.removeAllListeners('data');socket.destroy();if(error)reject(error);else resolveReply(result);};
  socket.setTimeout(command==='stop'?120000:5000,()=>finish(new Error('Salem no respondió al control local.')));
  socket.on('connect',()=>socket.write(JSON.stringify({token:running.token,command})+'\n'));
  socket.on('data',chunk=>{text+=chunk;if(text.length>65536){finish(new Error('Respuesta del control local demasiado grande.'));return;}if(text.includes('\n')){try{const result=JSON.parse(text.trim());if(result.error)finish(new Error(result.error));else if(result.pid!==running.pid||(command==='stop'?result.closed!==true:typeof result.url!=='string'))finish(new Error('Respuesta del control local sin confirmación válida.'));else finish(null,result);}catch(e){finish(e);}}});
  socket.on('error',error=>finish(error));
  socket.on('end',()=>finish(new Error('El control local cerró sin una respuesta completa.')));
  socket.on('close',()=>finish(new Error('El control local se cerró antes de confirmar la respuesta.')));
 });
}
export async function launchInstalled(input,{noBrowser=false}={}){
 const root=await safePath(input),info=await marker(root);
 let result;
 await operation(root,async()=>{
  if(await exists(join(root,'running.json'))){const running=await json(join(root,'running.json'));if(alive(running.pid)){result=await requestRuntime(root,'status');return;}}
  const version=join(root,'versions',info.current);await verifyPackage(version);
  const logDir=join(info.dataDir,'launcher-logs');await mkdir(logDir,{recursive:true});const logPath=join(logDir,'salem.log'),log=await open(logPath,'a');
  const child=spawn(join(version,'runtime','node.exe'),[join(version,'windows','runtime.mjs'),root],{cwd:version,detached:true,windowsHide:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
  let spawnError;child.on('error',error=>{spawnError=error;});
  for(let i=0;i<200;i++){if(spawnError)throw spawnError;await new Promise(r=>setTimeout(r,100));try{const running=await json(join(root,'running.json'));if(running.pid===child.pid){result=await requestRuntime(root,'status');return;}}catch{}if(child.exitCode!==null)throw new Error(`Salem no pudo iniciar. Consulta ${logPath}`);}
  throw new Error(`Salem no confirmó su inicio. Consulta ${logPath}. No se detuvo ningún proceso.`);
 });
 if(!noBrowser&&process.platform==='win32'){const child=spawn('explorer.exe',[result.url],{detached:true,windowsHide:true,stdio:'ignore'});child.unref();}
 return result;
}
async function cli(){const [command,...args]=process.argv.slice(2);const options={};for(let i=0;i<args.length;i++){const key=args[i];if(key==='--no-browser'){options.noBrowser=true;continue;}if(!['--install-dir','--data-dir','--shortcut-dir','--payload'].includes(key)||!args[i+1])throw new Error(`Opción inválida: ${key}`);options[{'--install-dir':'installDir','--data-dir':'dataDir','--shortcut-dir':'shortcutDir','--payload':'payload'}[key]]=args[++i];}
 let result;if(command==='install')result=await installPackage(options.payload??resolve(ownDir,'..'),options);else if(command==='launch')result=await launchInstalled(options.installDir,options);else if(command==='stop')result=await requestRuntime(await safePath(options.installDir),'stop');else if(command==='prepare-uninstall')result=await prepareUninstall(options.installDir);else throw new Error('Comando de Windows desconocido.');console.log(JSON.stringify(result));}
if(process.argv[1]&&same(process.argv[1],fileURLToPath(import.meta.url)))cli().catch(error=>{console.error(error.message);process.exitCode=1;});
