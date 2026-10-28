// Simulated provider for the cart quickstart: it asks for the shipping policy, plans three dependent tasks
// and builds each one from the reference solution. It never runs inference.
import {writeFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const [provider,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log(provider+' cart-fixture-1');process.exit(0);}
if(args.includes('--help')){console.log('--json --output-schema --output-last-message --sandbox --cd --ignore-user-config --json-schema --output-format --tools --allowedTools --setting-sources --strict-mcp-config --mcp-config --settings');process.exit(0);}
if(args.includes('status')){console.log(provider==='claude'?JSON.stringify({loggedIn:true}):'Logged in using test account');process.exit(0);}
// --fixture-api-only simulates a weak plan: every criterion maps to the api check and total ignores all but the first item.
const apiOnly=args.includes('--fixture-api-only');
let input='';for await(const chunk of process.stdin)input+=chunk;
const reference=readFileSync(new URL('./cart-reference.mjs',import.meta.url),'utf8').split(/\r?\n/);
const lines=()=>readFileSync('cart.mjs','utf8').split(/\r?\n/);
const implement=(name,line=reference.find(l=>l.startsWith(`export function ${name}(`)))=>writeFileSync('cart.mjs',lines().map(l=>l.startsWith(`export function ${name}(`)?line:l).join('\n'));
let payload;
if(input.includes('GOAL_JSON=')){
 const request=JSON.parse(input.match(/GOAL_JSON=(.+)/)[1]),free=/siempre es gratis/i.test(request.objective),answered=free||/\$999/.test(request.objective);
 const policy=free?'Envío siempre gratis':'Envío de $99 bajo $999 de subtotal, gratis desde $999 y en carritos vacíos';
 const node=(id,title,dependsOn=[])=>({id,title,dependsOn,objective:`${title}. ${policy}.`,scope:['cart.mjs'],acceptance:[`${title} con la API conservada`],checkIds:apiOnly?['api']:['api',id],agentId:provider});
 payload={schemaVersion:1,verdict:answered?'ready':'needs_input',summary:'Revisé cart.mjs y sus verificadores; prepararé tres pasos dependientes.',facts:[{description:'cart.mjs exporta subtotal, shipping y total sin implementar.',files:['cart.mjs']}],assumptions:[],decisions:['Los importes se manejan en centavos enteros.'],questions:answered?[]:['¿Qué política de envío aplico? Indica el costo, si hay envío gratis a partir de cierto subtotal y qué pasa con un carrito vacío.'],steps:[{title:'Carrito',description:'Subtotal, envío y total',files:['cart.mjs']}],task:{objective:`Carrito con subtotal, envío y total. ${policy}.`,scope:['cart.mjs'],acceptance:['El total combina subtotal y envío'],references:['AGENTS.md','cart.mjs'],checkIds:apiOnly?['api']:['api','subtotal','shipping','total']},proposedChecks:[],work:{tasks:[node('subtotal','Calcular el subtotal'),node('shipping','Aplicar la política de envío',['subtotal']),node('total','Calcular el total',['shipping'])]}};
}else{
 const task=JSON.parse(input.match(/TASK_JSON=(.+)/)[1]);
 if(task.stage==='build'){
  if(task.id.endsWith('-subtotal'))implement('subtotal');
  else if(task.id.endsWith('-shipping'))implement('shipping',/siempre gratis/i.test(task.objective)?'export function shipping(subtotalCents){return 0;}':undefined);
  else if(task.id.endsWith('-total')){if(lines().some(l=>/pendiente/.test(l)&&!l.includes('function total(')))throw Error('Missing predecessor code');implement('total',apiOnly?'export function total(items){const amount=subtotal(items.slice(0,1));return amount+shipping(amount);}':undefined);}
 }
 payload={schemaVersion:1,stage:task.stage,taskId:task.id,verdict:'success',summary:'Resultado de fixture; los checks reales deciden.',evidenceRefs:['cart.mjs'],findings:[]};
 if(task.stage==='review'&&task.id.endsWith('-total')){
  const history=JSON.parse(input.match(/^ACCEPTED_PREDECESSOR_EVIDENCE_JSON=(.+)$/m)?.[1]??'[]');
  if(history.length!==2||history.some(r=>!r.acceptance?.accepted||r.review?.sessionId===r.implementation?.sessionId)){payload.verdict='needs_changes';payload.summary='Falta evidencia de los pasos anteriores.';payload.findings=[{severity:'important',description:payload.summary}];}
 }
}
if(provider==='codex'){writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(payload));console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5,cached_input_tokens:0}}));}
else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:payload,session_id:randomUUID(),usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0},total_cost_usd:0.001}));
