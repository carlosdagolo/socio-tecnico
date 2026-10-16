# Socio técnico: un modelo de trabajo para Claude Code

Una skill de Claude Code que convierte a Claude en un socio técnico que trabaja con evidencia, en vez de un asistente que dice "listo" sin haberlo probado.

Salió de construir un SaaS real con Claude Code: cientos de tests, CI en cada rama y decisiones registradas desde el día uno.

## Qué aporta

| Problema común | Cómo lo resuelve |
|---|---|
| Claude dice "arreglado" y no lo está | Evidencia obligatoria: comando, resultado real y hash. Todo arreglo trae un test en rojo sin el arreglo y en verde con él. |
| Cada sesión empieza de cero | `docs/ESTADO_MVP.md` guarda el siguiente paso, las últimas 5 sesiones y todas las decisiones numeradas. Claude lo lee al iniciar. |
| Cambios grandes sin pensar | PLAN antes de código. Los módulos grandes incluyen lo irreversible, una alternativa simple, un pre-mortem y entregas pequeñas. |
| Romper main | Ramas feat/fix/chore desde dev, CI en GitHub Actions, merge solo con CI verde y tu OK. Un hook bloquea commits en main. |
| Gastar minutos y tokens | Tests afectados en local; la suite completa la corre la CI. Buscar código con grep, no con lecturas masivas. |
| Respuestas largas que no puedes seguir | Modo breve: máximo dos pasos por mensaje, instrucción exacta y una línea de explicación. |
| Un Claude que te da la razón | Rol de socio: cuestiona, propone una alternativa y recomienda una. Separa "indispensable ahora / después / no aporta". |

## Cómo funciona

Dos Claude con papeles distintos:

1. **Claude Code** (en tu PC, sobre el repo): planea, implementa, prueba y deja evidencia. Lo gobierna `CLAUDE.md`.
2. **Claude en un proyecto de claude.ai** (opcional): piensa contigo producto y prioridades, y revisa los PLAN y resultados de Claude Code. Lo gobierna `templates/instrucciones-proyecto.md`.

Es un plugin de Claude Code con dos partes:

**1. La skill** (tres modos):

- `/socio-tecnico:socio-tecnico setup`: una vez por repo. Crea `CLAUDE.md`, `docs/ESTADO_MVP.md`, los permisos de `.claude/settings.json`, la CI, el candado de main y (opcional) `.graphifyignore`. Nunca sobrescribe lo que ya tienes sin preguntar.
- `/socio-tecnico:socio-tecnico inicio`: al abrir cada sesión. Resume en 3 líneas dónde quedaste, qué sigue y qué está sin commit o en rojo.
- `/socio-tecnico:socio-tecnico cierre`: al terminar una unidad de trabajo. Reúne la evidencia (tests, CI con enlace, `git status`) y actualiza el registro.

**2. Las alertas y el guardián** (hooks que corren solos):

- **Aviso sonoro** cuando Claude termina, te pide permiso o te hace una pregunta. Se repite cada 2 minutos, hasta 10 veces, mientras no respondas. `/silencio` lo apaga o lo enciende. En Windows suena con PowerShell.
- **Franja sobre el prompt:** contexto usado, límite semanal, rama actual, último test y estado de la CI de la rama (con `gh`). Avisa cuando el contexto pasa del 85 %.
- **Resumen de `dotnet test`:** la salida completa va a un log en %TEMP% y Claude ve solo el resumen y los fallos (menos tokens).
- **Guardián:** bloquea leer `.env`, `secrets.json` y `appsettings.Development.json`, `dotnet ef database update`, `git reset --hard`, `--no-verify`, borrar ramas, y commits o push a main. Es de mejor esfuerzo: un comando ofuscado puede escapar, por eso los permisos de `settings.json` son la segunda capa.

El resumen de tests y parte del guardián están pensados para .NET. El resto sirve para cualquier stack.

Ciclo de cada cambio:

```
PLAN -> OK tuyo -> rama feat/ desde dev -> código + tests afectados
     -> push -> CI (gh run watch) -> registro de sesión -> OK tuyo -> merge a dev
     -> tú integras dev -> main
```

## Instalación (Windows, PowerShell)

Requisitos: Git, GitHub CLI y Claude Code.

1. Instala las herramientas (si no las tienes):
   ```powershell
   winget install --id Git.Git -e
   winget install --id GitHub.cli -e
   irm https://claude.ai/install.ps1 | iex
   gh auth login
   ```
2. Instala el plugin. Abre una terminal, corre `claude` y escribe:
   ```
   /plugin install socio-tecnico --marketplace carlosdagolo/claude-socio-tecnico
   ```
   Responde `y` para agregar el marketplace y elige el alcance de usuario (Enter). Desde una terminal normal también sirve:
   ```powershell
   claude plugin install socio-tecnico --marketplace carlosdagolo/claude-socio-tecnico
   ```
   En la app de escritorio: + junto al cuadro del prompt → Plugins → Add marketplace (`carlosdagolo/claude-socio-tecnico`) → Add plugin.
3. Abre Claude Code en tu repo y escribe `/socio-tecnico:socio-tecnico setup`. Responde sus preguntas (producto, stack, comandos).
4. Lo que haces tú en GitHub (Claude no toca permisos ni configuración de tu cuenta):
   - **Proteger main:** Settings → Rules → Rulesets → New branch ruleset → objetivo `main` → "Require a pull request" y "Require status checks to pass" (elige el job `build-and-test`). En repos privados depende de tu plan de GitHub.
   - **Alertas de CI por correo:** github.com → Settings → Notifications → Actions → "Only notify for failed workflows".
5. (Opcional) Crea un proyecto en claude.ai y pega `skills/socio-tecnico/templates/instrucciones-proyecto.md` en sus instrucciones.

Desde ahí, empieza cada sesión con `/socio-tecnico:socio-tecnico inicio`.

Para desarrollar el plugin: `claude plugin validate .` y `claude plugin test .` (32 tests).

## Graphify (opcional)

Si usas [graphify](https://pypi.org/project/graphifyy/) para tener un grafo del código, esto fue lo que medimos en un repo de unos 300 archivos C#:

- `graphify update .` tarda unos 20 s y no gasta API, pero el grafo envejece con cada commit. Hay que actualizarlo justo antes de consultarlo, no una vez al día.
- `graphify explain` y `graphify path` sirven para ver la forma de una clase y el impacto entre módulos.
- `graphify query` en texto libre devolvió entre 6 y 40 veces más texto que grep y a veces no encontró la respuesta.
- Con `.graphifyignore` (migraciones y tests fuera) el grafo bajó cerca de un tercio de nodos, pero `query` siguió con ruido.

Regla que dejamos: buscar con grep; graphify solo para impacto, actualizado antes de usarlo.

## Personaliza

Todo es texto. Edita tu `CLAUDE.md` cuando una regla no te sirva y registra el cambio como decisión en `docs/ESTADO_MVP.md`. Una regla que nadie cumple es peor que no tenerla.

## Licencia

MIT. Ver [LICENSE](LICENSE).
