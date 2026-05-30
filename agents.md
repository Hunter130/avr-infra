# Guía de Subagentes (Harness Structure)

Este documento define la estructura de delegación (Harness) basada en **Antigravity** para el proyecto `avr-infra`. El propósito de esta estructura es ahorrar tokens en el contexto principal, delegando tareas específicas y aisladas a subagentes especializados. Cada subagente tiene su propio conjunto de herramientas, roles e instrucciones de sistema.

## Subagentes Definidos

Puedes invocar a estos subagentes para resolver problemas específicos utilizando el nombre correspondiente (campo `TypeName`):

### 1. `api-developer`
- **Rol:** Especialista en Backend (Node.js, Express, Supabase).
- **Propósito:** Trabajar exclusivamente en el directorio `agent-api`. Mantiene la lógica de configuración de extensiones de Asterisk, el manejo de tokens de autenticación con Google STS y la comunicación directa con la base de datos Supabase/Firebase.
- **Herramientas:** Edición de archivos, ejecución de comandos (Node/npm), acceso a MCP servers (Firebase, Supabase).
- **Cuándo invocarlo:** Cambios en rutas, validación de schemas de base de datos, lógica de negocio del backend y autenticación.

### 2. `telephony-engineer`
- **Rol:** Especialista en Asterisk, SIP, PJSIP y Telefonía.
- **Propósito:** Configurar, debugear y mantener la integración entre la infraestructura de voz y Asterisk, operando en los directorios `asterisk` o `asterisk_dynamic`.
- **Herramientas:** Edición de archivos (PJSIP, dialplans, extensions.conf).
- **Cuándo invocarlo:** Cambios en la configuración SIP, ruteo de llamadas, problemas de conexión de Asterisk Audiosocket o registro de extensiones.

### 3. `devops`
- **Rol:** Especialista en Docker e Infraestructura.
- **Propósito:** Orquestación de contenedores y configuración de red en el proyecto `avr-infra`. Maneja todos los archivos `docker-compose-*.yml` y la gestión del entorno (`.env`).
- **Herramientas:** Edición de archivos ycomandos para interactuar con Docker y Docker Compose.
- **Cuándo invocarlo:** Agregar nuevos servicios de AI (nuevos proveedores STT/TTS), problemas de volúmenes, puertos, o variables de entorno.

### 4. `gemini-sts-developer`
- **Rol:** Especialista en Gemini Live, STS y Conectividad con Google.
- **Propósito:** Optimizar y configurar el servicio `avr-sts-gemini`, controlando la velocidad de respuesta (latencia), la calidad de la llamada, el flujo de audio en tiempo real y la configuración fina de herramientas (tools) y directivas de contexto.
- **Herramientas:** Edición de archivos (Node.js, WebSockets, esquemas JSON), pruebas de latencia y configuración de la API de Google GenAI.
- **Cuándo invocarlo:** Cambios en el conector de Gemini Live, optimización de parámetros de voz (sensibilidad, voces, thinking mode), depuración de latencia en la llamada, y modificación/creación de tools del bot de voz.
- **Instrucciones completas:** Ver detalles en [gemini-sts-developer.md](file:///Users/hunter/Documents/Dockers/Containers/avr-infra/skills/gemini-sts-developer.md).

### 5. `research`
- **Rol:** Investigador de contexto (Viene por defecto).
- **Propósito:** Realizar búsquedas exhaustivas en el código base, explorar dependencias, examinar logs o buscar en la web.
- **Herramientas:** Solo lectura (explorar directorios, ver archivos, búsquedas web).
- **Cuándo invocarlo:** Cuando necesites entender una API externa, buscar un bug en los logs sin gastar contexto principal o entender cómo se conecta un servicio en particular.

### 6. `git-developer`
- **Rol:** Especialista en Git y Control de Versiones.
- **Propósito:** Encargado exclusivo de revisar cambios (`git status` / `git diff`), realizar commits estructurados y hacer `git push` a la rama `dev`.
- **Herramientas:** Comandos de Git e inspección de estado del repositorio.
- **Cuándo invocarlo:** Al finalizar cambios en cualquier componente para subirlos de manera segura a la rama `dev`.
- **Instrucciones completas:** Ver detalles en [git-developer.md](file:///Users/hunter/Documents/Dockers/Containers/avr-infra/skills/git-developer.md).

### 7. `git-merger`
- **Rol:** Especialista en Fusión y Despliegue de Control de Versiones.
- **Propósito:** Fusionar cambios de la rama `dev` a la rama principal (`main`) y realizar el push correspondiente de manera segura.
- **Herramientas:** Comandos de Git e inspección de estado del repositorio.
- **Cuándo invocarlo:** Cuando el desarrollo en `dev` sea estable y se requiera pasar los cambios a `main` para prepararlos para producción.
- **Instrucciones completas:** Ver detalles en [git-merger.md](file:///Users/hunter/Documents/Dockers/Containers/avr-infra/skills/git-merger.md).


## ¿Cómo trabajar con esta estructura?

1. **Mantén el hilo principal limpio:** Usa el agente principal (Antigravity) como orquestador.
2. **Delega:** Si el usuario pide un cambio complejo en el API, invoca a `api-developer`.
3. **Espera la respuesta:** El subagente realizará el trabajo en segundo plano y reportará cuando termine.
4. **Verifica:** Usa herramientas o un subagente (como `research`) para revisar que los cambios no rompan otras integraciones.
5. **Sube tus cambios:** Delega al subagente `git-developer` para realizar el commit y push de tus modificaciones a la rama `dev`.
6. **Lanza a main/producción:** Delega al subagente `git-merger` para fusionar de `dev` a `main` cuando todo esté listo para producción.

---
*Esta estructura ha sido diseñada para optimizar los tokens (context context-saving) permitiéndote avanzar más rápido en los requerimientos del proyecto de AVR.*
