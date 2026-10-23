import { test, expect, type Page } from '@playwright/test';
test.beforeEach(async({page})=>{await page.addInitScript(()=>localStorage.setItem('salem.ui.advanced','true'));});
const settings={revision:1,commands:{claude:['claude'],codex:['codex']},maxConcurrentRuns:1,refreshIntervalMs:1000,preferredPort:3210};
async function install(page:Page, agents?:Record<string,unknown>) {
 let submitted:any;
 const profile={id:'existing',revision:1,name:'Perfil importado',archived:false,createdAt:1,updatedAt:1,baseRef:'HEAD',preparation:[],config:{schemaVersion:1,projectId:'importado',repoRoot:'C:/demo',contextFiles:[],agents,checks:[],capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:60000,maxOutputBytes:10000}}};
 const state={schemaVersion:1,revision:1,settings,projects:agents?[profile]:[],tasks:[],executions:[]};
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;
 if(path==='/api/bootstrap')return route.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}});
 if(path==='/api/state')return route.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}});
 if(path.startsWith('/api/projects')&&route.request().method()!=='GET'){submitted=route.request().postDataJSON();return route.fulfill({json:{...profile,...submitted}});}
 return route.fulfill({status:404,json:{error:'Ruta inesperada '+path}});});
 await page.goto('/'); await page.getByRole('button',{name:'Proyectos',exact:true}).click();
 if(agents)await page.getByRole('button',{name:'Editar Perfil importado',exact:true}).click();
 else {await page.locator('header').getByRole('button',{name:'Agregar proyecto',exact:true}).click();await page.getByLabel('Nombre del proyecto',{exact:true}).fill('Nuevo');await page.getByLabel('Identificador de configuración',{exact:true}).fill('nuevo');await page.getByLabel('Carpeta del repositorio',{exact:true}).fill('C:/demo');}
 return ()=>submitted;
}
test('new profiles propose Sol for build and Opus medium for definition and review, with editable CLI defaults',async({page})=>{
 const saved=await install(page);
 await expect(page.getByLabel('builder: selección de modelo',{exact:true})).toHaveValue('gpt-6.1-sol');
 await expect(page.getByLabel('reviewer: selección de modelo',{exact:true})).toHaveValue('claude-opus-5-5');
 await expect(page.getByLabel('reviewer: esfuerzo (opcional)',{exact:true})).toHaveValue('medium');
 await expect(page.getByLabel('Etapa define',{exact:true})).toHaveValue('reviewer');
 await expect(page.getByLabel('Etapa build',{exact:true})).toHaveValue('builder');
 await expect(page.getByLabel('Etapa review',{exact:true})).toHaveValue('reviewer');
 await page.getByLabel('builder: esfuerzo (opcional)',{exact:true}).fill('high');
 await page.getByLabel('builder: selección de modelo',{exact:true}).selectOption('');
 await expect(page.getByLabel('builder: esfuerzo (opcional)',{exact:true})).toHaveValue('');
 await expect(page.getByLabel('builder: modelo (opcional)',{exact:true})).toHaveValue('');
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();
 await expect.poll(()=>saved()?.config.agents.builder).not.toHaveProperty('model');
 expect(saved().config.agents.builder).not.toHaveProperty('effort');
 expect(saved().config.agents.reviewer).toMatchObject({model:'claude-opus-5-5',effort:'medium'});
});
test('imported custom selections survive editing and switching provider resets incompatible overrides',async({page})=>{
 const saved=await install(page,{builder:{provider:'codex',command:['custom-codex'],model:'unknown-future-model',effort:'future-effort',ignoreUserConfig:true}});
 await expect(page.getByLabel('builder: selección de modelo',{exact:true})).toHaveValue('__custom__');
 await expect(page.getByLabel('builder: modelo (opcional)',{exact:true})).toHaveValue('unknown-future-model');
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();
 await expect.poll(()=>saved()?.config.agents.builder.model).toBe('unknown-future-model');expect(saved().config.agents.builder.effort).toBe('future-effort');
 await page.getByRole('button',{name:'Editar Perfil importado',exact:true}).click();
 await page.getByLabel('builder: proveedor',{exact:true}).selectOption('claude');
 await expect(page.getByLabel('builder: modelo (opcional)',{exact:true})).toHaveValue('claude-opus-5-5');
 await expect(page.getByLabel('builder: esfuerzo (opcional)',{exact:true})).toHaveValue('medium');
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();
 await expect.poll(()=>saved()?.config.agents.builder.provider).toBe('claude');
 expect(saved().config.agents.builder).not.toHaveProperty('ignoreUserConfig');expect(saved().config.agents.builder.command).toEqual(['claude']);
});
test('detected projects expose editable model defaults before saving',async({page})=>{
 let saved:any;
 const config={schemaVersion:1,projectId:'detected',repoRoot:'C:/demo',contextFiles:['AGENTS.md'],agents:{codex:{provider:'codex',command:['codex'],model:'gpt-6.1-sol',ignoreUserConfig:true}},checks:[],capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:60000,maxOutputBytes:10000}};
 const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;
 if(path==='/api/bootstrap')return route.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}});
 if(path==='/api/state')return route.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}});
 if(path==='/api/projects/discover')return route.fulfill({json:{repoRoot:'C:/demo',sourceSha:'a'.repeat(40),stack:['Node.js'],contextFiles:['AGENTS.md'],files:['AGENTS.md'],truncated:false,warnings:[],suggested:{name:'Detectado',baseRef:'HEAD',preparation:[],config}}});
 if(path==='/api/projects'){saved=route.request().postDataJSON();return route.fulfill({json:{...saved,id:'detected',revision:1,createdAt:1,updatedAt:1,archived:false}});}
 return route.fulfill({status:404,json:{error:path}});});
 await page.goto('/');await page.getByRole('button',{name:'Incorporar proyecto',exact:true}).click();await page.getByLabel('Carpeta del repositorio',{exact:true}).fill('C:/demo');await page.getByRole('button',{name:'Investigar repositorio',exact:true}).click();
 await expect(page.getByLabel('codex: selección de modelo',{exact:true})).toHaveValue('gpt-6.1-sol');
 await page.getByLabel('codex: selección de modelo',{exact:true}).selectOption('gpt-6-luna');
 await page.getByRole('button',{name:'Agregar proyecto detectado',exact:true}).click();
 await expect.poll(()=>saved?.config.agents.codex.model).toBe('gpt-6-luna');
});
test('effort selections offer known levels and keep explicit edits when selecting a different model',async({page})=>{
 const saved=await install(page);
 const effort=page.getByLabel('builder: selección de esfuerzo',{exact:true});
 await expect(effort).toHaveValue('');
 await effort.selectOption('medium');
 await expect(page.getByLabel('builder: esfuerzo (opcional)',{exact:true})).toHaveValue('medium');
 await page.getByLabel('builder: selección de modelo',{exact:true}).selectOption('gpt-6-luna');
 await expect(effort.locator('option[value="ultra"]')).toHaveCount(0);
 await expect(effort).toHaveValue('medium');
 await page.getByLabel('reviewer: selección de esfuerzo',{exact:true}).selectOption('');
 await page.getByLabel('reviewer: selección de modelo',{exact:true}).selectOption('sonnet');
 await page.getByLabel('reviewer: selección de modelo',{exact:true}).selectOption('claude-opus-5-5');
 await expect(page.getByLabel('reviewer: esfuerzo (opcional)',{exact:true})).toHaveValue('');
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();
 await expect.poll(()=>saved()?.config.agents.builder.effort).toBe('medium');
 expect(saved().config.agents.reviewer).not.toHaveProperty('effort');
});
test('Haiku keeps imported custom effort without suggesting unsupported levels',async({page})=>{
 const saved=await install(page,{builder:{provider:'claude',command:['claude'],model:'haiku',effort:'future-level'}});
 const effort=page.getByLabel('builder: selección de esfuerzo',{exact:true});
 await expect(effort).toHaveValue('__custom__');
 await expect(effort.locator('option')).toHaveCount(2);
 await expect(page.getByLabel('builder: esfuerzo (opcional)',{exact:true})).toHaveValue('future-level');
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();
 await expect.poll(()=>saved()?.config.agents.builder.effort).toBe('future-level');
});
