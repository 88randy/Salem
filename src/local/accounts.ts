import { inspectAgent, type AgentHealth } from "../doctor.js";
import { runProcess } from "../process.js";
import type { AccountView, LocalState, Provider } from "./contracts.js";
import { startAuthProcess, type AuthProcess } from "./auth-process.js";

interface Operation {
  kind: "login" | "logout"; controller: AbortController;
  done: Promise<void>; finish: () => void; process?: AuthProcess;
}
const officialHosts = new Set(["auth.openai.com", "claude.ai", "console.anthropic.com", "platform.claude.com", "auth.anthropic.com"]);
const initial = (provider: Provider): AccountView => ({
  provider, installed: false, compatible: false, authenticated: null, version: null, error: null,
  connection: "idle", loginUrl: null, userCode: null, needsInput: false,
});
function requestError(message: string, status = 400): Error { return Object.assign(new Error(message), { status }); }
function validProvider(provider: Provider): void {
  if (provider !== "claude" && provider !== "codex") throw requestError("Proveedor desconocido");
}
function loginUrl(text: string): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      const candidate = match[0].replace(/[),.;]+$/, "");
      const url = new URL(candidate);
      if (url.protocol !== "https:" || !officialHosts.has(url.hostname) || url.username || url.password || url.port || url.hash) continue;
      if ([...url.searchParams].some(([key, value]) => {
        // Claude's authorize link uses code=true to select its return-code UI.
        if (/^code$/i.test(key)) return !(url.hostname === "claude.ai" && url.pathname === "/oauth/authorize" && value === "true");
        return /^(?:access_token|refresh_token|id_token|token|api_key|password|secret)$/i.test(key);
      })) continue;
      return url.href;
    } catch { /* Untrusted CLI text is never treated as a navigation instruction. */ }
  }
  return null;
}
function plain(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\r/g, "\n");
}

