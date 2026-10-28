import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { isInside } from "../config.js";
import type { CheckConfig } from "../contracts.js";
import { defaultAgent, type LocalSettings, type Provider } from "./contracts.js";
import type { DiscoveryReport } from "./research-contracts.js";
import { localGit } from "./git.js";
import { ownedResearchPath, pinnedInventory, sourceRoot } from "./research-repository.js";
import { localError } from "./validation.js";

const MAX_TEXT_BYTES=256*1024;
export async function discoverProject(repoRoot:string,settings:LocalSettings,provider:Provider,systemDir:string):Promise<DiscoveryReport>{
 if(provider!=="claude"&&provider!=="codex")throw localError("Proveedor desconocido.");
 await ownedResearchPath(systemDir,"empty-hooks");
 const root=await sourceRoot(repoRoot,systemDir),sourceSha=await localGit(root,["rev-parse","--verify","HEAD^{commit}"],systemDir);
 const inventory=await pinnedInventory(root,sourceSha,systemDir),files=inventory.files,set=new Set(files),warnings:string[]=[],stack:string[]=[],checks:CheckConfig[]=[];
 const read=async(file:string):Promise<string|null>=>{
  const size=Number(await localGit(root,["cat-file","-s",`${sourceSha}:${file}`],systemDir));
  if(!Number.isSafeInteger(size)||size>MAX_TEXT_BYTES)return null;
  const text=await localGit(root,["show",`${sourceSha}:${file}`],systemDir);return text.includes("\0")?null:text;
 };
 const localFile=async(file:string):Promise<boolean>=>{try{const path=resolve(root,file),info=await lstat(path);return info.isFile()&&!info.isSymbolicLink()&&isInside(root,await realpath(path));}catch{return false;}};
 const contextFiles:string[]=[];
 for(const name of ["AGENTS.md","CLAUDE.md","README.md","README.rst","README.txt","README","package.json","pyproject.toml","Cargo.toml","go.mod"]){if(set.has(name)&&await localFile(name)&&await read(name)!==null)contextFiles.push(name);}
 if(!contextFiles.length){
  for(const file of files.slice(0,50))if(await localFile(file)&&await read(file)!==null){contextFiles.push(file);break;}
  warnings.push("No se encontraron instrucciones o manifiestos reconocidos; revisa el contexto sugerido antes de ejecutar.");
 }
 if(!contextFiles.length)throw localError("El repositorio no contiene un archivo de contexto de texto disponible dentro de su raíz.");
 // status may invoke clean/process filters even when nothing is checked out.
 // Neutralize effective source filters for this invocation, without writing its config.
 const filterKeys=await localGit(root,["config","--name-only","--get-regexp","^filter\\..*\\.(process|smudge|clean|required)$"],systemDir,{allowMissing:true}),overrides:string[]=[];
 for(const key of filterKeys.split(/\r?\n/).filter(Boolean)){
  if(!/^filter\.[A-Za-z0-9._/-]+\.(?:process|smudge|clean|required)$/.test(key))throw localError("Filtro Git incompatible con una inspección sin scripts.");
  overrides.push("-c",`${key}=${key.endsWith(".required")?"false":""}`);
 }
 const dirty=await localGit(root,[...overrides,"--no-optional-locks","status","--porcelain","--untracked-files=normal"],systemDir);
 if(dirty)warnings.push("Hay cambios sin confirmar o archivos no versionados. La investigación usará únicamente la revisión Git confirmada; esos cambios quedan fuera.");
 if(inventory.truncated)warnings.push("El inventario se limitó a 1000 archivos; Salem deberá investigar el resto durante la planificación.");
 if(inventory.omitted)warnings.push("Se omitieron enlaces, submódulos o rutas no compatibles del inventario de evidencia.");
 if(!set.has("AGENTS.md")&&!set.has("CLAUDE.md"))warnings.push("No hay AGENTS.md ni CLAUDE.md en la raíz; las reglas del proyecto deben confirmarse en sus documentos.");
 if(set.has("package.json")){
  stack.push("Node.js");
  try{
   const raw=await read("package.json");if(raw===null)throw new Error("manifiesto demasiado grande o binario");
   const pkg=JSON.parse(raw) as {scripts?:unknown;packageManager?:unknown},scripts=pkg.scripts&&typeof pkg.scripts==="object"&&!Array.isArray(pkg.scripts)?pkg.scripts as Record<string,unknown>:{};
   const manager=typeof pkg.packageManager==="string"&&/^(pnpm|yarn|bun|npm)@/.test(pkg.packageManager)?pkg.packageManager.split("@")[0]!:set.has("pnpm-lock.yaml")?"pnpm":set.has("yarn.lock")?"yarn":set.has("bun.lockb")||set.has("bun.lock")?"bun":"npm";
   for(const name of ["test","typecheck","lint"]){const command=scripts[name];if(typeof command!=="string"||!command.trim())continue;if(/(?:no test specified|not implemented)/i.test(command)){warnings.push(`El script ${name} parece un marcador pendiente y no se añadió como check.`);continue;}checks.push({id:name,command:[manager,"run",name],required:true,toolFiles:["package.json"]});}
  }catch(error){warnings.push(`No se pudo interpretar package.json: ${(error as Error).message}. Configura los checks manualmente.`);}
 }
 if(set.has(".salem-check.mjs")){if(!stack.includes("Node.js"))stack.push("Node.js");checks.push({id:"salem-demo",command:[process.execPath,".salem-check.mjs"],required:true,toolFiles:[".salem-check.mjs"]});}
 const django=set.has("manage.py")&&await localFile("manage.py")&&await read("manage.py")!==null,ruffConfigs:string[]=[];
 for(const file of ["ruff.toml",".ruff.toml"])if(set.has(file)&&await localFile(file)&&await read(file)!==null)ruffConfigs.push(file);
 if(set.has("pyproject.toml")||set.has("requirements.txt")||set.has("setup.py")||django||ruffConfigs.length){
  stack.push("Python");const pyproject=set.has("pyproject.toml")?await read("pyproject.toml"):null,requirements=set.has("requirements.txt")?await read("requirements.txt"):null;
  if(/pytest/i.test(`${pyproject??""}\n${requirements??""}`))checks.push({id:"pytest",command:["python","-m","pytest"],required:true,...(set.has("pyproject.toml")?{toolFiles:["pyproject.toml"]}:{})});
  if(django){
   stack.push("Django");checks.push({id:"django-check",command:["python","manage.py","check"],required:true,toolFiles:["manage.py"]},{id:"django-migrations",command:["python","manage.py","makemigrations","--check"],required:true,toolFiles:["manage.py"]});
   warnings.push("Los checks de Django requieren el entorno y los ajustes del proyecto (por ejemplo DJANGO_SETTINGS_MODULE y dependencias instaladas); puede ser necesario ajustarlos.");
  }
  // Unrelated ruff mentions are accepted false positives: users review these proposals.
  const ruffFiles:string[]=[];
  if(pyproject!==null&&/ruff/i.test(pyproject)&&await localFile("pyproject.toml"))ruffFiles.push("pyproject.toml");
  if(requirements!==null&&/ruff/i.test(requirements)&&await localFile("requirements.txt"))ruffFiles.push("requirements.txt");
  ruffFiles.push(...ruffConfigs);if(ruffFiles.length)checks.push({id:"ruff",command:["python","-m","ruff","check","."],required:true,toolFiles:ruffFiles});
 }
 if(set.has("Cargo.toml")){stack.push("Rust");checks.push({id:"cargo-test",command:["cargo","test"],required:true,toolFiles:["Cargo.toml"]});}
 if(set.has("go.mod")){stack.push("Go");checks.push({id:"go-test",command:["go","test","./..."],required:true,toolFiles:["go.mod"]});}
 if(!stack.length)warnings.push("Stack no reconocido. La investigación deberá identificar sus herramientas y proponer la verificación.");
 if(!checks.length)warnings.push("No se detectaron checks automáticos. El plan debe proponer una verificación antes de aceptar código.");
 warnings.push("Los comandos detectados son propuestas: no se instalaron dependencias ni se ejecutaron checks durante la incorporación.");
 const name=basename(root).slice(0,120)||"Proyecto",slug=name.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,45)||"project",suffix=createHash("sha256").update(root).digest("hex").slice(0,8);
 return {repoRoot:root,sourceSha,stack,contextFiles,files,truncated:inventory.truncated,warnings,suggested:{name,baseRef:sourceSha,preparation:[],config:{schemaVersion:1,projectId:`${slug}-${suffix}`,repoRoot:root,contextFiles,agents:{[provider]:defaultAgent(provider,settings)},checks,capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:180000,maxOutputBytes:2_000_000},supervisor:{roles:{define:provider,build:provider,review:provider},runTimeoutMs:600000,maxAttempts:6}}}};
}
