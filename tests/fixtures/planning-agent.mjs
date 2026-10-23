import {writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
const [provider,mode,...args]=process.argv.slice(2);
if(args.includes('--version')){console.log(provider+' fixture-1');process.exit(0);}
if(args.includes('--help')){console.log('--json --output-schema --output-last-message --sandbox --cd --ignore-user-config --json-schema --output-format --tools --allowedTools --setting-sources --strict-mcp-config --mcp-config --settings');process.exit(0);}
if(args.includes('status')){console.log(provider==='claude'?JSON.stringify({loggedIn:true}):'Logged in using test account');process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;
const request=JSON.parse(input.match(/GOAL_JSON=(.+)/)?.[1]??'{}');
const artifact=provider==='codex'?dirname(args[args.indexOf('--output-last-message')+1]):request.artifactDir;
writeFileSync(join(artifact,'fixture-command.json'),JSON.stringify(args));
if(mode==='unsupported-model'){
 const message=JSON.stringify({type:'error',status:400,error:{type:'invalid_request_error',message:"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}});
 console.log(JSON.stringify({type:'turn.failed',error:{message}}));process.exit(1);
}
if(mode==='wait'){setInterval(()=>{},1000);await new Promise(()=>{});}
const plan={schemaVersion:1,verdict:mode==='questions'&&!request.answers.length?'needs_input':'ready',summary:'Corregir suma tras revisar el código.',facts:[{description:'sum resta los operandos',files:['sum.mjs']}],assumptions:[],decisions:['Conservar la API'],questions:mode==='questions'&&!request.answers.length?['¿Cómo tratar texto?']:[],steps:[{title:'Corregir suma',description:'Cambiar la operación y verificar el comportamiento.',files:['sum.mjs']}],task:{objective:request.objective||'Corregir la suma',scope:['sum.mjs'],acceptance:['Suma ambos argumentos'],references:['AGENTS.md','sum.mjs'],checkIds:['sum']},proposedChecks:[]};
if(mode==='invalid')plan.task.checkIds=['missing'];
if(mode==='propose'){plan.task.checkIds=['behavior'];plan.proposedChecks=[{id:'behavior',command:[process.execPath,'.salem-check.mjs'],toolFiles:['.salem-check.mjs']}];}
if(mode==='inline'){plan.task.checkIds=['inline'];plan.proposedChecks=[{id:'inline',command:[process.execPath,'--test'],toolFiles:[]}];}
if(mode==='mutate')writeFileSync('sum.mjs','tampered');
if(provider==='codex'){writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(plan));console.log(JSON.stringify({type:'thread.started',thread_id:'planning-fixture'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:3,cached_input_tokens:2}}));}
else console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,structured_output:plan,session_id:'planning-fixture',usage:{input_tokens:10,output_tokens:3,cache_read_input_tokens:2},total_cost_usd:0.001}));
