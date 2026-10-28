import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localDiff } from "../src/local/git.js";
import { git } from "./supervisor-fixture.js";

// The UI polls execution detail, so several diffs of one copy can overlap. Each one writes the same empty blob
// through add --intent-to-add; on Windows concurrent writers of one loose object can fail with "Permission denied".
test("concurrent diffs of one repository all succeed", async () => {
  for (let round = 0; round < 10; round++) {
    const root = await mkdtemp(join(tmpdir(), "salem diff race ")), repo = join(root, "repo"), systemDir = join(root, "system");
    await mkdir(systemDir); await git(root, "init", "-q", repo); await writeFile(join(repo, "tracked.txt"), "baseline\n");
    await git(repo, "add", "tracked.txt"); await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base");
    const sha = await git(repo, "rev-parse", "HEAD");
    for (let i = 0; i < 6; i++) await writeFile(join(repo, `new-${i}.txt`), `new ${i}\n`);
    const diffs = await Promise.all(Array.from({ length: 16 }, () => localDiff(repo, sha, systemDir)));
    for (const diff of diffs) assert.match(diff, /\+new 5/);
  }
});

// Polling must not pile up work: equivalent requests that are still waiting share one diff.
test("equivalent waiting diffs share one run", async () => {
  const root = await mkdtemp(join(tmpdir(), "salem diff share ")), repo = join(root, "repo"), systemDir = join(root, "system");
  await mkdir(systemDir); await git(root, "init", "-q", repo); await writeFile(join(repo, "tracked.txt"), "baseline\n");
  await git(repo, "add", "tracked.txt"); await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "base");
  const sha = await git(repo, "rev-parse", "HEAD");
  const running = localDiff(repo, sha, systemDir), waiting = [localDiff(repo, sha, systemDir), localDiff(repo, sha, systemDir), localDiff(repo, sha, systemDir)];
  assert.equal(new Set(waiting).size, 1);
  const other = localDiff(repo, sha, systemDir, { args: ["--stat"] });
  assert.ok(!waiting.includes(other));
  await Promise.all([running, ...waiting, other]);
});
