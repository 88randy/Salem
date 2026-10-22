import type { DeliveryInput, DeliveryReceipt, DeliveryJournal, DeliveryAction, ActionReceipt } from "./delivery-contracts.js";
import type { ProjectConfig } from "./contracts.js";
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { atomicJson, digest, acquireLock } from "./state-store.js";
import { repositorySnapshot, assertStateLocation } from "./repository.js";
import { runProcess, redact } from "./process.js";
import { checkToolHash } from "./checks.js";
import { evaluateAcceptance } from "./acceptance.js";
import { GithubDelivery, record } from "./delivery-github.js";
import { captureDeliveryTree } from "./delivery-tree.js";
import { parseDelivery } from "./delivery-config.js";

export async function deliveryToolsHash(config: ProjectConfig): Promise<string> {
  const d = config.delivery; if (!d) return "no-delivery";
  const hashes = [await checkToolHash(["git"],config.repoRoot)];
  const settings=await runProcess({command:["git","config","--show-origin","--null","--list"],cwd:config.repoRoot,timeoutMs:10000,maxOutputBytes:2000000});
  if(settings.status!=="exited"||settings.exitCode!==0)throw new Error("Cannot fingerprint Git execution configuration");
  // Only the digest leaves memory; configuration may contain credential settings.
  hashes.push(digest(settings.stdout));
  if (d.github) hashes.push(await checkToolHash(d.github.command,config.repoRoot,d.github.toolFiles));
  if (d.deploy) { hashes.push(await checkToolHash(d.deploy.command,config.repoRoot,d.deploy.toolFiles)); hashes.push(await checkToolHash(d.deploy.statusCommand,config.repoRoot,d.deploy.toolFiles)); }
  return digest(hashes);
}
type Outcome = { status: "found" | "absent" | "failed"; evidence: Record<string,unknown> };
function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value); }
export async function deliver(input: DeliveryInput): Promise<DeliveryReceipt> {
  const release=input.lockHeld?async()=>{}:await acquireLock(join(input.context.snapshot.gitDir,"agent-workflow.lock"),input.runId,input.leaseDir??join(resolve(input.artifactDir),"leases"));
  try{return await deliverOwned(input);}finally{await release();}
}
async function deliverOwned(input: DeliveryInput): Promise<DeliveryReceipt> {
  const config = input.context.config, d = config.delivery;
  if (!d || !config.capabilities.commit || d.github && !config.capabilities.pull_request || d.github?.merge && !config.capabilities.merge || d.deploy && !config.capabilities.deploy) throw new Error("Delivery capability/authority not delegated");
  parseDelivery(d);
  if (d.recovery !== "query_only" || !/^(?:feature|fix|refactor|chore|agent)\/[A-Za-z0-9/_-]+$/.test(d.branchPrefix) || !d.commit.author.name.trim() || !d.commit.author.email.trim()) throw new Error("Invalid explicit delivery policy");
  const accepted = await evaluateAcceptance(input.task,input.evidence,input.review,input.context);
  if (!accepted.accepted) throw new Error(`Delivery acceptance rejected: ${accepted.reasons.join("; ")}`);
  const unchanged = async () => { if (digest(await repositorySnapshot(config.repoRoot)) !== digest(input.context.snapshot)) throw new Error("Delivery worktree/version changed after review"); };
  const toolsHash=await deliveryToolsHash(config);
  if(input.expectedToolsHash && input.expectedToolsHash!==toolsHash || input.journal && input.journal.toolsHash!==toolsHash)throw new Error("Delivery tools changed since supervisor preflight");
  await unchanged();
  const artifactDir = resolve(input.artifactDir); await assertStateLocation(config.repoRoot,artifactDir); await mkdir(artifactDir,{recursive:true});
  const hooks=join(artifactDir,"empty-hooks");await mkdir(hooks,{recursive:true});
  let commandIndex = 0;
  const execute = async (command: string[], data?: string, env?: Record<string,string>) => {
    const result = await runProcess({ command, cwd: config.repoRoot, timeoutMs: config.budgets.stageTimeoutMs, maxOutputBytes: config.budgets.maxOutputBytes,
      leaseDir: input.leaseDir??join(artifactDir,"leases"), ...(data !== undefined ? {input:data} : {}), ...(env ? {env} : {}), ...(input.signal ? {signal:input.signal} : {}) });
    await atomicJson(join(artifactDir,`${Date.now()}-${++commandIndex}-${randomUUID()}.json`),{ command:command.map(redact), ...result });
    if (result.status !== "exited" || result.exitCode !== 0) throw new Error(result.error || result.stderr || "Delivery command failed");
    return result.stdout;
  };
  const git = (args: string[], data?: string, env?: Record<string,string>) => execute(["git","-c",`core.hooksPath=${hooks}`,"-c","core.fsmonitor=false",...args],data,{GIT_TERMINAL_PROMPT:"0",...env});
  const remote = d.github ? new GithubDelivery(d.github,async(method,path,body) => JSON.parse(await execute([...d.github!.command,"api",path,"--hostname","github.com","--method",method,...(body === undefined ? [] : ["--input","-"])],body === undefined ? undefined : JSON.stringify(body)))) : null;
  const pushDestination=async()=>{
    const urls=(await git(["remote","get-url","--push","--all",d.github!.remote])).split(/\r?\n/).map(v=>v.trim()).filter(Boolean);
    if(urls.length!==1||urls[0]!==d.github!.remoteUrl)throw new Error("Delivery requires exactly one authorized effective push destination URL");
    return urls[0]!;
  };
  // Verify permissions and immutable destinations before making even a local commit.
  if (d.github) {
    await pushDestination();
    await remote!.permission();
  }
  const key = digest({runId:input.runId, fingerprint:input.context.fingerprint, config:d});
  const journal: DeliveryJournal = input.journal ? structuredClone(input.journal) : { schemaVersion:1,key,fingerprint:input.context.fingerprint,configHash:digest(config),toolsHash,reviewed:input.context.snapshot,
    createdAt:Date.now(),branch:d.branchPrefix+input.runId,tree:null,commitSha:null,releaseSha:null,actions:[] };
  if (journal.schemaVersion !== 1 || journal.key !== key || journal.fingerprint !== input.context.fingerprint || journal.configHash !== digest(config) || journal.toolsHash !== toolsHash
    || digest(journal.reviewed) !== digest(input.context.snapshot) || journal.branch !== d.branchPrefix+input.runId) throw new Error("Delivery journal identity/version/tool mismatch");
  if ((await git(["check-ref-format","--branch",journal.branch])).trim() !== journal.branch) throw new Error("Invalid reserved delivery branch");
  const save = async () => { await atomicJson(join(artifactDir,"journal.json"),journal); await input.onCheckpoint?.(structuredClone(journal)); };
  let reason = "Delivery outcome unknown; query required";
  const finish = (success: boolean): DeliveryReceipt => ({ id:key,fingerprint:journal.fingerprint,verdict:success?"success":"blocked",summary:success?"Delegated delivery confirmed":reason,
    evidenceRefs:[join(artifactDir,"journal.json")],sha:journal.releaseSha ?? journal.commitSha,target:d.deploy?.target ?? d.github?.repository ?? config.repoRoot,idempotencyKey:key,actions:journal.actions,journal });
  const step = async(action:DeliveryAction,actionSha:string,target:string,query:()=>Promise<Outcome>,perform:()=>Promise<void>,safeRetry=false):Promise<boolean> => {
    let entry = journal.actions.find(a=>a.action===action);
    const actionKey = digest({key,action,sha:actionSha,target});
    if (entry && (entry.idempotencyKey !== actionKey || entry.sha !== actionSha || entry.target !== target)) throw new Error("Action receipt identity mismatch");
    if (input.signal?.aborted) { reason="Delivery cancelled; retained action receipts"; return false; }
    await unchanged();
    if(await deliveryToolsHash(config)!==toolsHash)throw new Error("Delivery tool changed before action");
    let observed: Outcome;
    try { observed=await query(); } catch(e) { reason=redact((e as Error).message); return false; }
    if (observed.status === "found") {
      entry ??= {action,idempotencyKey:actionKey,sha:actionSha,target,status:"intent",evidence:{},reason:null};
      if (!journal.actions.includes(entry)) journal.actions.push(entry);
      entry.status="succeeded";entry.evidence=observed.evidence;entry.reason=null;await save(); await unchanged();return true;
    }
    if (observed.status === "failed" || entry?.status === "succeeded" || entry?.status === "failed" || entry && !safeRetry) {
      reason=`${action}: remote result failed, changed or unknown; query_only forbids blind repetition`;
      if (entry && observed.status === "failed") {entry.status="failed";entry.evidence=observed.evidence;entry.reason=reason;await save();} return false;
    }
    entry ??= {action,idempotencyKey:actionKey,sha:actionSha,target,status:"intent",evidence:{},reason:null};
    if (!journal.actions.includes(entry)) journal.actions.push(entry);
    entry.status="intent";await save();
    if (input.signal?.aborted) {reason="Delivery cancelled before effect";return false;}
    await unchanged();
    try { await perform(); observed=await query(); }
    catch(e) { entry.status="unknown";entry.reason=reason=redact((e as Error).message);await save();return false; }
    entry.status=observed.status === "found" ? "succeeded" : observed.status === "failed" ? "failed" : "unknown";
    entry.evidence=observed.evidence;entry.reason=entry.status === "succeeded" ? null : reason=`${action}: outcome ${entry.status}; reconciliation required`;
    await save();await unchanged();return entry.status === "succeeded";
  };
  await save();
  // Preparing blobs is local and idempotent; the intent is durable before writes.
  if (!journal.actions.some(a=>a.action === "commit")) {
    const actionSha=input.context.snapshot.head,target=journal.branch;
    journal.actions.push({action:"commit",idempotencyKey:digest({key,action:"commit",sha:actionSha,target}),sha:actionSha,target,status:"intent",evidence:{},reason:null});await save();
  }
  const tree=await captureDeliveryTree(config.repoRoot,git);await unchanged();
  const reviewedPaths=new Set(((await git(["diff","--no-ext-diff","--no-textconv","--name-only","-z","HEAD"]))+"\0"+(await git(["ls-files","--others","--exclude-standard","-z"]))).split("\0").filter(Boolean));
  const preparedPaths=(await git(["diff-tree","--no-commit-id","--name-only","-r","-z",input.context.snapshot.head,tree])).split("\0").filter(Boolean);
  if(preparedPaths.some(path=>!reviewedPaths.has(path)))throw new Error("Raw materialization introduces normalization changes outside the reviewed diff; prepare a consistent isolated checkout before running");
  if (journal.tree && journal.tree !== tree) throw new Error("Delivery tree changed after intent");journal.tree=tree;await save();
  const message=`${d.commit.message}\n\nAgent-Workflow-Key: ${key}\n`, ref=`refs/heads/${journal.branch}`;
  const date=new Date(journal.createdAt).toISOString();
  const identity={GIT_AUTHOR_NAME:d.commit.author.name,GIT_AUTHOR_EMAIL:d.commit.author.email,GIT_COMMITTER_NAME:d.commit.author.name,GIT_COMMITTER_EMAIL:d.commit.author.email,GIT_AUTHOR_DATE:date,GIT_COMMITTER_DATE:date};
  // Deterministic orphan creation is safe to repeat; ref CAS never overwrites.
  const candidate=(await git(["commit-tree",tree,"-p",input.context.snapshot.head],message,identity)).trim();
  if (!sha(candidate) || journal.commitSha && journal.commitSha !== candidate) throw new Error("Deterministic commit identity mismatch");journal.commitSha=candidate;
  if (!await step("commit",input.context.snapshot.head,journal.branch,async()=>{
    const refs=(await git(["for-each-ref","--format=%(refname) %(objectname)",ref])).split("\n").find(line=>line.startsWith(`${ref} `))?.slice(ref.length+1).trim();
    if (!refs) return {status:"absent",evidence:{}};
    if (refs !== candidate) throw new Error("Reserved branch already has another commit");
    return {status:"found",evidence:{sha:candidate,tree,parent:input.context.snapshot.head,ref}};
  },async()=>{await git(["update-ref",ref,candidate,"0".repeat(candidate.length)]);},true))return finish(false);
  if (input.signal?.aborted) {reason="Delivery cancelled after commit";return finish(false);}
  let pr: Record<string,any> | null=null;
  if (remote && d.github) {
    const gh=d.github;
    if (!await step("push",candidate,gh.remoteUrl,async()=>{
      const target=await pushDestination();
      const current=(await git(["ls-remote","--refs","--",target,ref])).split(/\r?\n/).map(line=>line.split("\t")).find(parts=>parts[1]===ref)?.[0];if(!current)return{status:"absent",evidence:{}};
      if(current!==candidate)throw new Error("Remote reserved branch has another SHA");
      return{status:"found",evidence:{sha:candidate,ref,remote:gh.remoteUrl}};
    },async()=>{const target=await pushDestination();await git(["-c","push.followTags=false","-c",`remote.${gh.remote}.mirror=false`,"push","--no-follow-tags","--recurse-submodules=no","--",target,`${candidate}:${ref}`]);},true))return finish(false);
    if (!await step("pull_request",candidate,gh.repository,async()=>{
      pr=await remote.findPr(journal.branch,candidate,key);return pr?{status:pr.state==="open"||pr.merged===true?"found":"failed",evidence:{number:pr.number,url:pr.html_url,head:candidate,base:pr.base.ref}}:{status:"absent",evidence:{}};
    },async()=>{await remote.api("POST",`${remote.prefix}/pulls`,{title:d.commit.message.split("\n")[0],body:`${input.task.objective}\n\nAccepted fingerprint: ${journal.fingerprint}\n<!-- agent-workflow:${key} -->`,head:journal.branch,base:gh.baseBranch,draft:gh.draft});}))return finish(false);
    if (gh.merge) {
      const queryMerge=async():Promise<Outcome>=>{
        pr=await remote.findPr(journal.branch,candidate,key);if(!pr)return{status:"absent",evidence:{}};
        if(pr.merged!==true)return{status:pr.state==="open"?"absent":"failed",evidence:{number:pr.number}};
        await remote.checks(candidate,gh.merge!.requiredChecks);await remote.mergePolicy();
        if(!journal.actions.some(a=>a.action==="merge"))throw new Error("External merge without a run-owned intent requires reconciliation");
        if(!sha(pr.merge_commit_sha))throw new Error("Merge SHA missing");await remote.mergedTree(pr.merge_commit_sha,tree);journal.releaseSha=pr.merge_commit_sha;
        return{status:"found",evidence:{number:pr.number,url:pr.html_url,sha:pr.merge_commit_sha,tree,head:candidate}};
      };
      const pending=journal.actions.find(a=>a.action==="merge");
      if(!pending){
        try { pr=await remote.findPr(journal.branch,candidate,key);if(!pr)throw new Error("PR disappeared");
          if(!pr.merged){if(pr.draft!==false||pr.base.sha!==input.context.snapshot.head)throw new Error("Draft or changed base requires revalidation");await remote.checks(candidate,gh.merge.requiredChecks);await remote.mergePolicy();}
        }catch(e){reason=redact((e as Error).message);return finish(false);}
      }
      if(!await step("merge",candidate,gh.repository,queryMerge,async()=>{
        await remote.checks(candidate,gh.merge!.requiredChecks);await remote.mergePolicy();
        const current=await remote.findPr(journal.branch,candidate,key);if(!current||current.base.sha!==input.context.snapshot.head||current.draft!==false)throw new Error("PR changed before merge");
        const result=record(await remote.api("PUT",`${remote.prefix}/pulls/${current.number}/merge`,{sha:candidate,merge_method:gh.merge!.method}));if(result.merged!==true)throw new Error("Merge not confirmed");
      }))return finish(false);
    }
  }
  journal.releaseSha??=candidate;
  if(d.deploy){
    if(d.deploy.requiredChecks.length){try{if(!remote)throw new Error("Release checks require remote provider");await remote.checks(journal.releaseSha,d.deploy.requiredChecks);}catch(e){reason=redact((e as Error).message);return finish(false);}}
    const actionKey=digest({key,action:"deploy",sha:journal.releaseSha,target:d.deploy.target});
    const payload={schemaVersion:1,idempotencyKey:actionKey,sha:journal.releaseSha,tree,target:d.deploy.target};
    const query=async():Promise<Outcome>=>{
      const result=record(JSON.parse(await execute(d.deploy!.statusCommand,JSON.stringify({...payload,action:"query"}))));
      if(result.schemaVersion!==1||result.idempotencyKey!==actionKey||result.sha!==payload.sha||result.target!==payload.target||!Array.isArray(result.evidence)||!result.evidence.every((e:unknown)=>typeof e==="string"))throw new Error("Deployment query identity/proof invalid");
      if(result.status==="succeeded"&&result.evidence.length)return{status:"found",evidence:result};
      if(result.status==="not_found")return{status:"absent",evidence:result};
      if(result.status==="failed")return{status:"failed",evidence:result};throw new Error("Deployment pending/unknown");
    };
    if(!await step("deploy",journal.releaseSha,d.deploy.target,query,async()=>{await execute(d.deploy!.command,JSON.stringify({...payload,action:"execute"}));}))return finish(false);
  }
  if(input.signal?.aborted){reason="Delivery cancelled; confirmed receipts retained";return finish(false);}
  await unchanged();await save();return finish(true);
}
