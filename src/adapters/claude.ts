import type { StageInput, Usage } from "../contracts.js";
import { stageSchema } from "./schema.js";
import { observeUsage } from "./usage.js";
import { redact } from "../process.js";
export function claudeFailureMessage(stdout: string): string | null {
  try {
    const result = JSON.parse(stdout) as Record<string, unknown> | null;
    if (!result || result.type !== "result" || result.is_error !== true || typeof result.result !== "string") return null;
    const prefix = result.api_error === "usage_limit_reached" ? "Claude alcanzó el límite de uso de la cuenta. " : "Claude: ";
    return redact(prefix + result.result).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 800);
  } catch { return null; }
}
export function claudeCommand(input: StageInput): string[] {
  const tools = input.stage === "build" ? "Read,Glob,Grep,Edit,Write,Bash" : "Read,Glob,Grep";
  const agent = input.config.agents[input.agentId]!;
  return [...agent.command, ...(agent.model ? ["--model", agent.model] : []), ...(agent.effort ? ["--effort", agent.effort] : []), "-p", "--output-format", "json", "--json-schema", JSON.stringify(stageSchema), "--tools", tools, "--allowedTools", tools, "--setting-sources", "project", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', ...(input.disableHooks?["--settings",'{"disableAllHooks":true}']:[])];
}
export function claudeResponse(stdout: string): { payload: unknown; sessionId: string | null; usage: Usage } {
  const result = JSON.parse(stdout) as Record<string, unknown>;
  if (result.type !== "result" || result.is_error !== false || result.subtype !== "success") throw new Error(claudeFailureMessage(stdout) ?? "Claude reported an unsuccessful result");
  return { payload: result.structured_output, ...observeUsage("claude", stdout) };
}
