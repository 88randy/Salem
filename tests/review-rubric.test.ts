import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { StageInput } from "../src/contracts.js";
import { parsePayload } from "../src/adapters/schema.js";
import { runChecks } from "../src/checks.js";
import { evaluateAcceptance } from "../src/acceptance.js";
import { classifyRisk, addedDependencies } from "../src/review-policy.js";
import { runTask } from "../src/runner.js";
import { checkFixture } from "./check-fixture.js";
import { supervisorFixture } from "./supervisor-fixture.js";

const items = ["solves", "correct", "secure", "tested", "understandable", "style"] as const;
const rubric = (fail: Partial<Record<typeof items[number], string>> = {}) => Object.fromEntries(items.map(k => [k, fail[k] ? { pass: false, notes: fail[k] } : { pass: true, notes: "" }])) as Record<typeof items[number], { pass: boolean; notes: string }>;
const task = { id: "T-1", objective: "Fix the sum", scope: ["sum.mjs"], acceptance: ["sum adds"], references: [] };
const stage = (s: "define" | "build" | "review") => ({ stage: s, task } as unknown as StageInput);
const checked = <T extends Awaited<ReturnType<typeof supervisorFixture>>>(f: T): T => {
  f.config.checks = [{ id: "exists", required: true, command: [process.execPath, "-e", "require('assert/strict').ok(require('fs').existsSync('answer.txt'))"] }];
  f.task.acceptanceChecks = { "answer.txt exists": ["exists"] }; return f;
};
const payload = (s: string, extra: object = {}) => ({ schemaVersion: 1, stage: s, taskId: "T-1", verdict: "success", summary: "ok", evidenceRefs: [], findings: [], ...extra });

test("a review that omits any rubric item or the risk re-check is invalid", () => {
  assert.throws(() => parsePayload(payload("review"), stage("review")), /Review rubric incomplete/);
  for (const k of items) {
    const partial: Record<string, unknown> = rubric(); delete partial[k];
    assert.throws(() => parsePayload(payload("review", { rubric: partial, risk: { level: "normal", reasons: [] } }), stage("review")), new RegExp(`Review rubric incomplete: ${k}`));
  }
  assert.throws(() => parsePayload(payload("review", { rubric: rubric({ secure: " " }), risk: { level: "normal", reasons: [] } }), stage("review")), /incomplete/, "a failing item needs notes");
  assert.throws(() => parsePayload(payload("review", { rubric: rubric() }), stage("review")), /incomplete: risk/);
  assert.throws(() => parsePayload(payload("review", { rubric: rubric(), risk: { level: "high", reasons: [] } }), stage("review")), /Invalid risk/);
  assert.equal(parsePayload(payload("review", { rubric: rubric({ style: "naming" }), risk: { level: "normal", reasons: [] } }), stage("review")).rubric?.style.pass, false);
  assert.ok(parsePayload(payload("build"), stage("build")), "define/build results carry no rubric");
  assert.equal(parsePayload(payload("define", { rubric: null, risk: { level: "high", reasons: ["Cambia permisos"] } }), stage("define")).risk?.level, "high");
});

test("a failing security item blocks acceptance; a style-only finding does not; legacy reviews still load", async () => {
  const f = await checkFixture(); const evidence = await runChecks(f.config, f.snapshot.head, f);
  assert.equal((await evaluateAcceptance(f.task, evidence, f.review, f.context)).accepted, true, "a review recorded before the rubric is still valid");
  const secure = structuredClone(f.review); secure.payload!.rubric = rubric({ secure: "Expone datos de otros usuarios" });
  const blocked = await evaluateAcceptance(f.task, evidence, secure, f.context);
  assert.equal(blocked.accepted, false); assert.ok(blocked.reasons.includes("Review rubric fails: secure"));
  for (const k of ["solves", "correct", "tested"] as const) {
    const r = structuredClone(f.review); r.payload!.rubric = rubric({ [k]: "fails" }); assert.equal((await evaluateAcceptance(f.task, evidence, r, f.context)).accepted, false, k);
  }
  const style = structuredClone(f.review); style.payload!.rubric = rubric({ style: "Nombre poco claro", understandable: "Falta un comentario" });
  style.payload!.findings = [{ severity: "minor", description: "Renombrar la variable" }];
  assert.equal((await evaluateAcceptance(f.task, evidence, style, f.context)).accepted, true);
  style.payload!.findings = [{ severity: "critical", description: "Ilegible al punto de ocultar un fallo" }];
  assert.equal((await evaluateAcceptance(f.task, evidence, style, f.context)).accepted, false, "5 and 6 block when critical");
});

