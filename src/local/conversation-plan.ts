import type {WorkGraph,WorkTask} from './conversation-contracts.js';
import {localError,localText,record} from './validation.js';
const strings=(value:unknown,label:string,max=80):string[]=>{
 if(!Array.isArray(value)||value.length>max)throw localError(`Lista de ${label} inválida.`);
 return value.map(v=>localText(v,label,12000));
};
export function parseWorkGraph(value:unknown,checks:string[],agents:string[]):WorkGraph{
 const root=record(value,['tasks']);
 if(!Array.isArray(root.tasks)||!root.tasks.length||root.tasks.length>30)throw localError('El plan necesita entre 1 y 30 tareas.');
 const tasks:WorkTask[]=root.tasks.map(value=>{
  const r=record(value,['id','title','objective','scope','acceptance','checkIds','dependsOn','agentId']);
  const id=localText(r.id,'identificador',64),agentId=localText(r.agentId,'agente',64);
  if(!/^[A-Za-z0-9_-]+$/.test(id)||!agents.includes(agentId))throw localError('Identificador o agente del plan fuera del perfil.');
  const scope=strings(r.scope,'alcance'),acceptance=strings(r.acceptance,'aceptación'),checkIds=strings(r.checkIds,'checks');
  if(!scope.length||scope.some(p=>p.includes('\\')||p.startsWith('/')||p.includes(':')||p.split('/').some(x=>!x||x==='.'||x==='..'))||!acceptance.length||!checkIds.length||checkIds.some(c=>!checks.includes(c)))throw localError('Alcance o checks del plan inválidos; se conservan las reglas del proyecto.');
  return {id,agentId,title:localText(r.title,'título',500),objective:localText(r.objective,'objetivo',20000),scope,acceptance,checkIds,dependsOn:strings(r.dependsOn,'dependencias',30)};
 });
 const ids=new Set(tasks.map(t=>t.id));
 if(ids.size!==tasks.length||tasks.some(t=>t.dependsOn.some(id=>!ids.has(id)||id===t.id)))throw localError('Tareas duplicadas o dependencia inexistente.');
 const graph={tasks};orderedWork(graph);return graph;
}
export function orderedWork(graph:WorkGraph):WorkTask[]{
 const result:WorkTask[]=[],remaining=[...graph.tasks],done=new Set<string>();
 while(remaining.length){const at=remaining.findIndex(t=>t.dependsOn.every(id=>done.has(id)));if(at<0)throw localError('El plan tiene dependencias circulares.');const [task]=remaining.splice(at,1);result.push(task!);done.add(task!.id);}
 return result;
}
const string={type:'string'},stringsSchema={type:'array',items:string};
const object=(properties:Record<string,unknown>)=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const workTaskSchema=object({id:string,title:string,objective:string,scope:stringsSchema,acceptance:stringsSchema,checkIds:stringsSchema,dependsOn:stringsSchema,agentId:string});
export const workGraphSchema=object({tasks:{type:'array',minItems:1,maxItems:30,items:workTaskSchema}});
export const conversationWorkSchema=object({tasks:{type:'array',minItems:0,maxItems:30,items:workTaskSchema}});
