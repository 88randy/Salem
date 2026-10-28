import {lstat,readFile,readdir,realpath,open,rename,unlink} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import type {EvolutionRecord,EvolutionPromotion,EvolutionSourceIdentity} from './evolution-contracts.js';
import type {ProjectRecord} from './contracts.js';
import {LocalStore} from './store.js';
import {ownedResearchPath,sourceRoot} from './research-repository.js';
import {evolutionScope,evolutionInventory,assertEvolutionFiles,parseCandidatePatch} from './evolution-policy.js';
import {evolutionAuthority} from './evolution-authority.js';
import {digest,acquireLock} from '../state-store.js';
import {repositorySnapshot} from '../repository.js';
import {runChecks,checkToolHash} from '../checks.js';
import {evaluateAcceptance,evaluateChecks} from '../acceptance.js';
import {localGit} from './git.js';
import {localError} from './validation.js';
import {redact} from '../process.js';
import {classifyRisk,singleProviderQuestion} from '../review-policy.js';

export const promotionWorking=(e:EvolutionRecord)=>!!e.promotion&&['queued','preparing','applying','verifying','rolling_back'].includes(e.promotion.status);
export function queuedPromotion():EvolutionPromotion{return {status:'queued',reason:'Aplicación local en cola.',createdAt:Date.now(),updatedAt:Date.now(),root:'',gitDir:'',head:'',indexHash:'',baseTreeHash:'',candidateTreeHash:'',entries:[],checks:[],acceptance:null};}
const agents=(e:EvolutionRecord)=>[e.agentId,e.project.config.supervisor!.roles.review];
async function current(store:LocalStore,e:EvolutionRecord){const s=await store.readState(),p=s.projects.find(p=>p.id===e.projectId),t=s.tasks.find(t=>t.id===e.taskId);if(!p||p.archived||!t||t.archived||digest({project:p,task:t.spec})!==e.policyHash)throw localError('El perfil, permisos o tarea cambiaron; inicia otro experimento.',409);const identity=await sourceIdentity(store,e.project);if(!e.sourceIdentity||digest(identity)!==digest(e.sourceIdentity))throw localError('La identidad física del origen cambió después de investigar.',409);if(!e.authorityHash||await evolutionAuthority(e.project,e.project.config.repoRoot,agents(e))!==e.authorityHash)throw localError('La autoridad cambió; la aceptación histórica no permite aplicar esta candidata.',409);return identity;}
const artifact=(store:LocalStore,e:EvolutionRecord,...parts:string[])=>ownedResearchPath(store.root,'evolution',e.id,...parts);
async function indexHash(store:LocalStore,root:string){return digest(await localGit(root,['ls-files','--stage','-v','-z'],store.root));}
export async function sourceIdentity(store:LocalStore,project:ProjectRecord):Promise<EvolutionSourceIdentity>{const root=await sourceRoot(project.config.repoRoot,store.root);if(root!==resolve(project.config.repoRoot))throw localError('La raíz original está redireccionada; identidad distinta.',409);const gitDir=await realpath(await localGit(root,['rev-parse','--absolute-git-dir'],store.root)),r=await lstat(root,{bigint:true}),g=await lstat(gitDir,{bigint:true});if(!r.isDirectory()||r.isSymbolicLink()||!g.isDirectory()||g.isSymbolicLink())throw localError('Identidad física no verificable.',409);return {root,gitDir,rootKey:`${r.dev}:${r.ino}`,gitKey:`${g.dev}:${g.ino}`};}
async function file(root:string,path:string){const target=resolve(root,path),s=await lstat(target,{bigint:true});if(!s.isFile()||s.isSymbolicLink()||await realpath(target)!==target||s.nlink!==1n)throw localError('Destino enlazado o no regular; no se escribirá.',409);return {target,bytes:await readFile(target),mode:Number(s.mode&0o777n),identity:`${s.dev}:${s.ino}`};}

