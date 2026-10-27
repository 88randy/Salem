# Métricas y comparación — tarea 6

`summarizeRun` resume un checkpoint; `compareRuns` compara cohortes del mismo
proveedor. El reporte no ejecuta agentes, checks, Git ni acciones remotas.

```powershell
npm run build
node dist/src/cli.js report --state-dir C:/ruta/runs --run UUID
node dist/src/cli.js report --benchmark C:/ruta/manifest.json
node scripts/benchmark.mjs --provider fixture --case bug
node scripts/benchmark.mjs --provider claude
node scripts/benchmark.mjs --provider codex
```

Los últimos dos consumen cuota real. Cada uno fija seis corridas antes de la
primera inferencia: bug, funcionalidad y refactor, en modo directo y framework.
El protocolo versionado está en [evals/protocol.json](../evals/protocol.json).
Los límites son iguales por modo: 180 s/etapa, 600 s/corrida, seis intentos de
agente en total y 500000 tokens reportados. No se reintenta una corrida fallida.
El límite de tokens es un guard entre etapas: puede haber sobrepaso dentro de
una etapa y no es un tope de factura. Consumo desconocido bloquea más etapas.

## Qué se mide

- Éxito aceptado requiere completed, aceptación comprobada y recibo de entrega
  exitoso con el mismo fingerprint. Se conserva por separado aceptación de código.
- Pared: updatedAt menos createdAt. En benchmark se mide también el wrapper
  completo de ejecución y el setup por clon; total suma ambos. La preparación
  común de seeds/protocolo se informa aparte y amortizada entre las corridas
  planeadas. Incluye revisión, correcciones y checks, no solo el build.
- Activo: unión de invocaciones del controlador confirmadas; una pausa de resume
  no cuenta. Una invocación sin cierre deja activo=null, con subtotal confirmado.
  wallComplete indica si la observación tiene cierre; sin él, pared es solo lo
  observado hasta el checkpoint y total=null. Se informan aparte agentes y checks.
  Checkpoints antiguos no tienen
  esta telemetría; no se reconstruye precisión que nunca se capturó.
- Intentos define/build/review, checks fallidos, hallazgos bloqueantes y
  regresiones (un check que pasó y falla sobre otra versión). Los intentos
  invalidados y fallidos siguen consumiendo y permanecen en el reporte.
- Eventos de intervención con actor operator/automation y necesidad explícita
  o desconocida. Un resume de CLI registra solicitud de operador; la API permite
  marcar automatización. Cero intervenciones observadas en un demo automatizado
  no cuantifica el trabajo de un desarrollador humano ni de creación del framework.
- Fallos de código/checks, infraestructura/preflight, protocolo, política,
  cancelaciones y desconocidos se conservan separados. Un exit no cero del agente
  sin causa comprobada permanece desconocido, no se atribuye a transporte.

## Uso y costo

Cada total tiene value (solo cuando está completo), knownTotal (subtotal
conocido), reported y expected. null significa no disponible; no significa cero.
Un costo estimado sigue siendo estimado al agregarse. No se inventan precios.

El adapter conserva consumo incluso si la ejecución o el JSON de aceptación
fallan. Codex agrega turn.completed de la invocación; el costo normalmente no
viene informado. Claude usa modelUsage para tokens de todos los modelos y
acumulados de sesión, o declara el fallback de usage del loop principal. Se
normaliza entrada total incluyendo caché; caché leída/creada también se informa
separada. Sesiones acumuladas usan diferencias y no vuelven a sumar su historia.
Un reset/decrecimiento, salida parcial o sesión acumulada sin ID deja el total
incompleto. Los logs originales permanecen como evidencia.

Semántica contrastada con documentación oficial: [Codex JSONL](https://learn.chatgpt.com/docs/non-interactive-mode)
expone eventos de turno y uso; [Claude cost tracking](https://code.claude.com/docs/en/agent-sdk/cost-tracking)
describe acumulación por sesión, alcance de usage/modelUsage y estimaciones
locales de costo. No se consultó facturación ni se atribuye gasto real a esas
estimaciones.

## Protocolo y límites de inferencia

Los criterios se fijan en evals/tasks y los asserts externos en evals/acceptance.
El refactor exige comportamiento preservado y un solo recorrido observado por
lecturas de índices; no se acepta por texto del agente. Cada clon arranca en el
mismo SHA que su par y demuestra antes que el objetivo falla y las regresiones
existentes pasan. Los seeds tienen commits deterministas y materialización LF.

El modo directo automatiza la secuencia explícita de definición, implementación,
checks, review y commit con los mismos adapters y aceptación. Conserva un ledger
durable de medición por etapa/check, pero no tiene resume ni continuaciones del
supervisor. Un cierre abrupto conserva consumo confirmado y marca duración
incompleta. Es una baseline reproducible del flujo
explícito; no es una observación de un humano trabajando con sus herramientas.
Ambos modos entregan solo un commit local; tarea 5 conserva la aceptación de PR,
merge y despliegue. No se accede a repositorios externos ni a GitHub en este benchmark.

Se fijan hashes de protocolo, inputs, ejecutables, versión/configuración del
agente, instrucciones, aceptación y límites. Se rechazan clones reutilizados,
SHA/criterios/herramientas distintos y mezcla de proveedores. Modelo efectivo
ausente deja comparación parcial aunque se use el mismo default/perfil. No se
cambia la configuración global para ocultar ese límite.

Fallos, bloqueos y cancelaciones cuentan en el denominador, también si falló la
preparación antes de crear un run. Corridas planeadas sin iniciar se muestran
separadas y permanecen en el denominador; un protocolo incompleto no se presenta
como verified. El harness congela una copia de la observación y su duración en
un almacén separado, con revisión/checksum de origen; nunca reescribe el estado
operacional tras liberar el lock. El orden alterna por tarea/proveedor,
pero no elimina cachés, latencia del servicio ni carga del equipo. Una repetición
por celda es exploratoria: no permite significancia, prometer ahorro ni declarar
un proveedor universalmente superior. Desarrollo del framework, setup humano,
otros proyectos, producción, instalación limpia y CI quedan sin medición aquí.
