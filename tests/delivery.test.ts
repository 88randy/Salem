import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deliveryFixture } from "./delivery-fixture.js";
import { git } from "./supervisor-fixture.js";
import { deliver,deliveryToolsHash } from "../src/delivery.js";
import { repositorySnapshot } from "../src/repository.js";
import type { DeliveryJournal } from "../src/delivery-contracts.js";
import { runChecks } from "../src/checks.js";

test("delivery commits exactly the accepted bytes on a reserved branch without changing reviewed HEAD/index", async () => {
  const f = await deliveryFixture(), before = await repositorySnapshot(f.config.repoRoot);
  const result = await deliver(f.input);
  assert.equal(result.verdict, "success"); assert.ok(result.sha); assert.notEqual(result.sha, before.head);
  assert.equal(await git(f.config.repoRoot, "show", `${result.sha}:answer.txt`), "reviewed");
  assert.equal(await git(f.config.repoRoot, "rev-parse", `${result.sha}^`), before.head);
  assert.deepEqual(await repositorySnapshot(f.config.repoRoot), before);
  assert.equal(await git(f.config.repoRoot, "rev-parse", `refs/heads/${result.journal.branch}`), result.sha);
});

test("changed code or absent delegated commit prevents any delivery branch", async () => {
  const f = await deliveryFixture(); await writeFile(join(f.config.repoRoot, "answer.txt"), "not reviewed\n");
  await assert.rejects(deliver(f.input), /version|worktree|acceptance/i);
  assert.equal((await git(f.config.repoRoot, "for-each-ref", "--format=%(refname)", "refs/heads/feature/")).trim(), "");
  const denied = await deliveryFixture(); denied.config.capabilities.commit = false;
  await assert.rejects(deliver(denied.input), /authority|capability|delegated|acceptance/i);
});

test("recovery of a commit after the effect uses the same SHA and never duplicates the branch", async () => {
  const f = await deliveryFixture(); let journal: DeliveryJournal | undefined;
  await assert.rejects(deliver({ ...f.input, onCheckpoint: async j => {
    journal = j; if (j.actions.some(a => a.action === "commit" && a.status === "succeeded")) throw new Error("crash after effect");
  } }), /crash after effect/);
  assert.ok(journal?.commitSha); const sha = journal.commitSha;
  const resumed = await deliver({ ...f.input, journal });
  assert.equal(resumed.sha, sha); assert.equal(resumed.actions.filter(a => a.action === "commit").length, 1);
  assert.equal((await git(f.config.repoRoot, "for-each-ref", "--format=%(refname)", "refs/heads/feature/")).split("\n").length, 1);
});

test("cancellation after commit preserves its receipt and resume completes without repeating it", async () => {
  const f = await deliveryFixture(), controller = new AbortController();
  const first = await deliver({ ...f.input, signal: controller.signal, onCheckpoint: async j => {
    if (j.actions.some(a => a.action === "commit" && a.status === "succeeded")) controller.abort();
  } });
  assert.equal(first.verdict, "blocked"); assert.equal(first.actions[0]?.status, "succeeded");
  const resumed = await deliver({ ...f.input, journal: first.journal });
  assert.equal(resumed.verdict, "success"); assert.equal(resumed.sha, first.sha);
  assert.equal(await readFile(join(f.config.repoRoot, "answer.txt"), "utf8"), "reviewed\n");
});
test("a descendant ref cannot impersonate the exact reserved delivery branch",async()=>{
  const f=await deliveryFixture(),first=await deliver(f.input),ref=`refs/heads/${first.journal.branch}`;
  await git(f.config.repoRoot,"update-ref","-d",ref);await git(f.config.repoRoot,"update-ref",`${ref}/child`,first.journal.commitSha!);
  const result=await deliver({...f.input,journal:first.journal});
  assert.equal(result.verdict,"blocked");assert.match(result.summary,/changed|unknown|branch|repetition/i);
});
test("unreviewed Git execution configuration cannot change after delivery preflight",async()=>{
  const f=await deliveryFixture(),expectedToolsHash=await deliveryToolsHash(f.config);
  await git(f.config.repoRoot,"config","core.sshCommand","do-not-execute");
  await assert.rejects(deliver({...f.input,expectedToolsHash}),/tool.*changed/i);
});
test("raw materialization must not introduce normalization changes outside the reviewed diff",async()=>{
  const f=await deliveryFixture();
  await writeFile(join(f.config.repoRoot,".gitattributes"),"stable.txt text eol=lf\n");await writeFile(join(f.config.repoRoot,"stable.txt"),"stable\n");
  await git(f.config.repoRoot,"add",".gitattributes","stable.txt");
  await git(f.config.repoRoot,"-c","user.name=Demo","-c","user.email=demo@example.invalid","commit","-m","normalization baseline");
  await writeFile(join(f.config.repoRoot,"stable.txt"),"stable\r\n");
  assert.equal(await git(f.config.repoRoot,"diff","--name-only","HEAD","--","stable.txt"),"");
  const snapshot=await repositorySnapshot(f.config.repoRoot);f.input.context.snapshot=snapshot;f.input.review.repoSha=snapshot.head;
  f.input.evidence=await runChecks(f.config,snapshot.head,{...f,snapshot});
  await assert.rejects(deliver(f.input),/normalization|materialization|reviewed diff/i);
  assert.equal(await git(f.config.repoRoot,"for-each-ref","--format=%(refname)","refs/heads/feature/"),"");
});