/** Re-evaluate the ORIGINAL receipts and independent review; status alone is never authority. */
export async function validatePromotion(store:LocalStore,e:EvolutionRecord){
 if(e.status!=='improved'||!e.seal||!e.patch?.patch||!e.review||!e.acceptance?.accepted)throw localError('No hay una candidata actual con aceptación y respaldo verificables.',409);
 const allowed=evolutionScope(e.project,e.task),identity=await current(store,e);
 const patch=parseCandidatePatch(e.patch.patch,allowed);if(digest(patch)!==e.seal.patchHash)throw localError('La candidata cambió después de la aceptación.',409);
 const base=await ownedResearchPath(store.root,'research',e.id,e.snapshotIds.baseline,'workspace'),candidate=await ownedResearchPath(store.root,'research',e.id,e.snapshotIds.candidate,'workspace');
 await assertEvolutionFiles(base,e.seal.baseFiles,[],e.seal.baseFiles);await assertEvolutionFiles(candidate,e.seal.candidateFiles,[],e.seal.candidateFiles);
 const baseSnapshot=await repositorySnapshot(base),snapshot=await repositorySnapshot(candidate);
 if(baseSnapshot.treeHash!==e.seal.baseTreeHash||snapshot.treeHash!==e.seal.candidateTreeHash||snapshot.head!==e.sourceSha||baseSnapshot.head!==e.sourceSha)throw localError('El árbol de evidencia de la candidata cambió.',409);
 for(const change of patch.changes)if(!(await file(candidate,change.path)).bytes.equals(Buffer.from(change.content)))throw localError('Los bytes de la candidata no coinciden con el parche revisado.',409);
 // Re-check risk from the recorded diff: a high-risk repair needs a review from a provider other than the builder's.
 const risk=classifyRisk(e.task,e.diff,[e.review.payload?.risk]);if(risk.level==='high'&&e.review.provider===e.project.config.agents[e.agentId]?.provider)throw localError(singleProviderQuestion(risk),409);
 const toolHashes:Record<string,string>={};for(const c of e.project.config.checks)toolHashes[c.id]=await checkToolHash(c.command,candidate,c.toolFiles);
 const config={...e.project.config,repoRoot:candidate},fingerprint=digest({policyHash:e.policyHash,snapshot}),proof=await evaluateAcceptance(e.task,e.candidateChecks,e.review,{config,snapshot,fingerprint,evidenceRoot:await artifact(store,e,'candidate-checks'),implementationSessionId:e.patch.sessionId,toolHashes,implementationProvider:e.project.config.agents[e.agentId]?.provider??null,risk});
 const review=JSON.parse(await readFile(await artifact(store,e,'review','result.json'),'utf8'));if(!proof.accepted||digest(review)!==digest(e.review))throw localError('La evidencia de aceptación o revisión perdió su integridad.',409);
 const baselineConfig={...e.project.config,repoRoot:base},baseline=await evaluateChecks(e.task,e.baseline,{config:baselineConfig,snapshot:baseSnapshot,fingerprint:digest({config:baselineConfig,snapshot:baseSnapshot}),evidenceRoot:await artifact(store,e,'baseline-checks'),implementationSessionId:null,toolHashes});
 if(baseline.accepted||!baseline.retryable||!e.baseline.some(b=>b.status==='failed'&&b.failureKind==='code'&&e.candidateChecks.some(c=>c.checkId===b.checkId&&c.status==='passed')))throw localError('No hay evidencia íntegra de un fallo original reparado.',409);
 const root=await sourceRoot(e.project.config.repoRoot,store.root),source=await repositorySnapshot(root);
 if(source.dirty||source.head!==e.sourceSha||source.treeHash!==baseSnapshot.treeHash)throw localError('El origen cambió o no está limpio en la base aceptada; no se aplicará.',409);
 const entries:EvolutionPromotion['entries']=[];
 for(const change of patch.changes){const original=await file(root,change.path),baseFile=await file(base,change.path);if(!original.bytes.equals(baseFile.bytes)||(original.mode&0o111)!==(baseFile.mode&0o111))throw localError('El origen no coincide con el respaldo base.',409);entries.push({path:change.path,before:original.bytes.toString('base64'),after:Buffer.from(change.content).toString('base64'),mode:original.mode});}
 return {root,source,entries,toolHashes,identity};
}

