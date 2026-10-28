import {randomUUID} from 'node:crypto';
import {digest} from '../state-store.js';
import {redact} from '../process.js';
import {LocalStore,appendChat} from './store.js';
import {GoalManager} from './goals.js';
import {ExecutionManager} from './executions.js';
import {localError,localText,record,uuid} from './validation.js';
import type {ChatReference,ConversationRecord} from './conversation-contracts.js';

function references(value:unknown):ChatReference[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>8)throw localError('Adjunta como máximo ocho referencias de texto.');
 const result=value.map(v=>{const r=record(v,['name','text']);return {name:localText(r.name,'nombre de referencia',240),text:localText(r.text,'referencia de texto',40000)};});
 if(result.reduce((n,r)=>n+r.text.length,0)>100000)throw localError('Las referencias exceden 100.000 caracteres. Adjunta un extracto relevante.',413);
 return result;
}
const event=(c:ConversationRecord,key:string,text:string,source:NonNullable<import('./conversation-contracts.js').ChatMessage['source']>={kind:'conversation',id:c.id})=>appendChat(c,{id:randomUUID(),key,at:Date.now(),role:'salem',text,source});

/** Durable coordinator. CLI processes and their leases remain owned by existing managers. */
export class ConversationManager{
 private tail:Promise<unknown>=Promise.resolve();private timer:NodeJS.Timeout|undefined;private closed=false;private pumping=false;
 constructor(readonly store:LocalStore,readonly goals:GoalManager,readonly executions:Pick<ExecutionManager,'isActive'|'acceptedBase'|'startManaged'|'checkpoint'>&{cancel(id:string):Promise<unknown>;resumeManaged(id:string):Promise<unknown>},private options:{autoStart?:boolean;canStart?:()=>boolean}={}){}
 private serial<T>(fn:()=>Promise<T>):Promise<T>{const p=this.tail.then(fn);this.tail=p.catch(()=>{});return p;}
 async initialize(){
  for(const c of (await this.store.readState()).conversations??[])if(['planning','working'].includes(c.status)||c.resumeAfterCommandKey!==undefined||c.commands.some(cmd=>!c.handledCommands.includes(cmd.key))){
   await this.store.updateConversation(c.id,v=>{v.status='paused';v.resumeAfterCommandKey=v.commands.at(-1)!.key;v.reason='Salem se reinició. Continúa para reconciliar los resultados guardados; las tareas aceptadas y los mensajes pendientes se conservan.';event(v,`restart:${v.revision}`,v.reason);});
   if(c.goalId)await this.goals.halt(c.goalId);
   for(const step of c.steps)if(step.executionId)await this.executions.cancel(step.executionId);
  }
  if(this.options.autoStart!==false){this.timer=setInterval(()=>this.wake(),500);this.timer.unref();this.wake();}
 }
 async start(input:unknown):Promise<ConversationRecord>{return this.serial(async()=>{
  if(this.closed)throw localError('Salem se está cerrando.',409);
  const r=record(input,['projectId','text','agentId','requestKey','references']),projectId=uuid(r.projectId),text=localText(r.text,'objetivo',20000).trim(),key=localText(r.requestKey,'clave de solicitud',120),refs=references(r.references);
  const state=await this.store.readState(),project=state.projects.find(p=>p.id===projectId&&!p.archived);if(!project)throw localError('Selecciona un proyecto activo.',404);
  const agentId=r.agentId===undefined?project.config.supervisor!.roles.define:localText(r.agentId,'agente',64);if(!project.config.agents[agentId])throw localError('Agente fuera del perfil.');
  const id=randomUUID(),at=Date.now(),c:ConversationRecord={id,revision:1,projectId,project:structuredClone(project),agentId,requestKey:key,objective:text,createdAt:at,updatedAt:at,status:'planning',reason:null,messages:[{id:randomUUID(),key,at,role:'user',text,...(refs.length?{references:refs}:{})}],goalId:null,planRevision:0,steps:[],lastAcceptedExecutionId:null,commands:[{key,kind:'message',text,references:refs}],handledCommands:[]};
  const saved=await this.store.saveConversation(c);if(this.options.autoStart!==false)this.wake();return saved;
 });}
 async command(id:string,kind:string,input:unknown):Promise<ConversationRecord>{return this.serial(async()=>{
  if(this.closed)throw localError('Salem se está cerrando.',409);
  if(!['message','pause','continue','retry'].includes(kind))throw localError('Acción de conversación desconocida.');
  const r=record(input,kind==='message'?['revision','requestKey','text','references']:['revision','requestKey']),key=localText(r.requestKey,'clave de mensaje',120),text=kind==='message'?localText(r.text,'mensaje',20000).trim():undefined,refs=kind==='message'?references(r.references):undefined;
  const c=await this.store.findConversation(id),same=c.commands.find(cmd=>cmd.key===key);
  if(same){if(same.kind!==kind||same.text!==text||digest(same.references??[])!==digest(refs??[]))throw localError('Esta clave pertenece a otro mensaje.',409);return c;}
  if(!Number.isSafeInteger(r.revision)||c.revision!==r.revision)throw localError('La conversación cambió. Actualiza antes de enviar; tu borrador se conserva.',409);
  if(c.commands.length>=200||JSON.stringify(c.messages.filter(m=>m.role==='user')).length+JSON.stringify(refs??[]).length+(text?.length??0)>180000)throw localError('La conversación alcanzó su límite de contexto. Inicia otra con el objetivo consolidado.',413);
  const saved=await this.store.updateConversation(id,v=>{v.commands.push({key,kind,...(text===undefined?{}:{text,references:refs??[]})});if(kind==='message'){delete v.failedCommandKey;appendChat(v,{id:randomUUID(),key,at:Date.now(),role:'user',text:text!,...(refs?.length?{references:refs}:{})});}},c.revision);
  if(this.options.autoStart!==false)this.wake();return saved;
 });}
 wake(){if(this.closed||this.pumping||this.options.canStart?.()===false)return;this.pumping=true;void this.serial(async()=>{
  for(const c of (await this.store.readState()).conversations??[]){if(this.closed)break;try{await this.reconcile(c.id);}catch(error){const message=redact((error as Error).message);await this.store.updateConversation(c.id,v=>{v.status='blocked';v.reason=message;const pending=v.commands.find(cmd=>!v.handledCommands.includes(cmd.key));if(pending){v.failedCommandKey=pending.key;v.handledCommands.push(pending.key);}event(v,`error:${digest(message)}:${v.planRevision}`,message);});}}
 }).finally(()=>{this.pumping=false;}).catch(()=>{});}
 private async stop(c:ConversationRecord):Promise<boolean>{
  if(c.goalId){await this.goals.halt(c.goalId);if(this.goals.isActive(c.goalId))return false;}
  for(const step of c.steps)if(step.executionId){await this.executions.cancel(step.executionId);if(this.executions.isActive(step.executionId))return false;}
  // A completion that raced the stop is still a real accepted result.
  for(const step of c.steps.filter(s=>s.executionId&&s.status!=='accepted')){const e=await this.store.findExecution(step.executionId!);if(e.status==='completed')await this.accept(c,step.key,e.id);}
  return true;
 }
 private async accept(c:ConversationRecord,key:string,id:string){
  await this.executions.acceptedBase(id);
  await this.store.updateConversation(c.id,v=>{const step=v.steps.find(s=>s.key===key)!;step.status='accepted';v.lastAcceptedExecutionId=id;event(v,`accepted:${id}`,`Completado: ${step.planTask.title}. Los checks y la revisión independiente aceptaron el resultado.`,{kind:'execution',id});});
 }
 private async reconcile(id:string){
  let c=await this.store.findConversation(id);
  if(c.resumeAfterCommandKey!==undefined){
   const boundary=c.commands.findIndex(cmd=>cmd.key===c.resumeAfterCommandKey);
   if(boundary<0)throw localError('Falta la referencia de recuperación del chat. Conserva el historial para revisarlo.',409);
   const continuation=c.commands.slice(boundary+1).find(cmd=>!c.handledCommands.includes(cmd.key)&&['continue','retry'].includes(cmd.kind));
   if(!continuation)return;
   // Do not consume the pending queue. A fresh operator command releases it;
   // normal ordered reconciliation still handles each request exactly once.
   c=await this.store.updateConversation(id,v=>{delete v.resumeAfterCommandKey;v.reason=null;});
  }
  const command=c.commands.find(cmd=>!c.handledCommands.includes(cmd.key));
  if(command){
   if(command.kind==='message'||command.kind==='pause'){
    if(!await this.stop(c))return;c=await this.store.findConversation(id);
    if(command.kind==='pause'){await this.store.updateConversation(id,v=>{v.status='paused';v.reason='Trabajo detenido. El historial y las copias de código se conservan.';v.handledCommands.push(command.key);event(v,`paused:${command.key}`,v.reason!);});return;}
    const project=(await this.store.readState()).projects.find(p=>p.id===c.projectId&&!p.archived);
    if(!project||project.revision!==c.project.revision)throw localError('El perfil del proyecto cambió. Inicia una conversación con su configuración actual.',409);
    const context=c.messages.filter(m=>m.role==='user'||(m.source?.kind==='goal'&&m.text.includes('?'))).map(m=>({role:m.role,text:m.text,references:m.references}));
    const accepted=c.steps.filter(s=>s.status==='accepted').map(s=>s.planTask.title);
    const objective=`Objetivo inicial: ${c.objective}\nCONVERSACIÓN DEL USUARIO (las instrucciones más recientes precisan o cambian las anteriores):\n${JSON.stringify(context)}\nTrabajo ya aceptado y presente en la copia investigada: ${JSON.stringify(accepted)}. Planea únicamente lo que falta; verifica el objetivo completo al finalizar.`;
    const goal=await this.goals.start({projectId:c.projectId,agentId:c.agentId,objective,requestKey:`chat:${id}:${digest(command.key).slice(0,24)}`,conversational:true,...(c.lastAcceptedExecutionId?{baseExecutionId:c.lastAcceptedExecutionId}:{})});
    await this.store.updateConversation(id,v=>{v.goalId=goal.id;v.status='planning';v.reason=null;v.handledCommands.push(command.key);event(v,`research:${goal.id}`,'Voy a revisar el proyecto con tus instrucciones y preparar los pasos necesarios.',{kind:'goal',id:goal.id});});return;
   }
   if(command.kind==='continue'||command.kind==='retry'){
    if(!['paused','blocked'].includes(c.status)){await this.store.updateConversation(id,v=>{v.handledCommands.push(command.key);});return;}
    if(c.failedCommandKey){await this.store.updateConversation(id,v=>{v.handledCommands=v.handledCommands.filter(key=>key!==v.failedCommandKey);delete v.failedCommandKey;v.handledCommands.push(command.key);v.status='planning';v.reason=null;});return;}
    const step=c.steps.find(s=>s.key.startsWith(c.goalId+':')&&s.status!=='accepted');
    if(step?.executionId){
     if(command.kind==='retry')await this.store.updateConversation(id,v=>{const next=v.steps.find(s=>s.key===step.key)!;next.executionId=null;next.status='pending';next.attempt++;});
     else await this.executions.resumeManaged(step.executionId);
     await this.store.updateConversation(id,v=>{if(command.kind==='continue')v.steps.find(s=>s.key===step.key)!.status='running';v.status='working';v.reason=null;v.handledCommands.push(command.key);event(v,`continue:${command.key}`,command.kind==='retry'?'Reintento este paso en una copia nueva del último resultado aceptado.':'Reconcilio el checkpoint guardado para continuar.');});return;
    }
    if(c.goalId){const goal=await this.store.findGoal(c.goalId);if(['cancelled','failed','blocked','interrupted'].includes(goal.status))await this.goals.retry(goal.id,goal.revision);}
    await this.store.updateConversation(id,v=>{v.status=c.steps.some(s=>s.key.startsWith(c.goalId+':'))?'working':'planning';v.reason=null;v.handledCommands.push(command.key);});return;
   }
  }
  if(c.status==='planning'&&c.goalId){
   const goal=await this.store.findGoal(c.goalId);if(this.goals.isActive(goal.id))return;
   if(goal.status==='needs_input'){await this.store.updateConversation(id,v=>{v.status='needs_input';v.reason=null;event(v,`questions:${goal.id}:${goal.revision}`,`${goal.plan?.summary??''}\n\n${goal.plan?.questions.join('\n\n')??''}`,{kind:'goal',id:goal.id,revision:goal.revision});});return;}
   if(goal.status==='answered'){await this.store.updateConversation(id,v=>{v.status='answered';v.reason=null;event(v,`answer:${goal.id}`,goal.plan?.summary??'La investigación no devolvió una respuesta.',{kind:'goal',id:goal.id,revision:goal.revision});});return;}
   if(goal.status==='ready'){const verified=await this.goals.verifiedPlan(goal.id);await this.store.materializeConversation(id,goal.id,verified.files);return;}
   if(['failed','blocked','cancelled','interrupted'].includes(goal.status))throw localError(goal.reason??goal.plan?.summary??'La investigación se detuvo. Revisa su evidencia y continúa cuando esté resuelto.',409);
  }
  if(c.status!=='working'||!c.goalId)return;
  const current=c.steps.filter(s=>s.key.startsWith(c.goalId+':')),step=current.find(s=>s.status!=='accepted');
  if(!step){if(!current.length)throw localError('Faltan tareas verificables del plan.');if(!c.lastAcceptedExecutionId)throw localError('Falta la entrega conjunta.');await this.executions.acceptedBase(c.lastAcceptedExecutionId);await this.store.updateConversation(id,v=>{v.status='completed';v.reason=null;event(v,`completed:${v.goalId}`,'Objetivo completado. Todos los pasos y la aceptación conjunta tienen checks reales y revisión independiente. Puedes revisar los cambios y los resultados; el código está conservado en la copia local de Salem.',{kind:'execution',id:v.lastAcceptedExecutionId!});});return;}
  if(!step.executionId){const e=await this.executions.startManaged(c.id,step.taskId,`chat:${c.id}:${digest(step.key).slice(0,16)}:${step.attempt}`,c.lastAcceptedExecutionId??undefined);await this.store.updateConversation(id,v=>{const next=v.steps.find(s=>s.key===step.key)!;next.executionId=e.id;next.status='running';const a=e.project.config.agents[next.planTask.agentId]!;event(v,`start:${e.id}`,`Empiezo: ${next.planTask.title}. Implementa ${a.provider==='claude'?'Claude':'Codex'} con ${a.model??'el modelo predeterminado del CLI'}${a.effort?' ('+a.effort+')':''}.`,{kind:'execution',id:e.id});});return;}
  const e=await this.store.findExecution(step.executionId);
  if(e.status==='completed'&&!this.executions.isActive(e.id)){await this.accept(c,step.key,e.id);return;}
  if(['failed','blocked','cancelled','interrupted'].includes(e.status)&&!this.executions.isActive(e.id)){await this.store.updateConversation(id,v=>{v.steps.find(s=>s.key===step.key)!.status='blocked';v.status='blocked';v.reason=e.reason??'El paso no pudo completarse.';event(v,`blocked:${e.id}:${e.revision}`,`Se detuvo «${step.planTask.title}»: ${v.reason}\nEl trabajo aceptado anterior se conserva. Revisa la evidencia, continúa el checkpoint o reintenta este paso en una copia nueva.`,{kind:'execution',id:e.id});});return;}
  const run=await this.executions.checkpoint(e.id);if(run){const attempt=run.attempts.at(-1);if(attempt&&!c.messages.some(m=>m.key===`phase:${attempt.id}`))await this.store.updateConversation(id,v=>{event(v,`phase:${attempt.id}`,({define:'Definiendo el detalle de',build:'Implementando',review:'Revisando de forma independiente'}[attempt.stage])+` «${step.planTask.title}».`,{kind:'execution',id:e.id});});}
 }
 async shutdown(){
  this.closed=true;if(this.timer)clearInterval(this.timer);await this.tail;
  // A corrupt catalog must remain untouched. The drained coordinator owns no
  // native processes; the server separately closes their execution/goal owners.
  let conversations:ConversationRecord[];try{conversations=(await this.store.readState()).conversations??[];}catch{return;}
  for(const c of conversations)if(['planning','working'].includes(c.status)||c.resumeAfterCommandKey!==undefined||c.commands.some(cmd=>!c.handledCommands.includes(cmd.key))){
   await this.store.updateConversation(c.id,v=>{v.status='paused';v.resumeAfterCommandKey=v.commands.at(-1)!.key;v.reason='Salem se cerró. Continúa para reconciliar el trabajo y los mensajes guardados.';});await this.stop(c);
  }
 }
}
