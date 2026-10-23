import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, readFile, access, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { StageInput } from "../src/contracts.js";
import { runStage } from "../src/adapters/index.js";

async function input(provider: "codex" | "claude", mode = "ok"): Promise<StageInput> {
  const dir = await mkdtemp(join(tmpdir(), "adapter with spaces "));
  const repoRoot = join(dir, "repo"); await mkdir(repoRoot);
  await writeFile(join(repoRoot, "AGENTS.md"), "# Test context");
  return {
    agentId: "agent", stage: "review", artifactDir: join(dir, "evidence"),
    task: { id: "TASK-1", objective: "Inspect project context", scope: ["read"], acceptance: ["valid schema"], references: [] },
    config: { schemaVersion: 1, projectId: "test", repoRoot, contextFiles: ["AGENTS.md"],
      agents: { agent: { provider, command: [process.execPath, resolve("tests/fixtures/fake-agent.mjs"), provider, mode] } },
      checks: [], capabilities: { edit: false, commit: false, pull_request: false, merge: false, deploy: false },
      budgets: { stageTimeoutMs: 10000, maxOutputBytes: 20000 } }
  };
}
test('review prompts include historical accepted receipts separately from model statements',async()=>{
 const i=await input('codex');const receipt={executionId:'previous-execution',runId:'previous-run',acceptance:{accepted:true,fingerprint:'accepted-fingerprint'},review:{sessionId:'independent-review'},implementation:{sessionId:'builder'},integrity:{instructionsHash:'protected-instructions'}};
 (i as any).predecessorEvidence=[receipt];assert.equal((await runStage(i)).status,'succeeded');
 const prompt=await readFile(join(i.artifactDir,'prompt.txt'),'utf8'),line=prompt.match(/^ACCEPTED_PREDECESSOR_EVIDENCE_JSON=(.+)$/m);
 assert.ok(line,'the actual review request must carry the historical receipts');assert.deepEqual(JSON.parse(line[1]!),[receipt]);
});

