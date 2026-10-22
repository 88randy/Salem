import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildInputHash,writeBuildStamp} from './windows/build-inputs.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
export async function buildApplication(directory=root){
 const before=await buildInputHash(directory);
 for(const [script,args] of [['node_modules/typescript/bin/tsc',[]],['node_modules/vite/bin/vite.js',['build','--config','ui/vite.config.ts']]]){
  const result=spawnSync(process.execPath,[resolve(directory,script),...args],{cwd:directory,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;if(result.status!==0)throw new Error(`Build failed: ${script} exited ${result.status??'without status'}`);
 }
 await writeBuildStamp(directory,before);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildApplication();
