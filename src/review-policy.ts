import type { DependencyReceipt, ProjectConfig, RiskAssessment, RubricItem, RunState, StagePayload, StageResult, TaskSpec } from "./contracts.js";
import { inspectAgent } from "./doctor.js";

// Priority order: a failure in the first four blocks acceptance; the last two only report.
export const rubricItems: RubricItem[] = ["solves", "correct", "secure", "tested", "understandable", "style"];
export const blockingRubricItems: RubricItem[] = ["solves", "correct", "secure", "tested"];
export const incompleteRubric = "Review rubric incomplete";
const reasons = { auth: "el inicio de sesión o los permisos", data: "la forma en que se guardan los datos", destructive: "el borrado de datos guardados", architecture: "la estructura general del proyecto" };
const specRules: [RegExp, string][] = [
  [/\b(auth\w*|log ?in|sign[ -]?in|password\w*|credential\w*|oauth|sso|jwt|permission\w*|authori[sz]\w*|rbac|acl|autentica\w*|autoriza\w*|contraseñ\w*|permisos?|inicio de sesión|credencial\w*)\b/iu, reasons.auth],
  [/\b(data ?model|database schema|schema migration|migrations?|modelo de datos|esquema de (la )?base de datos|migraci[oó]n\w*)\b/iu, reasons.data],
  [/\b(architecture|architectural|arquitectura)\b/iu, reasons.architecture]
];
const authPath = /(^|[\/_.-])(auth\w*|login|signin|sign-in|password\w*|permission\w*|oauth|jwt|acl|rbac|sessions?)([\/_.-]|$)/i;
const authCode = /\b(permission_classes|login_required|IsAuthenticated|authenticate\(|jwt\.|bcrypt|passport\.)/;
const dataPath = /(^|\/)(migrations?|alembic)\/|\.sql$|(^|\/)(schema\.prisma|models\.py)$/i;
const destructive = /\b(DROP\s+(TABLE|COLUMN|SCHEMA|DATABASE)|TRUNCATE\b|DELETE\s+FROM|RemoveField|DeleteModel|dropTable|dropColumn|drop_table|drop_column|remove_column)/i;

/** Splits a review diff into each file's added and removed lines (all lines of untracked files are added). */
export function changedLines(diff: string): { path: string; lines: string[]; removed: string[] }[] {
  const files: { path: string; lines: string[]; removed: string[] }[] = []; let current: { path: string; lines: string[]; removed: string[] } | null = null, untracked = false;
  for (const line of diff.split(/\r?\n/)) {
    const tracked = /^diff --git a\/.+ b\/(.+)$/.exec(line), extra = /^UNTRACKED (".*")$/.exec(line);
    if (tracked || extra) { current = { path: tracked ? tracked[1]! : JSON.parse(extra![1]!) as string, lines: [], removed: [] }; untracked = !!extra; files.push(current); continue; }
    if (!current) continue;
    if (untracked) current.lines.push(line);
    else if (line.startsWith("+") && !line.startsWith("+++")) current.lines.push(line.slice(1));
    else if (line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
  }
  return files;
}
export interface Dependency { name: string; ecosystem: DependencyReceipt["ecosystem"] }
/** Packages a change adds to dependency files; the supervisor checks each one in its public registry. */
export function addedDependencies(diff: string): Dependency[] {
  const found = new Map<string, Dependency>(), add = (name: string, ecosystem: Dependency["ecosystem"]) => found.set(`${ecosystem}:${name}`, { name, ecosystem });
  for (const file of changedLines(diff)) {
    const base = file.path.split("/").at(-1)!;
    if (base === "package.json") {
      try { const json = JSON.parse(file.lines.join("\n")) as Record<string, unknown>; for (const k of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) if (json[k] && typeof json[k] === "object") Object.keys(json[k]).forEach(n => add(n, "npm")); continue; } catch { /* a hunk, not a whole file */ }
      for (const l of file.lines) { const m = /^\s*"(@?[\w.\/-]+)"\s*:\s*"(?:[\^~<>=]*\s*\d|\*|latest|npm:|workspace:)/.exec(l); if (m) add(m[1]!, "npm"); }
    } else if (/^requirements.*\.txt$/i.test(base)) {
      for (const l of file.lines) { const m = /^\s*([A-Za-z0-9][\w.-]*)(\[[^\]]*\])?\s*(==|>=|<=|~=|!=|>|<|$)/.exec(l); if (m) add(m[1]!, "pypi"); }
    }
  }
  return [...found.keys()].sort().map(k => found.get(k)!);
}
/** Public registries queried read-only and without credentials; tests point these at a local fake. */
export const dependencyRegistries = { npm: "https://registry.npmjs.org/", pypi: "https://pypi.org/pypi/" };
const validName = { npm: /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i, pypi: /^[A-Za-z0-9][\w.-]*$/ };
/** Receipts the reviewer can rely on: found / not_found from the registry, unknown on any other answer or network error. */
export async function verifyDependencies(deps: Dependency[], signal?: AbortSignal, timeoutMs = 5000): Promise<DependencyReceipt[]> {
  return Promise.all(deps.map(async (d, i): Promise<DependencyReceipt> => {
    const registry = !validName[d.ecosystem].test(d.name) || i >= 50 ? "" : d.ecosystem === "npm" ? dependencyRegistries.npm + d.name.replace("/", "%2f") : `${dependencyRegistries.pypi}${encodeURIComponent(d.name)}/json`;
    if (!registry) return { ...d, status: "unknown", registry };
    try {
      const res = await fetch(registry, { headers: { accept: "application/json" }, signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]) });
      await res.body?.cancel();
      return { ...d, status: res.status === 200 ? "found" : res.status === 404 ? "not_found" : "unknown", registry };
    } catch { return { ...d, status: "unknown", registry }; }
  }));
}
/** Deterministic risk floor from the spec and, at review time, the diff. Agents may raise it, never lower it. */
export function classifyRisk(task: TaskSpec, diff = "", claimed: (RiskAssessment | null | undefined)[] = []): RiskAssessment & { explanation: string } {
  const found = new Set<string>(), text = [task.objective, ...task.scope, ...task.acceptance].join("\n");
  for (const [rule, reason] of specRules) if (rule.test(text)) found.add(reason);
  for (const file of changedLines(diff)) {
    // Deleting an access check is as risky as adding one.
    if (authPath.test(file.path) || [...file.lines, ...file.removed].some(l => authCode.test(l))) found.add(reasons.auth);
    if (dataPath.test(file.path)) { found.add(reasons.data); if (file.lines.some(l => destructive.test(l))) found.add(reasons.destructive); }
  }
  const known = [...found], other = claimed.flatMap(r => r?.level === "high" ? r.reasons : []);
  const level = known.length || claimed.some(r => r?.level === "high") ? "high" : "normal";
  const list = known.length > 1 ? `${known.slice(0, -1).join(", ")} y ${known.at(-1)}` : known[0] ?? "partes delicadas del proyecto";
  return { level, reasons: [...new Set([...known, ...other])], explanation: level === "high" ? `Este cambio toca ${list}, por eso lo revisa una IA distinta de la que lo hizo antes de aceptarlo.` : "" };
}
export function runRisk(state: RunState, diff = ""): RiskAssessment & { explanation: string } {
  return classifyRisk(state.task, diff, [state.risk, ...state.attempts.map(a => a.result?.payload?.risk)]);
}
export function singleProviderQuestion(risk: RiskAssessment & { explanation: string }): string {
  return `${risk.explanation.replace(/, por eso.*$/, "")}, así que conviene que lo revise una IA distinta de la que lo hizo, pero solo hay una disponible. ¿Puedes conectar la otra (Claude o Codex) en Cuentas para continuar?`;
}
/** Failing items that block acceptance; legacy results without a rubric report none here. */
export function rubricBlocks(payload: StagePayload | null | undefined): RubricItem[] {
  return payload?.rubric ? blockingRubricItems.filter(k => payload.rubric![k]?.pass !== true) : [];
}
export const invalidRubric = (result: StageResult) => result.stage === "review" && !!result.error?.startsWith(incompleteRubric);
export function buildProvider(state: RunState, config: ProjectConfig): string | undefined {
  return [...state.attempts].reverse().find(a => a.stage === "build" && a.valid && a.result)?.result?.provider ?? config.agents[config.supervisor!.roles.build]?.provider;
}
/** High-risk changes are reviewed by another provider; null means none is configured and ready. */
export async function crossProviderReviewer(config: ProjectConfig, builder: string | undefined, signal: AbortSignal, leaseDir: string): Promise<string | null> {
  const preferred = config.supervisor!.roles.review;
  for (const id of [preferred, ...Object.keys(config.agents).sort().filter(id => id !== preferred)]) {
    const agent = config.agents[id];
    if (!agent || agent.provider === builder) continue;
    if (id === preferred) return id; // already preflighted with the run's roles
    const health = await inspectAgent(agent, config.repoRoot, { signal, leaseDir, timeoutMs: config.budgets.stageTimeoutMs });
    if (health.compatible && health.authenticated === true) return id;
  }
  return null;
}
