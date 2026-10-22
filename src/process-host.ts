// A separate guardian owns one subprocess tree. IPC loss means the supervisor
// died, so no agent may continue mutating the worktree after recovery begins.
import { spawn, type ChildProcess } from "node:child_process";
import { atomicJson } from "./state-store.js";
const [leaseFile, token] = process.argv.slice(2);
let child: ChildProcess | undefined;
let stopping = false;
let finishing = false;
let killerDone: Promise<void> = Promise.resolve();
async function finish(code: number): Promise<void> {
  if (finishing) return; finishing = true; stopping = true;
  await killerDone;
  // The child has its own group; clean remaining members on normal POSIX exit.
  if (process.platform !== "win32" && child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already empty */ } }
  try {
    await atomicJson(leaseFile!, { pid: process.pid, token, closed: true });
    process.exitCode = code;
    if (process.connected) process.send!({ type: "cleaned" }, () => { if (process.connected) process.disconnect(); });
  } catch { process.exitCode = 1; if (process.connected) process.disconnect(); }
}
function stop(): void {
  if (stopping) return; stopping = true;
  if (!child?.pid) { void finish(1); return; }
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killerDone = new Promise(resolve => { killer.once("close", () => resolve()); });
    killer.on("error", () => child?.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}
process.on("disconnect", stop);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
process.on("message", (raw: unknown) => {
  const message = raw as { type: string; command: string[]; cwd: string; timeoutMs: number; env?: Record<string, string> };
  if (message.type === "stop") { stop(); return; }
  if (message.type !== "start" || child || stopping) return;
  child = spawn(message.command[0]!, message.command.slice(1), { cwd: message.cwd, env: { ...process.env, ...message.env }, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const timer = setTimeout(stop, message.timeoutMs);
  process.stdin.pipe(child.stdin!); child.stdout!.pipe(process.stdout); child.stderr!.pipe(process.stderr);
  child.stdin!.on("error", () => {});
  child.on("error", e => { process.stderr.write(e.message); });
  child.on("close", code => { clearTimeout(timer); void finish(code ?? 1); });
});
