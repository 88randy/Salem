import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../process.js";
import { localError } from "./validation.js";

export async function localGit(root:string,args:string[],systemDir:string,options:{signal?:AbortSignal;leaseDir?:string;allowMissing?:boolean}={}):Promise<string>{
 const hooks=join(systemDir,"empty-hooks");await mkdir(hooks,{recursive:true});
 const r=await runProcess({command:["git","--no-pager","-c",`core.hooksPath=${hooks}`,"-c","core.fsmonitor=false","-c","core.longpaths=true",...args],cwd:root,
   env:{GIT_TERMINAL_PROMPT:"0",GIT_NO_LAZY_FETCH:"1"},timeoutMs:120000,maxOutputBytes:2_000_000,
   ...(options.signal?{signal:options.signal}:{}),...(options.leaseDir?{leaseDir:options.leaseDir}:{})});
 if(options.allowMissing&&r.status==="exited"&&r.exitCode===1)return "";
 if(r.status!=="exited"||r.exitCode!==0)throw localError(r.error||r.stderr.trim()||"No se pudo completar la operación Git local.");
 return r.stdout.trim();
}
