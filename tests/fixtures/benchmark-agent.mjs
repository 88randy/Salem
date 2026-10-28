import {writeFileSync,readFileSync,existsSync,mkdirSync,rmSync,chmodSync} from 'node:fs';import {execFileSync} from 'node:child_process';import {randomUUID} from 'node:crypto';
const args=process.argv.slice(2);
if(args.includes('--version')){console.log('codex benchmark-fixture-1');process.exit(0);}
if(args.includes('--help')){console.log('--json --output-schema --output-last-message --sandbox --cd --ignore-user-config');process.exit(0);}
if(args.includes('status')){console.log('Logged in using test fixture');process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;
const task=JSON.parse(input.match(/TASK_JSON=(.+)/)[1]);
if(task.stage==='build'){
  if(task.id==='BUG-SUM')writeFileSync('sum.mjs','export function sum(a,b){return a+b;}\n');
  // Patch-export fixture: a committed marker asks for a binary file, a new directory, a deletion and a mode change.
  if(task.id==='BUG-SUM'&&existsSync('patch-fixture.txt')){
    mkdirSync('new dir/deep',{recursive:true});writeFileSync('new dir/deep/asset.bin',Buffer.from(Array.from({length:256},(_,i)=>i).filter(i=>i!==13)));writeFileSync('new dir/notes.txt','nested\n');
    writeFileSync('context.txt',readFileSync('context.txt','utf8').replace('line 5\n','line five\n'));rmSync('patch-fixture.txt');chmodSync('sum.mjs',0o755);execFileSync('git',['update-index','--chmod=+x','sum.mjs']);
  }
  if(task.id==='FEATURE-MEAN')writeFileSync('mean.mjs','export function mean(values){if(!values.length)throw new RangeError("empty");return values.reduce((a,b)=>a+b,0)/values.length;}\n');
  if(task.id==='REFACTOR-STATS')writeFileSync('stats.mjs','export function stats(values){let total=0,min=null,max=null;for(const v of values){total+=v;min=min===null?v:Math.min(min,v);max=max===null?v:Math.max(max,v);}return {count:values.length,total,min,max};}\n');
}
const payload={schemaVersion:1,stage:task.stage,taskId:task.id,verdict:'success',summary:'Fixture only, not LLM performance',evidenceRefs:task.scope,findings:[]};
if(task.stage==='review')Object.assign(payload,{rubric:Object.fromEntries(['solves','correct','secure','tested','understandable','style'].map(k=>[k,{pass:true,notes:''}])),risk:{level:'normal',reasons:[]}});
writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(payload));
console.log(JSON.stringify({type:'thread.started',thread_id:randomUUID(),model:'fixture'}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5,cached_input_tokens:0}}));
