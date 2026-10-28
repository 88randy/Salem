import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {cartGoal,createLocalDemo,planLocalDemo} from '../src/local/demo.js';
import {cartEstimate,demoEstimate,type DemoEstimateReference} from '../src/local/demo-estimate.js';
import {defaultSettings,type AccountView,type Provider} from '../src/local/contracts.js';
import {startLocalServer} from '../src/local/server.js';

const account=(provider:Provider,ready:boolean,extra:Partial<AccountView>={}):AccountView=>({provider,installed:true,compatible:true,authenticated:ready,version:'fixture',error:null,connection:ready?'connected':'idle',loginUrl:null,userCode:null,needsInput:false,...extra});
const settings=defaultSettings();
const measured:DemoEstimateReference={version:1,scenarios:[
 {roles:{define:'codex',build:'codex',review:'claude'},measuredAt:'2026-11-01',salemVersion:'0.5.1',providers:{codex:{model:'gpt-6.1-sol',effort:'medium',runs:2,tokens:{min:11000,max:17000},wallMs:{min:61000,max:93000}},claude:{model:'claude-opus-5-5',effort:'medium',runs:2,tokens:{min:5000,max:8000},wallMs:{min:20000,max:31000}}}},
 {roles:{define:'claude',build:'claude',review:'claude'},measuredAt:'2026-11-02',salemVersion:'0.5.1',providers:{claude:{model:'claude-opus-5-5',effort:'high',runs:3,tokens:{min:9000,max:14000},wallMs:{min:50000,max:70000}}}},
]};

