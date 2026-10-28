import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { alive, acquireLock } from "../src/state-store.js";
import { runProcess } from "../src/process.js";
import { WindowsJob } from "../src/windows-job.js";
import { spawn } from "node:child_process";

// The agent starts two detached grandchildren that escape libuv's job: one
// inherits (and holds) the agent's stdout/stderr pipes, one ignores stdio.
const keep = "require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)";
const agent = `const {spawn}=require('child_process'),fs=require('fs'),{join}=require('path');const [dir,mode]=process.argv.slice(1);
spawn(process.execPath,['-e',${JSON.stringify(keep)},join(dir,'piped.pid')],{stdio:'inherit',detached:true}).unref();
spawn(process.execPath,['-e',${JSON.stringify(keep)},join(dir,'silent.pid')],{stdio:'ignore',detached:true}).unref();
const wait=setInterval(()=>{if(['piped.pid','silent.pid'].every(f=>fs.existsSync(join(dir,f)))){clearInterval(wait);console.log('spawned');if(mode==='exit')process.exit(0);setInterval(()=>{},1000);}},20);`;
const pids = async (dir: string) => Promise.all(["piped.pid", "silent.pid"].map(async f => Number(await readFile(join(dir, f), "utf8"))));
const kill = async (dir: string) => {
  for (const f of ["piped.pid", "silent.pid"]) {
    const pid = Number(await readFile(join(dir, f), "utf8").catch(() => "0"));
    if (pid && alive(pid)) await runProcess({ command: ["taskkill.exe", "/PID", String(pid), "/T", "/F"], cwd: dir, timeoutMs: 5000, maxOutputBytes: 1000 });
  }
};
const lease = async (dir: string) => JSON.parse(await readFile(join(dir, "leases", (await readdir(join(dir, "leases")))[0]!), "utf8"));
const tree = async () => { const dir = await mkdtemp(join(tmpdir(), "salem tree ")); await mkdir(join(dir, "leases")); return dir; };
const run = async (dir: string, mode: "exit" | "stay", extra: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  runProcess({ command: [process.execPath, "-e", agent, dir, mode], cwd: dir, leaseDir: join(dir, "leases"), timeoutMs: extra.timeoutMs ?? 15000, maxOutputBytes: 10000, ...(extra.signal ? { signal: extra.signal } : {}) });
const spawned = async (dir: string) => { for (let i = 0; i < 200 && !["piped.pid", "silent.pid"].every(f => existsSync(join(dir, f))); i++) await delay(50); };
const windows = { skip: process.platform !== "win32", timeout: 30000 };

test("windows: descendants of a normally exiting agent are terminated before the cleanup receipt", windows, async () => {
  const dir = await tree(), result = await run(dir, "exit");
  try {
    assert.equal(result.status, "exited", result.error ?? ""); assert.equal(result.exitCode, 0, result.stderr); assert.match(result.stdout, /spawned/);
    for (const pid of await pids(dir)) assert.equal(alive(pid), false, `descendant ${pid} survived a normal exit`);
    assert.equal((await lease(dir)).closed, true);
  } finally { await kill(dir); }
});

test("windows: timeout terminates detached descendants", windows, async () => {
  const dir = await tree(), result = await run(dir, "stay", { timeoutMs: 4000 });
  try {
    assert.equal(result.status, "timed_out", result.error ?? "");
    for (const pid of await pids(dir)) assert.equal(alive(pid), false, `descendant ${pid} survived a timeout`);
    assert.equal((await lease(dir)).closed, true);
  } finally { await kill(dir); }
});

test("windows: stop terminates detached descendants", windows, async () => {
  const dir = await tree(), c = new AbortController();
  const pending = run(dir, "stay", { signal: c.signal });
  await spawned(dir); c.abort();
  const result = await pending;
  try {
    assert.equal(result.status, "cancelled", result.error ?? "");
    for (const pid of await pids(dir)) assert.equal(alive(pid), false, `descendant ${pid} survived a stop`);
    assert.equal((await lease(dir)).closed, true);
  } finally { await kill(dir); }
});

test("windows: an unconfirmable tree cleanup withholds the receipt and keeps new work blocked", windows, async () => {
  const dir = await tree(), leaseDir = join(dir, "leases"), pending = run(dir, "stay");
  try {
    await spawned(dir);
    const host = (await lease(dir)).pid;
    // Kill the containment helper: the guardian can no longer prove the tree is empty.
    const query = `Get-CimInstance Win32_Process -Filter 'ParentProcessId=${host} and Name=''windows-job-helper.exe''' | ForEach-Object { $_.ProcessId }`;
    const found = await runProcess({ command: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", query], cwd: dir, timeoutMs: 15000, maxOutputBytes: 1000 });
    const helper = Number(found.stdout.trim().split(/\s+/)[0]);
    assert.ok(helper > 0, `containment helper not found: ${found.stdout} ${found.stderr}`);
    process.kill(helper, "SIGKILL");
    const result = await pending;
    assert.equal(result.status, "failed"); assert.match(result.error ?? "", /cleanup receipt/);
    assert.equal((await lease(dir)).closed, false, "an unconfirmed cleanup must not close the lease");
    const path = join(dir, "worktree.lock"); await mkdir(path);
    await writeFile(join(path, "owner.json"), JSON.stringify({ pid: 2147483647, token: "old", runId: "old", leaseDir }));
    await assert.rejects(acquireLock(path, "new"), /guardian|cleanup|unconfirmed/i);
  } finally { await pending.catch(() => {}); await kill(dir); }
});

// PID-reuse class: containment must never target a process chosen by PID, or a
// recycled PID could pull an unrelated process into the job (and kill it later).
test("windows: the containment helper refuses PID-based assignment, so a bystander is never pulled into the job", windows, async () => {
  const bystander = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore", windowsHide: true });
  const job = WindowsJob.start();
  try {
    await job.ready;
    const request = (job as unknown as { reply(line: string): Promise<string> }).reply.bind(job);
    assert.notEqual(await request(`assign ${bystander.pid}`), "ok", "the helper accepted a PID to contain");
    assert.equal(await job.terminate(), true);
    await delay(200);
    assert.equal(alive(bystander.pid!), true, "terminating the job killed a process that was only named by PID");
  } finally { job.close(); bystander.kill(); }
});

test("windows: the helper creates the gate inside the job before it runs and reports its exit", windows, async () => {
  const dir = await tree(), job = WindowsJob.start();
  try {
    await job.ready;
    const exits = await job.launch(process.execPath, ["-e", "process.exit(7)"], dir);
    assert.ok(exits > 0);
    assert.equal(await job.gateExit, 7);
  } finally { job.close(); }
  const second = WindowsJob.start();
  try {
    await second.ready;
    const pid = await second.launch(process.execPath, ["-e", "setInterval(()=>{},1000)"], dir);
    assert.equal(alive(pid), true);
    assert.equal(await second.terminate(), true, "the job did not report the launched gate as its member");
    assert.equal(await second.gateExit, 1);
    assert.equal(alive(pid), false, "terminating the job did not end the launched gate");
    await assert.rejects(second.launch(process.execPath, ["-e", ""], dir), /already started/);
  } finally { second.close(); }
});

test("windows: a missing containment helper fails closed", windows, async () => {
  const dir = await tree(), job = WindowsJob.start(join(dir, "missing-helper.exe"));
  try { await assert.rejects(job.ready, /containment unavailable/); } finally { job.close(); }
});
