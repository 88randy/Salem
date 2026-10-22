import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp,writeFile,readFile,stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {atomicJson} from "../src/state-store.js";

test("Windows atomic replacement survives a short lived reader lock without losing the previous catalog",{skip:process.platform!=="win32"},async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem atomic ")),file=join(root,"catalog.json"),ready=join(root,"ready"),release=join(root,"release");
 await atomicJson(file,{revision:1});
 const child=spawn("powershell.exe",["-NoProfile","-NonInteractive","-Command","$stream=[System.IO.File]::Open($env:SALEM_LOCK_FILE,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read); try { [System.IO.File]::WriteAllText($env:SALEM_READY,'ready'); while(-not [System.IO.File]::Exists($env:SALEM_RELEASE)){Start-Sleep -Milliseconds 10} } finally { $stream.Dispose() }"],{windowsHide:true,stdio:"ignore",env:{...process.env,SALEM_LOCK_FILE:file,SALEM_READY:ready,SALEM_RELEASE:release}});
 const done=new Promise<number|null>((resolve,reject)=>{child.once("error",reject);child.once("exit",resolve);});
 try {
  const deadline=Date.now()+10000;while(!(await stat(ready).catch(()=>null))){assert.ok(Date.now()<deadline,"reader did not become ready");await delay(20);}
  assert.equal(JSON.parse(await readFile(file,"utf8")).revision,1);
  const unlocked=delay(350).then(()=>writeFile(release,"release"));
  try {await atomicJson(file,{revision:2});}finally{await unlocked;}
  assert.equal(JSON.parse(await readFile(file,"utf8")).revision,2);
 } finally {await writeFile(release,"release");assert.equal(await done,0);}
});
