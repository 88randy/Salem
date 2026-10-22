import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { inspectAgent } from "../src/doctor.js";
for (const provider of ["claude", "codex"] as const) {
  test(`${provider}: distinguishes installed, compatible and authenticated`, async () => {
    const command = [process.execPath, resolve("tests/fixtures/fake-agent.mjs"), provider, "ok"];
    const health = await inspectAgent({ provider, command }, process.cwd());
    assert.equal(health.installed, true); assert.equal(health.compatible, true); assert.equal(health.authenticated, true);
    command[3] = "auth";
    assert.equal((await inspectAgent({ provider, command }, process.cwd())).authenticated, false);
  });
}
test("uninstalled CLI never becomes authenticated or compatible", async () => {
  const r = await inspectAgent({ provider: "codex", command: ["missing-doctor-executable"] }, process.cwd());
  assert.equal(r.installed, false); assert.equal(r.compatible, false); assert.equal(r.authenticated, null);
});
test("Claude loggedIn true with nonzero exit cannot authenticate", async () => {
  const r = await inspectAgent({ provider: "claude", command: [process.execPath, resolve("tests/fixtures/fake-agent.mjs"), "claude", "auth-error"] }, process.cwd());
  assert.notEqual(r.authenticated, true);
});
