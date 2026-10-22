import type { DeliveryConfig } from "./delivery-contracts.js";
function object(v: unknown, keys: string[]): Record<string,unknown> {
  if (!v || typeof v!=="object"||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw new Error("Invalid/unknown delivery config");return v as Record<string,unknown>;
}
function text(v: unknown): string {if(typeof v!=="string"||!v.trim()||v.includes("\0"))throw new Error("Invalid delivery text");return v;}
function strings(v:unknown,nonempty=true):string[]{if(!Array.isArray(v)||nonempty&&!v.length)throw new Error("Invalid delivery command/checks");return v.map(text);}
function tools(v: Record<string,unknown>):{toolFiles?:string[]}{return "toolFiles" in v?{toolFiles:strings(v.toolFiles)}:{};}
export function parseDelivery(raw:unknown):DeliveryConfig{
  const d=object(raw,["branchPrefix","recovery","commit","github","deploy"]),prefix=text(d.branchPrefix);
  if(!/^(?:feature|fix|refactor|chore|agent)\/[A-Za-z0-9/_-]+$/.test(prefix)||prefix.includes("..")||prefix.includes("//"))throw new Error("Invalid reserved delivery branch prefix");
  if(d.recovery!=="query_only")throw new Error("Explicit query_only delivery recovery required");
  const c=object(d.commit,["message","author"]),a=object(c.author,["name","email"]),name=text(a.name),email=text(a.email);
  if(/[<>\r\n]/.test(name)||!/^[^\s<>@]+@[^\s<>@]+$/.test(email))throw new Error("Invalid delivery author");
  const result:DeliveryConfig={branchPrefix:prefix,recovery:"query_only",commit:{message:text(c.message),author:{name,email}}};
  if(d.github!==undefined){
    const g=object(d.github,["command","toolFiles","remote","remoteUrl","repository","baseBranch","draft","merge"]),repo=text(g.repository),remote=text(g.remote),remoteUrl=text(g.remoteUrl),base=text(g.baseBranch);
    if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)||!/^\w[\w.-]*$/.test(remote)||base.startsWith("-")||/\s|[~^:?*\[\\]|\.\./.test(base)||typeof g.draft!=="boolean"||/[\r\n]/.test(remoteUrl)||/https?:\/\/[^/]*@/.test(remoteUrl))throw new Error("Invalid delivery repository/destination");
    result.github={command:strings(g.command),...tools(g),remote,remoteUrl,repository:repo,baseBranch:base,draft:g.draft};
    if(g.merge!==undefined){const m=object(g.merge,["method","requiredChecks"]);if(m.method!=="merge"&&m.method!=="squash")throw new Error("Invalid merge method");if(g.draft)throw new Error("Draft delivery cannot request merge");result.github.merge={method:m.method,requiredChecks:[...new Set(strings(m.requiredChecks))]};}
  }
  if(d.deploy!==undefined){const p=object(d.deploy,["command","statusCommand","toolFiles","target","requiredChecks"]);result.deploy={command:strings(p.command),statusCommand:strings(p.statusCommand),...tools(p),target:text(p.target),requiredChecks:[...new Set(strings(p.requiredChecks,false))]};}
  return result;
}
