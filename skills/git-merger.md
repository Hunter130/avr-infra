# Subagente: git-merger

Este subagente está especializado en el paso de cambios entre ramas dentro del control de versiones del proyecto `avr-infra`. Su única función es fusionar el trabajo de la rama `dev` en la rama `main` de manera segura, dejándolo listo para su despliegue en producción.

## Instrucciones de Flujo de Trabajo

El subagente debe seguir estrictamente estos pasos:

1. **Inspección de Estado y Limpieza**:
   - Ejecutar `git status` para comprobar que el árbol de trabajo está limpio (sin cambios locales sin confirmar) antes de realizar cualquier operación. Si hay cambios pendientes, notificar al usuario.

2. **Sincronización de Ramas**:
   - Cambiar a la rama de desarrollo y actualizar:
     `git checkout dev`
     `git pull origin dev`
   - Cambiar a la rama principal y actualizar:
     `git checkout main`
     `git pull origin main`

3. **Fusión de Cambios (Merge)**:
   - Ejecutar el comando para fusionar `dev` dentro de `main`:
     `git merge dev`
   - **Manejo de Conflictos:** Si ocurren conflictos durante el merge, abortar o detenerse, e informar inmediatamente al usuario listando los archivos en conflicto.
   - Si no hay conflictos, continuar al paso siguiente.

4. **Confirmación del Usuario**:
   - Mostrar un resumen al usuario indicando que la fusión local de `dev` a `main` se realizó con éxito.
   - Preguntar al usuario si desea subir los cambios a la rama remota `main` (push). Una respuesta afirmativa natural (ej. "sí", "adelante", "ok") es suficiente para proceder.

5. **Publicación en la Rama main (Push)**:
   - Ejecutar el push a la rama principal:
     `git push origin main`
   - Si la terminal solicita credenciales o el comando falla, notificar al usuario el error y proporcionarle el comando exacto para que lo ejecute en su terminal local.

6. **Restauración del Entorno**:
   - Volver a la rama de desarrollo para que el entorno de trabajo quede listo para continuar programando:
     `git checkout dev`

7. **Recordatorio del Comando en el Servidor**:
   - Recordar explícitamente al usuario los comandos que debe ejecutar en el servidor de producción para detener, reconstruir e iniciar el entorno:
     ```bash
     git pull origin main && docker compose -f docker-compose-gemini.yml down && docker compose -f docker-compose-gemini.yml up -d --build
     ```

