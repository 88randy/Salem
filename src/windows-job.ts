// Windows containment for one guardian subprocess tree. A Job Object holds the
// tree independently of parent PIDs, so descendants that outlive or detach from
// the agent remain reachable. Membership is inherited at creation and the job
// forbids breakaway; kill-on-close also ends the tree if the helper dies.
//
// The helper is windows-job-helper.exe, compiled at build time from
// windows-job-helper.cs with the system .NET Framework compiler. It creates the
// launch gate itself, SUSPENDED, assigns it to the job through the handle that
// CreateProcess returned and only then resumes it. No PID is ever used to pick a
// process to contain, so a recycled PID cannot pull an unrelated process in.
//
// Wiring (guardian side of the protocol documented in windows-job-helper.cs):
//   helper fd 0/1  control lines (requests / replies and the gate "exit" event)
//   helper fd 3    Node IPC; the helper hands it to the gate as its fd 3, so
//                  `send()` here reaches the gate's `process.on("message")`
//   helper fd 4-6  the gate's stdin, stdout and stderr
// The helper closes its own copies of fds 3-6 once the gate exists, so EOF and
// IPC disconnect reflect the gate tree alone.
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** Longest wait for a helper answer that a run's settlement depends on (its own terminate waits up to 5 s). */
export const controlDeadlineMs = 8000;
const helperPath = fileURLToPath(new URL("./windows-job-helper.exe", import.meta.url));
const b64 = (value: string) => Buffer.from(value, "utf8").toString("base64");
// The gate command is node.exe plus a script path: plain quoting is exact for paths.
const quote = (value: string) => {
  if (/["\0]/.test(value) || value.endsWith("\\")) throw new Error(`Unsupported launch argument: ${value}`);
  return `"${value}"`;
};

export class WindowsJob {
  private replies: ((line: string) => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private dead = false;
  private exited!: (code: number | null) => void;
  /** Rejects when containment is unavailable (helper missing or blocked, job creation failed). */
  readonly ready: Promise<void>;
  /** The gate's exit code, or null when the helper ended first (cleanup then cannot be confirmed). */
  readonly gateExit: Promise<number | null> = new Promise(resolve => { this.exited = resolve; });
  private constructor(private readonly helper: ChildProcess) {
    createInterface({ input: helper.stdout! }).on("line", raw => {
      const line = raw.trim(), exit = /^exit (\d+)$/.exec(line);
      if (exit) this.exited(Number(exit[1])); else this.replies.shift()?.(line);
    });
    const gone = () => { this.dead = true; this.exited(null); for (const reply of this.replies.splice(0)) reply("error helper exited"); };
    helper.once("exit", gone); helper.once("error", gone);
    helper.stdin!.on("error", () => {});
    helper.on("error", () => {}); // a later channel error must not crash the guardian
    for (const stream of [this.stdin, this.stdout, this.stderr]) stream.on("error", () => {});
    this.ready = this.reply().then(line => { if (line !== "ready") throw new Error(`Windows process containment unavailable: ${line}`); });
  }
  /**
   * Starts the helper and its job; await `ready` before launching. Production
   * omits `helper` and always gets the release helper. `helper` is a test seam:
   * tests pass the fault-injection build (tests/windows-job-test-helper.ts) or a
   * missing file, directly or through ProcessInput.windowsJobHelper.
   */
  static start(helper: string = helperPath): WindowsJob {
    // Absolute path next to this module: PATH must not be able to substitute the helper.
    return new WindowsJob(spawn(helper, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore", "ipc", "pipe", "pipe", "pipe"] }));
  }
  private get pipes(): (Readable | Writable)[] { return this.helper.stdio as unknown as (Readable | Writable)[]; }
  get stdin(): Writable { return this.pipes[4] as Writable; }
  get stdout(): Readable { return this.pipes[5] as Readable; }
  get stderr(): Readable { return this.pipes[6] as Readable; }
  private reply(request?: string): Promise<string> {
    const next = this.queue.then(() => new Promise<string>(resolve => {
      if (this.dead) { resolve("error helper exited"); return; }
      this.replies.push(resolve);
      if (request !== undefined) this.helper.stdin!.write(`${request}\n`);
    }));
    this.queue = next; return next;
  }
  /**
   * Creates the gate inside the job (suspended, assigned by handle, resumed) and
   * returns its PID for diagnostics only. Once this resolves the gate is contained.
   */
  async launch(executable: string, args: string[], cwd: string): Promise<number> {
    const reply = await this.reply(`start ${b64(executable)} ${b64([executable, ...args].map(quote).join(" "))} ${b64(cwd)}`);
    const started = /^started (\d+)$/.exec(reply);
    if (!started) throw new Error(`Cannot start contained process: ${reply}`);
    return Number(started[1]);
  }
  /** Sends one IPC message to the gate. */
  send(message: unknown, callback: (error: Error | null) => void): void { this.helper.send(message as object, callback); }
  /**
   * Terminates every process in the job; true only when the job is confirmed empty.
   * Survivors, an error, or no answer within `deadlineMs` all yield false.
   */
  async terminate(deadlineMs = controlDeadlineMs): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>(resolve => { timer = setTimeout(resolve, deadlineMs, "error no answer"); });
    try { return (await Promise.race([this.reply("terminate"), late])) === "active 0"; } finally { clearTimeout(timer); }
  }
  /** Ends the helper; closing its job handle kills anything still inside. */
  close(): void { this.helper.stdin!.end(); this.helper.kill(); if (this.helper.connected) this.helper.disconnect(); }
}
