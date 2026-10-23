import { mkdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { parseGoalPlan } from "./planning.js";
import type { GoalRecord } from "./research-contracts.js";
import { atomicJson, digest } from "../state-store.js";
import { defaultSettings } from "./contracts.js";
import type { ExecutionRecord, LocalSettings, LocalState, ProjectInput, ProjectRecord, TaskInput, TaskRecord } from "./contracts.js";
import { localError, record, uuid, validateProjectInput, validateSettings, validateTaskInput } from "./validation.js";
import type {ConversationRecord,ChatMessage} from './conversation-contracts.js';
import {orderedWork} from './conversation-plan.js';
export function appendChat(c:ConversationRecord,message:ChatMessage):void{if(!c.messages.some(m=>m.key===message.key))c.messages.push(message);}

const MAX_CATALOG_BYTES=50_000_000;
export class LocalStore {
  readonly root:string;
  private ready:Promise<void>|undefined;
  private tail:Promise<unknown>=Promise.resolve();
  constructor(root:string){this.root=resolve(root);}
  private async initialize():Promise<void>{
    await mkdir(this.root,{recursive:true});
    try{await stat(join(this.root,"catalog.json"));}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;
      const value:LocalState={schemaVersion:1,revision:1,settings:defaultSettings(),projects:[],tasks:[],executions:[],goals:[]};
      await atomicJson(join(this.root,"catalog.json"),{checksum:digest(value),value});}
  }
  async readState():Promise<LocalState>{
    this.ready??=this.initialize();await this.ready;
    try{
      if((await stat(join(this.root,"catalog.json"))).size>MAX_CATALOG_BYTES)throw new Error("tamaño excedido");
      const envelope=JSON.parse(await readFile(join(this.root,"catalog.json"),"utf8")) as {checksum:string;value:LocalState};
      const s=envelope.value;
      if(!s||s.schemaVersion!==1||!Number.isSafeInteger(s.revision)||!Array.isArray(s.projects)||!Array.isArray(s.tasks)||!Array.isArray(s.executions)||(s.goals!==undefined&&!Array.isArray(s.goals))||digest(s)!==envelope.checksum)throw new Error("integridad inválida");
      if(s.evolutions!==undefined&&!Array.isArray(s.evolutions))throw new Error('Evolución inválida');
      if(s.conversations!==undefined&&!Array.isArray(s.conversations))throw new Error('Conversaciones inválidas');
      validateSettings(s.settings);
      return structuredClone(s);
    }catch(e){throw localError(`No se pudo leer el catálogo de Salem; conserva los datos para recuperarlo: ${(e as Error).message}`,500);}
  }
  private async change<T>(fn:(state:LocalState)=>Promise<T>|T):Promise<T>{
    const run=this.tail.then(async()=>{const s=await this.readState(),result=await fn(s);s.revision++;
      const envelope={checksum:digest(s),value:s};
      if(Buffer.byteLength(JSON.stringify(envelope))>MAX_CATALOG_BYTES)throw localError("El catálogo excede el límite de tamaño; los datos anteriores se conservaron.",413);
      await atomicJson(join(this.root,"catalog.json"),envelope);return structuredClone(result);});
    this.tail=run.catch(()=>{});return run;
  }
  async saveProject(input:ProjectInput):Promise<ProjectRecord>{return this.change(async s=>{
    const existing=input.id?s.projects.find(p=>p.id===uuid(input.id)):undefined;
    if(input.id&&!existing)throw localError("Proyecto no encontrado.",404);
    if(existing&&input.revision!==existing.revision)throw localError("409: el proyecto cambió en otra pestaña. Recarga su versión antes de guardar.",409);
    const project=await validateProjectInput(input,existing);
    if(s.projects.some(p=>p.id!==project.id&&p.config.projectId===project.config.projectId))throw localError("Ya existe un proyecto con ese identificador.",409);
    if(existing)s.projects[s.projects.indexOf(existing)]=project;else s.projects.push(project);return project;
  });}
  async saveConversation(c:ConversationRecord):Promise<ConversationRecord>{return this.change(s=>{
    s.conversations??=[];const same=s.conversations.find(v=>v.requestKey===c.requestKey);
    if(same){if(same.projectId!==c.projectId||same.objective!==c.objective||same.agentId!==c.agentId||digest(same.messages[0]?.references??[])!==digest(c.messages[0]?.references??[]))throw localError('La clave pertenece a otra conversación.',409);return same;}
    s.conversations.push(structuredClone(c));return c;
  });}
  async findConversation(id:string):Promise<ConversationRecord>{const c=(await this.readState()).conversations?.find(c=>c.id===uuid(id));if(!c)throw localError('Conversación no encontrada.',404);return c;}
  async updateConversation(id:string,fn:(c:ConversationRecord)=>void,revision?:number):Promise<ConversationRecord>{return this.change(s=>{
    const c=s.conversations?.find(c=>c.id===uuid(id));if(!c)throw localError('Conversación no encontrada.',404);
    if(revision!==undefined&&c.revision!==revision)throw localError('La conversación cambió. Actualiza antes de enviar; tu borrador se conserva.',409);
    fn(c);c.revision++;c.updatedAt=Date.now();return c;
  });}
  async materializeConversation(id:string,goalId:string,files:string[]):Promise<ConversationRecord>{return this.change(s=>{
    const c=s.conversations?.find(c=>c.id===uuid(id)),goal=s.goals?.find(g=>g.id===uuid(goalId));
    if(!c||!goal||c.goalId!==goal.id||c.projectId!==goal.projectId||goal.status!=='ready'||!goal.plan||!goal.sourceSha)throw localError('El plan de la conversación no está listo.',409);
    if(c.steps.some(step=>step.key.startsWith(goal.id+':')))return c;
    const project=s.projects.find(p=>p.id===c.projectId&&!p.archived);
    if(!project||project.revision!==c.project.revision||goal.project.revision!==c.project.revision)throw localError('El perfil cambió; se conserva la conversación y no se ejecuta el plan.',409);
    const plan=parseGoalPlan(goal.plan,files,project.config.checks.map(check=>check.id),Object.keys(project.config.agents));
    if(plan.proposedChecks.length||!plan.work)throw localError('El plan requiere checks nuevos o no tiene tareas. Revisa el perfil de forma explícita antes de continuar.',409);
    const ordered=orderedWork(plan.work);c.planRevision++;
    for(const [index,node] of ordered.entries()){
      const last=index===ordered.length-1,criteria=[...new Set([...node.acceptance,...(last?plan.task.acceptance:[])])];
      const spec={id:`CHAT-${c.id.slice(0,8)}-${c.planRevision}-${node.id}`,objective:`Paso ${index+1} de ${ordered.length}: ${node.title}\n${node.objective}\n\nObjetivo inicial: ${c.objective}\nResultado acordado tras la conversación: ${plan.task.objective}\n\nDecisiones del plan:\n${plan.decisions.join('\n')}\nSupuestos:\n${plan.assumptions.join('\n')}\n${last?'Última tarea: verifica el resultado conjunto del objetivo completo.':'Implementa y revisa los criterios de este paso. Los pasos posteriores comprobarán el resto del objetivo; no declares el objetivo conjunto completado todavía.'}`,scope:[...new Set([...node.scope,...(last?plan.task.scope:[])])],acceptance:criteria,references:plan.task.references,acceptanceChecks:Object.fromEntries(criteria.map(criterion=>[criterion,[...new Set([...node.checkIds,...(last&&plan.task.acceptance.includes(criterion)?plan.task.checkIds:[])])]]))};
      const task=validateTaskInput({projectId:c.projectId,spec},project);task.conversation={id:c.id,planRevision:c.planRevision,stepId:node.id};s.tasks.push(task);
      c.steps.push({key:`${goal.id}:${node.id}`,planTask:node,taskId:task.id,executionId:null,status:'pending',attempt:0});
    }
    c.status='working';c.reason=null;c.revision++;c.updatedAt=Date.now();
    appendChat(c,{id:randomUUID(),key:`plan:${goal.id}`,at:Date.now(),role:'salem',text:`${plan.summary}\n\n${ordered.map((t,i)=>`${i+1}. ${t.title}`).join('\n')}\n\n${plan.decisions.join('\n')}${plan.assumptions.length?'\nSupuestos por comprobar:\n'+plan.assumptions.join('\n'):''}\n\nPrepararé y comprobaré cada paso en una copia aislada.`,source:{kind:'goal',id:goal.id,revision:goal.revision}});return c;
  });}
  async saveTask(input:TaskInput):Promise<TaskRecord>{return this.change(s=>{
    const project=s.projects.find(p=>p.id===uuid(input.projectId));if(!project)throw localError("Proyecto no encontrado.",404);
    const existing=input.id?s.tasks.find(t=>t.id===uuid(input.id)):undefined;
    if(input.id&&!existing)throw localError("Tarea no encontrada.",404);
    if(existing?.conversation)throw localError('Esta tarea pertenece a un plan congelado. Pide el ajuste desde su conversación.',409);
    if(existing&&existing.projectId!==project.id)throw localError("No se puede mover una tarea con historial a otro proyecto.");
    if(existing&&input.revision!==existing.revision)throw localError("409: la tarea cambió en otra pestaña. Recarga su versión antes de guardar.",409);
    let copyOrigin:TaskRecord["origin"];
    if(!existing&&input.origin!==undefined){
      const origin=record(input.origin,["goalId","sourceSha","projectRevision"]),source=s.tasks.find(t=>t.projectId===project.id&&t.origin&&digest(t.origin)===digest(origin)),goal=s.goals?.find(g=>g.id===origin.goalId);
      if(!source?.origin||!goal||goal.status!=="materialized"||goal.sourceSha!==source.origin.sourceSha||goal.projectId!==project.id)throw localError("No se puede verificar el origen investigado en este catálogo. Crea un nuevo objetivo en el proyecto de destino.",409);
      copyOrigin=structuredClone(source.origin);
    }
    const validated=copyOrigin?Object.fromEntries(Object.entries(input).filter(([key])=>key!=="origin")) as unknown as TaskInput:input;
    const task=validateTaskInput(validated,project,existing);if(copyOrigin)task.origin=copyOrigin;
    if(s.tasks.some(t=>t.id!==task.id&&t.projectId===task.projectId&&t.spec.id===task.spec.id))throw localError("Ya existe una tarea con ese identificador en el proyecto.",409);
    if(existing)s.tasks[s.tasks.indexOf(existing)]=task;else s.tasks.push(task);return task;
  });}
  async saveSettings(input:LocalSettings):Promise<LocalSettings>{return this.change(s=>{
    const settings=validateSettings(input);
    if(settings.revision!==s.settings.revision)throw localError("409: los ajustes cambiaron en otra pestaña.",409);
    settings.revision++;s.settings=settings;return settings;
  });}
  async saveExecution(execution:ExecutionRecord):Promise<ExecutionRecord>{return this.change(s=>{
    uuid(execution.id);if(s.executions.some(e=>e.id===execution.id))throw localError("La ejecución ya existe.",409);
    s.executions.push(structuredClone(execution));return execution;
  });}
  async patchExecution(id:string,patch:Partial<ExecutionRecord>):Promise<ExecutionRecord>{return this.change(s=>{
    const execution=s.executions.find(e=>e.id===uuid(id));if(!execution)throw localError("Ejecución no encontrada.",404);
    if(patch.id&&patch.id!==id)throw localError("Identidad de ejecución inválida.");
    Object.assign(execution,structuredClone(patch),{id,revision:execution.revision+1,updatedAt:Date.now()});return execution;
  });}
  async findExecution(id:string):Promise<ExecutionRecord>{const e=(await this.readState()).executions.find(e=>e.id===uuid(id));if(!e)throw localError("Ejecución no encontrada.",404);return e;}
  async saveEvolution(e:import('./evolution-contracts.js').EvolutionRecord){return this.change(s=>{s.evolutions??=[];if(s.evolutions.some(v=>v.id===e.id||v.requestKey===e.requestKey))throw localError('Experimento duplicado.',409);s.evolutions.push(e);return e;});}
  async patchEvolution(id:string,patch:Partial<import('./evolution-contracts.js').EvolutionRecord>){return this.change(s=>{const e=s.evolutions?.find(e=>e.id===uuid(id));if(!e)throw localError('Experimento no encontrado.',404);Object.assign(e,structuredClone(patch),{id,revision:e.revision+1,updatedAt:Date.now()});return e;});}
  async saveGoal(goal:GoalRecord):Promise<GoalRecord>{return this.change(s=>{
    uuid(goal.id);s.goals??=[];
    const same=s.goals.find(g=>g.requestKey===goal.requestKey);
    if(same){if(same.projectId!==goal.projectId||same.objective!==goal.objective||same.agentId!==goal.agentId)throw localError("La clave ya pertenece a otro objetivo.",409);return same;}
    if(s.goals.some(g=>g.id===goal.id))throw localError("El objetivo ya existe.",409);s.goals.push(structuredClone(goal));return goal;
  });}
  async patchGoal(id:string,patch:Partial<GoalRecord>,revision?:number):Promise<GoalRecord>{return this.change(s=>{
    const goal=s.goals?.find(g=>g.id===uuid(id));if(!goal)throw localError("Objetivo no encontrado.",404);
    if(revision!==undefined&&goal.revision!==revision)throw localError("409: el objetivo cambió. Actualiza su versión.",409);
    if(patch.id&&patch.id!==id)throw localError("Identidad de objetivo inválida.");
    Object.assign(goal,structuredClone(patch),{id,revision:goal.revision+1,updatedAt:Date.now()});return goal;
  });}
  async findGoal(id:string):Promise<GoalRecord>{const g=(await this.readState()).goals?.find(g=>g.id===uuid(id));if(!g)throw localError("Objetivo no encontrado.",404);return g;}
  async materializeGoal(id:string,revision:number,files:string[]):Promise<{goal:GoalRecord;task:TaskRecord}>{return this.change(async s=>{
    const goal=s.goals?.find(g=>g.id===uuid(id));if(!goal)throw localError("Objetivo no encontrado.",404);
    if(goal.conversational)throw localError('Las tareas de este objetivo se gestionan desde su conversación.',409);
    if(goal.createdTaskId){const task=s.tasks.find(t=>t.id===goal.createdTaskId);if(!task)throw localError("La tarea del plan no está en el catálogo.",409);return {goal,task};}
    if(goal.revision!==revision)throw localError("409: el objetivo cambió. Actualiza su versión.",409);
    if(goal.status!=="ready"||!goal.plan||!goal.sourceSha)throw localError("El plan no está listo o tiene preguntas pendientes.",409);
    const project=s.projects.find(p=>p.id===goal.projectId&&!p.archived);
    if(!project||project.revision!==goal.project.revision)throw localError("El proyecto cambió o está archivado. Investiga un nuevo objetivo con el perfil actual.",409);
    const plan=parseGoalPlan(goal.plan,files,project.config.checks.map(c=>c.id),Object.keys(project.config.agents));
    let updated=project;
    if(plan.proposedChecks.length){
      updated=await validateProjectInput({...project,config:{...project.config,checks:[...project.config.checks,...plan.proposedChecks.map(c=>({id:c.id,command:c.command,required:true,...(c.toolFiles.length?{toolFiles:c.toolFiles}:{})}))]}},project);
      s.projects[s.projects.indexOf(project)]=updated;
    }
    const spec={id:`PLAN-${goal.id.slice(0,8)}`,objective:`${goal.objective}\n\n${plan.task.objective}\n\nPlan de investigación (${goal.sourceSha}):\n${plan.steps.map((step,i)=>`${i+1}. ${step.title}: ${step.description}`).join("\n")}\n\nDecisiones:\n${plan.decisions.join("\n")}\nSupuestos por validar:\n${plan.assumptions.join("\n")}`,scope:plan.task.scope,acceptance:plan.task.acceptance,references:plan.task.references,acceptanceChecks:Object.fromEntries(plan.task.acceptance.map(c=>[c,plan.task.checkIds]))};
    const task=validateTaskInput({projectId:project.id,spec},updated);
    if(s.tasks.some(t=>t.projectId===project.id&&t.spec.id===spec.id))throw localError("El identificador de la tarea ya existe.",409);
    task.id=randomUUID();task.origin={goalId:goal.id,sourceSha:goal.sourceSha,projectRevision:updated.revision};s.tasks.push(task);
    goal.createdTaskId=task.id;goal.status="materialized";goal.revision++;goal.updatedAt=Date.now();return {goal,task};
  });}
}
