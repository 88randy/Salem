import { runProcess } from '../../dist/src/process.js';
import { writeFile } from 'node:fs/promises';
const [cwd, leaseDir, pidFile] = process.argv.slice(2);
const result = await runProcess({ command: [process.execPath, '-e', `require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`, pidFile], cwd, leaseDir, timeoutMs: 20000, maxOutputBytes: 10000 });
await writeFile(pidFile + '.result', JSON.stringify(result));
