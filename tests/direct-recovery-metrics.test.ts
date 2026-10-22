import {test} from "node:test";
import assert from "node:assert/strict";
import {writeFile,readFile,readdir,access} from "node:fs/promises";
import {setTimeout as delay} from "node:timers/promises";
import {join,resolve} from "node:path";
import {supervisorFixture} from "./supervisor-fixture.js";
import {runTask,resumeRun} from "../src/runner.js";
import {runDirectTask} from "../src/direct-workflow.js";
import {StateStore} from "../src/state-store.js";
import {runProcess} from "../src/process.js";
import {summarizeRun} from "../src/metrics.js";
import type {RunState} from "../src/contracts.js";
async function fixture(){
  const f=await supervisorFixture();f.config.capabilities.commit=true;
  f.config.delivery={branchPrefix:"feature/agent-",recovery:"query_only",commit:{message:"demo",author:{name:"Demo",email:"demo@example.invalid"}}};return f;
}
for(const [mode,run] of [["direct",runDirectTask],["framework",runTask]] as const){
  test(`${mode}: operator cancellation wins when reported consumption also reaches the cap`,async()=>{
    const f=await fixture(),c=new AbortController();f.config.supervisor!.maxReportedTokens=10;
    const state=await run(f.task,f.config,{stateDir:f.stateDir,signal:c.signal,onCheckpoint:async s=>{if(s.attempts.at(-1)?.result?.stage==="define")c.abort();}});
    assert.equal(state.status,"cancelled");
  });
  test(`${mode}: operator cancellation before preflight is cancellation`,async()=>{
    const f=await fixture(),c=new AbortController();c.abort();const state=await run(f.task,f.config,{stateDir:f.stateDir,signal:c.signal});
    assert.equal(state.status,"cancelled");
  });
  test(`${mode}: cancellation during a check takes precedence over blocked check assessment`,async()=>{
    const f=await fixture(),marker=join(f.dir,"check-started"),script=join(f.dir,"check.mjs"),c=new AbortController();
    await writeFile(script,`import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`);
    f.config.checks=[{id:"check",command:[process.execPath,script],required:true}];f.task.acceptanceChecks={"answer.txt exists":["check"]};
    const work=run(f.task,f.config,{stateDir:f.stateDir,signal:c.signal});
    let finished=false;void work.then(()=>{finished=true;},()=>{finished=true;});
    // Synchronize with the check, rather than cancelling a healthy preflight on a slow host.
    // The actual supervisor/stage budgets remain unchanged and still bound the run.
    const deadline=Date.now()+f.config.supervisor!.runTimeoutMs;
    let started=false;while(!finished&&Date.now()<deadline){try{await access(marker);started=true;break;}catch{await delay(50);}}
    c.abort();const state=await work;assert.equal(started,true,`checker must start before cancellation; run ended ${state.status}: ${state.reason}`);assert.equal(state.status,"cancelled");
  });
}
test("abrupt direct exit preserves confirmed usage and leaves incomplete duration unknown",async()=>{
  const f=await fixture(),profile=join(f.dir,"profile.json"),task=join(f.dir,"task.json");
  await writeFile(profile,JSON.stringify(f.config));await writeFile(task,JSON.stringify(f.task));
  const p=await runProcess({command:[process.execPath,resolve("tests/fixtures/direct-crash.mjs"),profile,task,f.stateDir],cwd:process.cwd(),timeoutMs:60000,maxOutputBytes:100000});
  assert.equal(p.exitCode,79,p.stderr);
  const ids=(await readdir(f.stateDir)).filter(x=>/^[a-f0-9-]{36}$/.test(x));assert.equal(ids.length,1);
  const state=await new StateStore(f.stateDir).read(ids[0]!) as unknown as RunState;
  assert.equal(state.attempts.length,1);assert.equal(state.attempts[0]!.result?.stage,"define");
  const m=summarizeRun(state);assert.equal(m.usage.totalTokens.value,15);assert.ok(m.timing.wallMs>0);assert.equal(m.timing.activeMs,null);
  assert.equal(m.timing.totalMs,null);assert.equal(m.accepted,false);
  assert.match(await readFile(f.trace,"utf8"),/define/);
  await assert.rejects(resumeRun(state.id,f.config,{stateDir:f.stateDir}),/not a resumable|not.*resumable/i);
});