async function replace(root:string,id:string,entry:EvolutionPromotion['entries'][number],content:string,expected:string){
 const original=await file(root,entry.path),{target}=original,temp=`${target}.salem-${id}.tmp`,bytes=Buffer.from(content,'base64');
 if(original.bytes.toString('base64')!==expected||original.mode!==entry.mode)throw Error('Conflicto antes de preparar el reemplazo');
 const handle=await open(temp,'wx',entry.mode);try{await handle.writeFile(bytes);await handle.chmod(entry.mode);await handle.sync();}finally{await handle.close();}
 try{const latest=await file(root,entry.path);if(latest.bytes.toString('base64')!==expected||latest.mode!==entry.mode||latest.identity!==original.identity)throw Error('Conflicto: archivo modificado mientras se preparaba el reemplazo');await rename(temp,target);if(process.platform!=='win32'){const dir=await open(dirname(target),'r');try{await dir.sync();}finally{await dir.close();}}}finally{await unlink(temp).catch(error=>{if(error.code!=='ENOENT')throw error;});}
}
async function clearTemp(root:string,id:string,entry:EvolutionPromotion['entries'][number]){const path=`${resolve(root,entry.path)}.salem-${id}.tmp`;try{const s=await lstat(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||await realpath(path)!==path)throw Error('Respaldo temporal enlazado');const bytes=(await readFile(path)).toString('base64');if(bytes!==entry.before&&bytes!==entry.after)throw Error('Temporal contiene cambios ajenos');await unlink(path);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}

/** Conservative recovery: original or proposed bytes only, never overwrite a third value. */
export async function restorePromotion(store:LocalStore,e:EvolutionRecord,reason:string):Promise<void>{
 const p=e.promotion;if(!p?.entries.length)throw localError('No hay respaldo durable para restaurar.',409);
 const save=async(status:EvolutionPromotion['status'],message:string)=>{p.status=status;p.reason=message;p.updatedAt=Date.now();await store.patchEvolution(e.id,{promotion:p});};
 try{
  const leaseRoot=await artifact(store,e,'leases');try{for(const name of await readdir(leaseRoot)){if(!/^[a-f0-9-]{36}\.json$/.test(name))throw Error('Lease inválido');const path=await artifact(store,e,'leases',name),s=await lstat(path);if(!s.isFile()||s.size>100000)throw Error('Lease inválido');const lease=JSON.parse(await readFile(path,'utf8'));if(lease.closed!==true||!Number.isSafeInteger(lease.pid)||lease.pid<=0||lease.token!==name.slice(0,-5))throw Error('Falta recibo de cierre de procesos; no se restaura');}}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  // Frozen policy validates the ORIGINAL scope even if the live profile has since changed.
  const allowed=evolutionScope(e.project,e.task);if(p.entries.some(v=>!allowed.includes(v.path))||new Set(p.entries.map(v=>v.path)).size!==p.entries.length)throw Error('Respaldo fuera del alcance original');
  const root=await sourceRoot(e.project.config.repoRoot,store.root),snapshot=await repositorySnapshot(root);
  if(!p.identity||digest(await sourceIdentity(store,e.project))!==digest(p.identity))throw Error('La identidad física del origen cambió; no se restaura otro repositorio');
  if(root!==p.root||snapshot.gitDir!==p.gitDir||snapshot.head!==p.head||await indexHash(store,root)!==p.indexHash)throw Error('La identidad, HEAD o índice del origen cambió; conserva el respaldo');
  for(const entry of p.entries){const now=await file(root,entry.path),value=now.bytes.toString('base64');if((value!==entry.after&&value!==entry.before)||now.mode!==entry.mode)throw Error(`Conflicto con cambios ajenos en ${entry.path}`);}
  await save('rolling_back',reason);
  for(const entry of p.entries){const now=await file(root,entry.path);if(![entry.before,entry.after].includes(now.bytes.toString('base64'))||now.mode!==entry.mode)throw Error(`Conflicto al restaurar ${entry.path}`);await clearTemp(root,e.id,entry);if(now.bytes.toString('base64')!==entry.before)await replace(root,e.id,entry,entry.before,entry.after);}
  for(const entry of p.entries)if((await file(root,entry.path)).bytes.toString('base64')!==entry.before)throw Error('No se confirmó la restauración');
  await save('rolled_back',`${reason} Respaldo original restaurado; no se cambió Git ni se publicaron cambios.`);
 }catch(error){await save('conflict',`${reason} Reversión detenida: ${(error as Error).message}. Respaldo conservado.`);}
}

export async function promotionLock(store:LocalStore,e:EvolutionRecord){const root=await sourceRoot(e.project.config.repoRoot,store.root),gitDir=await realpath(await localGit(root,['rev-parse','--absolute-git-dir'],store.root)),path=await ownedResearchPath(gitDir,'salem-promotion.lock'),leaseDir=await artifact(store,e,'leases');return acquireLock(path,e.id,leaseDir);}
/** A late storage/cleanup error must never replace a prepared journal with an empty queued copy. */
export async function recordPromotionFailure(store:LocalStore,initial:EvolutionRecord,error:unknown){const latest=(await store.readState()).evolutions?.find(e=>e.id===initial.id);if(!latest?.promotion)throw error;const p=latest.promotion;await store.patchEvolution(latest.id,{promotion:{...p,status:p.entries.length?'conflict':'blocked',reason:redact(`Aplicación detenida: ${(error as Error).message}. ${p.entries.length?'Respaldo conservado; reintenta la reversión.':'No se escribió código.'}`),updatedAt:Date.now()}});}
export async function applyPromotion(store:LocalStore,initial:EvolutionRecord,signal:AbortSignal){
 let e=initial;const save=async(p:EvolutionPromotion)=>{e=await store.patchEvolution(e.id,{promotion:p});};
 try{
  signal.throwIfAborted();const validated=await validatePromotion(store,e);signal.throwIfAborted();
  const p:EvolutionPromotion={status:'applying',reason:'Respaldo durable preparado; aplicando bytes revisados.',createdAt:Date.now(),updatedAt:Date.now(),root:validated.root,gitDir:validated.source.gitDir,head:validated.source.head,indexHash:await indexHash(store,validated.root),baseTreeHash:e.seal!.baseTreeHash,candidateTreeHash:e.seal!.candidateTreeHash,identity:validated.identity,entries:validated.entries,checks:[],acceptance:null};
  await save(p); // MUST precede every source write, including the first.
  for(const entry of p.entries){signal.throwIfAborted();if(digest(await sourceIdentity(store,e.project))!==digest(p.identity))throw Error('La identidad física cambió antes de escribir');const now=await file(p.root,entry.path);if(now.bytes.toString('base64')!==entry.before||now.mode!==entry.mode)throw Error('El origen cambió antes de escribir');await replace(p.root,e.id,entry,entry.after,entry.before);}
  await current(store,e);const snapshot=await repositorySnapshot(p.root);if(snapshot.head!==p.head||snapshot.treeHash!==p.candidateTreeHash)throw Error('El árbol aplicado no coincide con la candidata aceptada');
  p.status='verifying';p.reason='Verificando los mismos checks en el origen aplicado.';await save(p);
  const config=e.project.config,fingerprint=digest({promotion:e.id,policy:e.policyHash,snapshot}),evidenceRoot=await artifact(store,e,'applied-checks'),leaseDir=await artifact(store,e,'leases');
  await runChecks(config,p.head,{artifactDir:evidenceRoot,snapshot,fingerprint,signal,leaseDir,toolHashes:validated.toolHashes,onEvidence:async c=>{p.checks.push(c);await save(p);}});
  const accepted=await evaluateChecks(e.task,p.checks,{config,snapshot,fingerprint,evidenceRoot,implementationSessionId:e.patch!.sessionId,toolHashes:validated.toolHashes});p.acceptance=accepted;await save(p);
  if(!accepted.accepted)throw Error(`Fallaron los checks tras aplicar: ${accepted.reasons.join('; ')}`);
  await current(store,e);signal.throwIfAborted();if(digest(await repositorySnapshot(p.root))!==digest(snapshot))throw Error('El origen cambió después de verificar');
  p.status='applied';p.reason='Mejora aplicada con respaldo y todos los checks originales verificados.';p.updatedAt=Date.now();await save(p);
 }catch(error){const reason=(error as Error).message;e=(await store.readState()).evolutions!.find(v=>v.id===e.id)!;
  if(e.promotion?.entries.length)await restorePromotion(store,e,reason);else await store.patchEvolution(e.id,{promotion:{status:'blocked',reason,createdAt:Date.now(),updatedAt:Date.now(),root:'',gitDir:'',head:'',indexHash:'',baseTreeHash:'',candidateTreeHash:'',entries:[],checks:[],acceptance:null}});
 }
}
