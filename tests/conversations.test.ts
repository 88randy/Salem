import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {ExecutionManager} from '../src/local/executions.js';
import {GoalManager} from '../src/local/goals.js';
import {ConversationManager} from '../src/local/conversations.js';
import {localGit} from '../src/local/git.js';
const until=async<T>(read:()=>Promise<T|undefined>,ms=600000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){const v=await read();if(v)return v;await new Promise(r=>setTimeout(r,80));}throw Error('Tiempo agotado esperando la conversación');};
async function fixture(){
 const root=await mkdtemp(join(tmpdir(),'salem conversation ')),store=new LocalStore(join(root,'data')),{project}=await createLocalDemo(store);
 const config=structuredClone(project.config);config.capabilities.commit=false;delete config.delivery;
 config.checks.push({id:'docs',command:[process.execPath,'-e',"require('node:assert/strict').match(require('node:fs').readFileSync('sum.mjs','utf8'),/Suma dos números/);"],required:false},{id:'types',command:[process.execPath,'--input-type=module','-e',"import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.throws(()=>sum('2',3),TypeError);"],required:false});
 for(const [id,agent] of Object.entries(config.agents))agent.command=[process.execPath,resolve('tests/fixtures/conversation-agent.mjs'),id];
 const p=await store.saveProject({...project,config});
 const executions=new ExecutionManager(store),goals=new GoalManager(store,{acceptedBase:id=>executions.acceptedBase(id),additionalActive:()=>executions.activeCount()}),chat=new ConversationManager(store,goals,executions);
 await executions.initialize();await goals.initialize();await chat.initialize();return {root,store,project:p,executions,goals,chat,close:async()=>{await chat.shutdown();await goals.shutdown();await executions.shutdown();}};
}
test('chat persists questions, idempotent answers and three accepted dependent tasks without commits',async()=>{
 const f=await fixture(),before=await localGit(f.project.config.repoRoot,['rev-parse','HEAD'],f.store.root);
 try{
  const request={projectId:f.project.id,text:'Corregir suma, documentar comportamiento y cubrir casos límite',requestKey:'new-chat'};
  const [a,b]=await Promise.all([f.chat.start(request),f.chat.start(request)]);assert.equal(a.id,b.id);
  const question=await until(async()=>{const c=await f.store.findConversation(a.id);if(c.status==='blocked')throw Error(c.reason??'blocked');return c.status==='needs_input'?c:undefined;});
  assert.match(question.messages.at(-1)!.text,/texto/);
  const reply={revision:question.revision,requestKey:'answer-one',text:'Rechaza texto con TypeError.'};
  await f.chat.command(a.id,'message',reply);const two=await f.chat.command(a.id,'message',reply);assert.equal(two.messages.filter(m=>m.key==='answer-one').length,1);assert.equal(two.commands.filter(cmd=>cmd.key==='answer-one').length,1);
  const done=await until(async()=>{const c=await f.store.findConversation(a.id);if(c.status==='blocked')throw Error(c.reason??'blocked');return c.status==='completed'?c:undefined;});
  assert.equal(done.steps.length,3);assert.ok(done.steps.every(s=>s.status==='accepted'));
  const state=await f.store.readState(),executions=state.executions.filter(e=>e.conversationId===a.id);assert.equal(executions.length,3);
  assert.equal(executions[1]!.continuationId,executions[0]!.id);assert.equal(executions[2]!.continuationId,executions[1]!.id);
  for(const e of executions){assert.equal(e.status,'completed');const d=await f.executions.detail(e.id);assert.equal(d.run?.acceptance?.accepted,true);assert.equal(d.run?.deliveryJournal?.commitSha,undefined);assert.equal(await localGit(e.workspace!,['rev-parse','HEAD'],f.store.root),before);}
  const final=await f.executions.detail(executions[2]!.id);assert.deepEqual((final.run!.checks??[]).filter(c=>c.status==='passed').map(c=>c.checkId).sort(),['docs','sum','types']);assert.ok(final.run!.task.acceptance.includes('Suma documentada y texto rechazado'));
  assert.match(await readFile(join(executions[2]!.workspace!,'sum.mjs'),'utf8'),/TypeError/);
  assert.equal(await localGit(f.project.config.repoRoot,['status','--porcelain'],f.store.root),'');assert.match(await readFile(join(f.project.config.repoRoot,'sum.mjs'),'utf8'),/a-b/);
  assert.equal((await f.store.readState()).projects.find(p=>p.id===f.project.id)!.revision,f.project.revision);
  await assert.rejects(f.store.saveTask({...state.tasks.find(t=>t.id===done.steps[0]!.taskId)!,spec:{...state.tasks.find(t=>t.id===done.steps[0]!.taskId)!.spec,acceptance:[]}}),/conversaci|congelado/i);
  await assert.rejects(f.executions.start(done.steps[0]!.taskId,'bypass-chat'),/conversaci|dependencias/i);
  const reloaded=new LocalStore(f.store.root);assert.equal((await reloaded.findConversation(a.id)).messages.length,done.messages.length);
  const previous=executions[0]!;await writeFile(join(previous.workspace!,'sum.mjs'),'tampered');await assert.rejects(f.executions.acceptedBase(previous.id),/cambi|base|acept/i);
 }finally{await f.close();}
});
