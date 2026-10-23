# Salem 0.5.1 — compatibilidad del modelo de Codex

Los perfiles nuevos de Codex y la incorporación automática utilizan **Predeterminado del CLI** con la configuración personal ignorada. La versión anterior fijaba `gpt-6.1-sol`, que algunas cuentas o clientes rechazan. Las sugerencias de modelos continúan disponibles; seleccionarlas no garantiza acceso desde la cuenta conectada.

La investigación del chat ahora muestra el motivo del rechazo del proveedor y cómo corregir el perfil, en lugar de un mensaje genérico de salida 1. El mensaje se normaliza, redacta y limita; los registros originales se conservan. No hay reintento con otro modelo ni sustitución automática.

Los proyectos existentes conservan sus elecciones. Para corregir uno afectado, selecciona **Predeterminado del CLI** en sus agentes Codex, guarda el perfil e inicia una conversación nueva. El chat anterior conserva su objetivo e historial con la configuración original. La actualización no modifica las cuentas ni la configuración global de los CLIs.

Esta corrección conserva los checks, permisos, presupuestos y reglas de aceptación de la versión conversacional 0.5.0. Sigue siendo una beta local para Windows x64 y el instalador no tiene firma digital.

[Modelos y solución de rechazos](MODELS.md) · [Gestión conversacional](CONVERSATIONS.md) · [Instalación](WINDOWS.md)
