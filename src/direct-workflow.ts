import type { ProjectConfig, TaskSpec, RunState } from "./contracts.js";
import type { RunnerOptions } from "./runner.js";
import { executionTools, runFingerprint } from "./runner.js";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { acquireLock, StateStore, digest } from "./state-store.js";
import { repositorySnapshot, instructionsHash, assertStateLocation } from "./repository.js";
import { runStage } from "./adapters/index.js";
import { runChecks } from "./checks.js";
import { evaluateChecks, evaluateAcceptance, type AcceptanceContext } from "./acceptance.js";
import { buildVerificationContext } from "./review-context.js";
import { deliver } from "./delivery.js";
import { usageBudgetReason } from "./metrics.js";
import { redact } from "./process.js";

// Reproducible baseline: explicit stage/check/review loop, no durable continuation
// or resume API. It uses the same tools and acceptance as the supervisor.
export async function runDirectTask(task: TaskSpec, config: ProjectConfig, options: RunnerOptions = {}): Promise<RunState> {
  if (!config.supervisor || !config.capabilities.edit || !config.capabilities.commit || !config.delivery || config.delivery.github || config.delivery.deploy) throw new Error("Direct benchmark requires explicit roles, budgets and local commit-only delivery");
  const store = new StateStore(options.stateDir ?? resolve(".artifacts/direct"));
  await assertStateLocation(config.repoRoot,store.root);
  const expected = await repositorySnapshot(config.repoRoot);
  if (expected.dirty) throw new Error("Direct benchmark requires clean isolated clone");
  const instructions=await instructionsHash(config);
  const id=randomUUID(), now=Date.now(), leaseDir=join(store.directory(id),"leases");
  const release=await acquireLock(join(expected.gitDir,"agent-workflow.lock"),id,leaseDir);
  const state:RunState={schemaVersion:1,id,revision:0,projectId:config.projectId,task:structuredClone(task),status:"queued",nextPhase:"defining",reason:null,
    createdAt:now,updatedAt:now,deadlineAt:now+config.supervisor.runTimeoutMs,configHash:digest(config),instructionsHash:instructions,toolsHash:"unverified",
    expected,attempts:[],checks:[],validation:null,acceptance:null,delivery:null,deliveryIntent:null,history:[{at:now,status:"queued",reason:null}],
    telemetry:{schemaVersion:1,controller:"direct",invocations:[{id:randomUUID(),startedAt:now,finishedAt:null}],interventions:[],agents:{},...(options.benchmark?{benchmark:structuredClone(options.benchmark)}:{})}};
  const controller=new AbortController(), abort=()=>controller.abort();options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
  const timer=setTimeout(abort,config.supervisor.runTimeoutMs);
  const change=(status:RunState["status"],reason:string|null=null)=>{state.status=status;state.reason=reason;state.updatedAt=Date.now();state.history.push({at:state.updatedAt,status,reason});return state;};
  const checkpoint=async()=>{state.updatedAt=Date.now();state.revision++;await store.write(id,state);await options.onCheckpoint?.(structuredClone(state));};
  const budget=()=>{
    if(options.signal?.aborted)return "cancelled";
    if(controller.signal.aborted||Date.now()>=state.deadlineAt)return "Run deadline / time budget exhausted";
    return usageBudgetReason(state,config.supervisor!.maxReportedTokens);
  };
  const context=():AcceptanceContext=>({config,snapshot:state.expected,fingerprint:runFingerprint(state),evidenceRoot:join(store.directory(id),"checks"),
    implementationSessionId:[...state.attempts].reverse().find(a=>a.stage==="build")?.result?.sessionId??null,toolHashes:state.checkToolHashes??{}});
  try {
    await checkpoint();
    try {
      const tools=await executionTools(config,controller.signal,leaseDir);state.toolsHash=tools.hash;state.checkToolHashes=tools.checkTools;state.deliveryToolsHash=tools.deliveryTools;state.telemetry!.agents=tools.agents;
    }catch(e){return change(options.signal?.aborted?"cancelled":"blocked",`Preflight: ${redact((e as Error).message)}`);}
    let stage:"define"|"build"|"review"="define";
    for(;;){
      const stop=budget();if(stop)return change(stop==="cancelled"?"cancelled":"blocked",stop);
      if(state.attempts.length>=config.supervisor.maxAttempts)return change("blocked","Attempt budget exhausted");
      change(stage==="define"?"defining":stage==="build"?"implementing":"reviewing");state.nextPhase=state.status as RunState["nextPhase"];
      const before=await repositorySnapshot(config.repoRoot);
      if(digest(before)!==digest(state.expected))return change("blocked","Worktree changed outside direct workflow");
      const verification=stage==="review"||(stage==="build"&&state.checks!.length)
        ?await buildVerificationContext(config,before,runFingerprint(state),state.checks??[],controller.signal,leaseDir):undefined;
      const attempt:RunState["attempts"][number]={id:randomUUID(),stage,agentId:config.supervisor.roles[stage],startedAt:Date.now(),finishedAt:null,before,after:null,artifactDir:"",result:null,valid:false};
      attempt.artifactDir=join(store.directory(id),"stages",attempt.id);state.attempts.push(attempt);
      await checkpoint(); // measurement intent, not a resumable continuation
      attempt.result=await runStage({config:{...config,budgets:{...config.budgets,stageTimeoutMs:Math.max(1,Math.min(config.budgets.stageTimeoutMs,state.deadlineAt-Date.now()))}},
        stage,agentId:attempt.agentId,task,artifactDir:attempt.artifactDir,leaseDir,priorStages:state.attempts.flatMap(a=>a.result?[a.result]:[]),...(verification?{verification}:{})},controller.signal);
      attempt.finishedAt=Date.now();attempt.after=await repositorySnapshot(config.repoRoot);
      if(before.head!==attempt.after.head||(stage!=="build"&&digest(before)!==digest(attempt.after)))return change("blocked","Agent modified read-only stage or HEAD");
      state.expected=attempt.after;const result=attempt.result;
      attempt.valid=result.status==="succeeded"&&Boolean(result.payload);await checkpoint();
      if(result.status!=="succeeded"||!result.payload)return change(result.status==="cancelled"?"cancelled":"failed",result.error??result.status);
      attempt.valid=true;
      if(result.payload.verdict==="blocked")return change("blocked",result.payload.summary);
      if(stage==="define"){stage="build";continue;}
      if(stage==="build"){
        for(const old of state.attempts.slice(0,-1))if(old.stage!=="define")old.valid=false;
        state.acceptance=null;change("validating");state.nextPhase="validating";
        const stopAfterBuild=budget();if(stopAfterBuild)return change(stopAfterBuild==="cancelled"?"cancelled":"blocked",stopAfterBuild);
        const ctx=context();
        await runChecks(config,state.expected.head,{artifactDir:ctx.evidenceRoot,snapshot:state.expected,fingerprint:ctx.fingerprint,
          toolHashes:state.checkToolHashes??{},signal:controller.signal,leaseDir,onEvidence:async e=>{state.checks!.push(e);await checkpoint();}});
        const stopAfterChecks=budget();if(stopAfterChecks)return change(stopAfterChecks==="cancelled"?"cancelled":"blocked",stopAfterChecks);
        const checks=await evaluateChecks(task,state.checks??[],ctx);
        if(!checks.accepted){if(checks.retryable){stage="build";continue;}return change("blocked",checks.reasons.join("; "));}
        stage="review";continue;
      }
      const changes=result.payload.verdict==="needs_changes"||result.payload.findings?.some(f=>f.severity!=="minor");
      if(changes){stage="build";continue;}
      state.acceptance=await evaluateAcceptance(task,state.checks??[],result,context());
      if(!state.acceptance.accepted)return change("blocked",state.acceptance.reasons.join("; "));
      const stopAfterReview=budget();if(stopAfterReview)return change(stopAfterReview==="cancelled"?"cancelled":"blocked",stopAfterReview);
      change("delivering");state.nextPhase="delivering";
      const receipt=await deliver({runId:id,task,context:context(),evidence:state.checks??[],review:result,artifactDir:join(store.directory(id),"delivery"),leaseDir,lockHeld:true,
        expectedToolsHash:state.deliveryToolsHash!,signal:controller.signal});state.delivery=receipt;state.deliveryJournal=receipt.journal;
      const stopAfterDelivery=budget();if(stopAfterDelivery)return change(stopAfterDelivery==="cancelled"?"cancelled":"blocked",stopAfterDelivery);
      return change(receipt.verdict==="success"?"completed":"blocked",receipt.verdict==="success"?null:receipt.summary);
    }
  }catch(e){return change(options.signal?.aborted?"cancelled":"failed",redact((e as Error).message));}
  finally{
    clearTimeout(timer);options.signal?.removeEventListener("abort",abort);
    try{state.telemetry!.invocations[0]!.finishedAt=Date.now();state.updatedAt=Date.now();state.revision++;await store.write(id,state);}finally{await release();}
  }
}
