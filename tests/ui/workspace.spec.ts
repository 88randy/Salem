import {test,expect,type Page} from '@playwright/test';

const settings={revision:1,commands:{claude:['claude'],codex:['codex']},maxConcurrentRuns:1,refreshIntervalMs:1000,preferredPort:3210};
const project={id:'p',revision:1,name:'Demo local',archived:false,createdAt:1,updatedAt:1,baseRef:'HEAD',preparation:[],config:{schemaVersion:1,projectId:'demo',repoRoot:'C:/demo',contextFiles:[],agents:{thinker:{provider:'claude',command:['claude'],model:'claude-opus-5-5',effort:'medium'},builder:{provider:'codex',command:['codex']}},supervisor:{roles:{define:'thinker',build:'builder',review:'thinker'}},checks:[],capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:60000,maxOutputBytes:10000}}};
const execution={id:'e',revision:1,taskId:'t',projectId:'p',requestKey:'req',createdAt:1,updatedAt:2,finishedAt:2,status:'completed',reason:null,project,task:{id:'BUG-SUM',objective:'Corregir la suma',scope:['sum.mjs'],acceptance:['Suma correcta'],references:[]},workspace:'C:/isolated',sourceSha:'a'.repeat(40),runId:'run',stateDir:'C:/Salem/runs/e',setupMs:20,preparationLogs:[]};

async function fixture(page:Page,{loseFirst=false,executions=[] as any[],initialGoals=[] as any[],evolutions=[] as any[]}={}){
 const requests:any[]=[];let goals:any[]=initialGoals;
 const state=()=>({schemaVersion:1,revision:1,settings,projects:[project],tasks:[],executions,goals,evolutions});
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path==='/api/bootstrap')return r.fulfill({json:{csrfToken:'csrf',state:state(),accounts:[],dataDir:'C:/Salem'}});
  if(path==='/api/state')return r.fulfill({json:{state:state(),accounts:[],dataDir:'C:/Salem'}});
  if(path==='/api/goals'){
   expect(r.request().headers()['x-salem-csrf']).toBe('csrf');requests.push(r.request().postDataJSON());
   if(loseFirst&&requests.length===1)return r.abort('connectionfailed');
   goals=[{...requests.at(-1),id:'goal',revision:1,project,status:'queued',sourceSha:null,createdAt:1,answers:[],attempts:[],plan:null,createdTaskId:null}];
   return r.fulfill({json:goals[0]});
  }
  if(path==='/api/executions/e')return r.fulfill({json:{execution:executions.find(e=>e.id==='e')||execution,run:null,metrics:null,diff:'',artifacts:[]}});
  return r.fulfill({status:404,json:{error:path}});
 });return requests;
}

test('home investigates a natural objective with the project role and opens its durable record',async({page})=>{
 const requests=await fixture(page);await page.goto('/');
 await page.getByLabel('Qué quieres lograr',{exact:true}).fill('Encuentra la causa del error de la suma');
 await page.getByRole('button',{name:'Investigar objetivo',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Encuentra la causa del error de la suma',exact:true})).toBeVisible();
 expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({projectId:'p',agentId:'thinker',objective:'Encuentra la causa del error de la suma'});
 await expect(page.getByRole('button',{name:'Cancelar investigación',exact:true})).toBeVisible();
});

test('home keeps its draft and request key if starting research loses the response',async({page})=>{
 const requests=await fixture(page,{loseFirst:true});await page.goto('/');
 await page.getByLabel('Qué quieres lograr',{exact:true}).fill('Revisar el cálculo');await page.getByRole('button',{name:'Investigar objetivo',exact:true}).click();
 await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByLabel('Qué quieres lograr',{exact:true})).toHaveValue('Revisar el cálculo');
 await page.getByRole('button',{name:'Investigar objetivo',exact:true}).click();await expect.poll(()=>requests.length).toBe(2);expect(requests[1].requestKey).toBe(requests[0].requestKey);
 await expect(page.getByRole('heading',{name:'Revisar el cálculo',exact:true})).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});

test('leaving home during research startup does not pull the user back when its response arrives',async({page})=>{
 await fixture(page);let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),received=new Promise<void>(r=>entered=r);
 await page.route('**/api/goals',async r=>{entered();await gate;return r.fulfill({json:{id:'goal',projectId:'p',agentId:'thinker',objective:'Revisar suma',project,status:'queued',createdAt:1,answers:[],attempts:[]}});});
 await page.goto('/');await page.getByLabel('Qué quieres lograr',{exact:true}).fill('Revisar suma');await page.getByRole('button',{name:'Investigar objetivo',exact:true}).click();await received;
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Proyectos',exact:true}).click();await expect(page.getByRole('heading',{name:'Proyectos',exact:true})).toBeVisible();
 const response=page.waitForResponse(r=>r.url().endsWith('/api/goals'));release();await (await response).finished();await page.waitForTimeout(500);
 await expect(page.getByRole('heading',{name:'Proyectos',exact:true})).toBeVisible();
});

test('a delayed state refresh after starting research does not override later navigation',async({page})=>{
 const requests=await fixture(page);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),received=new Promise<void>(r=>entered=r);
 await page.route('**/api/state',async r=>{if(requests.length){entered();await gate;}return r.fallback();});
 await page.goto('/');await page.getByLabel('Qué quieres lograr',{exact:true}).fill('Revisar cálculo');await page.getByRole('button',{name:'Investigar objetivo',exact:true}).click();await received;
 page.on('dialog',d=>d.accept());await page.getByRole('button',{name:'Proyectos',exact:true}).click();await expect(page.getByRole('heading',{name:'Proyectos',exact:true})).toBeVisible();
 const response=page.waitForResponse(r=>r.url().endsWith('/api/state'));release();await (await response).finished();await page.waitForTimeout(500);await expect(page.getByRole('heading',{name:'Proyectos',exact:true})).toBeVisible();
});

