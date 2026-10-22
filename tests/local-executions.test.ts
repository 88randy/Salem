import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile,mkdir,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {LocalStore} from "../src/local/store.js";
import {git} from "./supervisor-fixture.js";

async function modules(){
 const manager=await import("../src/local/executions.js").catch(()=>({ExecutionManager:undefined}));
 const demo=await import("../src/local/demo.js").catch(()=>({createLocalDemo:undefined}));
 assert.equal(typeof manager.ExecutionManager,"function","local execution manager missing");
 assert.equal(typeof demo.createLocalDemo,"function","isolated demo creation missing");
 return {Manager:manager.ExecutionManager!,createDemo:demo.createLocalDemo!};
}
async function fixture(){const root=await mkdtemp(join(tmpdir(),"salem runs ")),store=new LocalStore(join(root,"data"));const s=await store.readState();await store.saveSettings({...s.settings,commands:{...s.settings.commands,codex:[process.execPath,resolve("tests/fixtures/benchmark-agent.mjs")]}});return {root,store};}
async function until<T>(fn:()=>Promise<T|undefined>):Promise<T>{const deadline=Date.now()+180000;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw Error("Execution did not reach the expected durable state");}
test("a detected local-only profile completes with checked code and a diff without requiring commit authority",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};await f.store.saveProject({...project,config});const m=new Manager(f.store);await m.initialize();
 try{const e=await m.start(task.id,"local-only");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});assert.equal(done.status,"completed",done.reason??"");const detail=await m.detail(e.id);assert.equal(detail.metrics?.accepted,true);assert.equal(detail.run?.acceptance?.accepted,true);assert.equal(await git(done.workspace!,"rev-parse","HEAD"),done.sourceSha);assert.match(detail.diff,/return a\+b/);assert.match(detail.run?.delivery?.summary??"",/local|commit|diff/i);
 }finally{await m.shutdown();}
});
test("duplicate starts reserve once, freeze configuration and cancel a queued execution",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),m=new Manager(f.store,{autoStart:false});await m.initialize();
 const [a,b]=await Promise.all([m.start(task.id,"same-request"),m.start(task.id,"same-request")]);assert.equal(a.id,b.id);assert.equal((await f.store.readState()).executions.length,1);
 await f.store.saveProject({...project,name:"Changed",config:{...project.config,instructions:"Later settings"}});
 assert.equal((await f.store.findExecution(a.id)).project.name,project.name);
 assert.equal((await f.store.findExecution(a.id)).project.config.instructions,project.config.instructions);
 const cancelled=await m.cancel(a.id);assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.runId,null);await m.shutdown();
});
test("real fixture pipeline accepts code in an independent Git copy and can continue from its delivery",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),m=new Manager(f.store);await m.initialize();
 const beforeHead=await git(project.config.repoRoot,"rev-parse","HEAD"),before=await readFile(join(project.config.repoRoot,"sum.mjs"),"utf8");
 try{const e=await m.start(task.id,"first");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});
 assert.equal(done.status,"completed",done.reason??"");assert.notEqual(done.workspace,project.config.repoRoot);
 const detail=await m.detail(done.id);assert.equal(detail.metrics?.accepted,true);assert.equal(detail.run?.acceptance?.accepted,true);assert.match(detail.diff,/return a\+b/);
 assert.equal(await git(project.config.repoRoot,"rev-parse","HEAD"),beforeHead);assert.equal(await git(project.config.repoRoot,"status","--porcelain"),"");assert.equal(await readFile(join(project.config.repoRoot,"sum.mjs"),"utf8"),before);
 const next=await m.start(task.id,"continue",done.id);const second=await until(async()=>{const r=await f.store.findExecution(next.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});
 assert.equal(second.status,"completed",second.reason??"");assert.equal(second.sourceSha,detail.run!.deliveryJournal!.commitSha);
 }finally{await m.shutdown();}
});
test("failed preparation preserves output and never starts a core run",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store);
 await f.store.saveProject({...project,preparation:[[process.execPath,"-e","console.error('setup failed');process.exit(7)"]]});const m=new Manager(f.store);await m.initialize();
 try{const e=await m.start(task.id,"setup");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return r.status==="failed"?r:undefined;});assert.equal(done.runId,null);assert.match(done.reason??"",/prepara/i);const d=await m.detail(done.id);assert.ok(d.artifacts.length);const log=await m.artifact(done.id,done.preparationLogs[0]!,0);assert.match(log.text,/setup failed/);}finally{await m.shutdown();}
});
test("restart preserves an interrupted run and never creates a fallback; artifacts cannot escape",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{task}=await createDemo(f.store),m=new Manager(f.store,{autoStart:false});await m.initialize();const e=await m.start(task.id,"interrupted");await m.shutdown();await f.store.patchExecution(e.id,{status:"running"});
 const reopened=new Manager(f.store,{autoStart:false});await reopened.initialize();assert.equal((await f.store.findExecution(e.id)).status,"interrupted");
 const result=await reopened.resume(e.id);assert.equal(result.status,"blocked");assert.equal((await f.store.readState()).executions.length,1);
 const outside=join(f.root,"outside");await mkdir(outside);await writeFile(join(outside,"private.txt"),"private");const dir=join(f.store.root,"executions",e.id);await mkdir(dir,{recursive:true});await symlink(outside,join(dir,"linked"),process.platform==="win32"?"junction":"dir");
 await assert.rejects(reopened.artifact(e.id,"../../outside/private.txt",0),/ruta|artefact|permit|fuera/i);await assert.rejects(reopened.artifact(e.id,"linked/private.txt",0),/ruta|artefact|permit|fuera/i);await reopened.shutdown();
});
