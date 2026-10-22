import {test,expect} from '@playwright/test';
test('automatic application is explicit, shows post-application checks and reverts using the current revision',async({page})=>{
 const project={id:'p',name:'Demo',archived:false,config:{agents:{codex:{provider:'codex'}},supervisor:{roles:{define:'codex'}}}},task={id:'t',projectId:'p',archived:false,spec:{id:'BUG',acceptance:['Suma correcta']}};
 let submitted:any,rollback:any;let experiments:any[]=[];
 const state=()=>({schemaVersion:1,revision:1,settings:{refreshIntervalMs:500},projects:[project],tasks:[task],executions:[],evolutions:experiments});
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/bootstrap')return route.fulfill({json:{csrfToken:'csrf',state:state(),accounts:[],dataDir:'C:/Salem'}});
  if(path==='/api/state')return route.fulfill({json:{state:state(),accounts:[],dataDir:'C:/Salem'}});
  if(path==='/api/evolution/incidents')return route.fulfill({json:[]});
  if(path==='/api/evolution'){submitted=route.request().postDataJSON();experiments=[{id:'e',revision:7,task:task.spec,project,agentId:'codex',status:'improved',sourceSha:'a'.repeat(40),policyHash:'policy',createdAt:1,baseline:[],candidateChecks:[],promotion:{status:'applied',reason:'Mejora aplicada con respaldo.',entries:[{path:'sum.mjs'}],checks:[{checkId:'sum',status:'passed',exitCode:0}],createdAt:1,updatedAt:1}}];return route.fulfill({json:experiments[0]});}
  if(path==='/api/evolution/e/rollback'){rollback=route.request().postDataJSON();experiments=[{...experiments[0],revision:8,promotion:{...experiments[0].promotion,status:'rolled_back',reason:'Respaldo original restaurado.'}}];return route.fulfill({json:experiments[0]});}
  return route.fulfill({status:404,json:{error:path}});
 });
 await page.goto('/');await page.getByRole('button',{name:'Evolución',exact:true}).click();await page.getByLabel('Tarea de referencia').selectOption('t');
 await expect(page.getByLabel('Aplicar al superar las pruebas')).toBeChecked();await page.getByRole('button',{name:'Investigar y probar mejora',exact:true}).click();await expect.poll(()=>submitted?.applyOnSuccess).toBe(true);
 await expect(page.getByRole('heading',{name:'Aplicación local',exact:true})).toBeVisible();await expect(page.getByText('sum · Pasa · salida 0',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Revertir mejora',exact:true}).click();await expect.poll(()=>rollback?.revision).toBe(7);await expect(page.getByText('Respaldo original restaurado.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Revertir mejora',exact:true})).toHaveCount(0);
 for(const [width,height] of [[1366,900],[768,1024],[390,844]]){await page.setViewportSize({width:width!,height:height!});expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width!);}
});
