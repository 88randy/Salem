// Windows containment for one guardian subprocess tree. A Job Object holds the
// tree independently of parent PIDs, so descendants that outlive or detach from
// the agent remain reachable. Membership is inherited at creation and the job
// forbids breakaway; kill-on-close also ends the tree if this helper dies.
// The helper uses the system PowerShell and P/Invoke: no native dependency.
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";

const source = `
using System; using System.Runtime.InteropServices;
public static class SalemJob {
  [StructLayout(LayoutKind.Sequential)] public struct Basic { public long A, B; public uint Flags; public UIntPtr MinWs, MaxWs; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic Limits; public ulong R1, R2, R3, R4, R5, R6; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [StructLayout(LayoutKind.Sequential)] public struct Accounting { public long U, K, PU, PK; public uint Faults, Total, Active, Terminated; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static IntPtr Create() {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (job == IntPtr.Zero) throw new Exception("CreateJobObject " + Marshal.GetLastWin32Error());
    Extended info = new Extended(); info.Limits.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway allowed
    if (!SetInformationJobObject(job, 9, ref info, Marshal.SizeOf(typeof(Extended)))) throw new Exception("SetInformationJobObject " + Marshal.GetLastWin32Error());
    return job;
  }
  public static void Assign(IntPtr job, uint pid) {
    IntPtr process = OpenProcess(0x0101, false, pid); // PROCESS_SET_QUOTA | PROCESS_TERMINATE
    if (process == IntPtr.Zero) throw new Exception("OpenProcess " + Marshal.GetLastWin32Error());
    try { if (!AssignProcessToJobObject(job, process)) throw new Exception("AssignProcessToJobObject " + Marshal.GetLastWin32Error()); } finally { CloseHandle(process); }
  }
  public static uint Active(IntPtr job) {
    Accounting info; if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw new Exception("QueryInformationJobObject " + Marshal.GetLastWin32Error());
    return info.Active;
  }
  public static uint Terminate(IntPtr job) {
    if (Active(job) > 0 && !TerminateJobObject(job, 1)) throw new Exception("TerminateJobObject " + Marshal.GetLastWin32Error());
    for (int i = 0; i < 100; i++) { uint active = Active(job); if (active == 0) return 0; System.Threading.Thread.Sleep(50); }
    return Active(job);
  }
}`;
// One request per stdin line, one reply per stdout line. EOF ends the helper,
// which closes the last job handle and kills anything still inside.
const script = `$ErrorActionPreference = 'Stop'
try { Add-Type -TypeDefinition @'
${source}
'@; $job = [SalemJob]::Create(); [Console]::Out.WriteLine('ready') } catch { [Console]::Out.WriteLine('error ' + $_.Exception.Message); exit 1 }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    if ($line -match '^assign (\\d+)$') { [SalemJob]::Assign($job, [uint32]$Matches[1]); [Console]::Out.WriteLine('ok') }
    elseif ($line -eq 'terminate') { [Console]::Out.WriteLine('active ' + [SalemJob]::Terminate($job)) }
    else { [Console]::Out.WriteLine('error unknown request') }
  } catch { [Console]::Out.WriteLine('error ' + $_.Exception.Message) }
}`;

export class WindowsJob {
  private replies: ((line: string) => void)[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private dead = false;
  /** Rejects when containment is unavailable (no PowerShell, Add-Type blocked, job creation failed). */
  readonly ready: Promise<void>;
  private constructor(private readonly helper: ChildProcess) {
    createInterface({ input: helper.stdout! }).on("line", line => this.replies.shift()?.(line.trim()));
    const gone = () => { this.dead = true; for (const reply of this.replies.splice(0)) reply("error helper exited"); };
    helper.once("exit", gone); helper.once("error", gone);
    helper.stdin!.on("error", () => {});
    this.ready = this.reply().then(line => { if (line !== "ready") throw new Error(`Windows process containment unavailable: ${line}`); });
  }
  /** Starts the helper and its job; await `ready` before assigning. */
  static start(): WindowsJob {
    // Absolute path: PATH must not be able to substitute the containment helper.
    const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    return new WindowsJob(spawn(exe, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] }));
  }
  private reply(request?: string): Promise<string> {
    const next = this.queue.then(() => new Promise<string>(resolve => {
      if (this.dead) { resolve("error helper exited"); return; }
      this.replies.push(resolve);
      if (request !== undefined) this.helper.stdin!.write(`${request}\n`);
    }));
    this.queue = next; return next;
  }
  async assign(pid: number): Promise<void> {
    const reply = await this.reply(`assign ${pid}`);
    if (reply !== "ok") throw new Error(`Cannot contain process ${pid}: ${reply}`);
  }
  /** Terminates every process in the job; true only when the job is confirmed empty. */
  async terminate(): Promise<boolean> { return (await this.reply("terminate")) === "active 0"; }
  /** Ends the helper; closing its job handle kills anything still inside. */
  close(): void { this.helper.stdin!.end(); this.helper.kill(); }
}
