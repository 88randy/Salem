import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {GoalManager} from '../src/local/goals.js';
import {ExecutionManager} from '../src/local/executions.js';
import {ConversationManager} from '../src/local/conversations.js';
test('managed queues wait for durable conversation links and remain stopped while paused',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem chat queue ')),store=new LocalStore(root),demo=await createLocalDemo(store),config=structuredClone(demo.project.config);
 for(const agent of Object.values(config.agents))agent.command=[process.execPath,'-e','process.exit(7)'];
 const project=await store.saveProject({...demo.project,config}),goals=new GoalManager(store),executions=new ExecutionManager(store),chat=new ConversationManager(store,goals,executions,{autoStart:false});
 await goals.initialize();await executions.initialize();await chat.initialize();
 try{
  const c=await chat.start({projectId:project.id,text:'Suma',requestKey:'queue'}),goal=await goals.start({projectId:project.id,objective:'Suma',requestKey:'unlinked',conversational:true});await new Promise(r=>setTimeout(r,300));assert.equal((await store.findGoal(goal.id)).status,'queued');assert.equal((await store.findGoal(goal.id)).attempts.length,0);
  const id=randomUUID(),at=Date.now();await store.updateConversation(c.id,v=>{v.status='working';v.goalId=goal.id;v.steps=[{key:goal.id+':sum',planTask:{id:'sum',title:'Suma',objective:'Suma',scope:['sum.mjs'],acceptance:['Suma'],checkIds:['sum'],dependsOn:[],agentId:'codex'},taskId:demo.task.id,executionId:null,status:'running',attempt:0}];});
  await store.saveExecution({id,revision:1,projectId:project.id,taskId:demo.task.id,conversationId:c.id,requestKey:'unlinked-execution',createdAt:at,updatedAt:at,finishedAt:null,status:'queued',reason:null,project,task:demo.task.spec,workspace:null,sourceSha:null,runId:null,stateDir:join(store.root,'executions',id,'runs'),setupMs:null,preparationLogs:[]});
  executions.wake();await new Promise(r=>setTimeout(r,300));assert.equal((await store.findExecution(id)).status,'queued');
  await store.updateConversation(c.id,v=>{v.status='paused';v.steps[0]!.executionId=id;});executions.wake();await new Promise(r=>setTimeout(r,300));assert.equal((await store.findExecution(id)).status,'queued');assert.equal(executions.activeCount(),0);
  await store.saveProject({...project,name:'Profile changed'});
  await assert.rejects(executions.resumeManaged(id),/perfil|configuraci/i);
  await store.updateConversation(c.id,v=>{v.status='working';});executions.wake();
  const deadline=Date.now()+10000;while(Date.now()<deadline&&(await store.findExecution(id)).status==='queued')await new Promise(r=>setTimeout(r,30));
  assert.equal((await store.findExecution(id)).status,'blocked');assert.match((await store.findExecution(id)).reason??'',/perfil|configuraci/i);assert.equal(executions.activeCount(),0);assert.equal((await store.findExecution(id)).workspace,null);
 }finally{await chat.shutdown();await goals.shutdown();await executions.shutdown();}
});
