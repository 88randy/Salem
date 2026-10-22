import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { redact, runProcess } from "../src/process.js";
import type { ProjectConfig, TaskSpec, RunState } from "../src/contracts.js";
import { runFingerprint } from "../src/runner.js";

export async function git(root: string, ...args: string[]): Promise<string> {
  const started = Date.now();
  const result = await runProcess({ command: ["git", ...args], cwd: root, timeoutMs: 5000, maxOutputBytes: 200000 });
  if (result.status !== "exited" || result.exitCode !== 0) throw new Error(redact(`Fixture git ${args[0] ?? "unknown"}: status=${result.status}, exitCode=${result.exitCode}, elapsedMs=${Date.now() - started}, cwd=${root}; ${result.error ?? ""}; ${result.stderr}`).slice(0, 4000));
  return result.stdout.trim();
}
export async function supervisorFixture(mode = "ok") {
  const dir = await mkdtemp(join(tmpdir(), "supervisor demo "));
  const repoRoot = join(dir, "project"); await mkdir(repoRoot);
  await writeFile(join(repoRoot, "AGENTS.md"), "Only edit answer.txt. No Git mutations or remote actions.\n");
  await git(repoRoot, "init", "-b", "demo");
  await git(repoRoot, "add", "AGENTS.md");
  await git(repoRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "demo baseline");
  const trace = join(dir, "trace.jsonl");
  const config: ProjectConfig = { schemaVersion: 1, projectId: "test", repoRoot, contextFiles: ["AGENTS.md"],
    agents: { worker: { provider: "codex", command: [process.execPath, resolve("tests/fixtures/supervisor-agent.mjs"), trace, mode] } },
    checks: [], capabilities: { edit: true, commit: false, pull_request: false, merge: false, deploy: false },
    budgets: { stageTimeoutMs: 8000, maxOutputBytes: 100000 },
    supervisor: { roles: { define: "worker", build: "worker", review: "worker" }, runTimeoutMs: 120000, maxAttempts: 8 } };
  const task: TaskSpec = { id: "DEMO-3", objective: "Implement answer.txt", scope: ["answer.txt"], acceptance: ["answer.txt exists"], references: [] };
  return { dir, config, task, trace, stateDir: join(dir, "runs") };
}
export async function validGate(state: RunState) {
  return { id: `receipt-${state.attempts.length}`, fingerprint: runFingerprint(state), verdict: "success" as const, evidenceRefs: ["trusted-test-validator"], summary: "Test gate" };
}
