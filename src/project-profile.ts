import type { ProjectConfig } from "./contracts.js";
import { repositorySnapshot, instructionsHash } from "./repository.js";
export async function diagnoseProject(config: ProjectConfig) {
  const repository=await repositorySnapshot(config.repoRoot),requested=[...(config.delivery?["commit"]:[]),...(config.delivery?.github?["pull_request"]:[]),...(config.delivery?.github?.merge?["merge"]:[]),...(config.delivery?.deploy?["deploy"]:[])];
  const blockedActions=requested.filter(action=>!config.capabilities[action as keyof ProjectConfig["capabilities"]]);
  return {projectId:config.projectId,configuration:"valid",diagnosticOnly:!config.capabilities.edit,repository,instructionsHash:await instructionsHash(config),
    capabilities:config.capabilities,requestedActions:requested,blockedActions,unexecutedChecks:config.checks.map(c=>c.id),
    limitations:["Diagnosis only: no agent, test, commit, network publication, merge or deploy executed.",...(repository.dirty?["Dirty checkout: preserve existing work; use an isolated checkout for execution."]:[])]};
}
