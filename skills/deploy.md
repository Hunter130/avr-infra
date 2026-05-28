# Skill: Deploy / Auto-Commit Workflow

Este skill se activa cuando el usuario utiliza la palabra clave **"deployemos"**. Automatiza el proceso de preparación y confirmación (commit) de los cambios locales en la rama `main`, garantizando siempre la revisión y aprobación explícita del usuario.

## Instrucciones del Flujo de Trabajo

Cuando el usuario escriba **"deployemos"**, el agente debe seguir estos pasos en orden:

1. **Inspeccionar el Estado de Git**:
   - Ejecutar `git status` para ver los archivos modificados, eliminados y sin seguimiento (untracked).
   - Ejecutar `git diff --stat` para obtener un resumen del volumen de cambios.

2. **Presentar los Cambios al Usuario**:
   - Mostrar al usuario la lista de archivos modificados de forma limpia y ordenada.
   - Omitir directorios independientes que contengan su propio `.git` (como `avr-sts-gemini/`) para evitar commits corruptos o conflictos, a menos que el usuario lo pida explícitamente.

3. **Proponer un Mensaje de Commit (en Español)**:
   - Analizar los cambios realizados y estructurar una propuesta de mensaje de commit en **español** que siga el formato:
     ```text
     <tipo>: <título del commit en español>

     <descripción breve de los cambios o la funcionalidad en español>
     ```
   - El `<tipo>` debe seguir el estándar de commits convencionales (ej: `feat`, `fix`, `refactor`, `docs`, `chore`).
   - Pedir al usuario que confirme esta estructura y mensaje o proporcione uno personalizado.

4. **Esperar Aprobación con la Palabra Clave**:
   - **DETENERSE** y pedirle al usuario que confirme escribiendo la palabra clave **"deployemos"**.
   - El agente **no** debe realizar ninguna acción de indexación (`git add`) ni de confirmación (`git commit`) hasta que el usuario responda explícitamente con la palabra clave **"deployemos"**.

5. **Ejecutar el Commit**:
   - Una vez aprobado, indexar los archivos correspondientes:
     `git add <archivos>`
   - Realizar el commit local:
     `git commit -m "<mensaje-aprobado>"`

6. **Instrucciones para el Push**:
   - Dado que el comando `git push` a través de HTTPS puede requerir credenciales locales interactivas (como contraseñas, llaves SSH o tokens), guiar al usuario para que ejecute:
     `git push origin main`
     en su propia terminal local para completar la subida de los cambios a GitHub.
