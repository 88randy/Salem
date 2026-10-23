import {useEffect,useRef,useState} from 'react';
import {ArrowUp,Check,ChevronDown,FileText,Paperclip,Square,X} from 'lucide-react';
import type {ChatReference,ConversationRecord} from '../../src/local/conversation-contracts';
import type {LocalState} from '../../src/local/contracts';
import {api,download} from './api';
import {shortObjective} from './objective-text';
import './conversation.css';

export const chatStatus:Record<ConversationRecord['status'],string>={planning:'Investigando',needs_input:'Necesita tu respuesta',working:'Trabajando',paused:'En pausa',blocked:'Necesita atención',completed:'Completado',answered:'Respuesta lista'};
function initialDraft(id:string):{text:string;references:ChatReference[]}{try{const r=JSON.parse(sessionStorage.getItem(`salem.chat.draft.${id}`)??'null');if(r&&typeof r.text==='string'&&Array.isArray(r.references))return r;}catch{}return {text:'',references:[]};}
function pendingRequest(id:string):{signature:string;key:string}{try{const r=JSON.parse(sessionStorage.getItem(`salem.chat.draft.${id}`)??'null')?.pending;if(r&&typeof r.signature==='string'&&typeof r.key==='string'&&r.key.length<=120)return r;}catch{}return {signature:'',key:''};}
function InlineText({text}:{text:string}){return <>{text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^\s)]+\))/g).map((part,i)=>part.startsWith('**')?<strong key={i}>{part.slice(2,-2)}</strong>:part.startsWith('`')?<code key={i}>{part.slice(1,-1)}</code>:part.startsWith('[')&&/^\[[^\]]+\]\(https?:\/\//.test(part)?<a key={i} href={part.slice(part.indexOf('](')+2,-1)} target="_blank" rel="noreferrer">{part.slice(1,part.indexOf(']('))}</a>:part)}</>;}
function MessageText({text}:{text:string}){return <>{text.split(/(```[\s\S]*?```)/g).map((part,i)=>part.startsWith('```')?<pre key={i}><code>{part.replace(/^```[^\n]*\n?/,'').replace(/```$/,'')}</code></pre>:<div key={i} className="chat-prose">{part.split('\n').map((line,at)=>/^#{1,4} /.test(line)?<strong className="chat-prose-title" key={at}><InlineText text={line.replace(/^#{1,4} /,'')}/></strong>:<div key={at}><InlineText text={line||'\u00a0'}/></div>)}</div>)}</>;}

export function ConversationPage({conversation:c,state,onChanged,onExecution,onBack}:{conversation:ConversationRecord;state:LocalState;onChanged:()=>Promise<void>;onExecution:(id:string)=>void;onBack:()=>void}){
 const [draft,setDraft]=useState(()=>initialDraft(c.id));const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [panel,setPanel]=useState(false);
 const request=useRef(pendingRequest(c.id));const actions=useRef(new Map<string,string>());const end=useRef<HTMLDivElement>(null);const log=useRef<HTMLDivElement>(null);const nearEnd=useRef(true);const [unread,setUnread]=useState(false);const mounted=useRef(true);
 const running=c.status==='working'||c.status==='planning';const steps=c.steps.filter(s=>s.key.startsWith(c.goalId+':'));const accepted=steps.filter(s=>s.status==='accepted').length;
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
 useEffect(()=>{try{sessionStorage.setItem(`salem.chat.draft.${c.id}`,JSON.stringify({...draft,pending:request.current.key?request.current:undefined}));}catch{}},[draft,c.id]);
 useEffect(()=>{if(nearEnd.current)end.current?.scrollIntoView({block:'nearest'});else setUnread(true);},[c.messages.length]);
 useEffect(()=>{actions.current.clear();},[c.status]);
 async function send(){
  if(!draft.text.trim()||busy)return;
  const input={text:draft.text.trim(),references:draft.references},signature=JSON.stringify(input);if(request.current.signature!==signature)request.current={signature,key:crypto.randomUUID()};
  setBusy(true);setError('');
  try{
   // Persist before sending so a lost response followed by remount uses the
   // same command identity. Storage failure must not submit an untracked command.
   try{sessionStorage.setItem(`salem.chat.draft.${c.id}`,JSON.stringify({...draft,pending:request.current}));}catch{throw Error('No se pudo conservar la identidad del mensaje en esta pestaña. No se envió; tu borrador se conserva.');}
   await api(`/conversations/${c.id}/message`,{...input,revision:c.revision,requestKey:request.current.key});
   // A reopened chat owns its own draft. An old, unmounted request cannot
   // acknowledge or remove storage that the new instance may have edited.
   if(!mounted.current)return;
   request.current={signature:'',key:''};sessionStorage.removeItem(`salem.chat.draft.${c.id}`);
   setDraft({text:'',references:[]});nearEnd.current=true;await onChanged();
  }
  catch(e){if(mounted.current)setError(e instanceof TypeError?'No se confirmó el envío. Tu mensaje se conserva; vuelve a enviarlo para reconciliarlo sin duplicarlo.':e instanceof Error?e.message:'No se pudo enviar. Tu mensaje se conserva.');}
  finally{if(mounted.current)setBusy(false);}
 }
 async function action(kind:'pause'|'continue'|'retry'){
  if(busy)return;setBusy(true);setError('');const key=actions.current.get(kind)??crypto.randomUUID();actions.current.set(kind,key);
  try{await api(`/conversations/${c.id}/${kind}`,{revision:c.revision,requestKey:key});if(mounted.current)await onChanged();}catch(e){if(mounted.current)setError((e as Error).message);}finally{if(mounted.current)setBusy(false);}
 }
 async function attach(files:FileList|null){
  if(!files)return;setError('');try{const added:ChatReference[]=[];for(const file of files){if(file.size>160000)throw Error(`${file.name}: adjunta un extracto de hasta 40.000 caracteres.`);const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(text.length>40000||text.includes('\0'))throw Error(`${file.name}: usa un archivo de texto de hasta 40.000 caracteres.`);added.push({name:file.name,text});}
   setDraft(previous=>{const refs=[...previous.references,...added];if(refs.length>8||refs.reduce((n,r)=>n+r.text.length,0)>100000){setError('Adjunta hasta ocho referencias y un total de 100.000 caracteres.');return previous;}return {...previous,references:refs};});
  }catch(e){setError((e as Error).message);}
 }
 const scrollEnd=()=>{nearEnd.current=true;setUnread(false);end.current?.scrollIntoView({block:'nearest',behavior:'smooth'});};
 return <section className={`chat-page ${panel?'with-plan':''}`} aria-label="Trabajo con Salem">
  <header className="chat-header"><div><button className="quiet small" onClick={onBack}>Tu trabajo</button><h1 title={c.objective}>{shortObjective(c.objective,95)}</h1><p>{c.project.name} <span className={`status ${c.status}`}>{chatStatus[c.status]}</span></p></div><button className="quiet small" aria-label="Ver plan y resultados" aria-expanded={panel} onClick={()=>setPanel(!panel)}><FileText size={16}/><span>Plan y resultados</span></button></header>
  <div className="chat-center"><div className="chat-transcript" role="log" aria-label="Conversación con Salem" aria-live="polite" aria-relevant="additions" ref={log} onScroll={()=>{const el=log.current;if(el){nearEnd.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;if(nearEnd.current)setUnread(false);}}}>
   {c.messages.map(m=><article key={m.id} className={`chat-message ${m.role}`}><div className="chat-message-heading"><strong>{m.role==='user'?'Tú':'Salem'}</strong><time dateTime={new Date(m.at).toISOString()}>{new Date(m.at).toLocaleTimeString('es-MX',{hour:'2-digit',minute:'2-digit'})}</time></div><MessageText text={m.text}/>{m.references?.length&&<div className="chat-references">{m.references.map((r,i)=><details key={i}><summary><Paperclip size={13}/>{r.name}</summary><pre>{r.text}</pre></details>)}</div>}{m.source?.kind==='execution'&&<button className="quiet small chat-evidence" onClick={()=>onExecution(m.source!.id)}>Ver cambios y comprobaciones</button>}</article>)}
   {running&&<p className="chat-working" role="status"><span className="state-dot running"/>{c.status==='planning'?'Salem está investigando el proyecto…':`${accepted} de ${steps.length} pasos aceptados. Salem sigue trabajando…`}</p>}
   <div ref={end}/>
  </div>{unread&&<button className="chat-new-message small" onClick={scrollEnd}><ChevronDown size={15}/>Nuevo avance</button>}
  <div className="chat-compose-area">
   {c.reason&&<p className="chat-state-reason">{c.reason}</p>}
   <div className="chat-work-controls">{running?<button className="quiet small" disabled={busy} aria-label="Detener trabajo" onClick={()=>void action('pause')}><Square size={12}/>Detener</button>:['paused','blocked'].includes(c.status)?<><button className="small" disabled={busy} onClick={()=>void action('continue')}>Continuar trabajo</button>{c.status==='blocked'&&<button className="quiet small" disabled={busy} onClick={()=>void action('retry')}>Reintentar paso en copia nueva</button>}</>:null}<span>{c.status==='needs_input'?'Responde aquí para que Salem pueda continuar.':running?'Puedes precisar el objetivo mientras Salem trabaja.':'Puedes pedir ajustes o continuar con otro cambio.'}</span></div>
   <form className="chat-composer" onSubmit={e=>{e.preventDefault();void send();}}>{draft.references.length>0&&<div className="chat-attached">{draft.references.map((r,i)=><span key={i}><Paperclip size={13}/>{r.name}<button type="button" className="icon-button" aria-label={`Quitar referencia ${r.name}`} onClick={()=>setDraft({...draft,references:draft.references.filter((_,at)=>at!==i)})}><X size={12}/></button></span>)}</div>}<label className="sr-only" htmlFor="chat-input">Mensaje para Salem</label><textarea id="chat-input" placeholder={c.status==='needs_input'?'Responde a Salem…':'Dile a Salem qué necesitas…'} value={draft.text} disabled={busy} onChange={e=>setDraft({...draft,text:e.target.value})} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/><div className="chat-composer-bottom"><label className="chat-attach" title="Adjuntar archivos de texto"><Paperclip size={17}/><span>Referencia</span><input type="file" multiple accept=".txt,.md,.json,.js,.mjs,.ts,.tsx,.py,.csv,.yaml,.yml,.html,.css" aria-label="Adjuntar referencias de texto" disabled={busy} onChange={e=>{void attach(e.target.files);e.target.value='';}}/></label><span className="chat-local-note">Tus cuentas · copia local aislada</span><button className="primary chat-send" type="submit" disabled={busy||!draft.text.trim()} aria-label="Enviar mensaje"><ArrowUp size={17}/></button></div></form>
   {error&&<p className="error chat-error" role="alert">{error}</p>}<p className="chat-composer-hint">Enter envía · Mayús + Enter agrega una línea. Cambiar instrucciones detiene el paso en curso y prepara un nuevo plan.</p>
  </div></div>
  {panel&&<aside className="chat-plan" aria-label="Plan y resultados"><div className="section-heading"><h2>Plan y resultados</h2><button className="icon-button" aria-label="Cerrar plan" onClick={()=>setPanel(false)}><X size={16}/></button></div><p>Revisión {c.planRevision||'en preparación'}</p>{steps.length?<ol>{steps.map(step=>{const a=c.project.config.agents[step.planTask.agentId];return <li key={step.key}><div className="chat-step-heading">{step.status==='accepted'?<Check size={15}/>:<span className={`state-dot ${step.status==='running'?'running':''}`}/>}<strong>{step.planTask.title}</strong></div><small>{a?.provider==='claude'?'Claude':'Codex'} · {a?.model||'Predeterminado del CLI'}{a?.effort?` · ${a.effort}`:''}</small><span className="chat-step-status">{({pending:'Pendiente',running:'En curso',accepted:'Aceptado',blocked:'Necesita atención'})[step.status]}</span>{step.planTask.dependsOn.length>0&&<small>Después de: {step.planTask.dependsOn.join(', ')}</small>}{step.executionId&&<button className="quiet small" onClick={()=>onExecution(step.executionId!)}>Ver evidencia</button>}</li>;})}</ol>:<p className="muted">Los pasos aparecerán después de investigar el proyecto y resolver las preguntas pendientes.</p>}<p className="muted">Cada paso pasa por implementación, checks y revisión independiente. La última tarea comprueba el objetivo conjunto.</p><p className="muted">El código se conserva localmente. Esta conversación no publica cambios.</p><button className="small" onClick={()=>download(`salem-conversacion-${c.id}.json`,c)}>Exportar conversación</button>{state.executions.some(e=>e.id===c.lastAcceptedExecutionId)&&<button className="small" onClick={()=>onExecution(c.lastAcceptedExecutionId!)}>Revisar resultado aceptado</button>}</aside>}
 </section>;
}
