import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { repositorySnapshot } from "../src/repository.js";
import { git, supervisorFixture } from "./supervisor-fixture.js";

test("snapshot reads identity in one Git query while retaining content and dirty detection", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = await realpath(f.config.repoRoot);
  const head = await git(root, "rev-parse", "HEAD");
  const gitDir = await realpath(join(root, ".git"));
  const trace = join(f.dir, "snapshot-git-trace.log");
  const previous = process.env.GIT_TRACE;
  process.env.GIT_TRACE = trace.replaceAll("\\", "/");
  let before;
  try { before = await repositorySnapshot(root); }
  finally {
    if (previous === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previous;
  }
  assert.equal(before.root, root);
  assert.equal(before.head, head);
  assert.equal(before.gitDir, gitDir);
  assert.equal(before.dirty, false);
  const queries = (await readFile(trace, "utf8")).split("\n").filter(line => /built-in: git rev-parse /.test(line));
  assert.equal(queries.length, 1, "identity metadata should share one Git process");
  await writeFile(join(root, "answer.txt"), "changed\n");
  const after = await repositorySnapshot(root);
  assert.equal(after.dirty, true);
  assert.notEqual(after.treeHash, before.treeHash);
  assert.equal(after.head, before.head);
  await git(root, "add", "answer.txt");
  await git(root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "changed HEAD");
  const committed = await repositorySnapshot(root);
  assert.notEqual(committed.head, before.head);
  assert.equal(committed.dirty, false);
});

test("snapshot preserves linked worktree identity and rejects a nested repository root", async t => {
  const f = await supervisorFixture();
  const worktree = join(f.dir, "linked worktree");
  await git(f.config.repoRoot, "worktree", "add", "--detach", worktree, "HEAD");
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const snapshot = await repositorySnapshot(worktree);
  assert.equal(snapshot.root, await realpath(worktree));
  assert.equal(snapshot.head, await git(worktree, "rev-parse", "HEAD"));
  assert.equal(snapshot.gitDir, await realpath((await git(worktree, "rev-parse", "--absolute-git-dir"))));
  assert.notEqual(snapshot.gitDir, join(snapshot.root, ".git"));
  const nested = join(worktree, "nested");
  await mkdir(nested);
  await assert.rejects(repositorySnapshot(nested), /root of an isolated Git worktree/);
});

test("snapshot fingerprints a tracked file replaced by a directory deterministically", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "AGENTS.md");
  const before = await repositorySnapshot(root);
  await rm(path);
  await mkdir(join(path, "nested"), { recursive: true });
  await writeFile(join(path, "nested", "answer.txt"), "first\n");
  const after = await repositorySnapshot(root);
  assert.notEqual(after.treeHash, before.treeHash);
  assert.equal(after.dirty, true);
  assert.equal(after.head, before.head);
  assert.deepEqual(await repositorySnapshot(root), after);
  await writeFile(join(path, "nested", "answer.txt"), "second\n");
  assert.notEqual((await repositorySnapshot(root)).treeHash, after.treeHash);
});

test("snapshot distinguishes an empty replacement directory from a missing or original file", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "AGENTS.md");
  const contents = await readFile(path);
  const before = await repositorySnapshot(root);
  await rm(path);
  const missing = await repositorySnapshot(root);
  await mkdir(path);
  const empty = await repositorySnapshot(root);
  assert.notEqual(empty.treeHash, before.treeHash);
  assert.notEqual(empty.treeHash, missing.treeHash);
  assert.deepEqual(await repositorySnapshot(root), empty);
  await rm(path, { recursive: true });
  await writeFile(path, contents);
  assert.deepEqual(await repositorySnapshot(root), before);
});

test("snapshot sorts replacement directory contents independently of creation order", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "AGENTS.md");
  await rm(path);
  await mkdir(path);
  await writeFile(join(path, "z.txt"), "last\n");
  await writeFile(join(path, "a.txt"), "first\n");
  const before = await repositorySnapshot(root);
  await rm(path, { recursive: true });
  await mkdir(path);
  await writeFile(join(path, "a.txt"), "first\n");
  await writeFile(join(path, "z.txt"), "last\n");
  assert.deepEqual(await repositorySnapshot(root), before);
});

