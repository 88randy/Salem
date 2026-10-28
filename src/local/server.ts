import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, realpath, stat, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { acquireLock } from "../state-store.js";
import { isInside, parseProjectConfig } from "../config.js";
import { redact, runProcess } from "../process.js";
import { AccountManager } from "./accounts.js";
import { LocalStore } from "./store.js";
import { browseDirectories } from "./filesystem.js";
import { GoalManager } from "./goals.js";
import {ConversationManager} from './conversations.js';
import type {ExecutionManager} from './executions.js';
import { EvolutionManager } from './evolution.js';
import { discoverProject } from "./discovery.js";
import { localError, localText, record, uuid } from "./validation.js";
import type { LocalSettings, ProjectInput, Provider, TaskInput } from "./contracts.js";

export interface LocalExecutionManager extends Partial<Pick<ExecutionManager,'acceptedBase'|'startManaged'|'isActive'|'checkpoint'|'resumeManaged'>> {
  initialize(): Promise<void>;
  start(taskId: string, requestKey: string, baseExecutionId?: string): Promise<unknown>;
  cancel(id: string): Promise<unknown>; resume(id: string): Promise<unknown>;
  detail(id: string): Promise<unknown>; artifact(id: string, path: string, offset: number): Promise<unknown>;
  isBusy(provider: Provider): boolean; shutdown(): Promise<void>;
  activeCount?(): number;
  wake?():void;
}
export interface LocalServerOptions {
  dataDir: string; port: number; staticDir: string;
  store?: LocalStore; manager?: LocalExecutionManager; accounts?: AccountManager;
  sessionTtlMs?: number;
  directoryRoots?: string[];
}
const BODY_LIMIT = 1024 * 1024;
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" };
function equal(a: string | undefined, b: string): boolean {
  if (typeof a !== "string") return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function cookie(request: IncomingMessage, name: string): string | undefined {
  const cookies = (request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return cookies.length === 1 ? cookies[0]!.slice(name.length + 1) : undefined;
}
function headers(response: ServerResponse): void {
  response.setHeader("Content-Security-Policy", CSP);
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cache-Control", "no-store");
}
function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status; response.setHeader("Content-Type", "application/json; charset=utf-8"); response.end(JSON.stringify(value));
}
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) throw localError("La solicitud requiere Content-Type application/json.", 415);
  const length = request.headers["content-length"];
  if (length && (!/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) { request.resume(); throw localError("La solicitud excede 1 MiB.", 413); }
  const text = await new Promise<string>((resolveBody, reject) => {
    let bytes = 0, settled = false; const chunks: Buffer[] = [];
    const fail = (error: Error) => { if (settled) return; settled = true; reject(error); };
    request.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) { fail(localError("La solicitud excede 1 MiB.", 413)); return; }
      if (!settled) chunks.push(chunk);
    });
    request.once("end", () => { if (!settled) { settled = true; resolveBody(Buffer.concat(chunks).toString("utf8")); } });
    request.once("error", () => fail(localError("No se pudo leer la solicitud.")));
    request.once("aborted", () => fail(localError("La solicitud fue interrumpida.")));
  });
  try { return record(JSON.parse(text)); } catch { throw localError("El cuerpo debe ser un objeto JSON válido."); }
}
function provider(value: string): Provider {
  if (value !== "codex" && value !== "claude") throw localError("Proveedor desconocido."); return value;
}
async function branches(input: unknown): Promise<{branches: string[]; head: string}> {
  const supplied = localText(input, "carpeta del repositorio", 8192);
  let root: string;
  try { root = await realpath(resolve(supplied)); if (!(await stat(root)).isDirectory()) throw new Error(); }
  catch { throw localError("La carpeta del repositorio no existe."); }
  const git = (args: string[]) => runProcess({ command: ["git", "-c", "core.fsmonitor=false", "--no-pager", ...args], cwd: root, timeoutMs: 10000, maxOutputBytes: BODY_LIMIT });
  const top = await git(["rev-parse", "--show-toplevel"]);
  if (top.status !== "exited" || top.exitCode !== 0) throw localError("La carpeta no es un repositorio Git de trabajo.");
  let canonical: string;
  try { canonical = await realpath(top.stdout.trim()); } catch { throw localError("No se pudo verificar la raíz Git."); }
  if (canonical !== root) throw localError("Selecciona la raíz del repositorio Git, no una subcarpeta.");
  const [refs, head] = await Promise.all([git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]), git(["rev-parse", "--verify", "HEAD"])]);
  if (refs.status !== "exited" || refs.exitCode !== 0 || head.status !== "exited" || head.exitCode !== 0) throw localError("No se pudieron consultar las ramas o HEAD de Git.");
  return { branches: refs.stdout.split(/\r?\n/).filter(Boolean), head: head.stdout.trim() };
}

