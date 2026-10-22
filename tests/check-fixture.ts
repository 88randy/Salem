import { join } from "node:path";
import { supervisorFixture } from "./supervisor-fixture.js";
import { repositorySnapshot } from "../src/repository.js";
import type { StageResult } from "../src/contracts.js";
export async function checkFixture() {
  const f = await supervisorFixture();
  f.config.checks = [{ id: "test", command: [process.execPath, "-e", "console.log('real verification')"], required: true }];
  f.task.acceptanceChecks = { "answer.txt exists": ["test"] };
  const snapshot = await repositorySnapshot(f.config.repoRoot), artifactDir = join(f.dir, "checks"), fingerprint = "exact-fixture-version";
  const review: StageResult = { schemaVersion: 1, provider: "codex", stage: "review", taskId: f.task.id, status: "succeeded", payload: { schemaVersion: 1, stage: "review", taskId: f.task.id, verdict: "success", summary: "Reviewed", evidenceRefs: ["test"], findings: [] },
    error: null, sessionId: "independent-review", exitCode: 0, usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, costUsd: null, costKind: "unavailable", model: null },
    durationMs: 1, artifactDir: join(f.dir, "review"), repoSha: snapshot.head, verificationFingerprint: fingerprint };
  const context = { config: f.config, snapshot, fingerprint, evidenceRoot: artifactDir, implementationSessionId: "implementation" };
  return { ...f, snapshot, artifactDir, fingerprint, review, context };
}
