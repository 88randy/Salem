import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, copyFile, link, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDiscoveryOnly, runChecks, verifyCheck } from "../src/checks.js";
import { checkFixture } from "./check-fixture.js";
import { repositorySnapshot } from "../src/repository.js";
import { git } from "./supervisor-fixture.js";

test("checks execute literal argv and persist exit, logs and exact repository proof", async () => {
  const f = await checkFixture();
  const evidence = await runChecks(f.config, f.snapshot.head, f);
  assert.equal(evidence[0]?.status, "passed"); assert.equal(evidence[0]?.execution, "actual"); assert.equal(evidence[0]?.exitCode, 0);
  assert.equal(evidence[0]?.treeHash, f.snapshot.treeHash); assert.ok(await verifyCheck(evidence[0]!, f.artifactDir));
  assert.match(await readFile(join(evidence[0]!.artifactDir, "stdout.log"), "utf8"), /real verification/);
  await writeFile(join(evidence[0]!.artifactDir, "stdout.log"), "forged output");
  assert.equal(await verifyCheck(evidence[0]!, f.artifactDir), false);
});

test("nonzero, dry-run and optional not-applicable remain distinct evidence", async () => {
  const f = await checkFixture(); f.config.budgets.stageTimeoutMs = 3000;
  f.config.checks = [
    { id: "failed", required: true, command: [process.execPath, "-e", "process.exit(3)"] },
    { id: "dry", required: true, command: [process.execPath, "--version"], mode: "dry_run" },
    { id: "skip", required: false, command: [process.execPath, "--version"], notApplicableReason: "No database in this demo" }
  ];
  const evidence = await runChecks(f.config, f.snapshot.head, f);
  assert.deepEqual(evidence.map(e => [e.checkId, e.status, e.execution, e.exitCode]), [["failed", "failed", "actual", 3], ["dry", "failed", "dry_run", null], ["skip", "not_applicable", "not_run", null]]);
});

test("an external check script change invalidates cached success", async () => {
  const f = await checkFixture(), script = join(f.dir, "checker.mjs");
  await writeFile(script, "console.log('actual check')\n"); f.config.checks[0]!.command = [process.execPath, script];
  const first = await runChecks(f.config, f.snapshot.head, f);
  await writeFile(script, "process.exit(1)\n");
  const second = await runChecks(f.config, f.snapshot.head, { ...f, cached: first });
  assert.equal(second[0]?.status, "failed"); assert.notEqual(second[0]?.id, first[0]?.id);
});

test("a replaced trusted checker is blocked rather than accepted as a new passing command", async () => {
  const f = await checkFixture(), script = join(f.dir, "pinned-checker.mjs");
  await writeFile(script, "console.log('actual test')\n"); f.config.checks[0]!.command = [process.execPath, script];
  const first = await runChecks(f.config, f.snapshot.head, f);
  await writeFile(script, "console.log('fabricated success without a test')\n");
  const changed = await runChecks(f.config, f.snapshot.head, { ...f, toolHashes: { test: first[0]!.toolHash } });
  assert.equal(changed[0]?.status, "failed"); assert.equal(changed[0]?.execution, "not_run"); assert.match(changed[0]!.reason!, /tool.*changed/i);
});

test("project test source may evolve with the reviewed tree while external checker policy stays pinned", async () => {
  const f = await checkFixture(), script = join(f.config.repoRoot, "test.mjs");
  await writeFile(script, "import assert from 'node:assert/strict';assert.equal(1+1,2);\n");
  f.config.checks[0]!.command = [process.execPath, script];
  const snapshot = await repositorySnapshot(f.config.repoRoot);
  const first = await runChecks(f.config, snapshot.head, { ...f, snapshot });
  await writeFile(script, "import assert from 'node:assert/strict';assert.equal(2+2,4);\n");
  const next = await repositorySnapshot(f.config.repoRoot);
  const evidence = await runChecks(f.config, next.head, { ...f, snapshot: next, fingerprint: "new-source-version", toolHashes: { test: first[0]!.toolHash } });
  assert.equal(evidence[0]?.status, "passed"); assert.equal(evidence[0]?.treeHash, next.treeHash);
});

test("timeout and cancellation cannot create a passing check receipt", async () => {
  const f = await checkFixture(); f.config.budgets.stageTimeoutMs = 100;
  f.config.checks[0]!.command = [process.execPath, "-e", "setInterval(()=>{},1000)"];
  const result = await runChecks(f.config, f.snapshot.head, f);
  assert.equal(result[0]?.status, "failed"); assert.match(result[0]!.reason!, /timeout/i);
  const controller = new AbortController(); controller.abort();
  const cancelled = await runChecks(f.config, f.snapshot.head, { ...f, signal: controller.signal });
  assert.equal(cancelled[0]?.status, "failed"); assert.match(cancelled[0]!.reason!, /cancel/i);
});

