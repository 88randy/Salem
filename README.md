# Salem

Un espacio local para trabajar con Claude y Codex sobre tus proyectos de software.

Describe un objetivo, deja que Salem investigue el repositorio y revisa el plan. Después, el supervisor coordina implementación, pruebas y revisión con las cuentas que ya utilizas. Tú eliges los modelos, los límites y las acciones que puede realizar.

**Versión inicial para Windows.** Consulta las [notas de la versión](docs/RELEASE-0.3.0.md) para conocer la validación y las limitaciones comprobadas. Código abierto bajo [MIT](LICENSE).

## Empezar

### Windows: aplicación instalada

Descarga el instalador de [Releases](https://github.com/88randy/Salem/releases). La distribución incluye Node.js y abre Salem en tu navegador. Git y los CLIs oficiales de [Claude Code](https://code.claude.com/docs/en/setup) y [Codex](https://developers.openai.com/codex/cli) se instalan por separado.

La [guía de Windows](docs/WINDOWS.md) explica instalación, arranque, actualización y desinstalación. Los datos se conservan fuera de la carpeta de la aplicación. El instalador inicial no tiene firma digital; las descargas incluyen hashes para comprobar su integridad.

### Desde el código fuente

Requiere Node.js22, npm y Git:

```sh
git clone https://github.com/88randy/Salem.git
cd Salem
npm ci
npm run salem
```

Abre la dirección que imprime la terminal, normalmente `http://127.0.0.1:3210`. En **Cuentas**, comprueba o conecta las sesiones oficiales de los proveedores que vayas a usar. Cada persona utiliza su propia computadora y sus propias cuentas. No necesitas una API key cuando el CLI utiliza tu sesión existente. El uso de modelos consume la cuota o los créditos de esa cuenta.

## Qué puedes hacer

- **Incorporar proyectos:** detecta instrucciones, tecnologías y checks en una revisión Git local, sin ejecutar scripts durante la detección.
- **Plantear objetivos:** investiga el código, identifica supuestos y preguntas, y prepara un plan con evidencia y criterios de aceptación.
- **Coordinar Claude y Codex:** asigna agentes a definición, implementación y revisión. El perfil inicial propone Opus5.5 con esfuerzo medio para definir/revisar y GPT-6.1 Sol para implementar; puedes cambiar modelos y roles.
- **Ejecutar y comprobar:** trabaja en una copia aislada, ejecuta los checks del proyecto y exige revisión en otra sesión antes de aceptar código.
- **Seguir y recuperar:** conserva estado, etapas, diffs, logs y recibos. Permite cancelar, reanudar desde checkpoints verificables o iniciar otra ejecución conservando la anterior.
- **Entregar con permisos explícitos:** configura commits, PR, integración o despliegue cuando quieras delegar esas acciones. Registrar un proyecto no las habilita.
- **Probar mejoras:** reproduce un fallo con la aceptación existente, evalúa una candidata y puede aplicarla con respaldo. Repite los checks y ofrece reversión y recuperación ante una interrupción.
- **Medir:** muestra tiempos, iteraciones y uso reportado por los proveedores. Los datos desconocidos permanecen desconocidos; no se presentan como ahorro demostrado.

## Cómo colaboran las IA

Salem es el controlador del flujo. Las IA investigan, proponen, implementan y revisan; el controlador conserva el estado y comprueba las reglas. Puedes usar ambos proveedores o configurar uno solo. No hace falta que compartan credenciales ni que editen simultáneamente los mismos archivos.

Los modelos y esfuerzos se configuran por agente en **Proyectos → Agentes y etapas**. Hay opciones sugeridas, el predeterminado del CLI y un valor personalizado. La disponibilidad depende de tu cuenta, cliente y organización. Salem no cambia silenciosamente el modelo si el proveedor lo rechaza. Los perfiles existentes conservan sus elecciones.

## Tus datos y tu control

El servidor escucha únicamente en `127.0.0.1`. Las sesiones permanecen en el almacenamiento oficial de cada CLI. Salem conserva proyectos, configuraciones y evidencias en tu equipo; las consultas a modelos sí requieren conexión y envían contexto al proveedor correspondiente.

Los permisos de editar, crear commits, publicar, integrar y desplegar se delegan por separado. La autoevolución no puede cambiar las reglas de aceptación, verificadores, instrucciones o permisos. Aplicar una mejora modifica código fuente; no sustituye automáticamente el programa instalado.

Los agentes y checks se ejecutan con tu usuario del sistema. Una copia Git y los límites de herramientas no constituyen una sandbox frente a código malicioso. Revisa los proyectos y comandos que decidas ejecutar. Lee [seguridad](SECURITY.md) antes de exponer datos o reportar un problema.

## Documentación

- [Guía completa de Salem](docs/SALEM.md)
- [Windows: instalar y operar](docs/WINDOWS.md)
- [Modelos y colaboración](docs/MODELS.md)
- [Supervisor y recuperación](docs/SUPERVISOR.md)
- [Checks y aceptación](docs/CHECKS.md)
- [Entrega y capacidades](docs/DELIVERY.md)
- [Métricas y sus límites](docs/METRICS.md)
- [Contribuir](CONTRIBUTING.md)

## Desarrollo

```sh
npm ci
npm run typecheck
npm test
npx playwright install chromium
npm run test:ui
npm run test:distribution
```

Las pruebas automatizadas utilizan subprocess de fixtures y no consumen cuota de IA. Las pruebas con cuentas reales se ejecutan por separado y se identifican como tales. Para usar Chrome instalado en vez del Chromium de Playwright, define `PLAYWRIGHT_CHANNEL=chrome`.

El workflow de GitHub comprueba Windows. La existencia del workflow no sustituye sus resultados: revisa Actions y las notas de cada versión. No se acredita compatibilidad con macOS/Linux o un despliegue de producción por haber pasado el demo.

## Comunidad y licencia

Las propuestas y reproducciones pequeñas son bienvenidas en Issues. Consulta [CONTRIBUTING.md](CONTRIBUTING.md) antes de abrir un PR. El código propio se distribuye bajo MIT; las dependencias conservan sus [avisos de terceros](THIRD_PARTY_NOTICES.md). Salem es un proyecto independiente y no está afiliado a Anthropic ni OpenAI.
