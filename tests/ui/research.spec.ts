import { test, expect, type Page } from '@playwright/test';
test.beforeEach(async({page})=>{await page.addInitScript(()=>localStorage.setItem('salem.ui.advanced','true'));});
import { readFile } from 'node:fs/promises';

test('duplicating exporting and importing a planned task preserve its investigated origin', async ({page}) => {
 const origin={goalId:'g',sourceSha:'a'.repeat(40),projectRevision:1},original={id:'task',revision:1,projectId:'p',archived:false,createdAt:1,updatedAt:1,spec:{id:'PLAN-SHA',objective:'Fix sum',scope:['sum.mjs'],acceptance:['Correct sum'],references:['AGENTS.md']},origin};let tasks:any[]=[original],submitted:any;
 const state=()=>({schemaVersion:1,revision:1,settings,projects:[project],tasks,executions:[],goals:[]});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;if(path==='/api/bootstrap')return route.fulfill({json:{csrfToken:'csrf',state:state(),accounts:[],dataDir:'C:/Salem'}});if(path==='/api/state')return route.fulfill({json:{state:state(),accounts:[],dataDir:'C:/Salem'}});if(path==='/api/tasks'){submitted=route.request().postDataJSON();const saved={...submitted,id:'copy-'+tasks.length,revision:1,archived:false,createdAt:1,updatedAt:1};tasks.push(saved);return route.fulfill({json:saved});}return route.fulfill({status:404,json:{error:path}});});
 await page.goto('/');await page.getByRole('button',{name:'Tareas',exact:true}).click();await page.getByRole('button',{name:'Duplicar PLAN-SHA',exact:true}).click();await page.getByRole('button',{name:'Guardar tarea',exact:true}).click();await expect.poll(()=>submitted?.origin).toEqual(origin);await expect(page.getByRole('heading',{name:'Tareas',exact:true})).toBeVisible();
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Exportar PLAN-SHA',exact:true}).click();const file=await (await download).path();const exported=JSON.parse(await readFile(file!,'utf8'));expect(exported.origin).toEqual(origin);
 exported.spec.id='IMPORTED-SHA';submitted=undefined;await page.getByLabel('Importar tarea',{exact:true}).setInputFiles({name:'task.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(exported))});await page.getByRole('button',{name:'Guardar tarea',exact:true}).click();await expect.poll(()=>submitted?.origin).toEqual(origin);await expect(page.getByRole('heading',{name:'Tareas',exact:true})).toBeVisible();
});

const settings = { revision: 1, commands: { claude: ['claude'], codex: ['codex'] }, maxConcurrentRuns: 1, refreshIntervalMs: 500, preferredPort: 3210 };
const project = { id: 'p', revision: 1, name: 'Demo', archived: false, createdAt: 1, updatedAt: 1, baseRef: 'a'.repeat(40), preparation: [], config: { schemaVersion: 1, projectId: 'demo', repoRoot: 'C:/demo', contextFiles: ['AGENTS.md'], agents: { codex: { provider: 'codex', command: ['codex'], ignoreUserConfig: true }, claude: { provider: 'claude', command: ['claude'] } }, checks: [{ id: 'sum', command: ['node', '.salem-check.mjs'], required: true }], capabilities: { edit: true, commit: false, pull_request: false, merge: false, deploy: false }, budgets: { stageTimeoutMs: 180000, maxOutputBytes: 2000000 }, supervisor: { roles: { define: 'codex', build: 'codex', review: 'codex' }, runTimeoutMs: 600000, maxAttempts: 6 } } };
const plan = { schemaVersion: 1, verdict: 'ready', summary: 'La suma resta los argumentos.', facts: [{ description: 'sum usa una resta.', files: ['sum.mjs'] }], assumptions: ['Se mantiene la API actual.'], decisions: ['Cambiar solamente el operador.'], questions: [], steps: [{ title: 'Corregir la suma', description: 'Cambiar la resta por una suma.', files: ['sum.mjs'] }], task: { objective: 'Corregir sum(a,b)', scope: ['sum.mjs'], acceptance: ['La suma es correcta'], references: ['AGENTS.md'], checkIds: ['sum', 'extra'] }, proposedChecks: [{ id: 'extra', command: ['node', '--test'], toolFiles: [] }] };
const goalBase = { id: 'g', revision: 1, projectId: 'p', requestKey: 'req', objective: 'Haz que la suma funcione', agentId: 'codex', project, sourceSha: 'a'.repeat(40), status: 'ready', createdAt: 1, updatedAt: 2, finishedAt: 2, reason: null, answers: [], attempts: [{ id: 'attempt-1', startedAt: 1, finishedAt: 2, status: 'succeeded', error: null, usage: { inputTokens: 100, outputTokens: 50, cachedInputTokens: null, costUsd: null, costKind: 'unavailable', model: 'fixture' }, sessionId: 'session', durationMs: 1000 }], plan, createdTaskId: null };

