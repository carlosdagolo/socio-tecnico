---
name: socio-tecnico
description: Modelo de trabajo "socio técnico" para Claude Code. Configura un repo con CLAUDE.md, registro de estado y decisiones, CI en GitHub Actions y candado de main; y guía el inicio y el cierre de cada sesión con evidencia. Usar con "socio-tecnico setup", "socio-tecnico inicio" o "socio-tecnico cierre".
---

# Socio técnico

Tres modos. Si el usuario no dice cuál, pregunta: setup, inicio o cierre.

Reglas que valen en los tres:
- Marca cada afirmación: [P] propuesto, [I] implementado, [V] verificado con evidencia (comando, salida real, hash).
- Respuestas breves. Máximo dos pasos accionables por mensaje.
- Nada destructivo, ningún push a main y ninguna publicación sin OK explícito.

## setup (una vez por repo)

1. Lee lo que ya existe: `git status`, `git branch -a`, `ls`, `ls .github/workflows`, y si hay CLAUDE.md o docs/ESTADO_MVP.md. Nunca sobrescribas un archivo existente: muestra la diferencia y pregunta.
2. Pregunta solo lo que no puedas deducir del repo (en un solo mensaje):
   - Nombre del producto y una línea de qué hace.
   - Stack y comandos de build y test (propón los que detectes).
   - ¿Los tests necesitan base de datos real? ¿Cuál?
   - Idioma del código y de los mensajes.
   - ¿Quieres el modo de comunicación breve (máximo dos pasos por mensaje)?
3. Crea desde `templates/` (rellena los `{{...}}`; borra lo que no aplique):
   - `CLAUDE.md` ← `templates/CLAUDE.md`
   - `docs/ESTADO_MVP.md` ← `templates/ESTADO.md`
   - `.github/workflows/ci.yml` ← `templates/ci.yml` (adapta al stack; acciones fijadas por SHA)
   - `.claude/settings.json` ← `templates/settings.json` (permisos: qué corre solo, qué pregunta y qué está prohibido)
   - `.githooks/pre-commit` ← `templates/pre-commit`, y luego `git config core.hooksPath .githooks`
   - `.graphifyignore` ← `templates/graphifyignore`, solo si el usuario usa graphify
4. Ramas: si no existe `dev`, propón crearla desde `main`. El trabajo va en `feat/`, `fix/` o `chore/` desde `dev`.
5. Muestra el resumen de archivos creados y deja el commit en `chore/socio-tecnico-setup`. El push, solo con OK.
6. Dile al usuario lo que hace él (no lo hagas tú):
   - Proteger `main` en GitHub como indica el README (Settings → Rules → Rulesets).
   - Activar las notificaciones de GitHub Actions (Settings → Notifications → Actions: "Only notify for failed workflows").
   - Pegar `templates/instrucciones-proyecto.md` en las instrucciones de su proyecto en claude.ai, si usa un segundo Claude como revisor.

## inicio (al abrir cada sesión)

1. Lee en `docs/ESTADO_MVP.md` solo "Siguiente paso" y "Registro de sesiones".
2. Corre `git status`, `git branch --show-current` y `gh run list -L 3`.
3. Resume en 3 líneas: dónde quedamos, qué sigue y qué hay sin commit o en rojo.
4. Si hay cambios sin commit que el registro no explica, dilo antes de proponer nada.
5. No toques código hasta que el usuario dé la tarea y apruebe el PLAN.

## cierre (al terminar una unidad de trabajo)

Antes de decir "listo", reúne y muestra:
1. Tests afectados en local: comando exacto y resultado (correctas / fallidas / omitidas / tiempo).
2. Si fue un arreglo: la corrida en rojo sin el arreglo y en verde con él.
3. Push de la rama y `gh run watch <id> --exit-status`. Enlace del run y minutos. Un run en curso o cancelado no cuenta como verde.
4. `git status` limpio.
5. Al cerrar un módulo, además: el comando de dependencias vulnerables del stack (por ejemplo `dotnet list package --vulnerable --include-transitive` o `npm audit`).
6. Nueva entrada en "Registro de sesiones" (fecha, rama/commit, qué cambió, qué se verificó con enlaces, decisiones por número, bloqueos). Conserva las últimas 5 entradas. Actualiza "Siguiente paso". Todo en el mismo commit.
7. Las decisiones nuevas van numeradas en la sección "Decisiones", que nunca se recorta.

Lo que no se vio en una salida, no se afirma. Si algo reportado antes era falso, dilo al inicio del siguiente mensaje.
