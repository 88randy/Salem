# Salem local

Salem permite configurar proyectos, definir tareas y seguir ejecuciones de Claude
y Codex desde una interfaz en español. Cada persona lo ejecuta en su computadora,
con las cuentas y permisos de su usuario del sistema operativo. No requiere una
cuenta Salem ni copiar las sesiones de otra persona.

Puedes incorporar un repositorio local por su carpeta y describir un objetivo
en lenguaje natural. Salem propone el perfil, investiga el código y arma un plan
con evidencia y criterios de aceptación. Al crear la tarea desde ese plan, el
supervisor coordina definición, implementación, checks, revisión y las acciones
de entrega delegadas. También puedes seguir configurando perfiles y tareas de
forma manual.

## Arrancar

Se necesitan Node.js 22, npm y Git. Instala los CLIs oficiales de los proveedores
que vayas a utilizar; Salem comprueba su presencia, compatibilidad y sesión desde
Cuentas. Un CLI instalado no acredita por sí solo una sesión autenticada.

Desde la carpeta de este repositorio:

```powershell
npm ci
npm run salem
```

El segundo comando compila el núcleo y la interfaz, inicia el servidor y muestra
su dirección y directorio de datos. Abre esa dirección en el navegador. El puerto
predeterminado es `3210` y el servidor escucha exclusivamente en `127.0.0.1`.
Si el puerto está ocupado, informa el error; no cierra el servicio que lo usa.

Mantén la terminal abierta mientras trabajas. Cerrar una pestaña del navegador no
cancela las ejecuciones. Para detener el servidor, usa `Ctrl+C`: Salem solicita
cancelar sus procesos activos y espera su cierre.

## Cuentas personales

En **Cuentas**, usa **Comprobar** para detectar el CLI, consultar su versión y
verificar la sesión. La pantalla muestra el último diagnóstico; abrirla no inicia
automáticamente comandos de autenticación. Si ya existe una sesión válida, Salem
la aprovecha sin cerrarla ni reemplazarla.

- **Conectar** inicia el flujo oficial del CLI. Completa la autorización en el
  navegador que abra el proveedor o en el enlace oficial mostrado por Salem.
- Codex ofrece **Usar código de dispositivo** cuando el CLI soporta ese flujo.
  No hay una alternativa de dispositivo equivalente para Claude en esta interfaz.
- Si el CLI solicita un código de retorno, introdúcelo únicamente en la conexión
  activa que lo está pidiendo. No es un campo para contraseñas ni claves API.
- **Cancelar conexión** detiene la operación de conexión propia de Salem.
- **Desconectar** requiere confirmación y solicita cerrar la sesión oficial del
  proveedor para tu usuario del sistema. Puede afectar otras herramientas que usen
  esa misma sesión CLI; no borra proyectos ni ejecuciones de Salem.

Hay una cuenta activa por proveedor y usuario del sistema. Cambiar una cuenta
durante una ejecución de ese proveedor está bloqueado. Una conexión solo se marca
autenticada tras terminar correctamente y superar la comprobación del CLI.
Una expiración o un error quedan visibles; no se interpretan como éxito.

Salem no importa `auth.json`, contraseñas, tokens, memorias ni perfiles personales.
El almacenamiento oficial de cada CLI conserva las sesiones. Los enlaces y
códigos de conexión son efímeros y no se guardan en el historial de tareas.
Los comandos locales de los proveedores se eligen en **Ajustes**; la pantalla de
Cuentas incluye enlaces a su instalación oficial.

## Proyectos

**Agregar proyecto** abre el formulario completo. Puedes escribir rutas o usar
**Elegir carpeta**. Selecciona la raíz de un repositorio Git local y una rama o SHA
base disponible localmente; **Consultar ramas** muestra las opciones y el HEAD.
Solo entra el contenido del commit elegido. Los archivos sin commit del
repositorio seleccionado no forman parte de esa base.

El perfil se organiza en estos grupos:

