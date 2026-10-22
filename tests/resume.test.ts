import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { runTask, resumeRun } from "../src/runner.js";
import { StateStore } from "../src/state-store.js";
import { supervisorFixture, validGate, git } from "./supervisor-fixture.js";
import { setTimeout as delay } from "node:timers/promises";

test("run persists define/build and blocks at the missing validation capability", async () => {
  const f = await supervisorFixture();
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  assert.equal(state.status, "blocked"); assert.equal(state.nextPhase, "validating");
  assert.match(state.reason!, /validation.*no checks/i);
  assert.deepEqual(state.attempts.map(a => a.stage), ["define", "build"]);
  assert.equal(await readFile(join(f.config.repoRoot, "answer.txt"), "utf8"), "implemented\n");
  assert.equal((await new StateStore(f.stateDir).read(state.id)).status, "blocked");
});

test("resume after checkpoint does not replay a confirmed build", async () => {
  const f = await supervisorFixture(); let id = "";
  await assert.rejects(runTask(f.task, f.config, { stateDir: f.stateDir, onCheckpoint: async state => {
    id = state.id;
    if (state.nextPhase === "validating" && state.attempts.at(-1)?.result) throw new Error("controlled interruption");
  } }), /controlled interruption/);
  const result = await resumeRun(id, f.config, { stateDir: f.stateDir });
  assert.equal(result.status, "blocked");
  assert.equal(result.nextPhase, "validating"); assert.match(result.reason!, /validation.*no checks/i);
  assert.deepEqual(result.attempts.map(a => a.stage), ["define", "build"]);
  const trace = (await readFile(f.trace, "utf8")).trim().split("\n").map(x => JSON.parse(x));
  assert.deepEqual(trace.map(x => x.stage), ["define", "build"]);
});

test("review rejection loops through build within budget and passes feedback to a separate session", async () => {
  const f = await supervisorFixture("rework");
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir, gates: { validate: validGate } });
  assert.equal(state.status, "blocked"); assert.equal(state.nextPhase, "delivering");
  assert.deepEqual(state.attempts.map(a => a.stage), ["define", "build", "review", "build", "review"]);
  assert.equal(new Set(state.attempts.map(a => a.result!.sessionId)).size, 5);
  const trace = (await readFile(f.trace, "utf8")).trim().split("\n").map(x => JSON.parse(x));
  assert.match(trace[3].prompt, /Correct answer.txt/);
});

test("resume rejects external worktree edits and invalidates evidence", async () => {
  const f = await supervisorFixture(); const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  await writeFile(join(f.config.repoRoot, "answer.txt"), "outside change");
  const resumed = await resumeRun(state.id, f.config, { stateDir: f.stateDir });
  assert.equal(resumed.status, "blocked"); assert.match(resumed.reason!, /worktree.*changed/i);
  assert.ok(resumed.attempts.every(a => !a.valid));
  assert.equal((await readFile(f.trace, "utf8")).trim().split("\n").length, 2);
});

test("configuration drift cannot reuse earlier evidence", async () => {
  const f = await supervisorFixture(); const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  const changed = structuredClone(f.config); changed.capabilities.commit = true;
  const resumed = await resumeRun(state.id, changed, { stateDir: f.stateDir });
  assert.match(resumed.reason!, /configuration.*changed/i); assert.ok(resumed.attempts.every(a => !a.valid));
});

test("changed tool executable or instructions invalidate evidence on recovery", async () => {
  const f = await supervisorFixture(); const script = join(f.dir, "agent.mjs");
  await copyFile(f.config.agents.worker!.command[1]!, script); f.config.agents.worker!.command[1] = script;
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  await writeFile(script, (await readFile(script, "utf8")).replace("supervisor-fixture-1", "supervisor-fixture-2"));
  const resumed = await resumeRun(state.id, f.config, { stateDir: f.stateDir });
  assert.match(resumed.reason!, /tools.*changed/i); assert.ok(resumed.attempts.every(a => !a.valid));
  assert.deepEqual(resumed.telemetry!.agents,state.telemetry!.agents,"Rejected tool drift must preserve original provenance");
  await writeFile(join(f.config.repoRoot, "AGENTS.md"), "new instructions\n");
  assert.match((await resumeRun(state.id, f.config, { stateDir: f.stateDir })).reason!, /instructions.*changed/i);
});

test("cancelled subprocess leaves a retryable checkpoint and closes its leases", async () => {
  const f = await supervisorFixture("wait"); const controller = new AbortController();
  const pending = runTask(f.task, f.config, { stateDir: f.stateDir, signal: controller.signal });
  let started = false;
  for (let n = 0; n < 400; n++) {
    try { await readFile(f.trace + ".pid"); started = true; break; } catch { await delay(50); }
  }
  controller.abort(); const state = await pending;
  assert.ok(started, "cancel after the build subprocess actually started");
  assert.equal(state.status, "cancelled"); assert.equal(state.nextPhase, "implementing");
  await writeFile(f.trace + ".release", "continue");
  const resumed = await resumeRun(state.id, f.config, { stateDir: f.stateDir });
  assert.equal(resumed.nextPhase, "validating");
  assert.deepEqual(resumed.attempts.map(a => a.result?.status), ["succeeded", "cancelled", "succeeded"]);
});

