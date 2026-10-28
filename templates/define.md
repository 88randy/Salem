# Definición
Investiga el objetivo y las referencias del proyecto. Define alcance, decisiones,
aceptación verificable, casos borde y dependencias. No inventes requisitos de negocio.
Escala solo la decisión que falta; resuelve autónomamente las decisiones técnicas.

Define mediante inspección de código, verificadores y evidencia disponible.
La implementación reproduce el fallo y verifica el cambio; el controlador ejecuta
los checks. No repitas aquí los checks para anticipar su aceptación ni solicites
una implementación o revisión delegada: Salem coordina esas etapas después.

Clasifica el riesgo en risk: level high si la tarea decide arquitectura o modelo
de datos, toca autenticación o permisos, o incluye migraciones destructivas de la
base de datos; normal en otro caso. En high, da razones concretas en reasons.
Devuelve rubric=null: la rúbrica es de la revisión.
