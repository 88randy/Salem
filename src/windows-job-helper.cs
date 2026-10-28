// Salem Windows containment helper. Compiled at build time with the system
// .NET Framework compiler (scripts/build.mjs) into dist/src/windows-job-helper.exe.
// One helper owns one Job Object for one guardian; src/windows-job.ts drives it.
//
// Handles inherited from the guardian (libuv passes them in STARTUPINFO.lpReserved2,
// the C runtime file-descriptor table):
//   fd 0  control requests (one ASCII line each)   fd 1  control replies and events
//   fd 2  ignored                                  fd 3  Node IPC channel for the gate
//   fd 4  gate stdin    fd 5  gate stdout    fd 6  gate stderr
//
// Control protocol (requests on fd 0, lines on fd 1):
//   (startup)                      -> "ready" | "error <reason>" (then exit 1)
//   "start <app> <cmdline> <cwd>"  -> "started <pid>" | "error <reason>"
//       Fields are base64 UTF-8. Accepted once. The gate is created with fds 3-6
//       as its fds 3,0,1,2 and no other inherited handle, directly inside the job
//       (PROC_THREAD_ATTRIBUTE_JOB_LIST): it never exists outside the job, and no
//       PID is ever used to find it. "error" means no gate was created.
//   "terminate"                    -> "active <n>" (n = 0 means confirmed empty)
//   event, once, after "started"   -> "exit <code>" when the gate process ends
//   EOF on fd 0                    -> exit; the last job handle closes and
//                                     KILL_ON_JOB_CLOSE ends the whole tree.
// If this helper dies for any reason, the same kill-on-close applies.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class WindowsJobHelper {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long A, B; public uint Flags; public UIntPtr MinWs, MaxWs; public uint Active; public UIntPtr Affinity; public uint Priority, Scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Limits; public ulong R1, R2, R3, R4, R5, R6; public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob; }
  [StructLayout(LayoutKind.Sequential)] struct Accounting { public long U, K, PU, PK; public uint Faults, Total, Active, Terminated; }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfo {
    public int cb; public IntPtr Reserved, Desktop, Title;
    public int X, Y, XSize, YSize, XCountChars, YCountChars, FillAttribute, Flags;
    public short ShowWindow, CbReserved2; public IntPtr Reserved2, StdInput, StdOutput, StdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr AttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public uint ProcessId, ThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, IntPtr name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll")] static extern void GetStartupInfoW(out StartupInfo info);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returnSize);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation info);

  const uint CreateNoWindow = 0x08000000, ExtendedStartupInfoPresent = 0x80000;
  const int UseStdHandles = 0x100, UseShowWindow = 0x1;
  static readonly IntPtr HandleListAttribute = (IntPtr)0x20002; // PROC_THREAD_ATTRIBUTE_HANDLE_LIST
  static readonly IntPtr JobListAttribute = (IntPtr)0x2000D; // PROC_THREAD_ATTRIBUTE_JOB_LIST (Windows 10+)

  static readonly object writeLock = new object();
  static StreamWriter output;
  static IntPtr job;
  static IntPtr[] inherited; // guardian fds 3..6: ipc, stdin, stdout, stderr
  static byte[] inheritedFlags;
  static bool launched;

  static void Write(string line) { lock (writeLock) { output.Write(line + "\n"); output.Flush(); } }
  static Exception Win32(string call) { return new Exception(call + " " + Marshal.GetLastWin32Error()); }

  static int Main() {
    output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    try { job = CreateJob(); ReadInheritedHandles(); PrepareLaunch(); }
    catch (Exception e) { Write("error " + e.Message); return 1; }
    Write("ready");
    string line;
    while ((line = input.ReadLine()) != null) {
      try {
        string[] parts = line.Split(' ');
        if (parts.Length == 4 && parts[0] == "start") {
          Thread waiter = Launch(Decode(parts[1]), Decode(parts[2]), Decode(parts[3]));
          waiter.Start(); // after "started": the "exit" event always follows the reply
        }
        else if (line == "terminate") {
          // Test-only fault injection: "active" (job not emptied), "error", or
          // "silent" (no reply), without touching the job.
          string fault = Environment.GetEnvironmentVariable("SALEM_TEST_JOB_HELPER_TERMINATE");
          if (fault == "active") Write("active 1");
          else if (fault == "error") Write("error injected terminate failure");
          else if (fault != "silent") Write("active " + Terminate());
        }
        else Write("error unknown request");
      } catch (Exception e) { Write("error " + e.Message); }
    }
    return 0; // process exit closes the job handle: KILL_ON_JOB_CLOSE ends the tree
  }

  static string Decode(string value) { return Encoding.UTF8.GetString(Convert.FromBase64String(value)); }

  static IntPtr CreateJob() {
    IntPtr created = CreateJobObjectW(IntPtr.Zero, IntPtr.Zero);
    if (created == IntPtr.Zero) throw Win32("CreateJobObject");
    Extended info = new Extended(); info.Limits.Flags = 0x2000; // KILL_ON_JOB_CLOSE, no breakaway allowed
    if (!SetInformationJobObject(created, 9, ref info, Marshal.SizeOf(typeof(Extended)))) throw Win32("SetInformationJobObject");
    return created;
  }

  // C runtime fd table: int count, count flag bytes, count pointer-sized handles (unaligned).
  static void ReadInheritedHandles() {
    StartupInfo self; GetStartupInfoW(out self);
    int size = (ushort)self.CbReserved2;
    if (self.Reserved2 == IntPtr.Zero || size < 4) throw new Exception("missing inherited gate handles");
    int count = Marshal.ReadInt32(self.Reserved2);
    if (count < 7 || size < 4 + count + count * IntPtr.Size) throw new Exception("missing inherited gate handles");
    inherited = new IntPtr[4]; inheritedFlags = new byte[4];
    for (int i = 0; i < 4; i++) {
      inheritedFlags[i] = Marshal.ReadByte(self.Reserved2, 4 + 3 + i);
      inherited[i] = Marshal.ReadIntPtr(self.Reserved2, 4 + count + (3 + i) * IntPtr.Size);
      if (inherited[i] == IntPtr.Zero || inherited[i] == (IntPtr)(-1)) throw new Exception("missing inherited gate handle " + (3 + i));
    }
  }

  // Everything the launch needs is built at startup, so an unsupported system
  // (no PROC_THREAD_ATTRIBUTE_JOB_LIST before Windows 10) fails at "ready",
  // before any process exists. These buffers live as long as the helper.
  static IntPtr attributes, table;
  static int tableSize;
  static void PrepareLaunch() {
    // The gate sees ipc as fd 3 (NODE_CHANNEL_FD=3 is already in the inherited environment).
    IntPtr[] gate = { inherited[1], inherited[2], inherited[3], inherited[0] };
    byte[] flags = { inheritedFlags[1], inheritedFlags[2], inheritedFlags[3], inheritedFlags[0] };
    tableSize = 4 + gate.Length + gate.Length * IntPtr.Size;
    table = Marshal.AllocHGlobal(tableSize);
    Marshal.WriteInt32(table, 0, gate.Length);
    for (int i = 0; i < gate.Length; i++) {
      Marshal.WriteByte(table, 4 + i, flags[i]);
      Marshal.WriteIntPtr(table, 4 + gate.Length + i * IntPtr.Size, gate[i]);
    }
    IntPtr attributeSize = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
    attributes = Marshal.AllocHGlobal(attributeSize);
    if (!InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize)) throw Win32("InitializeProcThreadAttributeList");
    // Inherit exactly these four handles; nothing else of this helper leaks into the tree.
    IntPtr handleList = Marshal.AllocHGlobal(gate.Length * IntPtr.Size);
    for (int i = 0; i < gate.Length; i++) Marshal.WriteIntPtr(handleList, i * IntPtr.Size, gate[i]);
    if (!UpdateProcThreadAttribute(attributes, 0, HandleListAttribute, handleList, (IntPtr)(gate.Length * IntPtr.Size), IntPtr.Zero, IntPtr.Zero)) throw Win32("UpdateProcThreadAttribute(HANDLE_LIST)");
    // The kernel creates the gate already inside the job: it never exists
    // outside containment, whatever happens to this helper afterwards.
    IntPtr jobList = Marshal.AllocHGlobal(IntPtr.Size);
    Marshal.WriteIntPtr(jobList, job);
    if (!UpdateProcThreadAttribute(attributes, 0, JobListAttribute, jobList, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw Win32("UpdateProcThreadAttribute(JOB_LIST)");
  }

  static Thread Launch(string application, string commandLine, string directory) {
    if (launched) throw new Exception("gate already started");
    launched = true;
    try {
      StartupInfoEx startup = new StartupInfoEx();
      startup.Info.cb = Marshal.SizeOf(typeof(StartupInfoEx));
      startup.Info.Flags = UseStdHandles | UseShowWindow; startup.Info.ShowWindow = 0; // SW_HIDE
      startup.Info.StdInput = inherited[1]; startup.Info.StdOutput = inherited[2]; startup.Info.StdError = inherited[3];
      startup.Info.CbReserved2 = (short)tableSize; startup.Info.Reserved2 = table;
      startup.AttributeList = attributes;
      ProcessInformation created;
      // No CREATE_SUSPENDED: with JOB_LIST, job membership is part of process
      // creation itself, so there is no later assignment step left to protect.
      if (!CreateProcessW(application, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true, CreateNoWindow | ExtendedStartupInfoPresent, IntPtr.Zero, directory, ref startup, out created)) throw Win32("CreateProcess");
      TestPauseAfterCreate(created.ProcessId);
      CloseHandle(created.Thread);
      IntPtr process = created.Process;
      Thread waiter = new Thread(delegate () {
        WaitForSingleObject(process, 0xFFFFFFFF); uint code;
        if (!GetExitCodeProcess(process, out code)) code = 1;
        Write("exit " + code);
      });
      waiter.IsBackground = true;
      Write("started " + created.ProcessId);
      return waiter;
    } finally {
      // The guardian sees EOF and IPC disconnect only after every copy closes, so drop ours.
      foreach (IntPtr handle in inherited) CloseHandle(handle);
    }
  }

  // Test-only fault injection: with SALEM_TEST_JOB_HELPER_PAUSE_FILE set, record
  // "<helper pid> <gate pid>" there right after CreateProcess and stop, so a test
  // can kill this helper at the most dangerous point of a launch.
  static void TestPauseAfterCreate(uint gate) {
    string path = Environment.GetEnvironmentVariable("SALEM_TEST_JOB_HELPER_PAUSE_FILE");
    if (string.IsNullOrEmpty(path)) return;
    File.WriteAllText(path + ".tmp", System.Diagnostics.Process.GetCurrentProcess().Id + " " + gate);
    File.Move(path + ".tmp", path);
    Thread.Sleep(Timeout.Infinite);
  }

  static uint Active() {
    Accounting info;
    if (!QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw Win32("QueryInformationJobObject");
    return info.Active;
  }

  static uint Terminate() {
    if (Active() > 0 && !TerminateJobObject(job, 1)) throw Win32("TerminateJobObject");
    for (int i = 0; i < 100; i++) { if (Active() == 0) return 0; Thread.Sleep(50); }
    return Active();
  }
}
