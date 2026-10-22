import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "../src/process.js";
import { supervisorFixture } from "./supervisor-fixture.js";

test("CLI run/resume prints run identity, durable block and checkpoints without replaying stages", async () => {
  const f = await supervisorFixture(); const profile = join(f.dir, "profile.json"), task = join(f.dir, "task.json");
  await writeFile(profile, JSON.stringify(f.config)); await writeFile(task, JSON.stringify(f.task));
  const cli = (...args: string[]) => runProcess({ command: [process.execPath, resolve("dist/src/cli.js"), ...args, "--config", profile, "--state-dir", f.stateDir], cwd: process.cwd(), timeoutMs: 60000, maxOutputBytes: 100000 });
  const result = await cli("run", "--task", task);
  assert.equal(result.exitCode, 1); const state = JSON.parse(result.stdout);
  assert.equal(state.status, "blocked"); assert.equal(state.nextPhase, "validating");
  assert.match(result.stderr, /checkpoint/);
  const resumed = await cli("resume", "--run", state.id);
  assert.equal(resumed.exitCode, 1); assert.equal(JSON.parse(resumed.stdout).id, state.id);
  assert.equal((await readFile(f.trace, "utf8")).trim().split("\n").length, 2);
  assert.equal((await cli("resume", "--run", "../escape")).exitCode, 1);
});
