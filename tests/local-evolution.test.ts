import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import type {EvolutionRecord} from '../src/local/evolution-contracts.js';

async function fixture(mode='repair',provider:'codex'|'claude'='codex'){
 const root=await mkdtemp(join(tmpdir(),'salem evolve ')),store=new LocalStore(join(root,'data')),{project,task}=await createLocalDemo(store);
 const config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};
 config.agents={[provider]:{provider,command:[process.execPath,resolve('tests/fixtures/evolution-agent.mjs'),provider,mode]}};
 config.supervisor!.roles={define:provider,build:provider,review:provider};
 const p=await store.saveProject({...project,config});return {root,store,project:p,task,provider};
}
async function manager(f:Awaited<ReturnType<typeof fixture>>,autoStart=true){const m=await import('../src/local/evolution.js').catch(()=>({EvolutionManager:undefined}));assert.equal(typeof m.EvolutionManager,'function','evolution manager missing');const result=new m.EvolutionManager!(f.store,{autoStart});await result.initialize();return result;}
async function done(f:Awaited<ReturnType<typeof fixture>>,id:string){const end=Date.now()+f.project.config.supervisor!.runTimeoutMs+10000;while(Date.now()<end){const e=(await f.store.readState()).evolutions?.find(e=>e.id===id);if(e&&!['queued','baseline','planning','candidate','checking','reviewing'].includes(e.status))return e;await new Promise(r=>setTimeout(r,30));}throw Error('Evolution did not finish within its configured budget and cleanup grace');}
for(const provider of ['codex','claude'] as const)test(`evolution ${provider} repairs a reproduced defect with original acceptance and independent review`,async()=>{
 const f=await fixture('repair',provider),before=await readFile(join(f.project.config.repoRoot,'sum.mjs'),'utf8'),m=await manager(f);
 try{const input={taskId:f.task.id,agentId:provider,requestKey:'repair'},[a,b]=await Promise.all([m.start(input),m.start(input)]);assert.equal(a.id,b.id);const e=await done(f,a.id);
 assert.equal(e.status,'improved',e.reason??'');assert.equal(e.baseline[0]?.status,'failed');assert.equal(e.candidateChecks[0]?.status,'passed');assert.equal(e.acceptance?.accepted,true);assert.ok(e.plan?.facts.length);assert.notEqual(e.patch?.sessionId,e.review?.sessionId);assert.match(e.diff,/a\+b/);assert.deepEqual(e.task,f.task.spec);assert.deepEqual(e.project.config.capabilities,f.project.config.capabilities);assert.equal(await readFile(join(f.project.config.repoRoot,'sum.mjs'),'utf8'),before);assert.equal((await new LocalStore(f.store.root).readState()).evolutions?.length,1);
 }finally{await m.shutdown();}
});
for(const mode of ['checker','extra','expand','noop','mutate','badreview'] as const)test(`evolution rejects ${mode} without weakening frozen evaluation`,async()=>{
 const f=await fixture(mode),m=await manager(f);try{const e=await done(f,(await m.start({taskId:f.task.id,agentId:f.provider,requestKey:mode})).id);assert.notEqual(e.status,'improved');assert.equal(e.acceptance?.accepted??false,false);if(['checker','extra','expand','mutate'].includes(mode))assert.equal(e.candidateChecks.length,0);assert.equal(await readFile(join(f.project.config.repoRoot,'sum.mjs'),'utf8'),'export function sum(a,b){return a-b;}\n');}finally{await m.shutdown();}
});
test('read-only candidate receives complete source contents without needing a shell command',async()=>{
 const f=await fixture('needs-source'),m=await manager(f);try{const e=await done(f,(await m.start({taskId:f.task.id,requestKey:'source-in-prompt'})).id);assert.equal(e.status,'improved',e.reason??'');}finally{await m.shutdown();}
});
test('evolution refuses publication authority, checker scope and stale task profile',async()=>{
 const f=await fixture(),m=await manager(f,false);try{const p=await f.store.saveProject({...f.project,config:{...f.project.config,capabilities:{...f.project.config.capabilities,commit:true}}});await assert.rejects(m.start({taskId:f.task.id,requestKey:'authority'}),/permiso|local|commit|autoridad/i);
 await f.store.saveProject({...p,config:f.project.config});const t=await f.store.saveTask({...f.task,spec:{...f.task.spec,scope:['.salem-check.mjs']}});await assert.rejects(m.start({taskId:t.id,requestKey:'scope'}),/protegid|alcance|verificador/i);
 }finally{await m.shutdown();}
});
test('evolution does not let task scope delegate framework authority or instructions',async()=>{
 const f=await fixture(),{evolutionScope}=await import('../src/local/evolution-policy.js');
 for(const path of ['AGENTS.md','.salem-check.mjs','tests/example.mjs','src/acceptance.ts','src/adapters/codex.ts','src/process.ts','src/local/server.ts','src/local/evolution.ts','templates/build.md','scripts/start-local.mjs'])assert.throws(()=>evolutionScope(f.project,{...f.task.spec,scope:[path]}),/protegido|alcance/i,path);
});
test('baseline without a reproduced defect does not spend an inference or claim improvement',async()=>{
 const f=await fixture(),{localGit}=await import('../src/local/git.js');await writeFile(join(f.project.config.repoRoot,'sum.mjs'),'export function sum(a,b){return a+b;}\n');await localGit(f.project.config.repoRoot,['add','sum.mjs'],f.store.root);await localGit(f.project.config.repoRoot,['-c','user.name=Demo','-c','user.email=demo@example.invalid','commit','-m','Baseline already correct'],f.store.root);
 const m=await manager(f);try{const e=await done(f,(await m.start({taskId:f.task.id,requestKey:'already-correct'})).id);assert.equal(e.status,'no_improvement');assert.equal(e.planning,null);assert.equal(e.patch,null);assert.equal(e.baseline[0]?.status,'passed');}finally{await m.shutdown();}
});
test('a changed profile blocks a queued experiment rather than silently adopting new authority',async()=>{
 const f=await fixture(),m=await manager(f,false);try{const e=await m.start({taskId:f.task.id,requestKey:'changed'});await f.store.saveProject({...f.project,config:{...f.project.config,instructions:'New policy'}});m.wake();const end=await done(f,e.id);assert.equal(end.status,'blocked');assert.equal(end.baseline.length,0);assert.match(end.reason??'',/cambi|perfil/i);}finally{await m.shutdown();}
});
test('active cancellation terminates only the owned inference and retains baseline evidence',async()=>{
 const f=await fixture('wait'),m=await manager(f);try{const e=await m.start({taskId:f.task.id,requestKey:'active-cancel'});const end=Date.now()+30000;while(Date.now()<end){if((await m.detail(e.id)).status==='planning')break;await new Promise(r=>setTimeout(r,40));}await m.cancel(e.id);const cancelled=await done(f,e.id);assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.baseline[0]?.status,'failed');assert.equal(cancelled.acceptance,null);}finally{await m.shutdown();}
});
test('evolution cancellation and restart preserve evidence and quarantine unconfirmed children',async()=>{
 const f=await fixture('wait'),m=await manager(f,false),e=await m.start({taskId:f.task.id,requestKey:'persist'});await m.cancel(e.id);assert.equal((await m.detail(e.id)).status,'cancelled');await m.shutdown();
 const token=randomUUID(),leaseDir=join(f.store.root,'evolution',e.id,'leases');await mkdir(leaseDir,{recursive:true});await writeFile(join(leaseDir,`${token}.json`),JSON.stringify({pid:process.pid,token,closed:false}));
 await f.store.patchEvolution(e.id,{status:'planning'});const n=await manager(f,false);try{assert.equal((await n.detail(e.id)).status,'interrupted');assert.equal(n.isBusy(f.provider),true);assert.equal(n.activeCount(),1);await assert.rejects(n.start({taskId:f.task.id,requestKey:'held'}),/recibo|limpieza|cierre/i);await assert.rejects(n.artifact(e.id,'../catalog.json',0),/ruta|artefact|permit/i);}finally{await n.shutdown();}
});
