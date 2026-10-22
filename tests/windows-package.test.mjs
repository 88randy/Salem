import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, access, cp, lstat, readdir, symlink, utimes,link,rm} from 'node:fs/promises';
import {join, resolve, parse} from 'node:path';
import {spawnSync,spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {createServer as httpServer} from 'node:http';

const packaging = await import('../scripts/windows/manager.mjs').catch(() => ({}));
const buildInputs=await import('../scripts/windows/build-inputs.mjs').catch(()=>({}));
const testRoot=resolve('.artifacts','windows-unit-tests');await mkdir(testRoot,{recursive:true});
const fixture = async version => {
  const root = await mkdtemp(join(testRoot, 'salem-package-test-'));
  const payload = join(root, 'payload');
  await mkdir(join(payload, 'runtime'), {recursive:true});
  await writeFile(join(payload, 'runtime/node.exe'), 'fixture-runtime');
  await mkdir(join(payload, 'app'), {recursive:true});
  await writeFile(join(payload, 'app/hello.txt'), version);
  const manifest = await packaging.createManifest(payload, {version, sourceRevision:'a'.repeat(40), nodeVersion:'22.23.0'});
  await writeFile(join(payload, 'manifest.json'), JSON.stringify(manifest));
  return {root,payload,manifest,installDir:join(root,'Programs With Spaces','Salem'),dataDir:join(root,'SalemData'),shortcutDir:join(root,'Shortcuts')};
};

test('package management is available without npm or application dependencies', () => {
  assert.equal(typeof packaging.installPackage, 'function', 'Windows installation behavior is missing');
});

test('Salem branding supplies a scalable favicon and real Windows icon sizes',async()=>{
 const svg=await readFile(new URL('../ui/public/salem.svg',import.meta.url),'utf8');
 assert.match(svg,/viewBox="0 0 64 64"/);
 const icon=await readFile(new URL('../ui/public/salem.ico',import.meta.url));
 assert.equal(icon.readUInt16LE(0),0);assert.equal(icon.readUInt16LE(2),1);
 const count=icon.readUInt16LE(4);assert.equal(count,9);
 const sizes=[];for(let i=0;i<count;i++){const at=6+i*16,size=icon[at]||256;sizes.push(size);assert.equal(icon[at+1]||256,size);assert.equal(icon.readUInt16LE(at+6),32);const bytes=icon.readUInt32LE(at+8),offset=icon.readUInt32LE(at+12);assert.ok(offset>=6+count*16&&offset+bytes<=icon.length);assert.equal(icon.subarray(offset,offset+8).toString('hex'),'89504e470d0a1a0a');}
 assert.deepEqual(sizes,[16,20,24,32,40,48,64,128,256]);
 const html=await readFile(new URL('../ui/index.html',import.meta.url),'utf8');assert.match(html,/rel="icon"[^>]+salem\.svg/);
});

test('Windows shortcuts use the cat icon from the verified immutable version',{skip:process.platform!=='win32'},async()=>{
 const f=await fixture('0.4.0');await mkdir(join(f.payload,'app','web-dist'),{recursive:true});
 await cp(new URL('../ui/public/salem.ico',import.meta.url),join(f.payload,'app','web-dist','salem.ico'));
 const manifest=await packaging.createManifest(f.payload,{version:'0.4.0',sourceRevision:'a'.repeat(40),nodeVersion:'22.23.0'});
 await writeFile(join(f.payload,'manifest.json'),JSON.stringify(manifest));await packaging.installPackage(f.payload,f);
 const quote=v=>`'${v.replaceAll("'","''")}'`;
 const script=`$w=New-Object -ComObject WScript.Shell; @('Salem','Salir de Salem','Desinstalar Salem') | ForEach-Object { $w.CreateShortcut((Join-Path ${quote(f.shortcutDir)} ($_+'.lnk'))).IconLocation }`;
 const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
 assert.equal(result.status,0,result.stderr);const locations=result.stdout.trim().split(/\r?\n/);assert.equal(locations.length,3);
 const expected=join(f.installDir,'versions',manifest.buildId,'app','web-dist','salem.ico')+',0';for(const location of locations)assert.equal(location.toLowerCase(),expected.toLowerCase());
});
test('final packaging refuses source newer than compiled output', async () => {
  assert.equal(typeof buildInputs.assertBuildFresh,'function','Build freshness verification is missing');
  const root=await mkdtemp(join(testRoot,'build-inputs-'));
  for(const dir of ['src','dist/src','ui','web-dist','templates','scripts/windows'])await mkdir(join(root,dir),{recursive:true});
  for(const name of ['package.json','package-lock.json','tsconfig.json'])await writeFile(join(root,name),'{}');
  await writeFile(join(root,'scripts/build.mjs'),'// fixture');await writeFile(join(root,'scripts/windows/build-inputs.mjs'),'// fixture');
  await writeFile(join(root,'src/cli.ts'),'export const fresh = false');
  await writeFile(join(root,'dist/src/cli.js'),'export const fresh = false');
  await writeFile(join(root,'ui/main.tsx'),'// ui');await writeFile(join(root,'web-dist/index.html'),'<html></html>');
  await buildInputs.writeBuildStamp(root);await buildInputs.assertBuildFresh(root);
  await writeFile(join(root,'src/cli.ts'),'export const fresh = true');
  const old=new Date('2020-01-01'),newer=new Date('2020-01-02');
  await utimes(join(root,'dist/src/cli.js'),old,old);await utimes(join(root,'src/cli.ts'),newer,newer);
  await assert.rejects(buildInputs.assertBuildFresh(root),/build|compil|desactualiz/i);
  await utimes(join(root,'dist/src/cli.js'),new Date('2030-01-01'),new Date('2030-01-01'));
  await utimes(join(root,'web-dist/index.html'),new Date('2030-01-01'),new Date('2030-01-01'));
  await writeFile(join(root,'dist/src/cli.js'),'export const fresh = true');await buildInputs.writeBuildStamp(root);
  await buildInputs.assertBuildFresh(root);
});
test('install and upgrade retain data and previous immutable version', async () => {
  const f=await fixture('0.2.0');
  await packaging.installPackage(f.payload,f);
  await mkdir(f.dataDir,{recursive:true});
  await writeFile(join(f.dataDir,'personal.json'),'personal settings');
  const first=JSON.parse(await readFile(join(f.installDir,'install.json'),'utf8'));
  await writeFile(join(f.payload,'app/hello.txt'),'upgraded');
  const second=await packaging.createManifest(f.payload,{version:'0.2.1',sourceRevision:'b'.repeat(40),nodeVersion:'22.23.0'});
  await writeFile(join(f.payload,'manifest.json'),JSON.stringify(second));
  await packaging.installPackage(f.payload,f);
  const current=JSON.parse(await readFile(join(f.installDir,'install.json'),'utf8'));
  assert.notEqual(current.current,first.current);
  assert.equal(await readFile(join(f.installDir,'versions',first.current,'app/hello.txt'),'utf8'),'0.2.0');
  assert.equal(await readFile(join(f.dataDir,'personal.json'),'utf8'),'personal settings');
  assert.equal(current.previous,first.current);
});

test('updating linked launchers never overwrites external files',async()=>{
 for(const name of ['Launch.vbs','Stop.vbs','Uninstall.vbs','Launch.ps1','Uninstall.ps1']){
  const f=await fixture('0.2.0');await packaging.installPackage(f.payload,f);
  const outside=join(f.root,'external-'+name);await writeFile(outside,'external data');
  const target=join(f.installDir,name);await rm(target);await link(outside,target);
  let rejected=false;try{await packaging.installPackage(f.payload,f);}catch(e){assert.match(e.message,/enlace|regular|hardlink|v.nculo/i);rejected=true;}
  assert.equal(await readFile(outside,'utf8'),'external data',`${name} wrote through an existing hardlink`);
  if(!rejected)assert.equal((await lstat(target)).nlink,1,'safe replacement must detach the shared inode');
 }
});

test('runtime control rejects clean EOF and truncated JSON instead of leaving an unresolved operation',async()=>{
 for(const response of ['', '{"closed":']){
  const f=await fixture('0.2.0'),pipe=process.platform==='win32'?`\\\\.\\pipe\\salem-test-${process.pid}-${Date.now()}`:join(f.root,'control.sock');
  const server=createServer(socket=>{socket.once('data',()=>socket.end(response));});await new Promise(r=>server.listen(pipe,r));
  await mkdir(f.installDir,{recursive:true});await writeFile(join(f.installDir,'running.json'),JSON.stringify({pid:process.pid,token:'fixture-token',pipe}));
  try{const result=await Promise.race([packaging.requestRuntime(f.installDir,'stop').then(()=>({unexpectedSuccess:true}),error=>({error:error.message})),new Promise(r=>setTimeout(()=>r({unresolved:true}),1000))]);assert.ok(result.error,JSON.stringify(result));assert.match(result.error,/respuesta|cerr|incomplet|EOF/i);}finally{await new Promise(r=>server.close(r));}
 }
});
test('tampered payload is rejected before installation changes', async () => {
  const f=await fixture('0.2.0');
  await writeFile(join(f.payload,'app/hello.txt'),'tampered');
  await assert.rejects(packaging.installPackage(f.payload,f), /integridad|checksum/i);
  await assert.rejects(access(join(f.installDir,'install.json')));
});
test('provisional and final payloads have distinct provenance identities', async () => {
  const f=await fixture('0.2.0');
  const provisional=await packaging.createManifest(f.payload,{version:'0.2.0',sourceRevision:'a'.repeat(40),nodeVersion:'22.23.0',provisional:true});
  const final=await packaging.createManifest(f.payload,{version:'0.2.0',sourceRevision:'a'.repeat(40),nodeVersion:'22.23.0',provisional:false});
  assert.notEqual(provisional.buildId,final.buildId,'a final release must not reuse a provisional installation identity');
});
test('live recorded process prevents upgrade and uninstall without killing it', async () => {
  const f=await fixture('0.2.0');await packaging.installPackage(f.payload,f);
  await writeFile(join(f.installDir,'running.json'),JSON.stringify({pid:process.pid,token:'not-owned'}));
  await assert.rejects(packaging.installPackage(f.payload,f), /ejecuci.n|cerrar/i);
  await assert.rejects(packaging.prepareUninstall(f.installDir), /ejecuci.n|cerrar/i);
  assert.equal(process.kill(process.pid,0),true);
});
test('a manually started Node from installation blocks update without a launcher receipt', async () => {
  const f=await fixture('0.2.0');await packaging.installPackage(f.payload,f);
  const script=join(f.installDir,'manual-process.mjs');await writeFile(script,"console.log('ready');setInterval(()=>{},1000);");
  const child=spawn(process.execPath,[script],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  await new Promise((ready,reject)=>{child.once('error',reject);child.stdout.once('data',ready);});
  try{
    await assert.rejects(packaging.installPackage(f.payload,f),/ejecuci.n|cerrar|proceso/i);
    await assert.rejects(packaging.prepareUninstall(f.installDir),/ejecuci.n|cerrar|proceso/i);
    assert.equal(process.kill(child.pid,0),true,'update must not kill an independently started process');
  }finally{const closed=new Promise(r=>child.once('exit',r));child.kill();await closed;}
});
test('data below installation and unowned installation folders are rejected', async () => {
  const f=await fixture('0.2.0');
  await assert.rejects(packaging.installPackage(f.payload,{...f,dataDir:join(f.installDir,'data')}),/datos|separad/i);
  await mkdir(f.installDir,{recursive:true});await writeFile(join(f.installDir,'unrelated.txt'),'keep');
  await assert.rejects(packaging.installPackage(f.payload,f), /ajena|vac.a|Salem/i);
  assert.equal(await readFile(join(f.installDir,'unrelated.txt'),'utf8'),'keep');
});
test('data cannot be placed inside the temporary installation payload', async()=>{
  const f=await fixture('0.2.0');
  await assert.rejects(packaging.installPackage(f.payload,{...f,dataDir:join(f.payload,'temporaryData')}),/datos|paquete|tempor/i);
});
test('manifest traversal cannot escape the package', async () => {
  const f=await fixture('0.2.0');
  f.manifest.files['../outside.txt']='0'.repeat(64);
  await writeFile(join(f.payload,'manifest.json'),JSON.stringify(f.manifest));
  await assert.rejects(packaging.installPackage(f.payload,f),/ruta|manifest|integridad/i);
});
test('a junction prevents uninstall and preserves its target', async () => {
  const f=await fixture('0.2.0');await packaging.installPackage(f.payload,f);
  await mkdir(f.dataDir,{recursive:true});await writeFile(join(f.dataDir,'keep'),'do-not-delete');
  await symlink(f.dataDir,join(f.installDir,'linked-data'),'junction');
  await assert.rejects(packaging.prepareUninstall(f.installDir),/enlace|junction|ruta/i);
  assert.equal(await readFile(join(f.dataDir,'keep'),'utf8'),'do-not-delete');
});
test('uninstall plan preserves external data and rejects modified ownership marker', async () => {
  const f=await fixture('0.2.0');await packaging.installPackage(f.payload,f);
  await mkdir(f.dataDir,{recursive:true});await writeFile(join(f.dataDir,'keep'),'keep');
  const plan=await packaging.prepareUninstall(f.installDir);
  assert.equal(plan.installDir,resolve(f.installDir));assert.equal(plan.dataDir,resolve(f.dataDir));
  assert.equal(await readFile(join(f.dataDir,'keep'),'utf8'),'keep');
  const marker=JSON.parse(await readFile(join(f.installDir,'install.json'),'utf8'));
  await writeFile(join(f.installDir,'install.json'),JSON.stringify({...marker,installDir:f.root}));
  await assert.rejects(packaging.prepareUninstall(f.installDir), /identidad|instalaci.n/i);
});

test('installed launcher starts, reuses, gracefully closes and uninstalls without deleting data', {skip:!process.env.SALEM_WINDOWS_RUNTIME_SMOKE}, async t => {
  assert.equal(typeof packaging.launchInstalled,'function','Windows launch behavior is missing');
  const f=await fixture('0.2.0');
  await cp(process.execPath,join(f.payload,'runtime/node.exe'));
  await mkdir(join(f.payload,'app/dist'),{recursive:true});
  await cp(resolve('dist/src'),join(f.payload,'app/dist/src'),{recursive:true});
  await cp(resolve('web-dist'),join(f.payload,'app/web-dist'),{recursive:true});
  await cp(resolve('templates'),join(f.payload,'app/templates'),{recursive:true});
  await writeFile(join(f.payload,'app/package.json'),' {"type":"module"}');
  await cp(resolve('scripts/windows'),join(f.payload,'windows'),{recursive:true});
  const manifest=await packaging.createManifest(f.payload,{version:'0.2.0',sourceRevision:'provisional-test-only',nodeVersion:process.versions.node,provisional:true});
  await writeFile(join(f.payload,'manifest.json'),JSON.stringify(manifest));
  const {LocalStore}=await import(pathToFileURL(join(f.payload,'app/dist/src/local/store.js')));
  const store=new LocalStore(f.dataDir);const state=await store.readState();
  const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  await store.saveSettings({...state.settings,preferredPort:port,commands:{codex:[process.execPath],claude:[process.execPath]}});
  await packaging.installPackage(f.payload,f);
  const foreign=httpServer((request,response)=>response.end('foreign-server-kept'));
  await new Promise(r=>foreign.listen(port,'127.0.0.1',r));
  await assert.rejects(packaging.launchInstalled(f.installDir,{noBrowser:true}),/no pudo iniciar|no confirmó|consulta/i);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}`)).text(),'foreign-server-kept','occupied port must not kill or reuse a foreign process');
  await new Promise(r=>foreign.close(r));
  let running=false;
  t.after(async()=>{if(running)await packaging.requestRuntime(f.installDir,'stop').catch(()=>{});});
  const app=await packaging.launchInstalled(f.installDir,{noBrowser:true});running=true;
  assert.equal(app.url,`http://127.0.0.1:${port}`);
  assert.equal(app.dataDir,resolve(f.dataDir));
  const response=await fetch(app.url+'/api/bootstrap');assert.equal(response.status,200);
  const bootstrap=await response.json();assert.equal(bootstrap.dataDir,resolve(f.dataDir));
  assert.equal((await packaging.launchInstalled(f.installDir,{noBrowser:true})).pid,app.pid,'second launch must reuse owned server');
  await assert.rejects(packaging.installPackage(f.payload,f),/ejecuci.n|cerrar/i);
  const stopped=await packaging.requestRuntime(f.installDir,'stop');assert.equal(stopped.closed,true);running=false;
  await assert.rejects(fetch(app.url),/fetch failed/i);
  await writeFile(join(f.dataDir,'personal.txt'),'must survive');
  const uninstall=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(f.installDir,'Uninstall.ps1'),'-Quiet'],{encoding:'utf8',windowsHide:true});
  assert.equal(uninstall.status,0,uninstall.stderr);
  await assert.rejects(lstat(f.installDir));
  assert.equal(await readFile(join(f.dataDir,'personal.txt'),'utf8'),'must survive');
  await assert.rejects(access(join(f.shortcutDir,'Salem.lnk')));
});

