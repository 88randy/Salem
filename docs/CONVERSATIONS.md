# Trabajar desde una conversación

En **Inicio**, selecciona un proyecto y describe lo que quieres conseguir. Salem abre una conversación persistente: investiga el repositorio, responde consultas, pide las decisiones de negocio que no puede deducir y prepara las tareas necesarias para un cambio.

Por ejemplo: «Corrige el cálculo del carrito, conserva los verificadores y comprueba el resultado». No necesitas crear tareas ni iniciar sus ejecuciones una a una. Si preguntas «¿Cómo funciona el carrito?», Salem puede responder después de investigar sin iniciar implementación.

## Durante el trabajo

- Responde preguntas y agrega instrucciones desde el mismo chat. Puedes adjuntar archivos de texto como referencia. No adjuntes contraseñas ni tokens.
- **Plan y resultados** muestra los pasos, sus dependencias, el agente y modelo configurados, y el acceso a las evidencias.
- **Ver cambios y comprobaciones** abre el detalle de una ejecución con sus checks, revisión, diff y logs. Volver regresa a la conversación.
- **Detener** pide el cierre de los procesos propios y conserva su evidencia. Cambiar instrucciones también detiene el trabajo en curso antes de investigar otra revisión.
- **Continuar trabajo** reconcilia el checkpoint nativo. Si no puede verificarse, Salem se detiene y explica el motivo. **Reintentar paso en copia nueva** conserva el intento fallido y parte del último código aceptado.

La conversación se encuentra en **Trabajo**, búsqueda y recientes del menú lateral. El borrador se conserva durante las actualizaciones y, en la misma pestaña, al recargar. Puedes exportar el historial a JSON.

## Qué decide Salem

La investigación distingue hechos del repositorio, supuestos, decisiones técnicas y preguntas de producto. Propone tareas con criterios comprobables, IDs y dependencias. El controlador rechaza ciclos, rutas que escapan del proyecto, checks inexistentes y agentes ajenos al perfil.

Cada tarea puede asignarse a un agente del perfil del proyecto. La definición y revisión conservan sus roles configurados. Una elección de modelo representa la configuración solicitada; si el CLI no informa el modelo efectivo, no se inventa ese dato. Un rechazo de cuenta o cuota detiene el trabajo; no cambia silenciosamente de proveedor o modelo.

Los pasos se ejecutan en orden, en copias Git independientes dentro de los datos de Salem. La siguiente copia recibe exactamente los archivos y el índice del último resultado aceptado. Antes de continuar se comprueban su hash, checks reales, revisión en otra sesión y recibo de entrega. No hace falta crear un commit para encadenar tareas y el repositorio original conserva su estado.

Todos los checks requeridos del perfil se mantienen en cada paso. Los criterios de cada tarea se asocian a checks existentes; la última tarea incluye también la aceptación conjunta del objetivo. Un plan que requiere agregar verificadores se detiene para revisar explícitamente el perfil. La conversación no modifica las reglas de aceptación ni los permisos para poder avanzar.

## Persistencia y entrega

Mensajes, revisiones, tareas, ejecuciones y eventos se conservan en el catálogo local con checksum y escritura atómica. Repetir una solicitud con la misma clave no duplica la operación. El servidor mantiene el bloqueo exclusivo de la instalación. Tras un cierre, el trabajo interrumpido requiere una continuación explícita; los pasos aceptados no vuelven a ejecutarse por abrir la conversación.

Un mensaje o una respuesta de producto guardados justo antes del cierre también permanecen pendientes. Al volver a abrir Salem, pulsa **Continuar trabajo** para procesarlos: una orden de continuar anterior al cierre no autoriza su ejecución tras el reinicio. La cola y el orden de los mensajes se conservan.

La versión 0.5 usa el formato de catálogo 2. Lee los datos anteriores y, antes de la primera modificación, conserva una copia exacta `catalog.v1-backup-<id>.json` en la carpeta de datos. Las versiones 0.4 y anteriores rechazan el catálogo nuevo: no deben ejecutar sus tareas sin el coordinador conversacional. Para volver a una versión anterior, conserva primero todos los datos actuales y utiliza una copia separada del respaldo previo a la migración; ese respaldo no contiene el trabajo posterior. Reinstalar una versión antigua no convierte ni restaura automáticamente el catálogo.

Los mensajes de Salem citan su investigación o ejecución de origen. El chat presenta avances del controlador y resultados reales; no reconstruye una transcripción inventada de Claude o Codex ni muestra salida del proceso como si fuera una conversación humana.

