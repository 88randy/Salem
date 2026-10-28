import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountManager } from "../src/local/accounts.js";
import { defaultSettings, type LocalState, type Provider, type AccountView } from "../src/local/contracts.js";

const fixturePath = join(process.cwd(), "tests", "fixtures", "local-auth.mjs");
async function setup(data: Record<string, unknown> = {}, options: { timeoutMs?: number; isBusy?: (provider: Provider) => boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "salem-accounts-"));
  const stateFile = join(dir, "fixture-state.json");
  await writeFile(stateFile, JSON.stringify({ authenticated: false, ...data }));
  const state: LocalState = { schemaVersion: 1, revision: 1, settings: defaultSettings(), projects: [], tasks: [], executions: [] };
  for (const provider of ["claude", "codex"] as const) state.settings.commands[provider] = [process.execPath, fixturePath, "--state", stateFile, "--provider", provider];
  const manager = new AccountManager({ readState: async () => state }, { cwd: dir, timeoutMs: 4000, ...options });
  return { manager, dir, state, stateFile, async events() { try { return (await readFile(`${stateFile}.events`, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]); } catch { return []; } }, async close() { await manager.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } };
}
async function until(manager: AccountManager, predicate: (view: AccountView) => boolean, provider: Provider = "codex", timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = manager.list().find(view => view.provider === provider)!;
    if (predicate(view)) return view;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Account did not reach expected state: ${JSON.stringify(manager.list())}`);
}

test("account list is an isolated cache with no CLI probes", async () => {
  const s = await setup();
  try {
    assert.equal(s.manager.list().length, 2);
    assert.equal(s.manager.list()[0]!.authenticated, null);
    s.manager.list()[0]!.error = "mutated outside";
    assert.equal(s.manager.list()[0]!.error, null);
    assert.deepEqual(await s.events(), []);
  } finally { await s.close(); }
});
test("health verifies both provider formats and follows changed executable settings", async () => {
  const s = await setup({ authenticated: true });
  try {
    for (const provider of ["claude", "codex"] as const) assert.equal((await s.manager.check(provider)).connection, "connected");
    s.state.settings.commands.codex = ["missing-salem-cli-91b3"];
    const missing = await s.manager.check("codex");
    assert.equal(missing.installed, false); assert.equal(missing.authenticated, null);
    await assert.rejects(s.manager.check("unknown" as Provider), /proveedor|provider/i);
  } finally { await s.close(); }
});
test("nonzero status with positive output is never authenticated", async () => {
  const s = await setup({ authenticated: false, statusPositive: true, statusExit: 1 });
  try {
    for (const provider of ["claude", "codex"] as const) assert.equal((await s.manager.check(provider)).authenticated, false);
  } finally { await s.close(); }
});
test("exit zero with negative status is not an authenticated account", async () => {
  const s = await setup({ authenticated: false, statusExit: 0 });
  try { assert.equal((await s.manager.check("codex")).authenticated, false); }
  finally { await s.close(); }
});
test("incompatible CLI cannot start a login", async () => {
  const s = await setup({ incompatible: true });
  try {
    const view = await s.manager.connect("codex");
    assert.equal(view.installed, true); assert.equal(view.compatible, false); assert.equal(view.connection, "failed");
    assert.equal((await s.events()).some(args => args[0] === "login"), false);
  } finally { await s.close(); }
});
test("connecting an existing account does not start login or logout", async () => {
  const s = await setup({ authenticated: true });
  try {
    assert.equal((await s.manager.connect("codex")).connection, "connected");
    assert.equal((await s.events()).some(args => args[0] === "login" && args[1] !== "status"), false);
    assert.equal((await s.events()).some(args => args.includes("logout")), false);
  } finally { await s.close(); }
});
test("browser login streams only an official URL and accepts memory-only return code", async () => {
  const s = await setup();
  try {
    assert.equal((await s.manager.connect("claude")).connection, "connecting");
    const pending = await until(s.manager, view => view.loginUrl !== null && view.needsInput, "claude");
    assert.equal(new URL(pending.loginUrl!).hostname, "claude.ai");
    assert.equal((await s.events()).some(args => args.includes("login") && args.includes("--claudeai")), true);
    assert.equal(JSON.stringify(pending).includes("private-access-token"), false);
    await s.manager.input("claude", "fixture-return-code");
    const connected = await until(s.manager, view => view.connection === "connected", "claude");
    assert.equal(connected.authenticated, true); assert.equal(connected.loginUrl, null); assert.equal(connected.needsInput, false);
    assert.equal((await readFile(`${s.stateFile}.events`, "utf8")).includes("fixture-return-code"), false);
    await assert.rejects(s.manager.input("claude", "another-code"), /activa|active/i);
  } finally { await s.close(); }
});
test("device login exposes ephemeral code and cancel expires its operation", async () => {
  const s = await setup();
  try {
    await s.manager.connect("codex", "device");
    const pending = await until(s.manager, view => view.userCode !== null);
    assert.equal(pending.userCode, "ABCD-EFGH");
    assert.equal((await s.events()).some(args => args.includes("--device-auth")), true);
    const cancelling = s.manager.cancel("codex");
    assert.equal(s.manager.list().find(view => view.provider === "codex")!.loginUrl, null);
    assert.equal(s.manager.list().find(view => view.provider === "codex")!.userCode, null);
    const cancelled = await cancelling;
    assert.equal(cancelled.connection, "cancelled"); assert.equal(cancelled.loginUrl, null); assert.equal(cancelled.userCode, null);
  } finally { await s.close(); }
});
test("timeout clears ephemeral data and never returns raw auth output", async () => {
  const s = await setup();
  try {
    await s.manager.connect("codex", "device");
    // Prove a real login reached its ephemeral state before testing expiry.
    // A subsecond budget could instead expire inside the CLI compatibility probe.
    const pending = await until(s.manager, view => view.userCode !== null);
    assert.equal(pending.userCode, "ABCD-EFGH"); assert.notEqual(pending.loginUrl, null);
    const failed = await until(s.manager, view => view.connection === "failed", "codex", 10000);
    assert.equal(failed.loginUrl, null); assert.equal(failed.userCode, null);
    assert.match(failed.error!, /tiempo|timeout/i); assert.equal(JSON.stringify(failed).includes("private-access-token"), false);
  } finally { await s.close(); }
});
test("untrusted, credential-bearing, and non-HTTPS login URLs are rejected", async () => {
  for (const url of ["https://auth.openai.com.evil.test/login", "http://auth.openai.com/login", "https://user:secret@auth.openai.com/login", "https://auth.openai.com/login?access_token=secret", "https://auth.openai.com:444/login"]) {
    const s = await setup({ url });
    try {
      await s.manager.connect("codex");
      await until(s.manager, view => view.needsInput);
      assert.equal(s.manager.list().find(view => view.provider === "codex")!.loginUrl, null);
    } finally { await s.close(); }
  }
});
test("positive login text on nonzero exit never authenticates", async () => {
  const s = await setup({ mode: "nonzero" });
  try {
    await s.manager.connect("codex");
    const failed = await until(s.manager, view => view.connection === "failed");
    assert.equal(failed.authenticated, false); assert.equal(failed.loginUrl, null);
    assert.equal(JSON.stringify(failed).includes("private-access-token"), false);
  } finally { await s.close(); }
});
test("success is confirmed through a fresh health probe and disconnect verifies logout", async () => {
  const s = await setup({ mode: "auto" });
  try {
    await s.manager.connect("codex");
    await until(s.manager, view => view.connection === "connected");
    assert.ok((await s.events()).filter(args => args.includes("status")).length >= 2);
    assert.equal((await s.manager.disconnect("codex")).authenticated, false);
    assert.equal((await s.events()).some(args => args[0] === "logout"), true);
  } finally { await s.close(); }
});
test("successful process exit without a confirmed session fails closed", async () => {
  const s = await setup({ mode: "auto", noSessionAfterLogin: true });
  try {
    await s.manager.connect("codex");
    const view = await until(s.manager, view => view.connection === "failed");
    assert.equal(view.authenticated, false); assert.equal(view.loginUrl, null);
  } finally { await s.close(); }
});
test("failed logout does not claim the existing session disappeared", async () => {
  const s = await setup({ authenticated: true, logoutFails: true });
  try {
    await s.manager.check("claude");
    const view = await s.manager.disconnect("claude");
    assert.equal(view.connection, "failed"); assert.equal(view.authenticated, true);
    assert.equal(JSON.parse(await readFile(s.stateFile, "utf8")).authenticated, true);
  } finally { await s.close(); }
});
test("busy provider blocks all auth mutations but permits explicit health", async () => {
  const s = await setup({ authenticated: true }, { isBusy: provider => provider === "codex" });
  try {
    for (const action of [() => s.manager.connect("codex"), () => s.manager.disconnect("codex"), () => s.manager.cancel("codex"), () => s.manager.input("codex", "secret")]) {
      await assert.rejects(action, error => (error as Error & {status?: number}).status === 409);
    }
    assert.equal((await s.manager.check("codex")).authenticated, true);
    assert.equal((await s.events()).some(args => args.includes("logout")), false);
  } finally { await s.close(); }
});
test("close cancels owned login and forbids subsequent launch", async () => {
  const s = await setup();
  try {
    await s.manager.connect("codex");
    await until(s.manager, view => view.needsInput);
    await s.manager.close();
    assert.equal(s.manager.list().find(view => view.provider === "codex")!.connection, "cancelled");
    await assert.rejects(s.manager.connect("claude"), /cerrado|closed/i);
  } finally { await s.close(); }
});
test("close waits for its interrupted health check to settle", async () => {
  const s = await setup();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new AccountManager({ readState: async () => { await gate; return s.state; } }, { cwd: s.dir });
  try {
    const checking = manager.check("codex");
    let closed = false;
    const closing = manager.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(closed, false, "shutdown waits for all of its own probes");
    release();
    await Promise.all([checking, closing]);
    assert.deepEqual(await s.events(), []);
  } finally { release(); await manager.close(); await s.close(); }
});
test("account mutation predicate reserves even a login that discovers an existing session", async () => {
  const s = await setup({ authenticated: true });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const manager = new AccountManager({ readState: async () => { await gate; return s.state; } }, { cwd: s.dir });
  try {
    const connecting = manager.connect("codex");
    assert.equal(manager.isMutating("codex"), true);
    assert.equal(manager.isMutating("claude"), false);
    release();
    assert.equal((await connecting).connection, "connected");
    assert.equal(manager.isMutating("codex"), false);
    assert.equal((await s.events()).some(args => args[0] === "login" && args[1] !== "status"), false);
  } finally { release(); await manager.close(); await s.close(); }
});
test("logout reservation survives a connected cache and close waits for owned logout cleanup", async () => {
  // Logout is capped at 15 s by the manager; give a slow runner that whole window to reach the gate.
  const s = await setup({ authenticated: true }, { timeoutMs: 15000 });
  const gate = join(s.dir, "logout-gate");
  await writeFile(s.stateFile, JSON.stringify({ authenticated: true, logoutGate: gate }));
  let logout: Promise<AccountView> | undefined;
  try {
    await s.manager.check("codex");
    logout = s.manager.disconnect("codex");
    assert.equal(s.manager.isMutating("codex"), true);
    assert.equal(s.manager.list().find(view => view.provider === "codex")!.connection, "connected");
    let pid: number | undefined;
    const deadline = Date.now() + 15000;
    while (!pid && Date.now() < deadline) {
      try { pid = Number(await readFile(`${s.stateFile}.logout-pid`, "utf8")); }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.ok(pid, "native fixture logout reached its gate");
    await s.manager.close(); await logout;
    assert.equal(s.manager.isMutating("codex"), false);
    assert.throws(() => process.kill(pid!, 0), "shutdown waits until its logout process exits");
    assert.equal(JSON.parse(await readFile(s.stateFile, "utf8")).authenticated, true);
  } finally { await writeFile(gate, "release"); await logout?.catch(() => {}); await s.close(); }
});
// Parent-death cleanup has a different owner per platform, so each platform gets its own honest test.
// POSIX: the guardian spawns the login detached (its own process group), the parent receives SIGTERM alone and
// the fixture ignores stdin EOF, so the only thing that can kill the login is the guardian's
// process.on("disconnect", stop) handler. Removing that handler makes this test fail.
// Windows: libuv assigns every non-detached child to a job object created with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
// (src/win/process.c, uv__init_global_job_handle and uv_spawn). Killing the parent closes its job, which kills the
// guardian, whose own job then kills the login. The guardian handler never gets to run, so this test only checks
// that containment guarantee; it would still pass with the handler removed.
const isWindows = process.platform === "win32";
test("POSIX: the guardian's IPC disconnect handler kills its detached login group when the Salem parent dies",
  { skip: isWindows && "Windows kills the login through libuv job containment; covered by the Windows test" },
  () => loginDiesWithSalemParent("IPC disconnect killed only the owned fixture login"));
test("Windows: libuv kill-on-close job containment stops the login when the Salem parent dies (guardian handler not exercised)",
  { skip: !isWindows && "POSIX has no job containment; covered by the POSIX guardian handler test" },
  () => loginDiesWithSalemParent("closing the parent's libuv job killed the guardian and its login"));
async function loginDiesWithSalemParent(message: string) {
  // The slow start and the torn pid write reproduce the loaded-runner flake; readiness must not depend on timing.
  const s = await setup({ loginDelayMs: 5500, pidWriteGapMs: 500 });
  const moduleUrl = new URL("../src/local/auth-process.js", import.meta.url).href;
  // The guardian's own timeout must outlast every wait below, so it cannot mask a failed parent-death cleanup.
  const code = `import { startAuthProcess } from ${JSON.stringify(moduleUrl)};
    await startAuthProcess({ command: ${JSON.stringify([...s.state.settings.commands.codex, "login"])}, cwd: ${JSON.stringify(s.dir)}, timeoutMs: 120000, signal: new AbortController().signal, onOutput(text) { process.stdout.write(text); } });
    setInterval(() => {}, 1000);`;
  const parent = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", code], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  parent.stdout.on("data", chunk => { stdout += chunk; });
  parent.stderr.on("data", chunk => { stderr += chunk; });
  const parentClosed = new Promise<string>(resolve => parent.once("close", (code, signal) => resolve(`code=${code} signal=${signal}`)));
  let loginPid: number | undefined;
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    // The fixture prints its prompt only after the pid file is fully written.
    const ready = await new Promise<string>(resolve => {
      const timer = setTimeout(() => resolve("timed out after 60000 ms"), 60000);
      const check = () => { if (stdout.includes("Paste the authorization code here:")) { clearTimeout(timer); resolve("ready"); } };
      parent.stdout.on("data", check);
      void parentClosed.then(status => { clearTimeout(timer); resolve(`parent exited before readiness (${status})`); });
      check();
    });
    assert.equal(ready, "ready", `fixture login started in a separate Salem parent; stderr: ${stderr.trim() || "(empty)"}`);
    const raw = (await readFile(`${s.stateFile}.pid`, "utf8")).trim();
    assert.match(raw, /^[1-9]\d*$/, "fixture login wrote its pid");
    loginPid = Number(raw);
    assert.equal(alive(loginPid), true);
    parent.kill();
    const stopDeadline = Date.now() + 30000;
    while (alive(loginPid) && Date.now() < stopDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(alive(loginPid), false, message);
  } finally {
    parent.kill();
    if (loginPid && alive(loginPid)) process.kill(loginPid);
    await parentClosed;
    await s.close();
  }
}
