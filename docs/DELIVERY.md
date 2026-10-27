# Entrega autónoma — tarea 5

El supervisor entrega solo después de checks reales y review independiente.
Cada perfil delega commit, PR, merge y deploy por separado; el agente implementa
código, y el controlador ejecuta las acciones de entrega. No se ejecutan órdenes
de los logs o de la respuesta del modelo.

## Perfil y arranque

Además de supervisor/checks, declarar `delivery` y sus capacidades:

```json
"delivery": {
  "branchPrefix": "feature/agent-",
  "recovery": "query_only",
  "commit": {
    "message": "fix: corregir suma",
    "author": { "name": "Demo", "email": "demo@example.invalid" }
  },
  "github": {
    "command": ["gh"],
    "remote": "origin",
    "remoteUrl": "https://github.com/owner/project.git",
    "repository": "owner/project",
    "baseBranch": "main",
    "draft": false,
    "merge": { "method": "merge", "requiredChecks": ["build"] }
  },
  "deploy": {
    "command": ["node", "C:/tools/deploy.mjs"],
    "statusCommand": ["node", "C:/tools/query-deploy.mjs"],
    "target": "isolated-demo",
    "requiredChecks": ["Full release"]
  }
}
```

`commit` es obligatorio si existe entrega. Omitir github para entrega local;
omitir merge para terminar en PR; omitir deploy para terminar sin despliegue.
Activar únicamente las capacidades delegadas. `toolFiles` puede declarar los
inputs completos del comando GitHub/deploy; se aplican las reglas de pinning de
[CHECKS.md](CHECKS.md). El perfil no almacena tokens: `gh` y Git usan sus sesiones
y helpers existentes. Los destinos no deben incluir credenciales.

```powershell
npm run build
node dist/src/cli.js diagnose --config perfil.json
node dist/src/cli.js run --config perfil.json --task tarea.json --state-dir C:/ruta/estados
node dist/src/cli.js resume --config perfil.json --run UUID --state-dir C:/ruta/estados
```

`diagnose` lee configuración, instrucciones y Git; no invoca agentes, checks ni
acciones. Exit 0 acredita configuración válida, no aceptación del proyecto.

## Commit y versión entregada

El commit se construye con blobs sin filtros y `commit-tree` sobre el HEAD que
se revisó. Autor, mensaje y fecha persistida lo hacen determinista. Un CAS crea
una rama reservada `<branchPrefix><runId>`: nunca reemplaza una rama ajena ni
commitea sobre main. El HEAD y el índice del checkout revisado se conservan.
La rama de entrega contiene el commit; el checkout mantiene sus archivos para
inspección, por lo que puede seguir mostrando cambios sin commit en su rama.

El recibo vincula fingerprint/HEAD/treeHash revisados con árbol Git, commit
preparado y SHA final fusionado. No se atribuyen automáticamente pruebas a otro
SHA: el árbol remoto fusionado debe coincidir con el preparado antes de deploy.
`ActionReceipt.sha` identifica la entrada de la acción; `evidence.sha`, cuando
corresponde, identifica el commit creado. El recibo agregado informa el SHA final.

Una preparación que introduce rutas fuera del diff/untracked revisado bloquea.
Esto incluye normalización incidental de archivos limpios por CRLF/filtros:
preparar el checkout aislado con la política del proyecto antes de empezar;
la entrega no reescribe archivos para arreglarlo. Submódulos y symlinks no
materializados requieren adaptación. La construcción raw opera por archivo y
respeta el presupuesto total; el rendimiento en repositorios externos grandes aún no está medido.

Git hooks se desactivan para comandos del controlador: convertir sus requisitos
en checks explícitos. Se fija el hash de la configuración efectiva Git y de los
ejecutables/entrypoints para detectar cambios después del preflight. No se guarda
el contenido de configuración Git, solo su digest. Esto no es un sandbox frente
a procesos con los mismos permisos del usuario.