test('repeated stage narratives are compacted without dropping review findings or the full evidence',async()=>{
 const i=await input('codex'),artifactDir=join(i.config.repoRoot,'previous-evidence');await mkdir(artifactDir);
 const payload={schemaVersion:1 as const,stage:'review' as const,taskId:i.task.id,verdict:'needs_changes' as const,
  summary:'Long investigation. '.repeat(310)+'Full narrative tail retained on disk.',evidenceRefs:['cart.mjs'],
  findings:[{severity:'important' as const,description:'The free-shipping threshold must be inclusive; this finding must reach the next implementation.'}]};
 await writeFile(join(artifactDir,'result.json'),JSON.stringify({payload}));
 i.priorStages=[{stage:'review',artifactDir,payload}];assert.equal((await runStage(i)).status,'succeeded');
 const prompt=await readFile(join(i.artifactDir,'prompt.txt'),'utf8');
 const prior=JSON.parse(prompt.match(/^PRIOR_STAGE_RESULTS_JSON=(.+)$/m)![1]!)[0];
 assert.ok(prior.payload.summary.length<=1500,'repeated narratives must not dominate each subsequent prompt');
 assert.equal(prior.summaryTruncated,true,'the consumer must know that the narrative is an excerpt');
 assert.deepEqual(prior.payload.findings,payload.findings,'actionable review feedback must remain complete');
 assert.deepEqual(prior.payload.evidenceRefs,['cart.mjs']);
 assert.equal(prior.artifactDir,artifactDir);
 assert.deepEqual(JSON.parse(await readFile(join(prior.artifactDir,'result.json'),'utf8')).payload,payload,'the original result must remain available in full');
});
for (const provider of ["codex", "claude"] as const) {
  test(`${provider}: real subprocess normalizes structured output, usage and evidence`, async () => {
    const i = await input(provider); const r = await runStage(i);
    assert.equal(r.status, "succeeded"); assert.equal(r.payload?.taskId, "TASK-1");
    assert.equal(r.usage.inputTokens, 10); assert.equal(r.usage.cachedInputTokens, 2);
    assert.equal(r.usage.costKind, provider === "claude" ? "estimated" : "unavailable");
    assert.equal(r.sessionId, "fixture-session");
    assert.ok((await readdir(i.artifactDir)).includes("result.json"));
    assert.match(await readFile(join(i.artifactDir, "prompt.txt"), "utf8"), /AGENTS.md/);
  });
  for (const mode of ["malformed", "wrong-task", "auth", "no-result"]) {
    test(`${provider}: rejects ${mode} instead of trusting process exit`, async () => {
      const r = await runStage(await input(provider, mode));
      assert.equal(r.status, "failed"); assert.equal(r.payload, null); assert.ok(r.error);
    });
  }
}
test("build without delegated edit authority fails before process starts", async () => {
  const i = await input("codex"); i.stage = "build";
  const r = await runStage(i);
  assert.equal(r.status, "failed"); assert.match(r.error ?? "", /edit/i);
});
test("evidence directory cannot be reused and files are not overwritten", async () => {
  const i = await input("claude"); await runStage(i);
  const prior = await readFile(join(i.artifactDir, "result.json"), "utf8");
  await assert.rejects(runStage(i), /exist|reuse/i);
  assert.equal(await readFile(join(i.artifactDir, "result.json"), "utf8"), prior);
});
test("cancellation before stage must not launch health probes", async () => {
  const i = await input("codex", "markversion");
  const c = new AbortController(); c.abort();
  const r = await runStage(i, c.signal);
  assert.equal(r.status, "cancelled");
  await assert.rejects(access(join(i.config.repoRoot, "version-started")));
});
test("stage deadline also covers CLI preflight", async () => {
  const i = await input("codex", "slowversion"); i.config.budgets.stageTimeoutMs = 100;
  const r = await runStage(i);
  assert.equal(r.status, "timed_out");
  assert.ok(r.durationMs < 4000, "preflight must not spend eight seconds outside a 100ms deadline");
});
test("Codex final-message file is redacted before return and persistence", async () => {
  const secret = "sk-ant-agent-workflow-test-secret-6e42";
  process.env.AGENT_WORKFLOW_TEST_TOKEN = secret;
  try {
    const i = await input("codex", "secret"); const r = await runStage(i);
    assert.equal(r.status, "succeeded");
    assert.equal(JSON.stringify(r).includes(secret), false);
    assert.equal((await readFile(join(i.artifactDir, "last-message.json"), "utf8")).includes(secret), false);
  } finally { delete process.env.AGENT_WORKFLOW_TEST_TOKEN; }
});
test("Codex final-message file cannot bypass output budget", async () => {
  const i = await input("codex", "large-file"); const r = await runStage(i);
  assert.equal(r.status, "failed"); assert.match(r.error ?? "", /output/i);
  assert.ok((await stat(join(i.artifactDir, "last-message.json"))).size <= i.config.budgets.maxOutputBytes);
});
test("Codex final-message is also redacted when the process fails", async () => {
  const secret = "sk-ant-agent-workflow-test-secret-failure-3124";
  process.env.AGENT_WORKFLOW_TEST_TOKEN = secret;
  try {
    const i = await input("codex", "secret-failed"); const r = await runStage(i);
    assert.equal(r.status, "failed");
    assert.equal((await readFile(join(i.artifactDir, "last-message.json"), "utf8")).includes(secret), false);
  } finally { delete process.env.AGENT_WORKFLOW_TEST_TOKEN; }
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: provider refusal is readable and redacted while the stage remains failed`, async () => {
    const previous = process.env.AGENT_WORKFLOW_TEST_TOKEN;
    const secret = "private-provider-token-" + Date.now(); process.env.AGENT_WORKFLOW_TEST_TOKEN = secret;
    try {
      const i = await input(provider, "service-error"), r = await runStage(i);
      assert.equal(r.status, "failed"); assert.equal(r.payload, null); assert.equal(r.failureKind, "unknown");
      assert.match(r.error ?? "", provider === "claude" ? /session limit.*resets 6:10pm/ : /model is not supported/);
      assert.ok((r.error?.length ?? 0) <= 800); assert.equal(JSON.stringify(r).includes(secret), false);
      assert.equal((await readFile(join(i.artifactDir, "result.json"), "utf8")).includes(secret), false);
    } finally { if (previous === undefined) delete process.env.AGENT_WORKFLOW_TEST_TOKEN; else process.env.AGENT_WORKFLOW_TEST_TOKEN = previous; }
  });
}

test("Claude error payload with exit zero stays rejected and exposes its usage limit", async () => {
  const r = await runStage(await input("claude", "service-error-zero"));
  assert.equal(r.status, "failed"); assert.equal(r.payload, null); assert.equal(r.failureKind, "protocol");
  assert.match(r.error ?? "", /session limit.*resets 6:10pm/);
});

test("Codex failed turn with exit zero stays rejected and exposes the provider refusal", async () => {
  const r = await runStage(await input("codex", "service-error-zero"));
  assert.equal(r.status, "failed"); assert.equal(r.payload, null); assert.equal(r.failureKind, "protocol");
  assert.match(r.error ?? "", /model is not supported/);
});
