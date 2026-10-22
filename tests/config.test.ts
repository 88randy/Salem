import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProjectConfig } from "../src/config.js";

export async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "agent workflow "));
  await mkdir(join(dir, "repo with spaces"));
  await writeFile(join(dir, "repo with spaces", "AGENTS.md"), "# Project instructions");
  const config = {
    schemaVersion: 1, projectId: "demo", repoRoot: "./repo with spaces", contextFiles: ["AGENTS.md"],
    agents: { worker: { provider: "codex", command: [process.execPath, "--version"] } },
    checks: [{ id: "tests", command: [process.execPath, "--version"], required: true }],
    capabilities: { edit: true, commit: false, pull_request: false, merge: false, deploy: false },
    budgets: { stageTimeoutMs: 1000, maxOutputBytes: 100000 }
  };
  const file = join(dir, "profile.json");
  const save = async () => writeFile(file, JSON.stringify(config));
  await save();
  return { dir, config, file, save };
}

test("loads portable profile with spaces without Linear and resolves context", async () => {
  const f = await fixture();
  const c = await loadProjectConfig(f.file);
  assert.equal(c.repoRoot, join(f.dir, "repo with spaces"));
  assert.deepEqual(c.agents.worker?.command, [process.execPath, "--version"]);
  assert.equal(c.capabilities.merge, false);
});
test("rejects unresolved repo_root, missing context, and traversal", async () => {
  const f = await fixture();
  f.config.repoRoot = "repo_root"; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /repoRoot/);
  f.config.repoRoot = "./repo with spaces"; f.config.contextFiles = ["missing.md"]; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /context/);
  f.config.contextFiles = ["../profile.json"]; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /context/);
});
test("rejects missing authority and shell-string commands", async () => {
  const f = await fixture();
  const raw = f.config as unknown as Record<string, unknown>;
  delete raw.capabilities; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /capabilities/);
  raw.capabilities = { edit: true, commit: true, pull_request: false, merge: false, deploy: false };
  raw.agents = { worker: { provider: "codex", command: "codex exec" } }; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /command/);
});
test("rejects empty commands, invalid budgets and unknown fields", async () => {
  const f = await fixture();
  f.config.budgets.stageTimeoutMs = 0; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /stageTimeoutMs/);
  f.config.budgets.stageTimeoutMs = 1000;
  f.config.agents.worker!.command = []; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /command/);
  f.config.agents.worker!.command = [process.execPath];
  (f.config as unknown as Record<string, unknown>).automaticDeploy = true; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /Unknown/);
});
test("rejects context through a directory symlink escaping the project", async () => {
  const f = await fixture();
  const outside = join(f.dir, "outside"); await mkdir(outside);
  await writeFile(join(outside, "private.md"), "outside context");
  await symlink(outside, join(f.dir, "repo with spaces", "linked"), process.platform === "win32" ? "junction" : "dir");
  f.config.contextFiles = ["linked/private.md"]; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /contextFiles/);
});
test("validates the optional Codex clean-profile setting", async () => {
  const f = await fixture();
  const agent = f.config.agents.worker! as unknown as Record<string, unknown>;
  agent.ignoreUserConfig = true; await f.save();
  const loaded = await loadProjectConfig(f.file);
  assert.equal((loaded.agents.worker as unknown as Record<string, unknown>).ignoreUserConfig, true);
  agent.ignoreUserConfig = "true"; await f.save();
  await assert.rejects(loadProjectConfig(f.file), /ignoreUserConfig/);
});
