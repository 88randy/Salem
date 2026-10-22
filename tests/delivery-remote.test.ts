import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { deliveryFixture, localOrigin } from "./delivery-fixture.js";
import { forgeFixture } from "./forge-fixture.js";
import { runChecks } from "../src/checks.js";
import { deliver, deliveryToolsHash } from "../src/delivery.js";
import { git } from "./supervisor-fixture.js";
import type {DeliveryJournal} from "../src/delivery-contracts.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const f = await deliveryFixture(), origin = await localOrigin(f.config.repoRoot, f.dir), forge = await forgeFixture(origin);
  t.after(forge.close); f.config.capabilities.pull_request = true;
  f.config.delivery!.github = { command: forge.command, remote: "origin", remoteUrl: origin, repository: "demo/project", baseBranch: "main", draft: false };
  const authorize = async () => { f.input.evidence = await runChecks(f.config, f.snapshot.head, { ...f, snapshot: f.snapshot }); };
  return { ...f, origin, forge, authorize };
}

test("insufficient remote permissions cannot cause a commit or push", async t => {
  const f = await fixture(t); f.forge.state.canPush = false; await f.authorize();
  await assert.rejects(deliver(f.input), /permission|credential|push/i);
  assert.equal(await git(f.config.repoRoot, "for-each-ref", "--format=%(refname)", "refs/heads/feature/"), "");
});
test("a lost PR response is reconciled by identity without creating a duplicate PR", async t => {
  const f = await fixture(t); await f.authorize(); f.forge.state.loseCreate = "after";
  const first = await deliver(f.input); assert.equal(first.verdict, "blocked");
  const second = await deliver({ ...f.input, journal: first.journal });
  assert.equal(second.verdict, "success"); assert.equal(f.forge.state.pulls.length, 1);
  assert.equal(f.forge.state.pulls[0]!.head.sha, second.sha);
  assert.equal(await git(f.origin, "rev-parse", `refs/heads/${second.journal.branch}`), second.sha);
});
test("an unknown PR outcome with no matching object blocks without a blind retry", async t => {
  const f = await fixture(t); await f.authorize(); f.forge.state.loseCreate = "before";
  const first = await deliver(f.input); assert.equal(first.verdict, "blocked");
  f.forge.state.loseCreate = "";
  const second = await deliver({ ...f.input, journal: first.journal });
  assert.equal(second.verdict, "blocked"); assert.equal(f.forge.state.pulls.length, 0);
});
test("merge requires successful same-SHA checks and reconciles a lost merge response", async t => {
  const f = await fixture(t); f.config.capabilities.merge = true;
  f.config.delivery!.github!.merge = { method: "merge", requiredChecks: ["build"] }; await f.authorize();
  f.forge.state.checks[0]!.conclusion = "skipped";
  const first = await deliver(f.input); assert.equal(first.verdict, "blocked"); assert.equal(f.forge.state.pulls[0]!.merged, false);
  f.forge.state.checks[0]!.conclusion = "success"; f.forge.state.loseMerge = true;
  const second = await deliver({ ...f.input, journal: first.journal }); assert.equal(second.verdict, "blocked");
  const third = await deliver({ ...f.input, journal: second.journal }); assert.equal(third.verdict, "success");
  assert.equal(await git(f.origin, "rev-parse", "refs/heads/main"), third.journal.releaseSha);
  assert.equal(await git(f.origin, "rev-parse", `${third.journal.releaseSha}^{tree}`), third.journal.tree);
});
test("a failed deploy stays failed and a lost successful deploy is queried without repetition", async () => {
  for (const mode of ["fail", "lost"]) {
    const f = await deliveryFixture(), root = join(f.dir, "deployed"); await mkdir(root); await writeFile(join(root,"mode.txt"), mode);
    const command = [process.execPath, resolve("tests/fixtures/demo-deploy.mjs"), root];
    f.config.capabilities.deploy = true; f.config.delivery!.deploy = { command, statusCommand: command, target: "local-demo", requiredChecks: [] };
    f.input.evidence = await runChecks(f.config, f.snapshot.head, { ...f, snapshot: f.snapshot });
    const first = await deliver(f.input); assert.equal(first.verdict, "blocked");
    await writeFile(join(root,"mode.txt"), "");
    const resumed = await deliver({ ...f.input, journal: first.journal });
    assert.equal(resumed.verdict, mode === "lost" ? "success" : "blocked");
    const receipts = (await readdir(root)).filter(p => p.endsWith(".json")); assert.equal(receipts.length, 1);
    const release = JSON.parse(await readFile(join(root,receipts[0]!),"utf8")); assert.equal(release.sha, resumed.sha);
    assert.equal(release.status, mode === "lost" ? "succeeded" : "failed");
  }
});
test("delivery tools replaced after preflight are rejected before executing their query command",async t=>{
  const f=await fixture(t),script=join(f.dir,"gh-policy.mjs"),marker=join(f.dir,"executed.txt");
  await writeFile(script,await readFile(resolve("tests/fixtures/gh-client.mjs"),"utf8"));f.config.delivery!.github!.command=[process.execPath,script,f.forge.url];
  await f.authorize();const expectedToolsHash=await deliveryToolsHash(f.config);
  await writeFile(script,`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker)},'executed');console.log(JSON.stringify({full_name:'demo/project',permissions:{push:true}}));`);
  await assert.rejects(deliver({...f.input,expectedToolsHash}),/tool.*changed/i);
  await assert.rejects(readFile(marker,"utf8"),{code:"ENOENT"});
});
test("controller delivery does not execute unreviewed Git hooks",async t=>{
  const f=await fixture(t);await f.authorize();
  await writeFile(join(f.snapshot.gitDir,"hooks","pre-push"),"#!/bin/sh\nprintf hook-executed > .git/hook-ran\n",{mode:0o755});
  const result=await deliver(f.input);assert.equal(result.verdict,"success");
  await assert.rejects(readFile(join(f.snapshot.gitDir,"hook-ran"),"utf8"),{code:"ENOENT"});
});
test("merge refuses a strict policy that still allows administrator bypass",async t=>{
  const f=await fixture(t);f.config.capabilities.merge=true;f.config.delivery!.github!.merge={method:"merge",requiredChecks:["build"]};
  f.forge.state.enforceAdmins=false;await f.authorize();
  const result=await deliver(f.input);assert.equal(result.verdict,"blocked");assert.equal(f.forge.state.pulls[0]!.merged,false);
});
test("multiple push destinations are rejected before publishing to an unauthorized bare repository",async t=>{
  const f=await fixture(t),other=join(f.dir,"unauthorized.git");await mkdir(other);await git(other,"init","--bare","-b","main");
  await git(f.config.repoRoot,"config","--add","remote.origin.pushurl",f.origin);await git(f.config.repoRoot,"config","--add","remote.origin.pushurl",other);
  await f.authorize();await assert.rejects(deliver(f.input),/destination|push.*url|multiple/i);
  assert.equal(await git(other,"for-each-ref","--format=%(refname)"),"");
});
test("implicit followTags cannot publish refs outside the delegated branch",async t=>{
  const f=await fixture(t);await git(f.config.repoRoot,"-c","user.name=Demo","-c","user.email=demo@example.invalid","tag","-a","private-tag","-m","not delegated");
  await git(f.config.repoRoot,"config","push.followTags","true");await f.authorize();
  const result=await deliver(f.input);assert.equal(result.verdict,"success");
  assert.equal(await git(f.origin,"for-each-ref","--format=%(refname)","refs/tags/"),"");
});
test("push recovery queries the exact authorized push URL even when fetch uses a different repository",async t=>{
  const f=await fixture(t),pushRoot=join(f.dir,"push-destination.git");await mkdir(pushRoot);await git(pushRoot,"init","--bare","-b","main");
  await git(f.config.repoRoot,"push",pushRoot,"HEAD:refs/heads/main");await git(f.config.repoRoot,"config","remote.origin.pushurl",pushRoot);
  const pushForge=await forgeFixture(pushRoot);t.after(pushForge.close);
  f.config.delivery!.github!.remoteUrl=pushRoot;f.config.delivery!.github!.command=pushForge.command;await f.authorize();let journal:DeliveryJournal|undefined;
  await assert.rejects(deliver({...f.input,onCheckpoint:async j=>{journal=j;if(j.actions.some(a=>a.action==="push"&&a.status==="succeeded"))throw new Error("interrupt after push effect");}}),/interrupt after push effect/);
  assert.ok(journal);const resumed=await deliver({...f.input,journal});assert.equal(resumed.verdict,"success");
  assert.equal(await git(f.origin,"for-each-ref","--format=%(refname)","refs/heads/feature/"),"");
  assert.equal(await git(pushRoot,"rev-parse",`refs/heads/${resumed.journal.branch}`),resumed.journal.commitSha);
  assert.equal(pushForge.state.pulls.length,1);
});
test("an external merge after a failed check cannot become accepted delivery on resume",async t=>{
  const f=await fixture(t);f.config.capabilities.merge=true;f.config.delivery!.github!.merge={method:"merge",requiredChecks:["build"]};await f.authorize();
  f.forge.state.checks[0]!.conclusion="skipped";const first=await deliver(f.input);assert.equal(first.verdict,"blocked");
  const merged=await git(f.origin,"-c","user.name=External","-c","user.email=external@example.invalid","commit-tree",first.journal.tree!,"-p",f.snapshot.head,"-p",first.journal.commitSha!,"-m","external bypass");
  await git(f.origin,"update-ref","refs/heads/main",merged,f.snapshot.head);
  Object.assign(f.forge.state.pulls[0]!,{merged:true,state:"closed",merge_commit_sha:merged});
  const resumed=await deliver({...f.input,journal:first.journal});assert.equal(resumed.verdict,"blocked");
  assert.notEqual(resumed.actions.find(a=>a.action==="merge")?.status,"succeeded");
});
