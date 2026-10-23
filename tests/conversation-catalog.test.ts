import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {atomicJson,digest} from '../src/state-store.js';
test('catalog upgrades preserve the exact v1 data and prevent old readers from running managed work',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem catalog migration ')),store=new LocalStore(root),old={...await store.readState(),schemaVersion:1 as const};
 const envelope={checksum:digest(old),value:old};await atomicJson(join(root,'catalog.json'),envelope);const oldBytes=await readFile(join(root,'catalog.json'),'utf8');
 assert.equal((await new LocalStore(root).readState()).schemaVersion,1,'reading v1 is backward compatible');
 await store.saveSettings({...old.settings,maxConcurrentRuns:2});const updated=await store.readState();assert.equal(updated.schemaVersion,2,'0.4 accepts only schema 1, so it must reject the upgraded catalog');
 const backups=(await readdir(root)).filter(n=>/^catalog\.v1-backup-.*\.json$/.test(n));assert.equal(backups.length,1);assert.equal(await readFile(join(root,backups[0]!),'utf8'),oldBytes);
 await store.saveSettings({...updated.settings,maxConcurrentRuns:1});assert.equal((await readdir(root)).filter(n=>n.startsWith('catalog.v1-backup-')).length,1);assert.equal((await new LocalStore(root).readState()).schemaVersion,2);
});
