import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToolHash } from "../src/checks.js";
import { digest } from "../src/state-store.js";
import { repositorySnapshot } from "../src/repository.js";
import { supervisorFixture } from "./supervisor-fixture.js";

test("a tool without file inputs retains its executable digest without querying Git", async t => {
  const root = await mkdtemp(join(tmpdir(), "salem tool nonrepo "));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exe = await realpath(process.execPath);
  const expected = digest([[exe, createHash("sha256").update(await readFile(exe)).digest("hex")]]);
  const previous = process.env.PATH;
  process.env.PATH = "";
  try {
    // Neither Git resolution nor repository listing is possible here. The digest
    // remains the original executable-only digest for a command with no inputs.
    assert.equal(await checkToolHash([process.execPath], root), expected);
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
  }
  // Repository identity is still mandatory at the snapshot boundary used by
  // runners, checks and delivery; the tool hash is not a substitute for it.
  await assert.rejects(repositorySnapshot(root), /status=exited, exitCode=128/);
});

test("a tool with an external file input still detects replacement on every call", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  const script = join(f.dir, "tool.mjs");
  await writeFile(script, "console.log('original');\n");
  const before = await checkToolHash([process.execPath, script], f.config.repoRoot);
  await writeFile(script, "console.log('replacement');\n");
  assert.notEqual(await checkToolHash([process.execPath, script], f.config.repoRoot), before);
});

test("tools larger than the 100 MB artifact limit are still pinned", async t => {
  const f = await supervisorFixture();
  t.after(() => rm(f.dir, { recursive: true, force: true }));
  // The Linux Node.js binary is larger than the artifact limit; a sparse file stands in for it.
  const tool = join(f.dir, "large-tool.bin"), handle = await open(tool, "w");
  try { await handle.truncate(150_000_000); } finally { await handle.close(); }
  assert.match(await checkToolHash([process.execPath, "-e", "0"], f.config.repoRoot, [tool]), /^[a-f0-9]{64}$/);
});
