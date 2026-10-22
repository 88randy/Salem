import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StateStore,atomicJson} from "../src/state-store.js";
import {reportBenchmark,recordBenchmarkResult,recordBenchmarkFailure} from "../src/benchmark-report.js";
import {measuredRun,metricAttempt} from "./metrics-fixture.js";
async function fixture(){
  const dir=await mkdtemp(join(tmpdir(),"benchmark review ")),file=join(dir,"manifest.json");
  const a=measuredRun(),b=measuredRun();a.telemetry!.benchmark!.mode="direct";
  for(const [i,r] of [a,b].entries()){r.expected.root=join(dir,`project-${i}`);r.attempts=[metricAttempt(r.id)];await new StateStore(join(dir,"runs")).write(r.id,r);}
  const trials=[a,b].map((r,i)=>({caseId:"bug",mode:r.telemetry!.benchmark!.mode,baseSha:"base",repoRoot:`project-${i}`,stateDir:"runs",runId:r.id,status:"completed"}));
  await atomicJson(file,{schemaVersion:1,id:"suite",protocolHash:"protocol",evidenceKind:"fixture",fixedAt:100,commonSetupMs:10,trials});
  return {dir,file,a,b,trials};
}
test("preparation failure and unstarted paired trial stay in planned denominators and invalidate completeness",async()=>{
  const f=await fixture(),raw=JSON.parse(await readFile(f.file,"utf8"));
  raw.trials.push({caseId:"feature",mode:"direct",baseSha:"feature-base",repoRoot:"feature-direct",stateDir:"feature-direct-runs",runId:null,status:"preparing"},
    {caseId:"feature",mode:"framework",baseSha:"feature-base",repoRoot:"feature-framework",stateDir:"feature-framework-runs",runId:null,status:"scheduled"});
  await atomicJson(f.file,raw);
  await recordBenchmarkFailure(f.file,2,"clone preparation failed");
  const report=await reportBenchmark(f.file);
  assert.equal(report.comparison.baseline.total,2);assert.equal(report.comparison.candidate.total,2);
  assert.equal(report.comparison.baseline.successRate,0.5);assert.equal(report.comparison.baseline.failed,1);
  assert.notEqual(report.comparison.comparability,"verified");
  assert.equal(report.comparison.baseline.usage.totalTokens.value,null);
  const disk=JSON.parse(await readFile(f.file,"utf8"));assert.equal(disk.trials[2].status,"failed");assert.match(disk.trials[2].error,/clone/);
});
test("final measurement cannot overwrite a newer native checkpoint and remains a frozen observation",async()=>{
  const f=await fixture(),store=new StateStore(join(f.dir,"runs")),newer=structuredClone(f.a);
  newer.revision=77;newer.attempts.push(metricAttempt("later-resume"));await store.write(newer.id,newer);
  await recordBenchmarkResult(f.file,0,f.a,12000);
  const native=await store.read(f.a.id);assert.equal(native.revision,77);assert.equal((native.attempts as unknown[]).length,2);
  const report=await reportBenchmark(f.file),measured=report.runs.find(r=>r.id===f.a.id)!;
  assert.equal(measured.iterations.build,1);assert.equal(measured.timing.totalMs,12200);
});