| Grupo | Configuración |
| --- | --- |
| Proyecto y repositorio | Nombre, identificador, carpeta, rama o SHA base, archivos de contexto e instrucciones adicionales. |
| Agentes y etapas | Identificador, proveedor, ejecutable y argumentos separados, modelo y esfuerzo opcionales, perfil limpio de Codex y asignación de `define`, `build` y `review`. |
| Preparación del entorno | Secuencia de comandos con sus argumentos para preparar cada copia de ejecución. |
| Checks de aceptación | Identificador, comando, obligatoriedad, ejecución o simulación, razón de no aplicabilidad y archivos de herramientas. |
| Límites y capacidades | Tiempo por etapa y corrida, salida máxima, intentos, límite opcional de tokens reportados y permisos de editar, crear commits, abrir PR, integrar y desplegar. |
| Entrega y recuperación | Prefijo de rama, mensaje y autor del commit; GitHub, remoto, URL, repositorio, base y borrador; método de integración y checks; comandos de despliegue y consulta de estado, destino, archivos de herramientas y checks. |

Los archivos de contexto y herramientas se declaran relativos al repositorio.
Cada comando conserva el ejecutable y sus argumentos por separado: un argumento
que contiene espacios sigue siendo un solo argumento. No hay interpretación
implícita de shell, tuberías o expansión de variables.

Modelo y esfuerzo son opciones de esa invocación. Su disponibilidad depende del
proveedor y de tu cuenta; Salem muestra un rechazo sin sustituir automáticamente
el modelo. Vaciar un campo opcional elimina el override. Las opciones de proyecto
no reescriben la configuración global de los CLIs.

La recuperación de entrega usa `query_only`: consulta y reconcilia una acción
previa cuyo resultado es incierto; no la vuelve a ejecutar por inferencia.
Activar una capacidad y configurar sus herramientas son decisiones explícitas
del operador. Registrar un proyecto no habilita publicación ni producción.

Usa **Validar configuración** para comprobar el perfil y **Guardar proyecto**
para persistirlo. Las listas permiten editar, duplicar, exportar y archivar o
restaurar. Archivar es lógico: conserva el repositorio y la evidencia histórica.
**Importar perfil** y **Exportar perfil** permiten trasladar configuración JSON;
el editor de formularios sigue disponible y no requiere editar JSON a mano.
Revisa rutas y comandos al llevar un perfil a otra computadora.

Si otra pestaña guardó una revisión más reciente, el servidor rechaza la edición
con un conflicto. Salem conserva el borrador y ofrece actualizar las listas.
Esa actualización no reemplaza el formulario abierto. Conserva o exporta el
borrador antes de cancelar y abrir la versión actual para reconciliar cambios.

## Tareas

Agrega una tarea a un proyecto y completa su identificador legible, objetivo,
alcance, criterios de aceptación y referencias. Cada elemento de las listas ocupa
una línea. En **Checks por criterio**, relaciona los criterios con los checks
definidos en el proyecto; esa relación debe corresponder a verificaciones reales.
Una simulación no acredita aceptación de código.

Las tareas se pueden editar, duplicar, exportar, importar, archivar y restaurar.
El estado que muestra la lista se deriva de sus ejecuciones. Editar una tarea o un
perfil afecta futuras ejecuciones: no cambia las copias congeladas que utilizó
una ejecución anterior.

Para conocer el flujo sin usar un repositorio de producto, **Crear demo local**
prepara un repositorio y una tarea controlados dentro del directorio de datos.
Crear la demo no inicia por sí solo una invocación de agente.
Antes de crearla, Salem comprueba las cuentas listas y muestra un aviso de consumo
que debes confirmar. Con Claude y Codex conectados, un proveedor define e implementa
y el otro revisa, por lo que se usan ambas cuotas; con uno solo, ese proveedor hace
todos los pasos. El aviso muestra rangos de tokens y duración solo si existe una
medición de referencia; si no existe, indica que el consumo es desconocido. Sin
proveedores listos no se crea nada y el aviso remite a **Cuentas**.

