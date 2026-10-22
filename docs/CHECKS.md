# Checks y aceptación de código — tarea 4

El supervisor ejecuta los comandos del perfil en validating, obtiene evidencia
persistente y abre una sesión independiente de review antes de aceptar el código.
Un check roto pide otra implementación dentro del presupuesto. Un resultado de
infraestructura, configuración incompleta o evidencia inválida bloquea el ciclo.
La entrega sigue siendo una capacidad distinta de la tarea 5.

## Configuración

Los checks pertenecen al perfil del proyecto y sus comandos son arrays sin shell:

```json
"checks": [
  { "id": "unit", "command": ["node", "--test", "tests/sum.test.mjs"], "required": true },
  { "id": "database", "command": ["python", "verify_database.py"], "required": false,
    "notApplicableReason": "Esta tarea demo no tiene base de datos" }
]
```

La tarea declara qué checks prueban cada criterio, usando su texto exacto:

```json
"acceptance": ["sum(2,3) returns 5", "sum(-2,1) returns -1"],
"acceptanceChecks": {
  "sum(2,3) returns 5": ["unit"],
  "sum(-2,1) returns -1": ["unit"]
}
```

Todos los checks required deben pasar y cada criterio debe tener checks
configurados con evidencia pasada. Un not_applicable exige motivo y solo puede
ser no bloqueante si es opcional y no se necesita para cubrir un criterio.
`mode: "dry_run"` y flags conocidos de descubrimiento (`--dry-run`, `--version`,
`--help`, `--collect-only`, `--listTests`, `--list-tests`) no acreditan verificación.
Un check opcional fallido no cubre criterios; no elimina un required.

El mapeo declara la intención de cobertura; un proyecto debe configurar pruebas
que realmente comprueben su requisito. El framework no deduce la semántica de un
programa arbitrario por su exit code. La revisión debe detectar pruebas debilitadas
o una cobertura incorrecta; la demo usa asserts reales sobre la función resultante.

En Windows se usan ejecutables nativos o el entrypoint de un script con su
intérprete, como node.exe + npm-cli.js. No se interpretan launchers .cmd, comandos
de shell ni instrucciones de los logs. Los límites de salida y tiempo del perfil
y el deadline total de la ejecución también aplican a los checks.

## Evidencia y versión

Cada resultado guarda ID, comando redactado/hash, configuración, herramientas,
HEAD + huella del árbol, fingerprint de ejecución, estado, modo, exit code,
duración, motivo, stdout/stderr y recibo con hashes de integridad. Se verifica el
contenido de los logs al usar el recibo; un JSON emitido por el agente o una
referencia de evidencia en su respuesta no se convierte en CheckEvidence.

HEAD identifica la base Git, y treeHash incluye las modificaciones todavía sin
commit. Así se rechaza evidencia de otros cambios aunque HEAD sea el mismo.
Publicar o generar un commit y vincularlo a esta versión pertenece a tarea 5.

Los ejecutables y entrypoints de comprobación fuera del snapshot se fijan antes
de implementar, incluidos los archivos Git-ignored dentro del proyecto. Se
reconocen invocaciones habituales de Node/Python, también scripts tras `--test`
o `-u` y preloads de Node por ruta. Las opciones de intérprete ambiguas bloquean.
Para módulos, directorios de tests, wrappers nativos, dependencias transitivas o
archivos de política externos, declarar la lista completa de inputs de herramienta:

```json
{ "id": "policy", "command": ["python", "-m", "company_checks"], "required": true,
  "toolFiles": ["C:/tools/company_checks/__main__.py", "C:/tools/policy.json"] }
```

`toolFiles` reemplaza el descubrimiento automático y es responsabilidad de quien
configura el perfil incluir todos los archivos pertinentes. Deben existir y ser
archivos, no directorios. Solo se excluyen del pinning los inputs que realmente
forman parte del snapshot revisado; las salidas/logs no se declaran como inputs.
Una sustitución durante build bloquea aunque el nuevo script imprima éxito. Los
tests dentro del proyecto evolucionan con el árbol revisado y aparecen en el diff;
sus cambios invalidan la evidencia del árbol anterior. Los checks no pueden editar
fuente: se compara el snapshot antes/después y una mutación bloquea el supervisor.
Cada fallo conserva su clase (`code`, `infrastructure`, `policy`); solo si todos
los impedimentos son fallos de ejecución corregibles vuelve a build. Un timeout,
dry-run o required no aplicable no se vuelve corregible por otro check exit 1.

Los recibos se guardan fuera del árbol o en una ruta Git-ignored. Son datos del
controlador, no instrucciones. La integridad detecta corrupción/sustitución de
artefactos; no es una firma contra procesos con los mismos permisos del usuario.

## Revisión y reanudación

Review recibe la tarea, el diff completo dentro del presupuesto, huellas, estados
de checks, rutas de artefactos y extractos de logs. El contexto rotula esos datos
como no autoritativos. Se rechaza una revisión de otra versión, sesión compartida
con la implementación, salida inválida o hallazgos critical/important pendientes,
incluso si el verdict dice success. Los hallazgos bloqueantes vuelven a build.

La aceptación exige checks y review; pasar los checks solo deja review pendiente.
El estado expone `acceptance.accepted` y su fingerprint. El CLI puede quedar
blocked en delivering con código aceptado mientras no exista entrega implementada.

Cada check termina con un checkpoint. Tras un reinicio se reutiliza solo un recibo
pasado de esa misma configuración, herramientas y versión, cuyos archivos sigan
íntegros. Evidencia rota, comandos distintos o cambios de fuente obligan a obtener
evidencia nueva. Los resultados previos se conservan para auditoría. Este cache
presupone que los inputs del check están representados por esa versión; servicios
externos mutables requieren una política de proyecto antes de reutilizar sus resultados.

## Probar el ciclo actual

Desde Inicio usa **Crear demo local** y ejecuta su tarea. El demo conserva un verificador que rechaza la suma defectuosa. El supervisor debe corregir solo el archivo permitido, ejecutar los checks y obtener una revisión independiente. El detalle muestra evidencia, diff y entrega. Las inferencias consumen cuota del proveedor elegido; las pruebas automáticas de fixtures se ejecutan mediante npm test.