test("high-risk acceptance requires the other provider's review", async () => {
  const f = await checkFixture(); const evidence = await runChecks(f.config, f.snapshot.head, f);
  const risk = { level: "high" as const, reasons: ["auth"] };
  assert.equal((await evaluateAcceptance(f.task, evidence, f.review, { ...f.context, risk, implementationProvider: "codex" })).accepted, false);
  assert.equal((await evaluateAcceptance(f.task, evidence, { ...f.review, provider: "claude" }, { ...f.context, risk, implementationProvider: "codex" })).accepted, true);
  const flagged = structuredClone(f.review); flagged.payload!.risk = risk;
  assert.equal((await evaluateAcceptance(f.task, evidence, flagged, { ...f.context, implementationProvider: "codex" })).accepted, false, "the reviewer's own high classification counts");
});

test("risk is high for authentication, data model and destructive migrations, from the spec or the diff", () => {
  assert.equal(classifyRisk(task).level, "normal");
  assert.equal(classifyRisk({ ...task, objective: "Agregar inicio de sesión con contraseña" }).level, "high");
  assert.equal(classifyRisk({ ...task, objective: "Change the data model for orders" }).level, "high");
  const auth = "diff --git a/src/auth/session.ts b/src/auth/session.ts\n--- a/src/auth/session.ts\n+++ b/src/auth/session.ts\n@@ -1 +1 @@\n-export const ttl = 1;\n+export const ttl = 0;\n";
  const authRisk = classifyRisk(task, auth);
  assert.equal(authRisk.level, "high"); assert.match(authRisk.explanation, /^Este cambio toca el inicio de sesión o los permisos, por eso lo revisa una IA distinta/);
  assert.doesNotMatch(authRisk.explanation, /diff|provider|auth/i, "the explanation is plain Spanish");
  const migration = 'diff --git a/app/migrations/0007_drop.py b/app/migrations/0007_drop.py\n+++ b/app/migrations/0007_drop.py\n+        migrations.RemoveField(model_name="order", name="note"),\n';
  assert.ok(classifyRisk(task, migration).reasons.includes("el borrado de datos guardados"));
  assert.ok(classifyRisk(task, '\nUNTRACKED "db/0002.sql"\nDROP TABLE users;\n').reasons.includes("el borrado de datos guardados"));
  assert.equal(classifyRisk(task, "diff --git a/sum.mjs b/sum.mjs\n+++ b/sum.mjs\n+export const sum = (a, b) => a + b;\n").level, "normal");
  assert.equal(classifyRisk(task, "", [{ level: "high", reasons: ["El revisor vio un cambio de permisos"] }]).level, "high", "agents may raise risk");
});

test("dependency files: packages a change adds are listed for registry verification", () => {
  const tracked = 'diff --git a/package.json b/package.json\n+++ b/package.json\n   "dependencies": {\n+    "reqeusts-turbo-ai": "^2.1.0",\n+    "@scope/real": "~1.0.0",\n   },\n   "scripts": {\n+    "build": "tsc -p ."\n';
  assert.deepEqual(addedDependencies(tracked), ["@scope/real", "reqeusts-turbo-ai"]);
  assert.deepEqual(addedDependencies('\nUNTRACKED "package.json"\n{"dependencies":{"left-pad":"1.3.0"},"devDependencies":{"fakepkg-ai":"1.0.0"}}\n'), ["fakepkg-ai", "left-pad"]);
  assert.deepEqual(addedDependencies("diff --git a/requirements.txt b/requirements.txt\n+++ b/requirements.txt\n+django==5.1\n+pandaz-ml>=0.2\n+# comment\n"), ["django", "pandaz-ml"]);
});

