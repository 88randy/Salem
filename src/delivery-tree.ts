import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { repositoryFiles } from "./repository.js";
export type GitCommand = (args: string[], input?: string, env?: Record<string,string>) => Promise<string>;
// Build raw Git blobs without checkout filters or touching the user's index.
export async function captureDeliveryTree(root: string, git: GitCommand): Promise<string> {
  const staged = new Map<string,string>();
  for (const entry of (await git(["ls-files", "--stage", "-z"])).split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t"), [mode,,stage] = entry.slice(0,tab).split(" ");
    if (stage !== "0") throw new Error("Unmerged index cannot be delivered"); staged.set(entry.slice(tab+1),mode!);
  }
  type Directory = Map<string, { mode: string; sha: string } | Directory>;
  const tree: Directory = new Map();
  for (const path of await repositoryFiles(root)) {
    let info; try { info = await lstat(resolve(root,path)); } catch(e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") continue; throw e; }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error("Unsupported delivery source entry");
    if (staged.get(path) === "120000" && !info.isSymbolicLink()) throw new Error("Materialized symlink requires native symlink support before delivery");
    const mode = info.isSymbolicLink() ? "120000" : process.platform === "win32" ? staged.get(path) ?? "100644" : info.mode & 0o111 ? "100755" : "100644";
    const sha = (info.isSymbolicLink() ? await git(["hash-object","-w","--stdin"],await readlink(resolve(root,path))) : await git(["hash-object","-w","--no-filters","--",path])).trim();
    const names = path.split("/"); let parent = tree;
    for (const name of names.slice(0,-1)) { if (!parent.has(name)) parent.set(name,new Map()); const child = parent.get(name); if (!(child instanceof Map)) throw new Error("Conflicting source paths"); parent = child; }
    parent.set(names.at(-1)!,{mode,sha});
  }
  async function write(directory: Directory): Promise<string> {
    const entries: string[] = [];
    for (const [name, child] of [...directory.entries()].sort(([a],[b]) => a.localeCompare(b))) entries.push(child instanceof Map ? `040000 tree ${await write(child)}\t${name}\0` : `${child.mode} blob ${child.sha}\t${name}\0`);
    return (await git(["mktree","-z"],entries.join(""))).trim();
  }
  return write(tree);
}
