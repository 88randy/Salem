import { test, expect, type Page } from '@playwright/test';

const settings = { revision: 1, commands: { claude: ['claude'], codex: ['codex'] }, maxConcurrentRuns: 1, refreshIntervalMs: 1000, preferredPort: 3210 };

async function profileFixture(page: Page) {
  let projects: any[] = [];
  const submissions: any[] = [];
  const state = () => ({ schemaVersion: 1, revision: 1, settings, projects, tasks: [], executions: [] });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/bootstrap') return route.fulfill({ json: { csrfToken: 'csrf', state: state(), accounts: [], dataDir: 'C:/Salem' } });
    if (path === '/api/state') return route.fulfill({ json: { state: state(), accounts: [], dataDir: 'C:/Salem' } });
    if (path === '/api/projects' && route.request().method() === 'POST') {
      const input = route.request().postDataJSON();
      submissions.push(input);
      const project = { ...input, id: 'project', revision: submissions.length, archived: false, createdAt: 1, updatedAt: submissions.length };
      projects = [project];
      return route.fulfill({ json: project });
    }
    return route.fulfill({ status: 404, json: { error: 'Ruta inesperada' } });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agregar proyecto', exact: true }).click();
  await page.getByLabel('Nombre del proyecto', { exact: true }).fill('Regresión');
  await page.getByLabel('Identificador de configuración', { exact: true }).fill('regresion');
  await page.getByLabel('Carpeta del repositorio', { exact: true }).fill('C:/repos/demo');
  return submissions;
}

test('provider changes propose compatible defaults and preserve subsequent manual overrides', async ({ page }) => {
  const submissions = await profileFixture(page);
  await page.getByLabel('builder: comando: argumento 1', { exact: true }).fill('C:/tools/custom-agent.cmd');
  await page.getByLabel('builder: modelo (opcional)', { exact: true }).fill('modelo-elegido');
  await page.getByLabel('builder: esfuerzo (opcional)', { exact: true }).fill('high');
  await page.getByLabel('builder: proveedor', { exact: true }).selectOption('claude');
  await expect(page.getByLabel('builder: ignorar configuración personal de Codex', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('builder: modelo (opcional)', { exact: true })).toHaveValue('claude-opus-5-5');
  await expect(page.getByLabel('builder: esfuerzo (opcional)', { exact: true })).toHaveValue('medium');
  await page.getByLabel('builder: comando: argumento 1', { exact: true }).fill('C:/tools/custom-agent.cmd');
  await page.getByLabel('builder: modelo (opcional)', { exact: true }).fill('modelo-elegido');
  await page.getByLabel('builder: esfuerzo (opcional)', { exact: true }).fill('high');
  await page.getByRole('button', { name: 'Guardar proyecto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Regresión', exact: true })).toBeVisible();
  expect(submissions[0].config.agents.builder).not.toHaveProperty('ignoreUserConfig');
  expect(submissions[0].config.agents.builder).toMatchObject({ provider: 'claude', command: ['C:/tools/custom-agent.cmd'], model: 'modelo-elegido', effort: 'high' });

  await page.getByRole('button', { name: 'Editar Regresión', exact: true }).click();
  await page.getByLabel('builder: proveedor', { exact: true }).selectOption('codex');
  await expect(page.getByLabel('builder: ignorar configuración personal de Codex', { exact: true })).toBeChecked();
  await expect(page.getByLabel('builder: comando: argumento 1', { exact: true })).toHaveValue('codex');
  await expect(page.getByLabel('builder: modelo (opcional)', { exact: true })).toHaveValue('gpt-6.1-sol');
  await expect(page.getByLabel('builder: esfuerzo (opcional)', { exact: true })).toHaveValue('');
  await page.getByLabel('builder: comando: argumento 1', { exact: true }).fill('C:/tools/codex-personal.cmd');
  await page.getByLabel('builder: modelo (opcional)', { exact: true }).fill('modelo-elegido');
  await page.getByLabel('builder: esfuerzo (opcional)', { exact: true }).fill('high');
  await page.getByLabel('builder: ignorar configuración personal de Codex', { exact: true }).check();
  await page.getByRole('button', { name: 'Guardar proyecto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Regresión', exact: true })).toBeVisible();
  expect(submissions[1].config.agents.builder).toMatchObject({ provider: 'codex', ignoreUserConfig: true, command: ['C:/tools/codex-personal.cmd'], model: 'modelo-elegido', effort: 'high' });
});

test('delivery lists preserve Enter while typing and normalize all four arrays only when saving', async ({ page }) => {
  const submissions = await profileFixture(page);
  await page.locator('summary').filter({ hasText: 'Entrega y recuperación' }).click();
  await page.getByLabel('Configurar entrega', { exact: true }).check();
  await page.getByLabel('Configurar GitHub', { exact: true }).check();
  await page.getByLabel('Configurar integración de pull request', { exact: true }).check();
  await page.getByLabel('Configurar despliegue', { exact: true }).check();
  const lists = [
    ['GitHub: archivos de herramientas', 'tools/first.mjs', 'tools/second.mjs'],
    ['Checks requeridos para integrar', 'first-check', 'second-check'],
    ['Despliegue: archivos de herramientas', 'tools/deploy-first.mjs', 'tools/deploy-second.mjs'],
    ['Checks requeridos para desplegar', 'first-deploy-check', 'second-deploy-check'],
  ] as const;
  for (const [label, first, second] of lists) {
    const field = page.getByLabel(label, { exact: true });
    await field.click();
    await field.pressSequentially(first);
    await field.press('Enter');
    await expect(field).toHaveValue(`${first}\n`);
    await field.pressSequentially(second);
    await field.press('Enter');
    await field.pressSequentially('   ');
    await expect(field).toHaveValue(`${first}\n${second}\n   `);
  }
  await page.getByRole('button', { name: 'Guardar proyecto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Regresión', exact: true })).toBeVisible();
  expect(submissions[0].config.delivery.github.toolFiles).toEqual(['tools/first.mjs', 'tools/second.mjs']);
  expect(submissions[0].config.delivery.github.merge.requiredChecks).toEqual(['first-check', 'second-check']);
  expect(submissions[0].config.delivery.deploy.toolFiles).toEqual(['tools/deploy-first.mjs', 'tools/deploy-second.mjs']);
  expect(submissions[0].config.delivery.deploy.requiredChecks).toEqual(['first-deploy-check', 'second-deploy-check']);
});