test("templates carry the rubric in priority order and the AI-code and security checklists", async () => {
  const review = await readFile(resolve("templates/review.md"), "utf8");
  const order = items.map(k => review.indexOf(`${k}:`)); assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1]!)), "rubric in priority order");
  for (const text of ["NEW_DEPENDENCIES_JSON", "otra versión mayor", "Autorización rota", "datos personales", "RISK_JSON", "deshacer"]) assert.ok(review.includes(text), text);
  assert.match(await readFile(resolve("templates/define.md"), "utf8"), /risk/);
});

test("supervisor: a review missing rubric items is rerun before acceptance", async () => {
  const f = await supervisorFixture("no-rubric");
  checked(f);
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  assert.deepEqual(state.attempts.map(a => [a.stage, a.valid]), [["define", true], ["build", true], ["review", false], ["review", true]]);
  assert.match(state.attempts[2]!.result!.error!, /Review rubric incomplete: secure/);
  assert.equal(state.acceptance?.accepted, true); assert.equal(state.nextPhase, "delivering");
});

test("supervisor: a security failure sends the change back; a style-only finding does not", async () => {
  const security = checked(await supervisorFixture("security"));
  const s = await runTask(security.task, security.config, { stateDir: security.stateDir });
  assert.deepEqual(s.attempts.map(a => a.stage), ["define", "build", "review", "build", "review"]); assert.equal(s.acceptance?.accepted, true);
  const style = checked(await supervisorFixture("style"));
  const t = await runTask(style.task, style.config, { stateDir: style.stateDir });
  assert.deepEqual(t.attempts.map(a => a.stage), ["define", "build", "review"]); assert.equal(t.acceptance?.accepted, true);
});

test("supervisor: a high-risk change with one provider stops with a plain question", async () => {
  const f = checked(await supervisorFixture()); f.task.objective = "Add password reset to authentication";
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  assert.equal(state.status, "blocked"); assert.equal(state.risk?.level, "high");
  assert.ok(state.attempts.every(a => a.stage !== "review"), "no same-provider review is run silently");
  assert.match(state.reason!, /^Este cambio toca el inicio de sesión o los permisos, así que conviene que lo revise una IA distinta.*\?$/);
});

test("supervisor: a diff touching authentication is reviewed by the other provider when both are available", async () => {
  const f = checked(await supervisorFixture("auth-diff")); f.config.agents.second = { provider: "claude", command: f.config.agents.worker!.command };
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  const reviews = state.attempts.filter(a => a.stage === "review");
  assert.deepEqual(reviews.map(a => [a.agentId, a.result?.provider]), [["second", "claude"]]);
  assert.ok(state.history.some(h => h.status === "reviewing" && h.reason === state.risk?.explanation && /^Este cambio toca/.test(h.reason)));
  const prompt = (await readFile(f.trace, "utf8")).trim().split("\n").map(l => JSON.parse(l)).find(l => l.stage === "review").prompt as string;
  assert.equal(JSON.parse(prompt.match(/^RISK_JSON=(.+)$/m)![1]!).level, "high");
  assert.equal(state.acceptance?.accepted, true);
});

test("supervisor: a reviewer that finds high risk in the diff hands acceptance to the other provider", async () => {
  const f = await supervisorFixture("risky-diff"); f.config.agents.second = { provider: "claude", command: f.config.agents.worker!.command };
  checked(f);
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  assert.deepEqual(state.attempts.filter(a => a.stage === "review").map(a => a.result?.provider), ["codex", "claude"]);
  assert.equal(state.acceptance?.accepted, true); assert.equal(state.risk?.level, "high");
});

test("supervisor: an invented package in a dependency file is flagged by the review", async () => {
  const f = await supervisorFixture("invented-package"); f.config.supervisor!.maxAttempts = 3;
  checked(f);
  const state = await runTask(f.task, f.config, { stateDir: f.stateDir });
  const review = state.attempts.find(a => a.stage === "review")!.result!.payload!;
  assert.match(review.findings![0]!.description, /reqeusts-turbo-ai/); assert.doesNotMatch(review.findings![0]!.description, /left-pad/);
  assert.equal(review.rubric?.correct.pass, false); assert.notEqual(state.acceptance?.accepted, true);
});
