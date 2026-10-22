import {createHash} from 'node:crypto';import {createReadStream} from 'node:fs';
import {lstat,readdir,realpath} from 'node:fs/promises';import {dirname,join,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {digest} from '../state-store.js';import {resolveExecutable} from '../process.js';import type {ProjectRecord} from './contracts.js';
async function hashFile(path:string){const info=await lstat(path);if(!info.isFile()||info.size>1_073_741_824)throw Error('Herramienta externa no verificable (límite 1 GiB)');const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
/** Same authority classes as runner.executionTools, without repeating authentication probes. */
export async function evolutionAuthority(project:ProjectRecord,root=project.config.repoRoot,agentIds=Object.keys(project.config.agents)){
 const entries:unknown[]=[];for(const id of [...new Set(agentIds)].sort()){
  const agent=project.config.agents[id];if(!agent)throw Error('Agente de autoridad desconocido');
  const exe=await realpath(await resolveExecutable(agent.command[0]!));entries.push([id,'executable',exe,await hashFile(exe)]);
  const first=agent.command[1];if(first){const path=resolve(root,first);try{const s=await lstat(path);if(s.isFile())entries.push([id,'entry',first,await hashFile(await realpath(path))]);}catch(error){if(!['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code??''))throw error;}}
 }
 const runtime=resolve(dirname(fileURLToPath(import.meta.url)),'..');for(const path of (await readdir(runtime,{recursive:true})).sort())if(path.endsWith('.js'))entries.push(['runtime',path,await hashFile(join(runtime,path))]);
 for(const role of ['define','build','review'])entries.push(['template',role,await hashFile(resolve(runtime,'../../templates',`${role}.md`))]);return digest(entries);
}
