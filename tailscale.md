# Configuración de Red Tailscale con Docker (Windows / WSL 2)

Este documento detalla la configuración y arquitectura necesarias para permitir la interconexión segura de clientes SIP (softphones) y servidores de Call Center externos a través de **Tailscale VPN** con la central Asterisk en Docker.

---

## 1. El Problema de Red (WSL 2 y Docker NAT)
Cuando se utiliza Docker Desktop en Windows (WSL 2), las solicitudes de red provenientes de la VPN Tailscale hacia el puerto `5066` son mapeadas por el gateway virtual de Docker (`172.20.0.1`). 

Esto causa dos problemas críticos en la negociación de audio (RTP):
1. **Detección de Subred Local (SDP Incorrecto):** Asterisk ve que el origen de la señalización es `172.20.0.1`. Si la subred del contenedor (`172.20.0.0/24` o el bloque general `172.16.0.0/12`) está definida en `local_net` en los transportes de `pjsip.conf`, Asterisk asume que el cliente está en su misma red local (LAN) y envía en el SDP su IP interna `172.20.0.6`. El cliente externo no puede enrutar tráfico a esa IP privada, provocando **llamadas mudas (sin audio)**.
2. **Ignorado de `external_media_address`:** Incluso si quitamos las redes locales, la pila de red de Asterisk detecta que el gateway `172.20.0.1` está en la misma interfaz ethernet virtual que el contenedor (`172.20.0.6`), por lo que decide omitir la IP externa de transporte y sigue enviando la IP privada en el SDP.

---

## 2. La Solución Aplicada

### A. Configuración de Transportes (`pjsip.conf`)
Para forzar a Asterisk a usar la IP de Tailscale de producción (`100.83.104.96`), se eliminaron todas las subredes privadas locales de los transportes:

```ini
[transport-udp-tailscale]
type=transport
protocol=udp
bind=0.0.0.0:5066
local_net=127.0.0.1/32  ; SOLO 127.0.0.1 para forzar comportamiento externo
external_media_address=100.83.104.96
external_signaling_address=100.83.104.96
```

### B. Forzar `media_address` a Nivel de Endpoint
Para saltarnos la lógica automática de ruteo de subred de Asterisk, **se debe definir de manera explícita la dirección de media en los endpoints** que se conecten por VPN (como las extensiones de pruebas o troncales de call center):

```ini
[1000](endpoint-template)
auth=1000
aors=1000
media_address=100.83.104.96  ; Obliga al SDP a usar la IP de Tailscale del servidor

[callcenter-trunk](endpoint-template)
type=endpoint
context=from-callcenter
media_address=100.83.104.96  ; Obliga al SDP a usar la IP de Tailscale del servidor
```

*Nota: Los endpoints públicos (como la troncal de Vonage) no heredan esta propiedad y siguen negociando con su IP/dominio público correctamente.*

---

## 3. Apertura de Firewall en Windows Host
Por defecto, Windows clasifica la interfaz virtual de Tailscale como una red **Pública** y bloquea los puertos de audio RTP entrantes de forma silenciosa.

Debes ejecutar los siguientes comandos en **PowerShell como Administrador** en el servidor Windows para abrir los puertos necesarios:

```powershell
# Permitir señalización SIP en el puerto de Tailscale
New-NetFirewallRule -DisplayName "Asterisk SIP Tailscale" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5066

# Permitir flujo de audio RTP (rango de puertos configurado en rtp.conf)
New-NetFirewallRule -DisplayName "Asterisk RTP Tailscale" -Direction Inbound -Action Allow -Protocol UDP -LocalPort 10000-10500
```

---

## 4. Mantenimiento y Cambios de IP
Si la IP de Tailscale del servidor de producción cambia en el futuro:
1. Actualiza `100.83.104.96` con la nueva IP en `pjsip.conf` (en los transportes de Tailscale y en los campos `media_address` de los endpoints correspondientes).
2. Reinicia el contenedor para recargar los transportes:
   ```bash
   docker restart avr-asterisk
   ```
