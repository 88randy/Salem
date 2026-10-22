import {test} from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {LocalStore} from '../src/local/store.js';import {startLocalServer} from '../src/local/server.js';import {createLocalDemo} from '../src/local/demo.js';
test('evolution HTTP protects mutations and preserves idempotent queued experiments and old catalogs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem evolution http ')),store=new LocalStore(join(root,'data')),{project,task}=await createLocalDemo(store),web=join(root,'web');await mkdir(web);await writeFile(join(web,'index.html'),'Salem');
 const config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};
 config.agents={worker:{provider:'codex',command:[process.execPath,resolve('tests/fixtures/evolution-agent.mjs'),'codex','repair']}};config.supervisor!.roles={define:'worker',build:'worker',review:'worker'};
 await store.saveProject({...project,config});
 const manager={initialize:async()=>{},start:async()=>{},cancel:async()=>{},resume:async()=>{},detail:async()=>{},artifact:async()=>{},isBusy:()=>false,activeCount:()=>4,shutdown:async()=>{}};
 const server=await startLocalServer({dataDir:store.root,staticDir:web,port:0,store,manager});try{const b=await fetch(server.url+'/api/bootstrap'),bootstrap=await b.json() as {csrfToken:string},cookie=b.headers.get('set-cookie')!.split(';')[0]!,headers={Cookie:cookie,Origin:server.url,'Content-Type':'application/json','X-Salem-CSRF':bootstrap.csrfToken};
 const post=(path:string,body:unknown,h=headers)=>fetch(server.url+'/api/'+path,{method:'POST',headers:h,body:JSON.stringify(body)});
 assert.equal((await post('evolution',{taskId:task.id,requestKey:'csrf'},{...headers,'X-Salem-CSRF':'bad'})).status,403);
 assert.equal((await fetch(server.url+'/api/evolution',{headers:{Cookie:cookie}})).status,405);
 const input={taskId:task.id,requestKey:'http'},a=await post('evolution',input);assert.equal(a.status,200,await a.clone().text());const e=await a.json() as {id:string};assert.equal((await (await post('evolution',input)).json() as {id:string}).id,e.id);
 assert.equal((await fetch(server.url+'/api/evolution/'+e.id+'/apply',{headers:{Cookie:cookie}})).status,405);
 assert.equal((await post('evolution/'+e.id+'/apply',{revision:1},{...headers,'X-Salem-CSRF':'bad'})).status,403);
 assert.equal((await post('evolution/'+e.id+'/apply',{revision:1})).status,409);
 assert.equal((await post('evolution/'+e.id+'/rollback',{revision:1,permissions:{edit:true}})).status,400);
 assert.equal((await post('evolution/'+e.id+'/rollback',{revision:0})).status,400);
 assert.equal((await post('evolution',{...input,applyOnSuccess:true})).status,409);
 assert.equal((await post('evolution',{...input,permissions:{commit:true}})).status,400);assert.equal((await fetch(server.url+'/api/evolution/incidents',{headers:{Cookie:cookie}})).status,200);
 const detail=await fetch(server.url+'/api/evolution/'+e.id,{headers:{Cookie:cookie}});assert.equal((await detail.json() as {status:string}).status,'queued');
 assert.equal((await fetch(server.url+'/api/evolution/'+e.id+'/artifact?path=../catalog.json',{headers:{Cookie:cookie}})).status,403);
 assert.equal((await post('evolution/'+e.id+'/cancel',{})).status,200);assert.equal((await new LocalStore(store.root).readState()).evolutions?.[0]?.status,'cancelled');
 }finally{await server.close();}
});
