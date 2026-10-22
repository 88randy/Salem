import { test } from "node:test";
import assert from "node:assert/strict";
import { observeUsage } from "../src/adapters/usage.js";
import { summarizeRun } from "../src/metrics.js";
import { measuredRun, metricAttempt } from "./metrics-fixture.js";
import { runStage } from "../src/adapters/index.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Claude whole-tree usage includes cache and is session cumulative, with estimated cost", () => {
  const observation = observeUsage("claude", JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: "session",
    modelUsage: { model: { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 100, cacheCreationInputTokens: 20 } }, total_cost_usd: 0.25 }));
  assert.equal(observation.usage.inputTokens, 10); assert.equal(observation.usage.accounting?.tokenScope, "session_cumulative");
  const r = measuredRun(); r.attempts = [metricAttempt("a", observation.usage)]; r.attempts[0]!.result!.provider = "claude";
  assert.equal(summarizeRun(r).usage.inputTokens.value, 130); assert.equal(summarizeRun(r).usage.totalTokens.value, 134);
  assert.equal(observation.usage.costKind, "estimated");
});
test("Codex sums turn observations and retains known usage before a failed turn", () => {
  const stdout = [{ type: "thread.started", thread_id: "session" }, { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 2, cached_input_tokens: 3 } },
    { type: "turn.completed", usage: { input_tokens: 20, output_tokens: 4, cached_input_tokens: 5 } }, { type: "turn.failed" }].map(x => JSON.stringify(x)).join("\n");
  const o = observeUsage("codex", stdout); assert.equal(o.usage.inputTokens, 30); assert.equal(o.usage.outputTokens, 6);
  assert.equal(o.usage.costUsd, null); assert.equal(o.usage.accounting?.complete, false);
});
test("a started but unfinished Codex turn cannot leave the earlier usage complete", () => {
  const events=[{type:"thread.started",thread_id:"session"},{type:"turn.started"},{type:"turn.completed",usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}},{type:"turn.started"}];
  const o=observeUsage("codex",events.map(e=>JSON.stringify(e)).join("\n"));
  assert.equal(o.usage.inputTokens,10);assert.equal(o.usage.accounting?.complete,false);
});
test("reported Codex cache writes are preserved while absent cache-write data stays unknown", () => {
  const lines=(write:number|null)=>[{type:"thread.started",thread_id:"session"},{type:"turn.completed",usage:{input_tokens:120,output_tokens:4,cached_input_tokens:80,...(write===null?{}:{cache_write_input_tokens:write})}}].map(e=>JSON.stringify(e)).join("\n");
  const observed=observeUsage("codex",lines(20));assert.equal(observed.usage.accounting?.cacheCreationInputTokens,20);
  const run=measuredRun();run.attempts=[metricAttempt("writes",observed.usage)];
  assert.equal(summarizeRun(run).usage.totalTokens.value,124,"input already includes cache writes");
  assert.equal(observeUsage("codex",lines(null)).usage.accounting?.cacheCreationInputTokens,null);
});
test("a failed Claude process preserves reported usage instead of discarding it with the payload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "failed usage ")), repoRoot = join(dir, "project"); await mkdir(repoRoot);
  await writeFile(join(repoRoot, "AGENTS.md"), "Read only");
  const r = await runStage({ agentId: "worker", stage: "review", artifactDir: join(dir, "evidence"),
    task: { id: "usage", objective: "inspect", scope: ["read"], acceptance: ["inspect"], references: [] },
    config: { schemaVersion: 1, projectId: "usage", repoRoot, contextFiles: ["AGENTS.md"],
      agents: { worker: { provider: "claude", command: [process.execPath, resolve("tests/fixtures/fake-agent.mjs"), "claude", "usage-failed"] } },
      checks: [], capabilities: { edit: false, commit: false, pull_request: false, merge: false, deploy: false }, budgets: { stageTimeoutMs: 10000, maxOutputBytes: 30000 } } });
  assert.equal(r.status, "failed"); assert.equal(r.payload, null); assert.equal(r.usage.costUsd, 0.03);
  assert.equal(r.usage.outputTokens, 7); assert.equal(r.sessionId, "failed-session");
});
