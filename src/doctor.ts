import type { AgentConfig } from "./contracts.js";
import { runProcess } from "./process.js";
export interface AgentHealth { installed: boolean; compatible: boolean; authenticated: boolean | null; version: string | null; error: string | null }
export async function inspectAgent(agent: AgentConfig, cwd: string, options: { signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number; leaseDir?: string } = {}): Promise<AgentHealth> {
  const deadline = Date.now() + (options.timeoutMs ?? 45000);
  const run = (args: string[]) => runProcess({ command: [...agent.command, ...args], cwd, timeoutMs: Math.max(1, Math.min(15000, deadline - Date.now())), maxOutputBytes: options.maxOutputBytes ?? 100000, ...(options.signal ? { signal: options.signal } : {}), ...(options.leaseDir ? { leaseDir: options.leaseDir } : {}) });
  const result: AgentHealth = { installed: false, compatible: false, authenticated: null, version: null, error: null };
  if (options.signal?.aborted) { result.error = "Cancelled before health probes"; return result; }
  const v = await run(["--version"]);
  if (v.status !== "exited" || v.exitCode !== 0) { result.error = v.error ?? "CLI version failed"; return result; }
  result.installed = true; result.version = v.stdout.trim().slice(0, 200);
  if (Date.now() >= deadline || options.signal?.aborted) { result.error = "Health deadline exceeded or cancelled"; return result; }
  const help = await run(agent.provider === "codex" ? ["exec", "--help"] : ["--help"]);
  const required = agent.provider === "codex" ? ["--json", "--output-schema", "--output-last-message", "--sandbox", "--cd"] : ["--json-schema", "--output-format", "--tools", "--allowedTools", "--setting-sources", "--strict-mcp-config", "--mcp-config"];
  if (agent.ignoreUserConfig) required.push("--ignore-user-config");
  if (help.status !== "exited" || help.exitCode !== 0 || !required.every(flag => help.stdout.includes(flag))) { result.error = "CLI incompatible with required adapter capabilities"; return result; }
  result.compatible = true;
  if (Date.now() >= deadline || options.signal?.aborted) { result.error = "Health deadline exceeded or cancelled"; return result; }
  const auth = await run(agent.provider === "codex" ? ["login", "status"] : ["auth", "status"]);
  if (auth.status !== "exited" || auth.exitCode !== 0) { result.authenticated = auth.status === "exited" ? false : null; result.error = auth.error ?? "Authentication command failed"; return result; }
  if (agent.provider === "claude") {
    try { const parsed = JSON.parse(auth.stdout) as { loggedIn?: unknown }; result.authenticated = typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : null; } catch { result.authenticated = null; }
  } else {
    const output = `${auth.stdout}\n${auth.stderr}`;
    result.authenticated = /\bnot logged in\b/i.test(output) ? false : /^\s*Logged in\b/im.test(output) ? true : null;
  }
  if (result.authenticated !== true) result.error = result.authenticated === false ? "Authentication required" : "Authentication could not be verified";
  return result;
}
