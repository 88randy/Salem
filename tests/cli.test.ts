import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runProcess } from "../src/process.js";

test("CLI runs a JSON task against a separate configured project", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cli test "));
  await mkdir(join(dir, "project"));
  await writeFile(join(dir, "project", "AGENTS.md"), "# Foreign project context\nConfirm CONTEXTO-TEST-7c2a");
  const profile = join(dir, "profile.json"), task = join(dir, "task.json");
  await writeFile(profile, JSON.stringify({ schemaVersion: 1, projectId: "foreign", repoRoot: "./project", contextFiles: ["AGENTS.md"],
    agents: { reviewer: { provider: "claude", command: [process.execPath, resolve("tests/fixtures/fake-agent.mjs"), "claude", "ok"] } }, checks: [],
    capabilities: { edit: false, commit: false, pull_request: false, merge: false, deploy: false }, budgets: { stageTimeoutMs: 3000, maxOutputBytes: 30000 } }));
  await writeFile(task, JSON.stringify({ id: "CLI-1", objective: "Read", scope: ["read"], acceptance: ["valid result"], references: [] }));
  const run = (args: string[]) => runProcess({ command: [process.execPath, resolve("dist/src/cli.js"), ...args], cwd: process.cwd(), timeoutMs: 15000, maxOutputBytes: 100000 });
  const doctor = await run(["doctor", "--config", profile]);
  assert.equal(doctor.exitCode, 0); assert.equal(JSON.parse(doctor.stdout).agents.reviewer.contextAccepted, null);
  const stage = await run(["stage", "--config", profile, "--agent", "reviewer", "--stage", "review", "--task", task, "--artifacts", join(dir, "artifacts")]);
  assert.equal(stage.exitCode, 0); assert.equal(JSON.parse(stage.stdout).payload.taskId, "CLI-1");
  const invalid = await run(["doctor", "--config", profile, "--arbitrary", "true"]);
  assert.equal(invalid.exitCode, 1);
  const raw = JSON.parse(await (await import("node:fs/promises")).readFile(profile, "utf8"));
  raw.agents.reviewer.command[3] = "smoke"; await writeFile(profile, JSON.stringify(raw));
  const smoke = await run(["doctor", "--config", profile, "--smoke", "--artifacts", join(dir, "smokes")]);
  assert.equal(smoke.exitCode, 0); assert.equal(JSON.parse(smoke.stdout).agents.reviewer.contextAccepted, true);
  raw.agents.reviewer.command[3] = "prefix"; await writeFile(profile, JSON.stringify(raw));
  const prefix = await run(["doctor", "--config", profile, "--smoke", "--artifacts", join(dir, "smokes")]);
  assert.equal(prefix.exitCode, 1, "a prefix of the confirmation does not prove full context acceptance");
});