Los agentes reciben también recibos compactos de los pasos anteriores de su cadena. Antes de enviarlos, Salem comprueba la propiedad de las copias, los checkpoints, las pruebas de checks y las sesiones independientes de implementación y revisión. Así, el revisor final puede comprobar condiciones históricas sin acceder a carpetas ajenas a su tarea. Esos recibos no sustituyen la aceptación actual, no amplían permisos y conservan el hash del runtime que produjo cada resultado. Si exceden el presupuesto de contexto, el flujo se detiene y conserva la evidencia.

Salem separa la implementación de la revisión: el implementador verifica su cambio y devuelve el resultado; después el controlador inicia al revisor en otra sesión. Se evita encargar una segunda revisión dentro de la implementación para duplicar esa etapa. Los resúmenes de intentos previos se envían como extractos identificados, conservando los hallazgos estructurados completos y el resultado original en disco. Los criterios, el diff y los recibos de checks no se recortan con esa compactación.

Estas medidas reducen trabajo repetido, pero no garantizan un consumo fijo. El presupuesto cuenta los tokens que informa el CLI, incluidos los de entrada en caché cuando el proveedor los incluye en ese total. Un check verde o un verdict favorable no permite ignorar el presupuesto: si se alcanza, la ejecución se detiene y conserva la evidencia. No se cambia de modelo ni se amplía el límite automáticamente.

La entrega conversacional es local. El resultado permanece en la última copia aceptada, accesible desde el detalle. Publicar, integrar o desplegar requiere un flujo explícito de entrega con sus capacidades delegadas; iniciar el chat no publica automáticamente.

## Llevar el cambio aceptado a tu repositorio

En el detalle de una ejecución aceptada, **Descargar parche** entrega un archivo `.patch` con todo el cambio respecto al commit de origen de la tarea (`sourceSha`, visible en **Historial**): archivos nuevos, eliminados, binarios, carpetas nuevas y cambios de modo. En una conversación, el resultado aceptado es la ejecución del último paso (**Revisar resultado aceptado**) y su parche ya incluye los pasos anteriores. La descarga no modifica la copia aislada ni tu repositorio; la API equivalente es `GET /api/executions/<id>/patch`.

Aplícalo desde la raíz de tu repositorio. Primero comprueba qué toca y si encaja:

```sh
git apply --stat salem-1a2b3c4d.patch
git apply --3way --check salem-1a2b3c4d.patch
git apply --3way salem-1a2b3c4d.patch
```

- **Árbol limpio en `sourceSha`:** `git apply` reproduce exactamente el árbol aceptado. Añade `--index` si quieres dejarlo preparado para commit, incluidos los cambios de modo en Windows.
- **Rama que avanzó después de `sourceSha`:** `--3way` usa los blobs de origen que registra el parche para fusionar. Si hay conflictos, los marca en los archivos y en el índice; resuélvelos y revisa con `git diff` antes de hacer commit. Si prefieres aislarlo, crea una rama en `sourceSha` (`git switch -c salem-cambio <sourceSha>`), aplica allí y luego fusiona o rebasa con tus herramientas habituales.
- **Árbol con cambios sin commit:** `--3way` exige que los archivos afectados coincidan con el índice. Guarda o confirma antes tu trabajo (`git stash push -m antes-de-salem`), aplica el parche y recupera tus cambios con `git stash pop`; o aplícalo en un `git worktree` separado.
- **Si falla:** `git apply` no deja cambios a medias cuando la comprobación falla. Con `--reject` aplica lo que encaja y guarda el resto en archivos `.rej` para revisión manual (no combina con `--3way`).

El parche no aplica la redacción de secretos del diff en pantalla, porque alteraría su contenido: revísalo antes de compartirlo. Si supera 2 MB, la descarga se rechaza con un error claro; en ese caso recupera el cambio desde la ruta de la copia aislada. Si la copia aislada ya no existe, la descarga responde que no está disponible. El parche solo se genera si la copia sigue siendo exactamente el resultado aceptado (misma identidad Git e instantánea del repositorio, antes y después de exportar); si alguien la modificó después de la revisión, la descarga se rechaza para no entregar cambios sin revisar. Su forma no depende de tu configuración de Git (`diff.context`, `diff.noprefix`, `GIT_DIFF_OPTS`): siempre usa tres líneas de contexto y prefijos `a/` y `b/`. Tampoco la alteran marcas del índice (`assume-unchanged`, `skip-worktree`), filtros `clean`/`process` de cualquier nivel de configuración ni `core.attributesFile`; si la copia tiene `info/attributes` o reglas de conversión de fin de línea añadidas después de aceptar, la descarga se rechaza.

