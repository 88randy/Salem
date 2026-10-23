import {test,expect} from '@playwright/test';
const project={id:'p',revision:1,name:'Demo conversacional',archived:false,config:{agents:{codex:{provider:'codex',command:['codex']}},supervisor:{roles:{define:'codex',build:'codex',review:'codex'}},checks:[],capabilities:{edit:true}},baseRef:'HEAD'};
const settings={refreshIntervalMs:500,commands:{claude:['claude'],codex:['codex']}};
test('chat answers a question, preserves draft during updates and exposes real steps and evidence',async({page})=>{
 let chat:any=null;const sent:any[]=[];
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname,state={settings,projects:[project],tasks:[],executions:[],goals:[],evolutions:[],conversations:chat?[chat]:[]};
  if(path==='/api/bootstrap')return route.fulfill({json:{csrfToken:'csrf',state,accounts:[]}});
  if(path==='/api/state')return route.fulfill({json:{state,accounts:[]}});
  if(path==='/api/conversations'){
   const input=route.request().postDataJSON();sent.push(input);chat={id:'chat',revision:2,projectId:'p',project,objective:input.text,status:'needs_input',reason:null,messages:[{id:'u',key:'u',at:1,role:'user',text:input.text},{id:'q',key:'q',at:2,role:'salem',text:'¿Rechazamos texto o lo convertimos?',source:{kind:'goal',id:'goal'}}],steps:[],goalId:'goal',planRevision:0,lastAcceptedExecutionId:null,agentId:'codex',commands:[],handledCommands:[]};return route.fulfill({json:chat});
  }
  if(path==='/api/conversations/chat/message'){const input=route.request().postDataJSON();sent.push(input);chat={...chat,revision:3,status:'working',messages:[...chat.messages,{id:'a',key:'a',at:3,role:'user',text:input.text}],steps:[{key:'goal:one',taskId:'t',planTask:{title:'Validar entradas',agentId:'codex',dependsOn:[]},executionId:'e',status:'running'}]};return route.fulfill({json:chat});}
  return route.fulfill({status:404,json:{error:path}});
 });
 await page.goto('/');await page.getByLabel('Qué quieres lograr',{exact:true}).fill('Mejora la suma');await page.getByRole('button',{name:'Investigar objetivo',exact:true}).click();
 await expect(page.getByRole('log',{name:'Conversación con Salem'})).toContainText('¿Rechazamos texto o lo convertimos?');
 const composer=page.getByLabel('Mensaje para Salem',{exact:true});await composer.fill('Rechaza texto con TypeError');await page.waitForTimeout(1200);await expect(composer).toHaveValue('Rechaza texto con TypeError');
 await page.getByRole('button',{name:'Enviar mensaje',exact:true}).click();await expect(composer).toHaveValue('');
 await page.getByRole('button',{name:'Ver plan y resultados',exact:true}).click();await expect(page.getByRole('complementary',{name:'Plan y resultados'})).toContainText('Validar entradas');
 expect(sent[1].text).toBe('Rechaza texto con TypeError');await expect(page.getByRole('button',{name:'Detener trabajo',exact:true})).toBeVisible();
 await page.setViewportSize({width:390,height:844});await expect(composer).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('a late response from a closed chat cannot erase a new draft after reopening',async({page})=>{
 const chat:any={id:'chat',revision:1,projectId:'p',project,objective:'Preservar borradores',status:'needs_input',reason:null,messages:[],steps:[],goalId:'goal',planRevision:0,lastAcceptedExecutionId:null,agentId:'codex',commands:[],handledCommands:[]};
 let release:()=>void=()=>{},received=false;const response=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname,state={settings,projects:[project],tasks:[],executions:[],goals:[],evolutions:[],conversations:[chat]};
  if(path==='/api/bootstrap')return route.fulfill({json:{csrfToken:'csrf',state,accounts:[]}});if(path==='/api/state')return route.fulfill({json:{state,accounts:[]}});
  if(path==='/api/conversations/chat/message'){received=true;await response;return route.fulfill({json:chat});}return route.fulfill({status:404,json:{error:path}});
 });
 await page.goto('/#chat/chat');const input=page.getByLabel('Mensaje para Salem',{exact:true});await input.fill('Primer mensaje');await page.getByRole('button',{name:'Enviar mensaje',exact:true}).click();await expect.poll(()=>received).toBe(true);
 await page.getByRole('button',{name:'Tu trabajo',exact:true}).click();await page.locator('[data-conversation-actions="chat"]').first().click();await input.fill('Nuevo borrador que debe sobrevivir');
 await expect.poll(()=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('salem.chat.draft.chat')??'null')?.text)).toBe('Nuevo borrador que debe sobrevivir');release();await page.waitForTimeout(300);
 await page.reload();await expect(input).toHaveValue('Nuevo borrador que debe sobrevivir');
});

