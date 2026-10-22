import { test } from "node:test";
import assert from "node:assert/strict";
import { runProcess } from "../src/process.js";

const base = { cwd: process.cwd(), timeoutMs: 1500, maxOutputBytes: 2000 };
test("subprocess handles literal arguments, spaces and stdin without a shell", async () => {
  const args = ['a b', '"quotes"', '$(echo unsafe)', '&echo unsafe'];
  const r = await runProcess({ ...base, input: "hola", command: [process.execPath, "-e", "process.stdin.on('data', d=>console.log(JSON.stringify({args:process.argv.slice(1),input:d.toString()})))", ...args] });
  assert.equal(r.status, "exited");
  assert.deepEqual(JSON.parse(r.stdout), { args, input: "hola" });
});
test("missing executable is a structured failure", async () => {
  const r = await runProcess({ ...base, command: ["missing-agent-workflow-executable-31b"] });
  assert.equal(r.status, "failed"); assert.equal(r.exitCode, null);
});
test("timeout and output budget terminate processes", async () => {
  const r = await runProcess({ ...base, timeoutMs: 80, command: [process.execPath, "-e", "setInterval(()=>{},1000)"] });
  assert.equal(r.status, "timed_out");
  const noisy = await runProcess({ ...base, command: [process.execPath, "-e", "console.log('x'.repeat(10000))"] });
  assert.equal(noisy.status, "failed"); assert.match(noisy.error ?? "", /output/i);
  assert.ok(noisy.stdout.length <= base.maxOutputBytes);
});
test("abort before and during execution cancels promptly", async () => {
  const c = new AbortController(); c.abort();
  assert.equal((await runProcess({ ...base, command: ["not-even-installed"], signal: c.signal })).status, "cancelled");
  const live = new AbortController();
  const timer = setTimeout(() => live.abort(), 100);
  const r = await runProcess({ ...base, command: [process.execPath, "-e", "setInterval(()=>{},1000)"], signal: live.signal });
  clearTimeout(timer); assert.equal(r.status, "cancelled");
});
