import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { supervisorFixture } from "./supervisor-fixture.js";
import { runDirectTask } from "../src/direct-workflow.js";
import { summarizeRun } from "../src/metrics.js";
import { runProcess } from "../src/process.js";

test("direct comparison workflow rejects false success, corrects, independently reviews and commits exact accepted code", async () => {
  const f = await supervisorFixture(), checker = join(f.dir,"check.mjs");
  await writeFile(checker, "import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';assert.equal(readFileSync('answer.txt','utf8'),'corrected\\n');");
  f.config.checks = [{ id: "answer", required: true, command: [process.execPath,checker] }];
  f.task.acceptanceChecks = { "answer.txt exists": ["answer"] };
  f.config.capabilities.commit = true;
  f.config.delivery = { branchPrefix: "feature/agent-", recovery: "query_only", commit: { message: "fix demo", author: { name: "Demo", email: "demo@example.invalid" } } };
  const run = await runDirectTask(f.task, f.config, { stateDir: f.stateDir });
  assert.equal(run.status,"completed"); assert.equal(run.attempts.filter(a=>a.stage==="build").length,2);
  assert.equal(run.acceptance?.accepted,true); assert.equal(run.delivery?.verdict,"success");
  assert.equal(summarizeRun(run).quality.failedChecks,1); assert.equal(summarizeRun(run).iterations.review,1);
  assert.equal(summarizeRun(run).usage.totalTokens.value,60);
});
test("benchmark harness fixes protocol before inference and produces paired independent clones", async () => {
  const r = await runProcess({ command: [process.execPath,resolve("scripts/benchmark.mjs"),"--provider","fixture","--case","bug"],
    cwd: process.cwd(), timeoutMs: 240000,maxOutputBytes: 100000 });
  assert.equal(r.exitCode,0,r.stderr);
  const output = JSON.parse(r.stdout), { readFile } = await import("node:fs/promises");
  const manifest = JSON.parse(await readFile(output.manifest,"utf8"));
  assert.equal(manifest.trials.length,2); assert.ok(manifest.fixedAt < manifest.trials[0].startedAt);
  assert.equal(manifest.trials[0].baseSha,manifest.trials[1].baseSha);
  assert.notEqual(manifest.trials[0].repoRoot,manifest.trials[1].repoRoot);
  const report = JSON.parse(await readFile(output.report,"utf8"));
  assert.equal(report.comparison.baseline.accepted,1); assert.equal(report.comparison.candidate.accepted,1);
  assert.equal(report.evidenceKind,"fixture"); assert.equal(report.comparison.comparability,"verified");
});
