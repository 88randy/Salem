// A separate guardian owns one subprocess tree. IPC loss means the supervisor
// died, so no agent may continue mutating the worktree after recovery begins.
// POSIX contains the tree in a process group. Windows contains it in a Job
// Object (see windows-job.ts) because parent PIDs cannot find descendants once
// the agent has exited. The `cleaned` receipt is sent only after the tree is
// confirmed empty; otherwise the lease stays open and new work stays blocked.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { atomicJson } from "./state-store.js";
import { WindowsJob } from "./windows-job.js";
const [leaseFile, token] = process.argv.slice(2);
const windows = process.platform === "win32";
type Start = { type: string; command: string[]; cwd: string; timeoutMs: number; env?: Record<string, string> };
let child: ChildProcess | undefined;
let job: WindowsJob | undefined;
let contained = false; // Windows: the launch gate is in the job, so the job covers the whole tree.
let started = false;
let stopping = false;
let finishing = false;
let killerDone: Promise<void> = Promise.resolve();
// Windows: an uncontained gate never received its command, so it has no descendants.
const confirmEmpty = async (): Promise<boolean> => !contained || (job ? job.terminate() : false);
function unconfirmed(): void {
  finishing = true; process.exitCode = 1;
  process.stderr.write("Process tree cleanup could not be confirmed", () => { if (process.connected) process.disconnect(); process.exit(1); });
}
async function finish(code: number): Promise<void> {
  if (finishing) return; finishing = true; stopping = true;
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
  if (!child?.pid) { void finish(1); return; }
  if (windows) {
    if (!contained) { child.kill(); return; }
    killerDone = job!.terminate().then(ok => { if (!ok) child?.kill(); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
function attach(spawned: ChildProcess, timeoutMs: number): void {
  child = spawned;
  const timer = setTimeout(stop, timeoutMs);
  process.stdin.pipe(child.stdin!); child.stdout!.pipe(process.stdout); child.stderr!.pipe(process.stderr);
  child.stdin!.on("error", () => {});
  child.on("error", e => { process.stderr.write(e.message); });
  child.on("close", code => { clearTimeout(timer); void finish(code ?? 1); });
}
async function startContained(message: Start): Promise<void> {
  const timer = setTimeout(stop, message.timeoutMs);
  job = WindowsJob.start(); // finish() closes it, even while it is still starting
  try { await job.ready; } catch (e) { clearTimeout(timer); process.stderr.write((e as Error).message); void finish(1); return; }
  clearTimeout(timer);
  if (stopping) return;
  const gate = spawn(process.execPath, [fileURLToPath(new URL("./job-gate.js", import.meta.url))], { cwd: message.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"] });
  attach(gate, message.timeoutMs);
  if (!gate.pid) return; // spawn error: close settles the run
  // Descendants holding inherited pipes would delay close; end the tree on exit.
  gate.once("exit", () => { if (contained) void job!.terminate().then(ok => { if (!ok && !finishing) unconfirmed(); }); });
  try { await job.assign(gate.pid); } catch (e) { process.stderr.write((e as Error).message); gate.kill(); return; }
  // ChildProcess holds the gate's handle until exit is observed, so its PID cannot be reused here.
  if (stopping || gate.exitCode !== null || gate.signalCode !== null) { gate.kill(); return; }
  contained = true;
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
  if (windows) { void startContained(message); return; }
  attach(spawn(message.command[0]!, message.command.slice(1), { cwd: message.cwd, env: { ...process.env, ...message.env }, shell: false, windowsHide: true, detached: true, stdio: ["pipe", "pipe", "pipe"] }), message.timeoutMs);
});
