import {cp,mkdir,mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {runProcess,resolveExecutable} from '../dist/src/process.js';
import {forgeFixture} from '../dist/tests/forge-fixture.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),agentId=process.argv[2];
if(!['fixture','codex','claude'].includes(agentId))throw new Error('Usage: node scripts/demo-delivery.mjs <fixture|codex|claude>');
await mkdir(join(root,'.artifacts/task5-demo'),{recursive:true});
const dir=await mkdtemp(join(root,'.artifacts/task5-demo',agentId+'-')),project=join(dir,'project'),origin=join(dir,'origin.git');
await cp(join(root,'fixtures/supervisor-demo'),project,{recursive:true});await mkdir(origin);
const git=async(cwd,...args)=>{const r=await runProcess({command:['git',...args],cwd,timeoutMs:10000,maxOutputBytes:100000});assert.equal(r.exitCode,0,r.stderr);return r.stdout.trim();};
await git(project,'init','-b','demo');await git(project,'add','AGENTS.md','sum.mjs');
await git(project,'-c','user.name=Demo','-c','user.email=demo@example.invalid','commit','-m','demo baseline');
await git(origin,'init','--bare','-b','main');await git(project,'remote','add','origin',origin);await git(project,'push','origin','HEAD:refs/heads/main');
const base=await git(project,'rev-parse','HEAD'),forge=await forgeFixture(origin);forge.command[1]=join(root,'tests/fixtures/gh-client.mjs');
try {
  const checker=join(dir,'check-sum.mjs');await writeFile(checker,`import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';import {resolve} from 'node:path';const {sum}=await import(pathToFileURL(resolve('sum.mjs')));assert.equal(sum(2,3),5);assert.equal(sum(-2,1),-1);console.log('real sum assertions passed');\n`);
  const config=JSON.parse(await readFile(join(root,'profiles/demo.json'),'utf8'));
  config.repoRoot=project;config.agents={worker:agentId==='fixture'?{provider:'codex',command:[process.execPath,join(root,'tests/fixtures/acceptance-agent.mjs'),join(dir,'trace.jsonl')]}:config.agents[agentId]};
  if(agentId==='claude')config.agents.worker.command[0]=await resolveExecutable(config.agents.worker.command[0]);
  config.capabilities={edit:true,commit:true,pull_request:true,merge:true,deploy:true};config.checks=[{id:'sum-tests',command:[process.execPath,checker],required:true}];
  config.supervisor={roles:{define:'worker',build:'worker',review:'worker'},runTimeoutMs:600000,maxAttempts:8};
  const deployment=join(dir,'deployed'),deployCommand=[process.execPath,join(root,'tests/fixtures/demo-deploy.mjs'),deployment,origin];
  config.delivery={branchPrefix:'feature/agent-',recovery:'query_only',commit:{message:'fix: corregir suma demo',author:{name:'Demo',email:'demo@example.invalid'}},
    github:{command:forge.command,remote:'origin',remoteUrl:origin,repository:'demo/project',baseBranch:'main',draft:false,merge:{method:'merge',requiredChecks:['build']}},
    deploy:{command:deployCommand,statusCommand:deployCommand,target:'isolated-local-demo',requiredChecks:['build']}};
  const criteria=['sum(2,3) returns 5','sum(-2,1) returns -1'];
  const task={id:'DELIVERY-DEMO',objective:'Fix numeric sum(a,b). Only edit sum.mjs. Do not run Git or delivery actions; the supervisor owns them.',scope:['sum.mjs'],acceptance:criteria,acceptanceChecks:Object.fromEntries(criteria.map(c=>[c,['sum-tests']])),references:['AGENTS.md','sum.mjs']};
  const profile=join(dir,'profile.json'),taskFile=join(dir,'task.json'),stateDir=join(dir,'runs');
  await writeFile(profile,JSON.stringify(config,null,2));await writeFile(taskFile,JSON.stringify(task,null,2));
  forge.state.loseCreate='after';
  const call=async(args,label)=>{const r=await runProcess({command:[process.execPath,join(root,'dist/src/cli.js'),...args,'--config',profile,'--state-dir',stateDir],cwd:root,timeoutMs:620000,maxOutputBytes:2000000});await writeFile(join(dir,label+'-stdout.json'),r.stdout);await writeFile(join(dir,label+'-stderr.log'),r.stderr);return {result:r,state:JSON.parse(r.stdout)};};
  const first=await call(['run','--task',taskFile],'run');assert.equal(first.result.exitCode,1);assert.equal(first.state.status,'blocked');assert.equal(first.state.nextPhase,'delivering');
  assert.equal(forge.state.pulls.length,1);assert.equal(first.state.deliveryJournal.actions.find(a=>a.action==='pull_request').status,'unknown');
  const final=await call(['resume','--run',first.state.id],'resume');assert.equal(final.result.exitCode,0);assert.equal(final.state.status,'completed');assert.equal(final.state.acceptance.accepted,true);
  assert.equal(final.state.attempts.length,first.state.attempts.length);assert.equal(forge.state.pulls.length,1);
  assert.deepEqual(final.state.deliveryJournal.actions.map(a=>[a.action,a.status]),[['commit','succeeded'],['push','succeeded'],['pull_request','succeeded'],['merge','succeeded'],['deploy','succeeded']]);
  const release=final.state.deliveryJournal.releaseSha;assert.equal(await git(origin,'rev-parse','main'),release);assert.equal(await git(origin,'rev-parse',`${release}^{tree}`),final.state.deliveryJournal.tree);
  assert.equal(await git(project,'rev-parse','HEAD'),base);assert.equal(await git(project,'status','--porcelain'),'M sum.mjs');
  const {sum}=await import(pathToFileURL(join(deployment,'app','sum.mjs')));assert.equal(sum(2,3),5);assert.equal(sum(-2,1),-1);
  const report={accepted:true,agentId,runId:final.state.id,base,releaseSha:release,tree:final.state.deliveryJournal.tree,firstStatus:first.state.status,finalStatus:final.state.status,attempts:final.state.attempts.length,
    actions:final.state.deliveryJournal.actions,codeAcceptance:final.state.acceptance,stages:final.state.attempts.map(a=>({stage:a.stage,sessionId:a.result.sessionId,usage:a.result.usage})),
    prCount:forge.state.pulls.length,deployedCode:join(deployment,'app','sum.mjs'),limitations:['Local Git push/merge and real materialized demo deployment; GitHub REST/CI are a local test service, not real GitHub acceptance.','No Codequim mutation, publication or production deployment.']};
  await writeFile(join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({accepted:true,agentId,runId:report.runId,finalStatus:report.finalStatus,report:join(dir,'report.json')},null,2));
} finally {await forge.close();}
