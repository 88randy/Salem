import { randomUUID } from "node:crypto";
import { mkdir, readdir, realpath, lstat, open, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isInside } from "../config.js";
import type { ProjectConfig, RunState, AcceptedPredecessorEvidence } from "../contracts.js";
import { runTask, resumeRun, runFingerprint, verifyAcceptedBase, type RunnerOptions } from "../runner.js";
import {copyAcceptedTree} from './continuation.js';
import { summarizeRun } from "../metrics.js";
import { repositorySnapshot } from "../repository.js";
import { StateStore,digest } from "../state-store.js";
import { runProcess, redact } from "../process.js";
import type { ExecutionDetail, ExecutionRecord, Provider } from "./contracts.js";
import type { LocalStore } from "./store.js";
import { localDiff, localGit, localPatch, localTree } from "./git.js";
import { localError, localText, uuid } from "./validation.js";

const activeStatuses=new Set(["preparing","running"]);
const slug=(text:string)=>text.normalize("NFD").replace(/[̀-ͯ]/g,"").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"").slice(0,40).replace(/-+$/,"")||"cambio";
function providers(e:ExecutionRecord):Provider[]{return [...new Set(Object.values(e.project.config.supervisor!.roles).map(id=>e.project.config.agents[id]!.provider))];}
export class ExecutionManager {
 private active=new Map<string,{controller:AbortController;promise:Promise<void>;providers:Provider[]}>();
 private reservation:Promise<unknown>=Promise.resolve();
 private timer:NodeJS.Timeout|undefined;
 private pumping=false;private closed=false;private branching=new Set<string>();
 constructor(readonly store:LocalStore,private options:{autoStart?:boolean;canStart?:(provider:Provider)=>boolean;additionalActive?:()=>number}={}){}
 activeCount():number{return this.active.size;}
 async initialize():Promise<void>{
  const state=await this.store.readState();
  for(const e of state.executions)if(activeStatuses.has(e.status))await this.store.patchExecution(e.id,{status:"interrupted",reason:"Salem se cerró antes de confirmar el resultado. Reanuda para reconciliar el checkpoint; no se repiten acciones automáticamente."});
  if(this.options.autoStart!==false){this.timer=setInterval(()=>this.wake(),1000);this.timer.unref();this.wake();}
 }
 private serialized<T>(fn:()=>Promise<T>):Promise<T>{const next=this.reservation.then(fn);this.reservation=next.catch(()=>{});return next;}
 isBusy(provider:Provider):boolean{return [...this.active.values()].some(v=>v.providers.includes(provider));}
 isActive(id:string):boolean{return this.active.has(id);}
 async checkpoint(id:string):Promise<RunState|null>{return this.readRun(await this.store.findExecution(id));}
 async acceptedBase(id:string,options:{readOnly?:boolean}={}):Promise<NonNullable<RunnerOptions['acceptedBase']>>{
  const e=await this.store.findExecution(id);if(e.status!=='completed'||!e.workspace||this.active.has(id))throw localError('La tarea anterior no tiene un resultado confirmado.',409);
  await this.ownedWorkspace(e.workspace,e.id);const gitDir=await this.ownedPath('workspaces',e.id,'.git');if(!(await lstat(gitDir)).isDirectory())throw localError('La identidad Git de la base salió de la copia aislada.');
  const run=await this.readRun(e);if(!run||run.expected.gitDir!==gitDir)throw localError('No hay checkpoint aceptado con identidad Git válida.');
  const base={state:run,config:this.config(e),evidenceRoot:join(e.stateDir,run.id,'checks')};await verifyAcceptedBase(base,e.workspace,options);return base;
 }
 async predecessorEvidence(id:string):Promise<AcceptedPredecessorEvidence[]>{
  const state=await this.store.readState(),current=state.executions.find(e=>e.id===uuid(id));if(!current)throw localError('Ejecución no encontrada.',404);
  if(!current.continuationId)return [];
  const c=state.conversations?.find(c=>c.id===current.conversationId);if(!c)throw localError('Falta la conversación del historial.',409);
  const policy=(config:ProjectConfig)=>digest({capabilities:config.capabilities,checks:config.checks,contextFiles:config.contextFiles,instructions:config.instructions??null});
  const receipts:AcceptedPredecessorEvidence[]=[],seen=new Set<string>();let previousId:string|undefined=current.continuationId;
  while(previousId){
   if(seen.has(previousId))throw localError('El historial de continuidad contiene un ciclo.',409);seen.add(previousId);
   const e=state.executions.find(e=>e.id===previousId);
   if(!e||e.status!=='completed'||e.projectId!==current.projectId||e.conversationId!==c.id||e.project.revision!==c.project.revision||policy(e.project.config)!==policy(c.project.config)||!c.steps.some(s=>s.executionId===e.id&&s.status==='accepted'))throw localError('El historial no pertenece a los pasos aceptados de esta conversación y perfil.',409);
   // acceptedBase verifies the owned tree, checksum-bound checkpoint, actual
   // check proofs, independent review and local delivery before emitting data.
   const base=await this.acceptedBase(e.id),run=base.state,fingerprint=runFingerprint(run);
   const build=[...run.attempts].reverse().find(a=>a.stage==='build'&&a.valid)?.result,review=[...run.attempts].reverse().find(a=>a.stage==='review'&&a.valid)?.result;
   if(!build?.sessionId||!review?.sessionId||build.sessionId===review.sessionId||review.payload?.verdict!=='success'||!run.acceptance?.accepted||run.acceptance.fingerprint!==fingerprint)throw localError('El historial carece de una revisión independiente verificable.',409);
   receipts.unshift({executionId:e.id,previousExecutionId:e.continuationId??null,runId:run.id,taskId:run.task.id,profileRevision:e.project.revision,verifiedAt:Date.now(),fingerprint,repoSha:run.expected.head,treeHash:run.expected.treeHash,acceptance:structuredClone(run.acceptance),implementation:{provider:build.provider,sessionId:build.sessionId},review:{provider:review.provider,sessionId:review.sessionId,verdict:'success'},
    checks:base.config.checks.flatMap(check=>{const proof=[...(run.checks??[])].reverse().find(v=>v.checkId===check.id&&v.fingerprint===fingerprint);return proof?[{id:proof.id,checkId:proof.checkId,status:proof.status,required:check.required,relevantToAcceptance:run.acceptance!.checkIds.includes(proof.id),proofHash:proof.proofHash}]:[];}),
    integrity:{configHash:run.configHash,instructionsHash:run.instructionsHash,runtimeToolsHash:run.toolsHash,checkToolHashes:structuredClone(run.checkToolHashes??{}),projectPolicyHash:policy(e.project.config)}});
   if(Buffer.byteLength(JSON.stringify(receipts))>Math.min(100000,current.project.config.budgets.maxOutputBytes))throw localError('La evidencia histórica excede el presupuesto de contexto. Se conservan los resultados; inicia una conversación con el objetivo consolidado.',413);
   previousId=e.continuationId;
  }
  return receipts;
 }
 async startManaged(conversationId:string,taskId:string,key:string,previousId?:string):Promise<ExecutionRecord>{return this.serialized(async()=>{
  const state=await this.store.readState(),c=state.conversations?.find(c=>c.id===uuid(conversationId)),task=state.tasks.find(t=>t.id===uuid(taskId));
  const same=state.executions.find(e=>e.requestKey===key);if(same){if(same.taskId!==taskId||same.conversationId!==conversationId||same.continuationId!==previousId)throw localError('La clave pertenece a otro trabajo.',409);return same;}
  if(this.closed||!c||!task?.conversation||task.conversation.id!==c.id||task.projectId!==c.projectId)throw localError('Tarea fuera de la conversación.',409);
  const project=state.projects.find(p=>p.id===c.projectId&&!p.archived);if(!project||project.revision!==c.project.revision)throw localError('El perfil cambió. Se conservó el plan; revisa el proyecto antes de continuar.',409);
  const step=c.steps.find(s=>s.taskId===taskId);if(!step)throw localError('La tarea no pertenece al plan vigente.',409);
  const current=c.steps.filter(s=>s.key.startsWith(c.goalId+':'));
  if(current.find(s=>s.status!=='accepted')?.taskId!==taskId||previousId!==(c.lastAcceptedExecutionId??undefined)||step.planTask.dependsOn.some(id=>!current.some(s=>s.planTask.id===id&&s.status==='accepted')))throw localError('Primero deben aceptarse los pasos anteriores del plan.',409);
  if(previousId){const previous=await this.store.findExecution(previousId);if(previous.conversationId!==c.id||previous.projectId!==c.projectId)throw localError('La base pertenece a otra conversación.',409);await this.acceptedBase(previousId);}
  const frozen=structuredClone(c.project);frozen.config.supervisor!.roles.build=step.planTask.agentId;
  const goal=c.goalId?await this.store.findGoal(c.goalId):null;if(!goal?.sourceSha)throw localError('Falta la revisión investigada.');frozen.baseRef=goal.sourceSha;
  const id=randomUUID(),execution:ExecutionRecord={id,revision:1,taskId,projectId:c.projectId,conversationId:c.id,...(previousId?{continuationId:previousId}:{}),requestKey:key,createdAt:Date.now(),updatedAt:Date.now(),finishedAt:null,status:'queued',reason:null,project:frozen,task:structuredClone(task.spec),workspace:null,sourceSha:null,runId:null,stateDir:join(this.store.root,'executions',id,'runs'),setupMs:null,preparationLogs:[]};
  if(providers(execution).some(p=>this.options.canStart?.(p)===false))throw localError('La cuenta no está disponible para iniciar.',409);
  await this.store.saveExecution(execution);if(this.options.autoStart!==false)this.wake();return execution;
 });}
 async start(taskId:string,key:string,baseExecutionId?:string):Promise<ExecutionRecord>{return this.serialized(async()=>{
  if(this.closed)throw localError("Salem se está cerrando.",409);
  uuid(taskId);localText(key,"clave de solicitud",120);
  const state=await this.store.readState(),same=state.executions.find(e=>e.requestKey===key);
  if(same){if(same.taskId!==taskId||same.baseExecutionId!==baseExecutionId)throw localError("La clave ya pertenece a otra solicitud.",409);return same;}
  const task=state.tasks.find(t=>t.id===taskId&&!t.archived),project=state.projects.find(p=>p.id===task?.projectId&&!p.archived);
  if(!task||!project)throw localError("Selecciona un proyecto y una tarea activos.",404);
  if(task.conversation)throw localError('Continúa esta tarea desde su conversación para conservar dependencias y pruebas.',409);
  if(task.origin&&(task.origin.projectRevision!==project.revision||baseExecutionId))throw localError("El perfil del proyecto cambió o la base sustituye la revisión investigada. Crea un nuevo objetivo con el contexto actual.",409);
  const id=randomUUID(),execution:ExecutionRecord={id,revision:1,taskId,projectId:project.id,requestKey:key,createdAt:Date.now(),updatedAt:Date.now(),finishedAt:null,
   status:"queued",reason:null,project:structuredClone(project),task:structuredClone(task.spec),workspace:null,sourceSha:null,runId:null,
   stateDir:join(this.store.root,"executions",id,"runs"),setupMs:null,preparationLogs:[],...(baseExecutionId?{baseExecutionId:uuid(baseExecutionId)}:{})};
  if(task.origin)execution.project.baseRef=task.origin.sourceSha;
  if(providers(execution).some(p=>this.options.canStart?.(p)===false))throw localError("Espera a que termine la conexión de la cuenta antes de ejecutar.",409);
  if(baseExecutionId)await this.baseExecution(execution);
  await this.store.saveExecution(execution);if(this.options.autoStart!==false)this.wake();return execution;
 });}
 async cancel(id:string):Promise<ExecutionRecord>{return this.serialized(async()=>{
  const e=await this.store.findExecution(id),running=this.active.get(id);
  if(e.status==="completed")return e;
  if(running){running.controller.abort();return this.store.patchExecution(id,{reason:"Cancelación solicitada; esperando el cierre de los procesos propios."});}
  if(e.status==="queued")return this.store.patchExecution(id,{status:"cancelled",reason:"Cancelada antes de iniciar.",finishedAt:Date.now()});
  return e;
 });}
 async resumeManaged(id:string):Promise<ExecutionRecord>{return this.resume(id,true);}
 async resume(id:string,managed=false):Promise<ExecutionRecord>{return this.serialized(async()=>{
  const e=await this.store.findExecution(id);
  if(managed){const state=await this.store.readState(),c=state.conversations?.find(c=>c.id===e.conversationId);
   if(!c||!c.steps.some(s=>s.executionId===id&&s.key.startsWith(c.goalId+':')&&s.status!=='accepted'))throw localError('La ejecución no pertenece al paso vigente de la conversación.',409);
   if(!state.projects.some(p=>p.id===c.projectId&&!p.archived&&p.revision===c.project.revision&&p.revision===e.project.revision))throw localError('El perfil cambió. Inicia una conversación con su configuración actual; el código anterior se conserva.',409);
  }
  if(this.active.has(id)||e.status==="completed"||e.status==="queued")return e;
  if(e.conversationId&&!managed)throw localError('Continúa esta ejecución desde su conversación.',409);
  const run=await this.readRun(e,true).catch(()=>null);
  if(!run||!e.workspace)return this.store.patchExecution(id,{status:"blocked",reason:"No hay un checkpoint nativo verificable para reanudar. Conserva la evidencia; puedes repetir como una nueva ejecución aislada.",finishedAt:Date.now()});
  if(providers(e).some(p=>this.options.canStart?.(p)===false))throw localError("Espera a que termine la conexión de la cuenta.",409);
  const updated=await this.store.patchExecution(id,{runId:run.id,status:"queued",reason:"Reanudación solicitada.",finishedAt:null});
  if(this.options.autoStart!==false)this.wake();return updated;
 });}
 wake():void{if(this.closed||this.pumping)return;this.pumping=true;void this.pump().catch(()=>{}).finally(()=>{this.pumping=false;});}
 private async pump():Promise<void>{
  const state=await this.store.readState();
  for(const candidate of state.executions){
   if(this.closed)break;
   await this.serialized(async()=>{
    const current=await this.store.readState(),e=current.executions.find(item=>item.id===candidate.id);
    if(this.closed||this.active.size+(this.options.additionalActive?.()??0)>=current.settings.maxConcurrentRuns||!e||e.status!=="queued"||this.active.has(e.id)||providers(e).some(p=>this.options.canStart?.(p)===false))return;
    if(e.conversationId){const c=current.conversations?.find(c=>c.id===e.conversationId);
     if(!c||c.status!=='working'||!c.steps.some(s=>s.executionId===e.id&&s.key.startsWith(c.goalId+':')&&s.status==='running'))return;
     if(!current.projects.some(p=>p.id===c.projectId&&!p.archived&&p.revision===c.project.revision&&p.revision===e.project.revision)){await this.store.patchExecution(e.id,{status:'blocked',reason:'El perfil cambió. Inicia una conversación con su configuración actual; el código anterior se conserva.',finishedAt:Date.now()});return;}
    }
    const controller=new AbortController();
    // Reserve synchronously with the account predicate; execution starts only
    // after the active reservation is visible to cancellation and account changes.
    const promise=Promise.resolve().then(()=>this.execute(e,controller)).finally(()=>{this.active.delete(e.id);this.wake();});
    this.active.set(e.id,{controller,promise,providers:providers(e)});
   });
  }
 }
 private async baseExecution(e:ExecutionRecord):Promise<{root:string;sha:string}|null>{
  if(!e.baseExecutionId)return null;
  const previous=await this.store.findExecution(e.baseExecutionId);
  if(previous.projectId!==e.projectId||previous.status!=="completed"||!previous.workspace)throw localError("La base debe ser una entrega aceptada del mismo proyecto.");
  const run=await this.readRun(previous),sha=run?.deliveryJournal?.releaseSha??run?.deliveryJournal?.commitSha;
  if(!run||!summarizeRun(run).accepted||!sha)throw localError("La entrega seleccionada no tiene un SHA aceptado verificable.");
  await this.ownedWorkspace(previous.workspace,previous.id);return {root:previous.workspace,sha};
 }
 private async ownedPath(...parts:string[]):Promise<string>{
  const root=await realpath(this.store.root);let cursor=root;
  for(const part of parts){cursor=join(cursor,part);try{
   const info=await lstat(cursor);
   if(info.isSymbolicLink()||await realpath(cursor)!==cursor)throw localError("La ruta de ejecución contiene un enlace fuera del espacio permitido de Salem.",403);
  }catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")break;throw error;}}
  return join(root,...parts);
 }
 private async ownedWorkspace(path:string,id:string):Promise<string>{const expected=await this.ownedPath("workspaces",uuid(id)),actual=await realpath(path);if(actual!==expected)throw localError("Ruta de ejecución fuera del espacio de Salem.");return actual;}
 private async prepare(e:ExecutionRecord,signal:AbortSignal):Promise<ExecutionRecord>{
  const started=Date.now(),artifactRoot=await this.ownedPath("executions",e.id),leaseDir=join(artifactRoot,"setup-leases");
  await mkdir(artifactRoot,{recursive:true});await mkdir(await this.ownedPath("workspaces"),{recursive:true});
  const continuation=e.continuationId?await this.acceptedBase(e.continuationId):null;
  const base=continuation?{root:continuation.state.expected.root,sha:continuation.state.expected.head}:await this.baseExecution(e),source=base?.root??await realpath(e.project.config.repoRoot);
  const top=await realpath(await localGit(source,["rev-parse","--show-toplevel"],this.store.root,{signal,leaseDir}));
  if(top!==source)throw localError("El proyecto debe apuntar a la carpeta raíz de un repositorio Git.");
  const sha=await localGit(source,["rev-parse","--verify","--end-of-options",`${base?.sha??e.project.baseRef}^{commit}`],this.store.root,{signal,leaseDir});
  if(!/^[a-f0-9]{40,64}$/.test(sha))throw localError("No se pudo resolver el SHA base.");
  const workspace=await this.ownedPath("workspaces",e.id);
  e=await this.store.patchExecution(e.id,{workspace,sourceSha:sha});signal.throwIfAborted();
  await localGit(source,["clone","--local","--no-hardlinks","--dissociate","--no-checkout","--template=","--origin","salem-source","--",source,workspace],this.store.root,{signal,leaseDir});
  await localGit(workspace,["config","--local","core.hooksPath",join(this.store.root,"empty-hooks")],this.store.root,{signal,leaseDir});
  await localGit(workspace,["config","--local","core.fsmonitor","false"],this.store.root,{signal,leaseDir});
  const filters=await localGit(workspace,["config","--name-only","--get-regexp","^filter\\..*\\.(process|smudge|clean|required)$"],this.store.root,{signal,leaseDir,allowMissing:true});
  for(const key of filters.split(/\r?\n/).filter(Boolean)){
   if(!/^filter\.[A-Za-z0-9._/-]+\.(?:process|smudge|clean|required)$/.test(key))throw localError("Filtro Git no compatible con una copia aislada segura.");
   await localGit(workspace,["config","--local",key,key.endsWith(".required")?"false":""],this.store.root,{signal,leaseDir});
  }
  await localGit(workspace,["checkout","--detach",sha],this.store.root,{signal,leaseDir});
  if(continuation)await copyAcceptedTree(source,workspace);
  const remote=e.project.config.delivery?.github;
  if(remote){const names=(await localGit(workspace,["remote"],this.store.root,{signal,leaseDir})).split(/\r?\n/);
   await localGit(workspace,names.includes(remote.remote)?["remote","set-url",remote.remote,remote.remoteUrl]:["remote","add",remote.remote,remote.remoteUrl],this.store.root,{signal,leaseDir});}
  for(const [i,command] of e.project.preparation.entries()){
   signal.throwIfAborted();const result=await runProcess({command,cwd:workspace,timeoutMs:e.project.config.budgets.stageTimeoutMs,maxOutputBytes:e.project.config.budgets.maxOutputBytes,signal,leaseDir});
   const file=`preparation-${i+1}.log`;await writeFile(join(artifactRoot,file),redact(`${result.stdout}\n${result.stderr}\n${result.error??""}`),{mode:0o600});
   e=await this.store.patchExecution(e.id,{preparationLogs:[...e.preparationLogs,file]});
   if(result.status!=="exited"||result.exitCode!==0)throw localError(`Preparación ${i+1} fallida (${result.status}, salida ${result.exitCode??"desconocida"}). Consulta su log.`);
  }
  return this.store.patchExecution(e.id,{setupMs:Date.now()-started});
 }
 private config(e:ExecutionRecord):ProjectConfig{if(!e.workspace)throw localError("La copia aislada no está preparada.");return {...structuredClone(e.project.config),repoRoot:e.workspace};}
 private async execute(initial:ExecutionRecord,controller:AbortController):Promise<void>{
  let e=initial;
  try{
   if(!e.runId){await this.store.patchExecution(e.id,{status:"preparing",reason:null});controller.signal.throwIfAborted();e=await this.prepare(e,controller.signal);}
   else await this.ownedWorkspace(e.workspace!,e.id);
   controller.signal.throwIfAborted();await this.store.patchExecution(e.id,{status:"running",reason:null});
   const localOnly=Boolean(e.conversationId)||(!e.project.config.delivery&&!["commit","pull_request","merge","deploy"].some(capability=>e.project.config.capabilities[capability as keyof ProjectConfig["capabilities"]]));
   const options:RunnerOptions={stateDir:e.stateDir,signal:controller.signal,onCheckpoint:async(run:RunState)=>{await this.store.patchExecution(e.id,{runId:run.id,status:"running",reason:run.reason});},...(localOnly?{gates:{deliver:async(run:RunState)=>({id:randomUUID(),fingerprint:runFingerprint(run),verdict:run.acceptance?.accepted===true?"success" as const:"blocked" as const,evidenceRefs:(run.checks??[]).map(check=>check.artifactDir),summary:run.acceptance?.accepted===true?"Entrega local validada: código y diff conservados en la copia aislada, sin commit ni publicación.":"La entrega local requiere checks reales y revisión aceptada."})}}:{})};
   if(!e.runId&&e.continuationId)options.acceptedBase=await this.acceptedBase(e.continuationId);
   if(e.continuationId)options.predecessorEvidence=await this.predecessorEvidence(e.id);
   const result=e.runId?await resumeRun(e.runId,this.config(e),options):await runTask(e.task,this.config(e),options);
   await this.store.patchExecution(e.id,{runId:result.id,status:result.status==="completed"?"completed":result.status==="cancelled"?"cancelled":result.status==="failed"?"failed":"blocked",reason:result.reason,finishedAt:Date.now()});
  }catch(error){await this.store.patchExecution(e.id,{status:controller.signal.aborted?"cancelled":"failed",reason:controller.signal.aborted?"Ejecución cancelada; se conservaron los resultados confirmados.":`Preparación o ejecución fallida: ${redact((error as Error).message)}`,finishedAt:Date.now()});}
 }
 private async readRun(e:ExecutionRecord,discover=false):Promise<RunState|null>{
  const stateDir=await this.ownedPath("executions",uuid(e.id),"runs");
  if(resolve(e.stateDir)!==join(this.store.root,"executions",e.id,"runs"))throw localError("Checkpoint fuera del espacio permitido.",403);
  let ids=e.runId?[e.runId]:[];
  if(!ids.length&&discover){try{ids=(await readdir(stateDir)).filter(id=>/^[a-f0-9-]{36}$/.test(id));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
  if(ids.length!==1)return null;
  await this.ownedPath("executions",e.id,"runs",uuid(ids[0]),"state.json");
  const run=await new StateStore(stateDir).read(ids[0]!) as unknown as RunState;
  if(run.projectId!==e.project.config.projectId||run.task.id!==e.task.id||run.expected.root!==e.workspace)throw localError("El checkpoint no corresponde a esta ejecución.");
  return run;
 }
 async detail(id:string):Promise<ExecutionDetail>{
  const execution=await this.store.findExecution(id),run=await this.readRun(execution).catch(()=>null);
  let diff="";if(execution.workspace){try{await this.ownedWorkspace(execution.workspace,id);diff=await localDiff(execution.workspace,execution.sourceSha??"HEAD",this.store.root);}catch(error){diff=`No se pudo obtener el diff: ${redact((error as Error).message)}`;}}
  const root=await this.ownedPath("executions",uuid(id)),artifacts:{path:string;bytes:number}[]=[];
  const walk=async(dir:string):Promise<void>=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
   for(const entry of entries){if(artifacts.length>=500)break;const file=join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory())await walk(file);else if(entry.isFile()&&/\.(?:json|log|txt|md)$/.test(entry.name))artifacts.push({path:relative(root,file).replaceAll("\\","/"),bytes:(await lstat(file)).size});}};
  const metrics=run?summarizeRun(run):null;
  if(metrics){
   metrics.timing.setupMs=execution.setupMs;
   metrics.timing.totalMs=execution.setupMs!==null&&metrics.timing.wallComplete&&execution.finishedAt!==null&&["completed","failed","blocked","cancelled"].includes(execution.status)?execution.setupMs+metrics.timing.wallMs:null;
   metrics.limitations.push("Local total is measured preparation plus core wall time, including pauses between resumed invocations; queue time is excluded.");
  }
  await walk(root);return {execution,run,metrics,diff,artifacts};
 }
 /**
  * Binary-safe patch of an accepted execution against its source commit; never mutates the copy.
  * The copy must still be the tree that was accepted (Git identity and repository snapshot), before
  * and after the export, so later edits never leave Salem as if they had been reviewed.
  */
 async patch(id:string):Promise<{name:string;data:Buffer}>{
  const {e,workspace,sourceSha,unchanged}=await this.acceptedCopy(id,"exportar el parche","se exporta un parche");
  const data=await localPatch(workspace,sourceSha,this.store.root);await unchanged();
  if(!data.length)throw localError("La ejecución aceptada no tiene cambios respecto a su commit de origen.",409);
  return {name:`salem-${e.id.slice(0,8)}.patch`,data};
 }
 /** An accepted execution whose copy is still the accepted tree; unchanged() re-checks it after reading from it. */
 private async acceptedCopy(id:string,action:string,refusal:string):Promise<{e:ExecutionRecord;workspace:string;sourceSha:string;unchanged:()=>Promise<void>}>{
  const e=await this.store.findExecution(id),run=e.status==="completed"&&!this.active.has(e.id)?await this.readRun(e).catch(()=>null):null;
  if(!run||!summarizeRun(run).accepted||!e.sourceSha)throw localError(`Solo se puede ${action} de una ejecución aceptada.`,409);
  if(!e.workspace)throw localError("La ejecución no conserva una copia aislada.",410);
  try{await this.ownedWorkspace(e.workspace,e.id);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")throw localError(`La copia aislada ya no existe; no se puede ${action}.`,410);throw error;}
  const changed=`La copia aislada ya no coincide con el resultado aceptado (cambió después de la revisión o su entrega no es local); no ${refusal} sin revisar.`,workspace=e.workspace;
  let expected:string;
  try{const base=await this.acceptedBase(e.id,{readOnly:true});expected=digest(base.state.expected);}
  catch(error){if((error as {status?:number}).status===404)throw error;throw localError(`${changed} ${redact((error as Error).message)}`,409);}
  return {e,workspace,sourceSha:e.sourceSha,unchanged:async()=>{if(await repositorySnapshot(workspace,{readOnly:true}).then(digest,()=>null)!==expected)throw localError(changed,409);}};
 }
 /**
  * Creates refs/heads/<name> in the user's repository: a commit of the accepted tree whose parent is sourceSha.
  * Only objects and that new ref reach the repository (fetch, then update-ref with an empty old value so an existing
  * ref is never overwritten); HEAD, index, work tree, stash and other refs stay as they were and no hook runs there.
  */
 async branch(id:string,name?:string):Promise<{ref:string;commit:string}>{
  if(name!==undefined&&(typeof name!=="string"||!name||name.length>200||name.startsWith("-")||name.startsWith("refs/")||name.includes("..")||name.includes("@{")||/[\s\\~^:?*[\x00-\x1f\x7f]/.test(name)))throw localError("Nombre de rama inválido: usa letras, números, '/', '-', '_' o '.', sin espacios, sin '..' y sin prefijo refs/.",400);
  const current=await this.store.findExecution(id);
  if(current.branch)throw localError(`Esta ejecución ya creó la rama ${current.branch.ref} (commit ${current.branch.commit.slice(0,12)}); no se crea otra.`,409);
  if(this.branching.has(current.id))throw localError("La rama de esta ejecución ya se está creando.",409);
  this.branching.add(current.id);
  try{
   const {e,workspace,sourceSha,unchanged}=await this.acceptedCopy(id,"crear la rama","se crea una rama");
   const missing=()=>localError("No se encontró el repositorio Git del proyecto; no se creó la rama.",409);
   const repo=await realpath(e.project.config.repoRoot).catch(()=>{throw missing();}),git=(args:string[],options:{allowMissing?:boolean;env?:Record<string,string>}={})=>localGit(repo,args,this.store.root,options);
   if(await git(["rev-parse","--show-toplevel"]).then(top=>realpath(top),()=>null)!==repo)throw missing();
   const goal=await this.goalOf(e),branch=name??`salem/${slug(goal?.objective??e.task.objective)}-${e.id.slice(0,8)}`,ref=`refs/heads/${branch}`;
   if(await git(["check-ref-format","--branch",branch]).catch(()=>null)!==branch)throw localError(`Nombre de rama inválido: ${branch}.`,400);
   const [user,email]=await Promise.all(["user.name","user.email"].map(key=>git(["config","--get",key],{allowMissing:true})));
   if(!user||!email)throw localError('Tu repositorio no tiene identidad Git para el commit de la rama. Configúrala con git config user.name "Tu nombre" y git config user.email "tu@correo" en el repositorio (o con --global) y vuelve a intentarlo.',409);
   const exists=()=>localError(`La rama ${ref} ya existe en tu repositorio; elige otro nombre. No se modificó.`,409);
   if(await git(["rev-parse","--verify","--quiet",ref],{allowMissing:true}))throw exists();
   const env={GIT_AUTHOR_NAME:user,GIT_AUTHOR_EMAIL:email,GIT_COMMITTER_NAME:user,GIT_COMMITTER_EMAIL:email};
   const tree=await localTree(workspace,this.store.root);await unchanged();
   const message=`Salem: ${(goal?.objective??e.task.objective).split(/\r?\n/)[0]!.trim().slice(0,72)}\n\nResultado aceptado de la tarea ${e.task.id}.\nEjecución: ${e.id}\n${goal?`Objetivo: ${goal.id}\n`:""}Base: ${sourceSha}\n`;
   const commit=await localGit(workspace,["commit-tree",tree,"-p",sourceSha,"--no-gpg-sign","-F","-"],this.store.root,{env,input:message});
   // Objects only: no FETCH_HEAD, tags, submodules or auto-gc in the user's repository.
   await git(["-c","protocol.version=2","-c","gc.auto=0","-c","maintenance.auto=false","-c","fetch.writeCommitGraph=false","fetch","--quiet","--no-tags","--no-write-fetch-head","--no-recurse-submodules",workspace,commit]);
   try{await git(["update-ref","-m",`salem: rama del resultado aceptado ${e.id}`,ref,commit,""],{env});}
   catch(error){if(await git(["rev-parse","--verify","--quiet",ref],{allowMissing:true}))throw exists();throw error;}
   await this.store.patchExecution(e.id,{branch:{ref,commit,createdAt:Date.now()}});
   return {ref,commit};
  }finally{this.branching.delete(current.id);}
 }
 private async goalOf(e:ExecutionRecord):Promise<{id:string;objective:string}|null>{
  const state=await this.store.readState(),step=state.conversations?.find(c=>c.id===e.conversationId)?.steps.find(s=>s.executionId===e.id);
  const id=step?step.key.split(":")[0]:state.tasks.find(t=>t.id===e.taskId)?.origin?.goalId,goal=state.goals?.find(g=>g.id===id);
  return goal?{id:goal.id,objective:goal.objective}:null;
 }
 async artifact(id:string,path:string,offset=0):Promise<{text:string;truncated:boolean;nextOffset:number}>{
  await this.store.findExecution(id);localText(path,"ruta del artefacto",2000);
  if(isAbsolute(path)||path.includes("\\")||!Number.isSafeInteger(offset)||offset<0)throw localError("Ruta o desplazamiento de artefacto inválido.");
  const root=await this.ownedPath("executions",uuid(id)),target=resolve(root,path);
  if(!isInside(root,target))throw localError("La ruta del artefacto está fuera del espacio permitido.",403);
  const actual=await realpath(target);if(!isInside(root,actual)||!(/\.(?:json|log|txt|md)$/.test(actual)))throw localError("Artefacto fuera del espacio permitido.",403);
  const handle=await open(actual,"r");try{const info=await handle.stat();if(!info.isFile())throw localError("Artefacto inválido.");const buffer=Buffer.alloc(65536),{bytesRead}=await handle.read(buffer,0,buffer.length,offset);return {text:redact(buffer.subarray(0,bytesRead).toString("utf8")),truncated:offset+bytesRead<info.size,nextOffset:offset+bytesRead};}finally{await handle.close();}
 }
 async shutdown():Promise<void>{this.closed=true;if(this.timer)clearInterval(this.timer);for(const item of this.active.values())item.controller.abort();await Promise.allSettled([...this.active.values()].map(v=>v.promise));}
}
