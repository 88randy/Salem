import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryFiles } from "../src/repository.js";

test("repository failure reports the failed Git operation and actual process outcome", async t => {
  const root = await mkdtemp(join(tmpdir(), "salem nonrepo "));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(repositoryFiles(root), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /git ls-files/);
    assert.match(error.message, /status=exited/);
    assert.match(error.message, /exitCode=128/);
    assert.match(error.message, /not a git repository/i);
    assert.ok(error.message.includes(root));
    return true;
  });
});

test("repository failure distinguishes missing Git from an invalid worktree", async () => {
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    await assert.rejects(repositoryFiles(process.cwd()), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /status=failed/);
      assert.match(error.message, /exitCode=null/);
      assert.match(error.message, /Executable not found: git/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
});

test("repository diagnostics redact secrets before reporting process context", async t => {
  const root = await mkdtemp(join(tmpdir(), "salem diagnostic secret "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.SALEM_DIAGNOSTIC_TEST_SECRET;
  process.env.SALEM_DIAGNOSTIC_TEST_SECRET = root;
  try {
    await assert.rejects(repositoryFiles(root), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(root));
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    });
  } finally {
    if (previous === undefined) delete process.env.SALEM_DIAGNOSTIC_TEST_SECRET;
    else process.env.SALEM_DIAGNOSTIC_TEST_SECRET = previous;
  }
});
