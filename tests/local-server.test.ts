import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalStore } from "../src/local/store.js";
import { AccountManager } from "../src/local/accounts.js";
import { runProcess } from "../src/process.js";
import type { Bootstrap, ProjectInput, ProjectRecord, TaskRecord } from "../src/local/contracts.js";

async function startFunction() {
  const module = await import("../src/local/server.js").catch(() => ({ startLocalServer: undefined }));
  assert.equal(typeof module.startLocalServer, "function", "HTTP localhost server is missing");
  return module.startLocalServer!;
}
async function fixture(extra: { sessionTtlMs?: number; realManager?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "salem-http-")), dataDir = join(root, "data"), staticDir = join(root, "web");
  await mkdir(staticDir); await mkdir(dataDir);
  await writeFile(join(staticDir, "index.html"), '<!doctype html><title>Salem</title><script src="/app.js"></script>');
  await writeFile(join(staticDir, "app.js"), 'console.log("Salem");');
  const store = new LocalStore(dataDir), accounts = new AccountManager(store);
  const calls: string[] = [];
  const manager = {
    async initialize() { calls.push("initialize"); }, isBusy() { return false; },
    async start(taskId: string, requestKey: string, baseExecutionId?: string) { calls.push("start"); return { taskId, requestKey, baseExecutionId }; },
    async cancel(id: string) { calls.push("cancel"); return { id, status: "cancelled" }; },
    async resume(id: string) { calls.push("resume"); return { id, status: "queued" }; },
    async detail(id: string) { calls.push("detail"); return { execution: { id }, run: null, metrics: null, diff: "fixture", artifacts: [] }; },
    async artifact(id: string, path: string, offset: number) { calls.push("artifact"); if (path.includes("..")) throw Object.assign(new Error("Ruta rechazada"), { status: 400 }); return { text: `${id}:${path}:${offset}`, truncated: false, nextOffset: null }; },
    async patch(id: string) { calls.push("patch"); if (id.startsWith("0")) throw Object.assign(new Error("No aceptada"), { status: 409 }); return { name: `salem-${id.slice(0, 8)}.patch`, data: Buffer.from([0, 1, 2, 255, 10]) }; },
    async shutdown() { calls.push("shutdown"); },
  };
  const start = await startFunction();
  const { realManager, ...serverOptions } = extra;
  const server = await start({ dataDir, staticDir, port: 0, store, ...(realManager ? {} : { accounts, manager }), directoryRoots: [dataDir], ...serverOptions });
  const response = await fetch(`${server.url}/api/bootstrap`), bootstrap = await response.json() as Bootstrap;
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  const headers = { Cookie: cookie, Origin: server.url, "X-Salem-CSRF": bootstrap.csrfToken, "Content-Type": "application/json" };
  return { root, dataDir, staticDir, store, accounts: server.accounts!, calls, server, headers, bootstrap, cookie, async close() { await server.close(); await rm(root, { recursive: true, force: true }); } };
}
async function rawGet(url: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{status: number; body: string}>( (resolve, reject) => {
    const req = request(url, { method: "GET", path, headers }, response => {
      const chunks: Buffer[] = []; response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, body: Buffer.concat(chunks).toString() }));
    }); req.on("error", reject); req.end();
  });
}
test("bootstrap establishes HttpOnly SameSite session and serves real UI without probing accounts", async () => {
  const s = await fixture();
  try {
    assert.ok(s.bootstrap.csrfToken); assert.equal(s.bootstrap.state.projects.length, 0);
    assert.equal(s.bootstrap.accounts.length, 2); assert.equal(s.bootstrap.accounts[0]!.authenticated, null);
    assert.equal(s.bootstrap.dataDir, s.dataDir);
    const bootstrap = await fetch(`${s.server.url}/api/bootstrap`, { headers: { Cookie: s.cookie } });
    assert.match(bootstrap.headers.get("set-cookie")!, /HttpOnly/); assert.match(bootstrap.headers.get("set-cookie")!, /SameSite=Strict/);
    assert.equal((await bootstrap.json() as Bootstrap).csrfToken, s.bootstrap.csrfToken);
    const html = await fetch(s.server.url); assert.match(await html.text(), /Salem/);
    const csp = html.headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'self'/); assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.equal(html.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(s.calls, ["initialize"]);
    assert.match(await (await fetch(`${s.server.url}/nested/screen`)).text(), /Salem/);
    assert.equal((await fetch(`${s.server.url}/missing.js`)).status, 404);
  } finally { await s.close(); }
});
test("Host Origin cookie CSRF and mutation method are all enforced", async () => {
  const s = await fixture();
  try {
    assert.equal((await fetch(`${s.server.url}/api/state`)).status, 401);
    assert.equal((await fetch(`${s.server.url}/api/state`, { headers: { Cookie: s.cookie } })).status, 200);
    assert.equal((await rawGet(s.server.url, "/api/bootstrap", { Host: "attacker.invalid" })).status, 403);
    assert.equal((await fetch(`${s.server.url}/api/bootstrap`, { headers: { Origin: "https://attacker.invalid" } })).status, 403);
    assert.equal((await fetch(`${s.server.url}/api/state`, { headers: { Cookie: s.cookie, Origin: "null" } })).status, 403);
    const settings = s.bootstrap.state.settings;
    for (const headers of [{ ...s.headers, Origin: "https://attacker.invalid" }, { ...s.headers, "X-Salem-CSRF": "wrong" }, { ...s.headers, "X-Salem-CSRF": "é".repeat(s.bootstrap.csrfToken.length) }, { ...s.headers, Cookie: "" }, { Cookie: s.cookie, "X-Salem-CSRF": s.bootstrap.csrfToken, "Content-Type": "application/json" }]) {
      assert.ok([401,403].includes((await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers, body: JSON.stringify(settings) })).status));
    }
    assert.equal((await fetch(`${s.server.url}/api/accounts/codex/connect`, { headers: { Cookie: s.cookie } })).status, 405);
    const second = await (await fetch(`${s.server.url}/api/bootstrap`)).json() as Bootstrap;
    assert.equal((await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers: { ...s.headers, "X-Salem-CSRF": second.csrfToken }, body: JSON.stringify(settings) })).status, 403);
    assert.deepEqual(s.calls, ["initialize"]);
  } finally { await s.close(); }
});
test("JSON limits malformed bodies and revision conflicts preserve settings", async () => {
  const s = await fixture();
  try {
    const settings = s.bootstrap.state.settings;
    const saved = await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers: s.headers, body: JSON.stringify({ ...settings, maxConcurrentRuns: 2 }) });
    assert.equal(saved.status, 200);
    assert.equal((await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers: s.headers, body: JSON.stringify(settings) })).status, 409);
    assert.equal((await s.store.readState()).settings.maxConcurrentRuns, 2);
    assert.equal((await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers: s.headers, body: "{" })).status, 400);
    assert.equal((await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers: { ...s.headers, "Content-Type": "text/plain" }, body: "{}" })).status, 415);
    assert.equal((await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers: s.headers, body: JSON.stringify({ value: "x".repeat(1024 * 1024) }) })).status, 413);
    const chunkedStatus = await new Promise<number>((resolveStatus, reject) => {
      const req = request(s.server.url, { method: "PUT", path: "/api/settings", headers: { ...s.headers, "Transfer-Encoding": "chunked" } }, response => { response.resume(); response.on("end", () => resolveStatus(response.statusCode!)); });
      req.on("error", reject);
      for (let i = 0; i < 17; i++) req.write("x".repeat(65536));
      req.end();
    });
    assert.equal(chunkedStatus, 413);
  } finally { await s.close(); }
});
test("static paths reject traversal and symlink escape while picker returns directories only", async () => {
  const s = await fixture();
  try {
    await writeFile(join(s.root, "private.txt"), "fixture-not-public");
    await mkdir(join(s.dataDir, "visible")); await writeFile(join(s.dataDir, "not-a-directory"), "no-read");
    await symlink(s.root, join(s.staticDir, "escape"), "junction");
    await symlink(s.root, join(s.dataDir, "link"), "junction");
    for (const path of ["/../private.txt", "/%2e%2e/private.txt", "/..%5cprivate.txt", "/escape/private.txt"]) {
      const response = await rawGet(s.server.url, path);
      assert.ok([400,403,404].includes(response.status)); assert.doesNotMatch(response.body, /fixture-not-public/);
    }
    const listing = await fetch(`${s.server.url}/api/filesystem/directories?path=${encodeURIComponent(s.dataDir)}`, { headers: { Cookie: s.cookie } });
    assert.equal(listing.status, 200);
    const data = await listing.json() as {path: string; parent: string | null; directories: {name: string; path: string}[]};
    assert.ok(data.directories.some(entry => entry.name === "visible"));
    assert.equal(data.directories.some(entry => ["link", "not-a-directory"].includes(entry.name)), false);
    assert.equal((await fetch(`${s.server.url}/api/filesystem/directories?path=${encodeURIComponent(s.root)}`, { headers: { Cookie: s.cookie } })).status, 403);
    assert.equal((await fetch(`${s.server.url}/api/filesystem/directories?path=${encodeURIComponent(join(s.dataDir, "link"))}`, { headers: { Cookie: s.cookie } })).status, 403);
  } finally { await s.close(); }
});
test("execution routes validate UUIDs and delegate only the requested operation", async () => {
  const s = await fixture();
  try {
    const id = randomUUID(), taskId = randomUUID();
    const start = await fetch(`${s.server.url}/api/executions`, { method: "POST", headers: s.headers, body: JSON.stringify({ taskId, requestKey: "fixture-key" }) });
    assert.equal(start.status, 200); assert.equal((await start.json() as {taskId:string}).taskId, taskId);
    assert.equal((await fetch(`${s.server.url}/api/executions/${id}`, { headers: { Cookie: s.cookie } })).status, 200);
    assert.equal((await fetch(`${s.server.url}/api/executions/bad`, { headers: { Cookie: s.cookie } })).status, 400);
    assert.equal((await fetch(`${s.server.url}/api/executions/${id}/cancel`, { method: "POST", headers: s.headers, body: "{}" })).status, 200);
    assert.equal((await fetch(`${s.server.url}/api/executions/${id}/resume`, { method: "POST", headers: s.headers, body: "{}" })).status, 200);
    const artifact = await fetch(`${s.server.url}/api/executions/${id}/artifact?path=logs/fixture.txt&offset=12`, { headers: { Cookie: s.cookie } });
    assert.equal((await artifact.json() as {text:string}).text, `${id}:logs/fixture.txt:12`);
    assert.equal((await fetch(`${s.server.url}/api/executions/${id}/artifact?path=../private.txt`, { headers: { Cookie: s.cookie } })).status, 400);
    const patch = await fetch(`${s.server.url}/api/executions/${id}/patch`, { headers: { Cookie: s.cookie } });
    assert.equal(patch.status, 200); assert.equal(patch.headers.get("content-type"), "application/octet-stream");
    assert.equal(patch.headers.get("content-disposition"), `attachment; filename="salem-${id.slice(0, 8)}.patch"`); assert.equal(patch.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await patch.arrayBuffer()), Buffer.from([0, 1, 2, 255, 10]));
    assert.equal((await fetch(`${s.server.url}/api/executions/${id}/patch`)).status, 401);
    assert.equal((await fetch(`${s.server.url}/api/executions/${id}/patch`, { method: "POST", headers: s.headers, body: "{}" })).status, 404);
    assert.equal((await fetch(`${s.server.url}/api/executions/0${id.slice(1)}/patch`, { headers: { Cookie: s.cookie } })).status, 409);
    assert.equal((await fetch(`${s.server.url}/api/accounts/unknown/check`, { method: "POST", headers: s.headers, body: "{}" })).status, 400);
    assert.deepEqual(s.calls, ["initialize","start","detail","cancel","resume","artifact","artifact","patch","patch"]);
  } finally { await s.close(); }
});
test("expired sessions cannot mutate and bootstrap issues a fresh browser session", async () => {
  const s = await fixture({ sessionTtlMs: 30 });
  try {
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal((await fetch(`${s.server.url}/api/state`, { headers: { Cookie: s.cookie } })).status, 401);
    assert.equal((await fetch(`${s.server.url}/api/settings`, { method: "PUT", headers: s.headers, body: JSON.stringify(s.bootstrap.state.settings) })).status, 401);
    const renewed = await fetch(`${s.server.url}/api/bootstrap`);
    assert.equal(renewed.status, 200); assert.notEqual((await renewed.json() as Bootstrap).csrfToken, s.bootstrap.csrfToken);
  } finally { await s.close(); }
});
test("one server owns each data directory and bind failure releases only its lock", async () => {
  const s = await fixture();
  const start = await startFunction(), otherDir = join(s.root, "other");
  try {
    await assert.rejects(start({ dataDir: s.dataDir, staticDir: s.staticDir, port: 0 }), /instancia|bloque|locked/i);
    await assert.rejects(start({ dataDir: otherDir, staticDir: s.staticDir, port: Number(new URL(s.server.url).port) }), /puerto|port|EADDRINUSE/i);
    const retry = await start({ dataDir: otherDir, staticDir: s.staticDir, port: 0 }); await retry.close();
    assert.equal((await fetch(`${s.server.url}/api/state`, { headers: { Cookie: s.cookie } })).status, 200);
  } finally { await s.close(); }
});
test("corrupt state is preserved and unknown errors return no internal contents", async () => {
  const s = await fixture();
  try {
    await writeFile(join(s.dataDir, "catalog.json"), "fixture-secret-invalid-json");
    const response = await fetch(`${s.server.url}/api/state`, { headers: { Cookie: s.cookie } });
    assert.equal(response.status, 500); assert.doesNotMatch(await response.text(), /fixture-secret|SyntaxError|stack/);
    assert.equal(await readFile(join(s.dataDir, "catalog.json"), "utf8"), "fixture-secret-invalid-json");
    await s.server.close();
    assert.ok(s.calls.includes('shutdown'),'the native execution owner must still be shut down');
    assert.equal(await readFile(join(s.dataDir, "catalog.json"), "utf8"), "fixture-secret-invalid-json",'shutdown must preserve corrupt evidence without recreating the catalog');
  } finally { await s.close(); }
});
test("project and task HTTP edits retain independent identities and optimistic revisions", async () => {
  const s = await fixture();
  try {
    const post = (path: string, value: unknown) => fetch(`${s.server.url}/api${path}`, { method: "POST", headers: s.headers, body: JSON.stringify(value) });
    const projects: ProjectRecord[] = [];
    for (const suffix of ["first", "second"]) {
      const repoRoot = join(s.dataDir, suffix); await mkdir(repoRoot); await writeFile(join(repoRoot, "AGENTS.md"), "Fixture scope only.");
      const input: ProjectInput = { name: suffix, baseRef: "HEAD", preparation: [], config: {
        schemaVersion: 1, projectId: suffix, repoRoot, contextFiles: ["AGENTS.md"],
        agents: { fixture: { provider: "codex", command: [process.execPath] } }, checks: [],
        capabilities: { edit: true, commit: false, pull_request: false, merge: false, deploy: false },
        budgets: { stageTimeoutMs: 2000, maxOutputBytes: 10000 },
        supervisor: { roles: { define: "fixture", build: "fixture", review: "fixture" }, runTimeoutMs: 20000, maxAttempts: 3 },
      } };
      assert.equal((await post("/projects/validate", { config: input.config })).status, 200);
      const response = await post("/projects", input); assert.equal(response.status, 200);
      projects.push(await response.json() as ProjectRecord);
    }
    const tasks: TaskRecord[] = [];
    for (const project of projects) {
      const response = await post("/tasks", { projectId: project.id, spec: { id: "T-1", objective: project.name, scope: ["Fixture"], acceptance: ["Done"], references: [] } });
      assert.equal(response.status, 200); tasks.push(await response.json() as TaskRecord);
    }
    assert.notEqual(tasks[0]!.id, tasks[1]!.id); assert.notEqual(tasks[0]!.projectId, tasks[1]!.projectId);
    assert.equal((await post("/projects", { ...projects[0]!, name: "Changed" })).status, 200);
    assert.equal((await post("/projects", { ...projects[0]!, name: "Stale" })).status, 409);
    assert.equal((await s.store.readState()).projects.find(project => project.id === projects[1]!.id)!.name, "second");
    assert.deepEqual(s.calls, ["initialize"]);
  } finally { await s.close(); }
});
async function inputForValidation(dataDir: string): Promise<ProjectInput> {
  const repoRoot = join(dataDir, "validation-fixture");
  await mkdir(repoRoot); await writeFile(join(repoRoot, "AGENTS.md"), "Only private HTTP validation fixtures.");
  return { name: "Validation fixture", baseRef: "HEAD", preparation: [], config: {
    schemaVersion: 1, projectId: "validation-fixture", repoRoot, contextFiles: ["AGENTS.md"],
    agents: { fixture: { provider: "codex", command: [process.execPath] } }, checks: [],
    capabilities: { edit: true, commit: false, pull_request: false, merge: false, deploy: false },
    budgets: { stageTimeoutMs: 2000, maxOutputBytes: 10000 },
    supervisor: { roles: { define: "fixture", build: "fixture", review: "fixture" }, runTimeoutMs: 20000, maxAttempts: 3 },
  } };
}
test("invalid project budget returns actionable HTTP 400 during validation and saving", async () => {
  const s = await fixture();
  try {
    const project = await inputForValidation(s.dataDir);
    project.config.budgets.stageTimeoutMs = 0;
    for (const [path, input] of [["/projects/validate", { config: project.config }], ["/projects", project]] as const) {
      const response = await fetch(`${s.server.url}/api${path}`, { method: "POST", headers: s.headers, body: JSON.stringify(input) });
      assert.equal(response.status, 400, `${path} must treat invalid budgets as user input`);
      const error = await response.json() as {error: string}; assert.match(error.error, /stageTimeout|presupuesto|budget/i);
    }
    assert.equal((await s.store.readState()).projects.length, 0);
  } finally { await s.close(); }
});
test("invalid task acceptance and unknown spec fields return actionable HTTP 400", async () => {
  const s = await fixture();
  try {
    const project = await s.store.saveProject(await inputForValidation(s.dataDir));
    const spec = { id: "INVALID-TASK", objective: "Fixture", scope: ["Private fixture"], acceptance: ["Verified"], references: [] };
    const responses: {status: number; error: string}[] = [];
    for (const invalid of [{ ...spec, acceptance: [] }, { ...spec, unknownField: "not allowed" }]) {
      const response = await fetch(`${s.server.url}/api/tasks`, { method: "POST", headers: s.headers, body: JSON.stringify({ projectId: project.id, spec: invalid }) });
      responses.push({ status: response.status, error: (await response.json() as {error: string}).error });
    }
    assert.deepEqual(responses.map(response => response.status), [400, 400]);
    for (const response of responses) assert.match(response.error, /acceptance|task|tarea|campo|criterio/i);
    assert.equal((await s.store.readState()).tasks.length, 0);
  } finally { await s.close(); }
});
test("real execution manager blocks the provider reserved by a delayed logout and admits it after cleanup", async () => {
  const s = await fixture({ realManager: true });
  const gate = join(s.dataDir, "release-fixture-logout");
  let logout: Promise<Response> | undefined;
  try {
    const codexFile = join(s.dataDir, "codex-account.json"), claudeFile = join(s.dataDir, "claude-account.json");
    await writeFile(codexFile, JSON.stringify({ authenticated: true, logoutGate: gate }));
    await writeFile(claudeFile, JSON.stringify({ authenticated: true }));
    const command = (provider: "codex" | "claude", file: string) => [process.execPath, join(process.cwd(), "tests", "fixtures", "local-auth.mjs"), "--state", file, "--provider", provider];
    const state = await s.store.readState();
    await s.store.saveSettings({ ...state.settings, commands: { codex: command("codex", codexFile), claude: command("claude", claudeFile) } });
    const base = await inputForValidation(s.dataDir);
    const tasks: Record<string, string> = {};
    for (const provider of ["codex", "claude"] as const) {
      const project = await s.store.saveProject({ ...base, name: provider, config: { ...base.config, projectId: `logout-${provider}`, agents: { fixture: { provider, command: command(provider, provider === "codex" ? codexFile : claudeFile) } } } });
      const task = await s.store.saveTask({ projectId: project.id, spec: { id: "T-LOGOUT", objective: "Fixture only", scope: ["Fixture only"], acceptance: ["Private fixtures"], references: [] } });
      tasks[provider] = task.id;
    }
    await s.accounts.check("codex");
    logout = fetch(`${s.server.url}/api/accounts/codex/disconnect`, { method: "POST", headers: s.headers, body: "{}" });
    const deadline = Date.now() + 5000;
    let started = false;
    while (!started && Date.now() < deadline) {
      try { await readFile(`${codexFile}.logout-pid`); started = true; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    assert.equal(started, true, "native logout is held at a private fixture gate");
    assert.equal(s.accounts.list().find(account => account.provider === "codex")!.connection, "connected");
    const start = (provider: "codex" | "claude") => fetch(`${s.server.url}/api/executions`, { method: "POST", headers: s.headers, body: JSON.stringify({ taskId: tasks[provider], requestKey: randomUUID() }) });
    const blocked = await start("codex");
    assert.equal(blocked.status, 409, "the operational logout reservation must block a new execution");
    assert.equal((await s.store.readState()).executions.length, 0);
    const other = await start("claude"); assert.equal(other.status, 200);
    await s.server.manager!.cancel((await other.json() as {id: string}).id);
    await writeFile(gate, "release");
    assert.equal((await logout).status, 200);
    assert.equal(s.accounts.isMutating("codex"), false);
    const allowed = await start("codex"); assert.equal(allowed.status, 200);
    await s.server.manager!.cancel((await allowed.json() as {id: string}).id);
  } finally { await writeFile(gate, "release"); await logout?.catch(() => {}); await s.close(); }
});
test("Git branches are read only from the canonical repository root", async () => {
  const s = await fixture();
  try {
    const repo = join(s.dataDir, "repo"); await mkdir(repo); await mkdir(join(repo, "nested"));
    const git = (args: string[]) => runProcess({ command: ["git", ...args], cwd: repo, timeoutMs: 10000, maxOutputBytes: 20000 });
    assert.equal((await git(["init", "-b", "main"])).exitCode, 0);
    await writeFile(join(repo, "fixture.txt"), "Local fixture only.");
    assert.equal((await git(["add", "fixture.txt"])).exitCode, 0);
    assert.equal((await git(["-c", "user.name=Salem fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Fixture"])).exitCode, 0);
    const before = (await git(["rev-parse", "HEAD"])).stdout.trim();
    const response = await fetch(`${s.server.url}/api/projects/branches`, { method: "POST", headers: s.headers, body: JSON.stringify({ repoRoot: repo }) });
    assert.equal(response.status, 200);
    const data = await response.json() as {branches: string[]; head: string}; assert.deepEqual(data.branches, ["main"]); assert.equal(data.head, before);
    assert.equal((await fetch(`${s.server.url}/api/projects/branches`, { method: "POST", headers: s.headers, body: JSON.stringify({ repoRoot: join(repo, "nested") }) })).status, 400);
    assert.equal((await git(["status", "--porcelain"])).stdout, "");
    assert.equal((await git(["rev-parse", "HEAD"])).stdout.trim(), before);
  } finally { await s.close(); }
});
test("HTTP account actions use only private native fixtures and expose no raw authentication output", async () => {
  const s = await fixture();
  try {
    const accountFile = join(s.dataDir, "fixture-account.json"); await writeFile(accountFile, JSON.stringify({ authenticated: false }));
    const current = await s.store.readState();
    await s.store.saveSettings({ ...current.settings, commands: { ...current.settings.commands, codex: [process.execPath, join(process.cwd(), "tests", "fixtures", "local-auth.mjs"), "--state", accountFile, "--provider", "codex"] } });
    const post = (action: string, value: unknown = {}) => fetch(`${s.server.url}/api/accounts/codex/${action}`, { method: "POST", headers: s.headers, body: JSON.stringify(value) });
    const checked = await post("check"); assert.equal(checked.status, 200); assert.equal((await checked.json() as {authenticated: boolean}).authenticated, false);
    assert.equal((await post("connect", { method: "device" })).status, 200);
    const deadline = Date.now() + 5000;
    while (!s.accounts.list().find(account => account.provider === "codex")!.userCode && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    const pending = await fetch(`${s.server.url}/api/state`, { headers: { Cookie: s.cookie } });
    const pendingText = await pending.text(); assert.match(pendingText, /ABCD-EFGH/); assert.doesNotMatch(pendingText, /private-access-token/);
    assert.equal((await post("input", { text: "fixture-return-code" })).status, 200);
    const healthDeadline = Date.now() + 5000;
    while (s.accounts.list().find(account => account.provider === "codex")!.connection === "connecting" && Date.now() < healthDeadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(s.accounts.list().find(account => account.provider === "codex")!.authenticated, true);
    assert.equal((await post("disconnect")).status, 200);
    assert.equal(s.accounts.list().find(account => account.provider === "codex")!.authenticated, false);
  } finally { await s.close(); }
});
