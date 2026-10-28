import { test, expect } from '@playwright/test';
test.beforeEach(async({page})=>{await page.addInitScript(()=>localStorage.setItem('salem.ui.advanced','true'));});
const settings={revision:1,commands:{claude:['claude'],codex:['codex']},maxConcurrentRuns:1,refreshIntervalMs:1000,preferredPort:3210};
test('empty installation, complete profile and revision conflict preserve user draft',async({page})=>{
 let projects:any[]=[]; let conflict=false; let submitted:any;
 const state=()=>({schemaVersion:1,revision:1,settings,projects,tasks:[],executions:[]});
 await page.route('**/api/**',async route=>{
 const u=new URL(route.request().url());
 if(u.pathname==='/api/bootstrap')return route.fulfill({json:{csrfToken:'test-csrf',state:state(),accounts:[],dataDir:'C:/Salem'}});
 if(u.pathname==='/api/state')return route.fulfill({json:{state:state(),accounts:[],dataDir:'C:/Salem'}});
 if(u.pathname==='/api/projects'&&route.request().method()==='POST'){
 expect(route.request().headers()['x-salem-csrf']).toBe('test-csrf'); submitted=route.request().postDataJSON();
 if(conflict)return route.fulfill({status:409,json:{error:'Revisión desactualizada'}});
 const p={...submitted,id:'project-1',revision:1,archived:false,createdAt:1,updatedAt:1};projects=[p];return route.fulfill({json:p});}
 return route.fulfill({status:404,json:{error:'Ruta inesperada '+u.pathname}});
 });
 await page.goto('/');await expect(page.getByRole('heading',{name:'Tu espacio de trabajo local'})).toBeVisible();
 await page.getByRole('button',{name:'Proyectos',exact:true}).click();
 await page.locator('header').getByRole('button',{name:'Agregar proyecto',exact:true}).click();
 await page.getByLabel('Nombre del proyecto',{exact:true}).fill('Mi proyecto');
 await page.getByLabel('Identificador de configuración',{exact:true}).fill('mi-proyecto');
 await page.getByLabel('Carpeta del repositorio',{exact:true}).fill('C:/repos/demo');await page.getByLabel('Instrucciones adicionales',{exact:true}).fill('Temporal');await page.getByLabel('Instrucciones adicionales',{exact:true}).fill('');await page.getByLabel('builder: modelo (opcional)',{exact:true}).fill('Temporal');await page.getByLabel('builder: modelo (opcional)',{exact:true}).fill('');
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Mi proyecto',exact:true})).toBeVisible();expect(submitted.config.agents.builder.command).toEqual(['codex']);expect(submitted.config).not.toHaveProperty('instructions');expect(submitted.config.agents.builder).not.toHaveProperty('model');
 await page.getByRole('button',{name:'Editar Mi proyecto',exact:true}).click();
 await page.getByLabel('Nombre del proyecto',{exact:true}).fill('Borrador sin perder');conflict=true;
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Revisión desactualizada');await expect(page.getByRole('alert')).toBeInViewport();
 await page.waitForTimeout(1300);await expect(page.getByLabel('Nombre del proyecto',{exact:true})).toHaveValue('Borrador sin perder');
 await expect(page.getByRole('button',{name:'Actualizar listas',exact:true})).toBeVisible();
});
test('all screens remain usable on mobile and settings preserve argument boundaries',async({page})=>{
 let sent:any;const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;if(path==='/api/bootstrap')return r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}});if(path==='/api/settings'){sent=r.request().postDataJSON();return r.fulfill({json:{...sent,revision:2}});}return r.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}});});
 await page.setViewportSize({width:390,height:844});await page.goto('/');
 await page.getByRole('button',{name:'Ajustes',exact:true}).click();
 await page.getByLabel('Codex: argumento 1',{exact:true}).fill('C:/Program Files/codex.cmd');
 await page.getByRole('button',{name:'Guardar ajustes',exact:true}).click();expect(sent.commands.codex).toEqual(['C:/Program Files/codex.cmd']);
 await expect(page.getByRole('status')).toContainText('Ajustes guardados');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 for(const name of ['Tareas','Ejecuciones','Cuentas','Inicio']){await page.getByRole('button',{name,exact:true}).click();await expect(page.locator('main')).toBeVisible();}
});
test('demo execution exposes immutable task, real evidence and paginated logs; account commands use CSRF',async({page})=>{
 const project={id:'p',revision:1,name:'Demo local',archived:false,createdAt:1,updatedAt:1,baseRef:'HEAD',preparation:[],config:{schemaVersion:1,projectId:'demo',repoRoot:'C:/demo',contextFiles:[],agents:{builder:{provider:'codex',command:['codex']}},checks:[{id:'tests',command:['node','--test'],required:true}],capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:60000,maxOutputBytes:10000}}};
 const task={id:'t',revision:1,projectId:'p',archived:false,createdAt:1,updatedAt:1,spec:{id:'DEMO-1',objective:'Corregir suma',scope:['sum.js'],acceptance:['Suma correcta'],references:[]}};
 const execution={id:'e',revision:1,taskId:'t',projectId:'p',requestKey:'req',createdAt:1,updatedAt:2,finishedAt:2,status:'completed',reason:null,project,task:task.spec,workspace:'C:/worktree',sourceSha:'abc123',runId:'run-1',stateDir:'C:/Salem/runs/e',setupMs:20,preparationLogs:[]};
 let demo=false;let started=false;let connected=false;let logReads=0;let starts=0;const account=()=>({provider:'codex',installed:true,compatible:true,authenticated:connected,version:'1.0 fixture',error:null,connection:connected?'connected':'idle',loginUrl:null,userCode:null,needsInput:false});const state=()=>({schemaVersion:1,revision:1,settings,projects:demo?[project]:[],tasks:demo?[task]:[],executions:started?[execution]:[]});
 await page.route('**/api/**',async r=>{const u=new URL(r.request().url());const method=r.request().method();if(method!=='GET')expect(r.request().headers()['x-salem-csrf']).toBe('csrf');
 if(u.pathname==='/api/bootstrap')return r.fulfill({json:{csrfToken:'csrf',state:state(),accounts:[account()],dataDir:'C:/Salem'}});
 if(u.pathname==='/api/state')return r.fulfill({json:{state:state(),accounts:[account()],dataDir:'C:/Salem'}});
 if(u.pathname==='/api/projects/demo/plan')return r.fulfill({json:{roles:{define:'codex',build:'codex',review:'codex'},selected:'codex',fallback:false,crossProvider:false,estimates:[{provider:'codex',stages:['define','build','review'],model:null,effort:null,reference:null,matchesReference:false}]}});
 if(u.pathname==='/api/projects/demo'){expect(r.request().postDataJSON()).toEqual({provider:'codex',roles:{define:'codex',build:'codex',review:'codex'}});demo=true;return r.fulfill({json:{project,task}});}
 if(u.pathname==='/api/executions'){started=true;starts++;return r.fulfill({json:{...execution,id:starts===1?'e':'e2'}});}
 if(u.pathname==='/api/executions/e2')return r.fulfill({json:{execution:{...execution,id:'e2'},metrics:null,diff:'',run:null,artifacts:[{path:'logs/build.txt',bytes:9}]}});
 if(u.pathname==='/api/executions/e')return r.fulfill({json:{execution,metrics:null,diff:'+ return a + b;',artifacts:[{path:'logs/build.txt',bytes:9}],run:{id:'run-1',status:'completed',attempts:[],history:[{at:2,status:'completed',reason:'Aceptada'}],checks:[{checkId:'tests',status:'passed',execution:'actual',durationMs:30,exitCode:0,reason:null}],acceptance:{accepted:true,reasons:[],checkIds:['tests']},validation:null,delivery:null,deliveryJournal:null}}});
 if(u.pathname.endsWith('/artifact')){logReads++;return r.fulfill({json:{text:logReads===1?'parte uno':'parte dos',truncated:logReads===1,nextOffset:logReads===1?9:null}});}
 if(u.pathname==='/api/accounts/codex/check'){connected=true;return r.fulfill({json:account()});}
 return r.fulfill({status:404,json:{error:'Ruta no prevista '+u.pathname}});});
 await page.goto('/');await page.getByRole('button',{name:'Crear demo local',exact:true}).click();await page.getByRole('button',{name:'Confirmar y crear demo',exact:true}).click();await expect(page.getByRole('status')).toContainText('Demo local creada');
 await page.getByRole('button',{name:'Tareas',exact:true}).click();await page.getByRole('button',{name:'Ejecutar DEMO-1',exact:true}).click();
 await expect(page.getByRole('heading',{name:'DEMO-1',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Checks',exact:true}).click();await expect(page.getByRole('heading',{name:'tests Aprobado',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Diff',exact:true}).click();await expect(page.locator('pre')).toContainText('+ return a + b;');
 await page.getByRole('button',{name:'Logs',exact:true}).click();await page.getByRole('button',{name:/logs\/build.txt/}).click();await expect(page.locator('pre')).toContainText('parte uno');await page.getByRole('button',{name:'Cargar más',exact:true}).click();await expect(page.locator('pre')).toContainText('parte dos');
 await page.getByRole('button',{name:'Repetir como nueva',exact:true}).click();await expect(page.getByText('e2',{exact:true})).toBeVisible();await expect(page.getByText('parte unoparte dos',{exact:true})).not.toBeVisible();await page.getByRole('button',{name:'Cuentas',exact:true}).click();await page.getByRole('button',{name:'Comprobar Codex',exact:true}).click();await expect(page.getByText('Conectada',{exact:true})).toBeVisible();
});
test('malformed profile import reports an error without losing the application',async({page})=>{
 const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};
 await page.route('**/api/**',r=>r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}}));
 await page.goto('/');await page.getByRole('button',{name:'Proyectos',exact:true}).click();
 await page.getByLabel('Importar perfil',{exact:true}).setInputFiles({name:'bad.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schemaVersion:1,agents:{}}))});
 await expect(page.getByRole('alert')).toContainText('perfil');await expect(page.getByRole('heading',{name:'Proyectos',exact:true})).toBeVisible();
});
test('profile forms serialize preparation, agents, limits, checks and every delivery group',async({page})=>{
 let saved:any;const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;if(path==='/api/bootstrap')return r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}});if(path==='/api/filesystem/directories')return r.fulfill({json:{path:'C:/demo',parent:'C:/',directories:[]}});if(path==='/api/projects'){saved=r.request().postDataJSON();return r.fulfill({json:{...saved,id:'p',revision:1,archived:false,createdAt:1,updatedAt:1}});}return r.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}});});
 await page.goto('/');await page.getByRole('button',{name:'Agregar proyecto',exact:true}).click();
 await page.getByLabel('Nombre del proyecto',{exact:true}).fill('Completo');await page.getByLabel('Identificador de configuración',{exact:true}).fill('completo');
 await page.getByRole('button',{name:'Elegir carpeta',exact:true}).click();await page.getByRole('button',{name:'Ir',exact:true}).click();await page.waitForTimeout(100);expect(saved).toBeUndefined();await page.getByRole('button',{name:'Usar esta carpeta',exact:true}).click();await expect(page.getByLabel('Carpeta del repositorio',{exact:true})).toHaveValue('C:/demo');
 await page.getByLabel('Archivos de contexto',{exact:true}).fill('AGENTS.md\ndocs/context.md');await page.getByLabel('Instrucciones adicionales',{exact:true}).fill('Conservar contratos');
 await page.getByLabel('builder: modelo (opcional)',{exact:true}).fill('modelo-personal');await page.getByLabel('builder: esfuerzo (opcional)',{exact:true}).fill('high');
 await page.getByRole('button',{name:'Agregar argumento',exact:true}).first().click();await page.getByLabel('builder: comando: argumento 2',{exact:true}).fill('--flag with spaces');
 await page.locator('summary').filter({hasText:'Preparación del entorno'}).click();await page.getByRole('button',{name:'Agregar comando de preparación',exact:true}).click();await page.getByLabel('Preparación 1: argumento 1',{exact:true}).fill('npm');
 await page.getByRole('button',{name:'Agregar check',exact:true}).click();await page.getByLabel('Check 1: identificador',{exact:true}).fill('test');await page.getByLabel('Check 1: comando: argumento 1',{exact:true}).fill('node');await page.getByLabel('Check 1: razón de no aplicabilidad',{exact:true}).fill('Solo si aplica');await page.getByLabel('Check 1: archivos de herramientas',{exact:true}).fill('check.mjs');
 await page.locator('summary').filter({hasText:'Límites y capacidades'}).click();await page.getByLabel('Tiempo por etapa (ms)',{exact:true}).fill('60000');await page.getByLabel('Salida máxima (bytes)',{exact:true}).fill('40960');await page.getByLabel('Tiempo máximo de corrida (ms)',{exact:true}).fill('120000');await page.getByLabel('Intentos máximos',{exact:true}).fill('2');await page.getByLabel('Límite de tokens reportados (opcional)',{exact:true}).fill('10000');await page.getByLabel('Crear commits',{exact:true}).check();
 await page.locator('summary').filter({hasText:'Entrega y recuperación'}).click();await page.getByLabel('Configurar entrega',{exact:true}).check();await page.getByLabel('Nombre del autor',{exact:true}).fill('Operador');await page.getByLabel('Correo del autor',{exact:true}).fill('local@example.test');
 await page.getByLabel('Configurar GitHub',{exact:true}).check();await page.getByLabel('GitHub: URL del remoto',{exact:true}).fill('https://example.test/repo.git');await page.getByLabel('GitHub: repositorio (owner/repo)',{exact:true}).fill('local/demo');await page.getByLabel('GitHub: archivos de herramientas',{exact:true}).fill('gh.mjs');await page.getByLabel('Configurar integración de pull request',{exact:true}).check();await page.getByLabel('Checks requeridos para integrar',{exact:true}).fill('test');
 await page.getByLabel('Configurar despliegue',{exact:true}).check();await page.getByLabel('Despliegue: comando: argumento 1',{exact:true}).fill('deploy');await page.getByLabel('Despliegue: consultar estado: argumento 1',{exact:true}).fill('status');await page.getByLabel('Destino del despliegue',{exact:true}).fill('local');await page.getByLabel('Despliegue: archivos de herramientas',{exact:true}).fill('deploy.mjs');await page.getByLabel('Checks requeridos para desplegar',{exact:true}).fill('test');
 await page.getByRole('button',{name:'Guardar proyecto',exact:true}).click();await expect(page.getByRole('status')).toContainText('Proyecto guardado');
 expect(saved.preparation).toEqual([['npm']]);expect(saved.config.contextFiles).toEqual(['AGENTS.md','docs/context.md']);expect(saved.config.instructions).toBe('Conservar contratos');expect(saved.config.agents.builder).toMatchObject({model:'modelo-personal',effort:'high',command:['codex','--flag with spaces']});expect(saved.config.supervisor).toMatchObject({runTimeoutMs:120000,maxAttempts:2,maxReportedTokens:10000});expect(saved.config.checks[0]).toMatchObject({id:'test',toolFiles:['check.mjs']});expect(saved.config.delivery).toMatchObject({recovery:'query_only',commit:{author:{name:'Operador',email:'local@example.test'}},github:{repository:'local/demo',merge:{method:'squash',requiredChecks:['test']}},deploy:{command:['deploy'],statusCommand:['status'],target:'local',toolFiles:['deploy.mjs'],requiredChecks:['test']}});
});
test('visual utility layout has no overflow or console errors across desktop tablet and mobile',async({page},testInfo)=>{
 const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
 await page.route('**/api/**',r=>r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}}));
 for(const [width,height] of [[1440,900],[820,1180],[390,844]]){await page.setViewportSize({width:width!,height:height!});await page.goto('/');await expect(page.getByRole('heading',{name:'Tu espacio de trabajo local'})).toBeVisible();await expect(page.getByRole('button',{name:'Ajustes',exact:true})).toBeInViewport({ratio:1});await page.getByRole('button',{name:'Inicio',exact:true}).focus();await page.keyboard.press('Tab');await expect(page.getByRole('button',{name:'Proyectos',exact:true})).toBeFocused();await page.screenshot({path:testInfo.outputPath(`inicio-${width}.png`),fullPage:true});for(const name of ['Proyectos','Tareas','Ejecuciones','Cuentas','Ajustes']){await page.getByRole('button',{name,exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${name} ${width}`).toBe(true);}await page.getByRole('button',{name:'Proyectos',exact:true}).click();await page.locator('header').getByRole('button',{name:'Agregar proyecto',exact:true}).click();await expect(page.getByLabel('Nombre del proyecto',{exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath(`formulario-${width}.png`),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`Formulario ${width}`).toBe(true);}
 expect(errors).toEqual([]);
});
test('renaming an agent preserves its configuration and role assignments',async({page})=>{
 const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};await page.route('**/api/**',r=>r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}}));
 await page.goto('/');await page.getByRole('button',{name:'Agregar proyecto',exact:true}).click();
 await page.getByLabel('builder: identificador',{exact:true}).fill('implementador');await page.getByRole('heading',{name:'Agregar proyecto',exact:true}).click();
 await expect(page.getByLabel('implementador: comando: argumento 1',{exact:true})).toHaveValue('codex');await expect(page.getByLabel('Etapa define',{exact:true})).toHaveValue('reviewer');await expect(page.getByLabel('Etapa build',{exact:true})).toHaveValue('implementador');
});
test('data folder is configured in the GUI for the next launch without moving the current catalog',async({page})=>{
 let sent:any;const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};
 await page.route('**/api/**',async r=>{const path=new URL(r.request().url()).pathname;if(path==='/api/bootstrap')return r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}});if(path==='/api/settings'){sent=r.request().postDataJSON();return r.fulfill({json:{...sent,revision:2}});}if(path==='/api/filesystem/directories')return r.fulfill({json:{path:'C:/SalemNext',parent:'C:/',directories:[]}});return r.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}});});
 await page.goto('/');await page.getByRole('button',{name:'Ajustes',exact:true}).click();await expect(page.getByLabel('Carpeta de datos al reiniciar',{exact:true})).toHaveValue('C:/Salem');await page.getByLabel('Carpeta de datos al reiniciar',{exact:true}).fill('C:/SalemNext');
 await page.getByRole('button',{name:'Elegir carpeta de datos',exact:true}).click();await page.getByRole('button',{name:'Usar esta carpeta',exact:true}).click();await page.getByRole('button',{name:'Guardar ajustes',exact:true}).click();await expect(page.getByRole('status')).toContainText('Ajustes guardados');expect(sent.nextDataDir).toBe('C:/SalemNext');await expect(page.locator('.data-location code').first()).toHaveText('C:/Salem');
});
