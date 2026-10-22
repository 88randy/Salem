import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {runProcess} from "../src/process.js";
test("cancelling while the guardian persists ownership settles without an open stdin pipe",async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem early cancel "));
 const script=`import {watch} from 'node:fs';import {runProcess} from ${JSON.stringify(pathToFileURL(resolve("dist/src/process.js")).href)};const c=new AbortController();const watcher=watch(${JSON.stringify(root)},(_,name)=>{if(name?.endsWith('.tmp')){watcher.close();c.abort();}});const r=await runProcess({command:[process.execPath,'-e','setInterval(()=>{},1000)'],cwd:process.cwd(),leaseDir:${JSON.stringify(root)},timeoutMs:2000,maxOutputBytes:10000,signal:c.signal});watcher.close();console.log(JSON.stringify(r));`;
 const result=await runProcess({command:[process.execPath,"--input-type=module","-e",script],cwd:process.cwd(),timeoutMs:6000,maxOutputBytes:10000});
 assert.equal(result.status,"exited",`Early cancel hung: ${result.error}`);assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/cancelled|cleanup receipt/);
});
