import type { DeliveryConfig } from "./delivery-contracts.js";
export type Api = (method: string, path: string, body?: unknown) => Promise<unknown>;
export function record(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid remote object"); return value as Record<string, any>;
}
export class GithubDelivery {
  readonly prefix: string;
  constructor(readonly config: NonNullable<DeliveryConfig["github"]>, readonly api: Api) { this.prefix = `repos/${config.repository}`; }
  async permission(): Promise<void> {
    const repo = record(await this.api("GET", this.prefix));
    if (repo.full_name !== this.config.repository || repo.permissions?.push !== true) throw new Error("Remote repository identity / push permission could not be verified");
  }
  validatePr(raw: unknown, branch: string, sha: string, key: string): Record<string, any> {
    const pr = record(raw);
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || typeof pr.html_url !== "string" || pr.html_url !== `https://github.com/${this.config.repository}/pull/${pr.number}`
      || pr.head?.sha !== sha || pr.head?.ref !== branch || pr.head?.repo?.full_name !== this.config.repository
      || pr.base?.ref !== this.config.baseBranch || pr.base?.repo?.full_name !== this.config.repository || typeof pr.body !== "string" || !pr.body.includes(`<!-- agent-workflow:${key} -->`)) throw new Error("PR identity/head/base/idempotency mismatch");
    return pr;
  }
  async findPr(branch: string, sha: string, key: string): Promise<Record<string, any> | null> {
    const owner = this.config.repository.split("/")[0];
    const raw = await this.api("GET", `${this.prefix}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(this.config.baseBranch)}&per_page=100`);
    if (!Array.isArray(raw) || raw.length >= 100) throw new Error("Cannot prove complete unique PR lookup");
    if (raw.length > 1) throw new Error("Ambiguous duplicate PRs for delivery branch");
    if (!raw.length) return null;
    return this.validatePr(await this.api("GET", `${this.prefix}/pulls/${record(raw[0]).number}`), branch, sha, key);
  }
  async checks(sha: string, required: string[]): Promise<void> {
    if (!required.length) throw new Error("Explicit required remote checks missing");
    const payload = record(await this.api("GET", `${this.prefix}/commits/${sha}/check-runs?per_page=100`));
    if (!Array.isArray(payload.check_runs) || payload.total_count !== payload.check_runs.length || payload.total_count > 100) throw new Error("Incomplete remote check evidence");
    for (const name of required) {
      const candidates = payload.check_runs.map(record).filter(c => c.name === name).sort((a,b) => b.id-a.id);
      const current = candidates[0];
      if (!current || !Number.isSafeInteger(current.id) || current.head_sha !== sha || current.status !== "completed" || current.conclusion !== "success") throw new Error(`Remote check not successful for exact SHA: ${name}`);
    }
  }
  async mergePolicy(): Promise<void> {
    const protection=record(await this.api("GET",`${this.prefix}/branches/${encodeURIComponent(this.config.baseBranch)}/protection`));
    const policy = record(protection.required_status_checks);
    const contexts = Array.isArray(policy.contexts) ? policy.contexts : [];
    const checks = Array.isArray(policy.checks) ? policy.checks.map((c: any) => c.context) : [];
    if (policy.strict !== true || protection.enforce_admins?.enabled!==true || !this.config.merge!.requiredChecks.every(c => [...contexts, ...checks].includes(c))) throw new Error("Merge requires strict protected-branch checks without administrator bypass");
  }
  async mergedTree(sha: string, expected: string): Promise<void> {
    const commit = record(await this.api("GET", `${this.prefix}/commits/${sha}`));
    if (commit.sha !== sha || commit.commit?.tree?.sha !== expected) throw new Error("Merged content differs from accepted tree; deployment forbidden");
  }
}
