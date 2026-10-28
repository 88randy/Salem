import { mkdir, mkdtemp, rm, copyFile, open, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "../process.js";
import { localError } from "./validation.js";

/** Output budget shared by local Git reads and the exported patch. */
export const LOCAL_GIT_OUTPUT_LIMIT=2_000_000;
/** Paths of every index entry; scales with repository size, not with the change. */
const INDEX_LISTING_LIMIT=64_000_000;
export async function localGit(root:string,args:string[],systemDir:string,options:{signal?:AbortSignal;leaseDir?:string;allowMissing?:boolean;indexFile?:string;env?:Record<string,string>;input?:string;maxOutputBytes?:number}={}):Promise<string>{
 const hooks=join(systemDir,"empty-hooks");await mkdir(hooks,{recursive:true});
 const r=await runProcess({command:["git","--no-pager","-c",`core.hooksPath=${hooks}`,"-c","core.fsmonitor=false","-c","core.longpaths=true",...args],cwd:root,
   env:{GIT_TERMINAL_PROMPT:"0",GIT_NO_LAZY_FETCH:"1",...(options.indexFile?{GIT_INDEX_FILE:options.indexFile}:{}),...options.env},timeoutMs:120000,maxOutputBytes:options.maxOutputBytes??LOCAL_GIT_OUTPUT_LIMIT,...(options.input!==undefined?{input:options.input}:{}),
   ...(options.signal?{signal:options.signal}:{}),...(options.leaseDir?{leaseDir:options.leaseDir}:{})});
 if(options.allowMissing&&r.status==="exited"&&r.exitCode===1)return "";
 if(r.status!=="exited"||r.exitCode!==0)throw localError(r.error||r.stderr.trim()||"No se pudo completar la operación Git local.");
 return r.stdout.trim();
}

/**
 * Overrides that keep clean/process filters (from any config level) and core.attributesFile out of a diff, so only
 * the repository's own .gitattributes can convert work-tree bytes. Nothing is written to config.
 */
async function neutralConversions(root:string,systemDir:string,scratch:string):Promise<string[]>{
 const overrides=["-c",`core.attributesFile=${join(scratch,"no-attributes")}`];
 for(const key of (await localGit(root,["config","--name-only","--get-regexp","^filter\\..*\\.(process|smudge|clean|required)$"],systemDir,{allowMissing:true})).split(/\r?\n/).filter(Boolean)){
  if(!/^filter\.[A-Za-z0-9._/-]+\.(?:process|smudge|clean|required)$/.test(key))throw localError("Filtro Git incompatible con una exportación sin scripts.",409);
  overrides.push("-c",`${key}=${key.endsWith(".required")?"false":""}`);
 }
 return overrides;
}

export async function localDiff(root:string,sourceSha:string,systemDir:string,shape:{args?:string[];config?:string[];env?:Record<string,string>}={}):Promise<string>{
 const directory=await mkdtemp(join(systemDir,"diff-index-")),options={indexFile:join(directory,"index"),...(shape.env?{env:shape.env}:{})};
 try{
  const neutral=await neutralConversions(root,systemDir,directory);
  const git=(args:string[],extra:{input?:string;maxOutputBytes?:number}={})=>localGit(root,["-c","core.splitIndex=false",...neutral,...args],systemDir,{...options,...extra});
  // Copy staged membership and modes too (the index holds the executable bit where core.fileMode is false),
  // including tracked additions now covered by ignore rules.
  try{await copyFile(resolve(root,await localGit(root,["rev-parse","--git-path","index"],systemDir)),options.indexFile);}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await git(["read-tree","HEAD"]);}
  // assume-unchanged (lowercase tag) and skip-worktree (S/s) make Git trust the index over the work tree: clear them in the copy.
  const flagged=(await git(["ls-files","-v","-z"],{maxOutputBytes:INDEX_LISTING_LIMIT})).split("\0").filter(entry=>/^[a-zS] /.test(entry)).map(entry=>entry.slice(2));
  // update-index applies one marking option per call, so each flag is cleared separately.
  if(flagged.length)for(const flag of ["--no-assume-unchanged","--no-skip-worktree"])await git(["update-index",flag,"-z","--stdin"],{input:flagged.join("\0")+"\0"});
  await git(["add","--intent-to-add","--all","--"]);
  return await git([...(shape.config??[]).flatMap(entry=>["-c",entry]),"diff","--no-ext-diff","--no-textconv",...(shape.args??[]),sourceSha,"--"]);
 }finally{await rm(directory,{recursive:true,force:true});}
}

/**
 * Binary-safe patch of the work tree (untracked, non-ignored files included) against sourceSha.
 * Git writes the bytes to a private file so they skip text decoding and redaction. The patch shape is
 * pinned: user config or GIT_DIFF_OPTS that change context, prefixes, paths or color are overridden.
 */
const PATCH_CONFIG=["diff.context=3","diff.interHunkContext=0","diff.noprefix=false","diff.mnemonicPrefix=false","diff.suppressBlankEmpty=false","diff.relative=false","color.diff=false"];
const PATCH_ARGS=["--binary","--full-index","--unified=3","--inter-hunk-context=0","--no-color","--no-relative","--src-prefix=a/","--dst-prefix=b/"];
export async function localPatch(root:string,sourceSha:string,systemDir:string):Promise<Buffer>{
 // Salem never creates these in a copy; they could convert accepted bytes in ways the acceptance check cannot see.
 const info=resolve(root,await localGit(root,["rev-parse","--git-path","info/attributes"],systemDir));
 const converted=await localGit(root,["config","--local","--name-only","--get-regexp","^core\\.(autocrlf|eol|checkroundtripencoding)$"],systemDir,{allowMissing:true});
 // An ignored .gitattributes is invisible to the acceptance snapshot but still steers conversion (ident, eol, encoding).
 const hidden=await localGit(root,["ls-files","-z","--others","--ignored","--exclude-standard","--",":(glob)**/.gitattributes"],systemDir);
 if(converted||hidden||await stat(info).then(()=>true,()=>false))throw localError("La copia tiene atributos o reglas de conversión Git añadidos después de aceptar; no se exporta un parche que podría no coincidir con el resultado aceptado.",409);
 const directory=await mkdtemp(join(systemDir,"patch-")),file=join(directory,"accepted.patch");
 try{
  await localDiff(root,sourceSha,systemDir,{config:PATCH_CONFIG,args:[...PATCH_ARGS,`--output=${file}`],env:{GIT_DIFF_OPTS:""}});
  const handle=await open(file,"r");
  try{const {size}=await handle.stat();if(size>LOCAL_GIT_OUTPUT_LIMIT)throw localError(`El parche ocupa ${size} bytes y supera el límite de ${LOCAL_GIT_OUTPUT_LIMIT} bytes. Recupera el cambio desde la copia aislada.`,413);return await handle.readFile();}
  finally{await handle.close();}
 }finally{await rm(directory,{recursive:true,force:true});}
}
