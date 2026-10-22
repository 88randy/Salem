import type { TaskSpec, CheckEvidence, StageResult, RepositorySnapshot, GateReceipt } from "./contracts.js";
import type { AcceptanceContext } from "./acceptance.js";
export interface DeliveryConfig {
  branchPrefix: string; recovery: "query_only";
  commit: { message: string; author: { name: string; email: string } };
  github?: { command: string[]; toolFiles?: string[]; remote: string; remoteUrl: string; repository: string; baseBranch: string; draft: boolean;
    merge?: { method: "merge" | "squash"; requiredChecks: string[] } };
  deploy?: { command: string[]; statusCommand: string[]; toolFiles?: string[]; target: string; requiredChecks: string[] };
}
export type DeliveryAction = "commit" | "push" | "pull_request" | "merge" | "deploy";
export interface ActionReceipt {
  action: DeliveryAction; idempotencyKey: string; sha: string; target: string;
  status: "intent" | "succeeded" | "failed" | "unknown";
  evidence: Record<string, unknown>; reason: string | null;
}
export interface DeliveryJournal {
  schemaVersion: 1; key: string; fingerprint: string; configHash: string; toolsHash: string; reviewed: RepositorySnapshot;
  createdAt: number; branch: string; tree: string | null; commitSha: string | null; releaseSha: string | null; actions: ActionReceipt[];
}
export interface DeliveryReceipt extends GateReceipt {
  sha: string | null; target: string; idempotencyKey: string; actions: ActionReceipt[]; journal: DeliveryJournal;
}
export interface DeliveryInput {
  runId: string; task: TaskSpec; context: AcceptanceContext; evidence: CheckEvidence[]; review: StageResult;
  artifactDir: string; signal?: AbortSignal; journal?: DeliveryJournal;
  leaseDir?: string; lockHeld?: boolean; expectedToolsHash?: string;
  onCheckpoint?: (journal: DeliveryJournal) => Promise<void>;
}
