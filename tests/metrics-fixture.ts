import type { RunState, RunAttempt, Usage } from "../src/contracts.js";
import { randomUUID } from "node:crypto";
export function measuredRun(): RunState {
  return { schemaVersion: 1, id: randomUUID(), revision: 2, projectId: "demo", task: { id: "bug", objective: "fix", scope: ["sum.mjs"], acceptance: ["sum"], references: [] },
    status: "completed", nextPhase: "delivering", reason: null, createdAt: 1000, updatedAt: 11000, deadlineAt: 20000,
    configHash: "config", instructionsHash: "instructions", toolsHash: "tools",
    expected: { root: randomUUID(), gitDir: "git", head: "base", treeHash: "tree", dirty: true },
    attempts: [], history: [], checks: [], validation: null, deliveryIntent: null,
    acceptance: { accepted: true, fingerprint: "proof", reasons: [], checkIds: ["check"] },
    delivery: { id: "delivery", fingerprint: "proof", verdict: "success", evidenceRefs: ["receipt"], summary: "done" },
    telemetry: { schemaVersion: 1, invocations: [{ id: "initial", startedAt: 1000, finishedAt: 3000 }, { id: "resume", startedAt: 9000, finishedAt: 11000 }],
      interventions: [], agents: { worker: { provider: "codex", command: ["codex"], version: "1", executableHash: "exe", agentConfigHash: "agent" } },
      benchmark: { suiteId: "suite", protocolHash: "protocol", caseId: "bug", kind: "bug", mode: "framework", provider: "codex", baseSha: "base", acceptanceHash: "acceptance", agentConfigHash: "agent", limitsHash: "limits", environment: "win32-node22", setupMs: 200 } } };
}
export function metricAttempt(id: string, usage: Partial<Usage> = {}, stage: RunAttempt["stage"] = "build"): RunAttempt {
  const before = measuredRun().expected;
  return { id, stage, agentId: "worker", startedAt: 1100, finishedAt: 2100, before, after: before, artifactDir: id, valid: true,
    result: { schemaVersion: 1, provider: "codex", stage, taskId: "bug", status: "succeeded", payload: { schemaVersion: 1, taskId: "bug", stage, verdict: "success", summary: "done", evidenceRefs: ["file"] },
      error: null, exitCode: 0, sessionId: id, repoSha: "base", durationMs: 1000, artifactDir: id,
      usage: { inputTokens: 10, outputTokens: 2, cachedInputTokens: 3, costUsd: null, costKind: "unavailable", model: "model-a", ...usage } } };
}
