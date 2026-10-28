import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
test("discovery proposes Django checks from root manage.py without running it",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"manage.py"),"from pathlib import Path\nPath('RAN').write_text('bad')\n");await f.commit();const before=await f.git(["status","--porcelain"]),head=await f.git(["rev-parse","HEAD"]),result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);
 assert.deepEqual(result.stack,["Python","Django"]);assert.deepEqual(result.suggested.config.checks,[{id:"django-check",command:["python","manage.py","check"],required:true,toolFiles:["manage.py"]}]);assert.match(result.warnings.join(" "),/Django/);assert.match(result.warnings.join(" "),/DJANGO_SETTINGS_MODULE/);assert.match(result.warnings.join(" "),/dependenc/i);assert.match(result.warnings.join(" "),/ajust/i);await parseProjectConfig(result.suggested.config);
 await assert.rejects(readFile(join(f.repo,"RAN")),/ENOENT/);assert.equal(result.sourceSha,head);assert.equal(await f.git(["rev-parse","HEAD"]),head);assert.equal(await f.git(["status","--porcelain"]),before);
});
for(const [file,content,label] of [
 ["ruff.toml","line-length = 88\n","ruff.toml"],[".ruff.toml","",".ruff.toml"],
 ["pyproject.toml","[tool.ruff]\nline-length = 88\n","tool table"],["pyproject.toml","[tool.ruff.lint]\nselect = ['E']\n","nested tool table"],
 ["requirements.txt","Django>=5\nruff>=0.9\n","requirements dependency"],["pyproject.toml","[project]\ndependencies = ['ruff>=0.9']\n","project dependency"],
 ["pyproject.toml","[tool.poetry.dependencies]\nruff = '^0.9'\n","Poetry dependency"],["pyproject.toml","[project]\ndescription = 'ruff notes'\n","accepted unrelated string false positive"]
])test(`discovery proposes ruff from ${label}`,async()=>{
 const f=await fixture();await writeFile(join(f.repo,"README.md"),"# Python\n");await writeFile(join(f.repo,file!),content!);await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);
 assert.deepEqual(result.stack,["Python"]);assert.deepEqual(result.suggested.config.checks,[{id:"ruff",command:["python","-m","ruff","check","."],required:true,toolFiles:[file]}]);await parseProjectConfig(result.suggested.config);
});
test("discovery combines Django, pytest and every ruff marker without duplicate checks",async()=>{
 const f=await fixture();for(const [file,content] of Object.entries({"manage.py":"raise RuntimeError('must not run')\n","pyproject.toml":"[project]\ndependencies = ['pytest', 'ruff']\n[tool.ruff.lint]\nselect = ['E']\n","requirements.txt":"pytest\nruff\n","ruff.toml":"line-length = 88\n",".ruff.toml":"line-length = 88\n"}))await writeFile(join(f.repo,file),content);await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data),checks=result.suggested.config.checks;
 assert.deepEqual(result.stack,["Python","Django"]);assert.deepEqual(checks.map(c=>c.id).sort(),["django-check","pytest","ruff"]);assert.equal(new Set(checks.map(c=>c.id)).size,checks.length);assert.deepEqual(checks.find(c=>c.id==="pytest"),{id:"pytest",command:["python","-m","pytest"],required:true,toolFiles:["pyproject.toml"]});assert.deepEqual(checks.find(c=>c.id==="ruff")?.toolFiles,["pyproject.toml","requirements.txt","ruff.toml",".ruff.toml"]);await parseProjectConfig(result.suggested.config);
});
for(const [file,content] of [["pyproject.toml","[project]\ndependencies = ['requests']\n"],["requirements.txt","Django>=5\n"],["setup.py","raise RuntimeError('must not run')\n"]])test(`discovery keeps Python without Django, pytest or ruff for ${file}`,async()=>{
 const f=await fixture();await writeFile(join(f.repo,"README.md"),"# Python\n");await writeFile(join(f.repo,file!),content!);await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.deepEqual(result.stack,["Python"]);assert.deepEqual(result.suggested.config.checks,[]);
});
test("discovery preserves pytest proposals from requirements alone",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"requirements.txt"),"pytest>=8\n");await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.deepEqual(result.stack,["Python"]);assert.deepEqual(result.suggested.config.checks,[{id:"pytest",command:["python","-m","pytest"],required:true}]);
});
test("discovery reads committed Python markers despite dirty and untracked replacements",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"pyproject.toml"),"[project]\ndependencies = ['requests']\n");await f.commit();await writeFile(join(f.repo,"pyproject.toml"),"[tool.ruff]\n");await writeFile(join(f.repo,"manage.py"),"raise RuntimeError('must not run')\n");await writeFile(join(f.repo,"ruff.toml"),"line-length = 88\n");const discover=await discovery(),absent=await discover(f.repo,defaultSettings(),"codex",f.data);assert.deepEqual(absent.suggested.config.checks,[]);assert.deepEqual(absent.stack,["Python"]);
 await f.commit();await writeFile(join(f.repo,"pyproject.toml"),"[project]\ndependencies = []\n");const present=await discover(f.repo,defaultSettings(),"codex",f.data);assert.ok(present.stack.includes("Django"));assert.deepEqual(present.suggested.config.checks.find(c=>c.id==="ruff")?.toolFiles,["pyproject.toml","ruff.toml"]);
});
test("discovery ignores nested manage.py and root marker directories",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"README.md"),"# Nested\n");await mkdir(join(f.repo,"nested"));await writeFile(join(f.repo,"nested","manage.py"),"raise RuntimeError('must not run')\n");await mkdir(join(f.repo,"manage.py"));await writeFile(join(f.repo,"manage.py","source.txt"),"not a root file\n");await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.deepEqual(result.stack,[]);assert.deepEqual(result.suggested.config.checks,[]);
});
for(const file of ["manage.py","ruff.toml",".ruff.toml"])test(`discovery ignores committed symlink ${file}`,async()=>{
 const f=await fixture();await writeFile(join(f.repo,"README.md"),"# Links\n");await writeFile(join(f.repo,file),"../outside.py\n");await f.commit();const blob=await f.git(["rev-parse",`HEAD:${file}`]);await f.git(["update-index","--cacheinfo",`120000,${blob},${file}`]);await f.git(["-c","user.name=Salem Test","-c","user.email=test@example.invalid","commit","-m","link fixture"]);const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.deepEqual(result.stack,[]);assert.deepEqual(result.suggested.config.checks,[]);
});
for(const file of ["manage.py","ruff.toml",".ruff.toml"])test(`discovery requires a local regular file for committed ${file}`,async()=>{
 const f=await fixture();await writeFile(join(f.repo,"README.md"),"# Missing marker\n");await writeFile(join(f.repo,file),"# Marker\n");await f.commit();await rm(join(f.repo,file));await mkdir(join(f.repo,file));const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.deepEqual(result.suggested.config.checks,[]);assert.ok(!result.stack.includes("Django"));
});
for(const [label,content] of [["oversized","[tool.ruff]\n"+"#".repeat(256*1024)],["binary","[tool.ruff]\n\0binary"]])test(`discovery ignores ruff in ${label} pyproject.toml`,async()=>{
 const f=await fixture();await writeFile(join(f.repo,"README.md"),"# Bounded\n");await writeFile(join(f.repo,"pyproject.toml"),content!);await f.commit();const result=await(await discovery())(f.repo,defaultSettings(),"codex",f.data);assert.deepEqual(result.stack,["Python"]);assert.deepEqual(result.suggested.config.checks,[]);
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
test("proposed Django checks are executable checks, not discovery-only dry runs",async()=>{
 const f=await fixture();await writeFile(join(f.repo,"manage.py"),"print(1)");await f.commit();const checks=(await(await discovery())(f.repo,defaultSettings(),"codex",f.data)).suggested.config.checks;
 // The check runner classifies any argv containing --dry-run as discovery-only, which can never pass.
 const discoveryOnly=["--dry-run","--collect-only","--listTests","--list-tests","--help","--version"];
 for(const id of ["django-check"])assert.ok(!checks.find(c=>c.id===id)!.command.some(a=>discoveryOnly.includes(a)),id);
});
