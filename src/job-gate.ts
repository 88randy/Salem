// Windows launch gate. The guardian assigns this process to its Job Object and
// only then sends the command, so the agent and every descendant are created
// inside the job; nothing can start before containment exists.
import { spawn } from "node:child_process";

process.once("message", (raw: unknown) => {
  const message = raw as { command: string[]; cwd: string; env: Record<string, string> };
  setImmediate(() => { if (process.connected) process.disconnect(); }); // disconnecting inside the handler crashes Node 22
  const child = spawn(message.command[0]!, message.command.slice(1), { cwd: message.cwd, env: message.env, shell: false, windowsHide: true, stdio: "inherit" });
  child.on("error", e => { process.stderr.write(e.message); process.exitCode = 1; });
  child.on("exit", code => { process.exitCode = code ?? 1; });
});
