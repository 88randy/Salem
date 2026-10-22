import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, FolderOpen, Plus, RefreshCw, Square } from 'lucide-react';
import type { LocalSettings, LocalState, ProjectInput, ProjectRecord, Provider, TaskRecord } from '../../src/local/contracts';
import type { DiscoveryReport, GoalPlan, GoalRecord } from '../../src/local/research-contracts';
import { api } from './api';
import { Area, FolderPicker, Group, Select, Text } from './fields';
import { ModelFields } from './model-fields';

const providerNames = { codex: 'Codex', claude: 'Claude' };
const goalNames: Record<GoalRecord['status'], string> = {
  queued: 'En cola', investigating: 'Investigando', ready: 'Plan listo', needs_input: 'Necesita tu respuesta',
  blocked: 'Bloqueado', failed: 'Fallido', cancelled: 'Cancelado', interrupted: 'Interrumpido', materialized: 'Tarea creada',
};
const stamp = (value: number) => new Date(value).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const number = (value: number | null | undefined) => value == null ? 'No reportado' : value.toLocaleString('es-MX');
const commandText = (command: string[]) => command.map(part => /\s/.test(part) ? JSON.stringify(part) : part).join(' ');

export function ProjectDiscovery({ settings, onSave, onAdvanced, onCancel, onError }: {
  settings: LocalSettings; onSave: (project: ProjectInput) => Promise<void>;
  onAdvanced: (project: ProjectInput) => void; onCancel: () => void; onError: (error: unknown) => void;
}) {
  const [repoRoot, setRepoRoot] = useState('');
  const [provider, setProvider] = useState<Provider>('codex');
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<DiscoveryReport | null>(null);
  const [name, setName] = useState('');
  const changeRoot = (root: string) => { setRepoRoot(root); setReport(null); };
  const suggested = report ? { ...report.suggested, name: name.trim() } : null;
  async function detect() {
    setBusy(true);
    try {
      const value = await api<DiscoveryReport>('/projects/discover', { repoRoot: repoRoot.trim(), provider });
      setReport(value); setName(value.suggested.name);
    } catch (error) { onError(error); } finally { setBusy(false); }
  }
  return <div className="editor-form research-form">
    <div className="form-intro"><h1>Incorporar proyecto</h1><p>Elige el repositorio y Salem preparará su perfil de trabajo.</p></div>
    <form onSubmit={event => { event.preventDefault(); void detect(); }}>
      <Group title="Repositorio local" open><fieldset className="research-inputs" disabled={busy}>
        <div className="with-button"><Text label="Carpeta del repositorio" value={repoRoot} onChange={changeRoot} required />
          <button type="button" onClick={() => setPicking(true)}><FolderOpen size={15} />Elegir carpeta</button></div>
        <Select label="Proveedor para este proyecto" value={provider} onChange={value => { setProvider(value as Provider); setReport(null); }}
          options={[{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }]} />
        <p className="muted">Usa el ejecutable de {providerNames[provider]} configurado en Ajustes ({settings.commands[provider][0] || 'sin configurar'}). Después podrás ajustar los agentes y sus roles.</p>
        <button className="primary" disabled={!repoRoot.trim()} type="submit"><BookOpen size={15} />{busy ? 'Investigando…' : 'Investigar repositorio'}</button>
      </fieldset></Group>
    </form>
    {report && suggested && <section className="panel" aria-label="Configuración detectada">
      <div className="panel-title"><h2>Configuración detectada</h2></div>
      <div className="panel-body">
        <Text label="Nombre del proyecto" value={name} onChange={setName} required />
        <h3 className="research-subtitle">Modelos para este proyecto</h3>
        <p className="muted">Revisa la propuesta antes de guardar. Este perfil usa el proveedor que elegiste para todas las etapas; puedes ajustar agentes y asignaciones en el perfil completo.</p>
        {Object.entries(suggested.config.agents).map(([id, agent]) => <section key={id} className="nested-section"><h3>Agente {id}</h3><div className="form-grid"><ModelFields label={id} agent={agent} onChange={value => setReport({ ...report, suggested: { ...report.suggested, config: { ...report.suggested.config, agents: { ...report.suggested.config.agents, [id]: value } } } })} /></div></section>)}
        <dl className="facts"><dt>Repositorio</dt><dd>{report.repoRoot}</dd><dt>Revisión</dt><dd><code>{report.sourceSha}</code></dd>
          <dt>Tecnologías</dt><dd>{report.stack.join(', ') || 'Sin identificar'}</dd><dt>Contexto inicial</dt><dd>{report.contextFiles.join(', ')}</dd>
          <dt>Archivos inventariados</dt><dd>{report.files.length}{report.truncated ? ' (inventario parcial)' : ''}</dd></dl>
        <h3 className="research-subtitle">Checks detectados</h3>
        {suggested.config.checks.length ? <ul className="research-items">{suggested.config.checks.map(check => <li key={check.id}><strong>{check.id}</strong><code>{commandText(check.command)}</code></li>)}</ul>
          : <p className="muted">No se detectaron checks. La investigación del objetivo podrá proponerlos.</p>}
        {report.warnings.length > 0 && <div className="notice research-notice"><ul>{report.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div>}
        <p className="muted">La detección no instala dependencias ni ejecuta estos comandos. El perfil se puede editar antes de usarlo.</p>
        <div className="actions"><button className="primary" disabled={busy || !name.trim()} onClick={async () => { setBusy(true); try { await onSave(suggested); } catch (error) { onError(error); } finally { setBusy(false); } }}><Plus size={15} />Agregar proyecto detectado</button>
          <button disabled={busy} onClick={() => onAdvanced(suggested)}>Ajustar perfil antes de guardar</button></div>
      </div>
    </section>}
    <div className="actions"><button disabled={busy} onClick={onCancel}>Cancelar</button></div>
    {picking && <FolderPicker value={repoRoot} onChoose={root => { changeRoot(root); setPicking(false); }} onClose={() => setPicking(false)} />}
  </div>;
}

function defaultAgent(project?: ProjectRecord) {
  return project?.config.supervisor?.roles.define || Object.keys(project?.config.agents || {})[0] || '';
}

export function ObjectivesPage({ state, onChanged, onError, onDirty, onTaskCreated, onAddProject }: {
  state: LocalState; onChanged: () => Promise<void>; onError: (error: unknown) => void;
  onDirty: (dirty: boolean) => void; onTaskCreated: (task: Pick<TaskRecord, 'id' | 'projectId'>) => void; onAddProject: () => void;
}) {
  const projects = state.projects.filter(project => !project.archived);
  const goals = (state as LocalState & { goals?: GoalRecord[] }).goals ?? [];
  const [projectId, setProjectId] = useState(() => projects[0]?.id || '');
  const project = projects.find(item => item.id === projectId);
  const [agentId, setAgentId] = useState(() => defaultAgent(projects[0]));
  const [objective, setObjective] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const request = useRef({ signature: '', key: '' });
  const selected = goals.find(goal => goal.id === selectedId);
  const dirty = Boolean(objective.trim() || answer.trim());
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  useEffect(() => () => onDirty(false), [onDirty]);
  useEffect(() => {
    if (!projectId && projects[0]) { setProjectId(projects[0].id); setAgentId(defaultAgent(projects[0])); }
  }, [projectId, projects[0]?.id]);

  async function act(action: () => Promise<void>) {
    setBusy(true); try { await action(); } catch (error) { onError(error); } finally { setBusy(false); }
  }
  async function start() {
    const input = { projectId, objective: objective.trim(), agentId };
    const signature = JSON.stringify(input);
    if (request.current.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    await act(async () => {
      const goal = await api<GoalRecord>('/goals', { ...input, requestKey: request.current.key });
      await onChanged(); setSelectedId(goal.id); setObjective(''); setAnswer(''); request.current = { signature: '', key: '' };
    });
  }
  function open(id: string) {
    if (answer.trim() && !window.confirm('Hay una respuesta sin enviar. ¿Descartarla y abrir otro objetivo?')) return;
    setSelectedId(id); setAnswer('');
  }
  return <>
    <header className="page-header"><div><h1>Objetivos</h1><p>Describe el resultado. Salem investiga el proyecto y propone cómo llegar.</p></div>
      <div className="actions"><button disabled={busy} onClick={() => void act(onChanged)}><RefreshCw size={15} />Actualizar</button></div></header>
    {selected ? <>
      <div className="actions research-back"><button className="quiet small" disabled={busy} onClick={() => {
        if (answer.trim() && !window.confirm('Hay una respuesta sin enviar. ¿Descartarla y volver?')) return;
        setSelectedId(null); setAnswer('');
      }}><ArrowLeft size={15} />Todos los objetivos</button></div>
      <GoalDetail key={selected.id} goal={selected} answer={answer} onAnswerChange={setAnswer} busy={busy} onError={onError}
        onAction={(command, body) => act(async () => { await api(`/goals/${selected.id}/${command}`, body); await onChanged(); if (command === 'answer') setAnswer(''); })}
        onMaterialize={() => void act(async () => {
          const result = await api<{ goal: GoalRecord; task: TaskRecord }>(`/goals/${selected.id}/materialize`, { revision: selected.revision });
          await onChanged(); setAnswer(''); onTaskCreated(result.task);
        })} onOpenTask={() => onTaskCreated({ id: selected.createdTaskId!, projectId: selected.projectId })} />
    </> : <>
      <section className="panel research-composer"><div className="panel-title"><h2>Un nuevo objetivo</h2></div><div className="panel-body">
        {projects.length ? <form onSubmit={event => { event.preventDefault(); void start(); }}>
          <fieldset className="research-inputs" disabled={busy}>
            <div className="form-grid"><Select label="Proyecto del objetivo" value={projectId} options={projects.map(item => ({ value: item.id, label: item.name }))}
              onChange={id => { setProjectId(id); setAgentId(defaultAgent(projects.find(item => item.id === id))); }} />
              <Select label="Agente investigador" value={agentId} options={Object.entries(project?.config.agents || {}).map(([id, agent]) => ({ value: id, label: `${id} (${providerNames[agent.provider]})` }))} onChange={setAgentId} /></div>
            <Area label="Qué quieres lograr" value={objective} onChange={setObjective} required hint="Por ejemplo: corrige el cálculo de la suma sin cambiar su API. Agrega las reglas de negocio que ya conozcas." />
            <div className="actions"><button className="primary" disabled={!project || !agentId || !objective.trim()} type="submit"><BookOpen size={15} />{busy ? 'Iniciando…' : 'Investigar objetivo'}</button></div>
          </fieldset>
          <p className="muted research-caption">Investiga en una copia aislada con herramientas de lectura. El plan no ejecuta cambios ni acredita su aceptación.</p>
        </form> : <div className="research-empty"><p>Incorpora un repositorio para que Salem pueda investigar su código.</p><button className="primary" onClick={onAddProject}>Incorporar proyecto</button></div>}
      </div></section>
      <section className="panel research-history"><div className="panel-title"><h2>Investigaciones</h2><span className="muted">{goals.length}</span></div>
        {goals.length ? <ul className="list">{[...goals].sort((a, b) => b.createdAt - a.createdAt).map(goal => <li className="list-row" key={goal.id}>
          <div className="row-main"><h2>{goal.objective}</h2><p>{goal.project.name}</p><div className="row-meta"><time>{stamp(goal.createdAt)}</time><span>{providerNames[goal.project.config.agents[goal.agentId]!.provider]}</span><span>{goal.attempts.length} intentos</span></div></div>
          <div className="actions"><GoalStatus goal={goal} /><button className="small" onClick={() => open(goal.id)}>Ver plan</button></div>
        </li>)}</ul> : <div className="research-empty"><p className="muted">Tus objetivos, planes y preguntas pendientes aparecerán aquí.</p></div>}
      </section>
    </>}
  </>;
}

function GoalStatus({ goal }: { goal: GoalRecord }) { return <span className={`status ${goal.status}`}>{goalNames[goal.status]}</span>; }
function TextList({ title, items }: { title: string; items: string[] }) {
  return items.length ? <section className="research-section"><h3>{title}</h3><ul>{items.map((item, index) => <li key={index}>{item}</li>)}</ul></section> : null;
}
function Files({ files }: { files: string[] }) { return files.length ? <p className="research-files">{files.map((file, index) => <code key={index}>{file}</code>)}</p> : null; }

function PlanView({ plan }: { plan: GoalPlan }) {
  return <>
    <section className="panel research-plan"><div className="panel-title"><h2>Plan de trabajo</h2></div><div className="panel-body">
      <p>{plan.summary}</p>
      {plan.facts.length > 0 && <section className="research-section"><h3>Lo que encontró Salem</h3><ul className="research-items">{plan.facts.map((fact, index) => <li key={index}><p>{fact.description}</p><Files files={fact.files} /></li>)}</ul></section>}
      <TextList title="Supuestos" items={plan.assumptions} /><TextList title="Decisiones técnicas" items={plan.decisions} />
      {plan.steps.length > 0 && <section className="research-section"><h3>Pasos</h3><ol className="research-steps">{plan.steps.map((step, index) => <li key={index}><h3>{step.title}</h3><p>{step.description}</p><Files files={step.files} /></li>)}</ol></section>}
      <TextList title="Objetivo de la tarea" items={plan.task.objective ? [plan.task.objective] : []} />
      <TextList title="Alcance de la tarea" items={plan.task.scope} /><TextList title="Criterios de aceptación" items={plan.task.acceptance} />
      <TextList title="Referencias" items={plan.task.references} /><TextList title="Checks del plan" items={plan.task.checkIds} />
      {plan.proposedChecks.length > 0 && <section className="research-section"><h3>Checks propuestos</h3><p className="muted">Se incorporarán al perfil al crear la tarea. Revisa los comandos; se ejecutarán cuando inicies la tarea.</p>
        <ul className="research-items">{plan.proposedChecks.map(check => <li key={check.id}><strong>{check.id}</strong><code>{commandText(check.command)}</code><Files files={check.toolFiles} /></li>)}</ul></section>}
    </div></section>
  </>;
}

function GoalDetail({ goal, answer, onAnswerChange, busy, onError, onAction, onMaterialize, onOpenTask }: {
  goal: GoalRecord; answer: string; onAnswerChange: (value: string) => void; busy: boolean; onError: (error: unknown) => void;
  onAction: (command: string, body: unknown) => Promise<void>; onMaterialize: () => void; onOpenTask: () => void;
}) {
  const [log, setLog] = useState<{ path: string; text: string; nextOffset: number; truncated: boolean } | null>(null);
  const [reading, setReading] = useState(false);
  async function readLog(path: string, append = false) {
    setReading(true); try {
      const chunk = await api<{ text: string; nextOffset: number; truncated: boolean }>(`/goals/${goal.id}/artifact?path=${encodeURIComponent(path)}&offset=${append ? log?.nextOffset || 0 : 0}`);
      setLog({ path, text: (append ? log?.text || '' : '') + chunk.text, nextOffset: chunk.nextOffset, truncated: chunk.truncated });
    } catch (error) { onError(error); } finally { setReading(false); }
  }
  const active = ['queued', 'investigating'].includes(goal.status);
  return <div className="research-detail">
    <section className="panel"><div className="panel-title"><h2>{goal.objective}</h2><GoalStatus goal={goal} /></div><div className="panel-body">
      <dl className="facts"><dt>Proyecto</dt><dd>{goal.project.name}</dd><dt>Investigador</dt><dd>{goal.agentId} ({providerNames[goal.project.config.agents[goal.agentId]!.provider]})</dd>
        <dt>Revisión investigada</dt><dd>{goal.sourceSha ? <code>{goal.sourceSha}</code> : 'Pendiente de preparar'}</dd><dt>Creado</dt><dd>{stamp(goal.createdAt)}</dd></dl>
      {goal.reason && <p className={`research-notice ${goal.status === 'failed' ? 'error' : 'notice'}`}>{goal.reason}</p>}
      {active && <p className="muted research-caption">{goal.status === 'queued' ? 'Esperando un lugar disponible y una cuenta lista.' : 'Leyendo el repositorio y preparando el plan. Puedes salir de esta pantalla; el avance se guarda.'}</p>}
      <div className="actions research-caption">
        {active && <button disabled={busy} onClick={() => void onAction('cancel', {})}><Square size={14} />Cancelar investigación</button>}
        {['failed', 'cancelled', 'interrupted', 'blocked'].includes(goal.status) && <button disabled={busy} onClick={() => void onAction('retry', { revision: goal.revision })}><RefreshCw size={14} />Reintentar investigación</button>}
        {goal.status === 'materialized' && goal.createdTaskId && <button className="primary" onClick={onOpenTask}>Ir a la tarea creada</button>}
      </div>
    </div></section>
    {goal.plan && <>
      {goal.plan.questions.length > 0 && <section className="panel"><div className="panel-title"><h2>Preguntas para continuar</h2></div><div className="panel-body">
        <ul>{goal.plan.questions.map((question, index) => <li key={index}>{question}</li>)}</ul>
        {goal.status === 'needs_input' && <form onSubmit={event => { event.preventDefault(); void onAction('answer', { revision: goal.revision, text: answer.trim() }); }}>
          <Area label="Tu respuesta" value={answer} onChange={onAnswerChange} required hint="Aclara las reglas de negocio o decisiones que el código no permite confirmar." />
          <button className="primary" disabled={busy || !answer.trim()}>Continuar investigación</button></form>}
      </div></section>}
      <PlanView plan={goal.plan} />
      {goal.status === 'ready' && goal.plan.verdict === 'ready' && <section className="panel"><div className="panel-body"><h2>El plan está listo para crear una tarea</h2><p className="muted">Los pasos se incorporarán en una tarea para el supervisor. Tú decides cuándo ejecutarla. Los checks aún no se han ejecutado.</p>
        <button className="primary" disabled={busy} onClick={onMaterialize}><Plus size={15} />Crear tarea del plan</button></div></section>}
    </>}
    {goal.answers.length > 0 && <Group title="Respuestas anteriores"><ol className="research-answers">{goal.answers.map((item, index) => <li key={index}><time className="muted">{stamp(item.at)}</time>{item.questions?.map((question,i)=><p key={i}><strong>{question}</strong></p>)}<p>{item.text}</p></li>)}</ol></Group>}
    <Group title={`Intentos y evidencia (${goal.attempts.length})`} open>
      {goal.attempts.length ? goal.attempts.map((attempt, index) => <section className="research-attempt" key={attempt.id}>
        <h3>Intento {index + 1}</h3><p className="muted">{stamp(attempt.startedAt)} · {({ running: 'En curso', succeeded: 'Completado', failed: 'Fallido', cancelled: 'Cancelado', timed_out: 'Tiempo agotado', interrupted: 'Interrumpido' })[attempt.status]}</p>
        {attempt.error && <p className="error">{attempt.error}</p>}
        <dl className="facts"><dt>Duración</dt><dd>{attempt.durationMs == null ? 'En curso o no confirmada' : `${(attempt.durationMs / 1000).toFixed(1)} s`}</dd><dt>Tokens de entrada</dt><dd>{number(attempt.usage?.inputTokens)}</dd><dt>Tokens de salida</dt><dd>{number(attempt.usage?.outputTokens)}</dd><dt>Costo reportado</dt><dd>{attempt.usage?.costUsd == null ? 'No reportado' : `$${attempt.usage.costUsd.toFixed(4)} USD (${attempt.usage.costKind})`}</dd></dl>
        <div className="actions research-caption">{['stdout.log', 'stderr.log', 'result.json'].map(file => <button className="small" key={file} aria-label={`Ver ${file}${goal.attempts.length > 1 ? ` del intento ${index + 1}` : ''}`} disabled={reading} onClick={() => void readLog(`${attempt.id}/${file}`)}>Ver {file}</button>)}</div>
      </section>) : <p className="muted">La investigación todavía no ha iniciado un intento.</p>}
      {log && <div className="artifact-log research-log"><h3>{log.path}</h3><pre>{log.text || 'El archivo aún no tiene contenido.'}</pre>{log.truncated && <button disabled={reading} onClick={() => void readLog(log.path, true)}>Cargar más</button>}</div>}
    </Group>
  </div>;
}
