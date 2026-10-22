import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isInside } from "../config.js";
import type { ProjectRecord } from "./contracts.js";
import type { ResearchSnapshot } from "./research-contracts.js";
import { localGit } from "./git.js";
import { localError, localText, uuid } from "./validation.js";

/** Every existing component must remain physically below the canonical data root. */
export async function ownedResearchPath(dataDir:string,...parts:string[]):Promise<string>{
 const root=await realpath(dataDir);let cursor=root;
 for(const part of parts){
  if(!part||part==="."||part===".."||isAbsolute(part)||/[\\/:\0]/.test(part))throw localError("Componente de ruta fuera del espacio permitido de Salem.",403);
  cursor=join(cursor,part);
  try{const info=await lstat(cursor),actual=await realpath(cursor);if(info.isSymbolicLink()||actual!==cursor||!isInside(root,actual))throw localError("La ruta contiene un enlace fuera del espacio permitido de Salem.",403);}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 }
 return cursor;
}

export async function sourceRoot(input:string,systemDir:string,signal?:AbortSignal,leaseDir?:string):Promise<string>{
 localText(input,"carpeta del repositorio",8192);
 let root:string;try{root=await realpath(resolve(input));if(!(await lstat(root)).isDirectory())throw new Error();}catch{throw localError("La carpeta del repositorio no existe.");}
 const options={...(signal?{signal}:{}),...(leaseDir?{leaseDir}:{})};
 const top=await realpath(await localGit(root,["rev-parse","--show-toplevel"],systemDir,options));
 if(root!==top)throw localError("Selecciona la raíz del repositorio Git, no una subcarpeta.");return root;
}

export async function pinnedInventory(root:string,sha:string,systemDir:string,signal?:AbortSignal,leaseDir?:string):Promise<{files:string[];allFiles:string[];truncated:boolean;omitted:boolean}>{
 if(!/^[a-f0-9]{40,64}$/.test(sha))throw localError("La revisión Git no es un SHA válido.");
 const text=await localGit(root,["ls-tree","-r","-z","--full-tree",sha],systemDir,{...(signal?{signal}:{}),...(leaseDir?{leaseDir}:{})});
 let omitted=false;const all:string[]=[];
 for(const entry of text.split("\0").filter(Boolean)){
  const match=/^(100644|100755) blob [a-f0-9]+\t([\s\S]+)$/.exec(entry),name=match?.[2];
  if(!name||/[\\:\x00-\x1f]/.test(name)||name.startsWith("/")||name.split("/").some(p=>p==="."||p==="..")){omitted=true;continue;}all.push(name);
 }
 const priority=(file:string)=>/^(?:AGENTS\.md|CLAUDE\.md|README(?:\.[a-z]+)?|package\.json|pyproject\.toml|Cargo\.toml|go\.mod|\.salem-check\.mjs|[^/]*lock[^/]*)$/i.test(file)?0:1;
 all.sort((a,b)=>priority(a)-priority(b)||a.localeCompare(b,"en"));
 return {files:all.slice(0,1000),allFiles:all,truncated:all.length>1000,omitted};
}

/** No preparation commands, hooks or filters run while materializing research. */
export async function createResearchSnapshot(project:ProjectRecord,dataDir:string,goalId:string,attemptId:string,sourceSha:string|null,signal:AbortSignal):Promise<ResearchSnapshot>{
 uuid(goalId);uuid(attemptId);signal.throwIfAborted();
 const attempt=await ownedResearchPath(dataDir,"research",goalId,attemptId),workspace=await ownedResearchPath(dataDir,"research",goalId,attemptId,"workspace");
 await ownedResearchPath(dataDir,"empty-hooks");await mkdir(attempt,{recursive:true});
 const leaseDir=await ownedResearchPath(dataDir,"research",goalId,attemptId,"leases"),options={signal,leaseDir};
 const root=await sourceRoot(project.config.repoRoot,dataDir,signal,leaseDir);
 const sha=sourceSha??await localGit(root,["rev-parse","--verify","--end-of-options",`${project.baseRef}^{commit}`],dataDir,options);
 if(!/^[a-f0-9]{40,64}$/.test(sha))throw localError("No se pudo resolver la revisión Git de investigación.");
 try{await lstat(workspace);throw localError("El destino de investigación ya existe; usa un intento nuevo.",409);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 signal.throwIfAborted();
 await localGit(root,["clone","--local","--no-hardlinks","--dissociate","--no-checkout","--template=","--origin","salem-source","--",root,workspace],dataDir,options);
 await ownedResearchPath(dataDir,"research",goalId,attemptId,"workspace");
 await localGit(workspace,["config","--local","core.hooksPath",join(await realpath(dataDir),"empty-hooks")],dataDir,options);
 await localGit(workspace,["config","--local","core.fsmonitor","false"],dataDir,options);
 // A repository may track a link to a file outside its root. Research needs
 // the link declaration, never the external file behind it.
 await localGit(workspace,["config","--local","core.symlinks","false"],dataDir,options);
 const filters=await localGit(workspace,["config","--name-only","--get-regexp","^filter\\..*\\.(process|smudge|clean|required)$"],dataDir,{...options,allowMissing:true});
 for(const key of filters.split(/\r?\n/).filter(Boolean)){
  if(!/^filter\.[A-Za-z0-9._/-]+\.(?:process|smudge|clean|required)$/.test(key))throw localError("Filtro Git incompatible con una copia aislada segura.");
  await localGit(workspace,["config","--local",key,key.endsWith(".required")?"false":""],dataDir,options);
 }
 await localGit(workspace,["checkout","--detach",sha],dataDir,options);
 const inventory=await pinnedInventory(workspace,sha,dataDir,signal,leaseDir);
 return {root:workspace,sourceSha:sha,files:inventory.files,evidenceFiles:inventory.allFiles,truncated:inventory.truncated};
}
