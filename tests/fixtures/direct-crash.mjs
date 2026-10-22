import {readFile} from 'node:fs/promises';
import {loadProjectConfig} from '../../dist/src/config.js';
import {runDirectTask} from '../../dist/src/direct-workflow.js';
const [profile,task,stateDir]=process.argv.slice(2);
await runDirectTask(JSON.parse(await readFile(task,'utf8')),await loadProjectConfig(profile),{stateDir,onCheckpoint:async state=>{
  if(state.attempts.some(a=>a.stage==='define'&&a.result))process.exit(79);
}});
