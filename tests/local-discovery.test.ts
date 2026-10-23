import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings } from "../src/local/contracts.js";
import { parseProjectConfig } from "../src/config.js";
import { localGit } from "../src/local/git.js";

async function fixture() {
 const root=await mkdtemp(join(tmpdir(),"salem discovery ")),repo=join(root,"source"),data=join(root,"data");await mkdir(repo);await mkdir(data);
 const git=(args:string[])=>localGit(repo,args,data);
 await git(["init","--template=","-b","demo"]);
 return {root,repo,data,git,commit:async()=>{await git(["add","--all"]);await git(["-c","user.name=Salem Test","-c","user.email=test@example.invalid","commit","-m","fixture"]);}};
}
async function discovery(){const module=await import("../src/local/discovery.js").catch(()=>({discoverProject:undefined}));assert.equal(typeof module.discoverProject,"function","project discovery missing");return module.discoverProject!;}
test("discovery proposes a valid native-account profile from committed Node scripts without running them",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"AGENTS.md"),"Read README.md before changing code.\n");await writeFile(join(f.repo,"README.md"),"# Example\n");await writeFile(join(f.repo,"package.json"),JSON.stringify({name:"my-project",scripts:{test:"node -e \"require('fs').writeFileSync('RAN','bad')\"",typecheck:"tsc --noEmit",lint:"eslint ."}}));await writeFile(join(f.repo,"pnpm-lock.yaml"),"lockfileVersion: '9.0'\n");await f.commit();
 const before=await f.git(["status","--porcelain"]),head=await f.git(["rev-parse","HEAD"]),discover=await discovery(),result=await discover(f.repo,defaultSettings(),"codex",f.data);
 assert.equal(result.sourceSha,head);assert.equal(result.suggested.baseRef,head);assert.ok(result.stack.includes("Node.js"));assert.ok(result.contextFiles.includes("AGENTS.md"));assert.deepEqual(result.suggested.config.checks.map(c=>c.command),[["pnpm","run","test"],["pnpm","run","typecheck"],["pnpm","run","lint"]]);
 assert.equal(result.suggested.config.agents.codex!.ignoreUserConfig,true);assert.equal(result.suggested.config.agents.codex!.model,undefined);assert.deepEqual(result.suggested.config.supervisor!.roles,{define:"codex",build:"codex",review:"codex"});assert.deepEqual(result.suggested.preparation,[]);assert.deepEqual(result.suggested.config.capabilities,{edit:true,commit:false,pull_request:false,merge:false,deploy:false});await parseProjectConfig(result.suggested.config);
 await assert.rejects(readFile(join(f.repo,"RAN")),/ENOENT/);assert.equal(await f.git(["status","--porcelain"]),before);assert.equal(await f.git(["rev-parse","HEAD"]),head);
});
test("demo checker is discovered and dirty or untracked content is reported, not treated as committed evidence",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"AGENTS.md"),"# Demo\n");await writeFile(join(f.repo,"sum.mjs"),"export const sum=(a,b)=>a-b;\n");await writeFile(join(f.repo,".salem-check.mjs"),"console.log('check');\n");await f.commit();await writeFile(join(f.repo,"private.txt"),"untracked");await writeFile(join(f.repo,"sum.mjs"),"working change\n");
 const result=await(await discovery())(f.repo,defaultSettings(),"claude",f.data);assert.deepEqual(result.suggested.config.checks[0]!.command,[process.execPath,".salem-check.mjs"]);assert.deepEqual(result.suggested.config.checks[0]!.toolFiles,[".salem-check.mjs"]);assert.ok(!result.files.includes("private.txt"));assert.match(result.warnings.join(" "),/sin confirmar|no versionad|working|commit/i);assert.equal(result.suggested.config.agents.claude!.provider,"claude");
});
test("unknown stacks retain a real context file and explain missing checks; subdirectories and unborn repos are rejected",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"hello.txt"),"Some source\n");await mkdir(join(f.repo,"nested"));await f.commit();const discover=await discovery();const result=await discover(f.repo,defaultSettings(),"claude",f.data);assert.deepEqual(result.contextFiles,["hello.txt"]);assert.deepEqual(result.suggested.config.checks,[]);assert.match(result.warnings.join(" "),/check|verific|stack/i);await parseProjectConfig(result.suggested.config);await assert.rejects(discover(join(f.repo,"nested"),defaultSettings(),"claude",f.data),/raíz|root/i);const empty=await fixture();await assert.rejects(discover(empty.repo,defaultSettings(),"claude",empty.data));
});
test("discovery identifies Python, Rust and Go without invoking their tools",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"README.md"),"# Multi\n");await writeFile(join(f.repo,"pyproject.toml"),"[tool.pytest.ini_options]\ntestpaths=['tests']\n");await writeFile(join(f.repo,"Cargo.toml"),"[package]\nname='demo'\nversion='0.1.0'\n");await writeFile(join(f.repo,"go.mod"),"module example.invalid/demo\n");await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.ok(result.stack.includes("Python"));assert.ok(result.stack.includes("Rust"));assert.ok(result.stack.includes("Go"));assert.ok(result.suggested.config.checks.some(c=>c.command.join(" ")==="python -m pytest"));assert.ok(result.suggested.config.checks.some(c=>c.command.join(" ")==="cargo test"));assert.ok(result.suggested.config.checks.some(c=>c.command.join(" ")==="go test ./..."));
});
test("bounded discovery keeps root instructions and reports omitted inventory instead of inventing coverage",async()=>{
 const f=await fixture();await mkdir(join(f.repo,"src"));await writeFile(join(f.repo,"AGENTS.md"),"# Instructions\n");await Promise.all(Array.from({length:1003},(_,i)=>writeFile(join(f.repo,"src",`file-${String(i).padStart(4,"0")}.txt`),"source\n")));await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.equal(result.files.length,1000);assert.equal(result.truncated,true);assert.ok(result.contextFiles.includes("AGENTS.md"));assert.match(result.warnings.join(" "),/1000/);
});
test("discovery never runs configured Git clean filters while detecting same-size working changes",async()=>{
 const f=await fixture(),marker=join(f.root,"filter-ran"),filter=join(f.root,"filter.mjs");await writeFile(join(f.repo,"AGENTS.md"),"# Demo\n");await writeFile(join(f.repo,"README.md"),"AAAA\n");await writeFile(join(f.repo,".gitattributes"),"README.md filter=salem\n");await f.commit();
 await writeFile(filter,`import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'ran');for await(const chunk of process.stdin)process.stdout.write(chunk);`);
 await f.git(["config","--local","filter.salem.clean",`"${process.execPath.replaceAll("\\","/")}" "${filter.replaceAll("\\","/")}"`]);await writeFile(join(f.repo,"README.md"),"BBBB\n");
 const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);await assert.rejects(readFile(marker),/ENOENT/);assert.match(result.warnings.join(" "),/sin confirmar/);
});
