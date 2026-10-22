import { open, readFile, realpath, lstat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CheckEvidence, ProjectConfig, RepositorySnapshot, VerificationContext } from "./contracts.js";
import { runProcess, redact } from "./process.js";
import { isInside } from "./config.js";

async function excerpt(file: string): Promise<string> {
  const handle = await open(file, "r");
  try { const buffer = Buffer.alloc(2000); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); return buffer.subarray(0, bytesRead).toString("utf8"); }
  finally { await handle.close(); }
}
export async function buildVerificationContext(config: ProjectConfig, snapshot: RepositorySnapshot, fingerprint: string, evidence: CheckEvidence[], signal: AbortSignal, leaseDir: string): Promise<VerificationContext> {
  const limit = Math.min(config.budgets.maxOutputBytes, 100000);
  const git = async (args: string[]) => {
    const r = await runProcess({ command: ["git", ...args], cwd: config.repoRoot, timeoutMs: Math.min(10000, config.budgets.stageTimeoutMs), maxOutputBytes: limit, signal, leaseDir });
    if (r.status !== "exited" || r.exitCode !== 0) throw new Error("Cannot capture complete review diff within budget"); return r.stdout;
  };
  let diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--binary", snapshot.head]);
  const untracked = (await git(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
  for (const name of untracked) {
    const file = resolve(config.repoRoot, name), actual = await realpath(file);
    const s = await lstat(file);
    if (!isInside(config.repoRoot, actual) || !s.isFile() || s.size > limit) throw new Error("Untracked review file exceeds scope/budget");
    diff += `\nUNTRACKED ${JSON.stringify(name)}\n${await readFile(file, "utf8")}\n`;
    if (Buffer.byteLength(diff) > limit) throw new Error("Complete review diff exceeds budget");
  }
  const current = config.checks.flatMap(c => {
    const e = [...evidence].reverse().find(e => e.checkId === c.id && e.fingerprint === fingerprint); return e ? [e] : [];
  });
  return { fingerprint, repoSha: snapshot.head, treeHash: snapshot.treeHash, diff: redact(diff),
    checks: current.map(e => ({ id: e.id, checkId: e.checkId, status: e.status, exitCode: e.exitCode, reason: e.reason, artifactDir: e.artifactDir })),
    logs: await Promise.all(current.map(async e => ({ checkId: e.checkId, stdout: await excerpt(resolve(e.artifactDir, "stdout.log")), stderr: await excerpt(resolve(e.artifactDir, "stderr.log")) }))) };
}
