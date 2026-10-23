# Modelos y colaboración

Salem coordina etapas mediante un supervisor persistente. Los agentes investigan, definen, implementan y revisan; el controlador ejecuta los checks y aplica las reglas de aceptación y los permisos del perfil. Cambiar de modelo no cambia esa autoridad.

## Perfil inicial

| Etapa | Propuesta | Esfuerzo |
| --- | --- | --- |
| Definición | Claude Opus 5.5 | Medio (`medium`) |
| Implementación | Codex: predeterminado del CLI | Predeterminado del CLI |
| Revisión independiente | Claude Opus 5.5, en otra sesión | Medio (`medium`) |

Este reparto es la propuesta de Salem para perfiles manuales nuevos. Puedes modificarlo. La incorporación automática conserva el proveedor que elijas y permite ajustar su modelo antes de guardar; usar ambos proveedores requiere que configures sus roles y tengas ambas cuentas disponibles.

Desde 0.5.1, los agentes nuevos de Codex no fuerzan un identificador de modelo. Con la configuración personal ignorada, el CLI instalado resuelve su modelo predeterminado. Las sugerencias de Sol, Luna y Astra siguen disponibles para seleccionarlas expresamente; no acreditan acceso desde tu cuenta. Los perfiles existentes no se migran automáticamente.

En **Proyectos → Agentes y etapas** puedes escoger una opción sugerida, **Predeterminado del CLI** o **Personalizado**. El identificador exacto y el esfuerzo siguen siendo editables. Los perfiles importados y existentes conservan sus elecciones; cambiar de proveedor propone un modelo de ese proveedor y limpia los parámetros incompatibles del anterior. Los ajustes se guardan por proyecto y no reescriben la configuración global de tus CLIs.

## Recomendaciones oficiales consultadas

Consulta de Codex: **23 de octubre de 2026**. Referencias de Claude consultadas previamente el 22 de octubre.

- [OpenAI: modelos de Work y Codex](https://learn.chatgpt.com/docs/models) propone GPT-6.1 Sol para programación y agentes cuando está disponible, Luna para tareas concretas y Astra para trabajo más exigente. Recomienda comenzar con el esfuerzo predeterminado del cliente para Sol.
- [Anthropic: configuración de modelos](https://code.claude.com/docs/en/model-config) documenta Opus5.5 y su esfuerzo predeterminado medio, Sonnet para programación diaria y Haiku para tareas eficientes. El perfil Opus como planificador/revisor responde también a la preferencia de diseño de Salem.
- [Anthropic: cómo elegir modelo y esfuerzo](https://claude.com/resources/articles/claude-model-and-effort-level-in-claude-code) recomienda partir del esfuerzo predeterminado y ajustar a partir del contexto y los resultados.

La lista es una propuesta fechada, no una consulta en vivo a tu suscripción. Autenticación correcta no acredita acceso a todos los modelos. Los alias de Claude pueden avanzar a otra versión o estar redefinidos por tu organización; usa un identificador fijo si necesitas conservar una versión.

## Rechazos y límites

Si el proveedor rechaza el modelo, Salem conserva el error y no lo sustituye silenciosamente. Revisa el acceso y las restricciones de tu cuenta, escoge otro modelo o selecciona explícitamente el predeterminado del CLI. Un resultado cuyo modelo efectivo no haya sido informado se muestra como no reportado.

Para `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account`, abre **Proyectos → editar proyecto → Agentes y asignación de etapas** y cambia cada agente Codex afectado a **Predeterminado del CLI**. Mantén **ignorar configuración personal de Codex** activado si tu configuración global también fuerza ese modelo. Guarda el perfil e inicia una conversación nueva con el mismo objetivo: el chat anterior conserva una copia del perfil para mantener su trazabilidad. No basta con reintentar el chat antiguo. Las advertencias de metadatos y de snapshot de PowerShell no acreditan por sí solas este rechazo; la respuesta 400 del proveedor sí identifica el bloqueo.

La elección por etapa se configura en el perfil. No hay selección automática de un modelo según la dificultad de cada tarea ni un benchmark que pruebe que un reparto es universalmente mejor. Las métricas permiten evaluar un reparto con tus tareas y criterios reales.