test('long generated objectives show a readable preview while keeping their complete text available',async({page})=>{
 const text='Corregir suma. '+('Plan de investigación y evidencia del repositorio. '.repeat(40));await fixture(page,{executions:[{...execution,task:{...execution.task,objective:text}}]});await page.goto('/');
 await page.getByRole('button',{name:'Ejecuciones',exact:true}).click();await page.getByRole('button',{name:'Ver ejecución',exact:true}).click();
 const objective=page.locator('.execution-feed .objective-text');await expect(objective.getByText('Ver objetivo completo',{exact:true})).toBeVisible();await expect(objective.locator('.objective-full')).not.toBeVisible();
 await objective.getByText('Ver objetivo completo',{exact:true}).click();await expect(objective.locator('.objective-full')).toBeVisible();await expect(objective.locator('.objective-full')).toHaveText(text);
});

test('search opens real history and execution context does not turn completed into accepted',async({page})=>{
 await fixture(page,{executions:[execution]});await page.goto('/');await page.getByRole('button',{name:'Buscar',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Buscar en Salem'});await dialog.getByRole('searchbox').fill('suma');
 await dialog.getByRole('button',{name:/BUG-SUM/}).click();await expect(page.getByRole('heading',{name:'BUG-SUM',exact:true})).toBeVisible();
 await expect(page.getByRole('complementary',{name:'Contexto de la ejecución'})).toContainText('Sin aceptación registrada');
 await expect(page.getByText('C:/isolated',{exact:true})).toBeVisible();
});

test('activity distinguishes failures and can open the associated work',async({page})=>{
 await fixture(page,{executions:[{...execution,status:'failed',reason:'Límite de uso del proveedor'}]});await page.goto('/');
 await page.getByRole('button',{name:'Ver actividad',exact:true}).click();const activity=page.getByRole('dialog',{name:'Actividad de Salem'});
 await expect(activity).toContainText('Fallida');await expect(activity).toContainText('Límite de uso del proveedor');await activity.getByRole('button',{name:/BUG-SUM/}).click();
 await expect(activity).not.toBeVisible();await expect(page.getByRole('heading',{name:'BUG-SUM',exact:true})).toBeVisible();
});

test('activity includes research and improvement work and search opens the exact objective',async({page})=>{
 const goal={id:'g',projectId:'p',agentId:'thinker',objective:'Investigar regresión',project,status:'investigating',createdAt:2,answers:[],attempts:[],plan:null};
 const evolution={id:'v',projectId:'p',task:{id:'FIX-1',objective:'Reparar regresión'},project,status:'checking',createdAt:3};
 await fixture(page,{initialGoals:[goal],evolutions:[evolution]});await page.goto('/');await page.getByRole('button',{name:'Ver actividad',exact:true}).click();
 const activity=page.getByRole('dialog',{name:'Actividad de Salem'});await expect(activity).toContainText('Investigar regresión');await expect(activity).toContainText('Probando candidata');
 await activity.getByRole('button',{name:'Cerrar diálogo',exact:true}).click();await page.getByRole('button',{name:'Buscar',exact:true}).click();const search=page.getByRole('dialog',{name:'Buscar en Salem'});
 await search.getByRole('searchbox').fill('Investigar regresión');await search.getByRole('button',{name:/Investigar regresión/}).click();
 await expect(page.getByRole('heading',{name:'Investigar regresión',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Cancelar investigación',exact:true})).toBeVisible();
});

test('appearance persists independently of the server configuration and mobile has no overflow',async({page})=>{
 await fixture(page);await page.goto('/');await page.getByRole('button',{name:'Ajustes',exact:true}).click();await page.getByLabel('Tema de la interfaz',{exact:true}).selectOption('dark');
 await page.reload();await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
 await page.getByRole('button',{name:'Ajustes',exact:true}).click();await expect(page.getByLabel('Puerto preferido al reiniciar')).toHaveValue('3210');
 await page.getByLabel('Tema de la interfaz',{exact:true}).selectOption('light');
 for(const [width,height] of [[1366,900],[768,1024],[390,844]]){
  await page.setViewportSize({width:width!,height:height!});await page.getByRole('button',{name:'Inicio',exact:true}).click();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width!);
 }
});

test('dark theme keeps form surfaces dark and the data directory readable',async({page})=>{
 await fixture(page);await page.goto('/');await page.getByRole('button',{name:'Ajustes',exact:true}).click();await page.getByLabel('Tema de la interfaz',{exact:true}).selectOption('dark');
 const colors=await page.locator('.data-location code').evaluate(e=>({text:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor}));
 const luminance=(color:string)=>{const c=(color.match(/\d+/g)||[]).slice(0,3).map(Number).map(v=>{const n=v/255;return n<=.04045?n/12.92:((n+.055)/1.055)**2.4;});return .2126*c[0]!+.7152*c[1]!+.0722*c[2]!;};
 const values=[luminance(colors.text),luminance(colors.background)].sort((a,b)=>b-a);expect((values[0]!+.05)/(values[1]!+.05)).toBeGreaterThanOrEqual(4.5);
 const background=await page.getByLabel('Puerto preferido al reiniciar').evaluate(e=>getComputedStyle(e).backgroundColor);expect(luminance(background)).toBeLessThan(.2);
});

test('collapsed navigation keeps the new work action named and keyboard accessible',async({page})=>{
 await fixture(page);await page.goto('/');await page.getByRole('button',{name:'Contraer navegación',exact:true}).click();
 const action=page.getByRole('button',{name:'Nuevo trabajo',exact:true});await expect(action).toBeVisible();await action.focus();await expect(action).toBeFocused();
});
