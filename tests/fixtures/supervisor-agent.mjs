import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [trace, mode, ...args] = process.argv.slice(2);
const claude = args.includes('--json-schema') || args.includes('auth');
if (args.includes('--version')) { console.log('codex supervisor-fixture-1'); process.exit(0); }
if (args.includes('--help')) { console.log('--json --output-schema --output-last-message --sandbox --cd --json-schema --output-format --tools --allowedTools --setting-sources --strict-mcp-config --mcp-config'); process.exit(0); }
if (args.includes('status')) { console.log(claude ? JSON.stringify({ loggedIn: mode !== 'auth' }) : mode === 'auth' ? 'Not logged in' : 'Logged in using test account'); process.exit(mode === 'auth' ? 1 : 0); }
let input = ''; for await (const chunk of process.stdin) input += chunk;
const task = JSON.parse(input.match(/TASK_JSON=(.+)/)[1]);
appendFileSync(trace, JSON.stringify({ stage: task.stage, provider: claude ? 'claude' : 'codex', prompt: input }) + '\n');
const reviews = readFileSync(trace, 'utf8').trim().split('\n').filter(l => JSON.parse(l).stage === 'review').length;
if (mode === 'wait' && task.stage === 'build' && !existsSync(trace + '.release')) {
  writeFileSync(trace + '.pid', String(process.pid));
  setInterval(() => {}, 1000); await new Promise(() => {});
}
if (task.stage === 'build') writeFileSync('answer.txt', existsSync('answer.txt') ? 'corrected\n' : 'implemented\n');
if (task.stage === 'build' && mode === 'auth-diff') { mkdirSync('auth', { recursive: true }); writeFileSync('auth/permissions.mjs', 'export const canEdit = user => user.role === "owner";\n'); }
if (task.stage === 'build' && mode === 'invented-package') writeFileSync('package.json', JSON.stringify({ name: 'demo', dependencies: { 'left-pad': '1.3.0', 'reqeusts-turbo-ai': '^2.1.0', 'slow-registry-pkg': '1.0.0' } }, null, 2));
if (task.stage === 'build' && mode === 'remove-auth') writeFileSync('orders.js', readFileSync('orders.js', 'utf8').replace('  await authenticate(req);\n', ''));
let verdict = 'success';
if (mode === 'rework' && task.stage === 'review' && readFileSync('answer.txt', 'utf8') !== 'corrected\n') verdict = 'needs_changes';
const payload = { schemaVersion: 1, stage: task.stage, taskId: task.id, verdict, summary: verdict === 'needs_changes' ? 'Correct answer.txt' : 'Fixture stage done', evidenceRefs: ['answer.txt'], findings: verdict === 'needs_changes' ? [{ severity: 'important', description: 'Correct answer.txt' }] : [] };
if (mode === 'findings' && task.stage === 'review' && readFileSync('answer.txt','utf8') !== 'corrected\n') payload.findings = [{ severity: 'important', description: 'Correct answer.txt despite verdict success' }];
if (task.stage === 'review') {
  payload.rubric = Object.fromEntries(['solves', 'correct', 'secure', 'tested', 'understandable', 'style'].map(k => [k, { pass: true, notes: 'Fixture check' }]));
  payload.risk = mode === 'risky-diff' ? { level: 'high', reasons: ['El diff cambia permisos'] } : { level: 'normal', reasons: [] };
  if (mode === 'no-rubric' && reviews === 1) delete payload.rubric.secure;
  if (mode === 'security' && readFileSync('answer.txt', 'utf8') !== 'corrected\n') payload.rubric.secure = { pass: false, notes: 'Expone datos de otros usuarios' };
  if (mode === 'style') { payload.rubric.style = { pass: false, notes: 'Nombre poco claro' }; payload.findings = [{ severity: 'minor', description: 'Renombrar answer.txt' }]; }
  // Acts only on the supervisor's registry receipts, as the template instructs.
  const added = JSON.parse(input.match(/^NEW_DEPENDENCIES_JSON=(.+)$/m)?.[1] ?? '[]'), invented = added.filter(d => d.status === 'not_found').map(d => d.name), unknown = added.filter(d => d.status === 'unknown').map(d => d.name);
  if (unknown.length) payload.summary += `. No se pudo comprobar si existen: ${unknown.join(', ')}`;
  if (invented.length) { payload.verdict = 'needs_changes'; payload.rubric.correct = { pass: false, notes: 'Paquete inexistente' }; payload.findings = [{ severity: 'critical', description: `Paquete inexistente en el registro: ${invented.join(', ')}` }]; }
}
if (claude) console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: payload, session_id: randomUUID(), usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, total_cost_usd: 0.001 }));
else {
  writeFileSync(args[args.indexOf('--output-last-message') + 1], JSON.stringify(payload));
  console.log(JSON.stringify({ type: 'thread.started', thread_id: randomUUID() }));
  console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5, cached_input_tokens: 0 } }));
}
