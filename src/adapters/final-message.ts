import { lstat, open } from "node:fs/promises";
import { redact } from "../process.js";

/** Read a bounded native CLI artifact, redact it in place, then parse it. */
export async function readFinalMessage(file: string, maxBytes: number): Promise<unknown> {
  const entry = await lstat(file);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Final message must be a regular file");
  const handle = await open(file, "r+");
  try {
    const eraseOversize = async () => {
      await handle.truncate(0);
      await handle.writeFile("[OUTPUT_BUDGET_EXCEEDED]");
      throw new Error("Final message output budget exceeded");
    };
    if ((await handle.stat()).size > maxBytes) await eraseOversize();
    const chunks: Buffer[] = []; let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(65536, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead)); total += bytesRead;
    }
    if (total > maxBytes) await eraseOversize();
    const text = redact(Buffer.concat(chunks).toString("utf8"));
    await handle.truncate(0);
    await handle.write(text, 0, "utf8");
    return JSON.parse(text);
  } finally { await handle.close(); }
}
