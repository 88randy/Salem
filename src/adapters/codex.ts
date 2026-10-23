import type { StageInput, Usage } from "../contracts.js";
import { join } from "node:path";
import { observeUsage } from "./usage.js";
import { redact } from "../process.js";
export function codexFailureMessage(stdout: string): string | null {
  let message: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line) as {type?: string; message?: unknown; error?: {message?: unknown}} | null;
      const value = event?.type === "turn.failed" ? event.error?.message : event?.type === "error" ? event.message : null;
      if (typeof value === "string" && value.trim()) message = value;
    } catch { /* unrelated or incomplete events retain their raw evidence */ }
  }
  if(message===null)return null;
  // Some CLI versions wrap the provider response as JSON inside a message.
  for(let depth=0;depth<3;depth++){
    try{
      const nested=JSON.parse(message) as {error?:{message?:unknown}} | null;
      if(typeof nested?.error?.message!=='string')break;
      message=nested.error.message;
    }catch{break;}
  }
  const advice=/model is not supported|model[^\n]{0,120}(?:not available|not supported)/i.test(message)
    ? ' En Proyectos, edita los agentes y selecciona Predeterminado del CLI o un modelo disponible para tu cuenta. Si cambiaste el perfil, inicia una conversación nueva; el historial anterior se conserva.' : '';
  return (redact('Codex: '+message).replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,800-advice.length)+advice).slice(0,800);
}
export function codexCommand(input: StageInput): string[] {
  const agent = input.config.agents[input.agentId]!;
  return [...agent.command, "exec", ...(agent.ignoreUserConfig ? ["--ignore-user-config"] : []), ...(agent.model ? ["--model", agent.model] : []), ...(agent.effort ? ["-c", `model_reasoning_effort=${JSON.stringify(agent.effort)}`] : []), "--json", "--output-schema", join(input.artifactDir, "schema.json"), "--output-last-message", join(input.artifactDir, "last-message.json"), "--cd", input.config.repoRoot, "--sandbox", input.stage === "build" ? "workspace-write" : "read-only", "-"];
}
export function codexMetadata(stdout: string): { sessionId: string | null; usage: Usage } {
  let completed = false;
  for (const line of stdout.trim().split(/\r?\n/)) {
    const event = JSON.parse(line) as Record<string, unknown>;
    if (event.type === "turn.failed" || event.type === "error") throw new Error(codexFailureMessage(stdout) ?? "Codex reported a failed turn");
    if (event.type === "turn.completed") {
      completed = true;
    }
  }
  if (!completed) throw new Error("Codex did not complete a turn");
  return observeUsage("codex", stdout);
}
