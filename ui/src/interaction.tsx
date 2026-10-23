import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
export type RecordAction={label:string;run:()=>void;disabled?:boolean};

/** Menus delegate to the same actions as the visible controls. */
export function RecordInteractions({projectActions,executionActions}:{projectActions:(id:string)=>RecordAction[];executionActions:(id:string)=>RecordAction[]}){
 const [menu,setMenu]=useState<{x:number;y:number;label:string;actions:RecordAction[];anchor:HTMLElement}|null>(null);
 const [tip,setTip]=useState<{text:string;x:number;y:number}|null>(null);const ref=useRef<HTMLDivElement>(null);
 const close=()=>{setMenu(null);menu?.anchor.focus();};
 useEffect(()=>{
  const open=(event:Event)=>{
   const target=event.target as HTMLElement;
   const record=target.closest<HTMLElement>('[data-project-actions],[data-execution-actions],.list-row');if(!record)return;
   let actions:RecordAction[]=[],label='registro';
   if(record.dataset.projectActions){actions=projectActions(record.dataset.projectActions);label=record.dataset.recordName||'proyecto';}
   else if(record.dataset.executionActions){actions=executionActions(record.dataset.executionActions);label=record.dataset.recordName||'trabajo';}
   else{label=record.querySelector('h2')?.textContent||'registro';actions=Array.from(record.querySelectorAll<HTMLButtonElement>('.actions button')).map(button=>({label:button.getAttribute('aria-label')||button.textContent||'Abrir',disabled:button.disabled,run:()=>button.click()}));}
   if(!actions.length)return;
   event.preventDefault();const mouse=event as MouseEvent,box=record.getBoundingClientRect();
   setTip(null);setMenu({x:mouse.clientX||box.left+20,y:mouse.clientY||box.top+30,label,actions,anchor:target.closest<HTMLElement>('button')||record});
  };
  const keyboard=(event:KeyboardEvent)=>{if(event.key==='ContextMenu'||event.key==='F10'&&event.shiftKey)open(event);};
  const click=(event:MouseEvent)=>{const more=(event.target as HTMLElement).closest<HTMLElement>('[data-record-menu]');if(more)open(event);};
  const tooltip=(event:Event)=>{const el=(event.target as HTMLElement).closest<HTMLElement>('button[aria-label],button[title]');if(!el||!el.querySelector('svg'))return;const text=el.getAttribute('title')||el.getAttribute('aria-label');if(!text)return;const box=el.getBoundingClientRect();setTip({text,x:Math.min(innerWidth-170,Math.max(8,box.left)),y:Math.min(innerHeight-50,box.bottom+7)});};
  const hide=()=>setTip(null);
  document.addEventListener('contextmenu',open);document.addEventListener('keydown',keyboard);document.addEventListener('click',click);document.addEventListener('pointerover',tooltip);document.addEventListener('focusin',tooltip);document.addEventListener('pointerout',hide);document.addEventListener('focusout',hide);window.addEventListener('scroll',hide,true);
  return()=>{document.removeEventListener('contextmenu',open);document.removeEventListener('keydown',keyboard);document.removeEventListener('click',click);document.removeEventListener('pointerover',tooltip);document.removeEventListener('focusin',tooltip);document.removeEventListener('pointerout',hide);document.removeEventListener('focusout',hide);window.removeEventListener('scroll',hide,true);};
 },[projectActions,executionActions]);
 useLayoutEffect(()=>{if(!menu||!ref.current)return;const box=ref.current.getBoundingClientRect();ref.current.style.left=`${Math.max(8,Math.min(menu.x,innerWidth-box.width-8))}px`;ref.current.style.top=`${Math.max(8,Math.min(menu.y,innerHeight-box.height-8))}px`;ref.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();},[menu]);
 useEffect(()=>{if(!menu)return;const outside=(e:PointerEvent)=>{if(!ref.current?.contains(e.target as Node))setMenu(null);};const scroll=()=>setMenu(null);document.addEventListener('pointerdown',outside);window.addEventListener('resize',scroll);window.addEventListener('scroll',scroll,true);return()=>{document.removeEventListener('pointerdown',outside);window.removeEventListener('resize',scroll);window.removeEventListener('scroll',scroll,true);};},[menu]);
 return createPortal(<>{menu&&<div ref={ref} className="record-menu" role="menu" aria-label={`Acciones de ${menu.label}`} style={{left:menu.x,top:menu.y}} onKeyDown={e=>{const items=Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')||[]),index=items.indexOf(document.activeElement as HTMLButtonElement);if(e.key==='Escape'||e.key==='Tab'){e.preventDefault();close();}else if(['ArrowDown','ArrowUp','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?0:e.key==='End'?items.length-1:(index+(e.key==='ArrowDown'?1:-1)+items.length)%items.length;items[next]?.focus();}}}>{menu.actions.map((a,i)=><button role="menuitem" key={i} disabled={a.disabled} onClick={()=>{close();a.run();}}>{a.label}</button>)}</div>}{tip&&!menu&&<div role="tooltip" className="salem-tooltip" style={{left:tip.x,top:tip.y}}>{tip.text}</div>}</>,document.body);
}
