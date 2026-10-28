import {writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const [provider,mode,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log(provider+' evolution-fixture');process.exit(0);}
if(args.includes('--help')){console.log('--json --output-schema --output-last-message --sandbox --cd --ignore-user-config --json-schema --output-format --tools --allowedTools --setting-sources --strict-mcp-config --mcp-config --settings');process.exit(0);}
if(args.includes('status')){console.log(provider==='claude'?JSON.stringify({loggedIn:true}):'Logged in using test account');process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;
if(provider==='codex'&&args[args.indexOf('--sandbox')+1]!=='read-only')throw Error('Evolution must remain read-only');
if(provider==='claude'&&(args[args.indexOf('--tools')+1]!=='Read,Glob,Grep'||!args.includes('{"disableAllHooks":true}')))throw Error('Evolution requires read-only tools and disabled hooks');
if(mode==='wait'){setInterval(()=>{},1000);await new Promise(()=>{});}
let payload;
if(input.includes('GOAL_JSON=')){
 const request=JSON.parse(input.match(/GOAL_JSON=(.+)/)[1]);
 payload={schemaVersion:1,verdict:'ready',summary:'Reparar suma',facts:[{description:'Resta por error',files:['sum.mjs']}],assumptions:[],decisions:['Conservar contrato'],questions:[],steps:[{title:'Reparar',description:'Sumar',files:['sum.mjs']}],task:{objective:request.objective,scope:['sum.mjs'],acceptance:['Suma ambos argumentos'],references:['sum.mjs'],checkIds:['sum']},proposedChecks:[]};
 if(mode==='expand')payload.proposedChecks=[{id:'easy',command:[process.execPath,'-e','process.exit(0)'],toolFiles:[]}];
}else if(input.includes('EVOLUTION_PATCH_JSON=')){
 const request=JSON.parse(input.match(/EVOLUTION_PATCH_JSON=(.+)/)[1]);
 payload={schemaVersion:1,summary:'Corregir operador',changes:[{path:mode==='checker'?'.salem-check.mjs':mode==='extra'?'extra.mjs':'sum.mjs',content:mode==='noop'?'export function sum(a,b){return a-b;}\n':'export function sum(a,b){return a+b;}\n'}]};
 if(mode==='mutate')writeFileSync('.salem-check.mjs','process.exit(0)');
 if(mode==='needs-source'&&!request.sourceFiles?.some(f=>f.path==='sum.mjs'&&f.content==='export function sum(a,b){return a-b;}\n'))payload.changes=[];
 if(mode==='change-wrapper')writeFileSync(new URL(import.meta.url),'// changed external authority\n');
}else{
 const task=JSON.parse(input.match(/TASK_JSON=(.+)/)[1]);payload={schemaVersion:1,stage:task.stage,taskId:task.id,verdict:mode==='badreview'?'needs_changes':'success',summary:'Revisión de fixture',evidenceRefs:['sum.mjs'],findings:mode==='badreview'?[{severity:'important',description:'Regresión'}]:[]};
 if(task.stage==='review')Object.assign(payload,{rubric:Object.fromEntries(['solves','correct','secure','tested','understandable','style'].map(k=>[k,{pass:true,notes:''}])),risk:mode==='risky'?{level:'high',reasons:['La reparación cambia una comprobación de permisos']}:{level:'normal',reasons:[]}});
}
if(provider==='codex'){writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(payload));console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID()}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:3,cached_input_tokens:0}}));}
else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:payload,session_id:randomUUID(),usage:{input_tokens:10,output_tokens:3,cache_read_input_tokens:mode==='cache-budget'?900:0,...(mode==='unknown-cache'?{}:{cache_creation_input_tokens:0})},total_cost_usd:0.001}));