test("same-version valid checks are reused; altered logs or command invalidate the cache", async () => {
  const f = await checkFixture(); const first = await runChecks(f.config, f.snapshot.head, f);
  const second = await runChecks(f.config, f.snapshot.head, { ...f, cached: first });
  assert.equal(second[0]?.id, first[0]?.id);
  await writeFile(join(first[0]!.artifactDir, "stdout.log"), "tampered");
  const third = await runChecks(f.config, f.snapshot.head, { ...f, cached: first });
  assert.notEqual(third[0]?.id, first[0]?.id);
});

test("a check that edits the source cannot create passing evidence", async () => {
  const f = await checkFixture(); f.config.checks[0]!.command = [process.execPath, "-e", "require('fs').writeFileSync('AGENTS.md','changed')"];
  const evidence = await runChecks(f.config, f.snapshot.head, f);
  assert.equal(evidence[0]?.status, "failed"); assert.match(evidence[0]!.reason!, /changed|mutat/i);
});

test("checker entrypoints after interpreter flags are pinned before execution or cache reuse", async () => {
  const f = await checkFixture(), script = join(f.dir, "policy.test.mjs");
  await writeFile(script, "import assert from 'node:assert/strict';assert.equal(2+2,4);\n");
  f.config.checks[0]!.command = [process.execPath, "--test", script];
  const first = await runChecks(f.config, f.snapshot.head, f);
  assert.equal(first[0]?.status, "passed");
  await writeFile(script, "console.log('checker replaced with unconditional success')\n");
  const next = await runChecks(f.config, f.snapshot.head, { ...f, cached: first, toolHashes: { test: first[0]!.toolHash } });
  assert.equal(next[0]?.execution, "not_run"); assert.equal(next[0]?.status, "failed"); assert.notEqual(next[0]?.id, first[0]?.id);
});

test("Git-ignored checker inside the worktree is pinned independently of reviewed source", async () => {
  const f = await checkFixture(), dir = join(f.config.repoRoot, "node_modules", "policy");
  await mkdir(dir, { recursive: true }); await writeFile(join(f.config.repoRoot, ".gitignore"), "node_modules/\n");
  const script = join(dir, "check.mjs"); await writeFile(script, "console.log('real policy')\n");
  f.config.checks[0]!.command = [process.execPath, script];
  const snapshot = await repositorySnapshot(f.config.repoRoot);
  const first = await runChecks(f.config, snapshot.head, { ...f, snapshot });
  await writeFile(script, "console.log('forged success')\n");
  assert.deepEqual(await repositorySnapshot(f.config.repoRoot), snapshot);
  const next = await runChecks(f.config, snapshot.head, { ...f, snapshot, toolHashes: { test: first[0]!.toolHash } });
  assert.equal(next[0]?.execution, "not_run"); assert.equal(next[0]?.status, "failed");
});

test("ambiguous interpreter options require declared tool inputs and then pin those inputs", async () => {
  const f = await checkFixture(), script = join(f.dir, "policy.mjs");
  await writeFile(script, "import assert from 'node:assert/strict';assert.equal(2+2,4);\n");
  f.config.checks[0]!.command = [process.execPath, "--experimental-default-type=module", script];
  const blocked = await runChecks(f.config, f.snapshot.head, f);
  assert.equal(blocked[0]?.execution, "not_run"); assert.match(blocked[0]!.reason!, /tool.*inputs|ambiguous/i);
  f.config.checks[0]!.toolFiles = [script];
  const passed = await runChecks(f.config, f.snapshot.head, f); assert.equal(passed[0]?.status, "passed");
  await writeFile(script, "console.log('fake success')\n");
  const changed = await runChecks(f.config, f.snapshot.head, { ...f, toolHashes: { test: passed[0]!.toolHash } });
  assert.equal(changed[0]?.execution, "not_run"); assert.equal(changed[0]?.status, "failed");
});

