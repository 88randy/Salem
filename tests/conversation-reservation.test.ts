import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {GoalManager} from '../src/local/goals.js';
import {ExecutionManager} from '../src/local/executions.js';
import {ConversationManager} from '../src/local/conversations.js';
test('a failed reservation stops until an explicit continue and never creates a retry storm',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem chat reservation ')),store=new LocalStore(root),{project}=await createLocalDemo(store),goals=new GoalManager(store,{autoStart:false}),executions=new ExecutionManager(store,{autoStart:false});
 let starts=0,available=false;const original=goals.start.bind(goals);goals.start=async input=>{starts++;if(!available)throw Error('Cuenta ocupada');return original(input);};
 const chat=new ConversationManager(store,goals,executions,{autoStart:false});await chat.initialize();const c=await chat.start({projectId:project.id,text:'Suma',requestKey:'reservation'});
 const settle=async()=>{chat.wake();await new Promise(r=>setTimeout(r,150));};
 try{await settle();for(let n=0;n<3;n++)await settle();assert.equal(starts,1);const blocked=await store.findConversation(c.id);assert.equal(blocked.status,'blocked');assert.equal(blocked.messages.filter(m=>m.text==='Cuenta ocupada').length,1);
 available=true;await chat.command(c.id,'continue',{revision:blocked.revision,requestKey:'continue'});const deadline=Date.now()+10000;while(Date.now()<deadline&&!(await store.findConversation(c.id)).goalId)await settle();assert.equal(starts,2);assert.equal((await store.readState()).goals?.length,1);assert.equal((await store.findConversation(c.id)).status,'planning');
 }finally{await chat.shutdown();await goals.shutdown();await executions.shutdown();}
});
