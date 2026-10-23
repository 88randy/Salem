# Salem 0.4.0 — espacio de trabajo

Esta versión renueva la experiencia de la beta local para Windows. Conserva la identidad de Salem, las cuentas oficiales del CLI y el flujo de trabajo existente.

## Cambios

- Inicio centrado en un objetivo escrito en lenguaje natural: elige el proyecto, investiga con el agente asignado a definición y abre su registro persistente.
- Navegación lateral que se puede contraer, con proyectos y ejecuciones recientes. Biblioteca de proyectos con acceso al trabajo y a todas las opciones de perfil existentes.
- Búsqueda local de proyectos, tareas, objetivos, ejecuciones, errores y mejoras. Ctrl+K abre la búsqueda; también hay un botón accesible en pantallas pequeñas.
- Panel de actividad con investigaciones, ejecuciones y experimentos de mejora. Presenta el estado observado, los errores reportados y acceso al registro correspondiente.
- Ejecuciones con contexto lateral: entorno, perfil congelado, agentes, aceptación, checks y entrega. Las pestañas mantienen etapas, checks, diff, logs, métricas, entrega e historial.
- Ajustes organizados y tema claro, oscuro o según el sistema, persistente en este navegador. No modifica la configuración del CLI o del servidor al elegir un tema.
- Icono propio del gato en la pestaña, el instalador y los accesos directos de Windows, con resoluciones de 16 a 256 píxeles. El icono de los accesos apunta a la versión instalada y verificada.
- Los reintentos de investigación conservan su clave de idempotencia y su borrador. Una respuesta tardía al iniciar una investigación no te saca de la pantalla a la que navegaste.

## Ajustes de usabilidad

- Navegación principal Inicio, Proyectos y Trabajo. Las vistas técnicas siguen disponibles en Herramientas avanzadas; Cuentas y Ajustes conservan acceso directo.
- Menú lateral de ancho ajustable con arrastre o teclado y preferencia persistente. Controles compactos; proyectos y recientes ocupan el espacio principal.
- Menús de acciones con clic derecho, tecla Menú/Mayús+F10 y botón de más acciones en proyectos. Reutilizan los controles existentes y sus restricciones; no habilitan operaciones adicionales.
- Tooltips en botones de iconos. Desplegables con picker nativo estilizado en Chromium compatible, navegación de teclado y fallback del navegador.
- Panel de actividad con un único scroll; scrolls discretos, logs que conservan su altura y nombres de archivo legibles con la ruta completa disponible.
- Errores de operación visibles al pie de la pantalla. Tareas inválidas señalan alcance o aceptación junto al campo y junto a Guardar, sin perder el borrador. Un aviso de éxito no oculta un error posterior.
- Trabajo reúne investigaciones, progreso y resultados con un filtro explícito por proyecto; comienza mostrando todos. Los hallazgos conservan etapa/agente de procedencia.

## Gestión conversacional: siguiente fase

Esta versión conserva el motor actual: una investigación produce un plan y materializa una tarea para el supervisor. La conversación continua por objetivo, descomposición en varias tareas con dependencias y coordinación de su ciclo completo siguen pendientes. La nueva navegación facilita el recorrido existente y no simula esas capacidades futuras.

## Compatibilidad y validación

No hay migración del catálogo ni modificación de reglas de aceptación, permisos, CLIs, asignaciones de modelos o límites de los perfiles existentes. Una ejecución terminada no se presenta como aceptada si falta su recibo de aceptación.

Las pruebas de interfaz cubren el flujo anterior y el nuevo, con tamaños de escritorio, tableta y móvil emulados. Los resultados y artefactos por revisión están en [Actions](https://github.com/88randy/Salem/actions); consulta la nota de la [distribución descargada](https://github.com/88randy/Salem/releases) para las cifras y pruebas nativas de ese paquete. Un workflow definido o una prueba simulada no acreditan por sí solos una ejecución real de las IA.

Continúan los límites documentados en la [beta inicial](RELEASE-0.3.0.md): instalador sin firma digital, Windows x64, modelos sujetos a cuenta/cuota, ausencia de sandbox del sistema operativo y sin certificación en una VM limpia, dispositivos físicos, otros navegadores o producción.
