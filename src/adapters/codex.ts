import type { StageInput, Usage } from "../contracts.js";
import { join } from "node:path";
import { observeUsage } from "./usage.js";
export function codexCommand(input: StageInput): string[] {
  const agent = input.config.agents[input.agentId]!;
  return [...agent.command, "exec", ...(agent.ignoreUserConfig ? ["--ignore-user-config"] : []), ...(agent.model ? ["--model", agent.model] : []), ...(agent.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(agent.effort)}`] : []), "--json", "--output-schema", join(input.artifactDir, "schema.json"), "--output-last-message", join(input.artifactDir, "last-message.json"), "--cd", input.config.repoRoot, "--sandbox", input.stage === "build" ? "workspace-write" : "read-only", "-"];
}
export function codexMetadata(stdout: string): { sessionId: string | null; usage: Usage } {
  let completed = false;
  for (const line of stdout.trim().split(/\r?\n/)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "turn.failed" || event.type === "error") throw new Error("Codex reported a failed turn");
    if (event.type === "turn.completed") {
      completed = true;
    }
  }
  if (!completed) throw new Error("Codex did not complete a turn");
  return observeUsage("codex", stdout);
}