test('references and request identity survive a lost response; chat menus and the mobile composer remain accessible',async({page})=>{
 let posts:any[]=[];let chat:any={id:'chat',revision:1,projectId:'p',project,objective:'Un objetivo largo '+('con contexto del proyecto '.repeat(30)),status:'needs_input',reason:null,messages:[{id:'q',key:'q',at:1,role:'salem',text:'¿Qué comportamiento necesitas?'}],steps:[],goalId:'goal',planRevision:0,lastAcceptedExecutionId:null,agentId:'codex',commands:[],handledCommands:[]};
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname,state={settings,projects:[project],tasks:[],executions:[],goals:[],evolutions:[],conversations:[chat]};
  if(path==='/api/bootstrap')return route.fulfill({json:{csrfToken:'csrf',state,accounts:[]}});if(path==='/api/state')return route.fulfill({json:{state,accounts:[]}});
  if(path==='/api/conversations/chat/message'){const input=route.request().postDataJSON();posts.push(input);if(posts.length===1){chat={...chat,revision:2,messages:[...chat.messages,{id:'u',key:input.requestKey,at:2,role:'user',text:input.text,references:input.references}]};return route.abort('connectionfailed');}return route.fulfill({json:chat});}return route.fulfill({status:404,json:{error:path}});
 });
 await page.setViewportSize({width:1440,height:900});await page.goto('/#chat/chat');const input=page.getByLabel('Mensaje para Salem',{exact:true});await input.fill('Conserva la API adjunta');await page.getByLabel('Adjuntar referencias de texto').setInputFiles({name:'api.md',mimeType:'text/markdown',buffer:Buffer.from('La API debe conservar sum(a,b).')});
 await page.getByRole('button',{name:'Enviar mensaje',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(input).toHaveValue('Conserva la API adjunta');await expect(page.getByRole('button',{name:'Quitar referencia api.md'})).toBeVisible();
 await page.reload();await expect(input).toHaveValue('Conserva la API adjunta');await expect(page.getByRole('button',{name:'Quitar referencia api.md'})).toBeVisible();
 await page.getByRole('button',{name:'Enviar mensaje',exact:true}).click();await expect(input).toHaveValue('');expect(posts[0].requestKey).toBe(posts[1].requestKey);expect(posts[1].references).toEqual([{name:'api.md',text:'La API debe conservar sum(a,b).'}]);
 await input.fill('Conserva la API adjunta');await page.getByLabel('Adjuntar referencias de texto').setInputFiles({name:'api.md',mimeType:'text/markdown',buffer:Buffer.from('La API debe conservar sum(a,b).')});await page.getByRole('button',{name:'Enviar mensaje',exact:true}).click();await expect(input).toHaveValue('');expect(posts[2].requestKey).not.toBe(posts[1].requestKey);
 await page.locator('[data-conversation-actions="chat"]').first().click({button:'right'});await expect(page.getByRole('menuitem',{name:'Exportar conversación',exact:true})).toBeVisible();await page.keyboard.press('Escape');
 expect(await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+2)).toBe(true);
 await page.setViewportSize({width:390,height:844});await expect(input).toBeInViewport();await expect(page.getByRole('button',{name:'Enviar mensaje',exact:true})).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
