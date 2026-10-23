# Salem: gestión conversacional

Diseño aprobado: objetivo en lenguaje natural, investigación, preguntas de negocio, tareas dependientes, ejecución y revisión desde una conversación. El usuario pidió proceder con criterio; no se requiere otra aprobación del diseño. Implementación en rama `feat/salem-conversational-management` del checkout dedicado de Salem. Codequim queda fuera del trabajo.

## Contrato

- Conversación durable en el catálogo existente; mensajes identificados por clave de solicitud, eventos con fuente real, revisiones del plan y perfil congelado. Una pérdida de respuesta no duplica trabajo.
- Investigación de solo lectura mediante el adaptador existente, con un esquema adicional de tareas y dependencias. Valida IDs, ciclos, checks y agentes contra el perfil. No incorpora checks propuestos automáticamente.
- Coordinador secuencial del grafo: conserva las dependencias y ejecuta una tarea a la vez en una copia independiente por paso. Cada continuación verifica el checkpoint aceptado anterior y sus pruebas antes de copiar el árbol modificado como base. Sin commits implícitos. La aceptación existente, permisos y revisores independientes se conservan.
- La última tarea incorpora la aceptación conjunta del objetivo. Todos los checks requeridos se ejecutan en cada tarea. La entrega conversacional conserva el código local; publicar sigue siendo una acción explícita.
- El chat acepta nuevas instrucciones y referencias textuales; detener cancela procesos propios. Una instrucción durante trabajo pide detener antes de investigar otra revisión. No reconstruye una supuesta transcripción del proveedor. Los avances citan investigación, tarea, ejecución o check.
- Reinicio: conserva mensajes y resultados; un trabajo interrumpido necesita continuación explícita y reconciliación. Los eventos aceptados no se reejecutan. Se conserva la evidencia de fallos.
- UI: mantener el lenguaje visual de Salem (blanco, lavanda discreto, gato, títulos serif); conversación centrada, compositor fijo, panel plegable de pasos y evidencia, estados legibles. Móvil en una columna, teclado y errores junto al compositor.

## Plan de implementación

1. RED: validación del grafo, ciclos, IDs y checks/agents inválidos. GREEN: contratos y esquema de planificación versionado, compatible con objetivos anteriores.
2. RED: continuación de una entrega sin permiso de commit, rechazo de árbol alterado o prueba inválida. GREEN: continuidad verificada del supervisor y propiedad de workspace.
3. RED: mensajes idempotentes, pregunta/respuesta, secuencia de tres tareas, pausa/fallo/reinicio y aceptación conjunta. GREEN: catálogo y coordinador durable, sin duplicación entre ventanas.
4. API autenticada con CSRF y revisiones; pruebas de rutas, operaciones y recuperación.
5. Chat integrado a Inicio/Trabajo, referencias, preguntas, progreso, detener/continuar y acceso a cambios/checks; pruebas de interacción y responsive.
6. Demo aislada con tres tareas y pregunta real; cuentas Claude/Codex si disponibles. Verificar origen y configuración protegidos. Revisión final fresca del diff completo y verificación antes de entrega.

## Riesgos y comprobaciones

1. Respuesta HTTP perdida: misma clave devuelve el mismo mensaje/ejecución.
2. Reinicio durante una tarea: no se repite sin reconciliar el checkpoint nativo.
3. Cambios ajenos en workspace: hash exacto y pruebas aceptadas bloquean continuidad.
4. Plan inventa herramientas/permisos: allowlist del perfil; checks nuevos detienen y explican lo requerido.
5. Instrucción posterior contradice trabajo aceptado: nueva revisión conserva historial; investigar con contexto real y no afirmar que cambió código previo.
6. Límite de cuenta/modelo: presentar fallo verificable; no fallback silencioso.
7. Último paso pasa pero objetivo incompleto: aceptación conjunta obligatoria además de checks por tarea.

## Registro

2026-10-22: inspeccionados contratos, supervisor, investigación y ejecución. Confirmado que `baseExecutionId` exige SHA de commit y no sirve para tareas edit-only. Se implementa continuidad de checkpoint aceptado, sin alterar evaluadores de aceptación. No se usa el directorio de Odessay como checkout de trabajo.
