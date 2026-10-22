import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
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