export async function startLocalServer(options: LocalServerOptions) {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65535) throw localError("Puerto inválido.");
  const ttl = options.sessionTtlMs ?? 12 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(ttl) || ttl < 1) throw localError("Duración de sesión inválida.");
  await mkdir(resolve(options.dataDir), { recursive: true });
  const dataDir = await realpath(options.dataDir), staticDir = await realpath(options.staticDir);
  const release = await acquireLock(join(dataDir, "server.lock"), randomUUID());
  const store = options.store ?? new LocalStore(dataDir);
  let manager: LocalExecutionManager | undefined, accounts: AccountManager | undefined, goals: GoalManager | undefined, evolution: EvolutionManager | undefined,conversations:ConversationManager|undefined;
  let closing = false, initialized=false, closePromise: Promise<void> | undefined;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  let url = "";
  const server = createServer((request, response) => {
    headers(response);
    void handle(request, response).catch(error => {
      if (response.headersSent) { response.end(); return; }
      const supplied = (error as {status?: unknown}).status;
      const status = typeof supplied === "number" && Number.isInteger(supplied) && supplied >= 400 && supplied <= 599 ? supplied : 500;
      if (status === 413) response.setHeader("Connection", "close");
      json(response, status, { error: status < 500 ? redact(error instanceof Error ? error.message : "Solicitud inválida.") : "No se pudo completar la operación. Los datos existentes se conservan." });
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (closing) throw localError("Salem se está cerrando.", 503);
    const expectedHost = new URL(url).host;
    // Cookies are shared across ports by browsers. Keep local instances separate.
    const cookieName = `salem_session_${new URL(url).port}`;
    if (request.headers.host !== expectedHost || request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "host").length !== 1) throw localError("Host no permitido.", 403);
    const origin = request.headers.origin;
    if ((origin !== undefined && origin !== url) || request.headers["sec-fetch-site"] === "cross-site") throw localError("Origin no permitido.", 403);
    const method = request.method ?? "";
    if (!["GET", "POST", "PUT"].includes(method)) throw localError("Método no permitido.", 405);
    const rawPath = (request.url ?? "/").split("?")[0]!;
    let path: string;
    try { path = decodeURIComponent(rawPath); } catch { throw localError("Ruta inválida."); }
    if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".")) throw localError("Ruta no permitida.", 403);
    const parsed = new URL(request.url ?? "/", url);
    if (path === "/api/bootstrap") {
      if (method !== "GET") throw localError("Método no permitido.", 405);
      const now = Date.now();
      for (const [id, entry] of sessions) if (entry.expires <= now) sessions.delete(id);
      let id = cookie(request,cookieName), session = id ? sessions.get(id) : undefined;
      if (!session) {
        if (sessions.size >= 100) throw localError("Demasiadas sesiones locales. Cierra pestañas y vuelve a intentarlo.", 429);
        id = randomBytes(32).toString("base64url"); session = { csrf: randomBytes(32).toString("base64url"), expires: now + ttl }; sessions.set(id, session);
      }
      response.setHeader("Set-Cookie", `${cookieName}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(1, Math.floor(ttl / 1000))}`);
      json(response, 200, { csrfToken: session.csrf, state: await store.readState(), accounts: accounts!.list(), dataDir }); return;
    }
    if (path === "/api" || path.startsWith("/api/")) {
      const id = cookie(request,cookieName), session = id ? sessions.get(id) : undefined;
      if (!session || session.expires <= Date.now()) { if (id) sessions.delete(id); throw localError("La sesión local expiró. Recarga Salem.", 401); }
      if (method !== "GET" && (origin !== url || !equal(typeof request.headers["x-salem-csrf"] === "string" ? request.headers["x-salem-csrf"] : undefined, session.csrf))) throw localError("La solicitud requiere Origin y token CSRF de Salem.", 403);
      if (method === "GET") {
        const conversationRoute=path.match(/^\/api\/conversations\/([^/]+)$/);
        if(conversationRoute){json(response,200,await store.findConversation(uuid(conversationRoute[1])));return;}
        if(path==='/api/conversations'||/^\/api\/conversations\/[^/]+\/(?:message|pause|continue|retry)$/.test(path))throw localError('Esta acción requiere un método de mutación.',405);
        if (path === "/api/state") { json(response, 200, { state: await store.readState(), accounts: accounts!.list(), dataDir }); return; }
        if(path==='/api/evolution/incidents'){json(response,200,await evolution!.incidents());return;}
        const evolutionRoute=path.match(/^\/api\/evolution\/([^/]+)(?:\/(artifact))?$/);
        if(evolutionRoute){const id=uuid(evolutionRoute[1]);if(evolutionRoute[2]){const offset=parsed.searchParams.get('offset')??'0';if(!/^\d+$/.test(offset)||!Number.isSafeInteger(Number(offset)))throw localError('Offset inválido.');json(response,200,await evolution!.artifact(id,localText(parsed.searchParams.get('path'),'ruta del artefacto',8192),Number(offset)));}else json(response,200,await evolution!.detail(id));return;}
        if(path==='/api/evolution'||path==='/api/projects/evolution-demo'||/^\/api\/evolution\/[^/]+\/(?:cancel|apply|rollback)$/.test(path))throw localError('Esta acción requiere un método de mutación.',405);
        const goalRoute=path.match(/^\/api\/goals\/([^/]+)(?:\/(artifact))?$/);
        if(goalRoute){const id=uuid(goalRoute[1]);
          if(goalRoute[2]){const offset=parsed.searchParams.get("offset")??"0";if(!/^\d+$/.test(offset)||!Number.isSafeInteger(Number(offset)))throw localError("Offset de artefacto inválido.");json(response,200,await goals!.artifact(id,localText(parsed.searchParams.get("path"),"ruta del artefacto",8192),Number(offset)));}
          else json(response,200,await store.findGoal(id));return;
        }
        if(["/api/projects/discover","/api/goals"].includes(path)||/^\/api\/goals\/[^/]+\/(?:cancel|retry|answer|materialize)$/.test(path))throw localError("Esta acción requiere un método de mutación.",405);
        if (path === "/api/filesystem/directories") {
          const state = await store.readState();
          json(response, 200, await browseDirectories(parsed.searchParams.get("path") ?? "", options.directoryRoots ?? [homedir(), dataDir, ...state.projects.map(project => project.config.repoRoot)])); return;
        }
        const execution = path.match(/^\/api\/executions\/([^/]+)(?:\/(artifact))?$/);
        if (execution) {
          const id = uuid(execution[1]);
          if (execution[2]) {
            const offsetText = parsed.searchParams.get("offset") ?? "0";
            if (!/^\d+$/.test(offsetText) || !Number.isSafeInteger(Number(offsetText))) throw localError("Offset de artefacto inválido.");
            json(response, 200, await manager!.artifact(id, localText(parsed.searchParams.get("path"), "ruta del artefacto", 8192), Number(offsetText))); return;
          }
          json(response, 200, await manager!.detail(id)); return;
        }
        if (/^\/api\/accounts\/[^/]+\/(?:check|connect|cancel|disconnect|input)$/.test(path) || ["/api/settings", "/api/projects", "/api/tasks", "/api/executions", "/api/projects/demo", "/api/projects/demo/plan", "/api/projects/validate", "/api/projects/branches"].includes(path) || /^\/api\/executions\/[^/]+\/(?:cancel|resume)$/.test(path)) throw localError("Esta acción requiere un método de mutación.", 405);
        throw localError("Ruta de API no encontrada.", 404);
      }
      const input = await body(request);
      if (path === "/api/settings") {
        if (method !== "PUT") throw localError("Método no permitido.", 405);
        json(response, 200, await store.saveSettings(input as unknown as LocalSettings)); return;
      }
      if (method !== "POST") throw localError("Método no permitido.", 405);
      if(path==='/api/conversations'){json(response,200,await conversations!.start(input));return;}
      const chatAction=path.match(/^\/api\/conversations\/([^/]+)\/(message|pause|continue|retry)$/);
      if(chatAction){json(response,200,await conversations!.command(uuid(chatAction[1]),chatAction[2]!,input));return;}
      if(path==='/api/projects/evolution-demo'){record(input,[]);json(response,200,await (await import('./evolution-demo.js')).createEvolutionDemo(store));return;}
      if(path==='/api/evolution'){json(response,200,await evolution!.start(input as unknown as import('./evolution-contracts.js').EvolutionRequest));return;}
      const evolutionCancel=path.match(/^\/api\/evolution\/([^/]+)\/cancel$/);if(evolutionCancel){record(input,[]);json(response,200,await evolution!.cancel(uuid(evolutionCancel[1])));return;}
      const promotionAction=path.match(/^\/api\/evolution\/([^/]+)\/(apply|rollback)$/);if(promotionAction){record(input,['revision']);if(typeof input.revision!=='number'||!Number.isSafeInteger(input.revision)||input.revision<1)throw localError('Revisión de experimento inválida.');const id=uuid(promotionAction[1]);json(response,200,promotionAction[2]==='apply'?await evolution!.apply(id,input.revision):await evolution!.rollback(id,input.revision));return;}
      if(path==="/api/projects/discover"){record(input,["repoRoot","provider"]);json(response,200,await discoverProject(localText(input.repoRoot,"carpeta del repositorio",8192),(await store.readState()).settings,(input.provider===undefined?"codex":provider(localText(input.provider,"proveedor",20))),dataDir));return;}
      if(path==="/api/goals"){json(response,200,await goals!.start(input as unknown as import("./research-contracts.js").GoalRequest));return;}
      const goalAction=path.match(/^\/api\/goals\/([^/]+)\/(cancel|retry|answer|materialize)$/);
      if(goalAction){const id=uuid(goalAction[1]),action=goalAction[2];
        if(action==="cancel"){record(input,[]);json(response,200,await goals!.cancel(id));return;}
        record(input,action==="answer"?["revision","text"]:["revision"]);
        if(typeof input.revision!=="number"||!Number.isSafeInteger(input.revision)||input.revision<1)throw localError("Revisión del objetivo inválida.");
        json(response,200,action==="retry"?await goals!.retry(id,input.revision):action==="answer"?await goals!.answer(id,input.revision,localText(input.text,"respuesta",20000)):await goals!.materialize(id,input.revision));return;
      }
      if (path === "/api/projects") { json(response, 200, await store.saveProject(input as unknown as ProjectInput)); return; }
      if (path === "/api/tasks") { json(response, 200, await store.saveTask(input as unknown as TaskInput)); return; }
      if (path === "/api/projects/demo/plan") {
        record(input, ["provider"]); const selected = input.provider === undefined ? undefined : provider(localText(input.provider, "proveedor", 20));
        // Readiness comes from fresh CLI status probes; they never run inference.
        await Promise.all((["claude", "codex"] as const).map(p => accounts!.check(p)));
        json(response, 200, (await import("./demo.js")).planLocalDemo(accounts!.list(), (await store.readState()).settings, selected)); return;
      }
      if (path === "/api/projects/demo") {
        record(input, ["provider", "roles"]); const selected = input.provider === undefined ? undefined : provider(localText(input.provider, "proveedor", 20));
        if (input.roles === undefined) throw localError("Confirma el aviso de consumo antes de crear la demo.");
        const demo = await import("./demo.js"), plan = demo.planLocalDemo(accounts!.list(), (await store.readState()).settings, selected);
        if (!demo.sameRoles(plan.roles, input.roles)) throw localError("La disponibilidad de las cuentas cambió. Revisa de nuevo el aviso de consumo.", 412);
        json(response, 200, await demo.createLocalDemo(store, plan.roles)); return;
      }
      if (path === "/api/projects/validate") {
        try { json(response, 200, await parseProjectConfig(input.config)); }
        catch (error) { throw localError(redact(error instanceof Error ? error.message : "Configuración inválida.")); } return;
      }
      if (path === "/api/projects/branches") { json(response, 200, await branches(input.repoRoot)); return; }
      if (path === "/api/executions") {
        const taskId = uuid(input.taskId), key = localText(input.requestKey, "clave de solicitud", 200);
        const baseId = input.baseExecutionId === undefined ? undefined : uuid(input.baseExecutionId);
        json(response, 200, await manager!.start(taskId, key, baseId)); return;
      }
      const execution = path.match(/^\/api\/executions\/([^/]+)\/(cancel|resume)$/);
      if (execution) { const id = uuid(execution[1]); json(response, 200, execution[2] === "cancel" ? await manager!.cancel(id) : await manager!.resume(id)); return; }
      const auth = path.match(/^\/api\/accounts\/([^/]+)\/(check|connect|cancel|disconnect|input)$/);
      if (auth) {
        const agent = provider(auth[1]!); let result: unknown;
        switch (auth[2]) {
          case "check": result = await accounts!.check(agent); break;
          case "connect": {
            if (input.method !== undefined && input.method !== "browser" && input.method !== "device") throw localError("Método de conexión inválido.");
            result = await accounts!.connect(agent, input.method as "browser" | "device" | undefined); break;
          }
          case "cancel": result = await accounts!.cancel(agent); break;
          case "disconnect": result = await accounts!.disconnect(agent); break;
          case "input": result = await accounts!.input(agent, localText(input.text, "código de retorno", 4096)); break;
        }
        json(response, 200, result); return;
      }
      if (path === "/api/state") throw localError("Método no permitido.", 405);
      throw localError("Ruta de API no encontrada.", 404);
    }
    if (method !== "GET") throw localError("Método no permitido.", 405);
    if (path.split("/").some(part => part.startsWith("."))) throw localError("Archivo no encontrado.", 404);
    let file = resolve(staticDir, `.${path}`);
    try {
      file = await realpath(file);
      if (!isInside(staticDir, file)) throw localError("Archivo fuera del sitio público.", 403);
      if (!(await stat(file)).isFile()) throw localError("Archivo no encontrado.", 404);
    } catch (error) {
      if ((error as {status?: number}).status === 403) throw error;
      if (extname(path)) throw localError("Archivo no encontrado.", 404);
      try { file = await realpath(join(staticDir, "index.html")); if (!isInside(staticDir, file) || !(await stat(file)).isFile()) throw new Error(); }
      catch { throw localError("La interfaz de Salem aún no está construida.", 404); }
    }
    response.statusCode = 200; response.setHeader("Content-Type", mime[extname(file).toLowerCase()] ?? "application/octet-stream"); response.end(await readFile(file));
  }
  try {
    await store.readState();
    manager = options.manager ?? new (await import("./executions.js")).ExecutionManager(store, { canStart: (provider: Provider) => initialized&&!accounts?.isMutating(provider)&&!goals?.hasUnconfirmed(provider)&&!evolution?.hasUnconfirmed(provider),additionalActive:()=>(goals?.activeCount()??0)+(evolution?.activeCount()??0) });
    goals = new GoalManager(store,{canStart:provider=>initialized&&!accounts?.isMutating(provider)&&!evolution?.hasUnconfirmed(provider),additionalActive:()=>(manager?.activeCount?.()??0)+(evolution?.activeCount()??0),acceptedBase:async id=>{if(!manager?.acceptedBase)throw localError('La ejecución administrada no está disponible.',503);return manager.acceptedBase(id);}});
    conversations=new ConversationManager(store,goals,{
      cancel:id=>manager!.cancel(id),resumeManaged:async id=>{if(!manager?.resumeManaged)throw localError('La ejecución administrada no está disponible.',503);return manager.resumeManaged(id);},isActive:id=>manager?.isActive?.(id)??false,
      acceptedBase:async id=>{if(!manager?.acceptedBase)throw localError('La ejecución administrada no está disponible.',503);return manager.acceptedBase(id);},
      startManaged:async(...args)=>{if(!manager?.startManaged)throw localError('La ejecución administrada no está disponible.',503);return manager.startManaged(...args);},
      checkpoint:async id=>manager?.checkpoint?manager.checkpoint(id):null,
    },{canStart:()=>initialized});
    evolution=new EvolutionManager(store,{canStart:provider=>initialized&&!accounts?.isMutating(provider)&&!goals?.hasUnconfirmed(provider),additionalActive:()=>(manager?.activeCount?.()??0)+(goals?.activeCount()??0)});
    accounts = options.accounts ?? new AccountManager(store, { isBusy: provider => manager!.isBusy(provider)||goals!.isBusy(provider)||evolution!.isBusy(provider) });
    await evolution.initialize();
    await goals.initialize();
    await manager.initialize();
    await conversations.initialize();
    initialized=true;manager.wake?.();goals.wake();evolution.wake();
    await new Promise<void>((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
    });
    const address = server.address(); if (!address || typeof address === "string") throw new Error("No se pudo resolver el puerto local.");
    url = `http://127.0.0.1:${address.port}`;
  } catch (error) {
    await conversations?.shutdown().catch(()=>{});await accounts?.close().catch(() => {}); await evolution?.shutdown().catch(()=>{}); await goals?.shutdown().catch(()=>{}); await manager?.shutdown().catch(() => {}); await release();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") throw Object.assign(new Error(`El puerto ${options.port} está ocupado. Elige otro puerto para Salem.`), { code: "EADDRINUSE" });
    throw error;
  }
  const close = (): Promise<void> => closePromise ??= (async () => {
    closing = true;initialized=false; let failure: unknown;
    try{await conversations!.shutdown();}catch(error){failure=error;}
    try { await accounts!.close(); } catch (error) { failure = error; }
    try { await evolution!.shutdown(); } catch(error){failure??=error;}
    try { await goals!.shutdown(); } catch(error){failure??=error;}
    try { await manager!.shutdown(); } catch (error) { failure ??= error; }
    await new Promise<void>(resolveClose => { server.close(() => resolveClose()); server.closeAllConnections(); });
    sessions.clear(); await release();
    if (failure) throw new Error("No se pudo confirmar el cierre completo de las operaciones de Salem.");
  })();
  return { url, store, manager, accounts, goals, conversations, close };
}
