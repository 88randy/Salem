# Contribuir a Salem

Gracias por ayudar a mejorar Salem. Usa Issues para describir un problema reproducible o discutir una mejora antes de un cambio grande. No adjuntes credenciales, código privado ni catálogos completos.

## Desarrollo

Se necesitan Node.js22, Git y npm. Las pruebas automatizadas usan proveedores simulados y no necesitan cuentas de IA.

```sh
npm ci
npm run typecheck
npm test
npx playwright install chromium
npm run test:ui
```

Para probar con Chrome instalado, configura `PLAYWRIGHT_CHANNEL=chrome`. La interfaz usa el navegador solo en loopback. Para desarrollo interactivo: `npm run salem`.

Las convenciones de código, pruebas, Windows y flujo de trabajo, también para agentes de programación, están en [AGENTS.md](AGENTS.md).

Trabaja en una rama. Incluye una reproducción o una prueba de comportamiento, el cambio mínimo y los resultados de verificación. Distingue pruebas simuladas de inferencias reales. No cambies reglas de aceptación o permisos para que un test pase. Los comandos de agentes y checks son arrays sin shell.

## Revisión

Un PR debe explicar el problema, el resultado y cómo se comprobó. Cambios a persistencia, cancelación, entrega o evolución deben cubrir recuperación y protección de cambios ajenos. Mantén los archivos personales y los artefactos fuera de Git. Las contribuciones de código propio se reciben bajo MIT, conservando los avisos de terceros cuando correspondan.

Los cambios de diseño deben mantener la interfaz sencilla, en español, utilizable con teclado y en distintos tamaños de ventana. No hace falta una cuenta de pago para contribuir a las pruebas simuladas.
