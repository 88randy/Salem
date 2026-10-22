import type { AgentConfig } from './contracts.js';

type ModelProvider = AgentConfig['provider'];
export interface ModelPreset {
  id: string;
  label: string;
  purpose: string;
}
export const MODEL_GUIDANCE_DATE = '2026-10-22';
export const MODEL_GUIDANCE_SOURCES = {
  codex: { label: 'Modelos de Codex', url: 'https://learn.chatgpt.com/docs/models' },
  claude: { label: 'Modelos de Claude Code', url: 'https://code.claude.com/docs/en/model-config' },
} as const;

const presets: Record<ModelProvider, readonly ModelPreset[]> = {
  codex: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol (programación)', purpose: 'Propuesta para programación y agentes, si tu cuenta y cliente lo admiten.' },
    { id: 'gpt-6-luna', label: 'GPT-6 Luna (tareas concretas)', purpose: 'Opción para tareas concretas y acotadas.' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra (tareas complejas)', purpose: 'Opción para trabajo de mayor complejidad.' },
  ],
  claude: [
    { id: 'claude-opus-5-5', label: 'Opus 5.5 (planificación y revisión)', purpose: 'Propuesta de este perfil para planificación y revisión, con esfuerzo medio.' },
    { id: 'sonnet', label: 'Sonnet (programación diaria)', purpose: 'Alias recomendado para programación diaria; sigue la versión vigente de Sonnet.' },
    { id: 'haiku', label: 'Haiku (tareas eficientes)', purpose: 'Alias para tareas sencillas con prioridad en eficiencia.' },
    { id: 'opus', label: 'Opus (versión vigente)', purpose: 'Alias para tareas complejas; sigue la versión vigente de Opus.' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 (versión fija)', purpose: 'Versión fija de Sonnet para conservar una selección explícita.' },
  ],
};
export const modelPresets = (provider: ModelProvider): readonly ModelPreset[] => presets[provider];
export function recommendedModel(provider: ModelProvider): Pick<AgentConfig, 'model' | 'effort'> {
  return provider === 'codex' ? { model: 'gpt-6.1-sol' } : { model: 'claude-opus-5-5', effort: 'medium' };
}
/** A provider change is an explicit new selection, never a fallback after an API rejection. */
export function changeAgentProvider(agent: AgentConfig, provider: ModelProvider, command: string[]): AgentConfig {
  if (provider === agent.provider) return agent;
  const { model: _model, effort: _effort, ignoreUserConfig: _ignore, ...rest } = agent;
  return { ...rest, provider, command: [...command], ...recommendedModel(provider), ...(provider === 'codex' ? { ignoreUserConfig: true } : {}) };
}
