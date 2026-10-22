import {buildApplication} from './build.mjs';
import {fileURLToPath} from 'node:url';
import {dirname,resolve} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
await buildApplication(root);
await (await import('../dist/src/local/main.js')).startUI(process.argv.slice(2));
