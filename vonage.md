# Configuración e Integración con Vonage SIP Trunk

Este documento describe la configuración del Trunk SIP de **Vonage** en el proyecto `avr-infra`, detallando las credenciales, flujos de llamadas y soluciones a los errores históricos más comunes para evitar regresiones en producción.

---

## 1. Arquitectura de Conexión
La integración de Vonage conecta a la PBX de Asterisk (`avr-asterisk`) con la red de telefonía pública (PSTN) para realizar y recibir llamadas externas.

* **Dominio SIP de Vonage:** `rodaivoice.sip.vonage.com`
* **Transporte utilizado:** UDP público (Puerto `5060` en Asterisk)
* **Contexto de entrada:** `[from-vonage]` (Redirige llamadas a los agentes de IA en el dialplan)
* **Contexto de salida:** `[outbound-vonage]` (Maneja el marcado hacia Vonage)

---

## 2. Configuración en `pjsip.conf`
La troncal está definida en [pjsip.conf](file:///Users/hunter/Documents/Dockers/Containers/avr-infra/asterisk/conf/pjsip.conf) en las secciones `[vonage]`.

* **Registro:** Envía solicitudes de registro periódicas a Vonage con el usuario `rgranda`.
* **Identificación (Inbound):** Asterisk identifica las llamadas entrantes que provienen de `rodaivoice.sip.vonage.com` y las asocia al endpoint `[vonage]`, dirigiéndolas al contexto `from-vonage` en el plan de marcado.

---

## 3. Problemas Históricos y Soluciones

### A. Error: `404 Not Found` en Llamadas Salientes
* **Síntoma:** Al intentar realizar una llamada saliente a través del bot, Vonage respondía inmediatamente con un error `404 Not Found` y la llamada se caía.
* **Causa:** El Dialplan de Asterisk en `extensions.conf` estaba recortando el signo `+` de los números telefónicos antes de pasarlos a la directiva `Dial`. Vonage requiere estrictamente el formato internacional **E.164** completo (ej. `+525593178271`).
* **Solución:** Se corrigió en [extensions.conf](file:///Users/hunter/Documents/Dockers/Containers/avr-infra/asterisk/conf/extensions.conf) para asegurar que el patrón reconozca el signo `+` y pase el número intacto:
  ```ini
  [outbound-vonage]
  exten => _X.,1,Set(OUTBOUND_REQ=${EXTEN})
   same => n,Goto(outbound-vonage-process,s,1)

  exten => _+X.,1,Set(OUTBOUND_REQ=${EXTEN})
   same => n,Goto(outbound-vonage-process,s,1)
  ```

### B. Error: `488 Not Acceptable Here` (IP Nula en SDP)
* **Síntoma:** Las llamadas conectaban, pero fallaban inmediatamente con código SIP `488` debido a fallas de códec o IPs de audio incorrectas.
* **Causa:** Había un error tipográfico (typo) en la dirección pública externa dentro de `pjsip.conf` (`sip.asterix.rodaia.com` con **x** en lugar de `sip.asterisk.rodaia.com` con **k**). Esto impedía que Asterisk resolviera el DNS público y hacía que enviara un valor vacío (`0.0.0.0` o nulo) en el campo del SDP de audio (`c=IN IP4`).
* **Solución:** Se corrigieron todas las referencias al dominio público en `pjsip.conf` a la dirección correcta: `sip.asterisk.rodaia.com`.

### C. Conflicto de Transports y Puerto de Señalización
* **Síntoma:** El registro con Vonage fallaba o las llamadas se cortaban tras unos segundos por falta de respuesta SIP/RTP.
* **Causa:** En la plantilla de configuración base `[endpoint-template]` estaba forzado de forma rígida el parámetro `transport=transport-udp`. Esto obligaba a todos los endpoints que heredaban de la plantilla a conectarse solo por ese puerto, interfiriendo con el transporte exclusivo de Tailscale (`transport-udp-tailscale` en el puerto `5066`).
* **Solución:** Se eliminó la asignación de `transport` de la plantilla base `[endpoint-template]`. Ahora:
  * **Vonage** negocia a través del puerto SIP estándar `5060` (UDP público).
  * **Tailscale** negocia a través del puerto SIP exclusivo `5066` (UDP VPN privada).

---

## 4. Mantenimiento y Buenas Prácticas
* **Código de País:** Asegúrate de que tu API de backend (`agent-api`) siempre envíe el prefijo telefónico con el símbolo `+` al solicitar llamadas salientes.
* **Depuración SIP de Vonage:** Para ver los mensajes SIP entrantes y salientes en tiempo real de Vonage, ejecuta en la consola de Asterisk:
  ```bash
  asterisk -rx "pjsip set logger on"
  ```
