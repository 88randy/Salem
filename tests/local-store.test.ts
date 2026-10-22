import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectInput, TaskInput } from "../src/local/contracts.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "salem catalog "));
  const repo = join(root, "repo"); await mkdir(repo);
  await writeFile(join(repo,"AGENTS.md"),"Scope: demo only");
  const project: ProjectInput = { name:"Proyecto local",baseRef:"HEAD",preparation:[],config:{
    schemaVersion:1,projectId:"local",repoRoot:repo,contextFiles:["AGENTS.md"],
    agents:{codex:{provider:"codex",command:[process.execPath]}},checks:[],
    capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},
    budgets:{stageTimeoutMs:10000,maxOutputBytes:20000},
    supervisor:{roles:{define:"codex",build:"codex",review:"codex"},runTimeoutMs:60000,maxAttempts:6}
  }};
  return { root, project };
}
async function constructor() {
  const module = await import("../src/local/store.js").catch(()=>({LocalStore:undefined}));
  assert.equal(typeof module.LocalStore,"function","persistent local catalog is missing");
  return module.LocalStore!;
}
test("catalog persists projects tasks and settings across reopening without touching the project",async()=>{
  const C = await constructor(), f=await fixture(), store=new C(join(f.root,"data"));
  const p=await store.saveProject(f.project);
  const task:TaskInput={projectId:p.id,spec:{id:"T-1",objective:"Build",scope:["one"],acceptance:["passes"],references:[]}};
  const t=await store.saveTask(task);
  const current=await store.readState();
  await store.saveSettings({...current.settings,maxConcurrentRuns:2});
  const reopened=await new C(join(f.root,"data")).readState();
  assert.equal(reopened.projects[0]!.name,"Proyecto local");assert.equal(reopened.tasks[0]!.id,t.id);
  assert.equal(reopened.settings.maxConcurrentRuns,2);assert.equal(await readFile(join(f.project.config.repoRoot,"AGENTS.md"),"utf8"),"Scope: demo only");
});
test("stale project edits and duplicate task ids fail instead of losing newer changes",async()=>{
  const C=await constructor(),f=await fixture(),store=new C(join(f.root,"data")),p=await store.saveProject(f.project);
  await store.saveProject({...p,name:"Newest"});
  await assert.rejects(store.saveProject({...p,name:"Stale"}), /409|revisi|version/i);
  const input={projectId:p.id,spec:{id:"T-1",objective:"Build",scope:["one"],acceptance:["passes"],references:[]}};
  await store.saveTask(input);await assert.rejects(store.saveTask(input),/duplic|existe/i);
  assert.equal((await store.readState()).projects[0]!.name,"Newest");
});
test("corrupt catalog is not silently replaced and unsupported settings are rejected",async()=>{
  const C=await constructor(),f=await fixture(),dir=join(f.root,"data"),store=new C(dir);
  const s=await store.readState();await assert.rejects(store.saveSettings({...s.settings,maxConcurrentRuns:99}),/concurr|limit|inválid/i);
  await writeFile(join(dir,"catalog.json"),"broken");
  await assert.rejects(new C(dir).readState(),/catálogo|catalog|corrupt|JSON/i);
  assert.equal(await readFile(join(dir,"catalog.json"),"utf8"),"broken");
});

test("next-launch data folder is durable and must be an absolute path",async()=>{
  const C=await constructor(),f=await fixture(),store=new C(join(f.root,"data"));
  const current=await store.readState();
  const nextDataDir=join(f.root,"otro catálogo");
  const saved=await store.saveSettings({...current.settings,nextDataDir} as typeof current.settings);
  assert.equal((saved as typeof saved & {nextDataDir:string}).nextDataDir,nextDataDir);
  await assert.rejects(store.saveSettings({...saved,nextDataDir:"relative-folder"} as typeof saved),/absolut/i);
  assert.equal((await new C(store.root).readState()).settings.revision,saved.revision);
});
