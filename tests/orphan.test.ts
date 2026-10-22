import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { alive, acquireLock } from "../src/state-store.js";
import { runProcess } from "../src/process.js";

test("agent process is terminated when its supervisor is killed without cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "orphan recovery "));
  const pidFile = join(dir, "agent.pid");
  const parent = spawn(process.execPath, [resolve("tests/fixtures/owned-parent.mjs"), dir, join(dir, "leases"), pidFile], { stdio: "ignore", windowsHide: true });
  let pid: number | undefined;
  try {
    for (let i = 0; i < 100; i++) {
      try { pid = Number(await readFile(pidFile, "utf8")); if (pid) break; } catch { /* waiting for child */ }
      await delay(50);
    }
    assert.ok(pid, "fixture child launched");
    const leases = await readdir(join(dir, "leases")).catch(() => []);
    assert.ok(leases.length > 0, "recovery needs a durable guardian lease before the agent launches");
    const lease = JSON.parse(await readFile(join(dir, "leases", leases[0]!), "utf8"));
    assert.equal(lease.closed, false); assert.equal(alive(lease.pid), true);
    const exited = new Promise<void>(resolve => parent.once("exit", () => resolve()));
    parent.kill("SIGKILL"); await exited;
    for (let i = 0; i < 100 && alive(pid); i++) await delay(50);
    assert.equal(alive(pid), false, "orphan must be stopped by an independent guardian");
  } finally {
    parent.kill();
    if (pid && alive(pid)) {
      if (process.platform === "win32") await runProcess({ command: ["taskkill.exe", "/PID", String(pid), "/T", "/F"], cwd: dir, timeoutMs: 5000, maxOutputBytes: 1000 });
      else process.kill(-pid, "SIGKILL");
    }
  }
});

test("guardian death without a cleanup receipt is not treated as process completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "guardian crash ")), pidFile = join(dir, "agent.pid"), leaseDir = join(dir, "leases");
  const parent = spawn(process.execPath, [resolve("tests/fixtures/owned-parent.mjs"), dir, leaseDir, pidFile], { stdio: "ignore", windowsHide: true });
  let agentPid: number | undefined;
  try {
    for (let i = 0; i < 100; i++) { try { agentPid = Number(await readFile(pidFile, "utf8")); break; } catch { await delay(50); } }
    assert.ok(agentPid);
    const leaseFile = join(leaseDir, (await readdir(leaseDir))[0]!);
    const lease = JSON.parse(await readFile(leaseFile, "utf8")); process.kill(lease.pid, "SIGKILL");
    for (let i = 0; i < 100; i++) { try { await readFile(pidFile + ".result"); break; } catch { await delay(50); } }
    assert.equal(JSON.parse(await readFile(leaseFile, "utf8")).closed, false, "host closure is not proof of agent cleanup");
    const path = join(dir, "worktree.lock"); await mkdir(path);
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: 2147483647, token: "old", runId: "old", leaseDir }));
    await assert.rejects(acquireLock(path, "new"), /guardian|cleanup|unconfirmed/i);
  } finally {
    parent.kill();
    if (agentPid && alive(agentPid)) {
      if (process.platform === "win32") await runProcess({ command: ["taskkill.exe", "/PID", String(agentPid), "/T", "/F"], cwd: dir, timeoutMs: 5000, maxOutputBytes: 1000 });
      else process.kill(-agentPid, "SIGKILL");
    }
  }
});

test("a POSIX signal to the supervisor group cleans up the detached agent group", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "group signal ")), pidFile = join(dir, "agent.pid");
  const parent = spawn(process.execPath, [resolve("tests/fixtures/owned-parent.mjs"), dir, join(dir, "leases"), pidFile], { detached: true, stdio: "ignore" });
  let agentPid: number | undefined;
  try {
    for (let i = 0; i < 100; i++) { try { agentPid = Number(await readFile(pidFile, "utf8")); break; } catch { await delay(50); } }
    assert.ok(agentPid); process.kill(-parent.pid!, "SIGTERM");
    for (let i = 0; i < 100 && alive(agentPid); i++) await delay(50);
    assert.equal(alive(agentPid), false);
  } finally { parent.kill(); if (agentPid && alive(agentPid)) process.kill(-agentPid, "SIGKILL"); }
});
