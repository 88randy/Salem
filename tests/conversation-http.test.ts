import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {startLocalServer} from '../src/local/server.js';
import type {ConversationRecord} from '../src/local/conversation-contracts.js';
test('conversation HTTP protects commands and an informational question never starts implementation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem chat http ')),store=new LocalStore(join(root,'data')),{project}=await createLocalDemo(store),staticDir=join(root,'web');await mkdir(staticDir);await writeFile(join(staticDir,'index.html'),'Salem');
 const config=structuredClone(project.config);config.agents.codex!.command=[process.execPath,resolve('tests/fixtures/conversation-agent.mjs'),'codex'];await store.saveProject({...project,config});
 const server=await startLocalServer({port:0,dataDir:store.root,staticDir,store});
 try{
  const response=await fetch(server.url+'/api/bootstrap'),bootstrap=await response.json() as any,cookie=response.headers.get('set-cookie')!.split(';')[0]!,headers={Cookie:cookie,Origin:server.url,'Content-Type':'application/json','X-Salem-CSRF':bootstrap.csrfToken};
  const post=(path:string,input:unknown,h=headers)=>fetch(server.url+'/api/'+path,{method:'POST',headers:h,body:JSON.stringify(input)});
  assert.equal((await post('conversations',{projectId:project.id,text:'Solo explica cómo funciona la suma',requestKey:'http'},{...headers,'X-Salem-CSRF':'bad'})).status,403);
  assert.equal((await fetch(server.url+'/api/conversations',{headers:{Cookie:cookie}})).status,405);
  const input={projectId:project.id,text:'Solo explica cómo funciona la suma',requestKey:'http'},started=await post('conversations',input);assert.equal(started.status,200,await started.clone().text());const c=await started.json() as ConversationRecord;
  assert.equal((await (await post('conversations',input)).json() as ConversationRecord).id,c.id);
  assert.equal((await post(`conversations/${c.id}/message`,{revision:0,requestKey:'stale',text:'Otra cosa'})).status,409);
  assert.equal((await fetch(server.url+`/api/conversations/${c.id}/pause`,{headers:{Cookie:cookie}})).status,405);
  const deadline=Date.now()+120000;let done=c;while(Date.now()<deadline){done=await store.findConversation(c.id);if(['answered','blocked'].includes(done.status))break;await new Promise(r=>setTimeout(r,80));}
  assert.equal(done.status,'answered',done.reason??'');assert.match(done.messages.at(-1)!.text,/sum.mjs/);assert.equal((await store.readState()).executions.length,0);assert.equal(done.steps.length,0);
 }finally{await server.close();}
});
