import {test,expect} from '@playwright/test';
const settings={revision:1,commands:{claude:['claude'],codex:['codex']},maxConcurrentRuns:1,refreshIntervalMs:1000,preferredPort:3210};
const project={id:'p',revision:1,name:'Mi demo',archived:false,createdAt:1,updatedAt:1,baseRef:'HEAD',preparation:[],config:{schemaVersion:1,projectId:'demo',repoRoot:'C:/demo',contextFiles:[],agents:{builder:{provider:'codex',command:['codex']}},supervisor:{roles:{define:'builder',build:'builder',review:'builder'}},checks:[],capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:60000,maxOutputBytes:10000}}};
test.beforeEach(async({page})=>{
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;const state={schemaVersion:1,revision:1,settings,projects:[project],tasks:[],executions:[],goals:[],evolutions:[]};
  if(path==='/api/bootstrap')return r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}});
  if(path==='/api/state')return r.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}});
  return r.fulfill({status:400,json:{error:'No debería enviarse un formulario inválido'}});
 });await page.goto('/');
});
test('simple navigation prioritizes projects and keeps technical tools reachable',async({page})=>{
 const nav=page.getByRole('navigation',{name:'Navegación principal'});
 await expect(nav.getByRole('button',{name:'Trabajo',exact:true})).toBeVisible();
 await expect(nav.getByRole('button',{name:'Tareas',exact:true})).not.toBeVisible();
 await nav.getByText('Herramientas avanzadas',{exact:true}).click();
 await expect(nav.getByRole('button',{name:'Tareas',exact:true})).toBeVisible();
 await nav.getByRole('button',{name:'Trabajo',exact:true}).click();await expect(page.getByRole('heading',{name:'Tu trabajo',exact:true})).toBeVisible();
});
test('sidebar resizes with keyboard and persists its width',async({page})=>{
 const handle=page.getByRole('separator',{name:'Ancho del menú lateral'});await handle.focus();await handle.press('ArrowRight');
 await expect(handle).toHaveAttribute('aria-valuenow','252');await page.reload();await expect(handle).toHaveAttribute('aria-valuenow','252');
});
test('project menus work by right click and keyboard and icon actions have tooltips',async({page})=>{
 await page.getByRole('button',{name:'Proyectos',exact:true}).click();
 const copy=page.getByRole('button',{name:'Duplicar Mi demo',exact:true});await copy.hover();await expect(page.getByRole('tooltip')).toContainText('Duplicar Mi demo');
 await page.locator('.project-card').click({button:'right'});await expect(page.getByRole('menu',{name:'Acciones de Mi demo'})).toBeVisible();
 await page.getByRole('menuitem',{name:'Editar',exact:true}).click();await expect(page.getByLabel('Nombre del proyecto',{exact:true})).toHaveValue('Mi demo');
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Proyectos',exact:true}).click();
 await page.getByRole('button',{name:'Acciones de Mi demo',exact:true}).focus();await page.keyboard.press('Enter');await page.keyboard.press('ArrowDown');await page.keyboard.press('Escape');await expect(page.getByRole('menu')).toHaveCount(0);
});
test('invalid acceptance is explained at the field and beside save without losing the draft',async({page})=>{
 await page.getByText('Herramientas avanzadas',{exact:true}).click();await page.getByRole('button',{name:'Tareas',exact:true}).click();await page.locator('.page-header').getByRole('button',{name:'Agregar tarea',exact:true}).click();
 await page.getByLabel('Identificador de tarea',{exact:true}).fill('TEST');await page.getByLabel('Objetivo',{exact:true}).fill('Mi instrucción');await page.getByRole('button',{name:'Guardar tarea',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Agrega al menos un criterio');await expect(page.getByRole('alert')).toBeInViewport();
 await expect(page.getByLabel('Criterios de aceptación',{exact:true})).toHaveAttribute('aria-invalid','true');await expect(page.getByLabel('Objetivo',{exact:true})).toHaveValue('Mi instrucción');
});
test('activity owns a single vertical scroll container and selects use the modern picker',async({page})=>{
 await page.getByRole('button',{name:'Ver actividad',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Actividad de Salem'});
 expect(await dialog.evaluate(e=>getComputedStyle(e).overflowY)).toBe('hidden');
 expect(await dialog.locator('.activity-body').evaluate(e=>getComputedStyle(e).overflowY)).toBe('auto');
 await dialog.getByRole('button',{name:'Cerrar diálogo'}).click();
 expect(await page.getByLabel('Proyecto del objetivo',{exact:true}).evaluate(e=>getComputedStyle(e).appearance)).toBe('base-select');
});


test('a polling error cannot be hidden behind an earlier success notification',async({page})=>{
 let failing=false;const state={schemaVersion:1,revision:1,settings,projects:[project],tasks:[],executions:[],goals:[],evolutions:[]};
 await page.route('**/api/settings',r=>r.fulfill({json:{...settings,revision:2}}));
 await page.route('**/api/state',r=>failing?r.fulfill({status:500,json:{error:'Falló la lectura del catálogo'}}):r.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}}));
 await page.getByRole('button',{name:'Ajustes',exact:true}).click();await page.getByRole('button',{name:'Guardar ajustes',exact:true}).click();await expect(page.getByRole('status')).toBeVisible();failing=true;
 await expect(page.getByRole('alert')).toContainText('Falló la lectura');await expect(page.getByRole('status')).toHaveCount(0);await expect(page.getByRole('alert')).toBeInViewport();
});

test('work exposes its filter and starts with all projects so new work is not hidden',async({page})=>{
 await page.getByRole('button',{name:'Abrir proyecto Mi demo',exact:true}).click();await page.getByRole('button',{name:'Trabajo',exact:true}).click();
 await expect(page.getByLabel('Proyecto del trabajo',{exact:true})).toHaveValue('');
 await page.getByLabel('Proyecto del trabajo',{exact:true}).selectOption('p');await expect(page.getByLabel('Proyecto del trabajo',{exact:true})).toHaveValue('p');
});

test('compact projects keep the remaining projects accessible through show more',async({page})=>{
 const projects=Array.from({length:7},(_,i)=>({...project,id:`p${i}`,name:`Proyecto ${i}`}));const state={schemaVersion:1,revision:1,settings,projects,tasks:[],executions:[],goals:[],evolutions:[]};
 await page.route('**/api/bootstrap',r=>r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}}));await page.route('**/api/state',r=>r.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}}));await page.reload();
 await expect(page.getByRole('button',{name:'Abrir proyecto Proyecto 6',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Mostrar más proyectos',exact:true}).click();await expect(page.getByRole('button',{name:'Abrir proyecto Proyecto 6',exact:true})).toBeVisible();
});
