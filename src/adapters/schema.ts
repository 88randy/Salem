import type { StageInput, StagePayload } from "../contracts.js";
export const stageSchema = {
  type: "object", additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [1] }, stage: { type: "string", enum: ["define", "build", "review"] },
    taskId: { type: "string" }, verdict: { type: "string", enum: ["success", "needs_changes", "blocked"] },
    summary: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "object", additionalProperties: false, properties: { severity: { type: "string", enum: ["critical", "important", "minor"] }, description: { type: "string" } }, required: ["severity", "description"] } }
  }, required: ["schemaVersion", "stage", "taskId", "verdict", "summary", "evidenceRefs", "findings"]
};
export function parsePayload(value: unknown, input: StageInput): StagePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing structured stage result");
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.findings) || !v.findings.every(f => f && typeof f === "object" && Object.keys(f).every(k => ["severity", "description"].includes(k)) && ["critical", "important", "minor"].includes(f.severity) && typeof f.description === "string" && f.description.trim())) throw new Error("Invalid structured findings");
  if (Object.keys(v).some(k => !stageSchema.required.includes(k)) || v.schemaVersion !== 1 || v.stage !== input.stage || v.taskId !== input.task.id || !["success", "needs_changes", "blocked"].includes(String(v.verdict)) || typeof v.summary !== "string" || !v.summary.trim() || !Array.isArray(v.evidenceRefs) || !v.evidenceRefs.every(x => typeof x === "string")) throw new Error("Invalid stage result or task identity mismatch");
  return v as unknown as StagePayload;
}
