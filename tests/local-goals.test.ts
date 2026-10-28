import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LocalStore } from "../src/local/store.js";
import { createLocalDemo } from "../src/local/demo.js";
import { ExecutionManager } from "../src/local/executions.js";
import { digest } from "../src/state-store.js";
import type { GoalRecord } from "../src/local/research-contracts.js";

async function fixture(mode="ready",provider:"claude"|"codex"="claude"){
 const root=await mkdtemp(join(tmpdir(),"salem goals ")),store=new LocalStore(join(root,"data")),{project}=await createLocalDemo(store);
 const p=await store.saveProject({...project,config:{...project.config,agents:{...project.config.agents,[provider]:{provider,command:[process.execPath,resolve("tests/fixtures/planning-agent.mjs"),provider,mode]}}}});
 return {root,store,project:p,provider};
}
async function until(store:LocalStore,id:string,statuses:string[]):Promise<GoalRecord>{const end=Date.now()+60000;while(Date.now()<end){const goal=await store.findGoal(id);if(statuses.includes(goal.status))return goal;await new Promise(r=>setTimeout(r,40));}throw Error("Goal did not finish");}
test("existing checksummed catalogs load unchanged; goals survive restart with no silent inference replay",async()=>{
 const f=await fixture(),old=await f.store.readState();delete old.goals;await writeFile(join(f.store.root,"catalog.json"),JSON.stringify({checksum:digest(old),value:old}));
 const {GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();
 const goal=await m.start({projectId:f.project.id,objective:"Corregir suma",agentId:"claude",requestKey:"persist"});
 await f.store.patchGoal(goal.id,{status:"investigating"});await m.shutdown();const reopened=new GoalManager(new LocalStore(f.store.root),{autoStart:false});await reopened.initialize();
 assert.equal((await f.store.findGoal(goal.id)).status,"interrupted");assert.equal((await f.store.readState()).goals?.length,1);await reopened.shutdown();
});
test("goal research freezes project and source, produces plan, promotes once, then pins execution to researched SHA",async()=>{
 const f=await fixture(),before=await readFile(join(f.project.config.repoRoot,"sum.mjs"),"utf8"),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();
 try{
  const request={projectId:f.project.id,objective:"Corrige la suma sin cambiar su API",agentId:"claude",requestKey:"same"};
  const [a,b]=await Promise.all([m.start(request),m.start(request)]);assert.equal(a.id,b.id);
  const ready=await until(f.store,a.id,["ready","failed"]);assert.equal(ready.status,"ready",ready.reason??"");assert.equal(ready.attempts.length,1);assert.ok(ready.sourceSha);
  assert.equal(await readFile(join(f.project.config.repoRoot,"sum.mjs"),"utf8"),before);
  const [one,two]=await Promise.all([m.materialize(a.id,ready.revision),m.materialize(a.id,ready.revision)]);assert.equal(one.task.id,two.task.id);assert.equal(one.task.origin?.sourceSha,ready.sourceSha);assert.equal((await f.store.readState()).tasks.filter(t=>t.origin?.goalId===a.id).length,1);assert.match(one.task.spec.objective,/Conservar la API|Corregir suma/);
  const executions=new ExecutionManager(f.store,{autoStart:false});await executions.initialize();const execution=await executions.start(one.task.id,"planned");assert.equal(execution.project.baseRef,ready.sourceSha);await executions.shutdown();
  const p=(await f.store.readState()).projects.find(p=>p.id===f.project.id)!;await f.store.saveProject({...p,name:"changed"});const stale=new ExecutionManager(f.store,{autoStart:false});await assert.rejects(stale.start(one.task.id,"stale"),/cambi|revisi|obsolet/i);await stale.shutdown();
 }finally{await m.shutdown();}
});
test("clarification and explicit retry preserve attempts; stale answers and premature task creation fail",async()=>{
 const f=await fixture("questions"),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"questions"}),q=await until(f.store,g.id,["needs_input","failed"]);assert.equal(q.status,"needs_input",q.reason??"");
 await assert.rejects(m.materialize(g.id,q.revision),/listo|plan|pregunt/i);await assert.rejects(m.answer(g.id,q.revision-1,"Solo números"),/409|cambi|revisi/i);
 await m.answer(g.id,q.revision,"Solo números");const done=await until(f.store,g.id,["ready","failed"]);assert.equal(done.status,"ready",done.reason??"");assert.equal(done.attempts.length,2);assert.equal(done.answers.length,1);
 }finally{await m.shutdown();}
});
test("cancellation interrupts only owned planning process and repository mutations reject the plan",async()=>{
 const f=await fixture("wait"),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"cancel"});await until(f.store,g.id,["investigating"]);await m.cancel(g.id);const done=await until(f.store,g.id,["cancelled","failed"]);assert.equal(done.status,"cancelled",done.reason??"");}finally{await m.shutdown();}
 const bad=await fixture("mutate"),n=new GoalManager(bad.store);await n.initialize();try{const g=await n.start({projectId:bad.project.id,objective:"Suma",agentId:"claude",requestKey:"mutate"});const done=await until(bad.store,g.id,["failed","ready"]);assert.equal(done.status,"failed");assert.match(done.reason??"",/lectura|modific/i);assert.equal(done.plan,null);}finally{await n.shutdown();}
});
test("account mutation and shared execution capacity prevent research claims; archived and stale goals cannot promote",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),locked=new GoalManager(f.store,{autoStart:false,canStart:()=>false});await locked.initialize();await assert.rejects(locked.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"locked"}),/cuenta|conexi/i);await locked.shutdown();
 let occupied=1;const m=new GoalManager(f.store,{additionalActive:()=>occupied});await m.initialize();try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"capacity"});await new Promise(r=>setTimeout(r,150));assert.equal((await f.store.findGoal(g.id)).status,"queued");occupied=0;m.wake();const ready=await until(f.store,g.id,["ready","failed"]);assert.equal(ready.status,"ready",ready.reason??"");await f.store.saveProject({...f.project,archived:true});await assert.rejects(m.materialize(g.id,ready.revision),/cambi|activo|archiv|revisi/i);}finally{await m.shutdown();}
});
test("research evidence rejects outside paths and symlinked ancestors",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"paths"}),outside=join(f.root,"outside");await mkdir(outside);await writeFile(join(outside,"private.log"),"secret");await mkdir(join(f.store.root,"research"),{recursive:true});await symlink(outside,join(f.store.root,"research",g.id),process.platform==="win32"?"junction":"dir");await assert.rejects(m.artifact(g.id,"../outside/private.log",0),/ruta|permit|fuera|artefact/i);await assert.rejects(m.artifact(g.id,"private.log",0),/ruta|enlace|permit|fuera/i);}finally{await m.shutdown();}
});
test("creating a planned task atomically adds reviewed checks without expanding capabilities or losing its origin on edit",async()=>{
 const f=await fixture("propose"),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"proposed"}),ready=await until(f.store,g.id,["ready","failed"]);assert.equal(ready.status,"ready",ready.reason??"");
 const {task}=await m.materialize(g.id,ready.revision),state=await f.store.readState(),project=state.projects.find(p=>p.id===f.project.id)!;
 assert.ok(project.config.checks.some(c=>c.id==="behavior"));assert.deepEqual(project.config.capabilities,f.project.config.capabilities);assert.equal(task.origin?.projectRevision,project.revision);
 const edited=await f.store.saveTask({id:task.id,revision:task.revision,projectId:task.projectId,spec:{...task.spec,objective:task.spec.objective+"\nDetalle"}});assert.deepEqual(edited.origin,task.origin);
 await assert.rejects(f.store.saveTask({...edited,origin:{...edited.origin!,sourceSha:"b".repeat(40)}} as typeof edited),/origen|lectura/i);
 }finally{await m.shutdown();}
});
test("a ready plan with an inline check and no tool files materializes successfully",async()=>{
 const f=await fixture("inline"),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"inline"}),ready=await until(f.store,g.id,["ready","failed"]);assert.equal(ready.status,"ready",ready.reason??"");const {task}=await m.materialize(g.id,ready.revision);assert.ok(task.id);}finally{await m.shutdown();}
});
test("short clarification answers preserve the questions in the next independent session",async()=>{
 const f=await fixture("questions"),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"short"}),q=await until(f.store,g.id,["needs_input","failed"]);await m.answer(g.id,q.revision,"La primera opción");const ready=await until(f.store,g.id,["ready","failed"]);assert.equal(ready.status,"ready",ready.reason??"");assert.deepEqual(ready.answers[0]?.questions,["¿Cómo tratar texto?"]);const prompt=await readFile(join(f.store.root,"research",g.id,ready.attempts.at(-1)!.id,"prompt.txt"),"utf8");assert.match(prompt,/¿Cómo tratar texto\?/);}finally{await m.shutdown();}
});
test("unconfirmed research leases quarantine provider and capacity until a valid cleanup receipt exists",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"lease"});await m.shutdown();
 const {randomUUID}=await import("node:crypto"),attemptId=randomUUID(),token=randomUUID(),dir=join(f.store.root,"research",g.id,attemptId,"leases");await mkdir(dir,{recursive:true});const file=join(dir,`${token}.json`);await writeFile(file,JSON.stringify({pid:process.pid,token,closed:false}));await f.store.patchGoal(g.id,{status:"investigating",attempts:[{id:attemptId,status:"running",startedAt:Date.now(),finishedAt:null,error:null,usage:null,sessionId:null,durationMs:null}]});
 const reopened=new GoalManager(f.store,{autoStart:false});await reopened.initialize();try{const held=await f.store.findGoal(g.id);assert.equal(reopened.isBusy("claude"),true);assert.equal(reopened.activeCount(),1);await assert.rejects(reopened.retry(g.id,held.revision),/limpieza|cierre|recibo|proceso/i);await assert.rejects(reopened.start({projectId:f.project.id,objective:"Otra tarea",agentId:"claude",requestKey:"held"}),/limpieza|cierre|recibo|proceso/i);await writeFile(file,JSON.stringify({pid:process.pid,token,closed:true}));await reopened.retry(g.id,held.revision);assert.equal(reopened.isBusy("claude"),false);}finally{await reopened.shutdown();}
});
test("verified copies and imports retain researched origin and cannot silently switch source or profile",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"origin"}),ready=await until(f.store,g.id,["ready","failed"]),{task}=await m.materialize(g.id,ready.revision);
 const copied=await f.store.saveTask({projectId:task.projectId,spec:{...task.spec,id:task.spec.id+"-copy"},origin:task.origin} as import("../src/local/contracts.js").TaskInput);assert.deepEqual(copied.origin,task.origin);
 const exported=JSON.parse(JSON.stringify({projectId:task.projectId,spec:{...task.spec,id:task.spec.id+"-import"},origin:task.origin}));assert.deepEqual((await f.store.saveTask(exported)).origin,task.origin);
 await assert.rejects(f.store.saveTask({...exported,spec:{...exported.spec,id:"forged"},origin:{...task.origin,sourceSha:"f".repeat(40)}}),/origen|verificar|lectura/i);
 await f.store.saveProject({...f.project,name:"Later profile"});const executions=new ExecutionManager(f.store,{autoStart:false});await assert.rejects(executions.start(copied.id,"stale-copy"),/cambi|revisi/i);await executions.shutdown();
 }finally{await m.shutdown();}
});
async function settle(m:{isActive(id:string):boolean},id:string){const end=Date.now()+60000;while(m.isActive(id)&&Date.now()<end)await new Promise(r=>setTimeout(r,20));assert.equal(m.isActive(id),false);}
test("a cancel accepted after the goal is claimed but before it is investigating prevents the agent from starting",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;}),patch=f.store.patchGoal.bind(f.store);f.store.patchGoal=async(id:string,p:Partial<GoalRecord>,rev?:number)=>{if(p.status==="investigating")await gate;return patch(id,p,rev);};
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"claimed"});m.wake();const end=Date.now()+10000;while(!m.isActive(g.id)&&Date.now()<end)await new Promise(r=>setTimeout(r,5));assert.ok(m.isActive(g.id));
 const requested=await m.cancel(g.id);release();await settle(m,g.id);const done=await f.store.findGoal(g.id);assert.equal(done.status,"cancelled",`cancel returned ${requested.status}; goal ended ${done.status}`);assert.equal(done.plan,null);assert.notEqual(done.attempts.at(-1)?.status,"succeeded");}finally{release();await m.shutdown();}
});
test("cancelling an investigating goal with no registered agent is never a silent no-op",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"orphan"});await f.store.patchGoal(g.id,{status:"investigating",attempts:[{id:"00000000-0000-4000-8000-000000000001",startedAt:Date.now(),finishedAt:null,status:"running",error:null,usage:null,sessionId:null,durationMs:null}]});
 const c=await m.cancel(g.id);assert.equal(c.status,"cancelled");assert.ok(c.finishedAt);assert.match(c.reason??"",/cancel/i);assert.equal(c.attempts[0]!.status,"cancelled");assert.equal((await f.store.findGoal(g.id)).status,"cancelled");}finally{await m.shutdown();}
});
test("goal cancel follows its status table: waiting goals cancel, cancelled is idempotent, finished goals refuse with 409",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();
 try{let n=0;const goal=async(status:GoalRecord["status"])=>{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:`table-${n++}`});return status==="queued"?g:f.store.patchGoal(g.id,{status});};
 for(const status of ["queued","needs_input","ready"] as const){const g=await goal(status),c=await m.cancel(g.id);assert.equal(c.status,"cancelled",status);assert.ok(c.finishedAt,status);assert.match(c.reason??"",/cancel/i,status);}
 const twice=await goal("queued"),first=await m.cancel(twice.id),second=await m.cancel(twice.id);assert.equal(second.status,"cancelled");assert.equal(second.revision,first.revision);
 for(const status of ["failed","blocked","interrupted","materialized","answered"] as const){const g=await goal(status);await assert.rejects(m.cancel(g.id),(e:Error&{status?:number})=>e.status===409&&e.message.includes(status),status);assert.equal((await f.store.findGoal(g.id)).status,status);}
 for(const status of ["failed","materialized","answered","ready"] as const){const g=await goal(status);assert.equal((await m.halt(g.id)).status,status,`halt leaves ${status}`);}
 }finally{await m.shutdown();}
});
test("cancelling a registered investigation aborts it and reports the pending shutdown; a repeat cancel stays pending",async()=>{
 const f=await fixture("wait"),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store);await m.initialize();
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"pending"});await until(f.store,g.id,["investigating"]);
 const first=await m.cancel(g.id),second=await m.cancel(g.id);for(const c of [first,second]){assert.match(c.reason??"",/esperando el cierre del agente/);assert.equal(c.cancelRequested,true);}
 await settle(m,g.id);const done=await f.store.findGoal(g.id);assert.equal(done.status,"cancelled",done.reason??"");
 const again=await m.retry(g.id,done.revision);assert.equal(again.status,"queued");assert.equal(again.cancelRequested,false);await until(f.store,g.id,["investigating"]);await m.cancel(g.id);await settle(m,g.id);}finally{await m.shutdown();}
});
test("a cancel pending at restart is honored instead of replayed or reported as an interruption",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();
 const queued=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"restart-queued"}),running=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"restart-running"});
 await f.store.patchGoal(queued.id,{cancelRequested:true});await f.store.patchGoal(running.id,{status:"investigating",cancelRequested:true});await m.shutdown();
 const reopened=new GoalManager(new LocalStore(f.store.root),{autoStart:false});await reopened.initialize();
 try{for(const id of [queued.id,running.id]){const g=await f.store.findGoal(id);assert.equal(g.status,"cancelled");assert.equal(g.cancelRequested,false);assert.ok(g.finishedAt);}}finally{await reopened.shutdown();}
});
test("a queued goal cancels immediately while its provider account is connecting",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js");let connecting=false;const m=new GoalManager(f.store,{autoStart:false,canStart:()=>!connecting});await m.initialize();
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"connecting"});connecting=true;m.wake();await new Promise(r=>setTimeout(r,150));assert.equal(m.isActive(g.id),false);assert.equal((await f.store.findGoal(g.id)).status,"queued");const c=await m.cancel(g.id);assert.equal(c.status,"cancelled");connecting=false;m.wake();await new Promise(r=>setTimeout(r,150));assert.equal((await f.store.findGoal(g.id)).status,"cancelled");assert.equal(m.isActive(g.id),false);}finally{await m.shutdown();}
});
test("halting an apparently orphaned investigation keeps a result that completed while the lease was checked",async()=>{
 const f=await fixture(),{GoalManager}=await import("../src/local/goals.js"),m=new GoalManager(f.store,{autoStart:false});await m.initialize();
 try{const g=await m.start({projectId:f.project.id,objective:"Suma",agentId:"claude",requestKey:"orphan-race"}),attempt={id:"00000000-0000-4000-8000-000000000002",startedAt:Date.now(),finishedAt:null,status:"running" as const,error:null,usage:null,sessionId:null,durationMs:null};
 await f.store.patchGoal(g.id,{status:"investigating",attempts:[attempt]});
 // Simulate execute() persisting its result during the lease check that follows the stale read.
 const internal=m as unknown as {refreshLeaseState(goal:GoalRecord):Promise<string|null>},refresh=internal.refreshLeaseState.bind(m);
 internal.refreshLeaseState=async goal=>{const problem=await refresh(goal);await f.store.patchGoal(g.id,{status:"ready",finishedAt:Date.now(),attempts:[{...attempt,status:"succeeded",finishedAt:Date.now()}]});return problem;};
 const h=await m.halt(g.id),saved=await f.store.findGoal(g.id);
 assert.equal(h.status,"ready");assert.equal(saved.status,"ready");assert.equal(saved.attempts[0]!.status,"succeeded");}finally{await m.shutdown();}
});
