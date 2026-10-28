import { createHash, randomUUID } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runProcess, redact } from "./process.js";
import { digest } from "./state-store.js";
import { isInside } from "./config.js";
import type { ProjectConfig, RepositorySnapshot } from "./contracts.js";

async function git(root: string, ...args: string[]): Promise<string> {
  const started = Date.now();
  // Reading the index would otherwise run a configured fsmonitor command; the monitor only speeds Git up.
  // Replace refs could make Git read different objects than the ones recorded. No transport may start (for example a
  // lazy fetch through a promisor remote and its sshCommand). Paths are fingerprinted, so stdout is never redacted.
  const result = await runProcess({ command: ["git", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args], cwd: root,
    env: { GIT_NO_REPLACE_OBJECTS: "1", GIT_ALLOW_PROTOCOL: "", GIT_NO_LAZY_FETCH: "1" }, timeoutMs: 10000, maxOutputBytes: 2_000_000, rawStdout: true });
  if (result.status !== "exited" || result.exitCode !== 0) {
    const operation = redact(["git", ...args].join(" ")).slice(0, 500);
    const cwd = redact(root).slice(0, 500);
    const detail = redact([result.error, result.stderr.trim()].filter(Boolean).join("; ")).slice(0, 1000);
    throw new Error(`Git operation failed: ${operation} (status=${result.status}, exitCode=${result.exitCode}, elapsedMs=${Date.now() - started}, cwd=${cwd})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}
export async function repositoryFiles(root: string, config: string[] = []): Promise<string[]> {
  return (await git(root, ...config, "ls-files", "-z", "--cached", "--others", "--exclude-standard")).split("\0").filter(Boolean);
}
/**
 * Overrides for read-only snapshots taken after acceptance: config added later must not run a command
 * (fsmonitor, clean/process filters) or change how Git reads bytes (global attributes file). No config is written.
 */
async function inertConfig(root: string): Promise<string[]> {
  const listed = await runProcess({ command: ["git", "config", "--name-only", "--get-regexp", "^filter\\..*\\.(process|smudge|clean|required)$"], cwd: root, timeoutMs: 10000, maxOutputBytes: 2_000_000, rawStdout: true });
  if (listed.status !== "exited" || (listed.exitCode !== 0 && listed.exitCode !== 1)) throw new Error("Git operation failed: filter configuration listing");
  const config = ["-c", "core.fsmonitor=false", "-c", `core.attributesFile=${join(tmpdir(), `salem-no-attributes-${randomUUID()}`)}`];
  for (const key of listed.stdout.split(/\r?\n/).filter(Boolean)) {
    if (!/^filter\.[A-Za-z0-9._/-]+\.(?:process|smudge|clean|required)$/.test(key)) throw new Error("Unsupported Git filter configuration");
    config.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
  }
  return config;
}
/** readOnly keeps status from persisting its opportunistic index stat refresh (for exports that must not touch the index). */
export async function repositorySnapshot(root: string, options: { readOnly?: boolean } = {}): Promise<RepositorySnapshot> {
  root = await realpath(root);
  const inert = options.readOnly ? await inertConfig(root) : [];
  const fields = (await git(root, ...inert, "rev-parse", "--show-toplevel", "--absolute-git-dir", "HEAD")).trim().split(/\r?\n/);
  // Line-delimited metadata is unambiguous for ordinary paths. Preserve the
  // separate queries for paths containing newlines instead of guessing fields.
  const metadata = fields.length === 3 && /^[a-f0-9]{40,64}$/.test(fields[2]!) ? fields : null;
  const top = await realpath(metadata?.[0] ?? (await git(root, ...inert, "rev-parse", "--show-toplevel")).trim());
  if (root !== top) throw new Error("repoRoot must be the root of an isolated Git worktree");
  const head = metadata?.[2] ?? (await git(root, ...inert, "rev-parse", "HEAD")).trim();
  const gitDir = await realpath(metadata?.[1] ?? (await git(root, ...inert, "rev-parse", "--absolute-git-dir")).trim());
  const status = await git(root, ...inert, ...(options.readOnly ? ["--no-optional-locks"] : []), "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const paths = await repositoryFiles(root, inert);
  const staged = (await git(root, ...inert, "ls-files", "--stage", "-z")).split("\0");
  if (staged.some(entry => entry.startsWith("160000 "))) throw new Error("Submodules require a project adapter");
  const hash = createHash("sha256"); let bytes = 0;
  const seen = new Set<string>();
  async function hashPath(path: string): Promise<void> {
    const file = resolve(root, path);
    if (seen.has(file)) return;
    seen.add(file);
    if (!isInside(root, file)) throw new Error("Git file escapes worktree");
    hash.update(JSON.stringify(path));
    try {
      if (!isInside(root, await realpath(dirname(file)))) throw new Error("Git file escapes worktree");
      const stat = await lstat(file);
      if (!stat.isDirectory()) {
        bytes += stat.size;
        if (stat.size > 20_000_000 || bytes > 100_000_000) throw new Error("Worktree fingerprint size budget exceeded");
      }
      // Length-prefixed records: without them, bytes could move between a file and the next path's record.
      if (stat.isSymbolicLink()) { const target = Buffer.from(await readlink(file)); hash.update(`link:${target.length}:`); hash.update(target); }
      else if (stat.isFile()) { const content = await readFile(file); hash.update(`file:${stat.mode & 0o111}:${content.length}:`); hash.update(content); }
      else if (stat.isDirectory()) {
        hash.update("directory:");
        for (const name of (await readdir(file)).sort()) await hashPath(`${path}/${name}`);
      } else throw new Error("Unsupported worktree entry");
    } catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) hash.update("missing"); else throw e; }
  }
  for (const path of [...new Set(paths)].sort()) await hashPath(path);
  // Include index/staging changes even if working bytes remain identical.
  hash.update(await git(root, ...inert, "diff", "--cached", "--raw", "-z", "HEAD"));
  return { root, gitDir, head, treeHash: hash.digest("hex"), dirty: status.length > 0 };
}
export async function instructionsHash(config: ProjectConfig): Promise<string> {
  const root = await realpath(config.repoRoot);
  const entries = [];
  for (const path of config.contextFiles) {
    const file = await realpath(resolve(root, path));
    if (!isInside(root, file)) throw new Error("Context escapes worktree");
    entries.push([path, await readFile(file, "utf8")]);
  }
  if (config.instructions !== undefined) entries.push(["<salem-inline>", config.instructions]);
  return digest(entries);
}
export async function assertStateLocation(root: string, stateDir: string): Promise<void> {
  // Check an existing ancestor too, to reject a symlink into an unignored tree.
  let current = resolve(stateDir); let suffix: string[] = [];
  const { dirname, basename, join } = await import("node:path");
  for (;;) {
    try { current = join(await realpath(current), ...suffix.reverse()); break; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; suffix.push(basename(current)); current = dirname(current); }
  }
  if (isInside(root, current)) {
    const result = await runProcess({ command: ["git", "-c", "core.fsmonitor=false", "check-ignore", "-q", current], cwd: root, timeoutMs: 5000, maxOutputBytes: 1000 });
    if (result.exitCode !== 0) throw new Error("State directory inside worktree must be Git-ignored");
  }
}
