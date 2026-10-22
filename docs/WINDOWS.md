# Salem en Windows

El instalador `salem-<versión>-windows-x64-Setup.exe` instala Salem para tu usuario, sin permisos de administrador. Incluye Node.js 22 y la interfaz compilada: no necesitas npm ni clonar el repositorio para abrir Salem.

Requiere Windows 10/11 x64 con .NET Framework 4.8 y Windows PowerShell 5.1. El paquete es **sin firma de código**; SmartScreen o las políticas de tu organización pueden impedir su ejecución. La firma con certificado sigue pendiente. No se ha validado Windows ARM, Windows Server ni otros navegadores/dispositivos mediante este instalador.

## Instalar y abrir

1. Obtén el instalador y su archivo `SHA256SUMS.txt` del mismo release. Comprueba el hash con `Get-FileHash -Algorithm SHA256 -LiteralPath .\salem-<versión>-windows-x64-Setup.exe`.
2. Ejecuta el instalador y confirma las carpetas. Valores predeterminados:
   - Aplicación: `%LOCALAPPDATA%\Programs\Salem`.
   - Datos: `%LOCALAPPDATA%\Salem`.
3. Abre **Salem** desde el menú Inicio. El servidor queda oculto y abre tu navegador predeterminado en `http://127.0.0.1:3210` o el puerto configurado en Ajustes.
4. Para cerrar el servidor usa **Salir de Salem** en el menú Inicio. Cerrar la pestaña del navegador conserva el servidor activo. Salir solicita el cierre y espera a los procesos propios; los trabajos interrumpidos conservan sus checkpoints y evidencia.

Salem crea también el acceso **Desinstalar Salem** en el menú Inicio. El instalador no registra servicios de Windows, tareas programadas ni inicio automático con la sesión.

Git y los proveedores Claude Code/Codex se instalan y autentican por separado para trabajar con repositorios y agentes. Sus binarios, credenciales, perfiles y memorias personales no forman parte de esta distribución. Salem muestra el estado de los proveedores desde Cuentas. Si acabas de instalar una herramienta y Salem no la detecta, cierra Salem y vuelve a abrirlo para renovar su entorno.

## Actualizar

