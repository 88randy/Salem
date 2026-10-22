import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const [root, origin] = process.argv.slice(2);
let text = ''; for await (const chunk of process.stdin) text += chunk;
const request = JSON.parse(text);
if (!/^[a-f0-9]+$/.test(request.idempotencyKey) || !/^[a-f0-9]{40,64}$/.test(request.sha)) throw new Error('Invalid deployment identity');
await mkdir(root, { recursive: true }); const file = join(root, request.idempotencyKey + '.json');
let receipt; try { receipt = JSON.parse(await readFile(file,'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (!receipt && request.action === 'execute') {
  let mode = ''; try { mode = (await readFile(join(root, 'mode.txt'),'utf8')).trim(); } catch {}
  if(origin && mode !== 'fail') {
    const code=spawnSync('git',['--git-dir',origin,'show',`${request.sha}:sum.mjs`],{encoding:'utf8',windowsHide:true,maxBuffer:100000});
    if(code.status!==0)throw new Error(code.stderr||'Release SHA unavailable');
    const app=join(root,'app');await mkdir(app,{recursive:true});const file=join(app,'sum.mjs');
    await writeFile(file+'.tmp',code.stdout);await rename(file+'.tmp',file);
    const {sum}=await import(pathToFileURL(file).href);assert.equal(sum(2,3),5);assert.equal(sum(-2,1),-1);
  }
  receipt = { schemaVersion:1, idempotencyKey:request.idempotencyKey, sha:request.sha, target:request.target, status: mode === 'fail' ? 'failed' : 'succeeded', evidence:[file] };
  await writeFile(file, JSON.stringify(receipt));
  if (mode === 'lost') { process.exit(1); }
}
console.log(JSON.stringify(receipt ?? { schemaVersion:1, idempotencyKey:request.idempotencyKey, sha:request.sha, target:request.target, status:'not_found', evidence:[] }));
