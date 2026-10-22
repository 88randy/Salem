import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [trace, mode, ...args] = process.argv.slice(2);
if (args.includes('--version')) { console.log('codex supervisor-fixture-1'); process.exit(0); }
if (args.includes('--help')) { console.log('--json --output-schema --output-last-message --sandbox --cd'); process.exit(0); }
if (args.includes('status')) { console.log(mode === 'auth' ? 'Not logged in' : 'Logged in using test account'); process.exit(mode === 'auth' ? 1 : 0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
const task = JSON.parse(input.match(/TASK_JSON=(.+)/)[1]);
appendFileSync(trace, JSON.stringify({ stage: task.stage, prompt: input }) + '\n');
if (mode === 'wait' && task.stage === 'build' && !existsSync(trace + '.release')) {
  writeFileSync(trace + '.pid', String(process.pid));
  setInterval(() => {}, 1000); await new Promise(() => {});
}
if (task.stage === 'build') writeFileSync('answer.txt', existsSync('answer.txt') ? 'corrected\n' : 'implemented\n');
let verdict = 'success';
if (mode === 'rework' && task.stage === 'review' && readFileSync('answer.txt', 'utf8') !== 'corrected\n') verdict = 'needs_changes';
const payload = { schemaVersion: 1, stage: task.stage, taskId: task.id, verdict, summary: verdict === 'needs_changes' ? 'Correct answer.txt' : 'Fixture stage done', evidenceRefs: ['answer.txt'], findings: verdict === 'needs_changes' ? [{ severity: 'important', description: 'Correct answer.txt' }] : [] };
if (mode === 'findings' && task.stage === 'review' && readFileSync('answer.txt','utf8') !== 'corrected\n') payload.findings = [{ severity: 'important', description: 'Correct answer.txt despite verdict success' }];
writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(payload));
console.log(JSON.stringify({ type: 'thread.started', thread_id: randomUUID() }));
console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } }));