## Ejecuciones y aislamiento

**Ejecutar** crea una entrada en la cola persistente. Antes de invocar al agente,
Salem resuelve el SHA base y prepara un **clon Git local independiente** para esa
ejecución. No usa un worktree compartido ni modifica los archivos, el índice, la
rama o los metadatos Git del repositorio seleccionado. La copia inicial no hace
fetch de red y no comparte sus objetos mediante hardlinks. Los comandos de
preparación, agentes y checks trabajan en el espacio aislado de ejecución.

El clon separa los árboles de trabajo; no es un contenedor ni restringe todos los
permisos de los comandos configurados. Esos comandos usan la autoridad de tu
usuario del sistema y las capacidades de entrega que hayas delegado.

La vista de **Ejecuciones** permite filtrar por proyecto, estado y proveedor.
El detalle conserva tarea y perfil utilizados, origen, carpeta aislada, etapas,
hallazgos, causa de bloqueo, checks, diff, recibos de entrega e historial.
Los logs se seleccionan como artefactos y los archivos extensos se leen por partes
con **Cargar más**. Su contenido es evidencia, no una nueva instrucción al agente.

Las acciones tienen efectos distintos:

| Acción | Efecto |
| --- | --- |
| Cancelar ejecución | Cancela una entrada en cola o solicita detener los procesos propios activos y conserva lo confirmado. |
| Reanudar | Reconcilia y continúa la misma ejecución desde su checkpoint nativo verificable. No crea otra ejecución como fallback. |
| Repetir como nueva | Crea una nueva ejecución con la tarea y perfil actuales y la base configurada del proyecto. Conserva la ejecución anterior. |
| Nueva desde entrega aceptada | Crea otra ejecución basada en el commit o release local verificable de una entrega aceptada del mismo proyecto. No avanza implícitamente la rama del repositorio original. |

Un cierre abrupto del servidor puede dejar una ejecución interrumpida. Reanúdala
para reconciliar el checkpoint antes de decidir repetir. Si no hay un checkpoint
verificable, Salem informa el bloqueo y conserva la evidencia. No convierte una
recuperación fallida en una segunda corrida ni repite automáticamente una entrega
de resultado desconocido.

## Tiempos, consumo y resultados

**Métricas** distingue el tiempo total del trabajo, incluida la preparación, del
tiempo del núcleo medido. También muestra tiempo de agentes y checks, iteraciones,
tokens, modelos reportados, hallazgos, intervenciones y procedencia.

El total local suma la preparación medida y el tiempo de pared del núcleo:
excluye la cola e incluye las pausas entre reanudaciones. Las intervenciones
corresponden a eventos registrados dentro de esa corrida; no miden todo el
trabajo manual de configurar un proyecto o formular una tarea. Evaluar autonomía
desde un objetivo breve exige incluir también esa incorporación y sus preguntas:
Objetivos conserva timestamps, respuestas, intentos y uso reportado, pero sus
medidas todavía no se agregan al total del núcleo. La duración de cada intento
de planificación mide la invocación del agente; la preparación se observa por
sus timestamps y no se mezcla silenciosamente con esa duración.

Los datos desconocidos se muestran como no disponibles o sin medir. Un subtotal
parcial conserva esa etiqueta. El costo puede ser reportado, estimado, mixto o no
disponible: no equivale automáticamente a un cargo real de tu cuenta. Un proceso
que termina con salida cero tampoco equivale a una tarea aceptada. Consulta la
aceptación, los checks y los recibos de entrega antes de interpretar el resultado.
La [guía de métricas](METRICS.md) describe el detalle del núcleo y sus límites.

## Ajustes y datos

Todos los ajustes locales de la aplicación se gestionan desde **Ajustes**:

- Comandos de Claude y Codex, con ejecutable y argumentos separados. Las cuentas
  usan estos comandos; nuevos perfiles toman estos valores como punto de partida.
  Los perfiles existentes conservan sus propios comandos de agente.