## Journal y recuperación

Cada acción guarda intención antes del efecto, ID idempotente, SHA/destino,
estado y evidencia. El journal se guarda atómicamente y también se incluye en
el checkpoint checksummed del supervisor. stdout/stderr/resultados de comandos
quedan como artefactos locales. Todos los subprocess de entrega del supervisor
usan sus guardians y leases; un guardian sin recibo impide recuperar el lock.

Commit y push a la rama reservada pueden reconciliarse por identidad exacta y
CAS. PR, merge y deploy usan `query_only`: una respuesta desconocida exige
consulta positiva del resultado. Ausencia, ambigüedad, fallo o resultado pendiente
bloquean; no se reintenta una mutación remota a ciegas. Un fallo no se transforma
en éxito porque el comando terminó con exit 0. Cambiar credenciales no autoriza
nuevos destinos o capacidades. Los recibos anteriores y logs se conservan.

Una ejecución completed reanudada devuelve su recibo histórico sin acciones
nuevas; no significa que el ambiente remoto siga igual en otro momento.

## GitHub y deploy

El adapter usa `gh api --hostname github.com` con método explícito y JSON por
stdin; no compone shell. Valida repo/permisos, destino, head/base del PR y marcador
idempotente. Las consultas incompletas o PR duplicados bloquean. El merge requiere
checks nombrados en `success` del SHA exacto, rama base sin avanzar y protección
clásica strict, aplicada también a administradores; no hay bypass ni auto-merge.
Configuraciones que solo se puedan acreditar mediante rulesets requieren otro
adapter. La protección del servidor mantiene la condición de base actualizada
durante el merge, y el árbol resultante se comprueba antes de desplegar.

Se exige un único push URL efectivo, coincidente con el perfil. Push y consulta
usan ese mismo destino, aunque fetch apunte a otro repositorio. Se desactivan
followTags y recursión de submódulos; solo se publica la referencia reservada.
La recuperación de merge vuelve a exigir los checks/política. Un merge externo
sin intención de este run queda bloqueado para reconciliación, incluso si el
árbol coincide: confirmar un efecto no autoriza saltar un gate previo.

Las APIs usadas se contrastaron con [gh api](https://cli.github.com/manual/gh_api)
y [GitHub REST pulls](https://docs.github.com/en/rest/pulls/pulls).
No se ha publicado un PR real ni acreditado permisos/protección de GitHub real
en esta entrega: la demo usa un servicio REST local.

Deploy es un adapter del proyecto con protocolo JSON por stdin:

```json
{ "schemaVersion": 1, "action": "execute", "idempotencyKey": "HASH",
  "sha": "SHA", "tree": "TREE", "target": "isolated-demo" }
```

`statusCommand` recibe `action: "query"`. Responde schemaVersion, misma clave,
SHA y target, `status` (`succeeded`, `failed`, `not_found`, `pending`, `unknown`)
y `evidence: string[]`. Solo succeeded con evidencia no vacía acredita éxito.
El adapter debe consultar el sistema real por clave/SHA/destino y manejar su
idempotencia; un wrapper que imprime éxito no constituye aceptación operativa.
Los checks de release se consultan sobre el SHA final, después del merge.

## Demo reproducible

```powershell
npm run build
node scripts/demo-delivery.mjs fixture
node scripts/demo-delivery.mjs codex
node scripts/demo-delivery.mjs claude
```

Los últimos dos consumen cuota real. Cada demo usa Git bare local, servicio REST
de prueba y despliegue local materializado que ejecuta dos asserts sobre sum.mjs.
Pierde deliberadamente la respuesta de creación de PR y reanuda sin duplicarlo.
No toca repositorios externos, GitHub compartido ni producción. Las sesiones de agentes y
usage se guardan separados del fixture. Entrega aceptada no es benchmark;
métricas e instalación/piloto/CI siguen en tareas 6–7.
