import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateStore, acquireLock } from "../src/state-store.js";

test("checkpoints survive a new store instance and reject corrupt or substituted state", async () => {
  const root = await mkdtemp(join(tmpdir(), "durable state "));
  const store = new StateStore(root);
  const id = "4f48bdf9-a614-4848-a60d-7567290c0411";
  await store.write(id, { id, schemaVersion: 1, revision: 1 });
  assert.equal((await new StateStore(root).read(id)).revision, 1);
  const file = join(root, id, "state.json");
  const envelope = JSON.parse(await readFile(file, "utf8"));
  envelope.value.revision = 99;
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(store.read(id), /corrupt|checksum/i);
  await writeFile(file, "{partial");
  await assert.rejects(store.read(id), /corrupt/i);
});

test("failed serialization leaves the last durable checkpoint intact", async () => {
  const store = new StateStore(await mkdtemp(join(tmpdir(), "atomic state ")));
  const id = "4f48bdf9-a614-4848-a60d-7567290c0412";
  await store.write(id, { id, revision: 1 });
  await assert.rejects(store.write(id, { value: BigInt(1) }));
  assert.equal((await store.read(id)).revision, 1);
  await assert.rejects(store.read("../outside"), /run id/i);
});

test("one worktree lock excludes concurrent tasks and state roots", async () => {
  const root = await mkdtemp(join(tmpdir(), "exclusive worktree "));
  const path = join(root, "worktree.lock");
  const release = await acquireLock(path, "run-one");
  try { await assert.rejects(acquireLock(path, "run-two"), /locked/i); }
  finally { await release(); }
  const release2 = await acquireLock(path, "run-two"); await release2();
});

test("dead owner lock can be recovered; ambiguous owner is never stolen", async () => {
  const root = await mkdtemp(join(tmpdir(), "recovered lock "));
  const path = join(root, "worktree.lock"); await mkdir(path);
  await writeFile(join(path, "owner.json"), JSON.stringify({ pid: 2147483647, token: "old", runId: "old" }));
  const release = await acquireLock(path, "new");
  assert.equal(JSON.parse(await readFile(join(path, "owner.json"), "utf8")).runId, "new");
  await release(); await mkdir(path);
  await assert.rejects(acquireLock(path, "new"), /ambiguous|owner/i);
});

test("dead supervisor with an active guardian cannot be replaced from another state root", async () => {
  const root = await mkdtemp(join(tmpdir(), "guardian exclusion "));
  const path = join(root, "worktree.lock"), leaseDir = join(root, "old-state", "leases");
  await mkdir(path); await mkdir(leaseDir, { recursive: true });
  await writeFile(join(path, "owner.json"), JSON.stringify({ pid: 2147483647, token: "old", runId: "old", leaseDir }));
  await writeFile(join(leaseDir, "guardian.json"), JSON.stringify({ pid: process.pid, closed: false }));
  await assert.rejects(acquireLock(path, "new", join(root, "new-state", "leases")), /guardian|locked/i);
});

test("an oversized checkpoint cannot replace the last recoverable state", async () => {
  const store = new StateStore(await mkdtemp(join(tmpdir(), "bounded checkpoint ")));
  const id = "4f48bdf9-a614-4848-a60d-7567290c0413";
  await store.write(id, { id, revision: 1 });
  await assert.rejects(store.write(id, { id, revision: 2, output: "x".repeat(20_000_000) }), /size|budget/i);
  assert.equal((await store.read(id)).revision, 1);
});
