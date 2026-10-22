import {test} from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {runProcess} from "../src/process.js";
test("Salem UI entry explains local startup without demanding a project profile",async()=>{
 const result=await runProcess({command:[process.execPath,resolve("dist/src/cli.js"),"ui","--help"],cwd:process.cwd(),timeoutMs:10000,maxOutputBytes:10000});
 assert.equal(result.exitCode,0,result.stderr);assert.match(result.stdout,/Salem/);assert.match(result.stdout,/--data-dir/);assert.match(result.stdout,/--port/);
 const bad=await runProcess({command:[process.execPath,resolve("dist/src/cli.js"),"ui","--port","0","--port","-1"],cwd:process.cwd(),timeoutMs:10000,maxOutputBytes:10000});assert.notEqual(bad.exitCode,0);
});
