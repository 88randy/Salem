import { useState } from 'react';
import type { AgentConfig } from '../../src/contracts';
import { MODEL_GUIDANCE_DATE, MODEL_GUIDANCE_SOURCES, modelPresets } from '../../src/model-presets';
import { Select, Text } from './fields';

function effortLevels(agent: AgentConfig): string[] {
  if (agent.provider === 'claude') return ['claude-opus-5-5', 'opus'].includes(agent.model || '') ? ['low', 'medium', 'high', 'xhigh', 'max'] : [];
  if (agent.model === 'gpt-6-luna') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return ['gpt-6.1-sol', 'gpt-6-astra'].includes(agent.model || '') ? ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] : [];
}

export function ModelFields({ label, agent, onChange }: { label: string; agent: AgentConfig; onChange: (agent: AgentConfig) => void }) {
  const [custom, setCustom] = useState(false);
  const [customEffort, setCustomEffort] = useState(false);
  const options = modelPresets(agent.provider);
  const known = options.find(option => option.id === agent.model);
  const source = MODEL_GUIDANCE_SOURCES[agent.provider];
  const selected = custom ? '__custom__' : !agent.model ? '' : known ? agent.model : '__custom__';
  const levels = effortLevels(agent);
  const selectedEffort = customEffort ? '__custom__' : !agent.effort ? '' : levels.includes(agent.effort) ? agent.effort : '__custom__';
  return <>
    <Select label={`${label}: selección de modelo`} value={selected}
      options={[{ value: '', label: 'Predeterminado del CLI' }, ...options.map(option => ({ value: option.id, label: option.label })), { value: '__custom__', label: 'Personalizado' }]}
      onChange={value => {
        setCustom(value === '__custom__');
        if (value === '__custom__') return;
        const next = { ...agent };
        delete next.model;
        if (!value) delete next.effort;
        if (value) next.model = value;
        onChange(next);
      }} />
    <Text label={`${label}: modelo (opcional)`} value={agent.model || ''} onChange={model => onChange({ ...agent, model })}
      hint={known?.purpose || (agent.model ? 'Se conserva tu identificador personalizado. Salem no comprueba su disponibilidad al guardar.' : 'El CLI resolverá su modelo según tu cuenta y configuración.')} />
    <Select label={`${label}: selección de esfuerzo`} value={selectedEffort}
      options={[{ value: '', label: 'Predeterminado del CLI' }, ...levels.map(value => ({ value, label: ({ low: 'Bajo', medium: 'Medio', high: 'Alto', xhigh: 'Muy alto', max: 'Máximo', ultra: 'Ultra' } as Record<string, string>)[value] + ` (${value})` })), { value: '__custom__', label: 'Personalizado' }]}
      onChange={effort => {
        setCustomEffort(effort === '__custom__');
        if (effort === '__custom__') return;
        const next = { ...agent };
        if (effort) next.effort = effort;
        else delete next.effort;
        onChange(next);
      }} />
    <Text label={`${label}: esfuerzo (opcional)`} value={agent.effort || ''} onChange={effort => onChange({ ...agent, effort })}
      hint={agent.provider === 'claude' ? 'Vacío usa el esfuerzo del CLI. Los niveles dependen del modelo; max se aplica a la sesión. Se conservan valores personalizados.' : 'Vacío usa el esfuerzo del CLI. La disponibilidad de cada nivel depende de tu modelo, cliente y cuenta. Se conservan valores personalizados.'} />
    <p className="muted">Guía consultada el {MODEL_GUIDANCE_DATE}: <a href={source.url} target="_blank" rel="noreferrer">{source.label}</a>. La disponibilidad depende de tu cuenta y cliente; una cuenta conectada no confirma acceso a cada modelo. Un rechazo se muestra sin sustituir tu elección.</p>
  </>;
}
