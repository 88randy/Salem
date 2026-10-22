import { test } from "node:test";
import assert from "node:assert/strict";
import { runChecks } from "../src/checks.js";
import { evaluateAcceptance } from "../src/acceptance.js";
import { checkFixture } from "./check-fixture.js";

test("acceptance requires recorded checks, mapped criteria and independent successful review", async () => {
  const f = await checkFixture(); const evidence = await runChecks(f.config, f.snapshot.head, f);
  assert.equal((await evaluateAcceptance(f.task, evidence, f.review, f.context)).accepted, true);
  assert.equal((await evaluateAcceptance(f.task, [], f.review, f.context)).accepted, false);
  const noMapping = { ...f.task }; delete noMapping.acceptanceChecks;
  assert.equal((await evaluateAcceptance(noMapping, evidence, f.review, f.context)).accepted, false);
  assert.equal((await evaluateAcceptance({ ...f.task, acceptance: [] }, evidence, f.review, f.context)).accepted, false);
  const sameSession = { ...f.review, sessionId: "implementation" };
  assert.equal((await evaluateAcceptance(f.task, evidence, sameSession, f.context)).accepted, false);
});

test("green evidence for another SHA/tree or a dry-run cannot authorize acceptance", async () => {
  const f = await checkFixture(); const evidence = await runChecks(f.config, f.snapshot.head, f);
  for (const change of [{ repoSha: "wrong" }, { treeHash: "wrong" }, { execution: "dry_run" as const }, { exitCode: 7 }, { proofHash: "invented" }]) {
    assert.equal((await evaluateAcceptance(f.task, [{ ...evidence[0]!, ...change }], f.review, f.context)).accepted, false);
  }
  assert.equal((await evaluateAcceptance(f.task, evidence, { ...f.review, verificationFingerprint: "older-version" }, f.context)).accepted, false);
});

test("a blocking review or JSON success without requirement proof is rejected", async () => {
  const f = await checkFixture(); const evidence = await runChecks(f.config, f.snapshot.head, f);
  const review = structuredClone(f.review); review.payload!.verdict = "needs_changes";
  assert.equal((await evaluateAcceptance(f.task, evidence, review, f.context)).accepted, false);
  review.payload!.verdict = "success"; review.payload!.findings = [{ severity: "important", description: "Blocking defect despite success verdict" }];
  assert.equal((await evaluateAcceptance(f.task, evidence, review, f.context)).accepted, false);
  f.task.acceptance.push("another requirement without a check");
  assert.equal((await evaluateAcceptance(f.task, evidence, f.review, f.context)).accepted, false);
});

test("not-applicable with a reason is valid only for optional non-covering checks", async () => {
  const f = await checkFixture(); f.config.checks.push({ id: "optional", command: [process.execPath, "--version"], required: false, notApplicableReason: "No DB" });
  const evidence = await runChecks(f.config, f.snapshot.head, f);
  assert.equal((await evaluateAcceptance(f.task, evidence, f.review, f.context)).accepted, true);
  f.config.checks[1]!.required = true;
  assert.equal((await evaluateAcceptance(f.task, evidence, f.review, f.context)).accepted, false);
});
