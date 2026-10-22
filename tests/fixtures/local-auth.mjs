import { appendFile, readFile, writeFile } from 'node:fs/promises';
const argv = process.argv.slice(2);
const stateFile = argv[argv.indexOf('--state') + 1];
const provider = argv[argv.indexOf('--provider') + 1];
const args = argv.slice(argv.indexOf('--provider') + 2);
const state = JSON.parse(await readFile(stateFile, 'utf8'));
await appendFile(`${stateFile}.events`, `${JSON.stringify(args)}\n`);
if (args.includes('--version')) { console.log(`${provider} fixture 1.0`); process.exit(0); }
if (args.includes('--help')) {
  if (state.incompatible) { console.log('Unrelated CLI'); process.exit(0); }
  console.log('--json --output-schema --output-last-message --sandbox --cd --ignore-user-config --json-schema --output-format --tools --allowedTools --setting-sources --strict-mcp-config --mcp-config');
  process.exit(0);
}
if (args.includes('status')) {
  if (provider === 'claude') console.log(JSON.stringify({ loggedIn: state.statusPositive ?? state.authenticated }));
  else console.error((state.statusPositive ?? state.authenticated) ? 'Logged in using ChatGPT' : 'Not logged in');
  process.exit(state.statusExit ?? (state.authenticated ? 0 : 1));
}
if (args.includes('logout')) {
  if (state.logoutFails) process.exit(1);
  if (state.logoutGate) {
    await writeFile(`${stateFile}.logout-pid`, String(process.pid));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { await readFile(state.logoutGate); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    try { await readFile(state.logoutGate); } catch { process.exit(2); }
  }
  await writeFile(stateFile, JSON.stringify({ ...state, authenticated: false, statusPositive: undefined }));
  console.log('Logged out'); process.exit(0);
}
if (args.includes('login')) {
  await writeFile(`${stateFile}.pid`, String(process.pid));
  console.log('private-access-token-do-not-expose');
  console.log(`\u001b[36mOpen ${state.url ?? (provider === 'codex' ? 'https://auth.openai.com/codex/device' : 'https://claude.ai/oauth/authorize?code=true&client_id=fixture')}\u001b[0m`);
  if (args.includes('--device-auth')) console.log('Enter this one-time code: ABCD-EFGH');
  if (state.mode === 'nonzero') { console.log('Successfully logged in'); process.exit(1); }
  if (state.mode === 'auto') {
    await writeFile(stateFile, JSON.stringify({ ...state, authenticated: !state.noSessionAfterLogin }));
    process.exit(0);
  }
  console.log('Paste the authorization code here:');
  process.stdin.on('data', async data => {
    if (data.toString().trim() === 'fixture-return-code') {
      await writeFile(stateFile, JSON.stringify({ ...state, authenticated: true }));
      process.exit(0);
    } else process.exit(1);
  });
  setInterval(() => {}, 1000);
} else process.exit(2);
