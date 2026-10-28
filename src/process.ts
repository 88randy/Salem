import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
export interface ProcessInput { command: string[]; cwd: string; input?: string; env?: Record<string, string>; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; leaseDir?: string;
  /** Keep stdout unredacted, for integrity reads (paths, hashes) that are never displayed; stderr stays redacted. */
  rawStdout?: boolean;
  /**
   * Test seam, Windows owned runs only: absolute path of the containment helper
   * build to launch instead of the release helper next to windows-job.ts. Tests
   * set it to the fault-injection build (dist/tests/windows-job-helper.test.exe);
   * production callers never set it, so they always get the release helper.
   */
  windowsJobHelper?: string }
export interface ProcessResult { status: "exited" | "failed" | "cancelled" | "timed_out"; exitCode: number | null; stdout: string; stderr: string; error: string | null }

export function redact(text: string): string {
  let result = text;
  for (const [key, value] of Object.entries(process.env)) {
    if (/(?:KEY|TOKEN|PASSWORD|SECRET)/i.test(key) && value && value.length >= 8) {
      result = result.split(value).join("[REDACTED]");
      result = result.split(JSON.stringify(value).slice(1, -1)).join("[REDACTED]");
    }
  }
  return result.replace(/\b(?:sk-ant-|sk-proj-)[\w-]{12,}/g, "[REDACTED]");
}
export async function resolveExecutable(program: string): Promise<string> {
  if (isAbsolute(program) || program.includes("/") || program.includes("\\")) return program;
  const dirs = (process.env.PATH ?? process.env.Path ?? "").split(delimiter);
  for (const dir of dirs) {
    const candidates = process.platform === "win32" ? [join(dir, program.endsWith(".exe") ? program : `${program}.exe`)] : [join(dir, program)];
    // Windows npm launchers are shell scripts; resolve the native Claude binary
    // instead of invoking cmd.exe with model-generated prompt arguments.
    if (process.platform === "win32" && program === "claude") candidates.push(join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"));
    for (const file of candidates) {
      try { await access(file, constants.X_OK); return file; } catch { /* next PATH entry */ }
    }
  }
  throw new Error(`Executable not found: ${program}`);
}
export async function runProcess(input: ProcessInput): Promise<ProcessResult> {
  if (input.leaseDir) return (await import("./owned-process.js")).runOwnedProcess(input);
  const empty = (status: ProcessResult["status"], error: string | null): ProcessResult => ({ status, error, exitCode: null, stdout: "", stderr: "" });
  if (input.signal?.aborted) return empty("cancelled", "Cancelled before launch");
  if (!input.command.length || !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes <= 0) return empty("failed", "Invalid process arguments or budgets");
  let exe: string;
  try { exe = await resolveExecutable(input.command[0]!); } catch (e) { return empty("failed", redact(String(e))); }
  if (input.signal?.aborted) return empty("cancelled", "Cancelled before launch");
  return new Promise(resolve => {
    let status: ProcessResult["status"] = "exited", error: string | null = null, bytes = 0;
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const proc = spawn(exe, input.command.slice(1), { cwd: input.cwd, env: { ...process.env, ...input.env }, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const stop = (next: ProcessResult["status"], message: string) => {
      if (status !== "exited") return;
      status = next; error = message;
      if (!proc.pid) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
        killer.on("error", () => proc.kill());
      } else {
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
      }
    };
    const abort = () => stop("cancelled", "Cancelled");
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();
    const timer = setTimeout(() => stop("timed_out", "Stage timeout exceeded"), input.timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, input.maxOutputBytes - bytes);
      if (remaining) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > input.maxOutputBytes) stop("failed", "Process output budget exceeded");
    };
    proc.stdout.on("data", (c: Buffer) => collect(stdout, c));
    proc.stderr.on("data", (c: Buffer) => collect(stderr, c));
    proc.stdin.on("error", () => { /* child can reject args before reading stdin */ });
    proc.on("error", e => { status = "failed"; error = redact(e.message); });
    proc.on("close", exitCode => {
      clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      resolve({ status, exitCode, error, stdout: input.rawStdout ? Buffer.concat(stdout).toString("utf8") : redact(Buffer.concat(stdout).toString("utf8")), stderr: redact(Buffer.concat(stderr).toString("utf8")) });
    });
    proc.stdin.end(input.input ?? "");
  });
}
