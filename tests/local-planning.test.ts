import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GoalPlan } from "../src/local/research-contracts.js";
import { LocalStore } from "../src/local/store.js";
import { createLocalDemo } from "../src/local/demo.js";

export const examplePlan = (): GoalPlan => ({schemaVersion:1,verdict:"ready",summary:"Corregir suma tras revisar el código.",facts:[{description:"sum resta los operandos",files:["sum.mjs"]}],assumptions:[],decisions:["Conservar la API"],questions:[],steps:[{title:"Corregir suma",description:"Cambiar la operación y verificar el comportamiento.",files:["sum.mjs"]}],task:{objective:"Corregir la suma",scope:["sum.mjs"],acceptance:["Suma ambos argumentos"],references:["AGENTS.md","sum.mjs"],checkIds:["sum"]},proposedChecks:[]});

test('research surfaces Codex model refusal without changing the profile or hiding raw evidence',async()=>{
 const {runPlanning}=await import('../src/local/planning.js'),root=await mkdtemp(join(tmpdir(),'salem model refusal ')),store=new LocalStore(join(root,'data')),{project}=await createLocalDemo(store);
 project.config.agents.codex={provider:'codex',command:[process.execPath,resolve('tests/fixtures/planning-agent.mjs'),'codex','unsupported-model'],model:'gpt-6.1-sol'};
 const frozen=JSON.stringify(project),artifactDir=join(root,'evidence');await mkdir(artifactDir);
 const result=await runPlanning({goalId:'goal',attemptId:'attempt',sourceSha:'a'.repeat(40),project,agentId:'codex',objective:'Suma',answers:[],snapshot:{root:project.config.repoRoot,sourceSha:'a'.repeat(40),files:['AGENTS.md','sum.mjs'],truncated:false},artifactDir,leaseDir:join(root,'leases')},new AbortController().signal);
 assert.equal(result.status,'failed');assert.equal(result.plan,null);assert.match(result.error??'',/model is not supported/);assert.match(result.error??'',/Predeterminado del CLI/);
 assert.equal(JSON.stringify(project),frozen,'a refusal must never silently change a chosen model');
 assert.match(await readFile(join(artifactDir,'stdout.log'),'utf8'),/invalid_request_error/);
 const command=JSON.parse(await readFile(join(artifactDir,'fixture-command.json'),'utf8'));assert.equal(command[command.indexOf('--model')+1],'gpt-6.1-sol');
});
test("planner schema requires evidence and executable acceptance without accepting unknown permissions",async()=>{
 const {parseGoalPlan}=await import("../src/local/planning.js");
 const plan=examplePlan();assert.deepEqual(parseGoalPlan(plan,["sum.mjs","AGENTS.md"],["sum"]),plan);
 assert.throws(()=>parseGoalPlan({...plan,capabilities:{deploy:true}},["sum.mjs","AGENTS.md"],["sum"]),/campos|desconoc|plan/i);
 assert.throws(()=>parseGoalPlan({...plan,facts:[{description:"Inventado",files:["other.ts"]}]},["sum.mjs","AGENTS.md"],["sum"]),/archivo|evidencia/i);
 assert.throws(()=>parseGoalPlan({...plan,task:{...plan.task,scope:["../outside"]}},["sum.mjs","AGENTS.md"],["sum"]),/ruta|alcance/i);
 assert.throws(()=>parseGoalPlan({...plan,task:{...plan.task,checkIds:["missing"]}},["sum.mjs","AGENTS.md"],["sum"]),/check/i);
 assert.throws(()=>parseGoalPlan({...plan,task:{...plan.task,acceptance:[]}},["sum.mjs","AGENTS.md"],["sum"]),/aceptaci|criter/i);
 assert.throws(()=>parseGoalPlan({...plan,verdict:"needs_input",questions:[]},["sum.mjs","AGENTS.md"],["sum"]),/pregunt/i);
});
test("native planning adapters produce validated plans and restrict tools for both providers",async()=>{
 const {runPlanning}=await import("../src/local/planning.js"),root=await mkdtemp(join(tmpdir(),"salem planner ")),store=new LocalStore(join(root,"data")),{project}=await createLocalDemo(store);
 for(const provider of ["claude","codex"] as const){
  project.config.agents[provider]={provider,command:[process.execPath,resolve("tests/fixtures/planning-agent.mjs"),provider,"ready"]};
  const artifactDir=join(root,provider);await mkdir(artifactDir);
  const result=await runPlanning({goalId:"goal",attemptId:"attempt",sourceSha:"a".repeat(40),project,agentId:provider,objective:"Corrige sum",answers:[],snapshot:{root:project.config.repoRoot,sourceSha:"a".repeat(40),files:["AGENTS.md","sum.mjs",".salem-check.mjs"],truncated:false},artifactDir,leaseDir:join(root,`leases-${provider}`)},new AbortController().signal);
  assert.equal(result.status,"succeeded",result.error??"");assert.equal(result.plan?.verdict,"ready");assert.equal(result.usage?.inputTokens,10);
  const captured=JSON.parse(await readFile(join(artifactDir,"fixture-command.json"),"utf8")) as string[];
  if(provider==="claude"){assert.equal(captured[captured.indexOf("--tools")+1],"Read,Glob,Grep");assert.match(captured[captured.indexOf("--settings")+1]!,/disableAllHooks/);}
  else assert.equal(captured[captured.indexOf("--sandbox")+1],"read-only");
 }
});
test("exit zero without a valid plan fails while preserving reported usage",async()=>{
 const {runPlanning}=await import("../src/local/planning.js"),root=await mkdtemp(join(tmpdir(),"salem bad plan ")),store=new LocalStore(join(root,"data")),{project}=await createLocalDemo(store);
 project.config.agents.claude={provider:"claude",command:[process.execPath,resolve("tests/fixtures/planning-agent.mjs"),"claude","invalid"]};const artifactDir=join(root,"evidence");await mkdir(artifactDir);
 const result=await runPlanning({goalId:"goal",attemptId:"attempt",sourceSha:"a".repeat(40),project,agentId:"claude",objective:"Suma",answers:[],snapshot:{root:project.config.repoRoot,sourceSha:"a".repeat(40),files:["AGENTS.md","sum.mjs"],truncated:false},artifactDir,leaseDir:join(root,"leases")},new AbortController().signal);
 assert.equal(result.status,"failed");assert.equal(result.plan,null);assert.equal(result.usage?.inputTokens,10);assert.ok(result.error);
});
test("evidence outside the prompt sample remains valid when present in the full committed inventory",async()=>{
 const {runPlanning}=await import("../src/local/planning.js"),root=await mkdtemp(join(tmpdir(),"salem full evidence ")),store=new LocalStore(join(root,"data")),{project}=await createLocalDemo(store);project.config.agents.claude={provider:"claude",command:[process.execPath,resolve("tests/fixtures/planning-agent.mjs"),"claude","ready"]};const artifactDir=join(root,"evidence");await mkdir(artifactDir);
 const result=await runPlanning({goalId:"goal",attemptId:"attempt",sourceSha:"a".repeat(40),project,agentId:"claude",objective:"Suma",answers:[],snapshot:{root:project.config.repoRoot,sourceSha:"a".repeat(40),files:["AGENTS.md"],evidenceFiles:["AGENTS.md","sum.mjs",".salem-check.mjs"],truncated:true},artifactDir,leaseDir:join(root,"leases")},new AbortController().signal);assert.equal(result.status,"succeeded",result.error??"");
});
