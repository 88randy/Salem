import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {ExecutionManager} from '../src/local/executions.js';
import {GoalManager} from '../src/local/goals.js';
import {ConversationManager} from '../src/local/conversations.js';
import {runFingerprint} from '../src/runner.js';

test('historical review context contains verified receipts from the whole accepted chain, never foreign work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem historical proof ')),store=new LocalStore(root),{project,task}=await createLocalDemo(store),executions=new ExecutionManager(store,{autoStart:false}),goals=new GoalManager(store,{autoStart:false}),chat=new ConversationManager(store,goals,executions,{autoStart:false});
 const c=await chat.start({projectId:project.id,text:'Tres pasos con revisiones independientes',requestKey:'history'}),ids=[randomUUID(),randomUUID(),randomUUID()],goalId=randomUUID();
 await store.updateConversation(c.id,v=>{v.goalId=goalId;v.status='working';v.lastAcceptedExecutionId=ids[1]!;v.steps=ids.map((id,i)=>({key:goalId+':'+i,taskId:task.id,executionId:id,status:i<2?'accepted':'running',attempt:0,planTask:{id:String(i),title:'Paso '+i,objective:'Suma',scope:['sum.mjs'],acceptance:['Suma'],checkIds:['sum'],dependsOn:i?[String(i-1)]:[],agentId:'codex'}}));});
 for(const [i,id] of ids.entries())await store.saveExecution({id,revision:1,projectId:project.id,taskId:task.id,conversationId:c.id,...(i?{continuationId:ids[i-1]!}:{}),requestKey:id,createdAt:1,updatedAt:1,finishedAt:i<2?2:null,status:i<2?'completed':'queued',reason:null,project,task:{...task.spec,id:'STEP-'+i},workspace:join(root,'workspaces',id),sourceSha:'a'.repeat(40),runId:randomUUID(),stateDir:join(root,'executions',id,'runs'),setupMs:0,preparationLogs:[]});
 const verified:string[]=[];
 // Isolate transport and ownership checks here. Native acceptance verification
 // itself is exercised by the real supervisor fixture in conversations.test.ts.
 executions.acceptedBase=async id=>{verified.push(id);const e=await store.findExecution(id),state:any={id:e.runId,projectId:project.config.projectId,status:'completed',task:e.task,configHash:'config-hash',instructionsHash:'instructions-hash',toolsHash:'runtime-hash',expected:{root:e.workspace,gitDir:join(e.workspace!,'.git'),head:e.sourceSha,treeHash:'accepted-tree',dirty:true},checkToolHashes:{sum:'check-tool-hash'},attempts:[{stage:'build',valid:true,result:{provider:'codex',sessionId:'build-'+id}},{stage:'review',valid:true,result:{provider:'codex',sessionId:'review-'+id,payload:{verdict:'success',findings:[]}}}]};const fingerprint=runFingerprint(state),proofId=randomUUID();state.acceptance={accepted:true,fingerprint,checkIds:[proofId],reasons:[]};state.checks=[{id:proofId,checkId:'sum',status:'passed',fingerprint,proofHash:'proof-hash'}];state.delivery={verdict:'success',fingerprint};return {state,config:project.config,evidenceRoot:'isolated-port-test'};};
 const history=await (executions as any).predecessorEvidence(ids[2]!);
 assert.deepEqual(verified,[ids[1],ids[0]]);assert.deepEqual(history.map((r:any)=>r.executionId),ids.slice(0,2));
 for(const receipt of history){assert.equal(receipt.acceptance.accepted,true);assert.equal(receipt.checks[0].status,'passed');assert.equal(receipt.checks[0].proofHash,'proof-hash');assert.equal(receipt.checks[0].relevantToAcceptance,true);assert.notEqual(receipt.review.sessionId,receipt.implementation.sessionId);assert.equal(receipt.integrity.instructionsHash,'instructions-hash');assert.equal(receipt.profileRevision,project.revision);}
 await store.patchExecution(ids[0]!,{conversationId:randomUUID()});await assert.rejects((executions as any).predecessorEvidence(ids[2]!),/conversaci|histori|pertenece/i);
 await store.patchExecution(ids[0]!,{conversationId:c.id,status:'failed'});await assert.rejects((executions as any).predecessorEvidence(ids[2]!),/aceptad|histori/i);
 await store.patchExecution(ids[0]!,{status:'completed',continuationId:ids[1]!});await assert.rejects((executions as any).predecessorEvidence(ids[2]!),/ciclo/i);
});
