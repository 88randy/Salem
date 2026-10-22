import type {AcceptanceResult,CheckEvidence,StageResult,TaskSpec,Usage} from '../contracts.js';
import type {ProjectRecord} from './contracts.js';
import type {GoalPlan,PlanningResult} from './research-contracts.js';
export type EvolutionStatus='queued'|'baseline'|'planning'|'candidate'|'checking'|'reviewing'|'improved'|'no_improvement'|'blocked'|'failed'|'cancelled'|'interrupted';
export interface CandidatePatch {schemaVersion:1;summary:string;changes:{path:string;content:string}[]}
export interface PatchResult {status:'succeeded'|'failed';patch:CandidatePatch|null;sessionId:string|null;usage:Usage|null;error:string|null;durationMs:number}
export interface EvolutionRecord {
 id:string;revision:number;requestKey:string;taskId:string;projectId:string;agentId:string;
 project:ProjectRecord;task:TaskSpec;sourceSha:string|null;policyHash:string;
 status:EvolutionStatus;reason:string|null;createdAt:number;updatedAt:number;finishedAt:number|null;
 snapshotIds:{baseline:string;candidate:string};baseline:CheckEvidence[];candidateChecks:CheckEvidence[];
 authorityHash?:string;inferenceAttempts?:number;sourceIdentity?:EvolutionSourceIdentity;
 applyOnSuccess?:boolean;
 seal?:{baseTreeHash:string;candidateTreeHash:string;baseFiles:Record<string,string>;candidateFiles:Record<string,string>;patchHash:string};
 promotion?:EvolutionPromotion;
 plan:GoalPlan|null;planning:PlanningResult|null;patch:PatchResult|null;review:StageResult|null;acceptance:AcceptanceResult|null;diff:string;
}
export interface EvolutionRequest {taskId:string;agentId?:string;requestKey:string;applyOnSuccess?:boolean}
export interface EvolutionIncident {id:string;kind:'execution'|'goal';projectId:string;taskId:string|null;summary:string;at:number}
export interface EvolutionSourceIdentity {root:string;gitDir:string;rootKey:string;gitKey:string}
export interface EvolutionPromotion {
 status:'queued'|'preparing'|'applying'|'verifying'|'applied'|'rolling_back'|'rolled_back'|'conflict'|'blocked';
 reason:string;createdAt:number;updatedAt:number;root:string;gitDir:string;head:string;indexHash:string;
 baseTreeHash:string;candidateTreeHash:string;
 identity?:EvolutionSourceIdentity;
 entries:{path:string;before:string;after:string;mode:number}[];
 checks:CheckEvidence[];acceptance:AcceptanceResult|null;
}
