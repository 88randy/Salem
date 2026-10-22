# Seguridad

Salem es una aplicación local para una persona por computadora. Escucha exclusivamente en `127.0.0.1`, valida Host y Origin y protege mutaciones con sesión local y CSRF. No lo expongas mediante un proxy público para convertirlo en un servicio multiusuario.

Los agentes utilizan las sesiones oficiales de Claude Code y Codex. Salem no requiere copiar tokens o contraseñas a sus perfiles. Los checks y agentes ejecutan código con el usuario del sistema: una copia Git, los hashes y los límites de herramientas no equivalen a una sandbox del sistema operativo.

## Reportar un problema

Para un fallo que pueda revelar credenciales o permitir ejecución no autorizada, usa **Security → Advisories → Report a vulnerability** del repositorio si está habilitado. Si no está disponible, abre un Issue solicitando un canal privado sin incluir el exploit, datos personales o secretos. Los errores normales pueden reportarse en Issues con una reproducción reducida.

No adjuntes `auth.json`, archivos de configuración personales, catálogos completos, logs de autenticación ni contenido de proyectos privados. La redacción de logs no es un detector universal de secretos.

## Versiones

La línea inicial es `0.3.x` y está en evaluación pública. Consulta las notas de cada versión para conocer plataformas y recorridos comprobados. No hay una auditoría externa de seguridad acreditada.
