import { writeFileSync, readFileSync } from 'node:fs';
const [provider, mode, ...args] = process.argv.slice(2);
if (args.includes('--version')) {
  if (mode === 'markversion') writeFileSync('version-started', 'started');
  if (mode === 'slowversion') await new Promise(resolve => setTimeout(resolve, 8000));
  console.log(provider + ' fixture-1.0'); process.exit(0);
}
if (args.includes('--help')) { console.log('--json --output-schema --output-last-message --sandbox --cd --json-schema --output-format --tools --allowedTools --setting-sources --strict-mcp-config --mcp-config --permission-mode'); process.exit(0); }
if (args.includes('status')) {
  if (provider === 'claude') console.log(JSON.stringify({loggedIn: mode !== 'auth'}));
  else console.log(mode === 'auth' ? 'Not logged in' : 'Logged in using test account');
  process.exit(mode === 'auth' || mode === 'auth-error' ? 1 : 0);
}
if (mode === 'wait') { setInterval(() => {}, 1000); }
else if (mode === 'noise') { console.log('x'.repeat(10000)); }
else {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const task = JSON.parse(input.match(/TASK_JSON=(.+)/)?.[1] ?? '{}');
  const payload = { schemaVersion: 1, stage: task.stage, taskId: task.id, verdict: 'success', summary: 'fixture result', evidenceRefs: ['AGENTS.md'], findings: [] };
  if (mode === 'smoke' || mode === 'prefix') {
    payload.summary = readFileSync('AGENTS.md', 'utf8').match(/CONTEXTO-[A-Za-z0-9-]+/)?.[0] ?? 'no marker';
    if (mode === 'prefix') payload.summary = payload.summary.slice(0, -3);
  }
  if (mode === 'wrong-task') payload.taskId = 'someone-else';
  if (mode === 'secret' || mode === 'secret-failed') payload.summary = process.env.AGENT_WORKFLOW_TEST_TOKEN;
  if (mode === 'large-file') payload.summary = 'x'.repeat(100000);
  if (mode === 'malformed') { console.log('not json'); process.exit(0); }
  if (mode === 'auth') { console.log(JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in' })); process.exit(1); }
  if (mode === 'service-error' || mode === 'service-error-zero') {
    const message=(provider==='claude'?"You've hit your session limit; resets 6:10pm.":'The selected model is not supported for this account.')+' '+(process.env.AGENT_WORKFLOW_TEST_TOKEN??'')+' '+ 'x'.repeat(900);
    console.log(JSON.stringify(provider==='claude'?{type:'result',subtype:'success',is_error:true,api_error_status:429,api_error:'usage_limit_reached',result:message}:{type:'turn.failed',error:{message}}));
    process.exit(mode==='service-error-zero'?0:1);
  }
  if (mode === 'usage-failed') {
    console.log(JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'failed-session',
      usage: { input_tokens: 11, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, total_cost_usd: 0.03 })); process.exit(1);
  }
  if (mode === 'no-result') { console.log(JSON.stringify({ type: 'turn.completed', usage: {} })); process.exit(0); }
  if (provider === 'codex') {
    const file = args[args.indexOf('--output-last-message') + 1];
    writeFileSync(file, JSON.stringify(payload));
    if (mode === 'secret-failed') process.exit(1);
    console.log(JSON.stringify({ type: 'thread.started', thread_id: 'fixture-session' }));
    console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3, cached_input_tokens: 2 } }));
  } else {
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: payload, session_id: 'fixture-session', usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 2 }, modelUsage: { fixture: {} }, total_cost_usd: 0.001 }));
  }
}