test("snapshot fingerprints a tracked directory replaced by a file", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "folder");
  await mkdir(path);
  await writeFile(join(path, "child.txt"), "child\n");
  await git(root, "add", "folder");
  const before = await repositorySnapshot(root);
  await rm(path, { recursive: true });
  await writeFile(path, "replacement\n");
  const after = await repositorySnapshot(root);
  assert.notEqual(after.treeHash, before.treeHash);
  assert.deepEqual(await repositorySnapshot(root), after);
  await writeFile(path, "changed\n");
  assert.notEqual((await repositorySnapshot(root)).treeHash, after.treeHash);
});

test("snapshot does not follow directory symlinks inside a replacement directory", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "AGENTS.md"), outside = join(f.dir, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "private.txt"), "outside\n");
  await rm(path);
  await mkdir(path);
  try {
    await symlink(outside, join(path, "linked"), process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") return t.skip("Windows denied directory symlink creation");
    throw e;
  }
  // Git for Windows may list files through a junction; those paths must fail closed.
  const before = await repositorySnapshot(root).catch((e: Error) => e);
  if (before instanceof Error) { assert.match(before.message, /escapes worktree/); return; }
  await writeFile(join(outside, "private.txt"), "changed outside\n");
  assert.deepEqual(await repositorySnapshot(root), before);
});

test("snapshot rejects tracked paths escaping through a directory symlink", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "folder"), outside = join(f.dir, "outside");
  await mkdir(path);
  await writeFile(join(path, "child.txt"), "child\n");
  await git(root, "add", "folder");
  await mkdir(outside);
  await writeFile(join(outside, "child.txt"), "outside\n");
  await rm(path, { recursive: true });
  try {
    await symlink(outside, path, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "EPERM") return t.skip("Windows denied directory symlink creation");
    throw e;
  }
  await assert.rejects(repositorySnapshot(root), /escapes worktree/);
});

test("snapshot enforces the per-file size budget inside a replacement directory", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "AGENTS.md");
  await rm(path);
  await mkdir(path);
  const file = join(path, "large.txt");
  await writeFile(file, "");
  await truncate(file, 20_000_001);
  await assert.rejects(repositorySnapshot(root), /Worktree fingerprint size budget exceeded/);
});

test("snapshot counts replacement files once and enforces the total size budget", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "AGENTS.md");
  await rm(path);
  await mkdir(path);
  for (let i = 0; i < 5; i++) {
    const file = join(path, `${i}.txt`);
    await writeFile(file, "");
    await truncate(file, 20_000_000);
  }
  const before = await repositorySnapshot(root);
  assert.equal(before.dirty, true);
  await writeFile(join(path, "extra.txt"), "x");
  await assert.rejects(repositorySnapshot(root), /Worktree fingerprint size budget exceeded/);
});

test("snapshot rejects a real submodule with a submodule-specific error", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot;
  const head = await git(root, "rev-parse", "HEAD");
  await mkdir(join(root, "module"));
  await git(root, "update-index", "--add", "--cacheinfo", `160000,${head},module`);
  assert.match(await git(root, "ls-files", "--stage", "module"), /^160000 /);
  await assert.rejects(repositorySnapshot(root), /Submodules require a project adapter/);
  await rm(join(root, "module"), { recursive: true });
  await assert.rejects(repositorySnapshot(root), /Submodules require a project adapter/);
});

test("snapshot counts directory aliases from an embedded repository once", async t => {
  const f = await supervisorFixture(), nested = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  t.after(() => rm(nested.dir, { recursive: true, force: true }));
  const root = f.config.repoRoot, path = join(root, "AGENTS.md");
  await rm(path);
  await mkdir(path);
  await rename(nested.config.repoRoot, join(path, "nested"));
  for (let i = 0; i < 3; i++) {
    const file = join(path, "nested", `${i}.txt`);
    await writeFile(file, "");
    await truncate(file, 17_000_000);
  }
  const snapshot = await repositorySnapshot(root);
  assert.equal(snapshot.dirty, true);
  assert.deepEqual(await repositorySnapshot(root), snapshot);
});
