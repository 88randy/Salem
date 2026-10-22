import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeRun, compareRuns, usageBudgetReason } from "../src/metrics.js";
import { measuredRun, metricAttempt } from "./metrics-fixture.js";
import type { CheckEvidence } from "../src/contracts.js";

test("missing cost remains unavailable and partial totals never look complete", () => {
  const run = measuredRun(); run.attempts = [metricAttempt("a"), metricAttempt("b", { costUsd: 0.12, costKind: "estimated" })];
  const m = summarizeRun(run);
  assert.equal(m.usage.costUsd.value, null); assert.equal(m.usage.costUsd.knownTotal, 0.12);
  assert.equal(m.usage.costUsd.reported, 1); assert.equal(m.usage.costKind, "estimated");
});
test("session cumulative consumption uses differences while independent sessions are added", () => {
  const run = measuredRun(), accounting = { tokenScope: "session_cumulative" as const, costScope: "session_cumulative" as const,
    inputIncludesCache: true, cacheCreationInputTokens: 0, source: "reported", complete: true };
  run.attempts = [metricAttempt("a", { inputTokens: 100, outputTokens: 10, costUsd: 0.1, costKind: "estimated", accounting }),
    metricAttempt("b", { inputTokens: 150, outputTokens: 15, costUsd: 0.15, costKind: "estimated", accounting }),
    metricAttempt("c", { inputTokens: 20, outputTokens: 2, costUsd: 0.02, costKind: "estimated", accounting })];
  run.attempts[1]!.result!.sessionId = "a";
  const m = summarizeRun(run);
  assert.equal(m.usage.inputTokens.value, 170); assert.equal(m.usage.outputTokens.value, 17);
  assert.ok(Math.abs(m.usage.costUsd.value! - 0.17) < 1e-10);
  assert.equal(m.usage.costKind, "estimated");
});
test("invalidated and failed attempts retain usage and failure provenance", () => {
  const run = measuredRun(); run.attempts = [metricAttempt("failed"), metricAttempt("fixed")];
  Object.assign(run.attempts[0]!, { valid: false });
  Object.assign(run.attempts[0]!.result!, { status: "failed", failureKind: "infrastructure", error: "transport failed" });
  const m = summarizeRun(run); assert.equal(m.usage.inputTokens.value, 20);
  assert.equal(m.failures.infrastructure, 1); assert.equal(m.iterations.build, 2);
});
test("active time excludes the pause between resume invocations and never guesses crash duration", () => {
  const run = measuredRun(); const m = summarizeRun(run);
  assert.equal(m.timing.wallMs, 10000); assert.equal(m.timing.activeMs, 4000); assert.equal(m.timing.totalMs, 10200);
  run.telemetry!.invocations[0]!.finishedAt = null;
  const crash = summarizeRun(run); assert.equal(crash.timing.activeMs, null); assert.equal(crash.timing.confirmedActiveMs, 2000);
});
test("code acceptance without a matching confirmed delivery never counts as accepted success", () => {
  const run = measuredRun(); run.delivery!.fingerprint = "another-proof";
  const m = summarizeRun(run); assert.equal(m.accepted, false); assert.equal(m.codeAccepted, true);
});
test("regressions and blocking review findings survive later successful correction", () => {
  const run = measuredRun(); run.attempts = [metricAttempt("review", {}, "review")];
  run.attempts[0]!.result!.payload!.findings = [{ severity: "important", description: "fix it" }];
  run.checks = [{ id: "1", checkId: "existing", status: "passed", execution: "actual", durationMs: 30, fingerprint: "one" },
    { id: "2", checkId: "existing", status: "failed", execution: "actual", durationMs: 40, fingerprint: "two", failureKind: "code" }] as CheckEvidence[];
  const m = summarizeRun(run); assert.equal(m.quality.regressions, 1); assert.equal(m.quality.failedChecks, 1);
  assert.equal(m.quality.blockingFindings, 1); assert.equal(m.failures.task, 1);
});
test("failures and cancellations stay in the comparison denominator", () => {
  const a = measuredRun(), b = measuredRun(), c = measuredRun();
  for (const r of [a,b,c]) r.attempts = [metricAttempt(r.id)];
  a.telemetry!.benchmark!.mode = "direct"; b.status = "failed"; c.status = "cancelled";
  b.task.id = "feature"; b.telemetry!.benchmark!.caseId = "feature";
  c.task.id = "refactor"; c.telemetry!.benchmark!.caseId = "refactor";
  const report = compareRuns([], [a,b,c].map(summarizeRun));
  assert.equal(report.candidate.total, 3); assert.equal(report.candidate.accepted, 1);
  assert.equal(report.candidate.failed, 1); assert.equal(report.candidate.cancelled, 1);
  assert.equal(report.candidate.successRate, 1/3);
});
test("different SHA or acceptance cannot be presented as comparable and duplicate runs are rejected", () => {
  const a = measuredRun(), b = measuredRun(); a.telemetry!.benchmark!.mode = "direct";
  a.attempts = [metricAttempt("a")]; b.attempts = [metricAttempt("b")];
  b.telemetry!.benchmark!.baseSha = "different";
  assert.equal(compareRuns([summarizeRun(a)], [summarizeRun(b)]).comparability, "incompatible");
  assert.throws(() => compareRuns([summarizeRun(a)], [summarizeRun(a)]), /duplicate|independent/i);
});
test("unreported model and absent human telemetry remain explicitly unknown", () => {
  const a = measuredRun(), b = measuredRun(); a.telemetry!.benchmark!.mode = "direct";
  a.attempts = [metricAttempt("a", { model: null })]; b.attempts = [metricAttempt("b", { model: null })];
  assert.equal(compareRuns([summarizeRun(a)], [summarizeRun(b)]).comparability, "partial");
  delete a.telemetry;
  const legacy = summarizeRun(a); assert.equal(legacy.interventions.observed, null); assert.equal(legacy.timing.activeMs, null);
});
test("consumption guard stops another stage on exceeded or unmeasured usage", () => {
  const run = measuredRun(); run.attempts = [metricAttempt("a", { inputTokens: 100, outputTokens: 10 })];
  assert.match(usageBudgetReason(run, 100) ?? "", /budget/i);
  run.attempts[0]!.result!.usage.inputTokens = null;
  assert.match(usageBudgetReason(run, 100) ?? "", /unknown|unavailable|unmeasured/i);
  assert.equal(usageBudgetReason(run, undefined), null);
});
test("comparison rejects reused clones and pooling different providers", () => {
  const a = measuredRun(), b = measuredRun(); a.telemetry!.benchmark!.mode = "direct";
  a.attempts = [metricAttempt("a")]; b.attempts = [metricAttempt("b")];
  b.expected.root = a.expected.root;
  assert.equal(compareRuns([summarizeRun(a)], [summarizeRun(b)]).comparability,"incompatible");
  const c = measuredRun(), d = measuredRun(); c.telemetry!.benchmark!.mode = "direct";
  c.telemetry!.benchmark!.provider="claude"; d.telemetry!.benchmark!.provider="claude";
  c.attempts=[metricAttempt("c")]; d.attempts=[metricAttempt("d")];
  b.expected.root="another-root";
  assert.equal(compareRuns([a,c].map(summarizeRun),[b,d].map(summarizeRun)).comparability,"incompatible");
});
test("negative duration cannot make a failed run look faster", () => {
  const run=measuredRun();run.attempts=[metricAttempt("negative")];run.attempts[0]!.result!.durationMs=-1;
  assert.throws(()=>summarizeRun(run),/duration|timing/i);
});
test("changed instructions or runtime proof invalidate an otherwise identical comparison", () => {
  const a=measuredRun(),b=measuredRun();a.telemetry!.benchmark!.mode="direct";
  a.attempts=[metricAttempt("a")];b.attempts=[metricAttempt("b")];
  b.instructionsHash="changed";
  assert.equal(compareRuns([summarizeRun(a)],[summarizeRun(b)]).comparability,"incompatible");
  b.instructionsHash=a.instructionsHash;b.toolsHash="changed-runtime";
  assert.equal(compareRuns([summarizeRun(a)],[summarizeRun(b)]).comparability,"incompatible");
});
test("one cumulative dimension resetting invalidates total and stops the consumption guard", () => {
  const run=measuredRun(), accounting={tokenScope:"session_cumulative" as const,costScope:"session_cumulative" as const,inputIncludesCache:true,cacheCreationInputTokens:0,source:"reported",complete:true};
  run.attempts=[metricAttempt("a",{inputTokens:100,outputTokens:10,accounting}),metricAttempt("b",{inputTokens:90,outputTokens:40,accounting})];
  run.attempts[1]!.result!.sessionId="a";
  assert.equal(summarizeRun(run).usage.inputTokens.value,null);
  assert.equal(summarizeRun(run).usage.totalTokens.value,null);
  assert.match(usageBudgetReason(run,1000)??"",/unknown|unavailable/i);
});
test("cancelled execution preserves reported subtotal without certifying full consumption", () => {
  const run=measuredRun();run.status="cancelled";run.attempts=[metricAttempt("partial",{costUsd:0.1,costKind:"estimated"})];
  run.attempts[0]!.result!.status="cancelled";
  const m=summarizeRun(run);assert.equal(m.usage.totalTokens.value,null);assert.equal(m.usage.totalTokens.knownTotal,12);
  assert.equal(m.usage.costUsd.value,null);assert.equal(m.usage.costUsd.knownTotal,0.1);
});
