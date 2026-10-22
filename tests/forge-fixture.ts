import { createServer } from "node:http";
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { git } from "./supervisor-fixture.js";

export async function forgeFixture(origin: string) {
  const state = { canPush: true, loseCreate: "" as "" | "before" | "after", loseMerge: false, strict: true, enforceAdmins: true, checks: [{ name: "build", status: "completed", conclusion: "success" }],
    pulls: [] as Record<string, any>[] };
  const fullName = "demo/project";
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url!, "http://localhost"), suffix = url.pathname.replace(/^\/repos\/demo\/project\/?/, "");
      let text = ""; for await (const b of req) text += b;
      const body = text ? JSON.parse(text) : {};
      let result: unknown;
      if (req.method === "GET" && !suffix) result = { full_name: fullName, permissions: { push: state.canPush } };
      else if (req.method === "GET" && suffix === "branches/main/protection/required_status_checks") result = { strict: state.strict, contexts: ["build"] };
      else if (req.method === "GET" && suffix === "branches/main/protection") result = { required_status_checks: {strict:state.strict,contexts:["build"]},enforce_admins:{enabled:state.enforceAdmins} };
      else if (req.method === "GET" && /^commits\/[^/]+\/check-runs$/.test(suffix)) result = { total_count: state.checks.length, check_runs: state.checks.map((c, i) => ({ ...c, id: i + 1, head_sha: suffix.split("/")[1], app: { id: 1 } })) };
      else if (req.method === "GET" && /^commits\/[^/]+$/.test(suffix)) result = { sha: suffix.split("/")[1], commit: { tree: { sha: await git(origin, "rev-parse", `${suffix.split("/")[1]}^{tree}`) } } };
      else if (req.method === "GET" && suffix === "pulls") result = state.pulls.filter(p => !url.searchParams.get("head") || url.searchParams.get("head") === `demo:${p.head.ref}`);
      else if (req.method === "POST" && suffix === "pulls") {
        if (state.loseCreate === "before") { res.writeHead(500).end("outcome unknown"); return; }
        const headSha = await git(origin, "rev-parse", `refs/heads/${body.head.replace(/^demo:/, "")}`);
        const pr = { number: state.pulls.length + 1, html_url: `https://github.com/demo/project/pull/${state.pulls.length + 1}`, state: "open", merged: false, draft: body.draft,
          title: body.title, body: body.body, head: { sha: headSha, ref: body.head.replace(/^demo:/, ""), repo: { full_name: fullName } },
          base: { sha: await git(origin, "rev-parse", "refs/heads/main"), ref: body.base, repo: { full_name: fullName } }, merge_commit_sha: null };
        state.pulls.push(pr); result = pr;
        if (state.loseCreate === "after") { state.loseCreate = ""; res.writeHead(500).end("response lost after create"); return; }
      } else if (/^pulls\/\d+$/.test(suffix) && req.method === "GET") result = state.pulls.find(p => p.number === Number(suffix.split("/")[1]));
      else if (/^pulls\/\d+\/merge$/.test(suffix) && req.method === "PUT") {
        const pr = state.pulls.find(p => p.number === Number(suffix.split("/")[1]));
        if (!pr || body.sha !== pr.head.sha || !state.strict || state.checks.some(c => c.status !== "completed" || c.conclusion !== "success")) { res.writeHead(409).end("head/check mismatch"); return; }
        const base = await git(origin, "rev-parse", "refs/heads/main"), tree = await git(origin, "rev-parse", `${pr.head.sha}^{tree}`);
        const sha = await git(origin, "-c", "user.name=Forge", "-c", "user.email=forge@example.invalid", "commit-tree", tree, "-p", base, "-p", pr.head.sha, "-m", "Merge demo");
        await git(origin, "update-ref", "refs/heads/main", sha, base);
        pr.merged = true; pr.state = "closed"; pr.merge_commit_sha = sha; result = { merged: true, sha, message: "merged" };
        if (state.loseMerge) { state.loseMerge = false; res.writeHead(500).end("response lost after merge"); return; }
      } else { res.writeHead(404).end("Unsupported fixture route"); return; }
      if (!result) { res.writeHead(404).end("Not found"); return; }
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch (e) { res.writeHead(500).end(String(e)); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { state, url, command: [process.execPath, resolve("tests/fixtures/gh-client.mjs"), url], close: () => new Promise<void>((r,e) => server.close(error => error ? e(error) : r())) };
}