export class AccountManager {
  private readonly cache: Record<Provider, AccountView> = { claude: initial("claude"), codex: initial("codex") };
  private readonly operations = new Map<Provider, Operation>();
  private readonly epochs: Record<Provider, number> = { claude: 0, codex: 0 };
  private readonly checks = new Map<AbortController, Promise<void>>();
  private closed = false;
  private readonly cwd: string;
  private readonly timeoutMs: number;
  constructor(
    private readonly store: { readState(): Promise<LocalState> },
    private readonly options: { isBusy?: (provider: Provider) => boolean; cwd?: string; timeoutMs?: number } = {},
  ) {
    this.cwd = options.cwd ?? process.cwd();
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0) throw requestError("Tiempo de conexión inválido");
  }
  list(): AccountView[] { return [this.view("claude"), this.view("codex")]; }
  isMutating(provider: Provider): boolean { validProvider(provider); return this.operations.has(provider); }
  private view(provider: Provider): AccountView { return { ...this.cache[provider] }; }
  private ensureOpen(provider: Provider): void {
    validProvider(provider);
    if (this.closed) throw requestError("El gestor de cuentas está cerrado", 409);
  }
  private mutation(provider: Provider): void {
    this.ensureOpen(provider);
    if (this.options.isBusy?.(provider)) throw requestError("No se puede cambiar esta cuenta durante una ejecución del proveedor", 409);
  }
  private clearEphemeral(provider: Provider): void { Object.assign(this.cache[provider], { loginUrl: null, userCode: null, needsInput: false }); }
  private reserve(provider: Provider, kind: Operation["kind"]): Operation {
    if (this.operations.has(provider)) throw requestError("Ya hay una operación de cuenta activa", 409);
    let finish!: () => void;
    const operation: Operation = { kind, controller: new AbortController(), done: new Promise(resolve => { finish = resolve; }), finish: () => finish() };
    this.operations.set(provider, operation); this.epochs[provider]++;
    return operation;
  }
  private release(provider: Provider, operation: Operation): void {
    if (this.operations.get(provider) === operation) this.operations.delete(provider);
    operation.finish();
  }
  private async command(provider: Provider): Promise<string[]> {
    const command = (await this.store.readState()).settings.commands[provider];
    if (!Array.isArray(command) || command.length === 0 || command.some(part => typeof part !== "string" || !part.length)) throw requestError("Comando del proveedor inválido");
    return [...command];
  }
  private async health(provider: Provider, command: string[], signal: AbortSignal): Promise<AgentHealth> {
    const health = await inspectAgent({ provider, command }, this.cwd, { signal, timeoutMs: Math.min(this.timeoutMs, 45000), maxOutputBytes: 100000 });
    // CLI errors can contain raw output or local filenames; expose only fixed text.
    return { ...health, error: health.error ? (!health.installed ? "No se encontró un CLI ejecutable del proveedor" : !health.compatible ? "CLI incompatible con Salem" : health.authenticated === false ? "Se requiere iniciar sesión" : "No se pudo comprobar la sesión del CLI") : null };
  }
  async check(provider: Provider): Promise<AccountView> {
    this.ensureOpen(provider);
    if (this.operations.has(provider)) return this.view(provider);
    const epoch = this.epochs[provider], controller = new AbortController();
    let finish!: () => void;
    this.checks.set(controller, new Promise(resolve => { finish = resolve; }));
    try {
      const health = await this.health(provider, await this.command(provider), controller.signal);
      if (this.epochs[provider] === epoch && !this.closed) {
        Object.assign(this.cache[provider], health, { connection: health.authenticated === true ? "connected" : "idle" });
        this.clearEphemeral(provider);
      }
      return this.view(provider);
    } finally { this.checks.delete(controller); finish(); }
  }
  async connect(provider: Provider, method: "browser" | "device" = "browser"): Promise<AccountView> {
    this.mutation(provider);
    if (method !== "browser" && method !== "device") throw requestError("Método de conexión desconocido");
    if (provider === "claude" && method === "device") throw requestError("El flujo de dispositivo solo está disponible para Codex");
    const existing = this.operations.get(provider);
    if (existing?.kind === "login") return this.view(provider);
    const operation = this.reserve(provider, "login");
    Object.assign(this.cache[provider], { connection: "connecting", error: null }); this.clearEphemeral(provider);
    try {
      const command = await this.command(provider);
      const health = await this.health(provider, command, operation.controller.signal);
      if (operation.controller.signal.aborted) { this.cancelled(provider); return this.view(provider); }
      Object.assign(this.cache[provider], health);
      if (health.authenticated === true) { this.cache[provider].connection = "connected"; return this.view(provider); }
      if (!health.installed || !health.compatible) { this.cache[provider].connection = "failed"; return this.view(provider); }
      const args = provider === "claude" ? ["auth", "login", "--claudeai"] : ["login", ...(method === "device" ? ["--device-auth"] : [])];
      let output = "";
      operation.process = await startAuthProcess({
        command: [...command, ...args], cwd: this.cwd, timeoutMs: this.timeoutMs, signal: operation.controller.signal,
        onOutput: text => {
          if (operation.controller.signal.aborted || this.operations.get(provider) !== operation) return;
          output = plain(`${output}${text}`).slice(-8192);
          const view = this.cache[provider];
          view.loginUrl = loginUrl(output);
          if (method === "device" && /(?:one.time|device|verification|user)[\s\S]{0,100}code/i.test(output)) view.userCode = output.match(/\b[A-Z0-9]{4,5}-[A-Z0-9]{4,5}\b/)?.[0] ?? null;
          view.needsInput = /paste[^\n]{0,100}code|(?:authorization|authentication|return)\s+code[^\n]{0,40}(?:here|:)|enter[^\n]{0,60}(?:authorization|authentication|return)[^\n]{0,30}code/i.test(output);
        },
      });
      void this.completeLogin(provider, operation, command);
      return this.view(provider);
    } catch {
      if (operation.controller.signal.aborted) this.cancelled(provider);
      else { this.cache[provider].connection = "failed"; this.cache[provider].error = "No se pudo iniciar la conexión con el CLI"; this.clearEphemeral(provider); }
      return this.view(provider);
    } finally { if (!operation.process) this.release(provider, operation); }
  }
  private cancelled(provider: Provider): void {
    Object.assign(this.cache[provider], { connection: "cancelled", error: null }); this.clearEphemeral(provider);
  }
  private async completeLogin(provider: Provider, operation: Operation, command: string[]): Promise<void> {
    try {
      const result = await operation.process!.done;
      this.clearEphemeral(provider);
      if (operation.controller.signal.aborted || result.status === "cancelled") { this.cancelled(provider); return; }
      if (result.status !== "exited" || result.exitCode !== 0) {
        Object.assign(this.cache[provider], { connection: "failed", authenticated: false, error: result.status === "timed_out" ? "Se agotó el tiempo de conexión" : "El CLI no completó el inicio de sesión" });
        return;
      }
      const health = await this.health(provider, command, operation.controller.signal);
      if (operation.controller.signal.aborted) { this.cancelled(provider); return; }
      Object.assign(this.cache[provider], health, { connection: health.authenticated === true ? "connected" : "failed" });
    } catch {
      Object.assign(this.cache[provider], { connection: "failed", authenticated: null, error: "No se pudo verificar el inicio de sesión" });
    } finally { this.clearEphemeral(provider); this.release(provider, operation); }
  }
  async cancel(provider: Provider): Promise<AccountView> {
    this.mutation(provider);
    const operation = this.operations.get(provider);
    if (operation?.kind === "logout") throw requestError("La desconexión está en curso", 409);
    if (operation) { operation.controller.abort(); this.cancelled(provider); await operation.done; }
    return this.view(provider);
  }
  async input(provider: Provider, text: string): Promise<AccountView> {
    this.mutation(provider);
    const operation = this.operations.get(provider);
    if (operation?.kind !== "login" || !operation.process || !this.cache[provider].needsInput) throw requestError("No hay una conexión activa solicitando un código", 409);
    if (typeof text !== "string" || !text.trim() || text.length > 4096 || /[\x00-\x1f\x7f]/.test(text)) throw requestError("Código de retorno inválido");
    await operation.process.input(text.trim());
    this.cache[provider].needsInput = false;
    return this.view(provider);
  }
  async disconnect(provider: Provider): Promise<AccountView> {
    this.mutation(provider);
    const operation = this.reserve(provider, "logout"); this.clearEphemeral(provider);
    try {
      const command = await this.command(provider);
      const result = await runProcess({ command: [...command, ...(provider === "claude" ? ["auth", "logout"] : ["logout"])], cwd: this.cwd, timeoutMs: Math.min(this.timeoutMs, 15000), maxOutputBytes: 100000, signal: operation.controller.signal });
      if (result.status !== "exited" || result.exitCode !== 0) {
        Object.assign(this.cache[provider], { connection: "failed", error: "El CLI no completó la desconexión" });
        return this.view(provider);
      }
      const health = await this.health(provider, command, operation.controller.signal);
      Object.assign(this.cache[provider], health, { connection: health.authenticated === true ? "failed" : "idle", error: health.authenticated === true ? "El CLI conserva una sesión activa" : health.authenticated === false ? null : health.error });
      return this.view(provider);
    } catch {
      Object.assign(this.cache[provider], { connection: "failed", error: "No se pudo desconectar la cuenta" }); return this.view(provider);
    } finally { this.clearEphemeral(provider); this.release(provider, operation); }
  }
  async close(): Promise<void> {
    this.closed = true;
    const checks = [...this.checks.values()];
    for (const controller of this.checks.keys()) controller.abort();
    const operations = [...this.operations.values()];
    for (const [provider, operation] of this.operations) {
      operation.controller.abort();
      if (operation.kind === "login") this.cancelled(provider);
    }
    await Promise.all([...checks, ...operations.map(operation => operation.done)]);
  }
}
