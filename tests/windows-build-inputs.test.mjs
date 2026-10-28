import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,stat,utimes} from 'node:fs/promises';import {join,resolve} from 'node:path';import {createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';
import * as inputs from '../scripts/windows/build-inputs.mjs';
async function fixture(){const parent=resolve('.artifacts/windows-unit-tests');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'build-stamp-'));for(const dir of ['src','ui','templates','scripts/windows','dist/src','web-dist'])await mkdir(join(root,dir),{recursive:true});for(const [name,text]of Object.entries({'src/cli.ts':'export const value=1;','ui/main.tsx':'// UI','templates/define.md':'Define','scripts/build.mjs':'// build fixture','scripts/windows/build-inputs.mjs':'// input fixture','scripts/windows/reproducible-pe.mjs':'// pe fixture','package.json':'{"version":"0.3.0"}','package-lock.json':'{}','tsconfig.json':'{}','dist/src/cli.js':'export const value=1;','web-dist/index.html':'<html></html>'}))await writeFile(join(root,name),text);for(const name of ['dist/src/cli.js','web-dist/index.html'])await utimes(join(root,name),new Date('2030-01-01'),new Date('2030-01-01'));return root;}
test('final packaging rejects a build without a recorded input fingerprint',async()=>{const root=await fixture();await assert.rejects(inputs.assertBuildFresh(root),/huella|sello|build|compil/i);});
test('dependency and compiler input changes invalidate the recorded build even with unchanged timestamps',async()=>{const root=await fixture();for(const name of ['package-lock.json','package.json','tsconfig.json','scripts/windows/reproducible-pe.mjs']){if(typeof inputs.writeBuildStamp==='function')await inputs.writeBuildStamp(root);await inputs.assertBuildFresh(root);const file=join(root,name),before=await stat(file),text=await readFile(file,'utf8');await writeFile(file,text+' ');await utimes(file,before.atime,before.mtime);await assert.rejects(inputs.assertBuildFresh(root),/huella|build|compil/i);await writeFile(file,text);}});
test('the build stamp pins compiled bytes as well as sources',async()=>{const root=await fixture();assert.equal(typeof inputs.writeBuildStamp,'function');await inputs.writeBuildStamp(root);await inputs.assertBuildFresh(root);await writeFile(join(root,'dist/src/cli.js'),'different output');await assert.rejects(inputs.assertBuildFresh(root),/huella|build|compil/i);});
test('the build stamp pins the compiled Windows containment helper',async()=>{const root=await fixture(),helper=join(root,'dist/src/windows-job-helper.exe');await writeFile(helper,'helper v1');await inputs.writeBuildStamp(root);await inputs.assertBuildFresh(root);await writeFile(helper,'swapped helper');await assert.rejects(inputs.assertBuildFresh(root),/huella|build|compil/i);});
test('the build stamp covers only the release containment helper, never the test build',async()=>{const root=await fixture();await writeFile(join(root,'dist/src/windows-job-helper.exe'),'release helper');await mkdir(join(root,'dist/tests'),{recursive:true});const testHelper=join(root,'dist/tests/windows-job-helper.test.exe');await writeFile(testHelper,'test helper v1');const stamp=await inputs.writeBuildStamp(root);assert.deepEqual(Object.keys(stamp.outputs).filter(name=>/windows-job-helper/.test(name)),['dist/src/windows-job-helper.exe']);await writeFile(testHelper,'test helper v2');await inputs.assertBuildFresh(root);});
// Issue #31: csc 4.x has no /deterministic; it writes a fresh COFF TimeDateStamp and
// module MVID on every run. The build derives both from the compiled content instead.
const sha256=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
async function helperDirectory(){const parent=resolve('.artifacts/windows-unit-tests');await mkdir(parent,{recursive:true});return mkdtemp(join(parent,'helper-'));}
const windowsOnly={skip:process.platform!=='win32'&&'needs the .NET Framework compiler'};
test('two compilations of the containment helper produce the same bytes, and the result still runs',windowsOnly,async()=>{
 const build=await import('../scripts/build.mjs');assert.equal(typeof build.compileWindowsHelper,'function');
 // Same file name in both runs: csc takes the assembly and module names from /out.
 const dir=await helperDirectory(),source=resolve('src/windows-job-helper.cs'),first=join(dir,'first','windows-job-helper.exe'),second=join(dir,'second','windows-job-helper.exe');
 build.compileWindowsHelper(source,first);await new Promise(done=>setTimeout(done,1100));build.compileWindowsHelper(source,second);
 assert.equal(await sha256(first),await sha256(second));
 const run=spawnSync(first,[],{input:'',encoding:'utf8',windowsHide:true,timeout:30_000});
 assert.match(run.stdout,/^(?:ready|error )/,`the normalized helper must load and reach Main: ${run.stderr}`);
});
test('the derived PE identity depends on the compiled content and is stable when reapplied',windowsOnly,async()=>{
 const build=await import('../scripts/build.mjs'),pe=await import('../scripts/windows/reproducible-pe.mjs');
 const dir=await helperDirectory(),release=join(dir,'release.exe'),hooks=join(dir,'hooks.exe');
 build.compileWindowsHelper(resolve('src/windows-job-helper.cs'),release);build.compileWindowsHelper(resolve('src/windows-job-helper.cs'),hooks,['/define:SALEM_TEST_HOOKS']);
 const releaseBytes=await readFile(release),hooksBytes=await readFile(hooks),a=pe.peIdentity(releaseBytes),b=pe.peIdentity(hooksBytes);
 assert.notEqual(a.mvid,b.mvid);assert.notEqual(a.timeDateStamp,b.timeDateStamp);
 assert.ok(pe.normalizePeIdentity(releaseBytes).equals(releaseBytes),'normalizing an already normalized image changes nothing');
});
test('the PE normalizer rejects inputs it cannot normalize completely',async()=>{
 const pe=await import('../scripts/windows/reproducible-pe.mjs');
 assert.throws(()=>pe.normalizePeIdentity(Buffer.from('not a PE image')),/PE/);
});
