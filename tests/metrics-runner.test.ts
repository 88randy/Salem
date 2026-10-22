import { test } from "node:test";
import assert from "node:assert/strict";
import { supervisorFixture } from "./supervisor-fixture.js";
import { runTask, resumeRun } from "../src/runner.js";
import { summarizeRun } from "../src/metrics.js";
import { StateStore } from "../src/state-store.js";
import { runProcess } from "../src/process.js";
import { resolve } from "node:path";
import { loadProjectConfig } from "../src/config.js";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

test("runner persists active invocations, CLI provenance, and stops on the reported consumption cap", async () => {
  const f = await supervisorFixture(); f.config.supervisor!.maxReportedTokens = 10;
  const profile = join(f.dir, "profile.json"); await writeFile(profile, JSON.stringify(f.config));
  const config = await loadProjectConfig(profile);
  const run = await runTask(f.task, config, { stateDir: f.stateDir });
  assert.equal(run.status, "blocked"); assert.match(run.reason ?? "", /consumption.*budget/i);
  assert.equal(run.attempts.length, 1); assert.ok(summarizeRun(run).timing.activeMs! > 0);
  assert.match(run.telemetry!.agents.worker!.version ?? "", /fixture/);
  const resumed = await resumeRun(run.id, config, { stateDir: f.stateDir });
  assert.equal(resumed.attempts.length, 1); assert.equal(resumed.telemetry!.invocations.length, 2);
  assert.equal(resumed.telemetry!.interventions.filter(e => e.actor === "operator").length, 1);
  assert.equal((await readFile(f.trace, "utf8")).trim().split("\n").length, 1);
  const disk = await new StateStore(f.stateDir).read(run.id);
  assert.equal((disk.telemetry as typeof resumed.telemetry)!.invocations.every(i => i.finishedAt !== null), true);
});
test("report reads a checksum-protected checkpoint without config or project access", async () => {
  const { measuredRun, metricAttempt } = await import("./metrics-fixture.js");
  const f = await supervisorFixture(), state = measuredRun(); state.attempts = [metricAttempt("a")];
  await new StateStore(f.stateDir).write(state.id, state);
  const result = await runProcess({ command: [process.execPath, resolve("dist/src/cli.js"), "report", "--state-dir", f.stateDir, "--run", state.id], cwd: f.dir, timeoutMs: 10000, maxOutputBytes: 100000 });
  assert.equal(result.exitCode, 0, result.stderr); assert.equal(JSON.parse(result.stdout).accepted, true);
});
