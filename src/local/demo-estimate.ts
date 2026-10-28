import type { Provider } from "./contracts.js";

export type DemoStage = "define" | "build" | "review";
export type DemoRoles = Record<DemoStage, Provider>;
export interface DemoRange { min: number; max: number }
/** Provider-reported usage of real demo runs; `runs` counts only runs that reported usage. */
export interface DemoProviderReference { model: string; effort: string | null; runs: number; tokens: DemoRange; wallMs: DemoRange }
export interface DemoScenarioReference { roles: DemoRoles; measuredAt: string; salemVersion: string; providers: Partial<Record<Provider, DemoProviderReference>> }
export interface DemoEstimateReference { version: 1; scenarios: DemoScenarioReference[] }
export interface DemoProviderEstimate {
  provider: Provider; stages: DemoStage[]; model: string | null; effort: string | null;
  reference: (DemoProviderReference & { measuredAt: string; salemVersion: string }) | null; matchesReference: boolean;
}
export interface DemoPlan { roles: DemoRoles; selected: Provider; fallback: boolean; crossProvider: boolean; estimates: DemoProviderEstimate[] }

// Only measured runs belong here. No reference run has been recorded yet, so every provider is shown as unknown.
export const demoEstimate: DemoEstimateReference = { version: 1, scenarios: [] };
