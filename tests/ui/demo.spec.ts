import { test, expect, type Page } from '@playwright/test';
const settings={revision:1,commands:{claude:['claude'],codex:['codex']},maxConcurrentRuns:1,refreshIntervalMs:1000,preferredPort:3210};
const state={schemaVersion:1,revision:1,settings,projects:[],tasks:[],executions:[]};
const roles=(build:string,review:string)=>({define:build,build,review});
const estimate=(provider:string,stages:string[],reference:unknown=null,matchesReference=false)=>({provider,stages,model:provider==='claude'?'claude-opus-5-5':null,effort:provider==='claude'?'medium':null,reference,matchesReference});
async function mock(page:Page,plan:(provider:string|undefined)=>{status?:number;json:unknown}){
 const calls:{plan:any[];create:any[]}={plan:[],create:[]};
 await page.route('**/api/**',async r=>{const u=new URL(r.request().url());
  if(u.pathname==='/api/bootstrap')return r.fulfill({json:{csrfToken:'csrf',state,accounts:[],dataDir:'C:/Salem'}});
  if(u.pathname==='/api/state')return r.fulfill({json:{state,accounts:[],dataDir:'C:/Salem'}});
  if(u.pathname==='/api/projects/demo/plan'){const body=r.request().postDataJSON();calls.plan.push(body);const out=plan(body.provider);return r.fulfill({status:out.status??200,json:out.json});}
  if(u.pathname==='/api/projects/demo'){calls.create.push(r.request().postDataJSON());return r.fulfill({json:{project:{},task:{}}});}
  return r.fulfill({status:404,json:{error:'Ruta no prevista '+u.pathname}});});
 await page.goto('/');return calls;
}
test('cross-provider demo shows both quotas and creates nothing until confirmed',async({page})=>{
 const reference={model:'gpt-6.1-sol',effort:'medium',runs:2,tokens:{min:11000,max:17000},wallMs:{min:61000,max:93000},measuredAt:'2026-11-01',salemVersion:'0.5.1'};
 const calls=await mock(page,provider=>provider==='claude'?{json:{roles:roles('claude','codex'),selected:'claude',fallback:false,crossProvider:true,estimates:[estimate('claude',['define','build']),estimate('codex',['review'])]}}:{json:{roles:roles('codex','claude'),selected:'codex',fallback:false,crossProvider:true,estimates:[estimate('codex',['define','build'],reference,false),estimate('claude',['review'])]}});
 await page.getByRole('button',{name:'Crear demo local',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Crear demo local'});
 await expect(dialog).toContainText('usa las cuotas de Claude y Codex');
 await expect(dialog).toContainText('11,000–17,000 tokens');await expect(dialog).toContainText('61–93 s');
 await expect(dialog).toContainText('Medido el 2026-11-01 con gpt-6.1-sol · medium');await expect(dialog).toContainText('tu consumo puede variar');
 await expect(dialog.getByText('Consumo desconocido',{exact:false})).toHaveCount(1);
 await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();await expect(dialog).toHaveCount(0);expect(calls.create).toEqual([]);
 await page.getByRole('button',{name:'Crear demo local',exact:true}).click();
 await dialog.getByLabel('Proveedor que implementa',{exact:true}).selectOption('claude');
 await expect(dialog.getByText('Consumo desconocido',{exact:false})).toHaveCount(2);await expect(dialog).not.toContainText('tokens');
 await dialog.getByRole('button',{name:'Confirmar y crear demo',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Demo local creada');
 expect(calls.create).toEqual([{provider:'claude',roles:roles('claude','codex')}]);
});
test('single-provider demo explains the fallback and no provider points to Accounts',async({page})=>{
 let none=false;
 const calls=await mock(page,()=>none?{status:412,json:{error:'Ningún proveedor está listo para la demo. Conecta Claude o Codex en Cuentas y vuelve a intentarlo.'}}:{json:{roles:roles('claude','claude'),selected:'codex',fallback:true,crossProvider:false,estimates:[estimate('claude',['define','build','review'])]}});
 await page.getByRole('button',{name:'Crear demo local',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Crear demo local'});
 await expect(dialog).toContainText('Codex no está listo');await expect(dialog).toContainText('Claude define, implementa y revisa');
 await expect(dialog).toContainText('Consumo desconocido');await expect(dialog.getByLabel('Proveedor que implementa')).toHaveCount(0);
 await dialog.getByRole('button',{name:'Cancelar',exact:true}).click();
 none=true;await page.getByRole('button',{name:'Crear demo local',exact:true}).click();
 await expect(dialog.getByRole('alert')).toContainText('Cuentas');await expect(dialog.getByRole('button',{name:'Confirmar y crear demo'})).toHaveCount(0);
 await dialog.getByRole('button',{name:'Ir a Cuentas',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Cuentas',exact:true})).toBeVisible();expect(calls.create).toEqual([]);
});
