# Supervisor durable — tareas 3–5

`run` y `resume` coordinan etapas sobre un checkout Git exclusivo y con HEAD.
La versión del estado es independiente de la versión del perfil. Cada ejecución
tiene un UUID, tarea congelada, presupuestos, historial, intentos y checkpoints.

## Arranque

Además del perfil habitual, declarar agentes por rol y límites totales:

```json
"supervisor": {
  "roles": { "define": "codex", "build": "codex", "review": "claude" },
  "runTimeoutMs": 600000,
  "maxAttempts": 6
}
```

Los IDs deben existir en `agents`; build requiere `capabilities.edit=true`.
El presupuesto temporal incluye los reinicios y el tiempo detenido. Cada intento,
incluso interrumpido, consume presupuesto; no se amplía automáticamente al reanudar.
Los perfiles anteriores siguen funcionando con doctor/stage.

```powershell
npm run build
node dist/src/cli.js run --config perfil.json --task tarea.json --state-dir C:/ruta/estados
node dist/src/cli.js resume --config perfil.json --run UUID --state-dir C:/ruta/estados
```

El estado debe estar fuera del árbol del proyecto o en una carpeta ignorada por
Git. El valor por defecto es `.artifacts/runs` relativo al cwd del CLI. El CLI
emite checkpoints JSON en stderr y el estado final en stdout. Exit 0 significa
completed; un bloqueo/fallo devuelve 1 y cancelación devuelve 130.

## Recuperación y exclusión

- Antes de lanzar una etapa se guarda su intención. El resultado y la siguiente
  etapa se guardan juntos; un resultado confirmado no se vuelve a ejecutar.
- Escritura de JSON en archivo temporal, fsync del archivo y rename. En POSIX
  también fsync del directorio; en Windows no se promete protección ante pérdida
  eléctrica que el sistema operativo no garantice. La prueba cubre muerte del
  proceso y reanudación, no fallos físicos del disco.
- Un checksum e identidad de ejecución detectan estado parcial/corrupto. No se
  reemplaza un estado ilegible por uno nuevo ni se borra evidencia previa.
  Lectura y escritura comparten un límite de 20 MB: un resultado que lo excede
  no reemplaza el último checkpoint recuperable; sus artefactos quedan conservados.
- Un lock en el directorio Git del worktree excluye tareas simultáneas incluso
  con distintos directorios de estado. Un dueño vivo o ambiguo bloquea. Un PID
  reutilizado se considera vivo y bloquea conservadoramente.
- Cada subprocess de una etapa tiene un guardian independiente y un registro
  persistido antes de arrancar. La pérdida de IPC con el supervisor termina el
  árbol del agente; SIGINT/SIGTERM capturables también solicitan limpieza.
  Recuperar nunca mata un PID antiguo: exige un recibo durable de limpieza emitido
  por el guardian. Sin ese recibo bloquea incluso si el PID ya no existe.
- Un proceso terminado sin checkpoint de resultado no cuenta como éxito. Si dejó
  cambios parciales, se bloquea para inspección; se conservan esos archivos.
- El reinicio contrasta SHA, contenido e índice Git, configuración, instrucciones,
  versiones/binarios de CLI y runtime/plantillas. Una discrepancia invalida evidencia
  y bloquea. No mezcla cambios externos con un intento propio ni hace reset.

Si un lock queda sin `owner.json` o con un `.reclaim` incompleto, inspeccionar
procesos, registros y estados antes de retirarlo manualmente. El supervisor no
supone que un registro desconocido ya está abandonado. El mecanismo usa locks
locales: no coordina máquinas distintas ni garantiza locks en discos de red.
Submódulos y árboles mayores al presupuesto de fingerprint requieren adaptación.

## Etapas y extensiones

Máquina: queued → defining → implementing → validating → reviewing → delivering
→ completed; también blocked, failed y cancelled. Una revisión `needs_changes`
vuelve a implementing dentro del límite de intentos. Los roles usan invocaciones
nuevas; el feedback estructurado se pasa como datos, sin autoridad adicional.

El CLI ejecuta los [checks y aceptación](CHECKS.md) del perfil. Sin checks o sin
cobertura declarada bloquea en validating. Los fallos reales piden corrección;
configuración, infraestructura y pruebas inválidas bloquean sin consumir nuevos
builds. Una review independiente debe aprobar la misma versión antes de avanzar.
Con código aceptado se ejecuta la [entrega](DELIVERY.md) declarada por el perfil.
Sin perfil de entrega se bloquea en delivering. Un verdict del agente nunca
cierra el ciclo por sí solo.

La entrega nativa guarda un journal por acción, preserva HEAD/índice y reanuda
consultando efectos desconocidos. Todos sus subprocess comparten los leases del
run; no se pierde su protección de guardian al entrar a delivering.

La API admite puertos `gates.validate` y `gates.deliver` para integraciones de
código confiable. Deben respetar AbortSignal y devolver un recibo con ID,
fingerprint de `runFingerprint(state)`, verdict y referencias de evidencia. El
supervisor rechaza recibos con otra huella y conserva entregas confirmadas como
hechos históricos, incluso si falla la comprobación posterior. Antes de cada gate
contrasta el checkout con el snapshot revisado. Una intención de entrega se guarda
antes de invocarlo: si falta su recibo, la reanudación bloquea para reconciliación
en vez de repetir el callback. El adapter futuro debe entregar explícitamente la
versión revisada y consultar resultados desconocidos, no confiar solo en una
comprobación previa que puede competir con cambios externos.
Una ejecución completed reanudada devuelve su recibo histórico
sin repetir acciones ni afirmar que un checkout cambiado sigue validado. Estos
puertos son integraciones confiables; los fixtures que los usan no acreditan
aceptación de software ni publicación o recuperación remota. Con checks declarados
se exige además aceptación nativa de checks y revisión antes de entregar.

La regresión de señales a grupos POSIX queda omitida en Windows y requiere
ejecución Linux/macOS. En Windows sí se prueban muerte del supervisor y muerte
del guardian sin recibo; esta última impide adquirir de nuevo el worktree.

## Probar y recuperar una ejecución

Desde Inicio crea un demo local y ejecuta su tarea desde Tareas. Para comprobar recuperación, solicita cancelar y espera el cierre de procesos propios. El detalle conserva checkpoints, logs y opciones de reanudación. Reanudar reconcilia evidencia; Repetir como nueva conserva la ejecución anterior y utiliza el perfil vigente. Una interrupción no acredita éxito ni autoriza repetir una entrega cuyo resultado es incierto.
