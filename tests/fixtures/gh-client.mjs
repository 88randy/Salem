// Process-boundary double: forwards the real gh api argv protocol to a local REST fixture.
const [url, ...args] = process.argv.slice(2);
if (args[0] !== 'api') throw new Error('Expected gh api');
const endpoint = args[1], methodIndex = args.indexOf('--method');
const method = args[methodIndex + 1];
if (!endpoint?.startsWith('repos/demo/project') || !['GET','POST','PUT'].includes(method)) throw new Error('Unexpected target/method');
let data = ''; for await (const chunk of process.stdin) data += chunk;
const response = await fetch(`${url}/${endpoint}`, { method, ...(method === 'GET' ? {} : { body: data, headers: { 'Content-Type': 'application/json' } }) });
const text = await response.text();
if (!response.ok) { process.stderr.write(text); process.exitCode = 1; } else process.stdout.write(text);
