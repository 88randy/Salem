import type { StageInput, StagePayload } from "../contracts.js";
import { rubricItems, incompleteRubric } from "../review-policy.js";
const answer = { type: "object", additionalProperties: false, properties: { pass: { type: "boolean" }, notes: { type: "string" } }, required: ["pass", "notes"] };
export const stageSchema = {
  type: "object", additionalProperties: false,
  properties: {
    schemaVersion: { type: "integer", enum: [1] }, stage: { type: "string", enum: ["define", "build", "review"] },
    taskId: { type: "string" }, verdict: { type: "string", enum: ["success", "needs_changes", "blocked"] },
    summary: { type: "string" }, evidenceRefs: { type: "array", items: { type: "string" } },
    findings: { type: "array", items: { type: "object", additionalProperties: false, properties: { severity: { type: "string", enum: ["critical", "important", "minor"] }, description: { type: "string" } }, required: ["severity", "description"] } },
    rubric: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, properties: Object.fromEntries(rubricItems.map(k => [k, answer])), required: rubricItems }] },
    risk: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: false, properties: { level: { type: "string", enum: ["normal", "high"] }, reasons: { type: "array", items: { type: "string" } } }, required: ["level", "reasons"] }] }
  }, required: ["schemaVersion", "stage", "taskId", "verdict", "summary", "evidenceRefs", "findings", "rubric", "risk"]
};
export function parsePayload(value: unknown, input: StageInput): StagePayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Missing structured stage result");
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.findings) || !v.findings.every(f => f && typeof f === "object" && Object.keys(f).every(k => ["severity", "description"].includes(k)) && ["critical", "important", "minor"].includes(f.severity) && typeof f.description === "string" && f.description.trim())) throw new Error("Invalid structured findings");
  if (Object.keys(v).some(k => !stageSchema.required.includes(k)) || v.schemaVersion !== 1 || v.stage !== input.stage || v.taskId !== input.task.id || !["success", "needs_changes", "blocked"].includes(String(v.verdict)) || typeof v.summary !== "string" || !v.summary.trim() || !Array.isArray(v.evidenceRefs) || !v.evidenceRefs.every(x => typeof x === "string")) throw new Error("Invalid stage result or task identity mismatch");
  const r = v.risk as Record<string, unknown> | null | undefined;
  if (r != null && (typeof r !== "object" || Array.isArray(r) || Object.keys(r).some(k => k !== "level" && k !== "reasons") || !["normal", "high"].includes(String(r.level)) || !Array.isArray(r.reasons) || !r.reasons.every(x => typeof x === "string" && x.trim()) || (r.level === "high" && !r.reasons.length))) throw new Error("Invalid risk classification");
  // Define and build results carry no rubric; a review answers every item and re-checks risk from the diff.
  if (input.stage === "review" || v.rubric != null) {
    const rubric = v.rubric as Record<string, { pass?: unknown; notes?: unknown }> | null | undefined;
    const missing = rubricItems.filter(k => { const a = rubric?.[k]; return !a || typeof a !== "object" || Object.keys(a).some(x => x !== "pass" && x !== "notes") || typeof a.pass !== "boolean" || typeof a.notes !== "string" || (!a.pass && !a.notes.trim()); });
    if (!rubric || typeof rubric !== "object" || Array.isArray(rubric) || Object.keys(rubric).some(k => !rubricItems.includes(k as never)) || missing.length) throw new Error(`${incompleteRubric}: ${missing.join(", ") || "unexpected items"}`);
    if (input.stage === "review" && r == null) throw new Error(`${incompleteRubric}: risk`);
  }
  return v as unknown as StagePayload;
}