test('incorporation proposes a detected profile without executing and preserves manual editing', async ({page}) => {
  let projects: any[] = [], saved: any, detected: any;
  const state = () => ({ schemaVersion: 1, revision: 1, settings, projects, tasks: [], executions: [] });
  await page.route('**/api/**', async r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/bootstrap') return r.fulfill({ json: { csrfToken: 'csrf', state: state(), accounts: [], dataDir: 'C:/Salem' } });
    if (path === '/api/state') return r.fulfill({ json: { state: state(), accounts: [], dataDir: 'C:/Salem' } });
    expect(r.request().headers()['x-salem-csrf']).toBe('csrf');
    if (path === '/api/projects/discover') { detected = r.request().postDataJSON(); return r.fulfill({ json: { repoRoot: 'C:/demo', sourceSha: project.baseRef, stack: ['Node.js'], contextFiles: ['AGENTS.md'], files: ['AGENTS.md', 'sum.mjs'], truncated: false, warnings: ['Los cambios sin commit no se incluyen.'], suggested: { name: project.name, baseRef: project.baseRef, preparation: [], config: project.config } } }); }
    if (path === '/api/projects') { saved = r.request().postDataJSON(); projects = [{...project, ...saved}]; return r.fulfill({ json: projects[0] }); }
    return r.fulfill({ status: 404, json: { error: path } });
  });
  await page.goto('/'); await page.getByRole('button', {name: 'Incorporar proyecto', exact: true}).click();
  await page.getByLabel('Carpeta del repositorio', {exact: true}).fill('C:/demo');
  await page.getByLabel('Proveedor para este proyecto', {exact: true}).selectOption('claude');
  await page.getByRole('button', {name: 'Investigar repositorio', exact: true}).click();
  expect(detected).toEqual({repoRoot: 'C:/demo', provider: 'claude'}); expect(saved).toBeUndefined();
  await expect(page.getByRole('heading', {name: 'Configuración detectada', exact: true})).toBeVisible();
  await expect(page.getByText('Los cambios sin commit no se incluyen.', {exact: true})).toBeVisible();
  await expect(page.getByText('node .salem-check.mjs', {exact: true})).toBeVisible();
  await page.getByLabel('Nombre del proyecto', {exact: true}).fill('Mi demo');
  await page.getByRole('button', {name: 'Agregar proyecto detectado', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Mi demo', exact: true})).toBeVisible(); expect(saved.baseRef).toBe(project.baseRef);
  await page.getByRole('button', {name: 'Editar Mi demo', exact: true}).click(); await expect(page.getByLabel('Archivos de contexto', {exact: true})).toHaveValue('AGENTS.md');
});

test('natural objective shows the plan and creates a task only on explicit action', async ({page}) => {
  let goals: any[] = [], tasks: any[] = [], sent: any, materializations = 0, executions = 0;
  const state = () => ({ schemaVersion: 1, revision: 1, settings, projects: [project], tasks, executions: [], goals });
  await page.route('**/api/**', async r => {
    const path = new URL(r.request().url()).pathname;
    if (path === '/api/bootstrap') return r.fulfill({ json: {csrfToken:'csrf',state:state(),accounts:[],dataDir:'C:/Salem'} });
    if (path === '/api/state') return r.fulfill({ json: {state:state(),accounts:[],dataDir:'C:/Salem'} });
    expect(r.request().headers()['x-salem-csrf']).toBe('csrf');
    if (path === '/api/goals') { sent = r.request().postDataJSON(); goals = [{...goalBase, agentId: sent.agentId}]; return r.fulfill({json:goals[0]}); }
    if (path === '/api/goals/g/materialize') { materializations++; expect(r.request().postDataJSON()).toEqual({revision:1}); tasks=[{id:'t',projectId:'p',revision:1,archived:false,createdAt:1,updatedAt:1,spec:{id:'PLAN-G',...plan.task}}]; goals=[{...goals[0],status:'materialized',createdTaskId:'t'}]; return r.fulfill({json:{goal:goals[0],task:tasks[0]}}); }
    if (path === '/api/executions') { executions++; return r.fulfill({status:500,json:{error:'No debe ejecutarse automáticamente'}}); }
    return r.fulfill({status:404,json:{error:path}});
  });
  await page.goto('/'); await page.getByRole('button',{name:'Objetivos',exact:true}).click();
  await page.getByLabel('Qué quieres lograr', {exact:true}).fill('Haz que la suma funcione');
  await page.getByLabel('Agente investigador', {exact:true}).selectOption('claude');
  await page.waitForTimeout(700); await expect(page.getByLabel('Qué quieres lograr', {exact:true})).toHaveValue('Haz que la suma funcione');
  await page.getByRole('button',{name:'Investigar objetivo',exact:true}).click();
  await expect.poll(()=>sent).toMatchObject({projectId:'p',objective:'Haz que la suma funcione',agentId:'claude'}); expect(sent.requestKey).toBeTruthy();
  await expect(page.getByText('sum usa una resta.', {exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Corregir la suma',exact:true})).toBeVisible();
  await expect(page.getByText('node --test',{exact:true})).toBeVisible();
  expect(materializations).toBe(0);expect(executions).toBe(0);
  await page.getByRole('button',{name:'Crear tarea del plan',exact:true}).click();
  await expect(page.getByRole('heading',{name:'PLAN-G',exact:true})).toBeVisible();expect(materializations).toBe(1);expect(executions).toBe(0);
});

test('business answers survive polling and conflicts, failed research can retry and logs paginate', async ({page}) => {
  let goal: any = {...goalBase,status:'needs_input',plan:{...plan,verdict:'needs_input',questions:['¿Deben aceptarse números decimales?']}}; let answer: any, retry: any, logReads=0;
  const state = () => ({schemaVersion:1,revision:1,settings,projects:[project],tasks:[],executions:[],goals:[goal]});
  await page.route('**/api/**', async r => {
    const u=new URL(r.request().url());if(u.pathname==='/api/bootstrap')return r.fulfill({json:{csrfToken:'csrf',state:state(),accounts:[],dataDir:'C:/Salem'}});if(u.pathname==='/api/state')return r.fulfill({json:{state:state(),accounts:[],dataDir:'C:/Salem'}});
    if(u.pathname.endsWith('/answer')){answer=r.request().postDataJSON();return r.fulfill({status:409,json:{error:'El objetivo cambió. Recarga su versión.'}});}
    if(u.pathname.endsWith('/retry')){retry=r.request().postDataJSON();goal={...goal,status:'investigating',revision:3};return r.fulfill({json:goal});}
    if(u.pathname.endsWith('/artifact')){logReads++;return r.fulfill({json:{text:logReads===1?'Primera parte':'Segunda parte',truncated:logReads===1,nextOffset:10}});}
    return r.fulfill({status:404,json:{error:u.pathname}});
  });
  await page.goto('/');await page.getByRole('button',{name:'Objetivos',exact:true}).click();await page.getByRole('button',{name:'Ver plan',exact:true}).click();
  await expect(page.getByText('¿Deben aceptarse números decimales?',{exact:true})).toBeVisible();
  await page.getByLabel('Tu respuesta',{exact:true}).fill('Sí, también decimales');await page.waitForTimeout(700);await page.getByRole('button',{name:'Continuar investigación',exact:true}).click();
  await expect.poll(()=>answer).toEqual({revision:1,text:'Sí, también decimales'});await expect(page.getByRole('alert')).toContainText('El objetivo cambió');await expect(page.getByLabel('Tu respuesta',{exact:true})).toHaveValue('Sí, también decimales');
  await page.getByRole('button',{name:'Ver stdout.log',exact:true}).click();await expect(page.locator('pre')).toContainText('Primera parte');await page.getByRole('button',{name:'Cargar más',exact:true}).click();await expect(page.locator('pre')).toContainText('Segunda parte');
  goal={...goal,status:'failed',revision:2,reason:'El proveedor falló.'};await page.waitForTimeout(700);await page.getByRole('button',{name:'Reintentar investigación',exact:true}).click();await expect.poll(()=>retry).toEqual({revision:2});await expect(page.getByText('Investigando',{exact:true}).first()).toBeVisible();
});

test('objective and incorporation remain within the viewport on desktop, tablet and mobile', async ({page}, testInfo) => {
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const state={schemaVersion:1,revision:1,settings,projects:[project],tasks:[],executions:[],goals:[goalBase]};
  await page.route('**/api/**',r=>r.fulfill({json:{csrfToken:'s',state,accounts:[],dataDir:'C:/Salem'}}));
  for(const [width,height] of [[1440,900],[820,1180],[390,844]]){
    await page.setViewportSize({width:width!,height:height!});await page.goto('/');await page.getByRole('button',{name:'Objetivos',exact:true}).click();await page.getByRole('button',{name:'Ver plan',exact:true}).click();
    await expect(page.getByRole('button',{name:'Ajustes',exact:true})).toBeInViewport({ratio:1});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:testInfo.outputPath(`objetivos-${width}.png`),fullPage:true});
    await page.getByRole('button',{name:'Proyectos',exact:true}).click();await page.getByRole('button',{name:'Incorporar proyecto',exact:true}).click();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }expect(errors).toEqual([]);
});
