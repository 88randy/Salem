import {mkdir,readdir,readFile,writeFile,cp,stat,rm} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createManifest,verifyPackage,safePath} from './windows/manager.mjs';
import {filesAt,assertBuildFresh,sourceSnapshot} from './windows/build-inputs.mjs';
import {download} from './windows/download.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const hash=value=>createHash('sha256').update(value).digest('hex');
const quote=value=>`'${value.replaceAll("'","''")}'`;
const args=process.argv.slice(2),options={nodeVersion:'22.23.3'};
for(let i=0;i<args.length;i++){
 const key=args[i];if(key==='--provisional'){options.provisional=true;continue;}
 if(!['--out-dir','--node-version'].includes(key)||!args[i+1])throw new Error(`Opción desconocida: ${key}`);
 options[key==='--out-dir'?'outDir':'nodeVersion']=args[++i];
}
if(process.platform!=='win32'||process.arch!=='x64')throw new Error('Este empaquetador requiere Windows x64 para compilar Setup.exe y verificar el runtime.');
if(!/^22\.\d+\.\d+$/.test(options.nodeVersion))throw new Error('Se requiere una versión oficial Node.js 22.');
function command(exe,args){const result=spawnSync(exe,args,{cwd:root,encoding:'utf8',windowsHide:true,maxBuffer:10*1024*1024});if(result.status!==0)throw new Error(result.stderr||result.stdout||result.error?.message||`Falló ${exe}`);return result.stdout.trim();}
function ps(script){return command('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);}
const packageJson=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
if(!options.provisional)await assertBuildFresh(root);
const sourceInputsBefore=await sourceSnapshot(root);
const out=await safePath(options.outDir??join(root,'.artifacts','windows-release'));
await mkdir(out,{recursive:true});
const cache=join(root,'.artifacts','windows-runtime-cache');await mkdir(cache,{recursive:true});
const runtimeFile=`node-v${options.nodeVersion}-win-x64.zip`,runtimeUrl=`https://nodejs.org/dist/v${options.nodeVersion}/`;
const sums=await download(runtimeUrl+'SHASUMS256.txt',join(cache,`v${options.nodeVersion}-SHASUMS256.txt`));
const checksum=sums.toString('utf8').split(/\r?\n/).map(s=>s.trim().split(/\s+/)).find(a=>a[1]===runtimeFile)?.[0];
if(!checksum||!/^[a-f0-9]{64}$/.test(checksum))throw new Error('No se encontró el checksum oficial del runtime.');
const runtimeZip=join(cache,runtimeFile);await download(runtimeUrl+runtimeFile,runtimeZip,{verify:bytes=>{if(hash(bytes)!==checksum)throw new Error('El runtime Node.js no coincide con SHASUMS256.txt oficial.');}});
const runtimeDir=join(cache,`node-v${options.nodeVersion}-win-x64`);
try{await stat(join(runtimeDir,'node.exe'));}catch{ps(`Expand-Archive -LiteralPath ${quote(runtimeZip)} -DestinationPath ${quote(cache)} -Force`);}
// Also verify the extracted executable against the official executable checksum.
const exeChecksum=sums.toString('utf8').split(/\r?\n/).map(s=>s.trim().split(/\s+/)).find(a=>a[1]==='win-x64/node.exe')?.[0];
if(!exeChecksum||hash(await readFile(join(runtimeDir,'node.exe')))!==exeChecksum)throw new Error('El ejecutable extraído no coincide con el checksum oficial.');
if(command(join(runtimeDir,'node.exe'),['--version'])!==`v${options.nodeVersion}`)throw new Error('Versión Node.js inesperada.');
const stage=join(out,`salem-${packageJson.version}-windows-x64${options.provisional?'-provisional':''}`);
try{await stat(stage);throw new Error(`El staging ya existe: ${stage}. Usa otro --out-dir para conservar la evidencia.`);}catch(e){if(e.code!=='ENOENT')throw e;}
await mkdir(stage,{recursive:true});await mkdir(join(stage,'runtime'));await mkdir(join(stage,'app','dist','src'),{recursive:true});
await cp(join(runtimeDir,'node.exe'),join(stage,'runtime','node.exe'));
await cp(join(runtimeDir,'LICENSE'),join(stage,'runtime','LICENSE'));
const coreFiles=(await filesAt(join(root,'dist','src'))).filter(f=>f.endsWith('.js'));
if(!coreFiles.includes('cli.js')||!coreFiles.includes('local/server.js'))throw new Error('Falta build del core. Ejecuta npm run build antes de empaquetar.');
for(const file of coreFiles){const contents=await readFile(join(root,'dist','src',file),'utf8');for(const match of contents.matchAll(/(?:from\s*|import\s*\()\s*["']([^"']+)["']/g))if(!match[1].startsWith('.')&&!match[1].startsWith('node:'))throw new Error(`Dependencia core no incluida: ${file}: ${match[1]}`);const target=join(stage,'app','dist','src',file);await mkdir(dirname(target),{recursive:true});await writeFile(target,contents);}
// Windows process containment helper: without it owned processes fail closed.
try{await cp(join(root,'dist','src','windows-job-helper.exe'),join(stage,'app','dist','src','windows-job-helper.exe'));}catch(e){if(e.code==='ENOENT')throw new Error('Falta dist/src/windows-job-helper.exe. Ejecuta npm run build en Windows antes de empaquetar.');throw e;}
await cp(join(root,'web-dist'),join(stage,'app','web-dist'),{recursive:true});
await cp(join(root,'templates'),join(stage,'app','templates'),{recursive:true});
await writeFile(join(stage,'app','package.json'),JSON.stringify({name:packageJson.name,version:packageJson.version,type:'module',engines:packageJson.engines},null,2));
await mkdir(join(stage,'windows'));
for(const name of ['manager.mjs','runtime.mjs','Launch.ps1','Uninstall.ps1'])await cp(join(root,'scripts','windows',name),join(stage,'windows',name));
for(const name of ['LICENSE','THIRD_PARTY_NOTICES.md']){try{await cp(join(root,name),join(stage,name));}catch(e){if(e.code==='ENOENT')throw new Error(`Falta ${name}: la distribución requiere licencias propias y terceros.`);throw e;}}
await cp(join(root,'docs','WINDOWS.md'),join(stage,'WINDOWS.md'));
const sourceInputs=await sourceSnapshot(root);
if(JSON.stringify(sourceInputsBefore)!==JSON.stringify(sourceInputs))throw new Error('Las fuentes cambiaron durante el empaquetado. Conserva este staging solo como evidencia y vuelve a ejecutar con fuentes estables.');
const manifest=await createManifest(stage,{version:packageJson.version,sourceRevision:command('git',['rev-parse','HEAD']),sourceTreeHash:hash(JSON.stringify(sourceInputs)),provisional:options.provisional??false,nodeVersion:options.nodeVersion,runtimeSource:runtimeUrl+runtimeFile,runtimeArchiveSha256:checksum,runtimeExecutableSha256:exeChecksum,builtAt:new Date().toISOString()});
await writeFile(join(stage,'manifest.json'),JSON.stringify(manifest,null,2));await verifyPackage(stage);
const zip=stage+'.zip';ps(`Compress-Archive -Path ${quote(join(stage,'*'))} -DestinationPath ${quote(zip)} -CompressionLevel Optimal`);
const setup=stage+'-Setup.exe',compiler=join(process.env.WINDIR??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');
command(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+',`/win32icon:${join(root,'ui','public','salem.ico')}`,'/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.IO.Compression.dll','/reference:System.IO.Compression.FileSystem.dll',`/resource:${zip},SalemPayload.zip`,`/out:${setup}`,join(root,'scripts','windows','Setup.cs')]);
if(JSON.stringify(sourceInputs)!==JSON.stringify(await sourceSnapshot(root)))throw new Error('Las fuentes cambiaron durante la compresión/compilación del instalador; no se emite un reporte de release.');
await writeFile(stage+'-SHA256SUMS.txt',`${hash(await readFile(zip))}  ${zip.split(/[\\/]/).at(-1)}\n${hash(await readFile(setup))}  ${setup.split(/[\\/]/).at(-1)}\n`);
await writeFile(join(out,'build-report.json'),JSON.stringify({product:'Salem',version:packageJson.version,buildId:manifest.buildId,sourceRevision:manifest.sourceRevision,sourceTreeHash:manifest.sourceTreeHash,provisional:manifest.provisional,zip,setup,manifest:join(stage,'manifest.json'),signed:false,nodeVersion:options.nodeVersion},null,2));
console.log(JSON.stringify({zip,setup,buildId:manifest.buildId,provisional:manifest.provisional,signed:false},null,2));
