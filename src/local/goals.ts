import { randomUUID } from "node:crypto";
import { open, readFile, readdir, lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { atomicJson, digest } from "../state-store.js";
import { repositorySnapshot,repositoryFiles } from "../repository.js";
import type {RunnerOptions} from '../runner.js';
import {copyAcceptedTree} from './continuation.js';
import { redact } from "../process.js";
import type { Provider } from "./contracts.js";
import type { GoalAttempt, GoalRecord, GoalRequest } from "./research-contracts.js";
import { LocalStore } from "./store.js";
import { createResearchSnapshot, ownedResearchPath, pinnedInventory, sourceRoot } from "./research-repository.js";
import { runPlanning } from "./planning.js";
import { localGit } from "./git.js";
import { localError, localText, record, uuid } from "./validation.js";

export class GoalManager {
 private active=new Map<string,{controller:AbortController;promise:Promise<void>;provider:Provider}>();
 private quarantined=new Map<string,Provider>();
 private reservation:Promise<unknown>=Promise.resolve();private timer:NodeJS.Timeout|undefined;private closed=false;private pumping=false;
 constructor(readonly store:LocalStore,private options:{autoStart?:boolean;canStart?:(provider:Provider)=>boolean;additionalActive?:()=>number;acceptedBase?:(id:string)=>Promise<NonNullable<RunnerOptions['acceptedBase']>>}={}){}
 isActive(id:string):boolean{return this.active.has(id);}
 activeCount():number{return new Set([...this.active.keys(),...this.quarantined.keys()]).size;}
 hasUnconfirmed(provider:Provider):boolean{return [...this.quarantined.values()].includes(provider);}
 isBusy(provider:Provider):boolean{return this.hasUnconfirmed(provider)||[...this.active.values()].some(v=>v.provider===provider);}
 private serialized<T>(fn:()=>Promise<T>):Promise<T>{const next=this.reservation.then(fn);this.reservation=next.catch(()=>{});return next;}
 async initialize():Promise<void>{
  for(const g of (await this.store.readState()).goals??[]){
   const problem=await this.refreshLeaseState(g);
   if(problem&&g.status!=="investigating")await this.store.patchGoal(g.id,{status:g.status==="materialized"?"materialized":"blocked",reason:problem});
   if(g.status==="investigating")await this.store.patchGoal(g.id,{status:problem?"blocked":"interrupted",reason:problem??"La investigación se interrumpió. Se conservó su evidencia; reintenta explícitamente para iniciar otro intento.",finishedAt:Date.now(),attempts:g.attempts.map(a=>a.status==="running"?{...a,status:"interrupted",finishedAt:Date.now(),error:"Cierre antes de confirmar el plan."}:a)});
  }
  if(this.options.autoStart!==false){this.timer=setInterval(()=>this.wake(),1000);this.timer.unref();this.wake();}
 }
 async start(input:GoalRequest):Promise<GoalRecord>{return this.serialized(async()=>{
  if(this.closed)throw localError("Salem se está cerrando.",409);const r=record(input,["projectId","objective","agentId","requestKey","conversational","baseExecutionId"]);
  if(r.conversational!==undefined&&typeof r.conversational!=='boolean')throw localError('Modo de investigación inválido.');
  const baseExecutionId=r.baseExecutionId===undefined?undefined:uuid(r.baseExecutionId);
  if(baseExecutionId&&!r.conversational)throw localError('Esta base requiere una conversación.');
  const projectId=uuid(r.projectId),objective=localText(r.objective,"objetivo",r.conversational?200000:20000).trim(),key=localText(r.requestKey,"clave de solicitud",120);
  const state=await this.store.readState(),project=state.projects.find(p=>p.id===projectId&&!p.archived);if(!project)throw localError("Selecciona un proyecto activo.",404);
  const agentId=r.agentId===undefined?project.config.supervisor!.roles.define:localText(r.agentId,"agente",64),agent=project.config.agents[agentId];if(!agent)throw localError("Selecciona un agente del proyecto.");
  const same=state.goals?.find(g=>g.requestKey===key);if(same){if(same.projectId!==projectId||same.objective!==objective||same.agentId!==agentId||Boolean(same.conversational)!==Boolean(r.conversational)||same.baseExecutionId!==baseExecutionId)throw localError("La clave pertenece a otro objetivo.",409);return same;}
  if(this.options.canStart?.(agent.provider)===false)throw localError("Espera a que termine la conexión de la cuenta.",409);
  if(this.hasUnconfirmed(agent.provider))throw localError("La limpieza de un proceso anterior no está confirmada. Conserva sus recibos y resuelve el cierre antes de iniciar otra investigación.",409);
  const base=baseExecutionId?await this.options.acceptedBase?.(baseExecutionId):null;
  if(baseExecutionId&&!base)throw localError('No se pudo verificar la base aceptada.');
  if(base&&base.state.projectId!==project.config.projectId)throw localError('La base pertenece a otro proyecto.');
  const root=await sourceRoot(project.config.repoRoot,this.store.root),sourceSha=base?.state.expected.head??await localGit(root,["rev-parse","--verify","--end-of-options",`${project.baseRef}^{commit}`],this.store.root);
  if(!/^[a-f0-9]{40,64}$/.test(sourceSha))throw localError("No se pudo resolver la revisión del objetivo.");
  const goal:GoalRecord={id:randomUUID(),revision:1,projectId,requestKey:key,objective,agentId,project:structuredClone(project),sourceSha,status:"queued",createdAt:Date.now(),updatedAt:Date.now(),finishedAt:null,reason:null,answers:[],attempts:[],plan:null,createdTaskId:null};
  if(r.conversational)goal.conversational=true;if(baseExecutionId)goal.baseExecutionId=baseExecutionId;
  const saved=await this.store.saveGoal(goal);if(this.options.autoStart!==false)this.wake();return saved;
 });}
 async cancel(id:string):Promise<GoalRecord>{return this.serialized(async()=>{
  const g=await this.store.findGoal(id),active=this.active.get(id);
  if(g.status==="queued")return this.store.patchGoal(id,{status:"cancelled",finishedAt:Date.now(),reason:"Cancelado antes de iniciar."});
  if(active&&g.status==="investigating"){active.controller.abort();return this.store.patchGoal(id,{reason:"Cancelación solicitada; esperando el cierre del agente."});}return g;
 });}
 async retry(id:string,revision:number):Promise<GoalRecord>{return this.serialized(async()=>{
  const g=await this.store.findGoal(id);if(!["failed","blocked","cancelled","interrupted"].includes(g.status))throw localError("Este objetivo no puede reintentarse en su estado actual.",409);
  const problem=await this.refreshLeaseState(g);if(problem)throw localError(problem,409);
  if(this.options.canStart?.(g.project.config.agents[g.agentId]!.provider)===false)throw localError("Espera a que termine la conexión de la cuenta.",409);
  const saved=await this.store.patchGoal(id,{status:"queued",finishedAt:null,reason:null,plan:null},revision);if(this.options.autoStart!==false)this.wake();return saved;
 });}
 async answer(id:string,revision:number,text:string):Promise<GoalRecord>{return this.serialized(async()=>{
  const g=await this.store.findGoal(id);if(g.status!=="needs_input")throw localError("El objetivo no tiene preguntas pendientes.",409);
  if(this.options.canStart?.(g.project.config.agents[g.agentId]!.provider)===false)throw localError("Espera a que termine la conexión de la cuenta.",409);
  const answer=localText(text,"respuesta",20000).trim();if(g.answers.length>=20)throw localError("Se alcanzó el límite de aclaraciones. Crea un objetivo con el contexto consolidado.",409);
  const problem=await this.refreshLeaseState(g);if(problem)throw localError(problem,409);
  const saved=await this.store.patchGoal(id,{status:"queued",finishedAt:null,reason:null,answers:[...g.answers,{at:Date.now(),text:answer,questions:[...(g.plan?.questions??[])]}]},revision);if(this.options.autoStart!==false)this.wake();return saved;
 });}
 wake():void{if(this.closed||this.pumping)return;this.pumping=true;void this.pump().catch(()=>{}).finally(()=>{this.pumping=false;});}
 private async pump():Promise<void>{
  for(const id of this.quarantined.keys())await this.refreshLeaseState(await this.store.findGoal(id));
  for(const candidate of (await this.store.readState()).goals??[]){if(this.closed)break;await this.serialized(async()=>{
   const state=await this.store.readState(),goal=state.goals?.find(g=>g.id===candidate.id);if(!goal||goal.status!=="queued"||this.closed||this.active.has(goal.id)||this.activeCount()+(this.options.additionalActive?.()??0)>=state.settings.maxConcurrentRuns)return;
   if(goal.conversational&&!state.conversations?.some(c=>c.goalId===goal.id&&c.status==='planning'))return;
   const provider=goal.project.config.agents[goal.agentId]!.provider;if(this.options.canStart?.(provider)===false||this.hasUnconfirmed(provider))return;
   const controller=new AbortController(),promise=Promise.resolve().then(()=>this.execute(goal,controller.signal)).finally(async()=>{
     try{const latest=await this.store.findGoal(goal.id),problem=await this.refreshLeaseState(latest);if(problem)await this.store.patchGoal(goal.id,{status:"blocked",plan:null,reason:problem});}
     catch{this.quarantined.set(goal.id,provider);}
     finally{this.active.delete(goal.id);this.wake();}
   });this.active.set(goal.id,{controller,promise,provider});
  });}
 }
 private async refreshLeaseState(goal:GoalRecord):Promise<string|null>{
  let problem:string|null=null;
  try{for(const attempt of goal.attempts){
   const dir=await ownedResearchPath(this.store.root,"research",uuid(goal.id),uuid(attempt.id),"leases");let names:string[];
   try{names=await readdir(dir);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
   if(names.length>2000)throw localError("Demasiados recibos de proceso para verificar la limpieza.");
   for(const name of names){if(!name.endsWith(".json"))continue;const token=uuid(name.slice(0,-5)),file=await ownedResearchPath(this.store.root,"research",goal.id,attempt.id,"leases",name),info=await lstat(file);
    if(!info.isFile()||info.size>8192)throw localError("Recibo de proceso inválido.");const lease=JSON.parse(await readFile(file,"utf8")) as {pid:number;token:string;closed:boolean};
    if(!Number.isSafeInteger(lease.pid)||lease.pid<=0||lease.token!==token||lease.closed!==true)throw localError("Falta confirmar la limpieza de un proceso anterior; se necesita su recibo de cierre o una inspección.");
   }
  }}catch(error){problem=redact((error as Error).message);}
  const provider=goal.project.config.agents[goal.agentId]!.provider;if(problem)this.quarantined.set(goal.id,provider);else this.quarantined.delete(goal.id);return problem;
 }
 private async execute(initial:GoalRecord,signal:AbortSignal):Promise<void>{
  let goal=initial;const attempt:GoalAttempt={id:randomUUID(),startedAt:Date.now(),finishedAt:null,status:"running",error:null,usage:null,sessionId:null,durationMs:null};
  try{
   goal=await this.store.patchGoal(goal.id,{status:"investigating",reason:null,plan:null,attempts:[...goal.attempts,attempt]});signal.throwIfAborted();
   const base=goal.baseExecutionId?await this.options.acceptedBase?.(goal.baseExecutionId):null;
   if(goal.baseExecutionId&&!base)throw localError('No se pudo verificar la base aceptada.');
   const researchProject=base?{...goal.project,config:{...goal.project.config,repoRoot:base.state.expected.root}}:goal.project;
   const snapshot=await createResearchSnapshot(researchProject,this.store.root,goal.id,attempt.id,goal.sourceSha,signal);
   if(base){await copyAcceptedTree(base.state.expected.root,snapshot.root);const files=[];for(const path of await repositoryFiles(snapshot.root)){try{if((await lstat(join(snapshot.root,path))).isFile())files.push(path);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}snapshot.evidenceFiles=files;snapshot.files=files.slice(0,1000);snapshot.truncated=files.length>1000;}
   const artifactDir=await ownedResearchPath(this.store.root,"research",goal.id,attempt.id),leaseDir=await ownedResearchPath(this.store.root,"research",goal.id,attempt.id,"leases");
   const before=await repositorySnapshot(snapshot.root);if(before.head!==goal.sourceSha||(!base&&before.dirty))throw localError("La copia no coincide con la revisión investigada.");
   const result=await runPlanning({goalId:goal.id,attemptId:attempt.id,sourceSha:snapshot.sourceSha,project:goal.project,agentId:goal.agentId,objective:goal.objective,answers:goal.answers,snapshot,artifactDir,leaseDir,conversational:goal.conversational??false},signal);
   const after=await repositorySnapshot(snapshot.root),intact=before.head===after.head&&before.treeHash===after.treeHash&&before.dirty===after.dirty;
   await atomicJson(join(artifactDir,"integrity.json"),{before,after,intact});
   attempt.finishedAt=Date.now();attempt.durationMs=result.durationMs;attempt.usage=result.usage;attempt.sessionId=result.sessionId;attempt.status=result.status;attempt.error=result.error;
   if(!intact){attempt.status="failed";attempt.error="La investigación modificó archivos o la identidad Git; el plan fue rechazado por violar el modo de lectura.";}
   if(signal.aborted){attempt.status="cancelled";attempt.error="Investigación cancelada.";}
   const status=attempt.status==="succeeded"&&result.plan?result.plan.verdict:attempt.status==="cancelled"?"cancelled":"failed";
   await this.store.patchGoal(goal.id,{status,plan:status==="ready"||status==="needs_input"||status==="blocked"||status==='answered'?result.plan:null,reason:attempt.error,finishedAt:Date.now(),attempts:[...goal.attempts.slice(0,-1),attempt]});
  }catch(error){attempt.finishedAt=Date.now();attempt.durationMs=Date.now()-attempt.startedAt;attempt.status=signal.aborted?"cancelled":"failed";attempt.error=signal.aborted?"Investigación cancelada; se conservó la evidencia.":redact((error as Error).message);
   await this.store.patchGoal(goal.id,{status:signal.aborted?"cancelled":"failed",reason:attempt.error,finishedAt:Date.now(),plan:null,attempts:[...goal.attempts.filter(a=>a.id!==attempt.id),attempt]});
  }
 }
 async materialize(id:string,revision:number){return this.serialized(async()=>{
  const goal=await this.store.findGoal(id);if(goal.createdTaskId)return this.store.materializeGoal(id,revision,[]);
  if(goal.conversational)throw localError('Las tareas de este objetivo se gestionan desde su conversación.',409);
  const verified=await this.verifiedPlan(id);return this.store.materializeGoal(id,revision,verified.files);
 });}
 async verifiedPlan(id:string){
  const goal=await this.store.findGoal(id);
  if(goal.status!=="ready"||!goal.sourceSha)throw localError("El plan no está listo o tiene preguntas pendientes.",409);
  const attempt=goal.attempts.at(-1);if(!attempt||attempt.status!=="succeeded")throw localError("No hay un intento válido para crear la tarea.",409);
  const root=await ownedResearchPath(this.store.root,"research",goal.id,uuid(attempt.id),"workspace"),integrityPath=await ownedResearchPath(this.store.root,"research",goal.id,attempt.id,"integrity.json");
  const integrity=JSON.parse(await readFile(integrityPath,"utf8")) as {intact:boolean;after:{treeHash:string;head:string}},current=await repositorySnapshot(root);
  if(!integrity.intact||(!goal.baseExecutionId&&current.dirty)||current.head!==goal.sourceSha||current.treeHash!==integrity.after.treeHash)throw localError("La copia investigada cambió. Inicia un objetivo nuevo.",409);
  const problem=await this.refreshLeaseState(goal);if(problem)throw localError(problem,409);
  if(goal.baseExecutionId)await this.options.acceptedBase?.(goal.baseExecutionId);
  const inventory=await pinnedInventory(root,goal.sourceSha,this.store.root);return {goal,files:goal.baseExecutionId?await repositoryFiles(root):inventory.allFiles};
 }
 async artifact(id:string,path:string,offset=0):Promise<{text:string;truncated:boolean;nextOffset:number}>{
  const g=await this.store.findGoal(id);localText(path,"ruta del artefacto",2000);
  const match=/^([a-f0-9-]{36})\/(stdout\.log|stderr\.log|health\.json|prompt\.txt|schema\.json|last-message\.json|result\.json|integrity\.json)$/.exec(path);
  if(!match||!g.attempts.some(a=>a.id===match[1])||!Number.isSafeInteger(offset)||offset<0)throw localError("Ruta o desplazamiento fuera del artefacto permitido.",403);
  const target=await ownedResearchPath(this.store.root,"research",uuid(id),uuid(match[1]),match[2]!);
  const handle=await open(target,"r");try{const info=await handle.stat();if(!info.isFile())throw localError("Artefacto inválido.");const buffer=Buffer.alloc(65536),{bytesRead}=await handle.read(buffer,0,buffer.length,offset);return {text:redact(buffer.subarray(0,bytesRead).toString("utf8")),truncated:offset+bytesRead<info.size,nextOffset:offset+bytesRead};}finally{await handle.close();}
 }
 async shutdown():Promise<void>{this.closed=true;if(this.timer)clearInterval(this.timer);for(const a of this.active.values())a.controller.abort();await Promise.allSettled([...this.active.values()].map(a=>a.promise));}
}
