import type { ProjectConfig, RepositorySnapshot, TaskSpec, CheckEvidence, StageResult, AcceptanceResult } from "./contracts.js";
import { digest } from "./state-store.js";
import { verifyCheck, checkToolHash } from "./checks.js";
export interface AcceptanceContext { config: ProjectConfig; snapshot: RepositorySnapshot; fingerprint: string; evidenceRoot: string; implementationSessionId: string | null; toolHashes?: Record<string, string> }
export async function evaluateChecks(task: TaskSpec, evidence: CheckEvidence[], context: AcceptanceContext): Promise<AcceptanceResult & { retryable: boolean }> {
  const reasons: string[] = [], passed = new Set<string>(), codeFailures = new Set<string>(), checkIds: string[] = [];
  let retryable = true;
  const block = (reason: string, correctable = false) => { reasons.push(reason); retryable &&= correctable; };
  if (!task.acceptance.length) block("Task has no acceptance criteria");
  if (!context.config.checks.length) block("Validation has no checks configured");
  for (const check of context.config.checks) {
    const e = [...evidence].reverse().find(e => e.checkId === check.id && e.fingerprint === context.fingerprint);
    if (!e) { if (check.required) block(`Required check omitted: ${check.id}`); continue; }
    const toolHash = e.execution === "actual" ? await checkToolHash(check.command, context.config.repoRoot, check.toolFiles).catch(() => "unavailable") : e.toolHash;
    const pinned = !context.toolHashes || Boolean(check.notApplicableReason) || check.mode === "dry_run" || e.toolHash === context.toolHashes[check.id];
    const valid = pinned && e.schemaVersion === 1 && e.repoSha === context.snapshot.head && e.treeHash === context.snapshot.treeHash && e.configHash === digest(context.config) && e.toolHash === toolHash
      && e.commandHash === digest(check) && await verifyCheck(e, context.evidenceRoot);
    if (!valid) { block(`Invalid check proof/version: ${check.id}`); continue; }
    checkIds.push(e.id);
    if (e.status === "passed" && e.execution === "actual" && e.exitCode === 0 && !check.notApplicableReason && check.mode !== "dry_run") passed.add(check.id);
    else if (e.status === "not_applicable" && !e.reason?.trim()) block(`Not-applicable needs a reason: ${check.id}`);
    if (e.status === "failed" && e.execution === "actual" && e.exitCode !== null && e.exitCode !== 0 && e.failureKind === "code") codeFailures.add(check.id);
    if (check.required && !passed.has(check.id)) block(`Required check did not pass: ${check.id}`, codeFailures.has(check.id));
  }
  for (const criterion of task.acceptance) {
    const ids = task.acceptanceChecks?.[criterion];
    if (!ids?.length || ids.some(id => !context.config.checks.some(c => c.id === id))) block(`Missing check mapping for criterion: ${criterion}`);
    else if (!ids.every(id => passed.has(id))) block(`Criterion lacks passing evidence: ${criterion}`, ids.every(id => passed.has(id) || codeFailures.has(id)));
  }
  return { accepted: reasons.length === 0, reasons, fingerprint: context.fingerprint, checkIds, retryable: reasons.length > 0 && retryable };
}
export async function evaluateAcceptance(task: TaskSpec, evidence: CheckEvidence[], review: StageResult, context: AcceptanceContext): Promise<AcceptanceResult> {
  const result = await evaluateChecks(task, evidence, context);
  if (review.stage !== "review" || review.taskId !== task.id || review.status !== "succeeded" || review.exitCode !== 0 || review.payload?.stage !== "review" || review.payload.taskId !== task.id || review.payload.verdict !== "success") result.reasons.push("Independent review has unresolved findings or failed");
  if (!review.sessionId || !context.implementationSessionId || review.sessionId === context.implementationSessionId) result.reasons.push("Review must use a separate session from implementation");
  if (!Array.isArray(review.payload?.findings) || review.payload.findings.some(f => !f || f.severity !== "minor" || typeof f.description !== "string" || !f.description.trim())) result.reasons.push("Review has blocking or missing structured findings");
  if (review.repoSha !== context.snapshot.head || review.verificationFingerprint !== context.fingerprint) result.reasons.push("Review is for another repository version/fingerprint");
  result.accepted = result.reasons.length === 0;
  return result;
}