- Concurrencia máxima entre una y cuatro ejecuciones e intervalo de refresco.
- Puerto preferido para el próximo arranque.
- Carpeta de datos para el próximo arranque, mediante entrada manual o selector.

La pantalla muestra por separado el directorio de datos actual. Elegir otra
carpeta selecciona **otro catálogo local al iniciar Salem de nuevo**; no mueve ni
borra los proyectos, copias o evidencia del directorio actual. Si el destino es
nuevo, comienza con un catálogo vacío. Si ya contiene datos de Salem, se utiliza
ese catálogo. Cambiar el puerto tampoco reinicia el servidor activo.

La ubicación inicial es `%LOCALAPPDATA%\Salem` en Windows, o
`$XDG_STATE_HOME/salem` en otros sistemas; si esa variable no existe, se usa
`~/.local/state/salem`. Las preferencias de arranque mantienen la referencia al
catálogo seleccionado. La validación en otros sistemas sigue pendiente como parte
de la aceptación multiplataforma.

Los perfiles y tareas exportados no contienen las sesiones oficiales de las
cuentas. Las ejecuciones, logs, snapshots y copias de trabajo permanecen en el
directorio de datos. Archivar una entidad no los elimina y no hay recolección de
basura automática ni una acción de limpieza destructiva en esta interfaz.

Para respaldar, detén Salem de forma ordenada y copia el directorio de datos
completo a una ubicación de respaldo. Si seleccionaste otro directorio, conserva
también las preferencias `launch.json` de la ubicación inicial y los catálogos
anteriores que necesites. Mantén el respaldo privado: contiene información de los
repositorios y de sus ejecuciones. No agregues credenciales de los CLIs al respaldo
de Salem. Ante datos dañados o resultados inciertos, conserva los archivos para
diagnóstico; no los borres como mecanismo de recuperación.

## CLI opcional y seguridad local

La interfaz permite la configuración cotidiana. Para una distribución ya
construida, el binario ofrece también:

```powershell
salem ui --help
salem ui --port 3211 --data-dir "C:\SalemDatos"
```

En este checkout puedes usar el mismo comando sin instalar el binario global:

```powershell
node dist/src/cli.js ui --help
npm run salem -- --port 3211 --data-dir "C:\SalemDatos"
```

Los flags son overrides opcionales de arranque; `--data-dir` permite seleccionar
explícitamente un catálogo para recuperación. No trasladan la evidencia. El
servidor no se expone en la red: valida Host y Origin y protege las mutaciones con
sesión local y CSRF. Lee artefactos solo de ejecuciones registradas, con contención
de rutas y symlinks. No publiques ni coloques un proxy de red delante de este
servicio para convertirlo en una aplicación multiusuario.

## Alcance de la entrega

En **Proyectos → Incorporar proyecto**, selecciona la raíz Git y Claude o Codex.
Salem detecta instrucciones, tecnologías y checks en el commit actual, muestra
sus propuestas y permite guardarlas o abrir los ajustes completos. No instala ni
ejecuta scripts durante la detección. Los cambios sin confirmar quedan fuera de
la revisión investigada; repositorios sin commits necesitan un commit inicial.

En **Objetivos**, elige el proyecto, escribe qué quieres conseguir y pulsa
**Investigar objetivo**. Salem usa la cuenta CLI del agente seleccionado y una
copia independiente de esa revisión para leer el proyecto. El plan separa hechos
con archivos, supuestos, decisiones técnicas, pasos, aceptación y checks. Si faltan
reglas de negocio, puedes responder en la misma pantalla. Se conserva el historial
de intentos, logs, consumo reportado y revisión de origen.

