import { spawn, type ChildProcess } from "node:child_process";
import { resolveExecutable } from "../process.js";

export interface AuthProcess {
  done: Promise<{ exitCode: number | null; status: "exited" | "failed" | "cancelled" | "timed_out" }>;
  input(text: string): Promise<void>;
}

// This guardian never writes files. Command and input live only in memory.
// When Salem exits abruptly, cleanup of the one tree the guardian owns differs by platform:
// - POSIX: the login runs detached in its own process group, so only this guardian's
//   'disconnect' handler (IPC loss) kills it, by signalling the whole group.
// - Windows: libuv puts every non-detached child in a job object with
//   JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (libuv src/win/process.c). Salem's death closes its
//   job and kills this guardian, whose own job then kills the login; the 'disconnect'
//   handler does not get to run. This path does not use src/windows-job.ts.
const guardianSource = String.raw`
const { spawn } = require('node:child_process');
const { join } = require('node:path');
let child, stopping = false, finishing = false, timer;
let killing = Promise.resolve();
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child || !child.pid) { finish(1); return; }
  if (process.platform === 'win32') {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
    const killer = spawn(exe, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    killing = new Promise(resolve => { killer.once('close', resolve); killer.once('error', () => { child.kill(); resolve(); }); });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }
}
async function finish(code) {
  if (finishing) return;
  finishing = true;
  clearTimeout(timer);
  await killing;
  if (process.platform !== 'win32' && child && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  process.exitCode = code;
  if (process.connected) process.send({ type: 'cleaned' }, () => { if (process.connected) process.disconnect(); });
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', message => {
  if (message.type === 'stop') { stop(); return; }
  if (message.type !== 'start' || child || stopping) return;
  child = spawn(message.command[0], message.command.slice(1), { cwd: message.cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  timer = setTimeout(stop, message.timeoutMs);
  process.stdin.pipe(child.stdin);
  child.stdin.on('error', () => {});
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.on('error', () => {});
  child.on('close', code => finish(code === null ? 1 : code));
});
`;

export async function startAuthProcess(options: {
  command: string[]; cwd: string; timeoutMs: number; signal: AbortSignal;
  onOutput: (text: string) => void;
}): Promise<AuthProcess> {
  if (!options.command.length) throw new Error("Comando de autenticación vacío");
  const exe = await resolveExecutable(options.command[0]!);
  if (options.signal.aborted) throw new Error("Conexión cancelada");
  const host: ChildProcess = spawn(process.execPath, ["-e", guardianSource], {
    shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ipc"],
  });
  let ended = false;
  const done = new Promise<Awaited<AuthProcess["done"]>>(resolve => {
    let status: Awaited<AuthProcess["done"]>["status"] = "exited";
    let cleaned = false, bytes = 0;
    const stop = (reason: typeof status) => {
      if (ended || status !== "exited") return;
      status = reason;
      if (host.connected) host.send({ type: "stop" }, () => {});
    };
    const abort = () => stop("cancelled");
    options.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timed_out"), options.timeoutMs);
    const output = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 100000) { stop("failed"); return; }
      if (status === "exited") options.onOutput(chunk.toString("utf8"));
    };
    host.stdout!.on("data", output); host.stderr!.on("data", output);
    host.stdin!.on("error", () => {});
    host.on("message", raw => { if ((raw as { type?: string }).type === "cleaned") cleaned = true; });
    host.on("error", () => { status = "failed"; });
    host.on("close", exitCode => {
      ended = true; clearTimeout(timer); options.signal.removeEventListener("abort", abort);
      resolve({ status: cleaned ? status : "failed", exitCode });
    });
    host.send({ type: "start", command: [exe, ...options.command.slice(1)], cwd: options.cwd, timeoutMs: options.timeoutMs }, error => {
      if (error) stop("failed");
    });
    if (options.signal.aborted) abort();
  });
  return {
    done,
    input: async text => {
      if (ended || options.signal.aborted || !host.stdin?.writable) throw new Error("La conexión ya no está activa");
      await new Promise<void>((resolve, reject) => host.stdin!.write(`${text}\n`, error => error ? reject(new Error("No se pudo enviar el código")) : resolve()));
    },
  };
}
