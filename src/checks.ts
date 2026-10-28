import type { ProjectConfig, RepositorySnapshot, CheckEvidence } from "./contracts.js";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, readFile, realpath, lstat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { digest, atomicJson } from "./state-store.js";
import { repositorySnapshot, repositoryFiles, assertStateLocation } from "./repository.js";
import { checkInputs } from "./check-inputs.js";
import { isInside } from "./config.js";
import { runProcess, redact, resolveExecutable } from "./process.js";
export interface CheckOptions {
  artifactDir?: string; snapshot?: RepositorySnapshot; fingerprint?: string;
  signal?: AbortSignal; leaseDir?: string; cached?: CheckEvidence[];
  toolHashes?: Record<string, string>;
  onEvidence?: (evidence: CheckEvidence) => Promise<void>;
}
function bytesHash(text: string): string { return createHash("sha256").update(text).digest("hex"); }
// Artifacts stay small; tools (e.g. the ~120 MB Linux node binary) get their own streamed budget.
const MAX_ARTIFACT_BYTES = 100_000_000, MAX_TOOL_BYTES = 1_000_000_000;
async function fileHash(file: string, maxBytes = MAX_ARTIFACT_BYTES): Promise<string> {
  const s = await lstat(file); if (!s.isFile() || s.size > maxBytes) throw new Error(maxBytes === MAX_TOOL_BYTES ? "Check tool is not a regular file within the size budget" : "Invalid check artifact");
  const hash = createHash("sha256"); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest("hex");
}
export async function checkToolHash(command: string[], cwd: string, toolFiles?: string[]): Promise<string> {
  const exe = await realpath(await resolveExecutable(command[0]!));
  const files = [[exe, await fileHash(exe, MAX_TOOL_BYTES)]];
  const inputs = checkInputs(command, toolFiles);
  const source = new Set(inputs.length ? (await repositoryFiles(cwd)).map(path => resolve(cwd, path)) : []);
  for (const entry of inputs) {
    try {
      const file = resolve(cwd, entry);
      const actual = await realpath(file), info = await lstat(file);
      // Only files actually represented by the snapshot can evolve with source.
      if (info.isDirectory()) throw new Error("Directory check input requires explicit file toolFiles");
      if (!source.has(actual) || actual !== file || info.isSymbolicLink()) files.push([file, actual, await fileHash(actual, MAX_TOOL_BYTES)]);
    }
    catch (e) { throw new Error(`Unavailable check tool input: ${entry}`, { cause: e }); }
  }
  return digest(files);
}
export async function verifyCheck(evidence: CheckEvidence, root: string): Promise<boolean> {
  try {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(evidence.id) || resolve(evidence.artifactDir) !== resolve(root, evidence.id)) return false;
    const actualRoot = await realpath(root), actual = await realpath(evidence.artifactDir);
    if (!isInside(actualRoot, actual)) return false;
    for (const name of ["receipt.json", "stdout.log", "stderr.log"]) if (!(await lstat(join(actual, name))).isFile()) return false;
    if ((await lstat(join(actual, "receipt.json"))).size > 1_000_000) return false;
    const manifest = JSON.parse(await readFile(join(actual, "receipt.json"), "utf8"));
    const { proofHash, ...expected } = evidence;
    return proofHash === digest(manifest) && proofHash === digest(expected)
      && evidence.stdoutHash === await fileHash(join(actual, "stdout.log")) && evidence.stderrHash === await fileHash(join(actual, "stderr.log"));
  } catch { return false; }
}
const DISCOVERY_FLAGS = ["--dry-run", "--collect-only", "--listTests", "--list-tests", "--help", "--version"];
// Acceptance-policy guard: listing/simulating commands cannot produce passing evidence.
// The one exception is Django's `python manage.py makemigrations ... --check ... --dry-run`,
// which verifies (non-zero on missing migrations) and writes nothing. Only `--check`,
// `--dry-run` and app labels are allowed after it: options such as --merge, --empty or
// argparse abbreviations (-h, --hel, --vers) exit 0 without verifying. Interpreter flags,
// other manage.py paths, `python -m django` and `django-admin` stay discovery-only.
// Django exits 0 before running any command when DJANGO_AUTO_COMPLETE is set (shell completion),
// so the exception never applies while it is present in the environment checks inherit.
export function isDiscoveryOnly(command: readonly string[], env: NodeJS.ProcessEnv = process.env): boolean {
  if (!command.some(arg => DISCOVERY_FLAGS.includes(arg))) return false;
  const program = basename(command[0] ?? "").replace(/\.exe$/i, "").toLowerCase(), rest = command.slice(3);
  const migrationsCheck = /^python(?:\d+(?:\.\d+)*)?$/.test(program) && command[1] === "manage.py" && command[2] === "makemigrations"
    && rest.includes("--check") && rest.includes("--dry-run") && rest.every(arg => arg === "--check" || arg === "--dry-run" || /^[A-Za-z_][A-Za-z0-9_]*$/.test(arg));
  return !migrationsCheck || env.DJANGO_AUTO_COMPLETE !== undefined;
}
export async function runChecks(config: ProjectConfig, sha: string, options: CheckOptions = {}): Promise<CheckEvidence[]> {
  const snapshot = options.snapshot ?? await repositorySnapshot(config.repoRoot);
  if (snapshot.head !== sha || digest(await repositorySnapshot(config.repoRoot)) !== digest(snapshot)) throw new Error("Check SHA/worktree differs from expected version");
  const root = resolve(options.artifactDir ?? ".artifacts/checks");
  const leaseDir = options.leaseDir ?? join(root, "leases");
  await assertStateLocation(config.repoRoot, root); await assertStateLocation(config.repoRoot, leaseDir);
  await mkdir(root, { recursive: true });
  const fingerprint = options.fingerprint ?? digest({ config, snapshot });
  const results: CheckEvidence[] = [];
  for (const check of config.checks) {
    let toolHash = "not_run";
    if (!check.notApplicableReason && check.mode !== "dry_run") {
      try { toolHash = await checkToolHash(check.command, config.repoRoot, check.toolFiles); } catch { toolHash = "unavailable"; }
    }
    const toolMatches = !options.toolHashes || Boolean(check.notApplicableReason) || check.mode === "dry_run" || toolHash === options.toolHashes[check.id];
    const cached = [...(options.cached ?? [])].reverse().find(e => e.checkId === check.id && e.fingerprint === fingerprint && e.repoSha === sha && e.treeHash === snapshot.treeHash
      && e.configHash === digest(config) && e.commandHash === digest(check));
    if (cached && toolMatches && cached.toolHash === toolHash && (cached.status === "passed" || cached.status === "not_applicable") && await verifyCheck(cached, root)) { results.push(cached); continue; }
    const id = randomUUID(), artifactDir = join(root, id); await mkdir(artifactDir);
    const started = Date.now(); let stdout = "", stderr = "";
    let status: CheckEvidence["status"] = "failed", execution: CheckEvidence["execution"] = "not_run", exitCode: number | null = null, reason: string | null = null;
    let failureKind: CheckEvidence["failureKind"] = "policy";
    if (check.notApplicableReason) { status = "not_applicable"; reason = check.notApplicableReason; }
    else if (check.mode === "dry_run" || isDiscoveryOnly(check.command)) {
      execution = "dry_run"; reason = "Dry-run/discovery command cannot verify code";
    } else if (options.signal?.aborted) reason = "Check cancelled before launch";
    else if (toolHash === "unavailable") reason = "Check tool inputs unavailable or ambiguous; declare toolFiles";
    else if (!toolMatches) reason = "Check tool changed since preflight";
    else if (digest(await repositorySnapshot(config.repoRoot)) !== digest(snapshot)) reason = "Worktree changed before check";
    else {
      execution = "actual";
      const result = await runProcess({ command: check.command, cwd: config.repoRoot, timeoutMs: config.budgets.stageTimeoutMs, maxOutputBytes: config.budgets.maxOutputBytes, leaseDir, ...(options.signal ? { signal: options.signal } : {}) });
      stdout = result.stdout; stderr = result.stderr; exitCode = result.exitCode;
      status = result.status === "exited" && exitCode === 0 ? "passed" : "failed";
      failureKind = status === "passed" ? null : result.status === "exited" && exitCode !== null && exitCode !== 0 ? "code" : "infrastructure";
      reason = status === "passed" ? null : result.error ?? `Check exited with code ${exitCode}`;
      if (digest(await repositorySnapshot(config.repoRoot)) !== digest(snapshot)) { status = "failed"; reason = "Worktree changed during check"; failureKind = "policy"; }
    }
    await writeFile(join(artifactDir, "stdout.log"), stdout, { mode: 0o600 });
    await writeFile(join(artifactDir, "stderr.log"), stderr, { mode: 0o600 });
    const manifest = { schemaVersion: 1 as const, id, checkId: check.id, command: check.command.map(redact), commandHash: digest(check), toolHash, configHash: digest(config), fingerprint,
      repoSha: sha, treeHash: snapshot.treeHash, status, execution, exitCode, failureKind, reason: reason ? redact(reason) : null, durationMs: Date.now() - started, artifactDir, stdoutHash: bytesHash(stdout), stderrHash: bytesHash(stderr) };
    if (Buffer.byteLength(JSON.stringify(manifest, null, 2)) > 1_000_000) throw new Error("Check receipt size budget exceeded");
    await atomicJson(join(artifactDir, "receipt.json"), manifest);
    const evidence = { ...manifest, proofHash: digest(manifest) };
    results.push(evidence); await options.onEvidence?.(evidence);
    if (reason?.startsWith("Worktree changed")) break;
  }
  return results;
}
