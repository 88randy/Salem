#!/usr/bin/env node
import { loadProjectConfig, loadTask } from "./config.js";
import { inspectAgent } from "./doctor.js";
import { runStage } from "./adapters/index.js";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Stage } from "./contracts.js";
import { runTask, resumeRun } from "./runner.js";
import { diagnoseProject } from "./project-profile.js";
import { StateStore } from "./state-store.js";
import { summarizeRun } from "./metrics.js";
import { reportBenchmark } from "./benchmark-report.js";
try {
  const args = process.argv.slice(2);
  const command = args.shift();
  if(command === "ui") {
    await (await import("./local/main.js")).startUI(args);
  } else {
  if (!["doctor", "stage", "run", "resume", "diagnose", "report"].includes(String(command))) throw new Error("Usage: salem <ui|doctor|diagnose|stage|run|resume|report> [--config <profile.json>] [--task <task.json> | --run <run-id>] [--state-dir <directory>]");
  const options: Record<string, string | true> = {};
  while (args.length) {
    const key = args.shift()!;
    if (!["--config", "--agent", "--stage", "--task", "--artifacts", "--smoke", "--state-dir", "--run", "--benchmark"].includes(key) || key in options) throw new Error(`Unknown/duplicate option ${key}`);
    if (key === "--smoke") options[key] = true;
    else { const value = args.shift(); if (!value || value.startsWith("--")) throw new Error(`Missing value for ${key}`); options[key] = value; }
  }
  if (command === "report") {
    if (typeof options["--benchmark"] === "string" && Object.keys(options).length === 1) console.log(JSON.stringify(await reportBenchmark(options["--benchmark"]),null,2));
    else {
      if (Object.keys(options).some(k => !["--run", "--state-dir"].includes(k)) || typeof options["--run"] !== "string") throw new Error("report requires --run [--state-dir] or --benchmark <manifest.json>");
      const store = new StateStore(typeof options["--state-dir"] === "string" ? options["--state-dir"] : ".artifacts/runs");
      console.log(JSON.stringify(summarizeRun(await store.read(options["--run"]) as unknown as import("./contracts.js").RunState), null, 2));
    }
  } else {
  if (options["--benchmark"]) throw new Error("--benchmark is only valid for report");
  if (typeof options["--config"] !== "string") throw new Error("--config required");
  const config = await loadProjectConfig(options["--config"]);
  const agentId = options["--agent"];
  if (agentId && (typeof agentId !== "string" || !config.agents[agentId])) throw new Error("Unknown agent id");
  if(command==="diagnose"){
    if(Object.keys(options).some(k=>k!=="--config"))throw new Error("diagnose accepts only --config");
    console.log(JSON.stringify(await diagnoseProject(config),null,2));
  }else if (command === "run" || command === "resume") {
    const allowed = command === "run" ? ["--config", "--task", "--state-dir"] : ["--config", "--run", "--state-dir"];
    if (Object.keys(options).some(key => !allowed.includes(key))) throw new Error(`Invalid option for ${command}`);
    const input = options[command === "run" ? "--task" : "--run"];
    if (typeof input !== "string") throw new Error(command === "run" ? "run requires --task" : "resume requires --run");
    const controller = new AbortController(); const cancel = () => controller.abort();
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    try {
      const runnerOptions = { signal: controller.signal, ...(typeof options["--state-dir"] === "string" ? { stateDir: options["--state-dir"] } : {}),
        onCheckpoint: async (state: import("./contracts.js").RunState) => {
          console.error(JSON.stringify({ event: "checkpoint", runId: state.id, revision: state.revision, status: state.status, nextPhase: state.nextPhase, attempts: state.attempts.length, lastAttemptConfirmed: Boolean(state.attempts.at(-1)?.result) }));
        } };
      const result = command === "run" ? await runTask(await loadTask(input), config, runnerOptions) : await resumeRun(input, config, runnerOptions);
      console.log(JSON.stringify(result, null, 2)); process.exitCode = result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
    } finally { process.removeListener("SIGINT", cancel); process.removeListener("SIGTERM", cancel); }
  } else if (command === "stage") {
    if (options["--state-dir"] || options["--run"]) throw new Error("stage does not accept supervisor options");
    const stage = options["--stage"];
    if (typeof agentId !== "string" || typeof options["--task"] !== "string" || typeof options["--artifacts"] !== "string" || !["define", "build", "review"].includes(String(stage)) || options["--smoke"]) throw new Error("stage requires --agent, --stage, --task and --artifacts");
    const result = await runStage({ config, agentId, stage: stage as Stage, task: await loadTask(options["--task"]), artifactDir: options["--artifacts"] });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.status === "succeeded" && result.payload?.verdict === "success" ? 0 : 1;
  } else {
    if (options["--state-dir"] || options["--run"]) throw new Error("doctor does not accept supervisor options");
    if (options["--task"] || options["--stage"]) throw new Error("doctor does not execute arbitrary tasks; use stage");
    const agents: Record<string, unknown> = {};
    for (const [id, agent] of Object.entries(config.agents)) {
      if (agentId && id !== agentId) continue;
      const health = await inspectAgent(agent, config.repoRoot);
      let contextAccepted: boolean | null = null;
      let evidence: string | null = null;
      if (options["--smoke"] && health.compatible && health.authenticated) {
        const artifactDir = resolve(typeof options["--artifacts"] === "string" ? options["--artifacts"] : ".artifacts", `${id}-${randomUUID()}`);
        const result = await runStage({ config, agentId: id, stage: "review", artifactDir,
          task: { id: "CONTEXT-SMOKE", objective: "Read the configured project instruction files. In summary include the exact context confirmation requested by those files. Do not modify files or run any other task.", scope: ["Read project instructions"], acceptance: ["Report the required context confirmation"], references: [] } });
        // Smoke acceptance is available only for a project that declares its
        // own confirmation in the context, not for arbitrary software tasks.
        const contexts = await Promise.all(config.contextFiles.map(p => readFile(resolve(config.repoRoot, p), "utf8")));
        const confirmations = contexts.flatMap(c => c.match(/CONTEXTO-[A-Za-z0-9-]+/g) ?? []);
        contextAccepted = result.status === "succeeded" && result.payload?.verdict === "success" && confirmations.length > 0 && confirmations.every(c => result.payload!.summary.includes(c));
        evidence = artifactDir;
      }
      agents[id] = { ...health, contextAccepted, evidence };
      if (!health.compatible || health.authenticated !== true || (options["--smoke"] && contextAccepted !== true)) process.exitCode = 1;
    }
    console.log(JSON.stringify({ configuration: "valid", projectId: config.projectId, agents }, null, 2));
  }
  }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Invalid configuration");
  process.exitCode = 1;
}