test("only Django makemigrations --check --dry-run escapes the discovery-only guard", () => {
  const migrate = ["manage.py", "makemigrations", "--check", "--dry-run"];
  for (const command of [["python", ...migrate], ["python3", ...migrate], ["python3.12", ...migrate], ["C:\\Py\\python.exe", ...migrate], ["/usr/bin/python3", ...migrate],
    ["python", "manage.py", "makemigrations", "--dry-run", "--check"], ["python", "manage.py", "makemigrations", "app", "--check", "--dry-run"]])
    assert.equal(isDiscoveryOnly(command), false, command.join(" "));
  for (const command of [["python", "manage.py", "makemigrations", "--dry-run"], ["python", "manage.py", "migrate", "--check", "--dry-run"], ["python", "manage.py", "makemigrations", "--check", "--dry-run", "--help"],
    ["python", "manage.py", "makemigrations", "--check", "--dry-run", "--version"], ["python", "manage.py", "makemigrations", "--", "--check", "--dry-run"], ["python", "-W", "error", ...migrate],
    ["python", "-m", "django", "makemigrations", "--check", "--dry-run"], ["python", "sub/manage.py", "makemigrations", "--check", "--dry-run"], ["django-admin", "makemigrations", "--check", "--dry-run"],
    ["node", ...migrate], ["pythonw", ...migrate], ["python", "--collect-only"], ["pytest", "--collect-only"], ["jest", "--listTests"], ["vitest", "--list-tests"], ["python", "--help"], ["node", "--version"], ["tool", "--dry-run"]])
    assert.equal(isDiscoveryOnly(command), true, command.join(" "));
  assert.equal(isDiscoveryOnly(["python", "manage.py", "check"]), false);
});

test("makemigrations --check --dry-run runs; pending migrations fail without changing the worktree", async () => {
  const f = await checkFixture(), bin = join(f.dir, "bin"), python = join(bin, process.platform === "win32" ? "python.exe" : "python"), repo = f.config.repoRoot;
  await mkdir(bin); await link(process.execPath, python).catch(() => copyFile(process.execPath, python)); await chmod(python, 0o755);
  // A fake manage.py run by a node binary named python: like Django < 4.2, it writes the migration unless --dry-run is given.
  await writeFile(join(repo, "manage.py"), "const fs=require('fs'),a=process.argv.slice(2);if(a[0]!=='makemigrations')process.exit(2);"
    + "if(fs.readFileSync('models.txt','utf8')===(fs.existsSync('migrations/0001.txt')?fs.readFileSync('migrations/0001.txt','utf8'):'')){console.log('No changes detected');process.exit(0);}"
    + "console.log(\"Migrations for 'app':\");if(!a.includes('--dry-run')){fs.mkdirSync('migrations',{recursive:true});fs.writeFileSync('migrations/0001.txt',fs.readFileSync('models.txt'));}process.exit(a.includes('--check')?1:0);\n");
  await writeFile(join(repo, "models.txt"), "field\n"); await git(repo, "add", "manage.py", "models.txt");
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "pending model change");
  f.config.checks = [{ id: "django-migrations", required: true, command: [python, "manage.py", "makemigrations", "--check", "--dry-run"] }];
  const pending = await repositorySnapshot(repo), failed = await runChecks(f.config, pending.head, { ...f, snapshot: pending });
  assert.deepEqual([failed[0]?.status, failed[0]?.execution, failed[0]?.exitCode, failed[0]?.failureKind], ["failed", "actual", 1, "code"]);
  assert.match(await readFile(join(failed[0]!.artifactDir, "stdout.log"), "utf8"), /Migrations for 'app'/);
  assert.deepEqual(await repositorySnapshot(repo), pending); assert.ok(!(await readdir(repo)).includes("migrations"));
  await mkdir(join(repo, "migrations")); await writeFile(join(repo, "migrations", "0001.txt"), "field\n"); await git(repo, "add", "migrations");
  await git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "add migration");
  const clean = await repositorySnapshot(repo), passed = await runChecks(f.config, clean.head, { ...f, snapshot: clean });
  assert.deepEqual([passed[0]?.status, passed[0]?.execution, passed[0]?.exitCode, passed[0]?.failureKind], ["passed", "actual", 0, null]);
});

test("makemigrations options that exit 0 without verifying never escape the discovery-only guard", () => {
  const base = ["python", "manage.py", "makemigrations", "--check", "--dry-run"];
  // --merge and --empty return before applying --check; argparse accepts unambiguous prefixes of help/version.
  for (const extra of [["--merge"], ["--empty", "app"], ["-h"], ["--help"], ["--hel"], ["--vers"], ["--version"], ["--settings=x"], ["-v", "2"], ["--"], ["--noinput"]])
    assert.equal(isDiscoveryOnly([...base, ...extra]), true, extra.join(" "));
  assert.equal(isDiscoveryOnly([...base, "billing", "accounts"]), false);
});
