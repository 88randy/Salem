import {cp,mkdir,mkdtemp,readFile,readdir,writeFile} from 'node:fs/promises';
import {join,resolve,dirname,relative} from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID,createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {runProcess,resolveExecutable} from '../dist/src/process.js';import {loadProjectConfig} from '../dist/src/config.js';
import {runTask} from '../dist/src/runner.js';import {runDirectTask} from '../dist/src/direct-workflow.js';
import {atomicJson,digest} from '../dist/src/state-store.js';import {reportBenchmark,recordBenchmarkResult,recordBenchmarkFailure} from '../dist/src/benchmark-report.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),opts={};
while(args.length){const k=args.shift(),v=args.shift();if(!['--provider','--case'].includes(k)||!v||k in opts)throw new Error('Usage: benchmark.mjs --provider <fixture|claude|codex> [--case <all|bug|feature|refactor>]');opts[k]=v;}
const provider=opts['--provider'],selection=opts['--case']??'all';
if(!['fixture','claude','codex'].includes(provider)||!['all','bug','feature','refactor'].includes(selection))throw new Error('Invalid benchmark provider/case');
const began=Date.now(),protocol=JSON.parse(await readFile(join(root,'evals/protocol.json'),'utf8'));
const cases=protocol.cases.filter(k=>selection==='all'||selection===k);
await mkdir(join(root,'.artifacts/task6-benchmark'),{recursive:true});const dir=await mkdtemp(join(root,'.artifacts/task6-benchmark',provider+'-'));
const hooks=join(dir,'empty-hooks');await mkdir(hooks);
const git=async(cwd,...argv)=>{const r=await runProcess({command:['git','-c',`core.hooksPath=${hooks}`,'-c','core.autocrlf=false','-c','commit.gpgsign=false',...argv],cwd,timeoutMs:15000,maxOutputBytes:200000,
  env:{GIT_AUTHOR_DATE:'2026-10-21T00:00:00Z',GIT_COMMITTER_DATE:'2026-10-21T00:00:00Z'}});assert.equal(r.exitCode,0,r.stderr);return r.stdout.trim();};
