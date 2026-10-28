import {useEffect,useState} from 'react';
import type {Provider} from '../../src/local/contracts';
import type {DemoPlan,DemoProviderEstimate} from '../../src/local/demo-estimate';
import {api} from './api';
import {Modal,Select} from './fields';

const name=(p:Provider)=>p==='claude'?'Claude':'Codex';
const stageNames={define:'define',build:'implementa',review:'revisa'} as const;
const list=(items:string[])=>items.length>1?`${items.slice(0,-1).join(', ')} y ${items.at(-1)}`:items[0]??'';
const tokens=(n:number)=>n.toLocaleString('es-MX');
const seconds=(ms:number)=>Math.round(ms/1000);
function Estimate({e}:{e:DemoProviderEstimate}){const r=e.reference;
 return <section className="notice" aria-label={`Consumo de ${name(e.provider)}`}><h3>{name(e.provider)} {list(e.stages.map(s=>stageNames[s]))}</h3>{!r?<p>Consumo desconocido: aún no hay una medición de referencia para {name(e.provider)} en esta demo.</p>:<><dl className="facts"><dt>Tokens esperados</dt><dd>{tokens(r.tokens.min)}–{tokens(r.tokens.max)} tokens</dd><dt>Duración esperada</dt><dd>{seconds(r.wallMs.min)}–{seconds(r.wallMs.max)} s</dd></dl><small>Medido el {r.measuredAt} con {r.model}{r.effort?` · ${r.effort}`:''} en {r.runs} {r.runs===1?'ejecución':'ejecuciones'} (Salem {r.salemVersion}).</small>{!e.matchesReference&&<p><small>Medido con {r.model}{r.effort?` · ${r.effort}`:''}; tu consumo puede variar porque tu modelo o esfuerzo es distinto ({e.model||'predeterminado del CLI'}{e.effort?` · ${e.effort}`:''}).</small></p>}</>}</section>;}
export function DemoDialog({onClose,onCreated,onAccounts}:{onClose:()=>void;onCreated:()=>Promise<void>;onAccounts:()=>void}){
 const [provider,setProvider]=useState<Provider|undefined>();const [plan,setPlan]=useState<DemoPlan|null>(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
 useEffect(()=>{let alive=true;setPlan(null);setError('');api<DemoPlan>('/projects/demo/plan',provider?{provider}:{}).then(p=>{if(alive)setPlan(p);}).catch(e=>{if(alive)setError(e instanceof Error?e.message:'No se pudo preparar la demo.');});return()=>{alive=false;};},[provider]);
 async function confirm(){if(!plan)return;setBusy(true);setError('');try{await api('/projects/demo',{provider:plan.selected,roles:plan.roles});await onCreated();}catch(e){setError(e instanceof Error?e.message:'No se pudo crear la demo.');setBusy(false);}}
 return <Modal title="Crear demo local" onClose={onClose}><div className="dialog-body">
  {!plan&&!error&&<p className="muted">Comprobando las cuentas conectadas…</p>}
  {plan&&(plan.crossProvider?<><p>La demo usa las cuotas de Claude y Codex: {name(plan.roles.build)} define e implementa, y {name(plan.roles.review)} revisa en una sesión independiente.</p><Select label="Proveedor que implementa" value={plan.roles.build} onChange={v=>setProvider(v as Provider)} options={[{value:'codex',label:'Codex'},{value:'claude',label:'Claude'}]}/></>:<>{plan.fallback&&<p>{name(plan.selected)} no está listo; {name(plan.roles.build)} realizará todos los pasos.</p>}<p>La demo usa solo la cuota de {name(plan.roles.build)}: {name(plan.roles.build)} define, implementa y revisa en sesiones independientes.</p></>)}
  {plan&&plan.estimates.map(e=><Estimate key={e.provider} e={e}/>)}
  {plan&&<p className="muted"><small>El consumo real depende de tu cuenta y del estado del proveedor. Nada se crea ni se consume hasta que confirmes.</small></p>}
  {error&&<p role="alert" className="error">{error}</p>}
  <div className="actions">{plan&&<button className="primary" disabled={busy} onClick={()=>void confirm()}>Confirmar y crear demo</button>}{!plan&&error&&<button className="primary" onClick={onAccounts}>Ir a Cuentas</button>}<button disabled={busy} onClick={onClose}>Cancelar</button></div>
 </div></Modal>;
}
