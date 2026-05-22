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

### 4. `research`
- **Rol:** Investigador de contexto (Viene por defecto).
- **Propósito:** Realizar búsquedas exhaustivas en el código base, explorar dependencias, examinar logs o buscar en la web.
- **Herramientas:** Solo lectura (explorar directorios, ver archivos, búsquedas web).
- **Cuándo invocarlo:** Cuando necesites entender una API externa, buscar un bug en los logs sin gastar contexto principal o entender cómo se conecta un servicio en particular.

## ¿Cómo trabajar con esta estructura?

1. **Mantén el hilo principal limpio:** Usa el agente principal (Antigravity) como orquestador.
2. **Delega:** Si el usuario pide un cambio complejo en el API, invoca a `api-developer`.
3. **Espera la respuesta:** El subagente realizará el trabajo en segundo plano y reportará cuando termine.
4. **Verifica:** Usa herramientas o un subagente (como `research`) para revisar que los cambios no rompan otras integraciones.

---
*Esta estructura ha sido diseñada para optimizar los tokens (context context-saving) permitiéndote avanzar más rápido en los requerimientos del proyecto de AVR.*
