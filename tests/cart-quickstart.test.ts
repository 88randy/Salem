import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFile,mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {cartGoal,createLocalCart} from '../src/local/demo.js';
import {ExecutionManager} from '../src/local/executions.js';
import {GoalManager} from '../src/local/goals.js';
import {ConversationManager} from '../src/local/conversations.js';
import {localGit} from '../src/local/git.js';
import type {ProjectConfig} from '../src/contracts.js';

// The answer the guide suggests; it matches the shipping policy fixed by the fixture checks.
const policy='Envío de $99 si el subtotal es menor a $999; gratis desde $999. Un carrito vacío no paga envío.';
const reference=resolve('tests/fixtures/cart-reference.mjs');
const run=(config:ProjectConfig,root:string)=>Object.fromEntries(config.checks.map(c=>[c.id,spawnSync(c.command[0]!,c.command.slice(1),{cwd:root,windowsHide:true,encoding:'utf8'}).status]));
const until=async<T>(read:()=>Promise<T|undefined>,ms=600000)=>{const deadline=Date.now()+ms;while(Date.now()<deadline){const v=await read();if(v)return v;await new Promise(r=>setTimeout(r,80));}throw Error('Tiempo agotado esperando la conversación');};

test('cart fixture checks fail on the initial commit and pass on the reference solution',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem cart checks '));
 try{
  const {project,goal}=await createLocalCart(new LocalStore(root),{define:'claude',build:'claude',review:'codex'}),repo=project.config.repoRoot;
  assert.equal(goal,cartGoal);assert.doesNotMatch(goal,/\$|gratis|999|umbral/i);
  assert.deepEqual(project.config.supervisor!.roles,{define:'claude',build:'claude',review:'codex'});
  assert.deepEqual(project.config.checks.map(c=>[c.id,c.required]),[['api',true],['subtotal',false],['shipping',false],['total',false]]);
  // The repository is exactly the versioned fixture, committed once with LF endings.
  const fixture=resolve('fixtures/cart-quickstart'),files=(await readdir(fixture,{recursive:true,withFileTypes:true})).filter(e=>e.isFile()).map(e=>join(e.parentPath,e.name).slice(fixture.length+1).replaceAll('\\','/')).sort();
  assert.deepEqual((await localGit(repo,['ls-files'],root)).split('\n').sort(),files);
  for(const f of files)assert.equal(await readFile(join(repo,f),'utf8'),(await readFile(join(fixture,f),'utf8')).replaceAll('\r\n','\n'));
  assert.equal(await localGit(repo,['rev-list','--count','HEAD'],root),'1');assert.equal(await localGit(repo,['status','--porcelain'],root),'');
  assert.deepEqual(run(project.config,repo),{api:0,subtotal:1,shipping:1,total:1});
  await copyFile(reference,join(repo,'cart.mjs'));
  assert.deepEqual(run(project.config,repo),{api:0,subtotal:0,shipping:0,total:0});
 }finally{await rm(root,{recursive:true,force:true});}
});

test('creating the cart example twice keeps two independent projects',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem cart twice '));
 try{
  const store=new LocalStore(root),first=await createLocalCart(store),second=await createLocalCart(store);
  assert.notEqual(first.project.id,second.project.id);assert.notEqual(first.project.config.projectId,second.project.config.projectId);
  assert.notEqual(first.project.config.repoRoot,second.project.config.repoRoot);
  assert.deepEqual([first.project.name,second.project.name],['Ejemplo carrito','Ejemplo carrito 2']);
  assert.equal(await localGit(first.project.config.repoRoot,['status','--porcelain'],root),'');
  assert.equal((await store.readState()).projects.length,2);
 }finally{await rm(root,{recursive:true,force:true});}
});