test('Setup.exe installs and upgrades silently with bundled runtime and preserves user data on uninstall', {skip:!process.env.SALEM_WINDOWS_SETUP}, async t => {
  const root=await mkdtemp(join(testRoot,'setup-smoke-'));
  const installDir=join(root,'Programs With Spaces','Salem'),dataDir=join(root,'Data With Spaces'),shortcutDir=join(root,'Shortcuts'),temp=join(root,'Temp');
  await mkdir(temp,{recursive:true});
  const setup=resolve(process.env.SALEM_WINDOWS_SETUP);
  const setupArgs=['--silent','--install-dir',installDir,'--data-dir',dataDir,'--shortcut-dir',shortcutDir];
  const runSetup=exe=>spawnSync(exe,setupArgs,{encoding:'utf8',windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp},timeout:120000});
  const rejectedRoot=join(root,'RejectedRoot');
  const guardedSetup=process.env.SALEM_WINDOWS_UPGRADE_SETUP?resolve(process.env.SALEM_WINDOWS_UPGRADE_SETUP):setup;
  const invalid=spawnSync(guardedSetup,['--silent','--install-dir',rejectedRoot,'--data-dir',parse(root).root,'--shortcut-dir',shortcutDir],{encoding:'utf8',windowsHide:true,env:{...process.env,TEMP:temp,TMP:temp},timeout:120000});
  assert.notEqual(invalid.status,0,'a drive root must not be rewritten as a relative data path by argument quoting');
  await assert.rejects(access(join(rejectedRoot,'install.json')));
  let result=runSetup(setup);assert.equal(result.status,0,result.stderr||String(result.error));
  const initial=JSON.parse(await readFile(join(installDir,'install.json'),'utf8'));
  const versionDir=join(installDir,'versions',initial.current),runtime=join(versionDir,'runtime/node.exe'),manager=join(versionDir,'windows/manager.mjs');
  const {LocalStore}=await import(pathToFileURL(join(versionDir,'app/dist/src/local/store.js')));
  const store=new LocalStore(dataDir),state=await store.readState();
  const portServer=createServer();await new Promise(r=>portServer.listen(0,'127.0.0.1',r));const port=portServer.address().port;await new Promise(r=>portServer.close(r));
  await store.saveSettings({...state.settings,preferredPort:port,commands:{codex:[runtime],claude:[runtime]}});
  await writeFile(join(dataDir,'retain.txt'),'personal-data');
  result=spawnSync(runtime,[manager,'launch','--install-dir',installDir,'--no-browser'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr);
  const app=JSON.parse(result.stdout);let running=true;
  t.after(async()=>{if(running)spawnSync(runtime,[manager,'stop','--install-dir',installDir],{windowsHide:true,timeout:60000});});
  assert.equal((await fetch(app.url)).status,200);
  assert.notEqual(runSetup(setup).status,0,'Setup must refuse updating an active installation');
  const closed=spawnSync('wscript.exe',[join(installDir,'Stop.vbs')],{encoding:'utf8',windowsHide:true,timeout:60000});assert.equal(closed.status,0,closed.stderr);running=false;
  await assert.rejects(fetch(app.url),/fetch failed/i);
  result=runSetup(process.env.SALEM_WINDOWS_UPGRADE_SETUP?resolve(process.env.SALEM_WINDOWS_UPGRADE_SETUP):setup);assert.equal(result.status,0,result.stderr||String(result.error));
  const updated=JSON.parse(await readFile(join(installDir,'install.json'),'utf8'));
  if(process.env.SALEM_WINDOWS_UPGRADE_SETUP){assert.notEqual(updated.current,initial.current);assert.equal(updated.previous,initial.current);await access(versionDir);}
  assert.equal(await readFile(join(dataDir,'retain.txt'),'utf8'),'personal-data');
  result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(installDir,'Uninstall.ps1'),'-Quiet'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.error?.message||`signal=${result.signal}`);await assert.rejects(access(installDir));
  assert.equal(await readFile(join(dataDir,'retain.txt'),'utf8'),'personal-data');
  assert.deepEqual((await readdir(shortcutDir)).filter(f=>f.endsWith('.lnk')),[]);
  const evidence={setup,upgradeSetup:process.env.SALEM_WINDOWS_UPGRADE_SETUP??setup,initialVersion:initial.current,updatedVersion:updated.current,dataPreserved:true,uninstalled:true,port,root};
  await writeFile(join(root,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(`Windows Setup evidence: ${join(root,'evidence.json')}`);
});

test('Setup.exe accepts a real short TEMP alias and preserves data on uninstall', {skip:!process.env.SALEM_WINDOWS_SETUP}, async t => {
  const root=await mkdtemp(join(testRoot,'setup-short-temp-')),temp=join(root,'Temporary Folder');
  await mkdir(temp,{recursive:true});
  const script=`Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public static class SalemShortTemp { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern uint GetShortPathName(string name,StringBuilder output,uint size); }
'@
$buffer=New-Object Text.StringBuilder 32768; $length=[SalemShortTemp]::GetShortPathName('${temp.replaceAll("'","''")}',$buffer,32768); if($length -eq 0){throw 'Cannot obtain short TEMP path'}; $buffer.ToString()`;
  const short=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true});
  assert.equal(short.status,0,short.stderr);const shortTemp=short.stdout.trim();
  if(shortTemp.toLowerCase()===resolve(temp).toLowerCase()){t.skip('The test volume does not provide 8.3 aliases');return;}
  const setup=resolve(process.env.SALEM_WINDOWS_UPGRADE_SETUP??process.env.SALEM_WINDOWS_SETUP),installDir=join(root,'Programs','Salem'),dataDir=join(root,'Data'),shortcuts=join(root,'Shortcuts');
  const run=(where,target)=>spawnSync(setup,['--silent','--install-dir',target,'--data-dir',dataDir,'--shortcut-dir',shortcuts],{encoding:'utf8',windowsHide:true,timeout:120000,env:{...process.env,TEMP:where,TMP:where}});
  let result=run(shortTemp,installDir);
  assert.equal(result.status,0,result.stderr||result.error?.message||'Setup rejected a real short TEMP alias');
  await access(join(installDir,'install.json'));await mkdir(dataDir,{recursive:true});await writeFile(join(dataDir,'retain.txt'),'keep');
  result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(installDir,'Uninstall.ps1'),'-Quiet'],{encoding:'utf8',windowsHide:true,timeout:60000});
  assert.equal(result.status,0,result.stderr||result.error?.message);await assert.rejects(access(installDir));assert.equal(await readFile(join(dataDir,'retain.txt'),'utf8'),'keep');
  console.log('Windows Setup short TEMP alias and data preservation checks passed');
});
