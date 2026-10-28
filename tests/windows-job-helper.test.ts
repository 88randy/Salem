import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { releaseHelperPath, testHelperPath } from "./windows-job-test-helper.js";

// Fault-injection hooks are compiled only into the test build of the helper
// (SALEM_TEST_HOOKS). The release helper that ships must not carry them.
const hooks = ["SALEM_TEST_JOB_HELPER_PAUSE_FILE", "SALEM_TEST_JOB_HELPER_TERMINATE"];
// .NET keeps string literals as UTF-16LE (#US heap); check UTF-8 too.
const contains = (bytes: Buffer, text: string) => bytes.includes(Buffer.from(text, "utf16le")) || bytes.includes(Buffer.from(text, "utf8"));
const windows = { skip: process.platform !== "win32" };

test("windows: the release containment helper carries no fault-injection hooks", windows, async () => {
  const bytes = await readFile(releaseHelperPath);
  for (const hook of hooks) assert.equal(contains(bytes, hook), false, `release helper contains ${hook}`);
});

test("windows: the test build of the containment helper carries the fault-injection hooks", windows, async () => {
  const bytes = await readFile(testHelperPath);
  for (const hook of hooks) assert.equal(contains(bytes, hook), true, `test helper lacks ${hook}`);
});
