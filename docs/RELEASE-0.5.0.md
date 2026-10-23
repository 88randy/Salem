# Salem 0.5.0 — gestión conversacional

La beta para Windows incorpora una conversación que mantiene el objetivo, el plan y los resultados del proyecto. Describe qué quieres conseguir desde Inicio; Salem investiga el repositorio, pregunta por las decisiones de producto pendientes y organiza tareas dependientes.

## Trabajo desde el chat

- Plan visible con sus dependencias, agente asignado y estado de cada paso.
- Avances vinculados a investigaciones, ejecuciones, cambios y comprobaciones reales.
- Referencias de texto, borrador persistente, mensajes idempotentes y ajustes posteriores al objetivo.
- Detener, continuar y reintentar un paso en una copia nueva conservando los resultados aceptados.
- Respuestas informativas que investigan sin iniciar una implementación innecesaria.

Cada implementación parte del último resultado aceptado en una copia Git propia. La revisión se ejecuta en otra sesión y la última tarea comprueba también el objetivo conjunto. El chat entrega localmente: no crea commits ni publica, integra o despliega de forma implícita.

## Menos trabajo repetido

Salem proporciona al revisor recibos verificados de los pasos anteriores. El implementador devuelve su trabajo al controlador, que después inicia la revisión independiente; se evita duplicar esa revisión dentro de la implementación. Los resúmenes repetidos se envían como extractos identificados y los hallazgos estructurados permanecen completos. El resultado original sigue disponible en los artefactos.

En un reintento real del último paso del carrito de demo, el consumo pasó de **508309 a 301388 tokens reportados** con el mismo perfil y presupuesto de 500000. Los cuatro checks y la revisión independiente aprobaron el resultado y la conversación terminó con tres pasos aceptados. Es una observación exploratoria de una tarea; no demuestra un ahorro general ni un precio de facturación. El CLI no informó el modelo efectivo ni el costo, y su total de entrada incluye tokens en caché.

## Datos y actualización

El catálogo usa el formato **2**. Antes de la primera modificación de un catálogo anterior, Salem conserva un respaldo exacto `catalog.v1-backup-<id>.json`. Las versiones 0.4 y anteriores rechazan el formato nuevo para impedir que ejecuten sus tareas sin el coordinador conversacional.

Para volver a una versión anterior, conserva todos los datos actuales y utiliza una copia separada del respaldo previo a la migración. Ese respaldo no contiene el trabajo posterior. Reinstalar un programa antiguo no convierte ni restaura automáticamente el catálogo.

La configuración del proyecto se congela al preparar el plan. Cambiarla detiene el inicio de nuevos pasos; crea otra conversación con el perfil revisado. Las instrucciones, los verificadores, la aceptación, las capacidades y los presupuestos no se relajan automáticamente para completar un trabajo.

## Validación y límites

La validación local de esta entrega incluye typecheck y build, 49 pruebas de interfaz y 26 de distribución sin omisiones, con instalación y actualización mediante Setup y conservación de datos al desinstalar. La demo real completó tres tareas con Codex, sin modificar su repositorio de origen, y conservó el estado completado tras reiniciar sin añadir ejecuciones. Las pruebas automatizadas de proveedores utilizan fixtures; no equivalen a ensayos reales de todas las combinaciones de cuentas y modelos.

Consulta [Actions](https://github.com/88randy/Salem/actions) para el resultado completo de cada revisión y [Releases](https://github.com/88randy/Salem/releases) para identificar el instalador publicado. Un resultado local no acredita por sí solo la CI de otra revisión.

El coordinador ejecuta una tarea a la vez por conversación. Los adjuntos son texto UTF-8 y los agentes siguen sujetos a la cuenta, el modelo y la cuota disponibles. Los procesos se ejecutan con el usuario local; una copia Git no es una sandbox del sistema operativo. El instalador aún no tiene firma digital.

[Guía del chat](CONVERSATIONS.md) · [Instalación en Windows](WINDOWS.md) · [Seguridad](../SECURITY.md)
