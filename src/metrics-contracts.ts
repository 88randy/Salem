import type { RunStatus, Stage } from "./contracts.js";
export interface AgentProvenance {
  provider: "claude" | "codex"; command: string[]; version: string | null;
  executableHash: string; agentConfigHash: string;
}
export interface BenchmarkContext {
  suiteId: string; protocolHash: string; caseId: string; kind: "bug" | "feature" | "refactor";
  mode: "direct" | "framework"; provider: "claude" | "codex";
  baseSha: string; acceptanceHash: string; agentConfigHash: string; limitsHash: string;
  environment: string; setupMs: number; executionWallMs?: number;
}
export interface RunTelemetry {
  schemaVersion: 1;
  controller?: "supervisor" | "direct";
  invocations: { id: string; startedAt: number; finishedAt: number | null }[];
  interventions: { id: string; at: number; actor: "operator" | "automation"; needed: boolean | null; reason: string }[];
  agents: Record<string, AgentProvenance>;
  benchmark?: BenchmarkContext;
}
export interface MetricTotal { value: number | null; knownTotal: number | null; reported: number; expected: number }
export interface UsageSummary {
  inputTokens: MetricTotal; outputTokens: MetricTotal; cachedInputTokens: MetricTotal;
  cacheCreationInputTokens: MetricTotal; totalTokens: MetricTotal; costUsd: MetricTotal;
  costKind: "reported" | "estimated" | "mixed" | "unavailable";
  models: string[]; sources: string[]; observations: number;
}
export interface RunMetrics {
  schemaVersion: 1; id: string; projectId: string; taskId: string; status: RunStatus;
  accepted: boolean; codeAccepted: boolean; delivered: boolean;
  timing: { wallMs: number; wallComplete: boolean; activeMs: number | null; confirmedActiveMs: number; agentMs: number;
    checksMs: number; setupMs: number | null; totalMs: number | null };
  iterations: Record<Stage, number>;
  quality: { failedChecks: number; regressions: number; blockingFindings: number };
  failures: { infrastructure: number; task: number; protocol: number; policy: number; unknown: number; cancellations: number };
  usage: UsageSummary;
  interventions: { observed: number | null; necessary: number | null };
  provenance: { repositoryRoot: string; baseSha: string; finalSha: string | null; configHash: string; instructionsHash: string; toolsHash: string;
    agents: Record<string, AgentProvenance>; benchmark: BenchmarkContext | null };
  limitations: string[];
}
export interface CohortMetrics {
  total: number; accepted: number; failed: number; blocked: number; cancelled: number; unmeasured: number; successRate: number | null;
  wallMs: number; totalMs: number | null; activeMs: number | null; usage: UsageSummary;
}
export interface ComparisonReport {
  schemaVersion: 1; baseline: CohortMetrics; candidate: CohortMetrics;
  comparability: "verified" | "partial" | "incompatible"; issues: string[];
  paired: { taskId: string; baseline: string; candidate: string; totalDeltaMs: number | null }[];
  limitations: string[];
}
