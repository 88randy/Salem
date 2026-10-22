import { basename } from "node:path";

// Interpret only supported launch forms. Ambiguous invocations must declare the
// complete toolFiles list, rather than silently treating flags as entrypoints.
export function checkInputs(command: string[], declared?: string[]): string[] {
  if (declared?.length) return declared;
  const program = basename(command[0]!).replace(/\.exe$/i, "").toLowerCase();
  const node = program === "node", python = /^python(?:\d+(?:\.\d+)*)?$/.test(program);
  if (!node && !python) return declared ?? [];
  const files: string[] = []; let tests = false;
  const ambiguous = (): string[] => {
    if (declared?.length) return declared;
    throw new Error("Ambiguous check invocation: declare complete toolFiles inputs");
  };
  for (let i = 1; i < command.length; i++) {
    const arg = command[i]!;
    if (arg === "--") { files.push(...(tests ? command.slice(i + 1) : command.slice(i + 1, i + 2))); break; }
    if (node && ["-e", "--eval", "-p", "--print"].includes(arg) || python && arg === "-c") break;
    if (python && arg === "-m") return ambiguous();
    if (node && arg === "--test") { tests = true; continue; }
    if (node && ["-r", "--require", "--import", "--loader", "--experimental-loader"].includes(arg)) {
      const input = command[++i]; if (!input || !(input.startsWith(".") || /[/\\]/.test(input))) return ambiguous();
      files.push(input); continue;
    }
    if (node && /^--(?:require|import|loader|experimental-loader)=/.test(arg)) {
      const input = arg.slice(arg.indexOf("=") + 1); if (!(input.startsWith(".") || /[/\\]/.test(input))) return ambiguous();
      files.push(input); continue;
    }
    if (python && ["-W", "-X"].includes(arg)) { if (!command[++i]) return ambiguous(); continue; }
    const noValue = node ? ["--no-warnings", "--trace-warnings", "--enable-source-maps", "--experimental-strip-types", "--test-only", "--test-force-exit", "--help", "--version", "-v"]
      : ["-u", "-B", "-I", "-E", "-s", "-S", "-q", "-v", "-O", "-OO", "--help", "--version"];
    if (noValue.includes(arg)) continue;
    if (node && /^--(?:test-name-pattern|test-skip-pattern|test-timeout|test-concurrency|test-reporter|input-type)=/.test(arg)) continue;
    if (arg.startsWith("-")) return ambiguous();
    files.push(arg); if (!tests) break;
  }
  return [...new Set([...files, ...(declared ?? [])])];
}
