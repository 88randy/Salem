# Salem 0.3.0 — primera versión local para Windows

Salem permite gestionar proyectos, objetivos y ejecuciones de Claude Code y Codex con las sesiones oficiales de cada persona. Esta es una distribución inicial para probar proyectos locales. Consulta el estado automatizado del código en [CI Windows](https://github.com/88randy/Salem/actions/workflows/ci.yml) y la aceptación de cada paquete en [Releases](https://github.com/88randy/Salem/releases).

## Qué incluye

- Modelos, esfuerzo y etapas editables; el perfil nuevo propone Opus5.5 Medio para definir/revisar y GPT-6.1 Sol para implementar.
- Incorporación de repositorios, investigación de objetivos y preparación de planes.
- Supervisor persistente, checks reales, revisión independiente y entrega según capacidades explícitas.
- Mejoras de código fuente con respaldo, aplicación de candidatas aceptadas y reversión conservadora.
- Instalación Windows x64 por usuario, cierre de procesos propios y actualización/desinstalación conservando datos.
- Código MIT, avisos de dependencias, guías y plantillas para contribuir.

## Aceptación observada el 22 de octubre de 2026

| Recorrido | Evidencia observada |
| --- | --- |
| Código desde GitHub | Clon nuevo, npm ci, build e inicio con catálogo vacío; ambas sesiones locales detectadas al comprobarlas. |
| Interfaz | 24/24 pruebas locales en Chrome, con tamaños de escritorio, tablet y móvil emulados. |
| Distribución | 22 comprobaciones de contrato/launcher aprobadas; recorrido nativo Setup1/1 sobre el paquete actualizado: instala, arranca, rechaza actualización activa, cierra, actualiza y desinstala sin perder datos. También se probó instalación/desinstalación con una ruta temporal abreviada real de Windows. |
| Cuentas reales | Claude Opus5.5 Medio define y revisa en sesiones distintas; Codex con elección explícita del predeterminado del CLI implementa. Checks originales y entrega local aceptados; origen intacto. |
| Autoevolución en demo | Claude investiga/propone y Codex revisa; aplicación aceptada y reversión manual restauran hashes y estado Git originales sin cambiar permisos o verificadores. |
| CI Windows | Cada push comprueba tipos, núcleo, interfaz, distribución y Setup. El resultado y los logs pertenecen al commit indicado en Actions; un workflow existente no equivale a un resultado aprobado. |

Los recibos privados, rutas personales y credenciales quedan fuera del repositorio y de los adjuntos. Las notas de cada release identifican el commit probado y los hashes del paquete. Las primeras pasadas de validación descubrieron diferencias entre rutas temporales abreviadas y físicas en Windows y una carrera de limpieza de fixtures; las correcciones conservan la contención de rutas, el cierre de procesos y las aserciones. En una pasada local también se observaron límites de tiempo; esos casos se conservaron y repitieron sin elevar los presupuestos del producto.

## Disponibilidad de modelos

Una sesión autenticada no acredita acceso a todos los modelos. En la prueba local, el servicio rechazó el preset Sol para la sesión de Codex con ChatGPT. La elección explícita **Predeterminado del CLI** funcionó; Salem conserva el rechazo y no cambia modelos silenciosamente. El CLI no informó el nombre del modelo efectivo de Codex. Consulta [Modelos](MODELS.md) antes de elegir un preset para tu cuenta.

## Uso y límites

Instala Git y los CLIs oficiales de los proveedores que utilizarás. Abre Salem y comprueba o conecta tus cuentas en **Cuentas**. No hace falta una API key si el CLI usa tu sesión existente; se consume la cuota o los créditos de esa cuenta.

- El instalador no tiene firma digital. Comprueba los SHA256 publicados junto con sus archivos.
- Se probó Windows x64 con carpetas nuevas de instalación/datos de forma aislada. No se acredita una VM limpia, macOS/Linux, dispositivos físicos ni todas las políticas corporativas.
- Los agentes y checks ejecutan código con tu usuario; no hay sandbox del sistema operativo para proyectos hostiles.
- La autoevolución modifica código fuente con respaldo. No reemplaza automáticamente el runtime instalado ni vigila todas las regresiones futuras.
- Los demos no demuestran ahorro universal, superioridad de un modelo ni validación de producción.

La [guía de Windows](WINDOWS.md) explica instalación, cierre, actualización, recuperación de datos y desinstalación.
