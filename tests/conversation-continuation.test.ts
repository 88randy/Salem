import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,unlink,symlink,readFile,rmdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LocalStore} from '../src/local/store.js';
import {createLocalDemo} from '../src/local/demo.js';
import {localGit} from '../src/local/git.js';
import {copyAcceptedTree} from '../src/local/continuation.js';
import {repositorySnapshot} from '../src/repository.js';
test('continuation preserves staged bytes, working bytes, new files and deletion without a commit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem tree continuation ')),store=new LocalStore(join(root,'data')),{project}=await createLocalDemo(store),source=project.config.repoRoot,target=join(root,'copy');
 await localGit(source,['clone','--local','--no-hardlinks','--template=','--',source,target],store.root);
 await writeFile(join(source,'sum.mjs'),'export function sum(a,b){return a+b;}\n');await localGit(source,['add','sum.mjs'],store.root);
 await writeFile(join(source,'sum.mjs'),'// Working bytes differ from staged bytes.\nexport function sum(a,b){return a+b;}\n');await writeFile(join(source,'notes.md'),'New file\n');await unlink(join(source,'.gitattributes'));
 const before=await repositorySnapshot(source);await copyAcceptedTree(source,target);const after=await repositorySnapshot(target);
 assert.equal(after.head,before.head);assert.equal(after.treeHash,before.treeHash);assert.equal(after.dirty,before.dirty);assert.deepEqual(await repositorySnapshot(source),before);assert.equal(await readFile(join(target,'notes.md'),'utf8'),'New file\n');
});
test('continuation rejects a redirected Git directory before accessing another checkout',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem unsafe git ')),source=join(root,'source'),target=join(root,'target'),outside=join(root,'outside');
 await mkdir(source);await mkdir(target);await mkdir(outside);await symlink(outside,join(source,'.git'),process.platform==='win32'?'junction':'dir');await mkdir(join(target,'.git'));
 await assert.rejects(copyAcceptedTree(source,target),/directorio Git|copia aislada/i);
});

test('continuation preserves staged directory to file and file to directory transitions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'salem tree type changes ')),store=new LocalStore(join(root,'data')),{project}=await createLocalDemo(store),source=project.config.repoRoot,target=join(root,'copy');
 await mkdir(join(source,'lib'));await writeFile(join(source,'lib','item.mjs'),'old child\n');await writeFile(join(source,'entry'),'old file\n');
 await localGit(source,['add','.'],store.root);await localGit(source,['-c','user.name=Test','-c','user.email=test@example.com','commit','-m','Type transition baseline'],store.root);
 await unlink(join(source,'lib','item.mjs'));await rmdir(join(source,'lib'));await writeFile(join(source,'lib'),'replacement file\n');
 await unlink(join(source,'entry'));await mkdir(join(source,'entry'));await writeFile(join(source,'entry','item.mjs'),'replacement child\n');
 await localGit(source,['add','.'],store.root);
 // Managed preparation clones after accepting the source, so its object store
 // also owns the staged blobs. Its checkout still contains the HEAD file types.
 await localGit(source,['clone','--local','--no-hardlinks','--template=','--',source,target],store.root);
 const before=await repositorySnapshot(source);await copyAcceptedTree(source,target);assert.equal((await repositorySnapshot(target)).treeHash,before.treeHash);assert.equal((await repositorySnapshot(target)).dirty,before.dirty);
 assert.equal(await readFile(join(target,'lib'),'utf8'),'replacement file\n');assert.equal(await readFile(join(target,'entry','item.mjs'),'utf8'),'replacement child\n');
 assert.deepEqual(await repositorySnapshot(source),before);
});