1. Espera a que terminen los trabajos que quieras conservar en ejecución y usa **Salir de Salem**.
2. Ejecuta el instalador de la nueva versión y selecciona las mismas carpetas de instalación y de datos; si personalizaste el destino de datos inicial, indícalo otra vez.
3. La actualización verifica los checksums, añade una versión nueva y cambia el puntero de arranque. Conserva los datos, la configuración y la versión anterior en `versions\`.

Una actualización no mata procesos ni reemplaza los archivos de una versión en ejecución. Si el PID registrado sigue vivo, incluso si su identidad no puede confirmarse, la actualización se rechaza. También se comprueban procesos Node iniciados manualmente desde la instalación mediante la consulta local de procesos de Windows (CIM); si esa consulta falla, la actualización se detiene. Un puerto ocupado por otra aplicación genera un error; Salem no detiene ni reutiliza ese proceso.

No hay actualizaciones automáticas. Para volver a una versión anterior, cierra Salem y ejecuta el instalador de esa versión sobre la misma carpeta. No edites `install.json` manualmente. Conservar binarios anteriores no sustituye una copia de seguridad de datos: verifica compatibilidad del formato de datos antes de regresar a una versión antigua.

## Datos, logs y recuperación

La carpeta de instalación contiene exclusivamente versiones de la aplicación, lanzadores y recibos del proceso. El catálogo, preferencias, configuración de proyectos, checkpoints y evidencia viven en la carpeta de datos. La instalación exige que ambas carpetas estén separadas y rechaza enlaces/junctions en sus rutas.

Los cambios de carpeta y puerto se aplican en el siguiente arranque mediante los ajustes de Salem. `launch.json` en la carpeta de datos original conserva el destino seleccionado; la actualización mantiene ese punto de preferencias. No coloques los datos dentro de la instalación.

El log de arranque está en `<carpeta de datos original>\launcher-logs\salem.log`. Si el navegador no abre, consulta ese log y usa la URL local que contiene. Un registro `running.json` cuyo PID vivo no responde no se elimina automáticamente: confirma primero en el Administrador de tareas qué proceso es y que sus trabajos hayan finalizado. Salem nunca mata ese PID para desbloquear una actualización.

Antes de cambiar o reparar datos, cierra Salem y guarda una copia de la carpeta de datos completa. Este instalador no importa credenciales de otros equipos ni migra cuentas del sistema.

## Desinstalar

Usa **Salir de Salem** y después **Desinstalar Salem** en el menú Inicio. Se verifican la identidad de la instalación, su ruta absoluta y sus descendientes antes de eliminar archivos. Se rechazan junctions y procesos registrados vivos. Se eliminan únicamente esa instalación y los accesos directos que apuntan a ella. **La carpeta de datos permanece intacta**, aunque hayas elegido otro destino en Ajustes. No se borran credenciales de proveedores ni repositorios de trabajo.

También puedes ejecutar desde PowerShell:

```powershell
& "$env:LOCALAPPDATA\Programs\Salem\Uninstall.ps1"
```

## ZIP y automatización

El ZIP contiene el mismo payload verificable que el EXE. Extrae el ZIP en una carpeta temporal distinta de la instalación y ejecuta desde allí:

```powershell
.\runtime\node.exe .\windows\manager.mjs install --payload . --install-dir "$env:LOCALAPPDATA\Programs\Salem" --data-dir "$env:LOCALAPPDATA\Salem"
```

El instalador admite instalación silenciosa sin abrir el navegador:

```powershell
.\salem-<versión>-windows-x64-Setup.exe --silent --install-dir "C:\ruta\Programs\Salem" --data-dir "C:\ruta\SalemData"
```

`--shortcut-dir` permite elegir una carpeta de accesos directos para pruebas aisladas. Un fallo silencioso devuelve código distinto de cero y escribe `SalemSetup-last-error.log` en la carpeta temporal del usuario.

## Construir y verificar la distribución

Para mantenedores, desde un checkout limpio:

```powershell
npm ci
npm run build
node --test tests/windows-package.test.mjs
node scripts/package-windows.mjs --out-dir .artifacts/windows-release
```

El empaquetador **no compila la aplicación**: requiere `dist/src`, `web-dist` y el sello de `npm run build`. Ese sello fija por hash las fuentes, dependencias, configuración y salidas compiladas. Un cambio posterior invalida el build aunque conserve sus fechas de modificación. Descarga Node.js desde `https://nodejs.org/dist/`, verifica tanto el ZIP como `node.exe` contra `SHASUMS256.txt`, incluye su licencia y compila el bootstrapper con `csc.exe` de .NET Framework. El manifiesto registra revisión Git, hash de fuentes, hashes de archivos y versión de Node. Los checksums ofrecen integridad; no reemplazan una firma de editor.

El payload solo incluye JavaScript del core, interfaz estática, templates y licencias. No incluye `node_modules`, perfiles, cuentas, memorias, repositorios, `.local`, `.artifacts` ni datos de usuario. `--provisional` etiqueta paquetes de diagnóstico; no acredita que el build corresponda a las fuentes actuales. Los releases requieren build y aceptación finales coordinados.

Para ejecutar el smoke aislado del ciclo completo (build existente, puerto efímero, carpetas bajo `.artifacts`, proveedores sustituidos por un comando Node inocuo):

```powershell
$env:SALEM_WINDOWS_RUNTIME_SMOKE = '1'
node --test tests/windows-package.test.mjs
Remove-Item Env:\SALEM_WINDOWS_RUNTIME_SMOKE
```

Ese smoke verifica arranque instalado, reutilización del proceso propio, rechazo de puerto ajeno, cierre controlado, bloqueo de actualización mientras vive el servidor y desinstalación conservando datos. No acredita autenticación ni ejecución real de los proveedores.

Para aceptar un EXE construido, configura `SALEM_WINDOWS_SETUP` con su ruta y ejecuta la misma suite. `SALEM_WINDOWS_UPGRADE_SETUP` opcional recibe otro EXE y comprueba una actualización real entre ambos builds. El test usa instalación, accesos y `%TEMP%` propios bajo `.artifacts/windows-unit-tests`, conserva un archivo de datos al desinstalar y deja `evidence.json` en la carpeta de la prueba.
