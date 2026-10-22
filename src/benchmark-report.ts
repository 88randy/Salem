import { readFile, mkdir } from "node:fs/promises";
import { resolve, dirname, join, relative } from "node:path";
import { StateStore, atomicJson, digest } from "./state-store.js";
import type { RunState } from "./contracts.js";
import type { CohortMetrics } from "./metrics-contracts.js";
import { summarizeRun, compareRuns } from "./metrics.js";
import { redact } from "./process.js";
interface Trial {
  caseId: string; mode: "direct" | "framework"; baseSha: string; repoRoot: string; stateDir: string;
  runId: string | null; status: string; error?: string; failurePhase?: string; finishedAt?: number;
  observationDir?: string; sourceRevision?: number; sourceChecksum?: string; executionWallMs?: number;
}
interface Manifest extends Record<string,unknown> {
  schemaVersion: number; id: string; evidenceKind: string; protocolHash: string; fixedAt: number;
  commonSetupMs: number; trials: Trial[];
}
async function readManifest(file:string):Promise<Manifest>{
  const m=JSON.parse(await readFile(file,"utf8")) as Manifest;
  if(m.schemaVersion!==1||!m.id||!m.protocolHash||!Array.isArray(m.trials)||!m.trials.length||!["fixture","live"].includes(m.evidenceKind))throw new Error("Invalid benchmark manifest");
  for(const t of m.trials)if(!["direct","framework"].includes(t.mode)||!t.caseId||!t.repoRoot||!t.stateDir)throw new Error("Invalid planned trial");
  return m;
}
export async function recordBenchmarkResult(file:string,index:number,run:RunState,executionWallMs:number):Promise<Manifest>{
  const m=await readManifest(file),trial=m.trials[index];
  if(!trial||!Number.isFinite(executionWallMs)||executionWallMs<0||(trial.runId&&trial.runId!==run.id))throw new Error("Invalid benchmark result identity/timing");
  if(trial.observationDir)throw new Error("Benchmark result already frozen");
  const observed=structuredClone(run);
  if(!observed.telemetry?.benchmark)throw new Error("Missing benchmark context");
  observed.telemetry.benchmark.executionWallMs=executionWallMs;
  const root=join(dirname(resolve(file)),"observations");await mkdir(root,{recursive:true});
  const store=new StateStore(root);await mkdir(store.directory(run.id));
  await store.write(run.id,observed); // exclusive observation, never the operational checkpoint
  Object.assign(trial,{runId:run.id,status:run.status,finishedAt:Date.now(),observationDir:relative(dirname(resolve(file)),root),
    sourceRevision:run.revision,sourceChecksum:digest(run),executionWallMs});
  await atomicJson(file,m);return m;
}
export async function recordBenchmarkFailure(file:string,index:number,error:string,cancelled=false,phase="preparation"):Promise<Manifest>{
  const m=await readManifest(file),trial=m.trials[index];if(!trial)throw new Error("Invalid failed trial index");
  Object.assign(trial,{status:cancelled?"cancelled":"failed",error:redact(error).slice(0,20000),failurePhase:phase,finishedAt:Date.now()});
  await atomicJson(file,m);return m;
}
function includeUnmeasured(cohort:CohortMetrics,trials:Trial[]):void{
  cohort.total+=trials.length;cohort.unmeasured+=trials.length;
  cohort.failed+=trials.filter(t=>t.status==="failed").length;cohort.cancelled+=trials.filter(t=>t.status==="cancelled").length;
  cohort.successRate=cohort.total?cohort.accepted/cohort.total:null;
  if(!trials.length)return;
  cohort.totalMs=null;cohort.activeMs=null;
  for(const key of ["inputTokens","outputTokens","cachedInputTokens","cacheCreationInputTokens","totalTokens","costUsd"] as const){
    cohort.usage[key].value=null;cohort.usage[key].expected+=trials.length;
  }
}
export async function reportBenchmark(file:string){
  const manifest=await readManifest(file),runs=[];
  for(const trial of manifest.trials){
    if(!trial.runId)continue;
    const state=await new StateStore(resolve(dirname(file),trial.observationDir??trial.stateDir)).read(trial.runId) as unknown as RunState;
    const b=state.telemetry?.benchmark;
    if(!b||b.suiteId!==manifest.id||b.protocolHash!==manifest.protocolHash||b.baseSha!==trial.baseSha||b.mode!==trial.mode||b.kind!==trial.caseId||state.expected.root!==resolve(dirname(file),trial.repoRoot))throw new Error("Benchmark state/protocol identity mismatch");
    const metric=summarizeRun(state);
    if(trial.error){metric.accepted=false;metric.status=trial.status==="cancelled"?"cancelled":"failed";metric.failures.infrastructure++;metric.limitations.push(`Harness ${trial.failurePhase??"unknown"} failure: ${trial.error}`);}
    runs.push(metric);
  }
  const comparison=compareRuns(runs.filter(r=>r.provenance.benchmark?.mode==="direct"),runs.filter(r=>r.provenance.benchmark?.mode==="framework"));
  const unmeasured=manifest.trials.filter(t=>!t.runId);
  includeUnmeasured(comparison.baseline,unmeasured.filter(t=>t.mode==="direct"));
  includeUnmeasured(comparison.candidate,unmeasured.filter(t=>t.mode==="framework"));
  const complete=unmeasured.length===0&&manifest.trials.every(t=>["completed","failed","blocked","cancelled"].includes(t.status))&&runs.every(r=>r.timing.wallComplete);
  if(!complete){comparison.issues.push("Protocol incomplete: planned failed/unstarted trials remain in denominators and incomplete timings are not final totals.");if(comparison.comparability==="verified")comparison.comparability="partial";}
  return {schemaVersion:1,id:manifest.id,evidenceKind:manifest.evidenceKind,protocolHash:manifest.protocolHash,
    planned:manifest.trials.length,executed:runs.length,complete,unmeasuredTrials:unmeasured,
    commonSetupMs:manifest.commonSetupMs,setupAmortizedMsPerPlannedTrial:manifest.commonSetupMs/manifest.trials.length,comparison,runs};
}