**Crear tarea del plan** incorpora una tarea global con todos los pasos y los
checks propuestos que se muestran en pantalla. No inicia la implementación. Desde
Tareas puedes ejecutarla con el supervisor y la aceptación existentes. La tarea
queda fijada al SHA investigado: si cambias el perfil, investiga un nuevo objetivo.
Editar, duplicar, exportar e importar la tarea conserva su origen; una base de
ejecución anterior no sustituye silenciosamente esa revisión. Una importación
con origen solo se admite si el catálogo puede verificar su investigación; en
otra instalación, crea un objetivo nuevo. Crear la tarea de nuevo devuelve la misma tarea.

Una investigación lista no significa código aceptado. Al reiniciar Salem, una
investigación activa queda interrumpida con evidencia conservada y requiere un
reintento explícito; las que esperaban en cola siguen su curso. Cancelar espera
el cierre de sus procesos propios. Si falta un recibo de limpieza, Salem conserva
ocupados el proveedor y el cupo hasta que exista un recibo verificable o se
inspeccione el problema; no supone que un PID ausente acredita el cierre de sus
descendientes. Investigaciones y ejecuciones comparten el límite de concurrencia
configurado y evitan cambiar la cuenta mientras está en uso.

Desde la interfaz, un perfil sin política de entrega y sin capacidades Git o
remotas termina con una entrega local: código aceptado y diff en la copia
aislada, sin commit. Si delegas commits o publicación, configura su política de
entrega; registrar un proyecto no concede esos permisos.

La muestra inicial prioriza instrucciones y manifiestos y muestra hasta 1000
rutas. La evidencia se valida contra el inventario Git completo de archivos
regulares, sujeto al límite de lectura de metadata de 2 MB; la muestra no limita
qué archivos puede investigar o citar el plan. No hay memoria semántica compartida entre proyectos ni ejecución de
planes con dependencias como tareas separadas. La autonomía técnica no concede
permisos de publicación ni cambia las capacidades del perfil.

La distribución inicial se centra en Windows. Consulta las [notas de la versión](RELEASE-0.3.0.md)
para conocer las pruebas ejecutadas y sus límites. La aceptación en el demo no
acredita compatibilidad multiplataforma ni validación de producción.

## Evolución con aceptación fija

En **Evolución**, Salem identifica errores registrados en ejecuciones e investigaciones. Selecciona una tarea de referencia, el investigador Claude/Codex y **Investigar y probar mejora**. Para conocer el flujo, **Crear demo de evolución** registra un repositorio independiente con un ejemplo reducido del parser de salidas de Salem: acepta incorrectamente arrays por coerción y conserva un verificador que reproduce el defecto.

El experimento reproduce los checks originales en la base, investiga la causa y genera una propuesta de contenidos con herramientas de solo lectura. El controlador aplica exclusivamente archivos existentes del alcance autorizado a otro clon del mismo SHA; todos los demás archivos, instrucciones y verificadores quedan congelados. Ejecuta los mismos checks y exige una revisión en otra sesión mediante las mismas funciones de aceptación que el supervisor. Criterios nuevos del plan no sustituyen los originales. Solo marca **Mejora comprobada** si repara un fallo reproducido y toda la aceptación original pasa.

Necesita un perfil local con `edit=true`, las otras capacidades en `false`, sin `delivery` ni `preparation`, checks requeridos reales y aceptación mapeada. No transforma automáticamente perfiles con publicación en perfiles de experimento: crea un perfil local apropiado. El alcance debe enumerar archivos concretos, sin globs, enlaces ni archivos nuevos. No permite evolucionar las reglas de aceptación, comandos/permisos, adapters, instrucciones, tests, configuración ni el controlador de evolución. Las dependencias ya deben estar disponibles; las copias no instalan paquetes. El inventario incluye archivos ignorados y está limitado a 20000 entradas/100 MB totales/20 MB por archivo; rechaza entradas que no puede verificar.

Cada experimento conserva plan, sesiones, uso reportado, resultados antes/después, diff y candidata en el directorio de datos. El ejemplo de tipos estrictos es una reproducción reducida, no una modificación del runtime instalado. Se puede registrar Salem como proyecto para proponer mejoras de componentes permitidos; el evaluador sigue ejecutándose fuera de esa candidata. La aplicación local descrita abajo modifica código fuente; no instala binarios, commitea ni publica. Una reparación medida no acredita un aumento de velocidad o ahorro de tokens; los valores desconocidos se muestran como no reportados.

