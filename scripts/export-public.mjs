import {execFileSync} from 'node:child_process';
import {access,lstat,mkdir,writeFile} from 'node:fs/promises';
import {resolve,dirname,relative,isAbsolute,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const roots=new Set(['README.md','CITATION.cff','LICENSE','THIRD_PARTY_NOTICES.md','CONTRIBUTING.md','AGENTS.md','CLAUDE.md','SECURITY.md','CHANGELOG.md','.gitignore','.gitattributes','package.json','package-lock.json','tsconfig.json','playwright.config.ts']);
const guides=new Set(['SALEM.md','CITATION.md','WINDOWS.md','MODELS.md','CHECKS.md','DELIVERY.md','SUPERVISOR.md','METRICS.md','PROVENANCE.md','CONVERSATIONS.md','RELEASE-0.3.0.md','RELEASE-0.4.0.md','RELEASE-0.5.0.md','RELEASE-0.5.1.md']);
const directories=new Set(['src','ui','tests','fixtures','templates','evals','profiles','scripts','.github']);
const excluded=new Set(['scripts/demo-acceptance.mjs','scripts/demo-recovery.mjs']);
// Private external-project files stay local; matched by exact path SHA-256 so their names are not published.
const privateDigests=new Set(['00fd27001a5d2814300e407b1d5428579e8de5dec6967618dacc5b623f296855','b6a18744954afcab1a1ea25517f2e401a9ab9ace926797f3270d14fdd704f0bc']);
const pathDigest=path=>createHash('sha256').update(path).digest('hex');
function included(path,excludedDigests=privateDigests){return !excluded.has(path)&&!excludedDigests.has(pathDigest(path))&&(roots.has(path)||(path.startsWith('docs/')&&guides.has(path.slice(5)))||directories.has(path.split('/')[0]));}
function git(root,args){return execFileSync('git',args,{cwd:root,windowsHide:true,maxBuffer:25_000_000});}
export async function exportPublic({root,destination,excludedDigests=privateDigests}){
 root=resolve(root);destination=resolve(destination);
 if(destination===root)throw new Error('El destino no puede ser el origen.');
 try{await access(destination);throw new Error('El destino debe ser una carpeta nueva; ya existe.');}catch(e){if(e.code!=='ENOENT')throw e;}
 const parent=await lstat(dirname(destination));if(!parent.isDirectory()||parent.isSymbolicLink())throw new Error('La carpeta padre del destino debe ser un directorio regular.');
 const sourceCommit=git(root,['rev-parse','--verify','HEAD^{commit}']).toString().trim();
 const tree=git(root,['ls-tree','-r','-z',sourceCommit]).toString('utf8').split('\0').filter(Boolean),files=[];
 for(const item of tree){const tab=item.indexOf('\t'),path=item.slice(tab+1);if(!included(path,excludedDigests))continue;
  const mode=item.slice(0,item.indexOf(' '));if(!['100644','100755'].includes(mode))throw new Error(`Archivo público no regular: ${path}`);
  if(isAbsolute(path)||path.split('/').some(p=>!p||p==='.'||p==='..'||p.includes('\\')))throw new Error('Ruta pública inválida.');
  const output=resolve(destination,path),rel=relative(destination,output);if(rel.startsWith('..')||isAbsolute(rel))throw new Error('La ruta sale de la exportación.');
  const contents=git(root,['show',`${sourceCommit}:${path}`]);
  const text=contents.toString('utf8');
  // Defense in depth for known private locations. This is not a universal secret detector.
  if(/(?:[A-Za-z]:[\\/]+Users[\\/]+|\/home\/[^/\s]+\/|\/Users\/[^/\s]+\/)/i.test(text))throw new Error(`Ruta personal en archivo público: ${path}`);
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))throw new Error(`Clave privada en archivo público: ${path}`);
  files.push({path,contents,mode:mode==='100755'?0o755:0o644,sha256:createHash('sha256').update(contents).digest('hex')});
 }
 if(!files.some(f=>f.path==='README.md'))throw new Error('Falta README en el snapshot público.');
 const names=new Set(files.map(f=>f.path));
 for(const file of files.filter(f=>f.path.endsWith('.md'))){
  for(const match of file.contents.toString('utf8').matchAll(/\[[^\]]*\]\(<?([^\s)>]+)>?(?:\s+"[^"]*")?\)/g)){
   const raw=match[1];if(/^(?:https?:|mailto:|#)/i.test(raw))continue;
   const target=posix.normalize(posix.join(posix.dirname(file.path),decodeURIComponent(raw.split(/[?#]/)[0])));
   if(!names.has(target)&&!files.some(f=>f.path.startsWith(target.replace(/\/$/,'')+'/')))throw new Error(`Enlace a un documento fuera del snapshot público: ${file.path} → ${raw}`);
  }
 }
 await mkdir(destination);
 for(const file of files){const output=resolve(destination,file.path);await mkdir(dirname(output),{recursive:true});await writeFile(output,file.contents,{flag:'wx',mode:file.mode});}
 return {sourceCommit,files:files.map(f=>f.path),hashes:Object.fromEntries(files.map(f=>[f.path,f.sha256]))};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw new Error('Uso: node scripts/export-public.mjs <carpeta-nueva>');
 const report=await exportPublic({root:resolve(dirname(fileURLToPath(import.meta.url)),'..'),destination:process.argv[2]});
 console.log(JSON.stringify(report,null,2));
}
