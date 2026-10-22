import type { Usage } from "../contracts.js";
const count = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
const sum = (values: (number | null)[]) => values.length && values.every(v => v !== null) ? (values as number[]).reduce((a,b) => a+b,0) : null;
export function observeUsage(provider: "claude" | "codex", stdout: string): { sessionId: string | null; usage: Usage } {
  if (provider === "claude") {
    const r = JSON.parse(stdout) as Record<string, unknown>;
    if (r.type !== "result") throw new Error("Not a Claude result");
    const u = r.usage as Record<string, unknown> | undefined;
    const models = r.modelUsage && typeof r.modelUsage === "object" ? r.modelUsage as Record<string, Record<string, unknown>> : {};
    const values = Object.values(models);
    const wholeTree = values.length > 0 && values.every(v => count(v.inputTokens) !== null && count(v.outputTokens) !== null && count(v.cacheReadInputTokens) !== null && count(v.cacheCreationInputTokens) !== null);
    return { sessionId: typeof r.session_id === "string" ? r.session_id : null, usage: {
      inputTokens: wholeTree ? sum(values.map(v => count(v.inputTokens))) : count(u?.input_tokens),
      outputTokens: wholeTree ? sum(values.map(v => count(v.outputTokens))) : count(u?.output_tokens),
      cachedInputTokens: wholeTree ? sum(values.map(v => count(v.cacheReadInputTokens))) : count(u?.cache_read_input_tokens),
      costUsd: count(r.total_cost_usd), costKind: count(r.total_cost_usd) !== null ? "estimated" : "unavailable", model: Object.keys(models).sort().join(",") || null,
      accounting: { tokenScope: wholeTree ? "session_cumulative" : "invocation", costScope: "session_cumulative", inputIncludesCache: false,
        cacheCreationInputTokens: wholeTree ? sum(values.map(v => count(v.cacheCreationInputTokens))) : count(u?.cache_creation_input_tokens),
        source: wholeTree ? "claude.result.modelUsage" : "claude.result.usage_main_loop", complete: r.subtype !== "error_during_execution" }
    } };
  }
  let sessionId: string | null = null, model: string | null = null, failed = false, malformed = false, pendingTurns = 0;
  const turns: Record<string, unknown>[] = [];
  for (const line of stdout.trim().split(/\r?\n/).filter(Boolean)) {
    let e: Record<string, unknown>;
    try { e = JSON.parse(line); } catch { malformed = true; continue; }
    if (e.type === "thread.started" && typeof e.thread_id === "string") sessionId = e.thread_id;
    if (typeof e.model === "string") model = e.model;
    if (e.type === "turn.failed" || e.type === "error") failed = true;
    if (e.type === "turn.started") pendingTurns++;
    if (e.type === "turn.completed") { pendingTurns=Math.max(0,pendingTurns-1); turns.push(e.usage && typeof e.usage === "object" ? e.usage as Record<string, unknown> : {}); }
  }
  return { sessionId, usage: { inputTokens: sum(turns.map(t => count(t.input_tokens))), outputTokens: sum(turns.map(t => count(t.output_tokens))),
    cachedInputTokens: sum(turns.map(t => count(t.cached_input_tokens))), costUsd: null, costKind: "unavailable", model,
    accounting: { tokenScope: "invocation", costScope: "invocation", inputIncludesCache: true, cacheCreationInputTokens: sum(turns.map(t => count(t.cache_write_input_tokens))),
      source: "codex.turn.completed", complete: !failed && !malformed && pendingTurns === 0 && turns.length > 0 } } };
}
