import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deliveryFixture } from "./delivery-fixture.js";
import { loadProjectConfig } from "../src/config.js";
import { diagnoseProject } from "../src/project-profile.js";
test("project profile loads explicit delivery policy and rejects unknown recovery/branch escalation", async () => {
  const f = await deliveryFixture(), file = join(f.dir, "profile.json");
  await writeFile(file, JSON.stringify(f.config));
  assert.deepEqual((await loadProjectConfig(file)).delivery, f.config.delivery);
  f.config.delivery!.branchPrefix = "main"; await writeFile(file, JSON.stringify(f.config));
  await assert.rejects(loadProjectConfig(file), /branch|delivery/i);
});
test("diagnosis reads a dirty project without agents, checks or delivery effects",async()=>{
  const f=await deliveryFixture();for(const capability of ["edit","commit","pull_request","merge","deploy"] as const)f.config.capabilities[capability]=false;
  const before=await import("../src/repository.js").then(m=>m.repositorySnapshot(f.config.repoRoot));
  const report=await diagnoseProject(f.config);
  assert.equal(report.diagnosticOnly,true);assert.equal(report.configuration,"valid");assert.equal(report.repository.head,f.snapshot.head);assert.equal(report.repository.dirty,true);
  assert.ok(report.blockedActions.includes("commit"));assert.deepEqual(report.unexecutedChecks,["test"]);
  assert.deepEqual(await import("../src/repository.js").then(m=>m.repositorySnapshot(f.config.repoRoot)),before);
});
