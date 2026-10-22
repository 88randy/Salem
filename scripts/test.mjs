import {readdir,realpath} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
// Windows runners may expose TEMP using an 8.3 alias. Fixtures and the
// production stores must compare canonical paths, including in subprocesses.
const canonicalTemp=await realpath(tmpdir());
const env={...process.env,TMPDIR:canonicalTemp,TMP:canonicalTemp,TEMP:canonicalTemp};
const tests=(await readdir(new URL('../dist/tests/',import.meta.url))).filter(name=>name.endsWith('.test.js')).sort().map(name=>`dist/tests/${name}`);
if(!tests.length)throw new Error('No compiled core tests found. Build first.');
const child=spawn(process.execPath,['--test','--test-concurrency=1',...process.argv.slice(2),...tests],{stdio:'inherit',windowsHide:true,env});
child.once('error',error=>{console.error(error.message);process.exitCode=1;});
child.once('exit',(code)=>{process.exitCode=code??1;});
