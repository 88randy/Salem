import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AgentConfig, Capability, CheckConfig, ProjectConfig, TaskSpec } from "./contracts.js";
import { parseDelivery } from "./delivery-config.js";

function object(value: unknown, label: string, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${label}`);
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some(k => !keys.includes(k))) throw new Error(`Unknown field in ${label}`);
  return result;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) throw new Error(`Invalid ${label}`);
  return value;
}
function command(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Invalid ${label} command array`);
  return value.map(v => text(v, `${label} command`));
}
function positive(value: unknown, label: string, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
export async function loadTask(file: string): Promise<TaskSpec> {
  return parseTask(JSON.parse(await readFile(file, "utf8")));
}
export function parseTask(value: unknown): TaskSpec {
  const raw = object(value, "task", ["id", "objective", "scope", "acceptance", "references", "acceptanceChecks"]);
  const strings = (key: string, required: boolean): string[] => {
    const v = raw[key];
    if (!Array.isArray(v) || (required && !v.length)) throw new Error(`Invalid task.${key}`);
    return v.map(x => text(x, `task.${key}`));
  };
  const acceptance = strings("acceptance", true);
  let acceptanceChecks: Record<string, string[]> | undefined;
  if ("acceptanceChecks" in raw) {
    acceptanceChecks = Object.create(null) as Record<string, string[]>;
    for (const [criterion, checks] of Object.entries(object(raw.acceptanceChecks, "acceptanceChecks"))) {
      if (!acceptance.includes(criterion) || !Array.isArray(checks) || !checks.length) throw new Error("Invalid acceptance criterion/check mapping");
      acceptanceChecks[criterion] = checks.map(id => text(id, "acceptance check id"));
    }
  }
  return { id: text(raw.id, "task.id"), objective: text(raw.objective, "task.objective"), scope: strings("scope", true), acceptance, references: strings("references", false), ...(acceptanceChecks ? { acceptanceChecks } : {}) };
}
export function isInside(root: string, file: string): boolean {
  const r = relative(root, file);
  return r !== ".." && !r.startsWith(`..\\`) && !r.startsWith("../") && !isAbsolute(r);
}
export async function loadProjectConfig(file: string): Promise<ProjectConfig> {
  return parseProjectConfig(JSON.parse(await readFile(file, "utf8")), dirname(resolve(file)));
}
export async function parseProjectConfig(value: unknown, baseDir = process.cwd()): Promise<ProjectConfig> {
  const raw = object(value, "config", ["schemaVersion", "projectId", "repoRoot", "contextFiles", "instructions", "agents", "checks", "capabilities", "budgets", "supervisor", "delivery"]);
  if (raw.schemaVersion !== 1) throw new Error("Invalid schemaVersion");
  const projectId = text(raw.projectId, "projectId");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(projectId)) throw new Error("Invalid projectId");
  const root = text(raw.repoRoot, "repoRoot");
  if (root === "repo_root" || /\$\{|%[^%]+%/.test(root)) throw new Error("Unresolved repoRoot");
  let repoRoot: string;
  try {
    repoRoot = await realpath(resolve(baseDir, root));
    if (!(await stat(repoRoot)).isDirectory()) throw new Error();
  } catch { throw new Error("repoRoot must be an existing directory"); }
  if (!Array.isArray(raw.contextFiles) || raw.contextFiles.length === 0) throw new Error("Invalid contextFiles");
  const contextFiles: string[] = [];
  for (const v of raw.contextFiles) {
    const context = text(v, "contextFiles");
    if (isAbsolute(context) || !isInside(repoRoot, resolve(repoRoot, context))) throw new Error("contextFiles must stay inside repoRoot");
    try {
      const actual = await realpath(resolve(repoRoot, context));
      if (!isInside(repoRoot, actual) || !(await stat(actual)).isFile()) throw new Error();
    } catch { throw new Error("contextFiles must be existing files inside repoRoot"); }
    contextFiles.push(context);
  }
  const agents: Record<string, AgentConfig> = Object.create(null) as Record<string, AgentConfig>;
  for (const [id, v] of Object.entries(object(raw.agents, "agents"))) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || ["__proto__", "constructor", "prototype"].includes(id)) throw new Error("Invalid agent id");
    const a = object(v, `agent ${id}`, ["provider", "command", "ignoreUserConfig", "model", "effort"]);
    if (a.provider !== "codex" && a.provider !== "claude") throw new Error("Invalid agent provider");
    if ("ignoreUserConfig" in a && (typeof a.ignoreUserConfig !== "boolean" || a.provider !== "codex")) throw new Error("ignoreUserConfig must be a boolean on a Codex agent");
    const overrides: { model?: string; effort?: string } = {};
    if ("model" in a) { const model = text(a.model, "agent model"); if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model)) throw new Error("Invalid agent model"); overrides.model = model; }
    if ("effort" in a) { const effort = text(a.effort, "agent effort"); if (!/^[a-z][a-z0-9_-]{0,31}$/.test(effort)) throw new Error("Invalid agent effort"); overrides.effort = effort; }
    agents[id] = { provider: a.provider, command: command(a.command, `agent ${id}`), ...(typeof a.ignoreUserConfig === "boolean" ? { ignoreUserConfig: a.ignoreUserConfig } : {}), ...overrides };
  }
  if (!Object.keys(agents).length) throw new Error("At least one agent required");
  if (!Array.isArray(raw.checks)) throw new Error("Invalid checks");
  const ids = new Set<string>();
  const checks: CheckConfig[] = raw.checks.map(v => {
    const c = object(v, "check", ["id", "command", "required", "final", "mode", "notApplicableReason", "toolFiles"]);
    const id = text(c.id, "check id");
    if (ids.has(id) || typeof c.required !== "boolean") throw new Error("Invalid check id/required");
    if ("final" in c && typeof c.final !== "boolean") throw new Error("Invalid check final");
    ids.add(id);
    if ("mode" in c && c.mode !== "execute" && c.mode !== "dry_run") throw new Error("Invalid check mode");
    if ("toolFiles" in c && (!Array.isArray(c.toolFiles) || !c.toolFiles.length)) throw new Error("Invalid check toolFiles");
    return { id, command: command(c.command, "check"), required: c.required, ...(c.final === true ? { final: true } : {}), ...(c.mode ?{ mode: c.mode as "execute" | "dry_run" } : {}),
      ...(Array.isArray(c.toolFiles) ? { toolFiles: c.toolFiles.map(v => text(v, "check toolFiles")) } : {}),
      ...("notApplicableReason" in c ? { notApplicableReason: text(c.notApplicableReason, "notApplicableReason") } : {}) };
  });
  const keys: Capability[] = ["edit", "commit", "pull_request", "merge", "deploy"];
  const cap = object(raw.capabilities, "capabilities", keys);
  const capabilities = {} as Record<Capability, boolean>;
  for (const key of keys) {
    if (typeof cap[key] !== "boolean") throw new Error(`Invalid capabilities.${key}`);
    capabilities[key] = cap[key];
  }
  const b = object(raw.budgets, "budgets", ["stageTimeoutMs", "maxOutputBytes"]);
  let supervisor: ProjectConfig["supervisor"];
  if ("supervisor" in raw) {
    const s = object(raw.supervisor, "supervisor", ["roles", "runTimeoutMs", "maxAttempts", "maxReportedTokens"]);
    const roles = object(s.roles, "supervisor.roles", ["define", "build", "review"]);
    const checked = {} as Record<"define" | "build" | "review", string>;
    for (const stage of ["define", "build", "review"] as const) {
      checked[stage] = text(roles[stage], `supervisor.roles.${stage}`);
      if (!agents[checked[stage]]) throw new Error("Unknown supervisor role agent");
    }
    supervisor = { roles: checked, runTimeoutMs: positive(s.runTimeoutMs, "runTimeoutMs", 86_400_000), maxAttempts: positive(s.maxAttempts, "maxAttempts", 100),
      ...("maxReportedTokens" in s ? { maxReportedTokens: positive(s.maxReportedTokens, "maxReportedTokens", 1_000_000_000) } : {}) };
  }
  const instructions = "instructions" in raw ? text(raw.instructions, "instructions") : undefined;
  if (instructions && instructions.length > 100000) throw new Error("Instructions size budget exceeded");
  return { schemaVersion: 1, projectId, repoRoot, contextFiles, ...(instructions !== undefined ? { instructions } : {}), agents, checks, capabilities, budgets: {
    stageTimeoutMs: positive(b.stageTimeoutMs, "stageTimeoutMs", 3_600_000),
    maxOutputBytes: positive(b.maxOutputBytes, "maxOutputBytes", 100_000_000)
  }, ...(supervisor ? { supervisor } : {}), ...("delivery" in raw ? {delivery:parseDelivery(raw.delivery)} : {}) };
}
