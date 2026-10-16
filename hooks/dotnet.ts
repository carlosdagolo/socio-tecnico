import type { TestRun } from '../types'

// Solo cuando dotnet es el comando (inicio, tras ; && || | ( o comillas de -Command), no cuando se menciona en un texto.
export const isDotnetTest = (command: string) => /(^|[;&|(\n"'])\s*(&\s*)?dotnet(\.exe)?\s+test\b/.test(command)

// Agrupa el comando y manda toda su salida al archivo; conserva el código de salida.
export const wrapCommand = (command: string, logPath: string) =>
  `{ ${command}\n} > "${logPath.replace(/\\/g, '/')}" 2>&1`

// PowerShell: todos los flujos al archivo en UTF-8 (">" en Windows PowerShell 5.1 escribe UTF-16).
export const wrapPowerShell = (command: string, logPath: string) =>
  `& {\n${command}\n} *>&1 | Out-File -FilePath '${logPath.replace(/'/g, "''")}' -Encoding utf8; exit $LASTEXITCODE`

type Summary = Omit<TestRun, 'seconds' | 'exitCode' | 'logPath'> & { failures: string[]; tail: string[] }

// VSTest en cualquier idioma: "Passed! - Failed: 0, Passed: 5, Skipped: 0, Total: 5" o
// "Correctas! - Con error: 0, Superado: 5, Omitido: 0, Total: 5". El orden es fijo.
const VSTEST = /!\s+-\s+[^\n,:]+:\s+(\d+),\s+[^\n,:]+:\s+(\d+),\s+[^\n,:]+:\s+(\d+),\s+Total:\s+(\d+)/g
const MODERN = /total:\s*(\d+),?\s+failed:\s*(\d+),?\s+succeeded:\s*(\d+),?\s+skipped:\s*(\d+)/gi

export function parseOutput(output: string): Summary {
  const lines = output.split(/\r?\n/)
  let passed = 0, failed = 0, skipped = 0, total = 0, hasSummary = false

  for (const m of output.matchAll(VSTEST)) {
    failed += +m[1]; passed += +m[2]; skipped += +m[3]; total += +m[4]; hasSummary = true
  }
  if (!hasSummary) {
    for (const m of output.matchAll(MODERN)) {
      total += +m[1]; failed += +m[2]; passed += +m[3]; skipped += +m[4]; hasSummary = true
    }
  }

  // Cada test fallido con las primeras líneas de su "Error Message".
  const failures: string[] = []
  for (let i = 0; i < lines.length && failures.length < 20; i++) {
    // El nombre puede llevar parámetros con espacios (teorías): termina en la duración "[3 ms]" o "(3ms)".
    const head = lines[i].match(/^\s*(?:Failed|failed|Con error)\s+(.+?)\s+(?:\[<?\s*[\d.,]+\s*\w+\]|\(<?\s*[\d.,]+\s*\w+\))\s*$/)
    if (!head) continue
    const error: string[] = []
    let j = i + 1
    if (/(Error Message|Mensaje de error):/.test(lines[j] ?? '')) j++
    for (; j < lines.length && error.length < 6; j++) {
      const l = lines[j]
      if (/^\s*(Stack Trace:|Seguimiento de la pila:|Failed |Passed |Skipped |Con error |Standard Output)/.test(l) || l.trim() === '') break
      error.push(l.trim())
    }
    failures.push(`✗ ${head[1]}${error.length ? `\n    ${error.join('\n    ')}` : ''}`)
  }

  // Sin resumen (p. ej. error de compilación): errores y final de la salida.
  const tail = hasSummary
    ? []
    : [...new Set(lines.filter(l => /\berror\s+[A-Z]{2,}\d+:/.test(l)).map(l => l.trim()))].slice(0, 10)
        .concat(lines.filter(l => l.trim()).slice(-15))

  return { passed, failed, skipped, total, hasSummary, failures, tail }
}

export function formatSeconds(seconds: number): string {
  const s = Math.round(seconds)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export function formatSummary(s: Summary, run: TestRun): string {
  const head = s.hasSummary
    ? `dotnet test: ${s.passed} correctas, ${s.failed} fallidas, ${s.skipped} omitidas, ${s.total} total · ${formatSeconds(run.seconds)} · exit ${run.exitCode}`
    : `dotnet test: sin resumen de tests (¿falló la compilación?) · ${formatSeconds(run.seconds)} · exit ${run.exitCode}`
  return [head, ...s.failures, ...s.tail, `Salida completa: ${run.logPath}`].join('\n')
}
