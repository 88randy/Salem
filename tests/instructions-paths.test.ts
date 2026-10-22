import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { instructionsHash } from "../src/repository.js";
import type { ProjectConfig } from "../src/contracts.js";

test("instruction identity resolves an aliased project root while rejecting context outside its physical root", async () => {
  const dir = await mkdtemp(join(tmpdir(), "salem instructions alias "));
  const physical = join(dir, "physical"), alias = join(dir, "alias"), outside = join(dir, "outside");
  await mkdir(physical); await mkdir(outside);
  await writeFile(join(physical, "AGENTS.md"), "project instructions\n");
  await writeFile(join(outside, "AGENTS.md"), "outside instructions\n");
  await symlink(physical, alias, process.platform === "win32" ? "junction" : "dir");
  const config: ProjectConfig = { schemaVersion: 1, projectId: "alias", repoRoot: physical, contextFiles: ["AGENTS.md"], agents: {}, checks: [], capabilities: { edit: false, commit: false, pull_request: false, merge: false, deploy: false }, budgets: { stageTimeoutMs: 1000, maxOutputBytes: 1000 } };
  const expected = await instructionsHash(config);
  assert.equal(await instructionsHash({ ...config, repoRoot: alias }), expected);
  await symlink(outside, join(physical, "external"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(instructionsHash({ ...config, repoRoot: alias, contextFiles: ["external/AGENTS.md"] }), /Context escapes worktree/);
});