test("state location cannot dirty the project or escape via a symlink", async () => {
  const f = await supervisorFixture();
  await assert.rejects(runTask(f.task, f.config, { stateDir: join(f.config.repoRoot, "state") }), /ignored/i);
});

test("a validation receipt for another fingerprint cannot authorize review or delivery", async () => {
  const f = await supervisorFixture();
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir, gates: { validate: async s => ({ ...await validGate(s), fingerprint: "wrong" }) } });
  assert.equal(state.status, "blocked"); assert.match(state.reason!, /receipt|fingerprint/i);
  assert.deepEqual(state.attempts.map(a => a.stage), ["define", "build"]);
});

test("preflight authentication failure leaves a durable blocked run without launching a stage", async () => {
  const f = await supervisorFixture("auth");
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  assert.equal(state.status, "blocked"); assert.match(state.reason!, /preflight|auth/i);
  assert.equal(state.attempts.length, 0);
  assert.equal((await new StateStore(f.stateDir).read(state.id)).status, "blocked");
});

test("dirty baseline is refused and no agent launches", async () => {
  const f = await supervisorFixture(); await writeFile(join(f.config.repoRoot, "unrelated.txt"), "user work");
  await assert.rejects(runTask(f.task, f.config, { stateDir: f.stateDir }), /clean|dirty/i);
  await assert.rejects(readFile(f.trace));
});

test("attempt and wall-clock budgets stop recovery without discarding previous results", async () => {
  const f = await supervisorFixture(); f.config.supervisor!.maxAttempts = 1;
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  assert.equal(state.status, "blocked"); assert.match(state.reason!, /attempt.*budget/i); assert.equal(state.attempts.length, 1);
  const store = new StateStore(f.stateDir); const raw = await store.read(state.id); raw.deadlineAt = Date.now() - 1;
  await store.write(state.id, raw);
  const resumed = await resumeRun(state.id, f.config, { stateDir: f.stateDir });
  assert.match(resumed.reason!, /deadline|time.*budget/i); assert.equal(resumed.attempts.length, 1);
});

test("a confirmed delivery is never repeated on resume", async () => {
  const f = await supervisorFixture(); let deliveries = 0;
  const gates = { validate: validGate, deliver: async (s: Parameters<typeof validGate>[0]) => { deliveries++; return validGate(s); } };
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir, gates });
  assert.equal(state.status, "completed"); assert.ok(state.delivery);
  const resumed = await resumeRun(state.id, f.config, { stateDir: f.stateDir, gates });
  assert.equal(resumed.status, "completed"); assert.equal(deliveries, 1);
});

test("changed HEAD and corrupt state fail closed", async () => {
  const f = await supervisorFixture(); const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  await git(f.config.repoRoot, "add", "answer.txt");
  await git(f.config.repoRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "external commit");
  assert.match((await resumeRun(state.id, f.config, { stateDir: f.stateDir })).reason!, /worktree.*changed/i);
  await writeFile(join(f.stateDir, state.id, "state.json"), "{broken");
  await assert.rejects(resumeRun(state.id, f.config, { stateDir: f.stateDir }), /corrupt/i);
});

test("a delivery with an unknown outcome is not invoked again on resume", async () => {
  const f = await supervisorFixture();
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir, gates: { validate: validGate } });
  let calls = 0;
  await assert.rejects(resumeRun(state.id, f.config, { stateDir: f.stateDir, gates: { deliver: async () => { calls++; throw new Error("lost response after effect"); } } }), /lost response/);
  const resumed = await resumeRun(state.id, f.config, { stateDir: f.stateDir, gates: { deliver: async s => { calls++; return validGate(s); } } });
  assert.equal(calls, 1); assert.equal(resumed.status, "blocked"); assert.match(resumed.reason!, /unknown|reconcil/i);
});

test("a delivery receipt survives worktree drift after the effect", async () => {
  const f = await supervisorFixture();
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir, gates: { validate: validGate, deliver: async s => {
    await writeFile(join(f.config.repoRoot, "answer.txt"), "external change after delivery"); return validGate(s);
  } } });
  assert.equal(state.status, "blocked"); assert.ok(state.delivery, "never discard a confirmed effect receipt");
  assert.ok((await new StateStore(f.stateDir).read(state.id)).delivery);
});

test("worktree drift before a gate prevents its invocation", async () => {
  const f = await supervisorFixture(); let calls = 0, changed = false;
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir, gates: { validate: validGate, deliver: async s => { calls++; return validGate(s); } },
    onCheckpoint: async s => { if (s.status === "delivering" && !changed) { changed = true; await writeFile(join(f.config.repoRoot, "answer.txt"), "external edit before delivery"); } } });
  assert.equal(state.status, "blocked"); assert.equal(calls, 0);
});
