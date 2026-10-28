import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultAgent, type AccountView, type LocalSettings, type Provider } from "./contracts.js";
import type { LocalStore } from "./store.js";
import { localGit } from "./git.js";
import { localError } from "./validation.js";
import { demoEstimate, type DemoEstimateReference, type DemoPlan, type DemoRoles, type DemoStage } from "./demo-estimate.js";

const stages:DemoStage[]=["define","build","review"];
const ready=(accounts:AccountView[],provider:Provider)=>accounts.some(a=>a.provider===provider&&a.installed&&a.compatible&&a.authenticated===true);
export const sameRoles=(a:DemoRoles,b:unknown)=>!!b&&typeof b==="object"&&!Array.isArray(b)&&Object.keys(b).length===stages.length&&stages.every(s=>(b as Record<string,unknown>)[s]===a[s]);

export function planLocalDemo(accounts:AccountView[],settings:LocalSettings,selected:Provider="codex",reference:DemoEstimateReference=demoEstimate):DemoPlan{
 const other:Provider=selected==="codex"?"claude":"codex",mine=ready(accounts,selected),theirs=ready(accounts,other);
 if(!mine&&!theirs)throw localError("Ningún proveedor está listo para la demo. Conecta Claude o Codex en Cuentas y vuelve a intentarlo.",412);
 const build=mine?selected:other,roles:DemoRoles={define:build,build,review:mine&&theirs?other:build};
 const scenario=reference.scenarios.find(s=>sameRoles(roles,s.roles));
 const estimates=[...new Set(stages.map(s=>roles[s]))].map(provider=>{
  const agent=defaultAgent(provider,settings),measured=scenario?.providers[provider],model=agent.model??null,effort=agent.effort??null;
  return {provider,stages:stages.filter(s=>roles[s]===provider),model,effort,reference:measured&&scenario?{...measured,measuredAt:scenario.measuredAt,salemVersion:scenario.salemVersion}:null,matchesReference:!!measured&&measured.model===model&&measured.effort===effort};
 });
 return {roles,selected,fallback:!mine,crossProvider:roles.build!==roles.review,estimates};
}

export async function createLocalDemo(store:LocalStore,roles:DemoRoles={define:"codex",build:"codex",review:"codex"}){
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
  supervisor:{roles:{...roles},runTimeoutMs:600000,maxAttempts:6,maxReportedTokens:500000},
  delivery:{branchPrefix:"feature/salem-",recovery:"query_only",commit:{message:"fix: suma del demo",author:{name:"Salem Demo",email:"demo@example.invalid"}}}}});
 const criterion="sum(a,b) devuelve la suma de ambos argumentos";
 const task=await store.saveTask({projectId:project.id,spec:{id:"BUG-SUM",objective:"Corrige sum.mjs para que sum(a,b) devuelva la suma de ambos argumentos. Conserva el verificador y las instrucciones.",scope:["sum.mjs"],acceptance:[criterion],references:["AGENTS.md"],acceptanceChecks:{[criterion]:["sum"]}}});
 return {project,task};
}

// Deliberately silent about the shipping policy, so the conversation has to ask for it.
export const cartGoal="Completa el carrito de cart.mjs: calcula el subtotal, el costo de envío y el total. Conserva la API y los verificadores existentes.";
// Resolved from the compiled module (dist/src/local), next to the packaged app's own fixtures folder.
const cartFixture=fileURLToPath(new URL("../../../fixtures/cart-quickstart/",import.meta.url));
const cartChecks=["api","subtotal","shipping","total"];

/** Copies the versioned cart fixture into a new repository. Every call creates an independent project; earlier copies are untouched. */
export async function createLocalCart(store:LocalStore,roles:DemoRoles={define:"codex",build:"codex",review:"codex"}){
 const id=randomUUID(),root=join(store.root,"demos",id),settings=(await store.readState()).settings;
 const files=(await readdir(cartFixture,{recursive:true,withFileTypes:true})).filter(e=>!e.isDirectory());
 if(files.some(e=>!e.isFile()))throw localError("El ejemplo del carrito contiene entradas no admitidas.");
 await mkdir(root,{recursive:true});
 for(const e of files){const path=relative(cartFixture,join(e.parentPath,e.name));await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),(await readFile(join(cartFixture,path),"utf8")).replaceAll("\r\n","\n"));}
 await localGit(root,["init","--template=","-b","demo"],store.root);
 await localGit(root,["add","--all"],store.root);
 await localGit(root,["-c","user.name=Salem Demo","-c","user.email=demo@example.invalid","commit","-m","Ejemplo inicial del carrito"],store.root);
 const taken=new Set((await store.readState()).projects.map(p=>p.name));let name="Ejemplo carrito";for(let n=2;taken.has(name);n++)name=`Ejemplo carrito ${n}`;
 const project=await store.saveProject({name,baseRef:"HEAD",preparation:[],config:{schemaVersion:1,projectId:`cart-${id.slice(0,8)}`,repoRoot:root,contextFiles:["AGENTS.md"],
  agents:{codex:defaultAgent("codex",settings),claude:defaultAgent("claude",settings)},
  // Only the API check is required: intermediate steps cannot pass the checks of later steps yet.
  checks:cartChecks.map(c=>({id:c,command:[process.execPath,`checks/${c}.mjs`],required:c==="api"})),
  capabilities:{edit:true,commit:true,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:180000,maxOutputBytes:2_000_000},
  supervisor:{roles:{...roles},runTimeoutMs:600000,maxAttempts:6,maxReportedTokens:500000},
  delivery:{branchPrefix:"feature/salem-",recovery:"query_only",commit:{message:"feat: carrito del ejemplo",author:{name:"Salem Demo",email:"demo@example.invalid"}}}}});
 return {project,goal:cartGoal};
}
