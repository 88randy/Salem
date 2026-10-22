import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {loadProjectConfig} from "../src/config.js";
import {codexCommand} from "../src/adapters/codex.js";
import {claudeCommand} from "../src/adapters/claude.js";
import {runStage} from "../src/adapters/index.js";
import {instructionsHash} from "../src/repository.js";
import type {ProjectConfig,StageInput} from "../src/contracts.js";
test("project model effort and inline instructions are explicit process overrides",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"salem options "));await mkdir(join(dir,"repo"));await writeFile(join(dir,"repo","AGENTS.md"),"Demo");
 const raw={schemaVersion:1,projectId:"local",repoRoot:"./repo",contextFiles:["AGENTS.md"],instructions:"Return all evidence in Spanish",agents:{c:{provider:"codex",command:["codex"],model:"model-test",effort:"high"},a:{provider:"claude",command:["claude"],model:"claude-test",effort:"medium"}},checks:[],capabilities:{edit:true,commit:false,pull_request:false,merge:false,deploy:false},budgets:{stageTimeoutMs:10000,maxOutputBytes:20000}};
 const file=join(dir,"profile.json");await writeFile(file,JSON.stringify(raw));let config:ProjectConfig|undefined;
 await assert.doesNotReject(async()=>{config=await loadProjectConfig(file);},"optional UI settings must be supported");
 const task={id:"T",objective:"Inspect",scope:["read"],acceptance:["result"],references:[]};
 const c={config:config!,task,stage:"review",agentId:"c",artifactDir:join(dir,"output")} as StageInput;
 const ca=codexCommand(c);assert.ok(ca.includes("model-test"));assert.ok(ca.some(v=>v.includes("model_reasoning_effort")&&v.includes("high")));
 const aa=claudeCommand({...c,agentId:"a"});assert.ok(aa.includes("claude-test"));assert.ok(aa.includes("--effort"));assert.ok(aa.includes("medium"));
 const initial=await instructionsHash(config!);config!.instructions="Different instructions";assert.notEqual(await instructionsHash(config!),initial);
 config!.agents.c={provider:"codex",command:[process.execPath,resolve("tests/fixtures/fake-agent.mjs"),"codex","ok"]};
 await runStage(c);assert.match(await readFile(join(c.artifactDir,"prompt.txt"),"utf8"),/Different instructions/);
});
test("public package and CLI identify Salem without creator branding",async()=>{
 const pkg=JSON.parse(await readFile("package.json","utf8"));assert.equal(pkg.name,"salem-local");assert.ok(pkg.bin.salem);assert.equal(pkg.author,undefined);
 const source=await readFile("src/cli.ts","utf8");assert.match(source,/salem <|salem ui/);
});
