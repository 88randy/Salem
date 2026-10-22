import {createHash} from 'node:crypto';
import {lstat,readFile,readdir,realpath} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {checkInputs} from '../check-inputs.js';
import {digest} from '../state-store.js';
import type {ProjectRecord} from './contracts.js';
import type {TaskSpec} from '../contracts.js';
import type {CandidatePatch} from './evolution-contracts.js';
import {localError,localText,record} from './validation.js';
import {runProcess} from '../process.js';

const reserved=/(^|\/)(?:\.[^/]+|AGENTS\.md|CLAUDE\.md|CONTRIBUTING\.md|package(?:-lock)?\.json|[^/]*lock[^/]*|[^/]*(?:test|spec|check|acceptance|permission|polic|contract|config|runner|supervisor|owned-process|guardian)[^/]*)(?:\/|$)/i;
const frameworkAuthority=/^(?:templates\/|scripts\/|src\/adapters\/|src\/(?:acceptance|checks|check-inputs|config|contracts|runner|process|owned-process|process-host|process-guardian|state-store|repository|review-context|metrics|delivery[^/]*)\.ts$|src\/local\/(?:accounts|server|store|executions|goals|planning|git|research-repository|validation|evolution[^/]*)\.ts$)/i;
function identity(root:string,path:string){const value=relative(resolve(root),resolve(root,path.replace(/\\/g,'/'))).replace(/\\/g,'/');if(value==='..'||value.startsWith('../')||isAbsolute(value)||!value)throw localError('El verificador requiere entradas locales dentro del snapshot.');return process.platform==='win32'?value.toLowerCase():value;}
function verifierInputs(project:ProjectRecord){return project.config.checks.flatMap(c=>{let inferred:string[]=[];try{inferred=checkInputs(c.command);}catch{}const inputs=[...new Set([...inferred,...checkInputs(c.command,c.toolFiles)])];if(!inputs.length)throw localError('El verificador necesita un script local o toolFiles explícitos verificables.');for(const p of inputs)if(isAbsolute(p)||/^[a-z]:/i.test(p)||p.replace(/\\/g,'/').split('/').includes('..'))throw localError('El verificador requiere entradas locales, sin rutas externas ni escapes.');return inputs;});}
export async function validateEvolutionChecks(project:ProjectRecord,root:string,files:Record<string,string>){for(const input of verifierInputs(project)){const name=identity(root,input),path=resolve(root,input);if(!Object.keys(files).some(f=>identity(root,f)===name))throw localError('El verificador local no existe en el snapshot.');const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||await realpath(path)!==path)throw localError('El verificador debe ser un archivo local regular sin enlaces.');}}
export function evolutionScope(project:ProjectRecord,task:TaskSpec):string[]{
 const c=project.config;
 if(!c.capabilities.edit||Object.entries(c.capabilities).some(([k,v])=>k!=='edit'&&v)||c.delivery||project.preparation.length)throw localError('La evolución requiere un perfil local con edit y sin permisos de commit/publicación, delivery ni preparación.');
 if(!c.checks.length||c.checks.some(check=>!check.required||check.mode==='dry_run'||check.notApplicableReason))throw localError('La evolución necesita checks requeridos de ejecución real.');
 const protectedPaths=new Set([...c.contextFiles,...verifierInputs(project)].map(p=>identity(c.repoRoot,p)));
 if(!task.acceptance.length||task.acceptance.some(a=>!task.acceptanceChecks?.[a]?.length))throw localError('La tarea necesita criterios y mapas de aceptación existentes.');
 for(const path of task.scope){if(!path||/[\\:*?\[\]{}\x00-\x1f]/.test(path)||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..')||reserved.test(path)||frameworkAuthority.test(path)||protectedPaths.has(identity(c.repoRoot,path)))throw localError(`Archivo protegido o alcance ambiguo: ${path}`);}
 return [...new Set(task.scope)];
}
/** Includes ignored files. Links and special files never become writable candidates. */
export async function evolutionInventory(root:string):Promise<Record<string,string>>{
 const files:Record<string,string>=Object.create(null) as Record<string,string>;let bytes=0,count=0;
 const visit=async(dir:string,prefix:string)=>{for(const name of (await readdir(dir)).sort()){
  if(prefix===''&&name==='.git')continue;const path=prefix?`${prefix}/${name}`:name,full=join(dir,name),s=await lstat(full);
  if(++count>20000)throw localError('Inventario de evolución excede 20000 entradas.');
  if(s.isSymbolicLink())throw localError('La evolución no admite enlaces en la copia de prueba.');
  if(s.isDirectory())await visit(full,path);else if(s.isFile()){bytes+=s.size;if(bytes>100_000_000||s.size>20_000_000)throw localError('Inventario de evolución excede su presupuesto.');files[path]=createHash('sha256').update(`${s.mode&0o111}:`).update(await readFile(full)).digest('hex');}else throw localError('Entrada de evolución no soportada.');
 }};await visit(await realpath(root),'');
 const gitRoot=join(root,'.git'),gitInfo=await lstat(gitRoot);if(!gitInfo.isDirectory()||gitInfo.isSymbolicLink()||await realpath(gitRoot)!==gitRoot)throw localError('Metadata Git enlazada o inválida.');
 for(const name of await readdir(gitRoot)){if(['index','logs','FETCH_HEAD','ORIG_HEAD','COMMIT_EDITMSG'].includes(name))continue;const path=join(gitRoot,name),s=await lstat(path);if(s.isSymbolicLink())throw localError('Enlace en metadata Git.');if(s.isDirectory())await visit(path,`.git/${name}`);else if(s.isFile())files[`.git/${name}`]=digest(await readFile(path));else throw localError('Metadata Git no soportada.');}
 const index=await lstat(join(gitRoot,'index'));if(!index.isFile()||index.isSymbolicLink())throw localError('Índice Git inválido.');
 const semantic=await runProcess({command:['git','--no-optional-locks','-c','core.fsmonitor=false','ls-files','--stage','-v','-z'],cwd:root,timeoutMs:10000,maxOutputBytes:2_000_000});if(semantic.status!=='exited'||semantic.exitCode!==0)throw localError('No se pudo verificar el índice Git.');files['.git/<semantic-index>']=digest(semantic.stdout);
 return files;
}
export async function assertEvolutionFiles(root:string,before:Record<string,string>,allowed:string[],exact?:Record<string,string>):Promise<Record<string,string>>{
 const after=await evolutionInventory(root),writable=new Set(allowed);
 for(const path of new Set([...Object.keys(before),...Object.keys(after)]))if((!writable.has(path)||exact)&&after[path]!== (exact??before)[path])throw localError(`Archivo protegido o cambio no autorizado: ${path}`);
 return after;
}
export function parseCandidatePatch(value:unknown,allowed:string[]):CandidatePatch{
 const r=record(value,['schemaVersion','summary','changes']);if(r.schemaVersion!==1||!Array.isArray(r.changes)||!r.changes.length||r.changes.length>40)throw localError('Propuesta de código inválida.');
 const seen=new Set<string>();let bytes=0;
 const changes=r.changes.map(value=>{const c=record(value,['path','content']),path=localText(c.path,'archivo',8192);if(!allowed.includes(path)||seen.has(path)||typeof c.content!=='string'||c.content.includes('\0'))throw localError(`Propuesta fuera del alcance autorizado: ${path}`);seen.add(path);bytes+=Buffer.byteLength(c.content);if(bytes>1_000_000)throw localError('La propuesta excede 1 MiB.');return {path,content:c.content};});
 return {schemaVersion:1,summary:localText(r.summary,'resumen',16000),changes};
}
export async function applyCandidate(root:string,before:Record<string,string>,allowed:string[],patch:CandidatePatch):Promise<void>{
 const validated=parseCandidatePatch(patch,allowed);await assertEvolutionFiles(root,before,[],before);
 const {writeFile}=await import('node:fs/promises');
 for(const change of validated.changes){if(!Object.hasOwn(before,change.path))throw localError('La candidata solo modifica archivos existentes.');const target=resolve(root,change.path);if(await realpath(target)!==target||(await lstat(target)).isSymbolicLink())throw localError('Archivo de candidata enlazado.');await writeFile(target,change.content);}
}
