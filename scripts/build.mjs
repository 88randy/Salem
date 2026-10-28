import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildInputHash,writeBuildStamp} from './windows/build-inputs.mjs';
import {normalizePeIdentity} from './windows/reproducible-pe.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Windows process containment helper (see src/windows-job.ts). Built with the
// system .NET Framework compiler by absolute path: PATH must not choose it.
function windowsHelperCompiler(env=process.env){return join(env.WINDIR??env.SystemRoot??'C:\\Windows','Microsoft.NET','Framework64','v4.0.30319','csc.exe');}
export function compileWindowsHelper(source,out,extra=[]){
 const compiler=windowsHelperCompiler();if(!existsSync(compiler))throw new Error(`Build failed: the Windows containment helper needs ${compiler} (.NET Framework 4.x).`);
 mkdirSync(dirname(out),{recursive:true});
 const result=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/optimize+',...extra,`/out:${out}`,source],{cwd:dirname(source),stdio:'inherit',windowsHide:true});
 if(result.error)throw result.error;if(result.status!==0)throw new Error(`Build failed: csc.exe exited ${result.status??'without status'}`);
 // csc 4.x has no /deterministic: derive its per-run timestamp and MVID from the content.
 writeFileSync(out,normalizePeIdentity(readFileSync(out)));
}
function buildWindowsHelper(directory){
 if(process.platform!=='win32')return;
 // Release helper (dist/src: stamped and packaged) has no test hooks. The test
 // build (dist/tests: never stamped or packaged) adds the fault-injection hooks.
 for(const [out,extra] of [[resolve(directory,'dist','src','windows-job-helper.exe'),[]],[resolve(directory,'dist','tests','windows-job-helper.test.exe'),['/define:SALEM_TEST_HOOKS']]])compileWindowsHelper(resolve(directory,'src','windows-job-helper.cs'),out,extra);
}
export async function buildApplication(directory=root){
 const before=await buildInputHash(directory);
 for(const [script,args] of [['node_modules/typescript/bin/tsc',[]],['node_modules/vite/bin/vite.js',['build','--config','ui/vite.config.ts']]]){
  const result=spawnSync(process.execPath,[resolve(directory,script),...args],{cwd:directory,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error;if(result.status!==0)throw new Error(`Build failed: ${script} exited ${result.status??'without status'}`);
 }
 buildWindowsHelper(directory);
 await writeBuildStamp(directory,before);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await buildApplication();
