import { mkdir, open, readFile, rename, unlink, rmdir, lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
const MAX_CHECKPOINT_BYTES = 20_000_000;

export function digest(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
// Size budgets must measure this exact text: it is what atomicJson writes.
export function jsonText(value: unknown): string { return JSON.stringify(value, null, 2); }
// Windows readers (scanners, indexers, other processes) can briefly hold a file
// without delete sharing, which makes the atomic rename fail with EPERM/EACCES/
// EBUSY. Retrying 16 times with backoff min(25*2^n, 250) ms waits about 3.4 s in
// total. Reviewed for #34: measured holds stay well under 2 s even with the CPU
// 4x oversubscribed, so the budget is kept; past it the rename error is raised
// and the previous file stays intact.
export const RENAME_RETRY_LIMIT = 16;
export const RENAME_RETRY_MAX_DELAY_MS = 250;
// Test seam: lets tests observe each failed rename attempt (0-based) so they can
// synchronize with a real lock collision. Production never sets it; unset, it
// changes nothing. Observers must not throw.
type RenameFailureObserver = (attempt: number, error: NodeJS.ErrnoException) => void;
let renameFailureObserver: RenameFailureObserver | undefined;
export function observeRenameFailures(observer: RenameFailureObserver | undefined): void { renameFailureObserver = observer; }
export async function atomicJson(file: string, value: unknown): Promise<void> {
  const text = jsonText(value); // serialize before touching the checkpoint
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try {
    // Retry the same atomic replacement; never unlink the previous durable file.
    for(let attempt=0;;attempt++) {
      try {await rename(temp,file);break;}
      catch(error) {
        renameFailureObserver?.(attempt,error as NodeJS.ErrnoException);
        if(process.platform!=="win32"||attempt>=RENAME_RETRY_LIMIT||!["EPERM","EACCES","EBUSY"].includes((error as NodeJS.ErrnoException).code??""))throw error;
        await delay(Math.min(25*2**attempt,RENAME_RETRY_MAX_DELAY_MS));
      }
    }
    // Windows cannot fsync directories; POSIX can persist the rename as well.
    if (process.platform !== "win32") { const directory = await open(dirname(file), "r"); try { await directory.sync(); } finally { await directory.close(); } }
  } finally { await unlink(temp).catch(e => { if (e.code !== "ENOENT") throw e; }); }
}
export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== "ESRCH"; }
}
export class StateStore {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }
  directory(id: string): string {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new Error("Invalid run id");
    return join(this.root, id);
  }
  async write(id: string, value: unknown): Promise<void> {
    const envelope = { schemaVersion: 1, checksum: digest(value), value };
    if (Buffer.byteLength(jsonText(envelope)) > MAX_CHECKPOINT_BYTES) throw new Error("Checkpoint size budget exceeded; last durable state preserved");
    await atomicJson(join(this.directory(id), "state.json"), envelope);
  }
  async read(id: string): Promise<Record<string, unknown>> {
    const file = join(this.directory(id), "state.json");
    try {
      if ((await lstat(file)).size > MAX_CHECKPOINT_BYTES) throw new Error("oversized checkpoint");
      const envelope = JSON.parse(await readFile(file, "utf8"));
      if (envelope.schemaVersion !== 1 || !envelope.value || envelope.value.id !== id || envelope.checksum !== digest(envelope.value)) throw new Error("checksum or identity mismatch");
      return envelope.value as Record<string, unknown>;
    } catch (e) { throw new Error(`Corrupt or unreadable checkpoint: ${(e as Error).message}`); }
  }
}
interface LockOwner { pid: number; token: string; runId: string; leaseDir?: string }
async function owner(path: string): Promise<LockOwner> {
  try {
    const value = JSON.parse(await readFile(join(path, "owner.json"), "utf8")) as LockOwner;
    if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !value.token || !value.runId) throw new Error();
    return value;
  } catch { throw new Error("Ambiguous lock owner; manual inspection required"); }
}
export async function acquireLock(path: string, runId: string, leaseDir?: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const reclaim = `${path}.reclaim`;
  try { await lstat(reclaim); throw new Error("Worktree locked during recovery"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
  try { await mkdir(path); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (alive((await owner(path)).pid)) throw new Error("Worktree locked by a live supervisor");
    try { await mkdir(reclaim); } catch { throw new Error("Worktree locked during recovery"); }
    try {
      const previous = await owner(path);
      if (alive(previous.pid)) throw new Error("Worktree locked by a live supervisor");
      if (previous.leaseDir) {
        let files: string[];
        try { files = await readdir(previous.leaseDir); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") files = []; else throw e; }
        for (const file of files.filter(f => f.endsWith(".json"))) {
          const lease = JSON.parse(await readFile(join(previous.leaseDir, file), "utf8"));
          if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0 || lease.closed !== true) throw new Error("Previous process guardian cleanup unconfirmed; worktree locked");
        }
      }
      await unlink(join(path, "owner.json")); await rmdir(path); await mkdir(path);
    } finally { await rmdir(reclaim); }
  }
  const value: LockOwner = { pid: process.pid, token: randomUUID(), runId, ...(leaseDir ? { leaseDir } : {}) };
  await atomicJson(join(path, "owner.json"), value);
  return async () => {
    if ((await owner(path)).token !== value.token) throw new Error("Lock ownership changed");
    await unlink(join(path, "owner.json")); await rmdir(path);
  };
}
