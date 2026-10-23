import type { ProjectConfig, TaskSpec, RunState, GateReceipt, RunStatus, RunPhase, Stage } from "./contracts.js";
import { randomUUID, createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StateStore, acquireLock, digest } from "./state-store.js";
import { repositorySnapshot, instructionsHash, assertStateLocation } from "./repository.js";
import { inspectAgent } from "./doctor.js";
import { resolveExecutable, redact } from "./process.js";
import { runStage } from "./adapters/index.js";
import { runChecks, checkToolHash } from "./checks.js";
import { evaluateChecks, evaluateAcceptance, type AcceptanceContext } from "./acceptance.js";
import { buildVerificationContext } from "./review-context.js";
import { deliver, deliveryToolsHash } from "./delivery.js";
import { usageBudgetReason } from "./metrics.js";
import type { AgentProvenance, BenchmarkContext } from "./metrics-contracts.js";
export interface RunnerOptions {
  acceptedBase?: { state:RunState; config:ProjectConfig; evidenceRoot:string };
  stateDir?: string; signal?: AbortSignal;
  benchmark?: BenchmarkContext; resumeActor?: "operator" | "automation";
  onCheckpoint?: (state: RunState) => Promise<void>;
  gates?: { validate?: (state: RunState, signal: AbortSignal) => Promise<GateReceipt>; deliver?: (state: RunState, signal: AbortSignal) => Promise<GateReceipt> };
}
/** A dirty baseline is admitted only as the exact, independently accepted predecessor. */
export async function verifyAcceptedBase(base:NonNullable<RunnerOptions['acceptedBase']>,root:string):Promise<void>{
 const state=base.state,current=await repositorySnapshot(state.expected.root),target=await repositorySnapshot(root);
 if(state.status!=='completed'||digest(current)!==digest(state.expected)||current.head!==target.head||current.treeHash!==target.treeHash||current.dirty!==target.dirty||state.configHash!==digest(base.config)||state.instructionsHash!==await instructionsHash(base.config)||state.delivery?.verdict!=='success'||state.delivery.fingerprint!==runFingerprint(state))throw new Error('La base aceptada cambió o no tiene una entrega verificable.');
 const review=[...state.attempts].reverse().find(a=>a.stage==='review'&&a.valid)?.result;
 const implementationSessionId=[...state.attempts].reverse().find(a=>a.stage==='build'&&a.valid)?.result?.sessionId??null;
 if(!review||!state.acceptance?.accepted||state.acceptance.fingerprint!==runFingerprint(state))throw new Error('La base requiere aceptación y revisión independientes.');
 const accepted=await evaluateAcceptance(state.task,state.checks??[],review,{config:base.config,snapshot:current,fingerprint:runFingerprint(state),evidenceRoot:base.evidenceRoot,implementationSessionId,toolHashes:state.checkToolHashes??{}});
 if(!accepted.accepted)throw new Error('Pruebas de la base inválidas: '+accepted.reasons.join('; '));
}
export function runFingerprint(state: RunState): string {
  return digest({ task: state.task, config: state.configHash, instructions: state.instructionsHash, tools: state.toolsHash, repository: state.expected });
}
async function fileHash(file: string): Promise<string> {
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export async function executionTools(config: ProjectConfig, signal: AbortSignal, leaseDir: string): Promise<{ hash: string; checkTools: Record<string, string>; deliveryTools: string; agents: Record<string, AgentProvenance> }> {
  const tools = [];
  const agents: Record<string, AgentProvenance> = {};
  const checkTools: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const id of [...new Set(Object.values(config.supervisor!.roles))].sort()) {
    const agent = config.agents[id]!;
    signal.throwIfAborted();
    const health = await inspectAgent(agent, config.repoRoot, { signal, leaseDir, timeoutMs: config.budgets.stageTimeoutMs });
    if (!health.compatible || health.authenticated !== true) throw new Error(`Agent ${id} preflight: ${health.error}`);
    const exe = await resolveExecutable(agent.command[0]!);
    const files = [[exe, await fileHash(exe)]];
    // Hash an interpreter's entry script, not arbitrary output/log path args.
    for (const arg of agent.command.slice(1, 2)) {
      try { const path = resolve(config.repoRoot, arg); if ((await stat(path)).isFile()) files.push([path, await fileHash(path)]); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT" && (e as NodeJS.ErrnoException).code !== "ENOTDIR") throw e; }
    }
    tools.push({ id, version: health.version, files });
    agents[id] = { provider: agent.provider, command: agent.command.map(redact), version: health.version,
      executableHash: files[0]![1]!, agentConfigHash: digest(agent) };
  }
  const runtime = dirname(fileURLToPath(import.meta.url));
  for (const entry of (await readdir(runtime, { recursive: true })).sort()) {
    if (entry.endsWith(".js")) tools.push({ runtime: entry, hash: await fileHash(join(runtime, entry)) });
  }
  for (const role of ["define", "build", "review"]) tools.push({ role, hash: await fileHash(resolve(runtime, "../../templates", `${role}.md`)) });
  for (const check of config.checks) {
    checkTools[check.id] = check.notApplicableReason || check.mode === "dry_run" ? "not_run" : await checkToolHash(check.command, config.repoRoot, check.toolFiles);
    tools.push({ check: check.id, hash: checkTools[check.id] });
  }
  const deliveryTools=await deliveryToolsHash(config);tools.push({deliveryTools});
  return { hash: digest(tools), checkTools, deliveryTools, agents };
}
function requireSupervisor(config: ProjectConfig): void {
  const s = config.supervisor;
  if (!s || !Number.isSafeInteger(s.maxAttempts) || s.maxAttempts < 1 || !Number.isSafeInteger(s.runTimeoutMs) || s.runTimeoutMs < 1 || Object.values(s.roles).some(id => !config.agents[id]) || !s.roles.define || !s.roles.build || !s.roles.review) throw new Error("Explicit supervisor roles and budgets required");
  if (!config.capabilities.edit) throw new Error("Supervisor build requires delegated edit capability");
}
async function probeTools(store: StateStore, state: RunState, config: ProjectConfig, options: RunnerOptions): Promise<Awaited<ReturnType<typeof executionTools>> | null> {
  const controller = new AbortController(); const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(1, state.deadlineAt - Date.now()));
  try { return await executionTools(config, controller.signal, join(store.directory(state.id), "leases")); }
  catch (e) {
    await change(store, state, options.signal?.aborted ? "cancelled" : "blocked", `Preflight: ${redact((e as Error).message)}`, options);
    return null;
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
function parseState(raw: Record<string, unknown>): RunState {
  const state = raw as unknown as RunState;
  const statuses: RunStatus[] = ["queued", "defining", "implementing", "validating", "reviewing", "delivering", "completed", "failed", "blocked", "cancelled"];
  if (state.schemaVersion !== 1 || !statuses.includes(state.status) || !["defining", "implementing", "validating", "reviewing", "delivering"].includes(state.nextPhase) || !Number.isSafeInteger(state.revision) || !Number.isSafeInteger(state.deadlineAt) || !state.task?.id || !Array.isArray(state.attempts) || !Array.isArray(state.history) || !state.expected?.head || !state.expected?.treeHash || !state.configHash || !state.instructionsHash || !state.toolsHash) throw new Error("Corrupt supervisor state");
  for (const a of state.attempts) if (!a.id || !["define", "build", "review"].includes(a.stage) || !a.before?.treeHash || !a.artifactDir || typeof a.valid !== "boolean" || (a.result && (a.result.stage !== a.stage || a.result.taskId !== state.task.id))) throw new Error("Corrupt attempt checkpoint");
  return state;
}
async function noLiveLeases(store: StateStore): Promise<void> {
  let dirs: string[];
  try { dirs = await readdir(store.root); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
  for (const id of dirs.filter(id => /^[a-f0-9-]{36}$/.test(id))) {
    let files: string[];
    try { files = await readdir(join(store.directory(id), "leases")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    for (const file of files.filter(f => f.endsWith(".json"))) {
      const lease = JSON.parse(await readFile(join(store.directory(id), "leases", file), "utf8"));
      if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0) throw new Error("Ambiguous process lease");
      if (lease.closed !== true) throw new Error("Previous process guardian cleanup unconfirmed; recovery requires its receipt or inspection");
    }
  }
}
async function save(store: StateStore, state: RunState, options: RunnerOptions): Promise<void> {
  state.revision++; state.updatedAt = Date.now(); await store.write(state.id, state);
  await options.onCheckpoint?.(structuredClone(state));
}
async function change(store: StateStore, state: RunState, status: RunStatus, reason: string | null, options: RunnerOptions): Promise<RunState> {
  state.status = status; state.reason = reason;
  state.history.push({ at: Date.now(), status, reason }); await save(store, state, options); return state;
}
async function invalidate(store: StateStore, state: RunState, reason: string, options: RunnerOptions): Promise<RunState> {
  for (const attempt of state.attempts) attempt.valid = false;
  state.validation = null;
  state.acceptance = null;
  // Delivery receipts are historical facts. Never discard them to repeat an action.
  state.nextPhase = "defining";
  return change(store, state, "blocked", reason, options);
}
function gateMatches(receipt: GateReceipt, state: RunState): boolean {
  return Boolean(receipt && receipt.id && receipt.fingerprint === runFingerprint(state) && ["success", "needs_changes", "blocked"].includes(receipt.verdict) && Array.isArray(receipt.evidenceRefs) && receipt.evidenceRefs.length && receipt.evidenceRefs.every(x => typeof x === "string" && x.trim()) && typeof receipt.summary === "string");
}
function acceptanceContext(store: StateStore, state: RunState, config: ProjectConfig): AcceptanceContext {
  const implementation = [...state.attempts].reverse().find(a => a.stage === "build" && a.result?.status === "succeeded");
  return { config, snapshot: state.expected, fingerprint: runFingerprint(state), evidenceRoot: join(store.directory(state.id), "checks"), implementationSessionId: implementation?.result?.sessionId ?? null, toolHashes: state.checkToolHashes ?? {} };
}
async function validateCode(store: StateStore, state: RunState, config: ProjectConfig, signal: AbortSignal, options: RunnerOptions): Promise<GateReceipt> {
  const context = acceptanceContext(store, state, config);
  const evidence = await runChecks(config, state.expected.head, { artifactDir: context.evidenceRoot, snapshot: state.expected, fingerprint: context.fingerprint, signal,
    leaseDir: join(store.directory(state.id), "leases"), cached: state.checks ?? [], toolHashes: state.checkToolHashes ?? {}, onEvidence: async e => {
      state.checks ??= []; state.checks.push(e); await save(store, state, options);
    } });
  const assessment = await evaluateChecks(state.task, evidence, context);
  state.acceptance = { ...assessment, accepted: false, reasons: assessment.accepted ? ["Independent review pending"] : assessment.reasons };
  await save(store, state, options);
  return { id: randomUUID(), fingerprint: context.fingerprint, verdict: assessment.accepted ? "success" : assessment.retryable ? "needs_changes" : "blocked",
    summary: assessment.accepted ? "Configured checks passed; independent review required" : assessment.reasons.join("; "), evidenceRefs: evidence.length ? evidence.map(e => e.artifactDir) : ["profile.checks: empty"] };
}
async function drive(store: StateStore, state: RunState, config: ProjectConfig, options: RunnerOptions): Promise<RunState> {
  const controller = new AbortController(); const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(1, state.deadlineAt - Date.now()));
  try {
    for (;;) {
      if (options.signal?.aborted) return change(store, state, "cancelled", "Cancelled by operator", options);
      if (Date.now() >= state.deadlineAt) return change(store, state, "blocked", "Run deadline / time budget exhausted", options);
      if (controller.signal.aborted) return change(store, state, "cancelled", "Cancelled by operator", options);
      const consumption = usageBudgetReason(state, config.supervisor!.maxReportedTokens);
      if (consumption) return change(store, state, "blocked", consumption, options);
      const phase = state.nextPhase;
      await change(store, state, phase, null, options);
      if(phase==="delivering"&&config.delivery&&!options.gates?.deliver){
        const review=[...state.attempts].reverse().find(a=>a.stage==="review"&&a.valid)?.result;
        if(!review)return change(store,state,"blocked","Delivery requires independent review",options);
        try{
          const receipt=await deliver({runId:state.id,task:state.task,context:acceptanceContext(store,state,config),evidence:state.checks??[],review,
            artifactDir:join(store.directory(state.id),"delivery"),leaseDir:join(store.directory(state.id),"leases"),lockHeld:true,signal:controller.signal,
            ...(state.deliveryToolsHash?{expectedToolsHash:state.deliveryToolsHash}:{}),...(state.deliveryJournal?{journal:state.deliveryJournal}:{}),
            onCheckpoint:async journal=>{state.deliveryJournal=journal;await save(store,state,options);}});
          state.delivery=receipt;await save(store,state,options);
          if(Date.now()>=state.deadlineAt)return change(store,state,"blocked","Run deadline / time budget exhausted",options);
          if(controller.signal.aborted)return change(store,state,"cancelled","Cancelled by operator",options);
          return change(store,state,receipt.verdict==="success"?"completed":"blocked",receipt.verdict==="success"?null:receipt.summary,options);
        }catch(e){return change(store,state,options.signal?.aborted?"cancelled":"blocked",redact((e as Error).message),options);}
      }
      if (phase === "validating" || phase === "delivering") {
        if (phase === "delivering" && config.checks.length) {
          const review = [...state.attempts].reverse().find(a => a.stage === "review" && a.valid)?.result;
          if (!review) return change(store, state, "blocked", "Acceptance requires an independent review", options);
          state.acceptance = await evaluateAcceptance(state.task, state.checks ?? [], review, acceptanceContext(store, state, config));
          if (!state.acceptance.accepted) return change(store, state, "blocked", state.acceptance.reasons.join("; "), options);
        }
        if (phase === "delivering" && state.delivery) {
          if (state.delivery.verdict === "success" && state.delivery.fingerprint === runFingerprint(state)) return change(store, state, "completed", null, options);
          return change(store, state, "blocked", "Historical delivery exists; reconciliation required before further actions", options);
        }
        if (phase === "delivering" && state.deliveryIntent) return change(store, state, "blocked", "Delivery outcome unknown; reconciliation required before another action", options);
        const gate = phase === "validating" ? options.gates?.validate ?? (() => validateCode(store, state, config, controller.signal, options)) : options.gates?.deliver;
        if (!gate) return change(store, state, "blocked", `${phase === "validating" ? "Validation" : "Delivery"} capability not implemented (task ${phase === "validating" ? "4" : "5"})`, options);
        const beforeGate = await repositorySnapshot(config.repoRoot);
        if (digest(beforeGate) !== digest(state.expected)) return invalidate(store, state, "Worktree changed before gate; action not invoked", options);
        if (phase === "delivering") {
          state.deliveryIntent = { id: randomUUID(), fingerprint: runFingerprint(state) };
          await save(store, state, options); // unknown outcomes must never be replayed blindly
        }
        // Hooks are trusted supervisor integrations, never commands emitted by an agent.
        const receipt = await gate(structuredClone(state), controller.signal);
        if (phase === "delivering") { state.delivery = receipt; await save(store, state, options); }
        if (!gateMatches(receipt, state)) return change(store, state, "blocked", "Invalid gate receipt or fingerprint", options);
        const after = await repositorySnapshot(config.repoRoot);
        if (digest(after) !== digest(state.expected)) return invalidate(store, state, "Worktree changed during gate", options);
        if (phase === "delivering") state.delivery = receipt; else state.validation = receipt;
        if (Date.now() >= state.deadlineAt) return change(store, state, "blocked", "Run deadline / time budget exhausted", options);
        if (controller.signal.aborted) return change(store, state, "cancelled", "Cancelled by operator", options);
        if (receipt.verdict === "blocked") return change(store, state, "blocked", receipt.summary, options);
        if (receipt.verdict === "needs_changes") { state.nextPhase = "implementing"; state.validation = null; }
        else if (phase === "validating") state.nextPhase = "reviewing";
        else return change(store, state, "completed", null, options);
        await save(store, state, options); continue;
      }
      if (state.attempts.length >= config.supervisor!.maxAttempts) return change(store, state, "blocked", "Attempt budget exhausted", options);
      const stage: Stage = phase === "defining" ? "define" : phase === "implementing" ? "build" : "review";
      const before = await repositorySnapshot(config.repoRoot);
      if (digest(before) !== digest(state.expected)) return invalidate(store, state, "Worktree changed before stage", options);
      let verification: import("./contracts.js").VerificationContext | undefined;
      if (stage === "review" || (stage === "build" && state.checks?.length)) {
        try { verification = await buildVerificationContext(config, before, runFingerprint(state), state.checks ?? [], controller.signal, join(store.directory(state.id), "leases")); }
        catch (e) { return change(store, state, "blocked", redact((e as Error).message), options); }
      }
      const attempt = { id: randomUUID(), stage, agentId: config.supervisor!.roles[stage], startedAt: Date.now(), finishedAt: null as number | null,
        before, after: null as RunState["expected"] | null, artifactDir: "", result: null as RunState["attempts"][number]["result"], valid: false };
      attempt.artifactDir = join(store.directory(state.id), "stages", attempt.id);
      state.attempts.push(attempt); await save(store, state, options); // intent before launch
      const result = await runStage({ config: { ...config, budgets: { ...config.budgets, stageTimeoutMs: Math.max(1, Math.min(config.budgets.stageTimeoutMs, state.deadlineAt - Date.now())) } },
        agentId: attempt.agentId, stage, task: state.task, artifactDir: attempt.artifactDir,
        leaseDir: join(store.directory(state.id), "leases"), priorStages: state.attempts.flatMap(a => a.result ? [a.result] : []), ...(verification ? { verification } : {}) }, controller.signal);
      attempt.result = result; attempt.finishedAt = Date.now(); attempt.after = await repositorySnapshot(config.repoRoot);
      if (attempt.after.head !== before.head || (stage !== "build" && digest(attempt.after) !== digest(before))) {
        await save(store, state, options); return invalidate(store, state, "Agent modified read-only stage or Git HEAD", options);
      }
      state.expected = attempt.after;
      if (result.status !== "succeeded" || !result.payload) {
        await save(store, state, options);
        return change(store, state, result.status === "cancelled" ? "cancelled" : "failed", result.error ?? result.status, options);
      }
      attempt.valid = true;
      if (stage === "build") { state.validation = null; state.acceptance = null; for (const old of state.attempts.slice(0, -1)) if (old.stage !== "define") old.valid = false; }
      const reviewRequiresChanges = stage === "review" && (result.payload.verdict === "needs_changes" || result.payload.findings?.some(f => f.severity === "critical" || f.severity === "important"));
      if (stage === "review" && config.checks.length) {
        state.acceptance = await evaluateAcceptance(state.task, state.checks ?? [], result, acceptanceContext(store, state, config));
        if (!state.acceptance.accepted && result.payload.verdict === "success" && !reviewRequiresChanges) {
          await save(store, state, options); return change(store, state, "blocked", state.acceptance.reasons.join("; "), options);
        }
      }
      if (result.payload.verdict === "blocked") { await save(store, state, options); return change(store, state, "blocked", result.payload.summary, options); }
      if (stage === "review") state.nextPhase = reviewRequiresChanges ? "implementing" : "delivering";
      else state.nextPhase = stage === "define" ? "implementing" : "validating";
      await save(store, state, options); // result and continuation committed together
    }
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}
export async function runTask(task: TaskSpec, config: ProjectConfig, options: RunnerOptions = {}): Promise<RunState> {
  requireSupervisor(config);
  const store = new StateStore(options.stateDir ?? resolve(".artifacts/runs"));
  await assertStateLocation(config.repoRoot, store.root);
  const initial = await repositorySnapshot(config.repoRoot);
  const id = randomUUID(); const release = await acquireLock(join(initial.gitDir, "agent-workflow.lock"), id, join(store.directory(id), "leases"));
  let current: RunState | undefined;
  try {
    await noLiveLeases(store);
    const expected = await repositorySnapshot(config.repoRoot);
    if(options.acceptedBase)await verifyAcceptedBase(options.acceptedBase,config.repoRoot);
    else if (expected.dirty) throw new Error("Run requires a clean Git worktree; preserve user changes and use an isolated checkout");
    const now = Date.now();
    const state: RunState = { schemaVersion: 1, id, revision: 0, projectId: config.projectId, task: structuredClone(task), status: "queued", nextPhase: "defining", reason: null,
      createdAt: now, updatedAt: now, deadlineAt: now + config.supervisor!.runTimeoutMs, configHash: digest(config), instructionsHash: await instructionsHash(config), toolsHash: "unverified",
      expected, attempts: [], checks: [], acceptance: null, validation: null, delivery: null, deliveryIntent: null, history: [{ at: now, status: "queued", reason: null }],
      telemetry: { schemaVersion: 1, controller: "supervisor", invocations: [{ id: randomUUID(), startedAt: now, finishedAt: null }], interventions: [], agents: {}, ...(options.benchmark ? { benchmark: structuredClone(options.benchmark) } : {}) } };
    current = state;
    await save(store, state, options);
    const hash = await probeTools(store, state, config, options); if (!hash) return state;
    state.toolsHash = hash.hash; state.checkToolHashes = hash.checkTools; state.deliveryToolsHash=hash.deliveryTools; state.telemetry!.agents = hash.agents; await save(store, state, options);
    return await drive(store, state, config, options);
  } finally { try { if (current) await finishInvocation(store, current); } finally { await release(); } }
}
export async function resumeRun(runId: string, config: ProjectConfig, options: RunnerOptions = {}): Promise<RunState> {
  requireSupervisor(config);
  const store = new StateStore(options.stateDir ?? resolve(".artifacts/runs"));
  await assertStateLocation(config.repoRoot, store.root);
  const repository = await repositorySnapshot(config.repoRoot);
  const release = await acquireLock(join(repository.gitDir, "agent-workflow.lock"), runId, join(store.directory(runId), "leases"));
  let current: RunState | undefined;
  try {
    await noLiveLeases(store);
    const state = parseState(await store.read(runId));
    if (state.telemetry?.controller === "direct") throw new Error("Direct workflow has a measurement ledger, not a resumable continuation");
    if (state.projectId !== config.projectId || state.expected.root !== repository.root) throw new Error("Run belongs to another project/worktree");
    if (state.status === "completed") return state; // immutable historical receipt
    state.telemetry ??= { schemaVersion: 1, invocations: [{ id: "legacy-unmeasured", startedAt: state.createdAt, finishedAt: null }], interventions: [], agents: {} };
    state.telemetry.invocations.push({ id: randomUUID(), startedAt: Date.now(), finishedAt: null });
    state.telemetry.interventions.push({ id: randomUUID(), at: Date.now(), actor: options.resumeActor ?? "operator", needed: null, reason: state.reason ?? "Resume requested" });
    current = state; await save(store, state, options);
    if (state.configHash !== digest(config)) return invalidate(store, state, "Configuration changed; earlier evidence invalidated", options);
    if (Date.now() >= state.deadlineAt) return change(store, state, "blocked", "Run deadline / time budget exhausted", options);
    if (state.instructionsHash !== await instructionsHash(config)) return invalidate(store, state, "Instructions changed; earlier evidence invalidated", options);
    const hash = await probeTools(store, state, config, options); if (!hash) return state;
    if (state.toolsHash === "unverified" && state.attempts.length === 0) { state.toolsHash = hash.hash; state.checkToolHashes = hash.checkTools; state.deliveryToolsHash=hash.deliveryTools; await save(store, state, options); }
    else if (state.toolsHash !== hash.hash) return invalidate(store, state, "Tools changed; earlier evidence invalidated", options);
    state.telemetry.agents = hash.agents;
    const actual = await repositorySnapshot(config.repoRoot);
    const interrupted = state.attempts.at(-1);
    if (interrupted && !interrupted.finishedAt) {
      // No result checkpoint: edits cannot be attributed safely after a hard crash.
      if (digest(actual) !== digest(state.expected)) return invalidate(store, state, "Worktree changed during interrupted stage; inspect partial edits before retry", options);
      interrupted.finishedAt = Date.now(); interrupted.valid = false;
      await save(store, state, options);
    }
    if (digest(actual) !== digest(state.expected)) return invalidate(store, state, "Worktree changed since checkpoint; earlier evidence invalidated", options);
    return await drive(store, state, config, options);
  } catch (e) { throw new Error(redact((e as Error).message)); }
  finally { try { if (current) await finishInvocation(store, current); } finally { await release(); } }
}
async function finishInvocation(store: StateStore, state: RunState): Promise<void> {
  const invocation = state.telemetry?.invocations.at(-1);
  if (invocation && invocation.finishedAt === null) {
    invocation.finishedAt = Date.now(); state.updatedAt = invocation.finishedAt; state.revision++;
    await store.write(state.id, state); // closing measurement is not a new agent/gate checkpoint
  }
}
