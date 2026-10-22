import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProjectConfig } from "../src/config.js";
import { codexCommand } from "../src/adapters/codex.js";
import { claudeCommand } from "../src/adapters/claude.js";
import type { StageInput } from "../src/contracts.js";

test("Codex supports an explicit clean user configuration without changing global settings", async () => {
  const config = await loadProjectConfig("profiles/demo.json");
  const agent = config.agents.codex! as unknown as Record<string, unknown>;
  agent.ignoreUserConfig = true;
  const input: StageInput = { config, agentId: "codex", stage: "review", artifactDir: "evidence with spaces",
    task: { id: "CMD-1", objective: "Read", scope: ["read"], acceptance: ["read"], references: [] } };
  const command = codexCommand(input);
  assert.equal(command[config.agents.codex!.command.length], "exec");
  assert.ok(command.includes("--ignore-user-config"));
  assert.ok(command.indexOf("--ignore-user-config") > command.indexOf("exec"));
  assert.equal(command[command.indexOf("--sandbox") + 1], "read-only");
  assert.equal(command.includes("--model"), false, "clean profile uses CLI default rather than substituting a named model");
  delete agent.ignoreUserConfig;
  assert.equal(codexCommand(input).includes("--ignore-user-config"), false);
});

test("stage command builders preserve read-only review and explicit build tool boundaries", async () => {
  const config = await loadProjectConfig("profiles/demo.json");
  const input: StageInput = { config, agentId: "codex", stage: "review", artifactDir: "evidence with spaces",
    task: { id: "CMD-2", objective: "Read", scope: ["read"], acceptance: ["read"], references: [] } };
  for (const stage of ["define", "review"] as const) {
    input.stage = stage;
    const codex = codexCommand(input);
    assert.equal(codex[codex.indexOf("--sandbox") + 1], "read-only");
    input.agentId = "claude";
    const claude = claudeCommand(input);
    assert.equal(claude[claude.indexOf("--tools") + 1], "Read,Glob,Grep");
    assert.equal(claude[claude.indexOf("--allowedTools") + 1], "Read,Glob,Grep");
    assert.ok(claude.includes("--strict-mcp-config"));
    input.agentId = "codex";
  }
  input.stage = "build";
  const codex = codexCommand(input);
  assert.equal(codex[codex.indexOf("--sandbox") + 1], "workspace-write");
  input.agentId = "claude";
  const claude = claudeCommand(input);
  assert.equal(claude[claude.indexOf("--tools") + 1], "Read,Glob,Grep,Edit,Write,Bash");
});
