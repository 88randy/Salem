import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn,type ChildProcess} from "node:child_process";
import {mkdtemp,readFile,readdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {atomicJson,observeRenameFailures,RENAME_RETRY_LIMIT} from "../src/state-store.js";

const windowsOnly={skip:process.platform!=="win32",timeout:120_000};
const lockCodes=["EPERM","EACCES","EBUSY"];
// PowerShell startup alone took 7-15 s with the CPU 4x oversubscribed (#34).
const READY_TIMEOUT_MS=60_000;

// Holds `file` open for reading without delete sharing, like a scanner or indexer.
// The child blocks on stdin, so it never polls. Release terminates it: the OS closes
// its handles before the exit event fires, without the child having to run again.
async function holdReadLock(file:string):Promise<{release:()=>Promise<void>}> {
 const script="$stream=[System.IO.File]::Open($env:SALEM_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [Console]::Out.WriteLine('ready'); [Console]::Out.Flush(); [void][Console]::In.ReadLine() } finally { $stream.Dispose() }";
 const child:ChildProcess=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{windowsHide:true,stdio:["pipe","pipe","pipe"],env:{...process.env,SALEM_LOCK_FILE:file}});
 let output="";
 const exited=new Promise<void>(resolve=>child.once("exit",()=>resolve()));
 await new Promise<void>((resolve,reject)=>{
  const timer=setTimeout(()=>{child.kill();reject(new Error(`lock holder not ready after ${READY_TIMEOUT_MS} ms: ${output}`));},READY_TIMEOUT_MS);
  const fail=(error:Error)=>{clearTimeout(timer);reject(error);};
  child.once("error",error=>fail(new Error(`lock holder failed to start: ${error.message}`)));
  child.once("exit",(code,signal)=>fail(new Error(`lock holder exited before ready (code ${code}, signal ${signal}): ${output}`)));
  const collect=(chunk:Buffer)=>{output+=chunk.toString();if(/^ready\r?$/m.test(output)){clearTimeout(timer);resolve();}};
  child.stdout!.on("data",collect);child.stderr!.on("data",collect);
 });
 return {release:async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill();await exited;}};
}

async function revision(file:string):Promise<number> {return JSON.parse(await readFile(file,"utf8")).revision;}

test("Windows atomic replacement survives a short lived reader lock without losing the previous catalog",windowsOnly,async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem atomic ")),file=join(root,"catalog.json");
 await atomicJson(file,{revision:1});
 const lock=await holdReadLock(file);
 const failures:number[]=[];
 let blocked!:()=>void;const firstBlocked=new Promise<void>(resolve=>{blocked=resolve;});
 observeRenameFailures((attempt,error)=>{if(lockCodes.includes(error.code??"")){failures.push(attempt);blocked();}});
 try {
  const write=atomicJson(file,{revision:2});
  // Release only after atomicJson itself hit the lock, so the retry path is exercised.
  const first=await Promise.race([firstBlocked.then(()=>"blocked"),write.then(()=>"finished",()=>"finished")]);
  assert.equal(first,"blocked","atomicJson must collide with the reader lock before it is released");
  assert.equal(await revision(file),1,"replacement waits while the lock is held");
  await lock.release();
  await write;
  assert.equal(await revision(file),2);
  assert.ok(failures.length>=1&&failures.length<=RENAME_RETRY_LIMIT,`blocked attempts: ${failures.length}`);
 } finally {observeRenameFailures(undefined);await lock.release();}
});

test("Windows atomic replacement fails clearly and keeps the previous catalog when a lock outlives the retry budget",windowsOnly,async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem atomic ")),file=join(root,"catalog.json");
 await atomicJson(file,{revision:1});
 const lock=await holdReadLock(file);
 const failures:string[]=[];
 observeRenameFailures((_attempt,error)=>{failures.push(error.code??"");});
 try {
  await assert.rejects(atomicJson(file,{revision:2}),(error:NodeJS.ErrnoException&{dest?:string})=>{
   assert.ok(lockCodes.includes(error.code??""),`unexpected code ${error.code}`);
   assert.equal(error.syscall,"rename");assert.equal(error.dest,file);
   return true;
  });
  assert.equal(failures.length,RENAME_RETRY_LIMIT+1,"the whole retry budget is spent before failing");
  assert.ok(failures.every(code=>lockCodes.includes(code)),`attempt codes: ${failures.join(",")}`);
 } finally {observeRenameFailures(undefined);await lock.release();}
 assert.equal(await revision(file),1);
 assert.deepEqual(await readdir(root),["catalog.json"],"no temporary file is left behind");
});
