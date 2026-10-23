import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {ExecutionManager} from '../src/local/executions.js';
import {GoalManager} from '../src/local/goals.js';
import {ConversationManager} from '../src/local/conversations.js';
import type {GoalPlan} from '../src/local/research-contracts.js';
const until=async<T>(fn:()=>Promise<T|undefined>)=>{const deadline=Date.now()+20000;while(Date.now()<deadline){const v=await fn();if(v)return v;await new Promise(r=>setTimeout(r,20));}throw Error('Coordinator did not reconcile');};

test('coordinator recovery reuses an interrupted execution and explicit retry preserves accepted predecessors',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem chat recovery ')),store=new LocalStore(root),{project}=await createLocalDemo(store);
 const goals=new GoalManager(store,{autoStart:false}),executions=new ExecutionManager(store,{autoStart:false});
 // These ports simulate persisted native outcomes. The native pipeline and proof validation
 // are exercised separately by conversations.test.ts; this test isolates coordinator recovery.
 executions.acceptedBase=async()=>({} as any);
 executions.resumeManaged=async id=>store.patchExecution(id,{status:'queued',reason:null});
 const start=goals.start.bind(goals);goals.start=async request=>{
  const goal=await start(request),node=(id:string,dependsOn:string[]=[])=>({id,title:id,objective:'Implementar '+id,scope:['sum.mjs'],acceptance:['Suma válida'],checkIds:['sum'],dependsOn,agentId:'codex'});
  const plan:GoalPlan={schemaVersion:1,verdict:'ready',summary:'Tres pasos.',facts:[{description:'Suma',files:['sum.mjs']}],assumptions:[],decisions:[],questions:[],steps:[{title:'Suma',description:'Suma',files:['sum.mjs']}],task:{objective:'Suma completa',scope:['sum.mjs'],acceptance:['Resultado conjunto'],references:['sum.mjs'],checkIds:['sum']},proposedChecks:[],work:{tasks:[node('one'),node('two',['one']),node('three',['two'])]}};
  return store.patchGoal(goal.id,{status:'ready',plan});
 };
 goals.verifiedPlan=async id=>({goal:await store.findGoal(id),files:['sum.mjs']});
 let chat=new ConversationManager(store,goals,executions,{autoStart:false});await chat.initialize();
 const c=await chat.start({projectId:project.id,text:'Tres pasos',requestKey:'recover'});
 const tick=async()=>{chat.wake();await new Promise(r=>setTimeout(r,30));};
 const execution=async(index:number)=>until(async()=>{await tick();const current=await store.findConversation(c.id);return current.steps[index]?.executionId;});
 const first=await execution(0);const frozenGoal=await store.findGoal((await store.findConversation(c.id)).goalId!);await assert.rejects(goals.materialize(frozenGoal.id,frozenGoal.revision),/conversaci/i);await store.patchExecution(first,{status:'completed'});
 const second=await execution(1);await store.patchExecution(second,{status:'running'});
 await executions.initialize();chat=new ConversationManager(store,goals,executions,{autoStart:false});await chat.initialize();
 let current=await store.findConversation(c.id);assert.equal(current.status,'paused');assert.equal(current.steps[0]!.status,'accepted');assert.equal((await store.findExecution(second)).status,'interrupted');
 const resume={revision:current.revision,requestKey:'resume'};await chat.command(c.id,'continue',resume);await chat.command(c.id,'continue',resume);await tick();
 assert.equal((await store.readState()).executions.filter(e=>e.conversationId===c.id).length,2);assert.equal((await store.findConversation(c.id)).steps[1]!.executionId,second);
 await store.patchExecution(second,{status:'completed'});const third=await execution(2);await store.patchExecution(third,{status:'failed',reason:'Cuota de fixture agotada'});await tick();
 current=await until(async()=>{await tick();const v=await store.findConversation(c.id);return v.status==='blocked'?v:undefined;});assert.match(current.messages.at(-1)!.text,/Cuota/);assert.equal(current.lastAcceptedExecutionId,second);
 await chat.command(c.id,'retry',{revision:current.revision,requestKey:'retry'});
 const retried=await until(async()=>{await tick();const v=await store.findConversation(c.id);return v.steps[2]!.executionId&&v.steps[2]!.executionId!==third?v.steps[2]!.executionId:undefined;});
 assert.equal((await store.findExecution(retried)).continuationId,second);await store.patchExecution(retried,{status:'completed'});
 const done=await until(async()=>{await tick();const v=await store.findConversation(c.id);return v.status==='completed'?v:undefined;});assert.equal(done.steps.filter(s=>s.status==='accepted').length,3);assert.equal((await store.readState()).executions.filter(e=>e.conversationId===c.id).length,4);
 await chat.shutdown();await goals.shutdown();await executions.shutdown();
});