test('demo plan uses Claude alone when only Claude is ready',()=>{
 const plan=planLocalDemo([account('claude',true),account('codex',false)],settings);
 assert.deepEqual(plan.roles,{define:'claude',build:'claude',review:'claude'});
 assert.equal(plan.crossProvider,false);assert.equal(plan.fallback,true);
 assert.deepEqual(plan.estimates.map(e=>[e.provider,e.stages]),[['claude',['define','build','review']]]);
});
test('demo plan uses Codex alone when only Codex is ready',()=>{
 const plan=planLocalDemo([account('claude',false),account('codex',true)],settings,'codex');
 assert.deepEqual(plan.roles,{define:'codex',build:'codex',review:'codex'});
 assert.equal(plan.crossProvider,false);assert.equal(plan.fallback,false);
});
test('demo plan builds and reviews on different providers when both are ready',()=>{
 const accounts=[account('claude',true),account('codex',true)];
 const codex=planLocalDemo(accounts,settings),claude=planLocalDemo(accounts,settings,'claude');
 assert.deepEqual(codex.roles,{define:'codex',build:'codex',review:'claude'});
 assert.deepEqual(claude.roles,{define:'claude',build:'claude',review:'codex'});
 assert.equal(codex.crossProvider,true);assert.notEqual(codex.roles.build,codex.roles.review);
 assert.deepEqual(codex.estimates.map(e=>[e.provider,e.stages]),[['codex',['define','build']],['claude',['review']]]);
});
test('demo plan rejects when no provider is ready and points to Accounts',()=>{
 for(const accounts of [[account('claude',false),account('codex',false)],[account('claude',true,{compatible:false}),account('codex',true,{installed:false})],[account('claude',false,{authenticated:null})],[]]){
  assert.throws(()=>planLocalDemo(accounts,settings),(error:Error&{status?:number})=>error.status===412&&/Cuentas/.test(error.message));
 }
});
test('demo estimates come only from the reference file',()=>{
 const accounts=[account('claude',true),account('codex',true)];
 const plan=planLocalDemo(accounts,settings,'codex',measured),scenario=measured.scenarios[0]!;
 for(const estimate of plan.estimates){
  const reference=scenario.providers[estimate.provider]!;
  assert.deepEqual(estimate.reference,{...reference,measuredAt:scenario.measuredAt,salemVersion:scenario.salemVersion});
 }
 // The configured Codex demo agent uses the CLI default model, so it cannot be claimed to match a measured model.
 assert.equal(plan.estimates.find(e=>e.provider==='codex')!.matchesReference,false);
 assert.equal(plan.estimates.find(e=>e.provider==='claude')!.matchesReference,true);
 const mismatch=planLocalDemo([account('claude',true),account('codex',false)],settings,'claude',measured);
 assert.equal(mismatch.estimates[0]!.reference!.effort,'high');assert.equal(mismatch.estimates[0]!.matchesReference,false);
 const unknown=planLocalDemo(accounts,settings,'claude',measured);
 assert.deepEqual(unknown.estimates.map(e=>[e.reference,e.matchesReference]),[[null,false],[null,false]]);
});
test('shipped demo reference holds only well-formed measurements',()=>{
 for(const reference of [demoEstimate,cartEstimate])assert.equal(reference.version,1);
 for(const s of [...demoEstimate.scenarios,...cartEstimate.scenarios]){
  assert.match(s.measuredAt,/^\d{4}-\d{2}-\d{2}$/);assert.match(s.salemVersion,/^\d+\.\d+\.\d+$/);
  for(const p of Object.values(s.providers)){
   assert.ok(p&&p.model&&Number.isSafeInteger(p.runs)&&p.runs>0);
   for(const r of [p.tokens,p.wallMs])assert.ok(Number.isSafeInteger(r.min)&&r.min>0&&r.max>=r.min);
  }
 }
 const plan=planLocalDemo([account('claude',true),account('codex',true)],settings);
 for(const e of plan.estimates)if(!demoEstimate.scenarios.length)assert.equal(e.reference,null);
});
test('createLocalDemo stores the planned roles',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem demo roles '));
 try{
  const store=new LocalStore(root),{project}=await createLocalDemo(store,{define:'claude',build:'claude',review:'codex'});
  assert.deepEqual(project.config.supervisor!.roles,{define:'claude',build:'claude',review:'codex'});
  assert.deepEqual(Object.keys(project.config.agents).sort(),['claude','codex']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('demo HTTP plans from probed accounts and creates only after the plan is confirmed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem demo http ')),store=new LocalStore(join(root,'data')),staticDir=join(root,'web');await mkdir(staticDir);await writeFile(join(staticDir,'index.html'),'Salem');
 const fixture=resolve('tests/fixtures/local-auth.mjs'),files={claude:join(root,'claude.json'),codex:join(root,'codex.json')};
 const auth=async(claude:boolean,codex:boolean)=>{await writeFile(files.claude,JSON.stringify({authenticated:claude}));await writeFile(files.codex,JSON.stringify({authenticated:codex}));};
 await auth(true,true);
 const current=(await store.readState()).settings;
 await store.saveSettings({...current,commands:{claude:[process.execPath,fixture,'--state',files.claude,'--provider','claude'],codex:[process.execPath,fixture,'--state',files.codex,'--provider','codex']}});
 const server=await startLocalServer({port:0,dataDir:store.root,staticDir,store});
 try{
  const response=await fetch(server.url+'/api/bootstrap'),bootstrap=await response.json() as any,cookie=response.headers.get('set-cookie')!.split(';')[0]!,headers={Cookie:cookie,Origin:server.url,'Content-Type':'application/json','X-Salem-CSRF':bootstrap.csrfToken};
  const post=(path:string,input:unknown)=>fetch(server.url+'/api/'+path,{method:'POST',headers,body:JSON.stringify(input)});
  assert.equal((await fetch(server.url+'/api/projects/demo/plan',{headers:{Cookie:cookie}})).status,405);
  const planned=await post('projects/demo/plan',{provider:'claude'});assert.equal(planned.status,200,await planned.clone().text());
  const plan=await planned.json() as any;assert.deepEqual(plan.roles,{define:'claude',build:'claude',review:'codex'});
  assert.equal(plan.crossProvider,true);assert.equal((await store.readState()).projects.length,0);
  assert.equal((await post('projects/demo',{provider:'claude'})).status,400);
  assert.equal((await post('projects/demo',{provider:'claude',roles:{define:'codex',build:'codex',review:'claude'}})).status,412);
  assert.equal((await post('projects/demo',{provider:'claude',roles:plan.roles,extra:true})).status,400);
  assert.equal((await store.readState()).projects.length,0);
  const created=await post('projects/demo',{provider:'claude',roles:plan.roles});assert.equal(created.status,200,await created.clone().text());
  const {project}=await created.json() as any;assert.deepEqual(project.config.supervisor.roles,plan.roles);
  // The cart quickstart reuses the same confirmation: plan, then create with the confirmed roles.
  assert.equal((await post('projects/demo/plan',{kind:'otro'})).status,400);
  const cartPlan=await (await post('projects/demo/plan',{kind:'cart',provider:'codex'})).json() as any;assert.deepEqual(cartPlan.roles,{define:'codex',build:'codex',review:'claude'});
  assert.equal((await post('projects/demo',{kind:'cart',provider:'codex'})).status,400);assert.equal((await store.readState()).projects.length,1);
  const cart=await post('projects/demo',{kind:'cart',provider:'codex',roles:cartPlan.roles});assert.equal(cart.status,200,await cart.clone().text());
  const cartResult=await cart.json() as any;assert.equal(cartResult.goal,cartGoal);assert.equal(cartResult.task,undefined);
  assert.deepEqual(cartResult.project.config.supervisor.roles,cartPlan.roles);assert.equal(cartResult.project.name,'Ejemplo carrito');
  assert.equal((await store.readState()).projects.length,2);
  await auth(false,false);
  const none=await post('projects/demo/plan',{});assert.equal(none.status,412);assert.match((await none.json() as any).error,/Cuentas/);
  assert.equal((await post('projects/demo',{roles:{define:'codex',build:'codex',review:'codex'}})).status,412);
  assert.equal((await post('projects/demo',{kind:'cart',roles:{define:'codex',build:'codex',review:'codex'}})).status,412);
  assert.equal((await store.readState()).projects.length,2);
 }finally{await server.close();await rm(root,{recursive:true,force:true});}
});
