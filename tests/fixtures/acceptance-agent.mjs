import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [trace, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex acceptance-fixture-1'); process.exit(0); }
if (args.includes('--help')) { console.log('--json --output-schema --output-last-message --sandbox --cd'); process.exit(0); }
if (args.includes('status')) { console.log('Logged in using test account'); process.exit(0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
const task = JSON.parse(input.match(/TASK_JSON=(.+)/)[1]);
appendFileSync(trace, JSON.stringify({ stage: task.stage, prompt: input }) + '\n');
if (task.stage === 'build') {
  const builds = readFileSync(trace, 'utf8').trim().split('\n').map(x => JSON.parse(x)).filter(x => x.stage === 'build').length;
  writeFileSync('sum.mjs', `export function sum(a, b) {\n  return a ${builds === 1 ? '-' : '+'} b;\n}\n`);
}
const payload = { schemaVersion: 1, stage: task.stage, taskId: task.id, verdict: 'success', summary: 'Fixture stage; actual checks decide acceptance', evidenceRefs: ['sum.mjs'], findings: [] };
writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(payload));
console.log(JSON.stringify({ type: 'thread.started', thread_id: randomUUID() }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } }));
