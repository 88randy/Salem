import type { AgentConfig, ProjectConfig, RunState, TaskSpec } from "../contracts.js";
import type { RunMetrics } from "../metrics-contracts.js";
import { recommendedModel } from "../model-presets.js";

export type Provider = "claude" | "codex";
export interface LocalSettings {
  revision: number;
  commands: Record<Provider, string[]>;
  maxConcurrentRuns: number;
  refreshIntervalMs: number;
  preferredPort: number;
  nextDataDir?: string;
}
export interface ProjectRecord {
  id: string; revision: number; name: string; archived: boolean;
  createdAt: number; updatedAt: number;
  config: ProjectConfig;
  baseRef: string;
  preparation: string[][];
}
export interface TaskRecord {
  conversation?:{id:string;planRevision:number;stepId:string};
  id: string; revision: number; projectId: string; archived: boolean;
  createdAt: number; updatedAt: number; spec: TaskSpec;
  origin?: { goalId: string; sourceSha: string; projectRevision: number };
}
export type ExecutionStatus = "queued" | "preparing" | "running" | "interrupted" | "completed" | "failed" | "blocked" | "cancelled";
export interface ExecutionRecord {
  conversationId?:string; continuationId?:string;
  id: string; revision: number; taskId: string; projectId: string;
  requestKey: string; createdAt: number; updatedAt: number; finishedAt: number | null;
  status: ExecutionStatus; reason: string | null;
  project: ProjectRecord; task: TaskSpec;
  workspace: string | null; sourceSha: string | null; runId: string | null;
  stateDir: string; setupMs: number | null; preparationLogs: string[];
  baseExecutionId?: string;
  /**
   * Local branch created in the user's repository from the accepted result (absent in older records).
   * pending marks the intent written before update-ref; it is settled on retry or startup.
   */
  branch?: { ref: string; commit: string; createdAt: number; pending?: true } | undefined;
}
export interface LocalState {
  schemaVersion: 1 | 2; revision: number;
  settings: LocalSettings; projects: ProjectRecord[]; tasks: TaskRecord[];
  executions: ExecutionRecord[];
  goals?: import("./research-contracts.js").GoalRecord[];
  evolutions?: import("./evolution-contracts.js").EvolutionRecord[];
  conversations?: import('./conversation-contracts.js').ConversationRecord[];
}
export interface ProjectInput {
  id?: string; revision?: number; name: string; archived?: boolean;
  config: ProjectConfig; baseRef: string; preparation: string[][];
}
export interface TaskInput {
  id?: string; revision?: number; projectId: string; archived?: boolean; spec: TaskSpec;
  origin?: TaskRecord["origin"];
}
export interface AccountView {
  provider: Provider; installed: boolean; compatible: boolean; authenticated: boolean | null;
  version: string | null; error: string | null;
  connection: "idle" | "connecting" | "connected" | "failed" | "cancelled";
  loginUrl: string | null; userCode: string | null; needsInput: boolean;
}
export interface ExecutionDetail {
  execution: ExecutionRecord; run: RunState | null; metrics: RunMetrics | null;
  diff: string; artifacts: { path: string; bytes: number }[];
}
export interface Bootstrap {
  csrfToken: string; state: LocalState; accounts: AccountView[]; dataDir: string;
}
export interface ApiError { error: string; code?: string }
export const defaultSettings = (): LocalSettings => ({
  revision: 1, commands: { claude: ["claude"], codex: ["codex", "-c", "approval_policy=\"on-request\"", "-c", "approvals_reviewer=\"auto_review\""] },
  maxConcurrentRuns: 1, refreshIntervalMs: 1500, preferredPort: 3210,
});
export const defaultAgent = (provider: Provider, settings: LocalSettings): AgentConfig => ({
  provider, command: [...settings.commands[provider]], ...recommendedModel(provider), ...(provider === "codex" ? { ignoreUserConfig: true } : {}),
});
