import { lstat, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isInside } from "../config.js";
import { localError } from "./validation.js";

export interface DirectoryListing {
  path: string; parent: string | null; directories: { name: string; path: string }[];
}
export async function browseDirectories(input: string, allowedRoots: string[] = [homedir()]): Promise<DirectoryListing> {
  const requested = input || homedir();
  if (!isAbsolute(requested) || requested.includes("\0") || requested.length > 8192 || /^(?:\\\\|\/\/)/.test(requested)) throw localError("La carpeta debe ser una ruta local absoluta.");
  const roots: string[] = [];
  for (const root of allowedRoots) { try { roots.push(await realpath(root)); } catch { /* An unavailable registered root grants no access. */ } }
  let path: string;
  try {
    const info = await lstat(resolve(requested));
    if (info.isSymbolicLink()) throw localError("No se exploran enlaces de carpetas.", 403);
    if (!info.isDirectory()) throw localError("La ruta no es una carpeta.");
    path = await realpath(requested);
  } catch (error) {
    if ((error as {status?: number}).status) throw error;
    throw localError("No se pudo abrir esa carpeta.", 404);
  }
  if (!roots.some(root => isInside(root, path))) throw localError("La carpeta está fuera de los directorios permitidos para este usuario.", 403);
  const directories: DirectoryListing["directories"] = [];
  try {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = join(path, entry.name);
      try {
        const info = await lstat(candidate), actual = await realpath(candidate);
        if (info.isDirectory() && !info.isSymbolicLink() && isInside(path, actual)) directories.push({ name: entry.name, path: actual });
      } catch { /* Entries can disappear or be inaccessible during a folder scan. */ }
    }
  } catch { throw localError("No se pudo enumerar esa carpeta.", 403); }
  directories.sort((a, b) => a.name.localeCompare(b.name));
  const parent = dirname(path);
  return { path, parent: parent !== path && roots.some(root => isInside(root, parent)) ? parent : null, directories };
}
