import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startLocalServer} from "../src/local/server.js";
test("separate local ports keep independent browser sessions in the same cookie jar",async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem cookies ")),web=join(root,"web");await mkdir(web);await writeFile(join(web,"index.html"),"Salem");
 const a=await startLocalServer({dataDir:join(root,"a"),staticDir:web,port:0}),b=await startLocalServer({dataDir:join(root,"b"),staticDir:web,port:0});
 try {
  const first=await fetch(a.url+"/api/bootstrap"),second=await fetch(b.url+"/api/bootstrap");
  const one=first.headers.get("set-cookie")!.split(";")[0]!,two=second.headers.get("set-cookie")!.split(";")[0]!;
  assert.notEqual(one.split("=")[0],two.split("=")[0],"a second local Salem instance replaces the first session cookie");
  const jar=one+"; "+two;
  for(const url of [a.url,b.url])assert.equal((await fetch(url+"/api/state",{headers:{Cookie:jar}})).status,200);
  await b.close();assert.equal((await fetch(a.url+"/api/state",{headers:{Cookie:jar}})).status,200);
 } finally {await a.close();await b.close();}
});
