import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn,type ChildProcess} from "node:child_process";
import {mkdtemp,writeFile,readFile,readdir,rename} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {atomicJson} from "../src/state-store.js";

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
 try {
  const probe=join(root,"probe.tmp");await writeFile(probe,"{}");
  await assert.rejects(rename(probe,file),(error:NodeJS.ErrnoException)=>lockCodes.includes(error.code??""),"the reader lock must block replacement");
  const write=atomicJson(file,{revision:2});
  await delay(50);
  assert.equal(await revision(file),1,"replacement waits while the lock is held");
  await lock.release();
  await write;
  assert.equal(await revision(file),2);
 } finally {await lock.release();}
});

test("Windows atomic replacement fails clearly and keeps the previous catalog when a lock outlives the retry budget",windowsOnly,async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem atomic ")),file=join(root,"catalog.json");
 await atomicJson(file,{revision:1});
 const lock=await holdReadLock(file);
 try {
  await assert.rejects(atomicJson(file,{revision:2}),(error:NodeJS.ErrnoException&{dest?:string})=>{
   assert.ok(lockCodes.includes(error.code??""),`unexpected code ${error.code}`);
   assert.equal(error.syscall,"rename");assert.equal(error.dest,file);
   return true;
  });
 } finally {await lock.release();}
 assert.equal(await revision(file),1);
 assert.deepEqual(await readdir(root),["catalog.json"],"no temporary file is left behind");
});
