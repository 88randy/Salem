import type { ProjectRecord } from './contracts.js';
export interface WorkTask {
 id:string; title:string; objective:string; scope:string[]; acceptance:string[]; checkIds:string[]; dependsOn:string[]; agentId:string;
}
export interface WorkGraph { tasks:WorkTask[] }
export interface ChatReference {name:string;text:string}
export interface ChatMessage {
 id:string; key:string; at:number; role:'user'|'salem'; text:string;
 references?:ChatReference[];
 source?:{kind:'conversation'|'goal'|'execution';id:string;revision?:number};
}
export interface ConversationStep {
 key:string; planTask:WorkTask; taskId:string; executionId:string|null; status:'pending'|'running'|'accepted'|'blocked'; attempt:number;
}
export interface ConversationRecord {
 id:string; revision:number; projectId:string; project:ProjectRecord; requestKey:string; objective:string;
 createdAt:number; updatedAt:number;
 status:'planning'|'needs_input'|'working'|'paused'|'blocked'|'completed'|'answered';
 reason:string|null; messages:ChatMessage[]; goalId:string|null; planRevision:number;
 agentId:string; handledCommands:string[];
 failedCommandKey?:string;
 steps:ConversationStep[]; lastAcceptedExecutionId:string|null;
 commands:{key:string;kind:string;text?:string;references?:ChatReference[]}[];
}
