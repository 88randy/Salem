import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {EvolutionManager} from '../src/local/evolution.js';
import {localGit} from '../src/local/git.js';

const before='export function sum(a,b){return a-b;}\n',after='export function sum(a,b){return a+b;}\n';
async function fixture(sourceFails=false){
 const root=await mkdtemp(join(tmpdir(),'salem promotion ')),store=new LocalStore(join(root,'data')),{project,task}=await createLocalDemo(store);
 const config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};
 config.agents={codex:{provider:'codex',command:[process.execPath,resolve('tests/fixtures/evolution-agent.mjs'),'codex','repair']}};config.supervisor!.roles={define:'codex',build:'codex',review:'codex'};
 if(sourceFails){const checker=join(config.repoRoot,'.salem-check.mjs');await writeFile(checker,(await readFile(checker,'utf8'))+`\nif(process.cwd()===${JSON.stringify(config.repoRoot)})process.exit(7);\n`);await localGit(config.repoRoot,['add','.salem-check.mjs'],store.root);await localGit(config.repoRoot,['-c','user.name=Demo','-c','user.email=demo@example.invalid','commit','-m','Environment-specific check fixture'],store.root);}
 const p=await store.saveProject({...project,config}),m=new EvolutionManager(store);await m.initialize();return {store,project:p,task,m,file:join(config.repoRoot,'sum.mjs')};
}
async function wait(f:Awaited<ReturnType<typeof fixture>>,id:string){const deadline=Date.now()+600000;while(Date.now()<deadline){const e=await f.m.detail(id) as any;if(!['queued','baseline','planning','candidate','checking','reviewing'].includes(e.status)&&!['queued','preparing','applying','verifying','rolling_back'].includes(e.promotion?.status))return e;await new Promise(r=>setTimeout(r,30));}throw Error('Promotion timeout');}
async function start(f:Awaited<ReturnType<typeof fixture>>,applyOnSuccess=false){const e=await f.m.start({taskId:f.task.id,requestKey:'promotion',...(applyOnSuccess?{applyOnSuccess}: {})} as any);return wait(f,e.id);}
async function apply(f:Awaited<ReturnType<typeof fixture>>,e:any){const method=(f.m as any).apply;assert.equal(typeof method,'function','trusted application controller is missing');await method.call(f.m,e.id,e.revision);return wait(f,e.id);}

test('automatic promotion writes only accepted bytes, verifies original checks and supports durable manual rollback',async()=>{
 const f=await fixture();try{const head=await localGit(f.project.config.repoRoot,['rev-parse','HEAD'],f.store.root),e=await start(f,true);
 assert.equal(e.status,'improved',e.reason);assert.equal(e.promotion?.status,'applied',e.promotion?.reason);assert.equal(await readFile(f.file,'utf8'),after);assert.equal(e.promotion.checks[0].status,'passed');assert.ok(e.promotion.entries[0].before);assert.equal(await localGit(f.project.config.repoRoot,['rev-parse','HEAD'],f.store.root),head);
 assert.deepEqual((await f.store.readState()).projects[0]?.config.capabilities,{edit:true,commit:false,pull_request:false,merge:false,deploy:false});
 await (f.m as any).rollback(e.id,e.revision);const reverted=await wait(f,e.id);assert.equal(reverted.promotion.status,'rolled_back');assert.equal(await readFile(f.file,'utf8'),before);
 assert.equal((await new LocalStore(f.store.root).readState()).evolutions?.[0]?.id,e.id);
 }finally{await f.m.shutdown();}
});
test('checks that fail in the target automatically restore original source without changing the evaluator',async()=>{
 const f=await fixture(true);try{const e=await start(f,true);assert.equal(e.status,'improved',e.reason);assert.equal(e.promotion?.status,'rolled_back',e.promotion?.reason);assert.equal(e.promotion.checks[0].exitCode,7);assert.equal(await readFile(f.file,'utf8'),before);assert.equal(e.acceptance.accepted,true);}finally{await f.m.shutdown();}
});
test('promotion refuses changed source, candidate bytes and damaged acceptance receipts',async()=>{
 const f=await fixture();try{const e=await start(f);assert.equal(e.status,'improved',e.reason);
 await writeFile(f.file,'// user edit\n');await assert.rejects(apply(f,e),/origen|limpio|base|cambi/i);assert.equal(await readFile(f.file,'utf8'),'// user edit\n');await writeFile(f.file,before);
 const candidate=join(f.store.root,'research',e.id,e.snapshotIds.candidate,'workspace','sum.mjs');await writeFile(candidate,'// tampered\n');await assert.rejects(apply(f,e),/candidata|árbol|evidencia|cambi/i);await writeFile(candidate,after);
 await writeFile(join(e.candidateChecks[0].artifactDir,'stdout.log'),'tamper');await assert.rejects(apply(f,e),/aceptación|evidencia|recibo/i);assert.equal(await readFile(f.file,'utf8'),before);
 }finally{await f.m.shutdown();}
});
test('rollback preserves later user edits and permits retry only after the conflict is resolved',async()=>{
 const f=await fixture();try{let e=await start(f,true);assert.equal(e.promotion?.status,'applied');await writeFile(f.file,'// later user edit\n');await (f.m as any).rollback(e.id,e.revision);e=await wait(f,e.id);assert.equal(e.promotion.status,'conflict');assert.equal(await readFile(f.file,'utf8'),'// later user edit\n');await writeFile(f.file,after);await (f.m as any).rollback(e.id,e.revision);e=await wait(f,e.id);assert.equal(e.promotion.status,'rolled_back');assert.equal(await readFile(f.file,'utf8'),before);}finally{await f.m.shutdown();}
});
test('restart restores an interrupted journal and never repeats application or inference',async()=>{
 const f=await fixture();try{const e=await start(f,true);assert.equal(e.promotion?.status,'applied');await f.m.shutdown();await f.store.patchEvolution(e.id,{promotion:{...e.promotion,status:'applying'}} as any);f.m=new EvolutionManager(f.store,{autoStart:false});await f.m.initialize();const recovered=await f.m.detail(e.id) as any;assert.equal(recovered.promotion.status,'rolled_back');assert.equal(await readFile(f.file,'utf8'),before);assert.equal(recovered.inferenceAttempts,3);}finally{await f.m.shutdown();}
});
