import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runProcess, redact } from "./process.js";
import { digest } from "./state-store.js";
import { isInside } from "./config.js";
import type { ProjectConfig, RepositorySnapshot } from "./contracts.js";

async function git(root: string, ...args: string[]): Promise<string> {
  const started = Date.now();
  const result = await runProcess({ command: ["git", ...args], cwd: root, timeoutMs: 10000, maxOutputBytes: 2_000_000 });
  if (result.status !== "exited" || result.exitCode !== 0) {
    const operation = redact(["git", ...args].join(" ")).slice(0, 500);
    const cwd = redact(root).slice(0, 500);
    const detail = redact([result.error, result.stderr.trim()].filter(Boolean).join("; ")).slice(0, 1000);
    throw new Error(`Git operation failed: ${operation} (status=${result.status}, exitCode=${result.exitCode}, elapsedMs=${Date.now() - started}, cwd=${cwd})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}
export async function repositoryFiles(root: string): Promise<string[]> {
  return (await git(root, "ls-files", "-z", "--cached", "--others", "--exclude-standard")).split("\0").filter(Boolean);
}
/** readOnly keeps status from persisting its opportunistic index stat refresh (for exports that must not touch the index). */
export async function repositorySnapshot(root: string, options: { readOnly?: boolean } = {}): Promise<RepositorySnapshot> {
  root = await realpath(root);
  const fields = (await git(root, "rev-parse", "--show-toplevel", "--absolute-git-dir", "HEAD")).trim().split(/\r?\n/);
  // Line-delimited metadata is unambiguous for ordinary paths. Preserve the
  // separate queries for paths containing newlines instead of guessing fields.
  const metadata = fields.length === 3 && /^[a-f0-9]{40,64}$/.test(fields[2]!) ? fields : null;
  const top = await realpath(metadata?.[0] ?? (await git(root, "rev-parse", "--show-toplevel")).trim());
  if (root !== top) throw new Error("repoRoot must be the root of an isolated Git worktree");
  const head = metadata?.[2] ?? (await git(root, "rev-parse", "HEAD")).trim();
  const gitDir = await realpath(metadata?.[1] ?? (await git(root, "rev-parse", "--absolute-git-dir")).trim());
  const status = await git(root, ...(options.readOnly ? ["--no-optional-locks"] : []), "status", "--porcelain=v1", "-z", "--untracked-files=all");
  const paths = await repositoryFiles(root);
  const staged = (await git(root, "ls-files", "--stage", "-z")).split("\0");
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
      if (stat.isSymbolicLink()) hash.update(`link:${await readlink(file)}`);
      else if (stat.isFile()) { hash.update(`file:${stat.mode & 0o111}:`); hash.update(await readFile(file)); }
      else if (stat.isDirectory()) {
        hash.update("directory:");
        for (const name of (await readdir(file)).sort()) await hashPath(`${path}/${name}`);
      } else throw new Error("Unsupported worktree entry");
    } catch (e) { if (["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "")) hash.update("missing"); else throw e; }
  }
  for (const path of [...new Set(paths)].sort()) await hashPath(path);
  // Include index/staging changes even if working bytes remain identical.
  hash.update(await git(root, "diff", "--cached", "--raw", "-z", "HEAD"));
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
    const result = await runProcess({ command: ["git", "check-ignore", "-q", current], cwd: root, timeoutMs: 5000, maxOutputBytes: 1000 });
    if (result.exitCode !== 0) throw new Error("State directory inside worktree must be Git-ignored");
  }
}
