import {test} from "node:test";
import assert from "node:assert/strict";
import {randomBytes,randomUUID} from "node:crypto";
import {mkdtemp,readFile,writeFile,mkdir,symlink,rm,readdir,copyFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {LocalStore} from "../src/local/store.js";
import {runProcess} from "../src/process.js";
import {git} from "./supervisor-fixture.js";

async function modules(){
 const manager=await import("../src/local/executions.js").catch(()=>({ExecutionManager:undefined}));
 const demo=await import("../src/local/demo.js").catch(()=>({createLocalDemo:undefined}));
 assert.equal(typeof manager.ExecutionManager,"function","local execution manager missing");
 assert.equal(typeof demo.createLocalDemo,"function","isolated demo creation missing");
 return {Manager:manager.ExecutionManager!,createDemo:demo.createLocalDemo!};
}
async function fixture(){const root=await mkdtemp(join(tmpdir(),"salem runs ")),store=new LocalStore(join(root,"data"));const s=await store.readState();await store.saveSettings({...s.settings,commands:{...s.settings.commands,codex:[process.execPath,resolve("tests/fixtures/benchmark-agent.mjs")]}});return {root,store};}
async function until<T>(fn:()=>Promise<T|undefined>):Promise<T>{const deadline=Date.now()+180000;while(Date.now()<deadline){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,50));}throw Error("Execution did not reach the expected durable state");}
async function diffFixture(){
 const {Manager,createDemo}=await modules(),f=await fixture(),{task}=await createDemo(f.store),m=new Manager(f.store,{autoStart:false});await m.initialize();
 const e=await m.start(task.id,"untracked-diff"),workspace=join(f.store.root,"workspaces",e.id);
 await mkdir(workspace,{recursive:true});await git(workspace,"init","-b","demo");
 for(const name of ["tracked.txt","removed.txt"])await writeFile(join(workspace,name),"baseline\n");
 await git(workspace,"add","--all");await git(workspace,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-m","diff baseline");
 await f.store.patchExecution(e.id,{workspace,sourceSha:await git(workspace,"rev-parse","HEAD")});
 return {...f,m,e,workspace};
}

test("execution detail includes a new untracked text file as an addition",async()=>{
 const f=await diffFixture();
 try{
  await writeFile(join(f.workspace,"new-file.txt"),"new untracked content\n");
  const detail=await f.m.detail(f.e.id);
  assert.match(detail.diff,/diff --git a\/new-file\.txt b\/new-file\.txt/);
  assert.match(detail.diff,/new file mode/);assert.match(detail.diff,/\+new untracked content/);
 }finally{await f.m.shutdown();}
});

test("execution detail preserves the index and status with staged, recreated and nested new files",async()=>{
 const f=await diffFixture();
 try{
  await writeFile(join(f.workspace,"tracked.txt"),"staged version\n");await git(f.workspace,"add","tracked.txt");
  await rm(join(f.workspace,"tracked.txt"));await writeFile(join(f.workspace,"tracked.txt"),"recreated unstaged version\n");
  await rm(join(f.workspace,"removed.txt"));await writeFile(join(f.workspace,"staged.txt"),"staged addition\n");await git(f.workspace,"add","staged.txt");
  await mkdir(join(f.workspace,"new directory"));await writeFile(join(f.workspace,"new directory","new file.txt"),"nested addition\n");
  const status=await git(f.workspace,"status","--porcelain=v1","--untracked-files=all"),index=await readFile(join(f.workspace,".git","index"));
  const details=await Promise.all([f.m.detail(f.e.id),f.m.detail(f.e.id)]);
  assert.deepEqual(await readFile(join(f.workspace,".git","index")),index);
  assert.equal(await git(f.workspace,"status","--porcelain=v1","--untracked-files=all"),status);
  for(const detail of details){assert.match(detail.diff,/\+recreated unstaged version/);assert.match(detail.diff,/\+staged addition/);assert.match(detail.diff,/\+nested addition/);assert.match(detail.diff,/deleted file mode/);}
  assert.equal((await readdir(f.store.root)).some(name=>name.startsWith("diff-index-")),false);
 }finally{await f.m.shutdown();}
});

test("index flags cannot hide changed files from the diff or the exported patch",async()=>{
 const f=await diffFixture();
 try{
  await writeFile(join(f.workspace,"tracked.txt"),"hidden by assume-unchanged\n");await writeFile(join(f.workspace,"removed.txt"),"hidden by skip-worktree\n");
  await writeFile(join(f.workspace,"visible.txt"),"visible\n");await git(f.workspace,"add","visible.txt");
  await git(f.workspace,"update-index","--assume-unchanged","tracked.txt");await git(f.workspace,"update-index","--skip-worktree","removed.txt");
  const index=await readFile(join(f.workspace,".git","index")),{localPatch}=await import("../src/local/git.js");
  const sha=(await f.store.findExecution(f.e.id)).sourceSha!,detail=await f.m.detail(f.e.id),patch=(await localPatch(f.workspace,sha,f.store.root)).toString("utf8");
  for(const text of [detail.diff,patch]){assert.match(text,/\+hidden by assume-unchanged/);assert.match(text,/\+hidden by skip-worktree/);assert.match(text,/\+visible/);}
  assert.deepEqual(await readFile(join(f.workspace,".git","index")),index);
 }finally{await f.m.shutdown();}
});

test("snapshots fingerprint files whose names look like secrets",async()=>{
 const f=await diffFixture();
 try{
  const {repositorySnapshot}=await import("../src/repository.js"),file=join(f.workspace,"sk-ant-abcdefghijkl.txt");
  await writeFile(file,"accepted\n");const before=await repositorySnapshot(f.workspace,{readOnly:true});
  await writeFile(file,"changed after acceptance\n");const after=await repositorySnapshot(f.workspace,{readOnly:true});
  assert.notEqual(after.treeHash,before.treeHash);
 }finally{await f.m.shutdown();}
});

test("a forged index stat cache cannot hide a changed file from the diff or patch",async()=>{
 const f=await diffFixture();
 try{
  const {localPatch}=await import("../src/local/git.js"),file=join(f.workspace,"tracked.txt"),sha=(await f.store.findExecution(f.e.id)).sourceSha!;
  // Record a stat entry for the original bytes, then swap in same-size accepted bytes with the recorded timestamps.
  await git(f.workspace,"config","--local","core.trustctime","false");await git(f.workspace,"config","--local","core.checkStat","minimal");await git(f.workspace,"update-index","--refresh");
  const {stat:statFile,utimes}=await import("node:fs/promises"),before=await statFile(file);
  await writeFile(file,"accepted\n");await utimes(file,before.atime,before.mtime);
  assert.equal((await statFile(file)).size,before.size);
  await writeFile(join(f.workspace,"removed.txt"),"visible change\n");
  const detail=await f.m.detail(f.e.id),patch=(await localPatch(f.workspace,sha,f.store.root)).toString("utf8");
  for(const text of [detail.diff,patch]){assert.match(text,/\+accepted/);assert.match(text,/\+visible change/);}
 }finally{await f.m.shutdown();}
});

test("core.ignoreStat cannot hide a modified tracked file from the patch",async()=>{
 const f=await diffFixture();
 try{
  const {localPatch}=await import("../src/local/git.js"),sha=(await f.store.findExecution(f.e.id)).sourceSha!;
  await writeFile(join(f.workspace,"tracked.txt"),"modified\n");await writeFile(join(f.workspace,"brand-new.txt"),"new\n");
  await git(f.workspace,"config","--local","core.ignoreStat","true");
  const patch=(await localPatch(f.workspace,sha,f.store.root)).toString("utf8");
  assert.match(patch,/\+modified/);assert.match(patch,/\+new/);
 }finally{await f.m.shutdown();}
});

test("an embedded repository is refused instead of exported as a bare reference",async()=>{
 const f=await diffFixture();
 try{
  const {localPatch}=await import("../src/local/git.js"),sha=(await f.store.findExecution(f.e.id)).sourceSha!,inner=join(f.workspace,"inner");
  await mkdir(inner);await git(inner,"init","-q");await writeFile(join(inner,"file.txt"),"inside\n");await git(inner,"add","file.txt");
  await git(inner,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-q","-m","inner");
  await assert.rejects(localPatch(f.workspace,sha,f.store.root),(error:Error&{status?:number})=>error.status===409);
 }finally{await f.m.shutdown();}
});

test("snapshots cannot be forged by moving bytes between files",async()=>{
 const f=await diffFixture();
 try{
  const {repositorySnapshot}=await import("../src/repository.js");
  await writeFile(join(f.workspace,"za"),"X");await writeFile(join(f.workspace,"zb"),"Y");const before=await repositorySnapshot(f.workspace,{readOnly:true});
  await rm(join(f.workspace,"zb"));await writeFile(join(f.workspace,"za"),'X"zb"file:0:Y');const after=await repositorySnapshot(f.workspace,{readOnly:true});
  assert.notEqual(after.treeHash,before.treeHash);
 }finally{await f.m.shutdown();}
});

test("verification and export never start a Git transport, even for a missing object behind a promisor remote",async()=>{
 const f=await diffFixture();
 try{
  const {repositorySnapshot}=await import("../src/repository.js"),{localPatch}=await import("../src/local/git.js");
  const sha=(await f.store.findExecution(f.e.id)).sourceSha!,blob=await git(f.workspace,"rev-parse",`${sha}:tracked.txt`);
  await writeFile(join(f.workspace,"tracked.txt"),"changed\n");await rm(join(f.workspace,".git","objects",blob.slice(0,2),blob.slice(2)));
  const marker=join(f.root,"transport-ran.txt"),script=join(f.root,"transport.mjs"),slash=(p:string)=>p.replaceAll("\\","/");
  await writeFile(script,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'ran\\n');process.exit(1);\n`);
  for(const [key,value] of [["core.repositoryformatversion","1"],["extensions.partialClone","evil"],["remote.evil.url","ssh://salem.invalid/x"],["remote.evil.promisor","true"],["core.sshCommand",`"${slash(process.execPath)}" "${slash(script)}"`]] as const)await git(f.workspace,"config","--local",key,value);
  await repositorySnapshot(f.workspace,{readOnly:true}).catch(()=>null);await localPatch(f.workspace,sha,f.store.root).catch(()=>null);
  await assert.rejects(readFile(marker),{code:"ENOENT"});
 }finally{await f.m.shutdown();}
});

test("execution detail excludes ignored files and renders new binary files without dumping them",async()=>{
 const f=await diffFixture();
 try{
  await writeFile(join(f.workspace,".gitignore"),"ignored/\n");await mkdir(join(f.workspace,"ignored"));
  await writeFile(join(f.workspace,"ignored","large.txt"),"ignored content\n".repeat(200000));
  await writeFile(join(f.workspace,"asset.bin"),Buffer.from([0,1,2,...Buffer.from("binary content")]));
  const detail=await f.m.detail(f.e.id);
  assert.match(detail.diff,/Binary files \/dev\/null and b\/asset\.bin differ/);
  assert.doesNotMatch(detail.diff,/GIT binary patch|binary content|ignored content|diff --git a\/ignored\//);
 }finally{await f.m.shutdown();}
});

test("execution detail retains staged additions covered by a later ignore rule",async()=>{
 const f=await diffFixture();
 try{
  await writeFile(join(f.workspace,"staged.txt"),"already staged addition\n");await git(f.workspace,"add","staged.txt");
  await writeFile(join(f.workspace,".gitignore"),"staged.txt\n");await git(f.workspace,"update-index","--split-index");
  const status=await git(f.workspace,"status","--porcelain=v1"),index=await readFile(join(f.workspace,".git","index"));
  const detail=await f.m.detail(f.e.id);
  assert.match(detail.diff,/\+already staged addition/);
  assert.deepEqual(await readFile(join(f.workspace,".git","index")),index);assert.equal(await git(f.workspace,"status","--porcelain=v1"),status);
 }finally{await f.m.shutdown();}
});
test("execution detail compares committed and untracked additions against sourceSha",async()=>{
 const f=await diffFixture();
 try{
  await writeFile(join(f.workspace,"committed.txt"),"committed after source\n");await git(f.workspace,"add","committed.txt");
  await git(f.workspace,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-m","later addition");
  await writeFile(join(f.workspace,"untracked.txt"),"untracked after source\n");
  const detail=await f.m.detail(f.e.id);
  assert.match(detail.diff,/\+committed after source/);assert.match(detail.diff,/\+untracked after source/);
 }finally{await f.m.shutdown();}
});

test("execution detail rejects an oversized new diff and removes the temporary index",async()=>{
 const f=await diffFixture();
 try{
  await writeFile(join(f.workspace,"large.txt"),"x".repeat(2_100_000));
  const status=await git(f.workspace,"status","--porcelain=v1"),index=await readFile(join(f.workspace,".git","index"));
  const detail=await f.m.detail(f.e.id);
  assert.match(detail.diff,/No se pudo obtener el diff:.*budget exceeded/);
  assert.deepEqual(await readFile(join(f.workspace,".git","index")),index);assert.equal(await git(f.workspace,"status","--porcelain=v1"),status);
  assert.equal((await readdir(f.store.root)).some(name=>name.startsWith("diff-index-")),false);
 }finally{await f.m.shutdown();}
});

test("execution detail keeps its error path for missing or unowned workspaces",async()=>{
 const f=await diffFixture();
 try{
  await f.store.patchExecution(f.e.id,{workspace:join(f.root,"missing")});assert.match((await f.m.detail(f.e.id)).diff,/No se pudo obtener el diff:/);
  await f.store.patchExecution(f.e.id,{workspace:f.root});assert.match((await f.m.detail(f.e.id)).diff,/No se pudo obtener el diff:.*fuera del espacio/);
 }finally{await f.m.shutdown();}
});

test("a detected local-only profile completes with checked code and a diff without requiring commit authority",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};await f.store.saveProject({...project,config});const m=new Manager(f.store);await m.initialize();
 try{const e=await m.start(task.id,"local-only");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});assert.equal(done.status,"completed",done.reason??"");const detail=await m.detail(e.id);assert.equal(detail.metrics?.accepted,true);assert.equal(detail.run?.acceptance?.accepted,true);assert.equal(await git(done.workspace!,"rev-parse","HEAD"),done.sourceSha);assert.match(detail.diff,/return a\+b/);assert.match(detail.run?.delivery?.summary??"",/local|commit|diff/i);
 }finally{await m.shutdown();}
});
async function workTree(root:string):Promise<string>{
 // Tree of the work tree as Git sees it, computed with a throwaway index so the real index is untouched.
 const dir=await mkdtemp(join(tmpdir(),"salem tree ")),index=join(dir,"index");
 try{await copyFile(join(root,".git","index"),index);for(const args of [["add","--all"],["write-tree"]]){const r=await runProcess({command:["git",...args],cwd:root,env:{GIT_INDEX_FILE:index},timeoutMs:30000,maxOutputBytes:200000});if(r.status!=="exited"||r.exitCode!==0)throw Error(r.stderr);if(args[0]==="write-tree")return r.stdout.trim();}throw Error("unreachable");}
 finally{await rm(dir,{recursive:true,force:true});}
}
async function withEnv<T>(env:Record<string,string>,fn:()=>Promise<T>):Promise<T>{
 const saved=Object.fromEntries(Object.keys(env).map(key=>[key,process.env[key]]));Object.assign(process.env,env);
 try{return await fn();}finally{for(const [key,value] of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
// User diff settings that would break or reshape a patch if they leaked into the export.
const hostileDiff={GIT_DIFF_OPTS:"--unified=0",GIT_CONFIG_COUNT:"3",GIT_CONFIG_KEY_0:"diff.context",GIT_CONFIG_VALUE_0:"0",GIT_CONFIG_KEY_1:"diff.noprefix",GIT_CONFIG_VALUE_1:"true",GIT_CONFIG_KEY_2:"diff.mnemonicPrefix",GIT_CONFIG_VALUE_2:"true"};
test("an accepted execution exports a binary-safe patch that rebuilds its tree on a fresh clone of sourceSha",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};await f.store.saveProject({...project,config});
 // The fixture agent makes binary, new-directory, deletion, mode and mid-file changes before acceptance.
 const repo=project.config.repoRoot;await writeFile(join(repo,"patch-fixture.txt"),"remove me\n");await writeFile(join(repo,"context.txt"),Array.from({length:9},(_,i)=>`line ${i+1}\n`).join(""));
 await git(repo,"add","patch-fixture.txt","context.txt");await git(repo,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-q","-m","patch fixture");
 const m=new Manager(f.store);await m.initialize();
 try{
  assert.equal(typeof m.patch,"function","patch export missing");
  const e=await m.start(task.id,"patch");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});assert.equal(done.status,"completed",done.reason??"");
  const ws=done.workspace!,bytes=Buffer.from(Array.from({length:256},(_,i)=>i).filter(i=>i!==13));
  const status=await git(ws,"status","--porcelain=v1","--untracked-files=all"),index=await readFile(join(ws,".git","index"));
  const patch=await withEnv(hostileDiff,()=>m.patch(e.id));
  assert.deepEqual(await readFile(join(ws,".git","index")),index);assert.equal(await git(ws,"status","--porcelain=v1","--untracked-files=all"),status);
  assert.ok(Buffer.isBuffer(patch.data));assert.match(patch.name,/^salem-[a-f0-9]{8}\.patch$/);
  const text=patch.data.toString("latin1");assert.match(text,/GIT binary patch/);assert.match(text,/deleted file mode/);assert.match(text,/new mode 100755/);assert.match(text,/return a\+b/);assert.match(text,/^index [a-f0-9]{40}\.\.[a-f0-9]{40}/m);
  assert.match(text,/^diff --git a\/context\.txt b\/context\.txt$/m);assert.match(text,/^@@ -2,7 \+2,7 @@/m);
  const clone=join(f.root,"fresh clone"),file=join(f.root,"accepted.patch");await git(f.root,"clone","--quiet","--no-checkout",repo,clone);await git(clone,"checkout","--quiet","--detach",done.sourceSha!);await writeFile(file,patch.data);
  await git(clone,"apply","--3way","--check",file);await git(clone,"apply","--3way",file);
  assert.equal(await git(clone,"write-tree"),await workTree(ws));assert.deepEqual(await readFile(join(clone,"new dir","deep","asset.bin")),bytes);
  assert.equal((await readdir(f.store.root)).some(name=>/^(?:diff-index|patch)-/.test(name)),false);
  // Edits after acceptance were never reviewed: the export refuses them, and works again once reverted.
  await writeFile(join(ws,"unreviewed.txt"),"after acceptance\n");await assert.rejects(m.patch(e.id),(error:Error&{status?:number})=>error.status===409&&/ya no coincide con el resultado aceptado/.test(error.message));
  await rm(join(ws,"unreviewed.txt"));await writeFile(join(ws,"context.txt"),"rewritten\n");await assert.rejects(m.patch(e.id),(error:Error&{status?:number})=>error.status===409);
  await writeFile(join(ws,"context.txt"),(await readFile(join(clone,"context.txt"),"utf8")));assert.deepEqual((await m.patch(e.id)).data,patch.data);
  // A replace ref that maps a source blob to its accepted content would make Git hide that change.
  const original=await git(ws,"rev-parse",`${done.sourceSha}:context.txt`),accepted=await git(ws,"hash-object","-w","context.txt");
  await git(ws,"replace",original,accepted);assert.deepEqual((await m.patch(e.id)).data,patch.data);await git(ws,"replace","-d",original);
  // Conversion config added after acceptance must not reshape the accepted bytes: filters from any config level and
  // core.attributesFile are neutralized, and conversion settings Salem never creates in the copy are refused.
  const evil=join(f.root,"evil-filter.mjs"),attributes=join(f.root,"evil.attributes"),slash=(p:string)=>p.replaceAll("\\","/");
  // The script also leaves a marker: no command configured after acceptance may run during export or its checks.
  const marker=join(f.root,"evil-ran.txt"),command=`"${slash(process.execPath)}" "${slash(evil)}"`;
  await writeFile(evil,`import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(marker)},'ran\\n');process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('FILTERED\\n'));\n`);await writeFile(attributes,"*.txt filter=evil\n");
  await git(ws,"config","--local","filter.evil.clean",command);await git(ws,"config","--local","core.attributesFile",slash(attributes));await git(ws,"config","--local","core.fsmonitor",command);
  assert.deepEqual((await m.patch(e.id)).data,patch.data);
  const info=join(ws,".git","info");await mkdir(info,{recursive:true});await copyFile(attributes,join(info,"attributes"));
  await assert.rejects(m.patch(e.id),(error:Error&{status?:number})=>error.status===409&&/atributos|conversión/.test(error.message));
  await rm(join(info,"attributes"));await git(ws,"config","--local","core.autocrlf","true");
  await assert.rejects(m.patch(e.id),(error:Error&{status?:number})=>error.status===409&&/atributos|conversión/.test(error.message));
  // The same setting through config.worktree (extensions.worktreeConfig) is refused too.
  await git(ws,"config","--local","--unset","core.autocrlf");await git(ws,"config","--local","extensions.worktreeConfig","true");await git(ws,"config","--worktree","core.autocrlf","true");
  await assert.rejects(m.patch(e.id),(error:Error&{status?:number})=>error.status===409&&/atributos|conversión/.test(error.message));
  await git(ws,"config","--worktree","--unset","core.autocrlf");await git(ws,"config","--local","--unset","extensions.worktreeConfig");await git(ws,"config","--local","core.autocrlf","true");
  for(const key of ["core.autocrlf","core.attributesFile","filter.evil.clean","core.fsmonitor"])await git(ws,"config","--local","--unset",key);
  assert.deepEqual((await m.patch(e.id)).data,patch.data);
  await assert.rejects(readFile(marker),{code:"ENOENT"});
  // An ignored .gitattributes is invisible to the acceptance snapshot, so it must not steer the export either.
  const hidden=join(ws,"new dir",".gitattributes");await writeFile(join(info,"exclude"),"new dir/.gitattributes\n");await writeFile(hidden,"* ident\n");
  await assert.rejects(m.patch(e.id),(error:Error&{status?:number})=>error.status===409&&/atributos|conversión|ya no coincide/.test(error.message));
  await rm(hidden);await rm(join(info,"exclude"));
  assert.deepEqual((await m.patch(e.id)).data,patch.data);
  assert.equal((await readdir(f.store.root)).some(name=>/^(?:diff-index|patch)-/.test(name)),false);
  await rm(ws,{recursive:true,force:true});await assert.rejects(m.patch(e.id),(error:Error&{status?:number})=>error.status===410);
 }finally{await m.shutdown();}
});
// Everything in the user's repository that branch creation must leave byte-for-byte unchanged.
async function userRepoState(repo:string,except:string){
 const refs=(await git(repo,"for-each-ref","--format=%(refname) %(objectname)")).split("\n").filter(line=>!line.startsWith(except+" "));
 return {refs,head:await readFile(join(repo,".git","HEAD")),index:await readFile(join(repo,".git","index")),status:await git(repo,"--no-optional-locks","status","--porcelain=v1","--untracked-files=all"),stash:await git(repo,"stash","list","--format=%H %gs"),
  files:await Promise.all(["sum.mjs","context.txt","draft.txt"].map(name=>readFile(join(repo,name)).catch(()=>null))),fetchHead:await readFile(join(repo,".git","FETCH_HEAD")).catch(()=>null)};
}
test("an accepted execution creates a new local branch with its exact tree without touching the user's checkout",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};await f.store.saveProject({...project,config});
 const repo=project.config.repoRoot;await writeFile(join(repo,"patch-fixture.txt"),"remove me\n");await writeFile(join(repo,"context.txt"),Array.from({length:9},(_,i)=>`line ${i+1}\n`).join(""));
 await git(repo,"add","patch-fixture.txt","context.txt");await git(repo,"-c","user.name=Test","-c","user.email=test@example.invalid","commit","-q","-m","patch fixture");
 const m=new Manager(f.store);await m.initialize();
 try{
  assert.equal(typeof m.branch,"function","branch creation missing");
  const e=await m.start(task.id,"branch");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});assert.equal(done.status,"completed",done.reason??"");
  const ws=done.workspace!,wsStatus=await git(ws,"status","--porcelain=v1","--untracked-files=all"),wsIndex=await readFile(join(ws,".git","index")),patch=await m.patch(e.id);
  // The user keeps working: another branch checked out, a stash, staged and untracked changes.
  await git(repo,"switch","-q","-c","work");await writeFile(join(repo,"sum.mjs"),"stashed\n");await git(repo,"stash","push","-q","-m","user stash");
  await writeFile(join(repo,"context.txt"),"staged by the user\n");await git(repo,"add","context.txt");await writeFile(join(repo,"draft.txt"),"untracked\n");
  const empty=join(f.root,"empty.gitconfig");await writeFile(empty,"");
  await withEnv({GIT_CONFIG_GLOBAL:empty},()=>assert.rejects(m.branch(e.id,"salem/sin-identidad"),(error:Error&{status?:number})=>error.status===409&&/git config user\.name/.test(error.message)&&/git config user\.email/.test(error.message)));
  await git(repo,"config","user.name","Repo Owner");await git(repo,"config","user.email","owner@example.invalid");
  const before=await userRepoState(repo,"");
  for(const name of ["refs/heads/x","-x","a..b","con espacio","x.lock","@{-1}","a/","",`x${"y".repeat(300)}`])await assert.rejects(m.branch(e.id,name),(error:Error&{status?:number})=>error.status===400,name);
  const demo=await git(repo,"rev-parse","refs/heads/demo");
  await assert.rejects(m.branch(e.id,"demo"),(error:Error&{status?:number})=>error.status===409&&/refs\/heads\/demo/.test(error.message));
  assert.equal(await git(repo,"rev-parse","refs/heads/demo"),demo);assert.deepEqual(await userRepoState(repo,""),before);
  // Edits after acceptance were never reviewed.
  await writeFile(join(ws,"unreviewed.txt"),"after acceptance\n");await assert.rejects(m.branch(e.id),(error:Error&{status?:number})=>error.status===409&&/ya no coincide con el resultado aceptado/.test(error.message));await rm(join(ws,"unreviewed.txt"));
  const hookLog=join(f.root,"hook-ran.txt");await mkdir(join(repo,".git","hooks"),{recursive:true});await writeFile(join(repo,".git","hooks","reference-transaction"),`#!/bin/sh\necho ran >> '${hookLog.replaceAll("\\","/")}'\n`,{mode:0o755});
  const created=await withEnv({GIT_AUTHOR_NAME:"Leaked",GIT_COMMITTER_EMAIL:"leaked@example.invalid"},()=>m.branch(e.id));
  assert.equal(await readFile(hookLog).then(()=>true,()=>false),false,"a hook ran in the user's repository");
  assert.match(created.ref,/^refs\/heads\/salem\/[a-z0-9-]+-[a-f0-9]{8}$/);assert.ok(created.ref.endsWith(e.id.slice(0,8)));assert.match(created.commit,/^[a-f0-9]{40,64}$/);
  assert.equal(await git(repo,"rev-parse",created.ref),created.commit);assert.equal(await git(repo,"rev-parse",`${created.commit}^`),done.sourceSha);
  assert.equal(await git(repo,"rev-parse",`${created.commit}^{tree}`),await workTree(ws));
  assert.equal(await git(repo,"cat-file","-e",`${created.commit}:patch-fixture.txt`).then(()=>true,()=>false),false);
  assert.match(await git(repo,"ls-tree",created.commit,"sum.mjs"),/^100755 /);
  const bin=join(f.root,"asset.bin");await writeFile(bin,Buffer.from(Array.from({length:256},(_,i)=>i).filter(i=>i!==13)));
  assert.equal(await git(repo,"rev-parse",`${created.commit}:new dir/deep/asset.bin`),await git(repo,"hash-object","--no-filters",bin));
  assert.equal(await git(repo,"log","-1","--format=%an <%ae>|%cn <%ce>",created.commit),"Repo Owner <owner@example.invalid>|Repo Owner <owner@example.invalid>");
  assert.match(await git(repo,"log","-1","--format=%B",created.commit),new RegExp(e.id));
  assert.deepEqual(await userRepoState(repo,created.ref),before);
  assert.deepEqual(await readFile(join(ws,".git","index")),wsIndex);assert.equal(await git(ws,"status","--porcelain=v1","--untracked-files=all"),wsStatus);assert.equal(await git(ws,"rev-parse","HEAD"),done.sourceSha);
  assert.deepEqual((await m.patch(e.id)).data,patch.data);
  const record=(await f.store.findExecution(e.id)).branch;assert.equal(record?.ref,created.ref);assert.equal(record?.commit,created.commit);assert.equal(typeof record?.createdAt,"number");
  await assert.rejects(m.branch(e.id,"salem/otra"),(error:Error&{status?:number})=>error.status===409&&error.message.includes(created.ref));
  assert.equal((await readdir(f.store.root)).some(name=>/^(?:diff-index|patch|branch)-/.test(name)),false);
  // The hook is live: a plain ref update in the user's repository runs it.
  await git(repo,"update-ref","refs/salem-probe",created.commit);assert.ok(await readFile(hookLog));

  await rm(ws,{recursive:true,force:true});await f.store.patchExecution(e.id,{branch:undefined} as never);await assert.rejects(m.branch(e.id),(error:Error&{status?:number})=>error.status===410);
 }finally{await m.shutdown();}
});
test("branch creation ignores hostile repository config, never follows a symbolic ref and recovers an unrecorded branch",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};await f.store.saveProject({...project,config});
 const repo=project.config.repoRoot,m=new Manager(f.store);await m.initialize();
 try{
  const e=await m.start(task.id,"hostile");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});assert.equal(done.status,"completed",done.reason??"");
  await git(repo,"config","user.name","Repo Owner");await git(repo,"config","user.email","owner@example.invalid");
  const sentinel=join(f.root,"sentinel.txt"),script=join(f.root,"sentinel.mjs"),ran=()=>readFile(sentinel).then(()=>true,()=>false);
  await writeFile(script,`import {appendFileSync} from "node:fs";appendFileSync(${JSON.stringify(sentinel)},"ran\\n");`);
  // insteadOf rewrites the copy's path to ext::, which would run a command if any protocol but file were allowed.
  const ext=(text:string)=>text.replaceAll("%","%%").replaceAll(" ","% ");
  await git(repo,"config",`url.ext::${ext(process.execPath)} ${ext(script)}.insteadOf`,done.workspace!);await git(repo,"config","protocol.ext.allow","always");
  await assert.rejects(m.branch(e.id,"salem/ext"));assert.equal(await ran(),false,"ext:: command ran");
  assert.equal((await f.store.findExecution(e.id)).branch,undefined);assert.equal(await git(repo,"for-each-ref","refs/heads/salem/ext"),"");
  await git(repo,"config","--remove-section",`url.ext::${ext(process.execPath)} ${ext(script)}`);
  // A dangling symbolic ref at the requested name must not redirect creation to its target.
  await git(repo,"symbolic-ref","refs/heads/salem/x","refs/heads/other");
  await assert.rejects(m.branch(e.id,"salem/x"),(error:Error&{status?:number})=>error.status===409);
  assert.equal(await git(repo,"for-each-ref","refs/heads/other"),"");assert.equal(await git(repo,"symbolic-ref","refs/heads/salem/x"),"refs/heads/other");assert.equal((await f.store.findExecution(e.id)).branch,undefined);
  // Alternates make fetch ask core.alternateRefsCommand for their refs.
  const alt=join(f.root,"alt");await mkdir(alt);await git(alt,"init","-q");await writeFile(join(alt,"z.txt"),"z\n");await git(alt,"add","z.txt");await git(alt,"-c","user.name=T","-c","user.email=t@example.invalid","commit","-q","-m","z");
  await mkdir(join(repo,".git","objects","info"),{recursive:true});await writeFile(join(repo,".git","objects","info","alternates"),join(alt,".git","objects").replaceAll("\\","/")+"\n");
  await git(repo,"config","core.alternateRefsCommand",`"${process.execPath.replaceAll("\\","/")}" "${script.replaceAll("\\","/")}"; true`);
  // The receipt write after update-ref fails twice; retries finish the same branch instead of creating another.
  const original=f.store.patchExecution.bind(f.store);let failures=2;
  f.store.patchExecution=async(id,patch)=>{if(patch.branch&&!patch.branch.pending&&failures>0){failures--;throw Error("simulated crash after update-ref");}return original(id,patch);};
  await assert.rejects(m.branch(e.id,"salem/recover"),/simulated crash/);assert.equal(await ran(),false,"alternateRefsCommand ran");
  const ref="refs/heads/salem/recover",first=(await f.store.findExecution(e.id)).branch!;assert.equal(first.pending,true);assert.equal(first.ref,ref);assert.equal(await git(repo,"rev-parse",ref),first.commit);
  await assert.rejects(m.branch(e.id,"salem/otra"),(error:Error&{status?:number})=>error.status===409&&error.message.includes(ref));
  // The ref vanished before the retry: it is created again under the same name.
  await git(repo,"update-ref","-d",ref);await assert.rejects(m.branch(e.id),/simulated crash/);
  const second=(await f.store.findExecution(e.id)).branch!;assert.equal(second.pending,true);assert.equal(second.ref,ref);assert.equal(await git(repo,"rev-parse",ref),second.commit);
  // A ref moved to another commit is never claimed or overwritten.
  await git(repo,"update-ref",ref,done.sourceSha!);await assert.rejects(m.branch(e.id),(error:Error&{status?:number})=>error.status===409);assert.equal(await git(repo,"rev-parse",ref),done.sourceSha);
  await git(repo,"update-ref",ref,second.commit);
  const settled=await m.branch(e.id);assert.deepEqual(settled,{ref,commit:second.commit});
  const record=(await f.store.findExecution(e.id)).branch!;assert.equal(record.pending,undefined);assert.equal(record.commit,second.commit);
  assert.equal(await git(repo,"rev-parse",`${second.commit}^`),done.sourceSha);assert.equal(await ran(),false);
  await assert.rejects(m.branch(e.id),(error:Error&{status?:number})=>error.status===409&&error.message.includes(ref));
 }finally{await m.shutdown();}
});
test("shutdown waits for an in-flight branch creation and a new manager sees its receipt",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),config=structuredClone(project.config);delete config.delivery;config.capabilities={edit:true,commit:false,pull_request:false,merge:false,deploy:false};await f.store.saveProject({...project,config});
 const repo=project.config.repoRoot;let reached=false,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});
 const m=new Manager(f.store,{beforeBranchFetch:async()=>{reached=true;await gate;}});await m.initialize();
 try{
  const e=await m.start(task.id,"shutdown-branch");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});assert.equal(done.status,"completed",done.reason??"");
  await git(repo,"config","user.name","Repo Owner");await git(repo,"config","user.email","owner@example.invalid");
  const inFlight=m.branch(e.id,"salem/shutdown");await until(async()=>reached||undefined);
  let closed=false;const closing=m.shutdown().then(()=>{closed=true;});
  await new Promise(resolve=>setTimeout(resolve,300));assert.equal(closed,false,"shutdown resolved while a branch was being created");
  await assert.rejects(m.branch(e.id,"salem/otra"),(error:Error&{status?:number})=>error.status===409&&/cerrando/.test(error.message));
  release();const created=await inFlight;await closing;
  assert.deepEqual((await f.store.findExecution(e.id)).branch,{ref:"refs/heads/salem/shutdown",commit:created.commit,createdAt:(await f.store.findExecution(e.id)).branch!.createdAt});
  assert.equal(await git(repo,"rev-parse","refs/heads/salem/shutdown"),created.commit);
  const next=new Manager(f.store,{autoStart:false});await next.initialize();
  try{await assert.rejects(next.branch(e.id,"salem/segunda"),(error:Error&{status?:number})=>error.status===409&&error.message.includes(created.ref));}finally{await next.shutdown();}
  assert.equal(await git(repo,"for-each-ref","refs/heads/salem/segunda"),"");
 }finally{release();await m.shutdown();}
});
test("startup finishes a pending branch receipt whose ref already points at its commit",async()=>{
 const f=await diffFixture();
 try{
  const repo=f.workspace,commit=await git(repo,"rev-parse","HEAD"),ref="refs/heads/salem/pending";
  await f.store.patchExecution(f.e.id,{project:{...f.e.project,config:{...f.e.project.config,repoRoot:repo}},branch:{ref,commit,createdAt:1,pending:true}});
  await git(repo,"update-ref",ref,commit);
  const {Manager}=await modules(),reopened=new Manager(f.store,{autoStart:false});await reopened.initialize();
  assert.deepEqual((await f.store.findExecution(f.e.id)).branch,{ref,commit,createdAt:1});await reopened.shutdown();
 }finally{await f.m.shutdown();}
});
test("branch creation rejects unknown and not accepted executions",async()=>{
 const f=await diffFixture();
 try{
  assert.equal(typeof f.m.branch,"function","branch creation missing");
  await assert.rejects(f.m.branch(randomUUID()),(error:Error&{status?:number})=>error.status===404);
  await assert.rejects(f.m.branch(f.e.id),(error:Error&{status?:number})=>error.status===409);
  await f.store.patchExecution(f.e.id,{status:"completed"});await assert.rejects(f.m.branch(f.e.id),(error:Error&{status?:number})=>error.status===409);
 }finally{await f.m.shutdown();}
});
test("patch generation rejects output over the Git limit and leaves no temporary files",async()=>{
 const f=await diffFixture();
 try{
  const {localPatch}=await import("../src/local/git.js");
  await writeFile(join(f.workspace,"large.bin"),randomBytes(1_700_000));
  await assert.rejects(localPatch(f.workspace,await git(f.workspace,"rev-parse","HEAD"),f.store.root),(error:Error&{status?:number})=>error.status===413&&/límite/.test(error.message));
  assert.equal((await readdir(f.store.root)).some(name=>/^(?:diff-index|patch)-/.test(name)),false);
 }finally{await f.m.shutdown();}
});
test("patch export rejects unknown and not accepted executions",async()=>{
 const f=await diffFixture();
 try{
  assert.equal(typeof f.m.patch,"function","patch export missing");
  await assert.rejects(f.m.patch(randomUUID()),(error:Error&{status?:number})=>error.status===404);
  await assert.rejects(f.m.patch(f.e.id),(error:Error&{status?:number})=>error.status===409);
  await f.store.patchExecution(f.e.id,{status:"completed"});await assert.rejects(f.m.patch(f.e.id),(error:Error&{status?:number})=>error.status===409);
 }finally{await f.m.shutdown();}
});
test("duplicate starts reserve once, freeze configuration and cancel a queued execution",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),m=new Manager(f.store,{autoStart:false});await m.initialize();
 const [a,b]=await Promise.all([m.start(task.id,"same-request"),m.start(task.id,"same-request")]);assert.equal(a.id,b.id);assert.equal((await f.store.readState()).executions.length,1);
 await f.store.saveProject({...project,name:"Changed",config:{...project.config,instructions:"Later settings"}});
 assert.equal((await f.store.findExecution(a.id)).project.name,project.name);
 assert.equal((await f.store.findExecution(a.id)).project.config.instructions,project.config.instructions);
 const cancelled=await m.cancel(a.id);assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.runId,null);await m.shutdown();
});
test("real fixture pipeline accepts code in an independent Git copy and can continue from its delivery",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store),m=new Manager(f.store);await m.initialize();
 const beforeHead=await git(project.config.repoRoot,"rev-parse","HEAD"),before=await readFile(join(project.config.repoRoot,"sum.mjs"),"utf8");
 try{const e=await m.start(task.id,"first");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});
 assert.equal(done.status,"completed",done.reason??"");assert.notEqual(done.workspace,project.config.repoRoot);
 const detail=await m.detail(done.id);assert.equal(detail.metrics?.accepted,true);assert.equal(detail.run?.acceptance?.accepted,true);assert.match(detail.diff,/return a\+b/);
 assert.equal(await git(project.config.repoRoot,"rev-parse","HEAD"),beforeHead);assert.equal(await git(project.config.repoRoot,"status","--porcelain"),"");assert.equal(await readFile(join(project.config.repoRoot,"sum.mjs"),"utf8"),before);
 const next=await m.start(task.id,"continue",done.id);const second=await until(async()=>{const r=await f.store.findExecution(next.id);return ["completed","failed","blocked"].includes(r.status)?r:undefined;});
 assert.equal(second.status,"completed",second.reason??"");assert.equal(second.sourceSha,detail.run!.deliveryJournal!.commitSha);
 }finally{await m.shutdown();}
});
test("failed preparation preserves output and never starts a core run",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{project,task}=await createDemo(f.store);
 await f.store.saveProject({...project,preparation:[[process.execPath,"-e","console.error('setup failed');process.exit(7)"]]});const m=new Manager(f.store);await m.initialize();
 try{const e=await m.start(task.id,"setup");const done=await until(async()=>{const r=await f.store.findExecution(e.id);return r.status==="failed"?r:undefined;});assert.equal(done.runId,null);assert.match(done.reason??"",/prepara/i);const d=await m.detail(done.id);assert.ok(d.artifacts.length);const log=await m.artifact(done.id,done.preparationLogs[0]!,0);assert.match(log.text,/setup failed/);}finally{await m.shutdown();}
});
test("restart preserves an interrupted run and never creates a fallback; artifacts cannot escape",async()=>{
 const {Manager,createDemo}=await modules(),f=await fixture(),{task}=await createDemo(f.store),m=new Manager(f.store,{autoStart:false});await m.initialize();const e=await m.start(task.id,"interrupted");await m.shutdown();await f.store.patchExecution(e.id,{status:"running"});
 const reopened=new Manager(f.store,{autoStart:false});await reopened.initialize();assert.equal((await f.store.findExecution(e.id)).status,"interrupted");
 const result=await reopened.resume(e.id);assert.equal(result.status,"blocked");assert.equal((await f.store.readState()).executions.length,1);
 const outside=join(f.root,"outside");await mkdir(outside);await writeFile(join(outside,"private.txt"),"private");const dir=join(f.store.root,"executions",e.id);await mkdir(dir,{recursive:true});await symlink(outside,join(dir,"linked"),process.platform==="win32"?"junction":"dir");
 await assert.rejects(reopened.artifact(e.id,"../../outside/private.txt",0),/ruta|artefact|permit|fuera/i);await assert.rejects(reopened.artifact(e.id,"linked/private.txt",0),/ruta|artefact|permit|fuera/i);await reopened.shutdown();
});