const demo=JSON.parse(await readFile(join(root,'profiles/demo.json'),'utf8'));
const agent=provider==='fixture'?{provider:'codex',command:[process.execPath,join(root,'tests/fixtures/benchmark-agent.mjs')]}:structuredClone(demo.agents[provider]);
agent.command[0]=await resolveExecutable(agent.command[0]);
const fixedInputs=[];
for(const folder of ['evals','dist/src','templates'])for(const name of (await readdir(join(root,folder),{recursive:true})).sort()){
  const file=join(root,folder,name);try{const bytes=await readFile(file);fixedInputs.push([folder+'/'+name.replaceAll('\\','/'),createHash('sha256').update(bytes).digest('hex')]);}catch(e){if(e.code!=='EISDIR'&&e.code!=='EPERM')throw e;}
}
for(const file of ['scripts/benchmark.mjs','tests/fixtures/benchmark-agent.mjs'])fixedInputs.push([file,createHash('sha256').update(await readFile(join(root,file))).digest('hex')]);
const protocolHash=digest({protocol,fixedInputs}),id=randomUUID(),manifestFile=join(dir,'manifest.json');
let manifest={schemaVersion:1,id,evidenceKind:provider==='fixture'?'fixture':'live',requestedProvider:provider,protocol,protocolHash,fixedInputs,fixedAt:0,commonSetupMs:0,trials:[]};
const seeds={};
for(const kind of cases){
  const seed=join(dir,'seed-'+kind);await cp(join(root,'evals/demo'),seed,{recursive:true});
  if(kind==='bug')await writeFile(join(seed,'sum.mjs'),'export function sum(a, b) { return a - b; }\n');
  await git(seed,'init','-b','demo');await git(seed,'add','.');await git(seed,'-c','user.name=Demo','-c','user.email=demo@example.invalid','commit','-m',`eval baseline ${kind}`);
  seeds[kind]={root:seed,sha:await git(seed,'rev-parse','HEAD')};
  for(const mode of protocol.order[provider==='fixture'?'codex':provider][kind])manifest.trials.push({caseId:kind,mode,baseSha:seeds[kind].sha,repoRoot:relative(dir,join(dir,kind+'-'+mode,'project')),stateDir:relative(dir,join(dir,kind+'-'+mode,'runs')),runId:null,status:'scheduled',startedAt:null,finishedAt:null,setupMs:null});
}
manifest.commonSetupMs=Date.now()-began;manifest.fixedAt=Date.now();await atomicJson(manifestFile,manifest);
const controller=new AbortController(),abort=()=>controller.abort();process.on('SIGINT',abort);process.on('SIGTERM',abort);
try{
  for(let index=0;index<manifest.trials.length;index++){
    const trial=manifest.trials[index];let phase='preparation';
    if(controller.signal.aborted)break;
    try{
    const setupStart=Date.now(),trialDir=join(dir,trial.caseId+'-'+trial.mode),project=resolve(dir,trial.repoRoot);await mkdir(trialDir);
    trial.startedAt=Date.now();trial.status='preparing';await atomicJson(manifestFile,manifest);
    await git(dir,'clone','--no-hardlinks','--branch','demo','--',seeds[trial.caseId].root,project);
    await git(project,'config','core.autocrlf','false');await git(project,'config','core.hooksPath',hooks);
    assert.equal(await git(project,'rev-parse','HEAD'),trial.baseSha);assert.equal(await git(project,'status','--porcelain'),'');
    const task=JSON.parse(await readFile(join(root,'evals/tasks',trial.caseId+'.json'),'utf8'));
    const acceptance=join(root,'evals/acceptance',trial.caseId+'.mjs'),regressions=join(root,'evals/acceptance/regressions.mjs');
    for(const [name,command,want] of [['target',[process.execPath,acceptance],1],['regressions',[process.execPath,regressions,trial.caseId],0]]){
      const r=await runProcess({command,cwd:project,timeoutMs:10000,maxOutputBytes:100000});await writeFile(join(trialDir,'baseline-'+name+'.json'),JSON.stringify(r,null,2));assert.equal(r.exitCode,want,`Invalid fixed ${name} baseline: ${r.stderr}`);
    }
    const limits=protocol.budgets,config={schemaVersion:1,projectId:'benchmark',repoRoot:project,contextFiles:['AGENTS.md'],agents:{worker:agent},
      checks:[{id:'acceptance',command:[process.execPath,acceptance],required:true},{id:'regressions',command:[process.execPath,regressions,trial.caseId],required:true}],
      capabilities:{edit:true,commit:true,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:limits.stageTimeoutMs,maxOutputBytes:limits.maxOutputBytes},
      supervisor:{roles:{define:'worker',build:'worker',review:'worker'},runTimeoutMs:limits.runTimeoutMs,maxAttempts:limits.maxAttempts,maxReportedTokens:limits.maxReportedTokens},
      delivery:{branchPrefix:'feature/eval-',recovery:'query_only',commit:{message:'eval: '+task.id,author:{name:'Demo',email:'demo@example.invalid'}}}};
    const profile=join(trialDir,'profile.json');await writeFile(profile,JSON.stringify(config,null,2));await writeFile(join(trialDir,'task.json'),JSON.stringify(task,null,2));
    trial.setupMs=Date.now()-setupStart;trial.status='running';await atomicJson(manifestFile,manifest);
    const benchmark={suiteId:id,protocolHash,caseId:task.id,kind:trial.caseId,mode:trial.mode,provider:agent.provider,baseSha:trial.baseSha,
      acceptanceHash:digest({task,files:fixedInputs.filter(([p])=>p.startsWith('evals/acceptance/'))}),agentConfigHash:digest(agent),limitsHash:digest(limits),environment:`${process.platform}-${process.arch}-${process.version}`,setupMs:trial.setupMs};
    const executionStart=Date.now(),stateDir=resolve(dir,trial.stateDir);phase='execution';
    const onCheckpoint=async state=>{trial.runId=state.id;await atomicJson(manifestFile,manifest);console.error(JSON.stringify({provider,case:trial.caseId,mode:trial.mode,runId:state.id,status:state.status,attempts:state.attempts.length}));};
    const state=await (trial.mode==='direct'?runDirectTask:runTask)(task,await loadProjectConfig(profile),{stateDir,signal:controller.signal,benchmark,onCheckpoint});
    phase='postcondition';
    assert.equal(await git(project,'rev-parse','HEAD'),trial.baseSha);
    manifest=await recordBenchmarkResult(manifestFile,index,state,Date.now()-executionStart);
    console.error(JSON.stringify({event:'trial_finished',provider,case:trial.caseId,mode:trial.mode,status:state.status,reason:state.reason,runId:state.id}));
    }catch(e){
      manifest=await recordBenchmarkFailure(manifestFile,index,e instanceof Error?e.message:String(e),controller.signal.aborted,phase);
      console.error(JSON.stringify({event:'trial_failed',provider,case:trial.caseId,mode:trial.mode,phase,error:manifest.trials[index].error}));
    }
  }
}finally{process.removeListener('SIGINT',abort);process.removeListener('SIGTERM',abort);manifest.finishedAt=Date.now();await atomicJson(manifestFile,manifest);}
const report=await reportBenchmark(manifestFile),reportFile=join(dir,'report.json');await atomicJson(reportFile,report);
console.log(JSON.stringify({manifest:manifestFile,report:reportFile,planned:report.planned,executed:report.executed,comparison:report.comparison},null,2));
if(controller.signal.aborted)process.exitCode=130;
