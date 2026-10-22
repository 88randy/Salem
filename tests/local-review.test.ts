import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,readFile,rename,symlink} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {LocalStore} from "../src/local/store.js";
import {ExecutionManager} from "../src/local/executions.js";
import {createLocalDemo} from "../src/local/demo.js";
import type {ExecutionRecord} from "../src/local/contracts.js";
import {StateStore} from "../src/state-store.js";
import {isInside} from "../src/config.js";
import {git} from "./supervisor-fixture.js";
import {measuredRun} from "./metrics-fixture.js";

async function fixture(){const root=await mkdtemp(join(tmpdir(),"salem review ")),store=new LocalStore(join(root,"data"));const demo=await createLocalDemo(store);return {root,store,...demo};}
type Internals={pump():Promise<void>;execute(e:ExecutionRecord,controller:AbortController):Promise<void>;ownedWorkspace(path:string,id:string):Promise<string>};

test("a cancelled queued job never launches from an earlier polling snapshot",async()=>{
 const f=await fixture(),m=new ExecutionManager(f.store,{autoStart:false}),internals=m as unknown as Internals;
 await m.initialize();const e=await m.start(f.task.id,"cancel-race");let launched=false;
 internals.execute=async()=>{launched=true;};
 let captured!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>captured=r),gate=new Promise<void>(r=>release=r);
 const original=f.store.readState.bind(f.store);let hold=true;
 f.store.readState=async()=>{const state=await original();if(hold){hold=false;captured();await gate;}return state;};
 const pumping=internals.pump();await ready;
 try {assert.equal((await m.cancel(e.id)).status,"cancelled");}
 finally {release();await pumping;await m.shutdown();}
 assert.equal(launched,false,"a previously cancelled job started executing");
});

test("execution roots and workspace ancestors cannot be replaced by external junctions",async()=>{
 const f=await fixture(),m=new ExecutionManager(f.store,{autoStart:false});await m.initialize();const e=await m.start(f.task.id,"junction-root");
 const outside=join(f.root,"outside");await mkdir(outside);await (await import("node:fs/promises")).writeFile(join(outside,"private.txt"),"outside evidence");
 await mkdir(join(f.store.root,"executions"));await symlink(outside,join(f.store.root,"executions",e.id),process.platform==="win32"?"junction":"dir");
 await assert.rejects(m.artifact(e.id,"private.txt"),/ruta|espacio|enlace|permit|propiedad/i);
 await assert.rejects(m.detail(e.id),/ruta|espacio|enlace|permit|propiedad/i);
 await symlink(outside,join(f.store.root,"workspaces"),process.platform==="win32"?"junction":"dir");await mkdir(join(outside,e.id));
 await assert.rejects((m as unknown as Internals).ownedWorkspace(join(f.store.root,"workspaces",e.id),e.id),/ruta|espacio|enlace|permit|propiedad/i);
 await m.shutdown();
});

test("a local clone materializes borrowed Git objects so donor removal cannot break evidence",async()=>{
 const f=await fixture(),shared=join(f.root,"shared");await git(f.root,"clone","--shared",f.project.config.repoRoot,shared);
 await f.store.saveProject({...f.project,config:{...f.project.config,repoRoot:shared},preparation:[[process.execPath,"-e","process.exit(7)"]]});
 const m=new ExecutionManager(f.store);await m.initialize();
 try {
  const e=await m.start(f.task.id,"borrowed-objects");let done=e;const deadline=Date.now()+30000;
  while(!["completed","failed","blocked"].includes(done.status)){assert.ok(Date.now()<deadline,"preparation did not finish");await new Promise(r=>setTimeout(r,30));done=await f.store.findExecution(e.id);}
  assert.ok(done.workspace);assert.equal(done.runId,null);
  await assert.rejects(readFile(join(done.workspace!,".git","objects","info","alternates")),/ENOENT/);
  const moved=join(f.root,"donor-moved");assert.ok(isInside(f.root,resolve(f.project.config.repoRoot))&&isInside(f.root,resolve(moved)));
  await rename(f.project.config.repoRoot,moved);
  assert.equal(await git(done.workspace!,"rev-parse","--verify",`${done.sourceSha}^{commit}`),done.sourceSha);
  assert.match(await git(done.workspace!,"show",`${done.sourceSha}:sum.mjs`),/return a-b/);
 } finally {await m.shutdown();}
});

test("local metrics include measured setup and keep total unknown until the execution is terminal",async()=>{
 const f=await fixture(),m=new ExecutionManager(f.store,{autoStart:false});await m.initialize();const e=await m.start(f.task.id,"local-timing"),workspace=join(f.store.root,"workspaces",e.id);
 await mkdir(workspace,{recursive:true});
 const run=measuredRun();run.projectId=e.project.config.projectId;run.task=e.task;run.expected.root=workspace;delete run.telemetry!.benchmark;
 await new StateStore(e.stateDir).write(run.id,run);
 await f.store.patchExecution(e.id,{runId:run.id,workspace,setupMs:1234,status:"running"});
 assert.equal((await m.detail(e.id)).metrics?.timing.totalMs,null);
 await f.store.patchExecution(e.id,{status:"completed",finishedAt:Date.now()});
 const timing=(await m.detail(e.id)).metrics!.timing;assert.equal(timing.setupMs,1234);assert.equal(timing.totalMs,11234);
 await m.shutdown();
});
