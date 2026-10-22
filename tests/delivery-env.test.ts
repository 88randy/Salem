import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/process.js";
test("owned Git subprocess receives scoped deterministic identity without changing the parent environment", async () => {
  const leaseDir = await mkdtemp(join(tmpdir(), "delivery-env-"));
  const result = await runProcess({ command: [process.execPath, "-e", "console.log(process.env.FRAMEWORK_DELIVERY_IDENTITY)"], cwd: process.cwd(),
    timeoutMs: 5000, maxOutputBytes: 1000, leaseDir, ...{ env: { FRAMEWORK_DELIVERY_IDENTITY: "deterministic-test-author" } } });
  assert.equal(result.stdout.trim(), "deterministic-test-author"); assert.equal(process.env.FRAMEWORK_DELIVERY_IDENTITY, undefined);
});
