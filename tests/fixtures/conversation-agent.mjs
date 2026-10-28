import {writeFileSync,readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const [provider,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log(provider+' conversation-fixture-1');process.exit(0);}
if(args.includes('--help')){console.log('--json --output-schema --output-last-message --sandbox --cd --ignore-user-config --json-schema --output-format --tools --allowedTools --setting-sources --strict-mcp-config --mcp-config --settings');process.exit(0);}
if(args.includes('status')){console.log(provider==='claude'?JSON.stringify({loggedIn:true}):'Logged in using test account');process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;
let payload;
if(input.includes('GOAL_JSON=')){
 const request=JSON.parse(input.match(/GOAL_JSON=(.+)/)[1]),answered=request.objective.includes('Rechaza texto');
 const available=new Set(request.checks.map(c=>c.id));
 const node=(id,title,dependsOn=[])=>({id,title,dependsOn,objective:title,scope:['sum.mjs'],acceptance:[title+' conservando la suma'],checkIds:['sum',...(available.has(id)?[id]:[])],agentId:'codex'});
 payload={schemaVersion:1,verdict:answered?'ready':'needs_input',summary:'Revisé la suma y prepararé tres pasos.',facts:[{description:'La suma está implementada en sum.mjs.',files:['sum.mjs']}],assumptions:[],decisions:['Codex implementa; el supervisor conserva sus checks y revisor.'],questions:answered?[]:['¿Cómo quieres tratar texto: rechazarlo o convertirlo a número?'],steps:[{title:'Suma',description:'Corregir la operación',files:['sum.mjs']}],task:{objective:'Suma numérica documentada con rechazo de texto',scope:['sum.mjs'],acceptance:['Suma documentada y texto rechazado'],references:['AGENTS.md','sum.mjs'],checkIds:['sum']},proposedChecks:[],work:{tasks:[node('sum','Corregir suma'),node('docs','Documentar suma',['sum']),node('types','Rechazar texto con TypeError',['docs'])]}};
 if(request.objective.includes('Solo explica')){payload.verdict='answered';payload.summary='sum.mjs expone una función de suma; la evidencia es su implementación.';payload.questions=[];payload.work.tasks=[];}
 else payload.task.checkIds=['sum','docs','types'].filter(id=>available.has(id));
}else{
 const task=JSON.parse(input.match(/TASK_JSON=(.+)/)[1]);
 if(task.stage==='build'){
  if(task.id.endsWith('-sum'))writeFileSync('sum.mjs','export function sum(a,b){return a+b;}\n');
  else if(task.id.endsWith('-docs'))writeFileSync('sum.mjs','// Suma dos números.\n'+readFileSync('sum.mjs','utf8'));
  else if(task.id.endsWith('-types')){if(!readFileSync('sum.mjs','utf8').includes('Suma dos números'))throw Error('Missing predecessor code');writeFileSync('sum.mjs','// Suma dos números; rechaza otros tipos.\nexport function sum(a,b){if(typeof a!=="number"||typeof b!=="number")throw new TypeError("Solo números");return a+b;}\n');}
 }
 payload={schemaVersion:1,stage:task.stage,taskId:task.id,verdict:'success',summary:'Resultado de fixture; los checks reales deciden.',evidenceRefs:['sum.mjs'],findings:[]};
 if(task.stage==='review')Object.assign(payload,{rubric:Object.fromEntries(['solves','correct','secure','tested','understandable','style'].map(k=>[k,{pass:true,notes:''}])),risk:{level:'normal',reasons:[]}});
 if(task.stage==='review'&&task.id.endsWith('-types')){
  const history=JSON.parse(input.match(/^ACCEPTED_PREDECESSOR_EVIDENCE_JSON=(.+)$/m)?.[1]??'[]');
  if(history.length!==2||history.some(r=>!r.acceptance?.accepted||!r.integrity?.instructionsHash||r.review?.sessionId===r.implementation?.sessionId||!r.checks.some(c=>c.checkId==='sum'&&c.status==='passed'))){payload.verdict='needs_changes';payload.summary='Falta evidencia histórica de los pasos anteriores.';payload.findings=[{severity:'important',description:payload.summary}];}
 }
}
if(provider==='codex'){writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(payload));console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5,cached_input_tokens:0}}));}
else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:payload,session_id:randomUUID(),usage:{input_tokens:10,output_tokens:5,cache_read_input_tokens:0},total_cost_usd:0.001}));
