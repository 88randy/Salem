import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProjectConfig, loadTask } from "../src/config.js";
import { checkFixture } from "./check-fixture.js";

test("profile and task load explicit applicability, dry-run mode and criterion mappings", async () => {
  const f = await checkFixture(), profile = join(f.dir, "profile.json"), task = join(f.dir, "task.json");
  f.config.checks[0]!.mode = "dry_run";
  f.config.checks[0]!.toolFiles = ["external-policy.json"];
  await writeFile(profile, JSON.stringify(f.config)); await writeFile(task, JSON.stringify(f.task));
  assert.equal((await loadProjectConfig(profile)).checks[0]!.mode, "dry_run");
  assert.deepEqual((await loadProjectConfig(profile)).checks[0]!.toolFiles, ["external-policy.json"]);
  assert.deepEqual((await loadTask(task)).acceptanceChecks?.["answer.txt exists"], ["test"]);
  f.task.acceptanceChecks = { "undeclared criterion": ["test"] }; await writeFile(task, JSON.stringify(f.task));
  await assert.rejects(loadTask(task), /criterion|acceptance/i);
});
