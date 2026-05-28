# Arquitectura de Contenedores - AVR Stack Gemini (Roda IA)

Este documento detalla el propósito, funcionamiento y aportación principal de cada uno de los 5 contenedores que componen el stack productivo de **Gemini Speech-to-Speech** (`docker-compose-gemini.yml`) en el proyecto `avr-infra`.

---

## Esquema de Interacción

```mermaid
graph TD
    Client[Softphone / Cliente SIP] <-->|SIP / RTP (Puerto 5060)| Asterisk[avr-asterisk]
    Asterisk <-->|Audiosocket (Puerto 5001)| Core[avr-core]
    Core <-->|WebSocket (Puerto 6037)| STS[avr-sts-gemini]
    STS <-->|Live API (Audio Bidireccional)| Gemini[Google Gemini Live API]
    
    API[agent-api] -->|1. Lee Agentes| Supabase[(Supabase DB)]
    API -->|2. Escribe Archivos Dinámicos| ConfVolume[(Volumen Compartido /dynamic)]
    API -->|3. Recarga| Asterisk
    
    AMI[avr-ami] <-->|AMI Protocol (Puerto 5038)| Asterisk
    STS -->|Lanza llamadas salientes| AMI
```

---

## Detalle de Contenedores

### 1. `avr-asterisk`
* **Imagen:** `agentvoiceresponse/avr-asterisk`
* **Propósito:** Es la central telefónica (PBX) basada en **Asterisk 20**. Maneja toda la señalización telefónica de entrada y salida, la configuración de canales SIP (PJSIP) y las rutas de llamadas (Dialplan).
* **Aportación Principal:** **Canal de entrada y salida de voz.** Sirve como la puerta de enlace física/virtual. Cuando un usuario marca a la central o entra una llamada desde una troncal (como Vonage), este contenedor contesta, inicia la grabación y redirige el flujo de audio en tiempo real hacia `avr-core` utilizando el protocolo de baja latencia *Audiosocket*.

---

### 2. `agent-api`
* **Construcción:** Local (`./agent-api`)
* **Propósito:** Es una API REST desarrollada en **Node.js/Express** específicamente para las necesidades de Roda IA. Se conecta de forma segura a tu base de datos de **Supabase** (tabla `agentesID_Roda_IA`).
* **Aportación Principal:** **Sincronización y automatización de la telefonía.** Cuando agregas, editas o eliminas un agente en Supabase, la API escribe dinámicamente sus configuraciones en Asterisk (`pjsip_dynamic.conf`, `extensions_dynamic.conf`, `queues_dynamic.conf`) y en el entorno de Gemini (`agents.env`). Posteriormente, se conecta al socket de Docker del host para ordenar a Asterisk que recargue su plan de marcado de manera inmediata sin interrumpir el servicio.

---

### 3. `avr-core`
* **Imagen:** `agentvoiceresponse/avr-core`
* **Propósito:** Es el enrutador de audio bidireccional. Escucha en el puerto `5001` las conexiones de audio crudo (RAW Audio) provenientes de la central telefónica y las redirige hacia el bot de voz.
* **Aportación Principal:** **Puente de audio de ultra baja latencia.** Actúa como el intérprete entre los formatos de audio tradicionales de la telefonía (muestreo a 8kHz o 16kHz en PCM lineal) y las necesidades de los sockets de la Inteligencia Artificial. Esto abstrae la complejidad de decodificar y empaquetar flujos de audio en vivo.

---

### 4. `avr-sts-gemini`
* **Construcción:** Local (`./avr-sts-gemini`)
* **Propósito:** Es el cerebro del bot de Inteligencia Artificial. Establece una sesión WebSocket en tiempo real con la **Gemini Live API** de Google AI Studio, enviando el audio del cliente y recibiendo el audio sintetizado de la IA de regreso.
* **Aportación Principal:** **Inteligencia conversacional y voz en tiempo real.** Gestiona la lógica del diálogo del agente cargando las instrucciones del prompt, maneja el control de interrupción de voz del usuario (VAD/Barge-in), y se encarga del análisis post-llamada (enviando métricas y resúmenes a webhooks de N8N o procesándolos a través de APIs de Deepseek).

---

### 5. `avr-ami`
* **Imagen:** `agentvoiceresponse/avr-ami`
* **Propósito:** Es el conector del **Asterisk Manager Interface (AMI)**. Escucha todos los eventos internos de Asterisk y permite enviarle comandos de control de llamadas.
* **Aportación Principal:** **Llamadas automatizadas salientes (Outbound).** Proporciona una interfaz API HTTP para que el sistema pueda lanzar llamadas de manera automática. Cuando quieres que un agente de IA llame proactivamente a un cliente, este servicio le ordena a Asterisk abrir una llamada saliente (usando `originate`) y conectar al cliente con el flujo del bot.