Comparte cola, límites de concurrencia y exclusión de cambios de cuentas. Cancelar espera el cierre de procesos propios. Un reinicio conserva la evidencia y deja interrumpidos los experimentos activos, sin repetir inferencias; un nuevo experimento requiere iniciarlo explícitamente. Recibos de procesos sin cierre confirmado reservan el proveedor y capacidad. Una vez resueltos sus recibos, iniciar otro experimento vuelve a comprobarlos; Salem no mata PIDs por suposición. Los logs son datos, nunca permiso para ampliar autoridad.

La huella de autoridad incluye ejecutables y entry scripts de los agentes, runtime JS, templates y herramientas de checks. Cambiarlos durante el experimento bloquea la continuación. Cada inferencia consume un intento del `maxAttempts` original, además de respetar tiempo y tokens. El inventario protege objetos, refs e información Git y compara el índice por paths/blobs/stages/flags; los refrescos stat del índice no se interpretan como una modificación de código. Un clon y hashes no constituyen un sandbox de sistema operativo: los checks siguen ejecutando código con el usuario local. La evaluación de código hostil requiere aislamiento de host adicional.

Solo necesita los ejecutables del investigador seleccionado y del revisor configurado. Elegir Claude como investigador conserva el revisor del perfil; el demo usa Codex para revisión independiente. No es una comparación entre modelos con una única muestra. El presupuesto de tokens utiliza la misma función del supervisor, incluyendo lecturas y creación de caché y consumo incompleto.

## Aplicar y revertir mejoras

En **Evolución**, deja **Aplicar al superar las pruebas** activado para que el ciclo continúe automáticamente después de la aceptación original. Desactívalo para conservar únicamente la candidata. Una candidata actual que se investigó sin aplicación automática también ofrece **Aplicar mejora**. El detalle muestra el estado, archivos respaldados y resultados de los mismos checks tras aplicar.

Salem verifica otra vez los recibos, la revisión independiente y las huellas de autoridad antes de escribir. El origen debe estar limpio, en el mismo commit y árbol de la base investigada. Si editaste archivos, cambiaste el perfil o actualizaste herramientas, conserva tu trabajo e inicia un nuevo experimento apropiado; no fuerza el reemplazo ni reutiliza aceptación histórica. Experimentos anteriores a esta función no tienen un sello de aplicación y permanecen como evidencia histórica.

El respaldo durable guarda los bytes y modos originales antes de cambiar el primer archivo. Se aplican exactamente los contenidos revisados y se vuelven a ejecutar los checks requeridos en el origen. Si fallan o se cancela la aplicación, Salem intenta restaurar los originales. **Revertir mejora** permite pedir la misma restauración después de una aplicación correcta. No hace reset, checkout, commits ni publicación.

Un cambio posterior ajeno en un archivo de destino, HEAD, índice o identidad del repositorio detiene la reversión y conserva el respaldo. Resuelve el conflicto y pulsa **Reintentar reversión**; Salem no sobreescribe una tercera versión. Un reinicio durante una transacción restaura desde el journal cuando los recibos de procesos confirman su cierre; nunca repite a ciegas la aplicación o la inferencia. El bloqueo de aplicación se comparte entre instancias que apuntan al mismo repositorio, aunque usen catálogos distintos.

Este ciclo protege fallos detectados por los checks de aplicación. No observa continuamente regresiones futuras ni sustituye un sistema de despliegue. Las escrituras de varios archivos son recuperables, no una operación atómica visible para otros editores. Los checks se ejecutan con el usuario del sistema operativo; no hay aislamiento de host frente a código malicioso. El evaluador, sus permisos, configuración, instrucciones y verificadores siguen fuera del alcance evolucionable.
