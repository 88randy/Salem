// A separate guardian owns one subprocess tree. IPC loss means the supervisor
// died, so no agent may continue mutating the worktree after recovery begins.
// POSIX contains the tree in a process group. Windows contains it in a Job
// Object (see windows-job.ts) because parent PIDs cannot find descendants once
// the agent has exited. The `cleaned` receipt is sent only after the tree is
// confirmed empty; otherwise the lease stays open and new work stays blocked.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { atomicJson } from "./state-store.js";
import { WindowsJob } from "./windows-job.js";
const [leaseFile, token] = process.argv.slice(2);
const windows = process.platform === "win32";
type Start = { type: string; command: string[]; cwd: string; timeoutMs: number; env?: Record<string, string> };
let child: ChildProcess | undefined; // POSIX agent
let job: WindowsJob | undefined;
let contained = false; // Windows: the launch gate is in the job, so the job covers the whole tree.
let launching = false; // Windows: a gate may exist in the job but is not yet confirmed started.
let started = false;
let stopping = false;
let finishing = false;
let timer: NodeJS.Timeout | undefined;
let killerDone: Promise<void> = Promise.resolve();
// Windows: before a launch request no gate exists; from then on only the job can prove the tree is empty.
const confirmEmpty = async (): Promise<boolean> => !contained || (job ? job.terminate() : false);
function unconfirmed(): void {
  finishing = true; process.exitCode = 1; clearTimeout(timer);
  process.stderr.write("Process tree cleanup could not be confirmed", () => { if (process.connected) process.disconnect(); process.exit(1); });
}
async function finish(code: number): Promise<void> {
  if (finishing) return; finishing = true; stopping = true; clearTimeout(timer);
  await killerDone;
  // The child has its own group; clean remaining members on normal POSIX exit.
  if (!windows && child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already empty */ } }
  const clean = !windows || await confirmEmpty();
  job?.close();
  if (!clean) { unconfirmed(); return; }
  try {
    await atomicJson(leaseFile!, { pid: process.pid, token, closed: true });
    process.exitCode = code;
    if (process.connected) process.send!({ type: "cleaned" }, () => { if (process.connected) process.disconnect(); });
  } catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
}
function stop(): void {
  if (stopping) return; stopping = true;
  if (windows) {
    if (contained) killerDone = job!.terminate().then(() => {}); // the gate exit then settles the run
    else if (!launching) void finish(1); // startContained finishes once the pending launch settles
    return;
  }
  if (!child?.pid) { void finish(1); return; }
  try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
}
function pipe(stdin: Writable, stdout: Readable, stderr: Readable): void {
  process.stdin.pipe(stdin); stdout.pipe(process.stdout); stderr.pipe(process.stderr);
  stdin.on("error", () => {});
}
function attach(spawned: ChildProcess): void {
  child = spawned;
  pipe(child.stdin!, child.stdout!, child.stderr!);
  child.on("error", e => { process.stderr.write(e.message); });
  child.on("close", code => { void finish(code ?? 1); });
}
async function startContained(message: Start): Promise<void> {
  job = WindowsJob.start(); // finish() closes it, even while it is still starting
  try { await job.ready; } catch (e) { process.stderr.write((e as Error).message); void finish(1); return; }
  if (stopping) return;
  const gate = job;
  launching = true;
  try { await gate.launch(process.execPath, [fileURLToPath(new URL("./job-gate.js", import.meta.url))], message.cwd); }
  catch (e) {
    // A failed or unknown launch outcome (e.g. the helper died right after creating
    // the gate) is settled by the job, never assumed: `cleaned` is sent only if the
    // live helper confirms the job is empty. Otherwise the receipt is withheld and
    // new work stays blocked.
    launching = false; contained = true;
    process.stderr.write((e as Error).message); void finish(1); return;
  }
  launching = false; contained = true;
  // Run settles when the gate has exited and every holder of its output pipes is gone.
  const drained = (stream: Readable) => new Promise<void>(resolve => { stream.once("close", resolve); });
  pipe(gate.stdin, gate.stdout, gate.stderr);
  void gate.gateExit.then(() => {
    // Descendants holding inherited pipes would delay EOF; end the tree on exit.
    void gate.terminate().then(ok => { if (!ok && !finishing) unconfirmed(); });
  });
  void Promise.all([gate.gateExit, drained(gate.stdout), drained(gate.stderr)]).then(([code]) => finish(code ?? 1));
  if (stopping) { killerDone = gate.terminate().then(() => {}); return; }
  gate.send({ command: message.command, cwd: message.cwd, env: { ...process.env, ...message.env } }, e => { if (e) stop(); });
}
process.on("disconnect", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("message", (raw: unknown) => {
  const message = raw as Start;
  if (message.type === "stop") { stop(); return; }
  if (message.type !== "start" || started || stopping) return;
  started = true;
  timer = setTimeout(stop, message.timeoutMs);
  if (windows) { void startContained(message); return; }
  attach(spawn(message.command[0]!, message.command.slice(1), { cwd: message.cwd, env: { ...process.env, ...message.env }, shell: false, windowsHide: true, detached: true, stdio: ["pipe", "pipe", "pipe"] }));
});
