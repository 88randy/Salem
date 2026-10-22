import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessInput, ProcessResult } from "./process.js";
import { resolveExecutable, redact } from "./process.js";
import { atomicJson } from "./state-store.js";

export async function runOwnedProcess(input: ProcessInput): Promise<ProcessResult> {
  const failed = (error: string, status: ProcessResult["status"] = "failed"): ProcessResult => ({ status, exitCode: null, stdout: "", stderr: "", error });
  if (input.signal?.aborted) return failed("Cancelled before launch", "cancelled");
  if (!input.command.length || input.timeoutMs <= 0 || input.maxOutputBytes <= 0) return failed("Invalid process budgets");
  let exe: string;
  try { exe = await resolveExecutable(input.command[0]!); } catch (e) { return failed(redact(String(e))); }
  const token = randomUUID(), file = join(input.leaseDir!, `${token}.json`);
  const host = spawn(process.execPath, [fileURLToPath(new URL("./process-host.js", import.meta.url)), file, token], { stdio: ["pipe", "pipe", "pipe", "ipc"], windowsHide: true });
  const lease = { pid: host.pid, token, closed: false };
  return new Promise(resolve => {
    let status: ProcessResult["status"] = "exited", error: string | null = null, bytes = 0;
    let cleaned = false;
    let initialization: Promise<void> = Promise.resolve();
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const stop = (next: ProcessResult["status"], reason: string) => {
      if (status !== "exited") return; status = next; error = reason;
      if (host.connected) host.send({ type: "stop" }, () => {});
    };
    const abort = () => stop("cancelled", "Cancelled");
    input.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => stop("timed_out", "Stage timeout exceeded"), input.timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, input.maxOutputBytes - bytes);
      if (remaining) target.push(chunk.subarray(0, remaining)); bytes += chunk.length;
      if (bytes > input.maxOutputBytes) stop("failed", "Process output budget exceeded");
    };
    host.stdout!.on("data", (chunk: Buffer) => collect(stdout, chunk));
    host.stderr!.on("data", (chunk: Buffer) => collect(stderr, chunk));
    host.stdin!.on("error", () => {});
    host.on("message", raw => { if ((raw as { type?: string }).type === "cleaned") cleaned = true; });
    host.on("error", e => { status = "failed"; error = redact(e.message); });
    host.on("close", async exitCode => {
      clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      try {
        await initialization;
        if (cleaned && lease.pid) await atomicJson(file, { ...lease, closed: true });
        else { status = "failed"; error = "Guardian exited without a confirmed cleanup receipt; recovery requires inspection"; }
      }
      catch (e) { status = "failed"; error = `Cannot persist process receipt: ${redact(String(e))}`; }
      resolve({ status, exitCode, error, stdout: redact(Buffer.concat(stdout).toString("utf8")), stderr: redact(Buffer.concat(stderr).toString("utf8")) });
    });
    // Persist ownership before granting permission to start the agent.
    initialization = (async () => {
      try {
        if (!lease.pid) throw new Error("Guardian did not start");
        await atomicJson(file, lease);
        if (input.signal?.aborted) abort();
        if (status !== "exited") {
          // No start message will consume stdin. Close our pipe before the
          // guardian exits, otherwise ChildProcess.close may never settle.
          host.stdin!.end();
          // Keep IPC alive for the guardian's cleanup receipt. Disconnecting
          // while the first stop message is queued can lose ChildProcess.close
          // on Windows and abandon the promise despite a finished guardian.
          return;
        }
        host.send({ type: "start", command: [exe, ...input.command.slice(1)], cwd: input.cwd, timeoutMs: input.timeoutMs, env: input.env }, e => { if (e) stop("failed", e.message); });
        host.stdin!.end(input.input ?? "");
      } catch (e) { stop("failed", redact(String(e))); host.stdin!.end(); }
    })();
  });
}
