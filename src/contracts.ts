export type Stage = "define" | "build" | "review";
export type Capability = "edit" | "commit" | "pull_request" | "merge" | "deploy";
export interface AgentConfig { provider: "codex" | "claude"; command: string[]; ignoreUserConfig?: boolean; model?: string; effort?: string }
export interface CheckConfig { id: string; command: string[]; required: boolean; mode?: "execute" | "dry_run"; notApplicableReason?: string; toolFiles?: string[] }
export interface ProjectConfig {
  schemaVersion: 1;
  projectId: string;
  repoRoot: string;
  contextFiles: string[];
  instructions?: string;
  agents: Record<string, AgentConfig>;
  checks: CheckConfig[];
  capabilities: Record<Capability, boolean>;
  budgets: { stageTimeoutMs: number; maxOutputBytes: number };
  supervisor?: { roles: Record<Stage, string>; runTimeoutMs: number; maxAttempts: number; maxReportedTokens?: number };
  delivery?: import("./delivery-contracts.js").DeliveryConfig;
}
export interface TaskSpec { id: string; objective: string; scope: string[]; acceptance: string[]; references: string[]; acceptanceChecks?: Record<string, string[]> }
export interface CheckEvidence {
  schemaVersion: 1; id: string; checkId: string; command: string[]; commandHash: string;
  toolHash: string;
  configHash: string; fingerprint: string; repoSha: string; treeHash: string;
  status: "passed" | "failed" | "not_applicable"; execution: "actual" | "dry_run" | "not_run";
  exitCode: number | null; reason: string | null; durationMs: number; artifactDir: string;
  failureKind?: "code" | "infrastructure" | "policy" | null;
  stdoutHash: string; stderrHash: string; proofHash: string;
}
export interface AcceptanceResult { accepted: boolean; reasons: string[]; fingerprint: string; checkIds: string[] }
export interface VerificationContext {
  fingerprint: string; repoSha: string; treeHash: string; diff: string;
  checks: Pick<CheckEvidence, "id" | "checkId" | "status" | "exitCode" | "artifactDir" | "reason">[];
  logs: { checkId: string; stdout: string; stderr: string }[];
}
export interface StagePayload {
  schemaVersion: 1; stage: Stage; taskId: string;
  verdict: "success" | "needs_changes" | "blocked";
  summary: string; evidenceRefs: string[];
  findings?: { severity: "critical" | "important" | "minor"; description: string }[];
  /** Required from new reviews; absent in results recorded before the rubric existed. */
  rubric?: Record<RubricItem, { pass: boolean; notes: string }> | null;
  risk?: RiskAssessment | null;
}
export type RubricItem = "solves" | "correct" | "secure" | "tested" | "understandable" | "style";
export interface RiskAssessment { level: "normal" | "high"; reasons: string[] }
export interface DependencyReceipt { name: string; ecosystem: "npm" | "pypi"; status: "found" | "not_found" | "unknown"; registry: string }
export interface Usage {
  inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null;
  costUsd: number | null; costKind: "reported" | "estimated" | "unavailable";
  model: string | null;
  accounting?: { tokenScope: "invocation" | "session_cumulative"; costScope: "invocation" | "session_cumulative";
    inputIncludesCache: boolean; cacheCreationInputTokens: number | null; source: string; complete: boolean };
}
export interface StageInput {
  config: ProjectConfig; agentId: string; stage: Stage; task: TaskSpec; artifactDir: string;
  leaseDir?: string;
  disableHooks?: boolean;
  priorStages?: Pick<StageResult, "stage" | "payload" | "artifactDir">[];
  verification?: VerificationContext;
  risk?: RiskAssessment;
  predecessorEvidence?: AcceptedPredecessorEvidence[];
}
export interface AcceptedPredecessorEvidence {
  executionId:string; previousExecutionId:string|null; runId:string; taskId:string; profileRevision:number; verifiedAt:number;
  fingerprint:string; repoSha:string; treeHash:string;
  acceptance:AcceptanceResult;
  implementation:{provider:string;sessionId:string};
  review:{provider:string;sessionId:string;verdict:'success'};
  checks:{id:string;checkId:string;status:CheckEvidence['status'];required:boolean;relevantToAcceptance:boolean;proofHash:string}[];
  integrity:{configHash:string;instructionsHash:string;runtimeToolsHash:string;checkToolHashes:Record<string,string>;projectPolicyHash:string};
}
export type RunStatus = "queued" | "defining" | "implementing" | "validating" | "reviewing" | "delivering" | "completed" | "failed" | "blocked" | "cancelled";
export type RunPhase = "defining" | "implementing" | "validating" | "reviewing" | "delivering";
export interface RepositorySnapshot { root: string; gitDir: string; head: string; treeHash: string; dirty: boolean }
export interface RunAttempt {
  id: string; stage: Stage; agentId: string; startedAt: number; finishedAt: number | null;
  before: RepositorySnapshot; after: RepositorySnapshot | null;
  artifactDir: string; result: StageResult | null; valid: boolean;
}
export interface GateReceipt { id: string; fingerprint: string; verdict: "success" | "needs_changes" | "blocked"; evidenceRefs: string[]; summary: string }
export interface RunState {
  schemaVersion: 1; id: string; revision: number; projectId: string; task: TaskSpec;
  status: RunStatus; nextPhase: RunPhase; reason: string | null;
  createdAt: number; updatedAt: number; deadlineAt: number;
  configHash: string; instructionsHash: string; toolsHash: string;
  expected: RepositorySnapshot;
  attempts: RunAttempt[];
  validation: GateReceipt | null; delivery: GateReceipt | null;
  deliveryIntent: { id: string; fingerprint: string } | null;
  checks?: CheckEvidence[];
  checkToolHashes?: Record<string, string>;
  acceptance?: AcceptanceResult | null;
  deliveryJournal?: import("./delivery-contracts.js").DeliveryJournal;
  deliveryToolsHash?: string;
  telemetry?: import("./metrics-contracts.js").RunTelemetry;
  risk?: RiskAssessment & { explanation: string } | null;
  history: { at: number; status: RunStatus; reason: string | null }[];
}
export interface StageResult {
  schemaVersion: 1; provider: "codex" | "claude"; stage: Stage; taskId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  payload: StagePayload | null; error: string | null; sessionId: string | null;
  exitCode: number | null; usage: Usage; durationMs: number; artifactDir: string;
  repoSha: string | null;
  verificationFingerprint?: string;
  /** Registry receipts for packages the reviewed change adds. */
  dependencies?: DependencyReceipt[];
  failureKind?: "infrastructure" | "protocol" | "policy" | "unknown" | null;
}
