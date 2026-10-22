import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {startLocalServer} from "../src/local/server.js";
import {LocalStore} from "../src/local/store.js";
import {createLocalDemo} from "../src/local/demo.js";
import type {Bootstrap} from "../src/local/contracts.js";
import type {DiscoveryReport,GoalRecord} from "../src/local/research-contracts.js";

test("protected research HTTP discovers a project and creates one durable goal from a short objective",async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem research http ")),store=new LocalStore(join(root,"data")),{project}=await createLocalDemo(store),staticDir=join(root,"web");await mkdir(staticDir);await writeFile(join(staticDir,"index.html"),"Salem");
 const p=await store.saveProject({...project,config:{...project.config,agents:{...project.config.agents,claude:{provider:"claude",command:[process.execPath,resolve("tests/fixtures/planning-agent.mjs"),"claude","ready"]}}}});
 const server=await startLocalServer({port:0,dataDir:store.root,staticDir,store});try{
  const response=await fetch(`${server.url}/api/bootstrap`),bootstrap=await response.json() as Bootstrap,cookie=response.headers.get("set-cookie")!.split(";")[0]!,headers={Cookie:cookie,Origin:server.url,"Content-Type":"application/json","X-Salem-CSRF":bootstrap.csrfToken};
  const post=(path:string,value:unknown,provided=headers)=>fetch(`${server.url}/api/${path}`,{method:"POST",headers:provided,body:JSON.stringify(value)});
  assert.equal((await post("goals",{projectId:p.id,objective:"Suma",requestKey:"no-csrf"},{...headers,"X-Salem-CSRF":"bad"})).status,403);
  assert.equal((await fetch(`${server.url}/api/projects/discover`,{headers:{Cookie:cookie}})).status,405);
  const discovery=await post("projects/discover",{repoRoot:p.config.repoRoot,provider:"claude"});assert.equal(discovery.status,200,await discovery.clone().text());const report=await discovery.json() as DiscoveryReport;assert.ok(report.suggested.config.checks.length);assert.ok(report.contextFiles.includes("AGENTS.md"));
  assert.equal((await post("goals",{projectId:p.id,objective:"",requestKey:"empty"})).status,400);
  const input={projectId:p.id,objective:"Corrige la suma",agentId:"claude",requestKey:"goal-http"},started=await post("goals",input);assert.equal(started.status,200,await started.clone().text());const goal=await started.json() as GoalRecord;const repeat=await post("goals",input);assert.equal((await repeat.json() as GoalRecord).id,goal.id);
  assert.equal((await fetch(`${server.url}/api/goals/${goal.id}/cancel`,{headers:{Cookie:cookie}})).status,405);
  assert.equal((await post(`goals/${goal.id}/retry`,{revision:"wrong"})).status,400);
  const end=Date.now()+30000;let ready:GoalRecord=goal;while(Date.now()<end){ready=await store.findGoal(goal.id);if(["ready","failed"].includes(ready.status))break;await new Promise(r=>setTimeout(r,50));}assert.equal(ready.status,"ready",ready.reason??"");
  const detail=await fetch(`${server.url}/api/goals/${goal.id}`,{headers:{Cookie:cookie}});assert.equal((await detail.json() as GoalRecord).sourceSha,report.sourceSha);
  const materialized=await post(`goals/${goal.id}/materialize`,{revision:ready.revision});assert.equal(materialized.status,200,await materialized.clone().text());assert.equal((await store.readState()).executions.length,0);
  assert.equal((await fetch(`${server.url}/api/goals/${goal.id}/artifact?path=../private.log`,{headers:{Cookie:cookie}})).status,403);
 }finally{await server.close();}
});