### Crear una rama local con el cambio aceptado

Si prefieres no aplicar el parche a mano, **Crear rama** (junto a **Descargar parche**) crea una rama nueva en el repositorio del proyecto con exactamente el árbol aceptado: un commit cuyo padre es `sourceSha` y cuyo contenido es el mismo que exporta el parche (binarios, eliminaciones, carpetas nuevas y modos incluidos). Puedes escribir el nombre o dejarlo vacío para usar `salem/<objetivo>-<id corto de la ejecución>`. La API equivalente es `POST /api/executions/<id>/branch` con `{ "name"?: "..." }`, que responde `201` con `{ ref, commit }`.

- **Qué cambia en tu repositorio:** solo se añaden los objetos del commit (`git fetch` desde la copia aislada, sin `FETCH_HEAD`, etiquetas ni submódulos) y se crea la referencia nueva. Tu `HEAD`, índice, archivos, stash y demás ramas no cambian, así que funciona aunque tengas cambios sin commit o un merge o rebase a medias. No se hace checkout: cámbiate a la rama cuando quieras (`git switch <rama>`). No se ejecutan hooks en tu repositorio ni se firma el commit. La copia se lee solo por el protocolo `file`, así que reglas `url.*.insteadOf` u otros protocolos de tu configuración no pueden convertirla en un comando, y se anula `core.alternateRefsCommand` de tu repositorio durante esa lectura. Si cierras Salem mientras se crea una rama, el cierre espera a que termine y quede registrada.
- **Si algo falla a medias:** Salem registra la intención (rama y commit) antes de crear la referencia. Si después no puede guardar el recibo, la ejecución muestra la rama como pendiente y **Completar rama** (o reiniciar Salem) la confirma si la rama apunta a ese commit, o la vuelve a crear con el mismo nombre si no existe. Mientras esté pendiente no se crea otra rama con otro nombre.
- **Nunca sobrescribe:** la rama se crea de forma atómica solo si no existe, y nunca se sigue ni se reemplaza una referencia simbólica con ese nombre. Si ya existe, incluso por una carrera con otro proceso, responde `409` y no toca nada; elige otro nombre. Cada ejecución crea una sola rama; un segundo intento responde `409` con la rama ya creada.
- **Identidad:** autor y committer salen de `user.name` y `user.email` de la configuración Git de tu repositorio (local, global o del sistema). Si faltan, responde `409` con los comandos `git config` para configurarlos. El mensaje del commit nombra el objetivo, la tarea y la ejecución.
- **Nombre:** se valida con `git check-ref-format --branch`; se rechazan con `400` los nombres con espacios, `..`, `@{`, guion inicial o prefijo `refs/`.
- **Mismas garantías que el parche:** solo para ejecuciones aceptadas cuya copia aislada sigue siendo exactamente el resultado aceptado (`409` si cambió, `410` si ya no existe). La rama creada y su commit quedan registrados en la ejecución y se muestran en la pestaña **Entrega**.

Publicar la rama, abrir un PR o integrarla sigue siendo un paso tuyo o del flujo de entrega delegado.

## Límites actuales

El coordinador ejecuta una tarea a la vez por conversación, incluso si algunos nodos del plan son independientes. Las referencias adjuntas son texto UTF-8: hasta ocho archivos, 40.000 caracteres por archivo y 100.000 en total. Las imágenes y archivos binarios no se admiten como referencias del chat.

Una conversación admite hasta 200 comandos y un contexto limitado. Si se alcanza el límite, inicia otra con el contexto consolidado. Cambiar el perfil mientras un plan está congelado detiene el inicio de nuevas tareas; inicia otra conversación con la configuración actual. Las tareas de un plan se ajustan desde el chat, conservando su historial, y no se editan o ejecutan individualmente desde herramientas avanzadas.

La copia de una base aceptada rechaza enlaces o entradas incompatibles, en vez de seguirlos fuera del workspace. Los procesos y comprobaciones siguen los límites de [seguridad](../SECURITY.md) y [recuperación](SUPERVISOR.md) del framework. No se ofrece una sandbox del sistema operativo ni ejecución remota mediante este flujo.
