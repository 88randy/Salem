import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,readFile,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {LocalStore} from "../src/local/store.js";

test("startup follows the current catalog's next-launch folder and port without moving evidence",async()=>{
 const root=await mkdtemp(join(tmpdir(),"salem launch ")), next=join(root,"next");
 const store=new LocalStore(root),state=await store.readState();
 await store.saveSettings({...state.settings,nextDataDir:next,preferredPort:4321});
 const before=await readFile(join(root,"catalog.json"),"utf8");
 const main=await import("../src/local/main.js").catch(()=>({resolveLaunch:undefined}));
 assert.equal(typeof main.resolveLaunch,"function","GUI launch preferences are missing");
 const launch=await main.resolveLaunch!([],root);
 assert.equal(launch.dataDir,next);assert.equal(launch.port,4321);
 const explicit=await main.resolveLaunch!(["--data-dir",root,"--port","4322"],root);
 assert.equal(explicit.dataDir,root);assert.equal(explicit.port,4322);
 assert.equal(await readFile(join(root,"catalog.json"),"utf8"),before);
 await writeFile(join(root,"launch.json"),"broken");
 await assert.rejects(main.resolveLaunch!([],root),/preferencias|arranque/i);
 assert.equal(await readFile(join(root,"launch.json"),"utf8"),"broken");
});
