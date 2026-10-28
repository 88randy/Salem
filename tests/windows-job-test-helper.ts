// Test support for the Windows containment helper (src/windows-job-helper.cs).
//
// - releaseHelperPath: the helper production launches (dist/src, stamped and packaged).
// - testHelperPath: the same source compiled with /define:SALEM_TEST_HOOKS into
//   dist/tests by scripts/build.mjs. Only this build honors the
//   SALEM_TEST_JOB_HELPER_* fault-injection variables; tests select it through
//   ProcessInput.windowsJobHelper or WindowsJob.start(path).
// - rawHelper(): speaks the documented control protocol directly, so tests can
//   send requests WindowsJob never sends without touching its private members.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const releaseHelperPath = fileURLToPath(new URL("../src/windows-job-helper.exe", import.meta.url));
export const testHelperPath = fileURLToPath(new URL("./windows-job-helper.test.exe", import.meta.url));

export interface RawHelper {
  /** Sends one control line and resolves with the next reply line ("exit <code>" events are skipped). */
  request(line: string): Promise<string>;
  /** Resolves with the startup line ("ready" or "error <reason>"). */
  readonly ready: Promise<string>;
  close(): void;
}

/** Starts a helper with the same inherited handles WindowsJob gives it (fds 3-6 must exist). */
export function rawHelper(path = releaseHelperPath): RawHelper {
  const helper = spawn(path, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore", "ipc", "pipe", "pipe", "pipe"] });
  const waiting: ((line: string) => void)[] = [];
  const next = () => new Promise<string>(resolve => { waiting.push(resolve); });
  createInterface({ input: helper.stdout! }).on("line", raw => {
    const line = raw.trim();
    if (!/^exit \d+$/.test(line)) waiting.shift()?.(line);
  });
  helper.on("exit", () => { for (const resolve of waiting.splice(0)) resolve("error helper exited"); });
  helper.on("error", () => { for (const resolve of waiting.splice(0)) resolve("error helper exited"); });
  helper.stdin!.on("error", () => {});
  const ready = next();
  return {
    ready,
    request: line => { const reply = next(); helper.stdin!.write(`${line}\n`); return reply; },
    close: () => { helper.stdin!.end(); helper.kill(); if (helper.connected) helper.disconnect(); },
  };
}
