import type {ProjectConfig,TaskSpec} from '../../src/contracts';
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
const strings=(v:unknown):v is string[]=>Array.isArray(v)&&v.every(s=>typeof s==='string');
const optionalStrings=(v:unknown)=>v===undefined||strings(v);
// Check rendering structure here. Semantic and filesystem validation belong to the API.
export function profileShape(v:unknown):v is ProjectConfig{
 if(!object(v)||v.schemaVersion!==1||typeof v.projectId!=='string'||typeof v.repoRoot!=='string'||!strings(v.contextFiles)||!object(v.agents)||!Array.isArray(v.checks)||!object(v.capabilities)||!object(v.budgets))return false;
 if(v.instructions!==undefined&&typeof v.instructions!=='string')return false;
 if(!Object.values(v.agents).every(a=>object(a)&&['codex','claude'].includes(String(a.provider))&&strings(a.command)&&(a.model===undefined||typeof a.model==='string')&&(a.effort===undefined||typeof a.effort==='string')))return false;
 if(!v.checks.every(c=>object(c)&&typeof c.id==='string'&&strings(c.command)&&typeof c.required==='boolean'&&(c.final===undefined||typeof c.final==='boolean')&&optionalStrings(c.toolFiles)))return false;
 if(!['edit','commit','pull_request','merge','deploy'].every(k=>typeof (v.capabilities as Record<string,unknown>)[k]==='boolean'))return false;
 if(typeof v.budgets.stageTimeoutMs!=='number'||typeof v.budgets.maxOutputBytes!=='number')return false;
 if(v.supervisor!==undefined&&(!object(v.supervisor)||!object(v.supervisor.roles)||!['define','build','review'].every(k=>typeof (v.supervisor as {roles:Record<string,unknown>}).roles[k]==='string')||typeof v.supervisor.runTimeoutMs!=='number'||typeof v.supervisor.maxAttempts!=='number'))return false;
 if(v.delivery!==undefined){const d=v.delivery;if(!object(d)||typeof d.branchPrefix!=='string'||!object(d.commit)||typeof d.commit.message!=='string'||!object(d.commit.author)||typeof d.commit.author.name!=='string'||typeof d.commit.author.email!=='string')return false;
 if(d.github!==undefined){const g=d.github;if(!object(g)||!strings(g.command)||!optionalStrings(g.toolFiles)||!['remote','remoteUrl','repository','baseBranch'].every(k=>typeof g[k]==='string')||typeof g.draft!=='boolean')return false;if(g.merge!==undefined&&(!object(g.merge)||!strings(g.merge.requiredChecks)||!['merge','squash'].includes(String(g.merge.method))))return false;}
 if(d.deploy!==undefined){const p=d.deploy;if(!object(p)||!strings(p.command)||!strings(p.statusCommand)||!optionalStrings(p.toolFiles)||!strings(p.requiredChecks)||typeof p.target!=='string')return false;}}
 return true;
}
export function taskShape(v:unknown):v is TaskSpec{return object(v)&&typeof v.id==='string'&&typeof v.objective==='string'&&strings(v.scope)&&strings(v.acceptance)&&strings(v.references)&&(v.acceptanceChecks===undefined||(object(v.acceptanceChecks)&&Object.values(v.acceptanceChecks).every(strings)));}
export function preparationShape(v:unknown):v is string[][]{return Array.isArray(v)&&v.every(strings);}
