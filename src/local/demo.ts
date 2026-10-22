import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defaultAgent } from "./contracts.js";
import type { LocalStore } from "./store.js";
import { localGit } from "./git.js";

export async function createLocalDemo(store:LocalStore){
 const id=randomUUID(),root=join(store.root,"demos",id),settings=(await store.readState()).settings;
 await mkdir(root,{recursive:true});
 await writeFile(join(root,"AGENTS.md"),"# Demo Salem\nSolo modifica sum.mjs para cumplir la tarea. No cambies el verificador ni estas instrucciones. No ejecutes acciones Git o remotas.\nCONTEXTO-SALEM-DEMO\n");
 await writeFile(join(root,".gitattributes"),"* text eol=lf\n");
 await writeFile(join(root,"sum.mjs"),"export function sum(a,b){return a-b;}\n");
 await writeFile(join(root,".salem-check.mjs"),"import assert from 'node:assert/strict';import {sum} from './sum.mjs';assert.equal(sum(2,3),5);assert.equal(sum(-2,3),1);assert.equal(sum(0,0),0);console.log('Suma verificada');\n");
 await localGit(root,["init","--template=","-b","demo"],store.root);
 await localGit(root,["add","--all"],store.root);
 await localGit(root,["-c","user.name=Salem Demo","-c","user.email=demo@example.invalid","commit","-m","Demo inicial"],store.root);
 const project=await store.saveProject({name:"Demo Salem",baseRef:"HEAD",preparation:[],config:{schemaVersion:1,projectId:`demo-${id.slice(0,8)}`,repoRoot:root,contextFiles:["AGENTS.md"],
  agents:{codex:defaultAgent("codex",settings),claude:defaultAgent("claude",settings)},checks:[{id:"sum",command:[process.execPath,".salem-check.mjs"],required:true}],
  capabilities:{edit:true,commit:true,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:180000,maxOutputBytes:2_000_000},
  supervisor:{roles:{define:"codex",build:"codex",review:"codex"},runTimeoutMs:600000,maxAttempts:6,maxReportedTokens:500000},
  delivery:{branchPrefix:"feature/salem-",recovery:"query_only",commit:{message:"fix: suma del demo",author:{name:"Salem Demo",email:"demo@example.invalid"}}}}});
 const criterion="sum(a,b) devuelve la suma de ambos argumentos";
 const task=await store.saveTask({projectId:project.id,spec:{id:"BUG-SUM",objective:"Corrige sum.mjs para que sum(a,b) devuelva la suma de ambos argumentos. Conserva el verificador y las instrucciones.",scope:["sum.mjs"],acceptance:[criterion],references:["AGENTS.md"],acceptanceChecks:{[criterion]:["sum"]}}});
 return {project,task};
}
