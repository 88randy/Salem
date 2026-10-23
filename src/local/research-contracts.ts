import type { Usage } from "../contracts.js";
import type { ProjectInput, ProjectRecord, Provider } from "./contracts.js";

export interface DiscoveryReport {
  repoRoot: string; sourceSha: string; stack: string[]; contextFiles: string[];
  files: string[]; truncated: boolean; warnings: string[]; suggested: ProjectInput;
}
export interface GoalPlan {
  work?: import('./conversation-contracts.js').WorkGraph;
  schemaVersion: 1; verdict: "ready" | "needs_input" | "blocked" | "answered"; summary: string;
  facts: { description: string; files: string[] }[];
  assumptions: string[]; decisions: string[]; questions: string[];
  steps: { title: string; description: string; files: string[] }[];
  task: { objective: string; scope: string[]; acceptance: string[]; references: string[]; checkIds: string[] };
  proposedChecks: { id: string; command: string[]; toolFiles: string[] }[];
}
export interface GoalAttempt {
  id: string; startedAt: number; finishedAt: number | null;
  status: "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "interrupted";
  error: string | null; usage: Usage | null; sessionId: string | null; durationMs: number | null;
}
export type GoalStatus = "queued" | "investigating" | "ready" | "needs_input" | "blocked" | "failed" | "cancelled" | "interrupted" | "materialized" | "answered";
export interface GoalRecord {
  conversational?: boolean;
  baseExecutionId?:string;
  id: string; revision: number; projectId: string; requestKey: string; objective: string; agentId: string;
  project: ProjectRecord; sourceSha: string | null; status: GoalStatus;
  createdAt: number; updatedAt: number; finishedAt: number | null; reason: string | null;
  answers: { at: number; text: string; questions?: string[] }[]; attempts: GoalAttempt[]; plan: GoalPlan | null; createdTaskId: string | null;
}
export interface GoalRequest { projectId: string; objective: string; agentId?: string; requestKey: string; conversational?:boolean; baseExecutionId?:string }
export interface ResearchSnapshot { root: string; sourceSha: string; files: string[]; truncated: boolean; evidenceFiles?: string[] }
export interface PlanningResult {
  goalId: string; attemptId: string; sourceSha: string; configHash: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  plan: GoalPlan | null; error: string | null; usage: Usage | null; sessionId: string | null; durationMs: number;
}
export interface ResearchProvider { provider: Provider }
