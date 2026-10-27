import { mkdir, mkdtemp, rm, copyFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runProcess } from "../process.js";
import { localError } from "./validation.js";

export async function localGit(root:string,args:string[],systemDir:string,options:{signal?:AbortSignal;leaseDir?:string;allowMissing?:boolean;indexFile?:string}={}):Promise<string>{
 const hooks=join(systemDir,"empty-hooks");await mkdir(hooks,{recursive:true});
 const r=await runProcess({command:["git","--no-pager","-c",`core.hooksPath=${hooks}`,"-c","core.fsmonitor=false","-c","core.longpaths=true",...args],cwd:root,
   env:{GIT_TERMINAL_PROMPT:"0",GIT_NO_LAZY_FETCH:"1",...(options.indexFile?{GIT_INDEX_FILE:options.indexFile}:{})},timeoutMs:120000,maxOutputBytes:2_000_000,
   ...(options.signal?{signal:options.signal}:{}),...(options.leaseDir?{leaseDir:options.leaseDir}:{})});
 if(options.allowMissing&&r.status==="exited"&&r.exitCode===1)return "";
 if(r.status!=="exited"||r.exitCode!==0)throw localError(r.error||r.stderr.trim()||"No se pudo completar la operación Git local.");
 return r.stdout.trim();
}

export async function localDiff(root:string,sourceSha:string,systemDir:string):Promise<string>{
 const directory=await mkdtemp(join(systemDir,"diff-index-")),options={indexFile:join(directory,"index")};
 try{
  // Copy staged membership too, including tracked additions now covered by ignore rules.
  const git=(args:string[])=>localGit(root,["-c","core.splitIndex=false",...args],systemDir,options);
  try{await copyFile(resolve(root,await localGit(root,["rev-parse","--git-path","index"],systemDir)),options.indexFile);}
  catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await git(["read-tree","HEAD"]);}
  await git(["add","--intent-to-add","--all","--"]);
  return await git(["diff","--no-ext-diff","--no-textconv",sourceSha,"--"]);
 }finally{await rm(directory,{recursive:true,force:true});}
}
