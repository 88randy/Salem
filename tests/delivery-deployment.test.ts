import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile,readFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import { deliveryFixture } from "./delivery-fixture.js";
import { repositorySnapshot } from "../src/repository.js";
import { runChecks } from "../src/checks.js";
import { deliver } from "../src/delivery.js";
test("demo deployment materializes and executes the code of the confirmed release SHA",async()=>{
  const f=await deliveryFixture(),target=join(f.dir,"deployment");
  await writeFile(join(f.config.repoRoot,"sum.mjs"),"export function sum(a,b){return a+b;}\n");
  f.input.context.snapshot=await repositorySnapshot(f.config.repoRoot);
  const command=[process.execPath,resolve("tests/fixtures/demo-deploy.mjs"),target,f.snapshot.gitDir];
  f.config.capabilities.deploy=true;f.config.delivery!.deploy={command,statusCommand:command,target:"local-demo",requiredChecks:[]};
  f.input.evidence=await runChecks(f.config,f.input.context.snapshot.head,{...f,snapshot:f.input.context.snapshot});
  const receipt=await deliver(f.input);assert.equal(receipt.verdict,"success");
  assert.equal(await readFile(join(target,"app","sum.mjs"),"utf8"),"export function sum(a,b){return a+b;}\n");
});
