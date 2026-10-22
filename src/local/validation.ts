import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { parseProjectConfig, parseTask } from "../config.js";
import type { LocalSettings, ProjectInput, ProjectRecord, TaskInput, TaskRecord } from "./contracts.js";

export function localError(message: string, status = 400): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
export function record(value: unknown, keys?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw localError("Se esperaba un objeto de configuración.");
  const result = value as Record<string, unknown>;
  if (keys && Object.keys(result).some(k => !keys.includes(k))) throw localError("La configuración contiene campos desconocidos.");
  return result;
}
export function localText(value: unknown, label: string, max = 100000): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || value.length > max) throw localError(`Revisa ${label}: valor vacío o inválido.`);
  return value;
}
export function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)) throw localError("Identificador inválido.");
  return value;
}
export function argv(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 100) throw localError("El comando necesita un programa y argumentos separados.");
  return value.map(v => localText(v, "argumento", 8192));
}
export function validateSettings(value: unknown): LocalSettings {
  const r=record(value,["revision","commands","maxConcurrentRuns","refreshIntervalMs","preferredPort","nextDataDir"]);
  const commands=record(r.commands,["claude","codex"]);
  const number=(v:unknown,min:number,max:number,label:string):number=>{if(typeof v!=="number"||!Number.isSafeInteger(v)||v<min||v>max)throw localError(`Revisa ${label}: valor inválido (${min}–${max}).`);return v;};
  const nextDataDir=r.nextDataDir===undefined?undefined:localText(r.nextDataDir,"carpeta de datos",8192);
  if(nextDataDir!==undefined&&!isAbsolute(nextDataDir))throw localError("La carpeta de datos debe ser una ruta absoluta.");
  return {...(nextDataDir===undefined?{}:{nextDataDir}),revision:number(r.revision,1,Number.MAX_SAFE_INTEGER,"revisión"),commands:{claude:argv(commands.claude),codex:argv(commands.codex)},
    maxConcurrentRuns:number(r.maxConcurrentRuns,1,4,"concurrencia"),refreshIntervalMs:number(r.refreshIntervalMs,500,30000,"refresco"),preferredPort:number(r.preferredPort,1024,65535,"puerto")};
}
export async function validateProjectInput(input: ProjectInput, existing?: ProjectRecord): Promise<ProjectRecord> {
  const r=record(input,["id","revision","name","archived","config","baseRef","preparation","createdAt","updatedAt"]);
  if (r.archived !== undefined && typeof r.archived !== "boolean") throw localError("Estado de archivo inválido.");
  if (!Array.isArray(r.preparation) || r.preparation.length>20) throw localError("Revisa los comandos de preparación.");
  const baseRef=localText(r.baseRef,"rama o SHA base",200);
  if(baseRef.startsWith("-") || /[\s\x00-\x1f]|\.\./.test(baseRef))throw localError("La referencia Git base es inválida.");
  let config;
  try { config = existing && r.archived === true && JSON.stringify(r.config)===JSON.stringify(existing.config)
    ? existing.config : await parseProjectConfig(r.config); }
  catch(error) { throw localError(`Revisa la configuración del proyecto: ${(error as Error).message}`); }
  if (!config.supervisor) throw localError("Configura los agentes de definición, implementación y revisión.");
  return { id:existing?.id??(r.id?uuid(r.id):randomUUID()),revision:(existing?.revision??0)+1,
    name:localText(r.name,"nombre del proyecto",120).trim(),archived:r.archived===true,
    createdAt:existing?.createdAt??Date.now(),updatedAt:Date.now(),config,baseRef,preparation:r.preparation.map(argv) };
}
export function validateTaskInput(input: TaskInput, project: ProjectRecord, existing?: TaskRecord): TaskRecord {
  const r=record(input,["id","revision","projectId","archived","spec","createdAt","updatedAt","origin"]);
  if(r.origin!==undefined&&(!existing?.origin||JSON.stringify(r.origin)!==JSON.stringify(existing.origin)))throw localError("El origen investigado de la tarea es de solo lectura.");
  if (uuid(r.projectId)!==project.id) throw localError("Proyecto de la tarea inválido.");
  if (r.archived!==undefined&&typeof r.archived!=="boolean")throw localError("Estado de archivo inválido.");
  let spec;
  try { spec=parseTask(r.spec); } catch(error) { throw localError(`Revisa la tarea: ${(error as Error).message}`); }
  const checks=new Set(project.config.checks.map(c=>c.id));
  for(const ids of Object.values(spec.acceptanceChecks??{}))if(ids.some(id=>!checks.has(id)))throw localError("Un criterio hace referencia a un check inexistente.");
  return {id:existing?.id??(r.id?uuid(r.id):randomUUID()),revision:(existing?.revision??0)+1,
    projectId:project.id,archived:r.archived===true,createdAt:existing?.createdAt??Date.now(),updatedAt:Date.now(),spec,...(existing?.origin?{origin:structuredClone(existing.origin)}:{})};
}