async function conversation(maxAttempts?:number){
 const root=await mkdtemp(join(tmpdir(),'salem cart chat ')),store=new LocalStore(join(root,'data')),{project,goal}=await createLocalCart(store);
 const config=structuredClone(project.config);config.capabilities.commit=false;delete config.delivery;if(maxAttempts)config.supervisor!.maxAttempts=maxAttempts;
 for(const [id,agent] of Object.entries(config.agents))agent.command=[process.execPath,resolve('tests/fixtures/cart-agent.mjs'),id];
 const p=await store.saveProject({...project,config});
 const executions=new ExecutionManager(store),goals=new GoalManager(store,{acceptedBase:id=>executions.acceptedBase(id),additionalActive:()=>executions.activeCount()}),chat=new ConversationManager(store,goals,executions);
 await executions.initialize();await goals.initialize();await chat.initialize();
 const started=await chat.start({projectId:p.id,text:goal,requestKey:'cart'});
 const question=await until(async()=>{const c=await store.findConversation(started.id);if(c.status==='blocked')throw Error(c.reason??'blocked');return c.status==='needs_input'?c:undefined;});
 return {root,store,project:p,executions,chat,question,close:async()=>{await chat.shutdown();await goals.shutdown();await executions.shutdown();await rm(root,{recursive:true,force:true});}};
}

test('cart quickstart asks for the shipping policy and completes three dependent tasks with fixture agents',async()=>{
 const f=await conversation();
 try{
  assert.match(f.question.messages.at(-1)!.text,/envío/i);assert.equal(f.question.steps.length,0);
  await f.chat.command(f.question.id,'message',{revision:f.question.revision,requestKey:'policy',text:policy});
  const done=await until(async()=>{const c=await f.store.findConversation(f.question.id);if(c.status==='blocked')throw Error(c.reason??'blocked');return c.status==='completed'?c:undefined;});
  assert.deepEqual(done.steps.map(s=>[s.planTask.id,s.planTask.dependsOn,s.status]),[['subtotal',[],'accepted'],['shipping',['subtotal'],'accepted'],['total',['shipping'],'accepted']]);
  const runs=(await f.store.readState()).executions.filter(e=>e.conversationId===done.id);assert.equal(runs.length,3);
  assert.equal(runs[1]!.continuationId,runs[0]!.id);assert.equal(runs[2]!.continuationId,runs[1]!.id);assert.equal(done.lastAcceptedExecutionId,runs[2]!.id);
  const final=await f.executions.detail(runs[2]!.id);assert.equal(final.run?.acceptance?.accepted,true);
  assert.deepEqual((final.run!.checks??[]).filter(c=>c.status==='passed').map(c=>c.checkId).sort(),['api','shipping','subtotal','total']);
  assert.equal(await readFile(join(runs[2]!.workspace!,'cart.mjs'),'utf8'),(await readFile(reference,'utf8')).replaceAll('\r\n','\n'));
  // The source repository keeps its initial commit; the accepted change lives in the isolated copy.
  assert.equal(await localGit(f.project.config.repoRoot,['status','--porcelain'],f.store.root),'');
  assert.match(await readFile(join(f.project.config.repoRoot,'cart.mjs'),'utf8'),/pendiente/);
 }finally{await f.close();}
});

test('an answer that contradicts the fixture checks stops at shipping and keeps the accepted subtotal',async()=>{
 // Define, build and review each count as an attempt: three lets subtotal pass and stops shipping after one failing build.
 const f=await conversation(3);
 try{
  await f.chat.command(f.question.id,'message',{revision:f.question.revision,requestKey:'contradiction',text:'El envío siempre es gratis.'});
  const stopped=await until(async()=>{const c=await f.store.findConversation(f.question.id);if(c.status==='completed')throw Error('completed despite failing checks');return c.status==='blocked'?c:undefined;});
  assert.deepEqual(stopped.steps.map(s=>[s.planTask.id,s.status]),[['subtotal','accepted'],['shipping','blocked'],['total','pending']]);
  const subtotal=stopped.steps[0]!.executionId!;assert.equal(stopped.lastAcceptedExecutionId,subtotal);
  assert.equal((await f.executions.detail(subtotal)).run?.acceptance?.accepted,true);
  const shipping=await f.executions.detail(stopped.steps[1]!.executionId!);assert.notEqual(shipping.run?.acceptance?.accepted,true);
  assert.ok((shipping.run!.checks??[]).some(c=>c.checkId==='shipping'&&c.status==='failed'));
 }finally{await f.close();}
});
