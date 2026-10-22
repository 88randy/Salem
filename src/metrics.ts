import type { RunState, StageResult } from "./contracts.js";
import type { CohortMetrics, ComparisonReport, MetricTotal, RunMetrics, UsageSummary } from "./metrics-contracts.js";
import { digest } from "./state-store.js";

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
interface Reading { value: number | null; group: string | null; complete: boolean }
function total(readings: Reading[]): MetricTotal {
  let sum = 0, reported = 0, complete = true;
  const previous = new Map<string, number>();
  for (const r of readings) {
    if (!finite(r.value)) { complete = false; continue; }
    let delta = r.value;
    if (r.group) {
      const before = previous.get(r.group) ?? 0;
      if (r.value < before) complete = false; // reset or inconsistent cumulative observation
      delta = Math.max(0, r.value - before); previous.set(r.group, Math.max(before, r.value));
    }
    sum += delta; reported++; complete &&= r.complete;
  }
  return { value: complete && reported === readings.length && readings.length > 0 ? sum : null,
    knownTotal: reported ? sum : null, reported, expected: readings.length };
}
function sumNullable(values: (number | null)[]): number | null {
  return values.every(finite) ? (values as number[]).reduce((a,b) => a+b, 0) : null;
}
type UsageResult=Pick<StageResult,"provider"|"sessionId"|"status"|"usage">;
function usage(attempts: readonly {result:UsageResult|null}[]): UsageSummary {
  const results = attempts.map(a => a.result);
  const counters = new Map<string,number>();
  let inconsistentTokens = false;
  for (const r of results) {
    if (!r?.sessionId || r.usage.accounting?.tokenScope !== "session_cumulative") continue;
    for (const [field,value] of Object.entries({input:r.usage.inputTokens,output:r.usage.outputTokens,cacheRead:r.usage.cachedInputTokens,cacheCreation:r.usage.accounting.cacheCreationInputTokens})) {
      if (!finite(value)) continue;
      const key=`${r.provider}:${r.sessionId}:${field}`,prior=counters.get(key);
      if (prior !== undefined && value < prior) inconsistentTokens=true;
      counters.set(key,value);
    }
  }
  const reading = (r: UsageResult | null, value: number | null, cost = false): Reading => {
    const scope = cost ? r?.usage.accounting?.costScope ?? (r?.provider === "claude" ? "session_cumulative" : "invocation") : r?.usage.accounting?.tokenScope;
    const cumulative = scope === "session_cumulative";
    return { value: cumulative && !r?.sessionId ? null : value,
      group: cumulative ? `${r?.provider}:${r?.sessionId}` : null,
      complete: r?.usage.accounting?.complete !== false && r?.status !== "cancelled" && r?.status !== "timed_out" && (cost || !inconsistentTokens) };
  };
  const input = (r: UsageResult | null) => {
    if (!r) return null;
    const u = r.usage;
    return u.accounting?.inputIncludesCache === false
      ? sumNullable([u.inputTokens, u.cachedInputTokens, u.accounting.cacheCreationInputTokens]) : u.inputTokens;
  };
  const tokens = (get: (r: UsageResult | null) => number | null) => total(results.map(r => reading(r, get(r))));
  const kinds = new Set(results.flatMap(r => r && finite(r.usage.costUsd) && r.usage.costKind !== "unavailable" ? [r.usage.costKind] : []));
  return { inputTokens: tokens(input), outputTokens: tokens(r => r?.usage.outputTokens ?? null),
    cachedInputTokens: tokens(r => r?.usage.cachedInputTokens ?? null),
    cacheCreationInputTokens: tokens(r => r?.usage.accounting?.cacheCreationInputTokens ?? null),
    totalTokens: tokens(r => sumNullable([input(r), r?.usage.outputTokens ?? null])),
    costUsd: total(results.map(r => reading(r, r?.usage.costKind === "unavailable" ? null : r?.usage.costUsd ?? null, true))),
    costKind: kinds.size > 1 ? "mixed" : [...kinds][0] ?? "unavailable",
    models: [...new Set(results.flatMap(r => r?.usage.model ? [r.usage.model] : []))].sort(),
    sources: [...new Set(results.map(r => r?.usage.accounting?.source ?? "legacy_or_unavailable"))].sort(), observations: results.length };
}
function active(run: RunState): { value: number | null; confirmed: number } {
  if (!run.telemetry) return { value: null, confirmed: 0 };
  const intervals = run.telemetry.invocations.filter(i => i.finishedAt !== null).map(i => {
    if (!finite(i.startedAt) || !finite(i.finishedAt) || i.finishedAt < i.startedAt) throw new Error("Invalid active interval");
    return [i.startedAt, i.finishedAt] as [number,number];
  }).sort((a,b) => a[0]-b[0]);
  let sum = 0, end = 0;
  for (const [a,b] of intervals) { sum += Math.max(0, b-Math.max(a,end)); end = Math.max(end,b); }
  return { value: run.telemetry.invocations.some(i => i.finishedAt === null) ? null : sum, confirmed: sum };
}
export function summarizeRun(run: RunState): RunMetrics {
  if (run.schemaVersion !== 1 || !run.id || !run.task?.id || !Array.isArray(run.attempts) || !Array.isArray(run.history) || !finite(run.createdAt) || !finite(run.updatedAt) || run.updatedAt < run.createdAt) throw new Error("Invalid run for metrics");
  if (new Set(run.attempts.map(a => a.id)).size !== run.attempts.length) throw new Error("Duplicate attempt id");
  if (run.attempts.some(a => a.result && !finite(a.result.durationMs)) || (run.checks ?? []).some(e => !finite(e.durationMs))) throw new Error("Invalid duration measurement");
  const codeAccepted = run.acceptance?.accepted === true;
  const delivered = codeAccepted && run.delivery?.verdict === "success" && run.delivery.fingerprint === run.acceptance?.fingerprint;
  const accepted = run.status === "completed" && delivered;
  const a = active(run), benchmark = run.telemetry?.benchmark ?? null;
  const setupMs = benchmark?.setupMs ?? null;
  if (setupMs !== null && !finite(setupMs)) throw new Error("Invalid setup measurement");
  const wallMs = run.updatedAt-run.createdAt;
  const wallComplete = ["completed","failed","blocked","cancelled"].includes(run.status) && !run.telemetry?.invocations.some(i=>i.finishedAt===null);
  const executionMs = benchmark?.executionWallMs ?? wallMs;
  if (!finite(executionMs)) throw new Error("Invalid execution measurement");
  const iterations = { define: 0, build: 0, review: 0 };
  const failures = { infrastructure: 0, task: 0, protocol: 0, policy: 0, unknown: 0, cancellations: 0 };
  let blockingFindings = 0, regressions = 0, failedChecks = 0;
  for (const attempt of run.attempts) {
    iterations[attempt.stage]++;
    const r = attempt.result;
    if (!r) { failures.unknown++; continue; }
    blockingFindings += r.payload?.findings?.filter(f => f.severity === "critical" || f.severity === "important").length ?? 0;
    if (r.status === "cancelled") failures.cancellations++;
    else if (r.status !== "succeeded") failures[r.failureKind ?? "unknown"]++;
    else if (r.payload?.verdict === "needs_changes") failures.task++;
    else if (r.payload?.verdict === "blocked") failures.unknown++;
  }
  const checks = new Map((run.checks ?? []).map(e => [e.id, e]));
  const previous = new Map<string, { status: string; fingerprint: string }>();
  for (const e of checks.values()) {
    if (e.status === "failed") { failedChecks++; failures[e.failureKind === "code" ? "task" : e.failureKind ?? "unknown"]++; }
    const prior = previous.get(e.checkId);
    if (e.execution === "actual") {
      if (e.status === "failed" && prior?.status === "passed" && prior.fingerprint !== e.fingerprint) regressions++;
      previous.set(e.checkId, e);
    }
  }
  if (!run.attempts.length && run.status === "blocked" && /^Preflight:/i.test(run.reason ?? "")) failures.infrastructure++;
  if (run.status === "cancelled" && !failures.cancellations) failures.cancellations++;
  if (run.status === "failed" && !Object.values(failures).some(Boolean)) failures.unknown++;
  const events = run.telemetry?.interventions.filter(e => e.actor === "operator");
  const observation = usage(run.attempts);
  const limitations: string[] = [];
  if (!run.telemetry) limitations.push("Legacy checkpoint: active time, human intervention and agent provenance were not captured.");
  if (a.value === null) limitations.push("Active duration is unavailable; an unclosed invocation is not assumed to include the recovery pause.");
  if (observation.costUsd.value === null) limitations.push("Full cost is unavailable; knownTotal is only a reported subtotal, never zero spend.");
  if (observation.models.length === 0 || run.attempts.some(x => !x.result?.usage.model)) limitations.push("Effective model is not fully reported.");
  if (observation.sources.includes("legacy_or_unavailable")) limitations.push("Some usage lacks explicit scope or source; inspect original stage artifacts.");
  return { schemaVersion: 1, id: run.id, projectId: run.projectId, taskId: run.task.id, status: run.status, accepted, codeAccepted, delivered,
    timing: { wallMs, wallComplete, activeMs: a.value, confirmedActiveMs: a.confirmed,
      agentMs: run.attempts.reduce((n,x) => n+(x.result?.durationMs ?? 0),0), checksMs: [...checks.values()].reduce((n,e) => n+e.durationMs,0),
      setupMs, totalMs: setupMs === null || !wallComplete ? null : executionMs+setupMs }, iterations, quality: { failedChecks, regressions, blockingFindings }, failures,
    usage: observation, interventions: { observed: events ? events.length : null,
      necessary: events && !events.some(e => e.needed === null) && (accepted || events.length > 0) ? events.filter(e => e.needed).length : null },
    provenance: { repositoryRoot: run.expected.root, baseSha: run.attempts[0]?.before.head ?? run.expected.head, finalSha: run.deliveryJournal?.releaseSha ?? run.deliveryJournal?.commitSha ?? null,
      configHash: run.configHash, instructionsHash: run.instructionsHash, toolsHash: run.toolsHash,
      agents: run.telemetry?.agents ?? {}, benchmark }, limitations };
}
function combineUsage(rows: RunMetrics[]): UsageSummary {
  const keys = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheCreationInputTokens", "totalTokens", "costUsd"] as const;
  const sums = Object.fromEntries(keys.map(k => {
    const values = rows.map(r => r.usage[k]);
    return [k, { value: rows.length ? sumNullable(values.map(v => v.value)) : null,
      knownTotal: values.some(v => v.knownTotal !== null) ? values.reduce((n,v) => n+(v.knownTotal ?? 0),0) : null,
      reported: values.reduce((n,v) => n+v.reported,0), expected: values.reduce((n,v) => n+v.expected,0) }];
  })) as Pick<UsageSummary, typeof keys[number]>;
  const kinds = new Set(rows.map(r => r.usage.costKind).filter(k => k !== "unavailable"));
  return { ...sums, costKind: kinds.size > 1 ? "mixed" : [...kinds][0] ?? "unavailable",
    models: [...new Set(rows.flatMap(r => r.usage.models))].sort(), sources: [...new Set(rows.flatMap(r => r.usage.sources))].sort(),
    observations: rows.reduce((n,r) => n+r.usage.observations,0) };
}
function cohort(rows: RunMetrics[]): CohortMetrics {
  const accepted = rows.filter(r => r.accepted).length;
  return { total: rows.length, accepted, failed: rows.filter(r => r.status === "failed").length, blocked: rows.filter(r => r.status === "blocked").length,
    cancelled: rows.filter(r => r.status === "cancelled").length, unmeasured: 0, successRate: rows.length ? accepted/rows.length : null,
    wallMs: rows.reduce((n,r) => n+r.timing.wallMs,0), totalMs: rows.length ? sumNullable(rows.map(r => r.timing.totalMs)) : null,
    activeMs: rows.length ? sumNullable(rows.map(r => r.timing.activeMs)) : null, usage: combineUsage(rows) };
}
export function compareRuns(baseline: RunMetrics[], candidate: RunMetrics[]): ComparisonReport {
  const ids = [...baseline,...candidate].map(r => r.id);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate run; comparisons require independent executions");
  const issues: string[] = [], paired: ComparisonReport["paired"] = [];
  let incompatible = false, partial = false;
  const fail = (message: string) => { incompatible = true; issues.push(message); };
  const note = (message: string) => { partial = true; issues.push(message); };
  const providers = new Set([...baseline,...candidate].map(r => r.provenance.benchmark?.provider).filter(Boolean));
  if (providers.size > 1) fail("Compare workflow modes separately per provider; pooled providers are not comparable.");
  const key = (r: RunMetrics) => `${r.provenance.benchmark?.provider ?? "unknown"}:${r.taskId}`;
  const left = new Map(baseline.map(r => [key(r),r])), right = new Map(candidate.map(r => [key(r),r]));
  if (left.size !== baseline.length || right.size !== candidate.length) fail("Repeated task/provider in one cohort; use separate replicate comparisons.");
  if (!baseline.length || !candidate.length) fail("Both cohorts are required.");
  for (const k of new Set([...left.keys(),...right.keys()])) {
    const a = left.get(k), b = right.get(k);
    if (!a || !b) { fail(`Missing paired task: ${k}`); continue; }
    const am = a.provenance.benchmark, bm = b.provenance.benchmark;
    if (!a.timing.wallComplete || !b.timing.wallComplete) note(`Incomplete timing observation: ${k}`);
    if (a.provenance.repositoryRoot === b.provenance.repositoryRoot) fail(`Reused clone: ${k}`);
    for (const field of ["baseSha", "instructionsHash", "toolsHash"] as const) if (a.provenance[field] !== b.provenance[field]) fail(`Different observed ${field}: ${k}`);
    if (!am || !bm) { note(`Missing fixed protocol: ${k}`); continue; }
    if (am.mode !== "direct" || bm.mode !== "framework") fail(`Incorrect cohort modes: ${k}`);
    if (am.baseSha !== a.provenance.baseSha || bm.baseSha !== b.provenance.baseSha) fail(`Declared base differs from observed base: ${k}`);
    for (const field of ["suiteId", "protocolHash", "caseId", "provider", "baseSha", "acceptanceHash", "agentConfigHash", "limitsHash", "environment"] as const) {
      if (am[field] !== bm[field]) fail(`Different ${field}: ${k}`);
    }
    if (digest(a.provenance.agents) !== digest(b.provenance.agents)) fail(`Different CLI/version/configuration: ${k}`);
    if (!a.usage.models.length || !b.usage.models.length || a.limitations.includes("Effective model is not fully reported.") || b.limitations.includes("Effective model is not fully reported.")) note(`Effective model unverified: ${k}`);
    else if (digest(a.usage.models) !== digest(b.usage.models)) fail(`Different reported models: ${k}`);
    paired.push({ taskId: a.taskId, baseline: a.id, candidate: b.id,
      totalDeltaMs: a.timing.totalMs !== null && b.timing.totalMs !== null ? b.timing.totalMs-a.timing.totalMs : null });
  }
  return { schemaVersion: 1, baseline: cohort(baseline), candidate: cohort(candidate),
    comparability: incompatible ? "incompatible" : partial ? "partial" : "verified", issues, paired,
    limitations: ["Exploratory sample; no statistical significance or causal savings claim.",
      "Compare modes separately per provider. Tokens and estimated costs are not equivalent billing across providers.",
      "Direct mode automates the explicit workflow; observed interventions do not measure a human developer's work."] };
}
export function usageBudgetReason(run: {attempts:readonly {result:UsageResult|null}[]}, limit: number | undefined): string | null {
  if (limit === undefined || run.attempts.length === 0) return null;
  const tokens = usage(run.attempts).totalTokens;
  if (tokens.value === null) return "Reported token consumption unavailable/unknown; consumption budget prevents another stage";
  return tokens.value >= limit ? "Reported token consumption budget exhausted" : null;
}
