import { describe, expect, mock, test } from 'claude-code/testing'

import { isDotnetTest, parseOutput } from '../hooks/dotnet'

const FAILED_RUN = [
  '  Determining projects to restore...',
  '  MyApp.Tests -> C:\\repo\\bin\\MyApp.Tests.dll',
  '  Failed MyApp.Tests.Sales.ConfirmSale_ShouldRejectPartialPayment [215 ms]',
  '  Error Message:',
  '   Assert.Equal() Failure: Values differ',
  '   Expected: Confirmed',
  '   Actual:   Draft',
  '  Stack Trace:',
  '     at MyApp.Tests.Sales.ConfirmSale_ShouldRejectPartialPayment() in C:\\repo\\SalesTests.cs:line 42',
  '',
  'Failed!  - Failed:     1, Passed:   311, Skipped:     2, Total:   314, Duration: 1 m 12 s - MyApp.Tests.dll (net10.0)',
].join('\r\n')

const BUILD_ERROR = [
  'C:\\repo\\Sale.cs(10,5): error CS1002: ; expected [C:\\repo\\MyApp.Domain.csproj]',
  'Build FAILED.',
].join('\n')

describe('dotnet test parsing', () => {
  test('detects dotnet test commands only', () => {
    expect(isDotnetTest('dotnet test MyApp.sln --filter Sales')).toBe(true)
    expect(isDotnetTest('cd x && dotnet test')).toBe(true)
    expect(isDotnetTest('dotnet build MyApp.sln')).toBe(false)
    expect(isDotnetTest('echo "dotnet testing"')).toBe(false)
    expect(isDotnetTest('powershell -NoProfile -Command "dotnet test MyApp.sln"')).toBe(true)
    expect(isDotnetTest('& dotnet test')).toBe(true)
  })

  test('ignores commands that only mention dotnet test', () => {
    expect(isDotnetTest('grep -n "resumen de dotnet test" register.tsx')).toBe(false)
    expect(isDotnetTest('git commit -m "fix: dotnet test summary"')).toBe(false)
    expect(isDotnetTest("sed -i '/de dotnet test/d' x.ts")).toBe(false)
  })

  test('sums the summary and extracts each failure with its error', () => {
    const s = parseOutput(FAILED_RUN)
    expect(s).toMatchObject({ passed: 311, failed: 1, skipped: 2, total: 314, hasSummary: true })
    expect(s.failures).toHaveLength(1)
    expect(s.failures[0]).toContain('ConfirmSale_ShouldRejectPartialPayment')
    expect(s.failures[0]).toContain('Expected: Confirmed')
    expect(s.failures[0]).not.toContain('Stack Trace')
  })

  test('understands the Spanish output of dotnet test', () => {
    // Salida real de esta máquina (dotnet en español), proyecto desechable con 1 test fallido.
    const spanish = [
      '[xUnit.net 00:00:01.09]     xfail.UnitTest1.Fails_ShouldShowMessage [FAIL]',
      '  Con error xfail.UnitTest1.Fails_ShouldShowMessage [3 ms]',
      '  Mensaje de error:',
      '   Assert.Equal() Failure: Strings differ',
      'Expected: "Confirmed"',
      'Actual:   "Draft"',
      '  Seguimiento de la pila:',
      '     at xfail.UnitTest1.Fails_ShouldShowMessage() in C:\\x\\UnitTest1.cs:line 5',
      'Con error! - Con error:     1, Superado:     1, Omitido:     0, Total:     2, Duración: 219 ms - xfail.dll (net10.0)',
      'Correctas! - Con error:     0, Superado:     5, Omitido:     0, Total:     5, Duración: 11 s - MyApp.Tests.dll (net10.0)',
    ].join('\r\n')

    const s = parseOutput(spanish)

    expect(s).toMatchObject({ passed: 6, failed: 1, skipped: 0, total: 7, hasSummary: true })
    expect(s.failures).toHaveLength(1)
    expect(s.failures[0]).toContain('Fails_ShouldShowMessage')
    expect(s.failures[0]).toContain('Expected: "Confirmed"')
    expect(s.failures[0]).not.toContain('Seguimiento')
  })

  test('lists failed theory cases whose names carry parameters', () => {
    // Salida real de ApiErrorHandlingTests en Release (2026-10-15).
    const theory = [
      '  Con error MyApp.Tests.Api.ApiErrorHandlingTests.CoreException_ShouldReturnProblemDetails_WithItsMessage(probe: "domain-invalid-operation", expected: Conflict) [962 ms]',
      '  Mensaje de error:',
      '   Assert.Equal() Failure: Values differ',
      'Expected: Conflict',
      'Actual:   InternalServerError',
      '  Seguimiento de la pila:',
      '  Failed MyApp.Tests.X.Y(a: 1, b: "two words") [5 ms]',
      '  Error Message:',
      '   boom',
      'Con error! - Con error:     2, Superado:     6, Omitido:     0, Total:     8, Duración: 1 s - MyApp.Tests.dll (net10.0)',
    ].join('\r\n')

    const s = parseOutput(theory)

    expect(s.failures).toHaveLength(2)
    expect(s.failures[0]).toContain('WithItsMessage(probe: "domain-invalid-operation", expected: Conflict)')
    expect(s.failures[0]).toContain('Actual:   InternalServerError')
    expect(s.failures[1]).toContain('Y(a: 1, b: "two words")')
    expect(s.failures[1]).toContain('boom')
  })

  test('lists a failure whose duration is under a millisecond', () => {
    // Línea real de la CI (run 38794782455).
    const s = parseOutput('  Failed MyApp.Tests.CiCanaryTests.CiCanary_ShouldFailOnPurpose [< 1 ms]\n  Error Message:\n   Fallo a propósito')
    expect(s.failures).toHaveLength(1)
    expect(s.failures[0]).toContain('CiCanary_ShouldFailOnPurpose')
  })

  test('reports compile errors when there is no summary', () => {
    const s = parseOutput(BUILD_ERROR)
    expect(s.hasSummary).toBe(false)
    expect(s.tail.join('\n')).toContain('error CS1002')
  })
})

describe('Bash hook', () => {
  test('runs the original command and summarizes its stdout', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
    mock.store(on)
    let ranCommand = ''
    on('tool.call', { tool: 'Bash' }, async (_$, e) => {
      ranCommand = e.command
      return { result: { stdout: FAILED_RUN, stderr: '', interrupted: false } }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test MyApp.sln' })

    // Sin reescribir: el modo automático revisa exactamente lo que corre.
    expect(ranCommand).toBe('dotnet test MyApp.sln')
    const stdout = (r.result as { stdout: string }).stdout
    expect(stdout).toContain('311 correctas, 1 fallidas, 2 omitidas, 314 total')
    expect(stdout).toContain('ConfirmSale_ShouldRejectPartialPayment')
    expect(stdout).not.toContain('Determining projects')
  })

  test('summarizes the text of a failed run and keeps its exit code', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: `Exit code 1\n${FAILED_RUN}` }))

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test MyApp.sln' })

    const stdout = (r.result as { stdout: string }).stdout
    expect(stdout).toContain('311 correctas, 1 fallidas, 2 omitidas, 314 total')
    expect(stdout).toContain('exit 1')
  })

  test('says the output was cut and invents no numbers', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    const cut = 'Exit code 1\n  Determining projects to restore...\n\n... [20012 characters truncated] ...\n\nlinea 641 xxxx'
    on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: cut, text: cut }))

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test MyApp.sln' })

    const stdout = (r.result as { stdout: string }).stdout
    expect(stdout).toContain('salida recortada')
    expect(stdout).not.toContain('correctas')
    expect(stdout).not.toContain('compilación')
  })

  test('reads the persisted output when the tool saved it to a file', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    let readPath = ''
    on('tool.call', { tool: 'Bash' }, async () => ({
      result: { stdout: 'primeras lineas', stderr: '', interrupted: false, persistedOutputPath: 'C:\\r\\tool-results\\a.txt', persistedOutputSize: 70954 },
    }))
    on('fs.read', async (_$, e) => {
      readPath = e.path
      return { value: FAILED_RUN }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test MyApp.sln' })

    expect(readPath).toBe('C:\\r\\tool-results\\a.txt')
    expect((r.result as { stdout: string }).stdout).toContain('311 correctas, 1 fallidas, 2 omitidas, 314 total')
  })

  test('shows the real error when the persisted output cannot be read', async ($, on) => {
    mock.clock(on)
    mock.store(on)
    on('tool.call', { tool: 'Bash' }, async () => ({
      result: { stdout: 'primeras lineas', stderr: '', interrupted: false, persistedOutputPath: 'C:\\r\\a.txt', persistedOutputSize: 70954 },
    }))
    on('fs.read', async () => {
      throw new Error('ENOENT: no such file')
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test MyApp.sln' })

    // El motor de pruebas reemplaza el error lanzado por su propio mensaje; lo que importa es que el motivo aparezca.
    const stdout = (r.result as { stdout: string }).stdout
    expect(stdout).toMatch(/no se pudo leer la salida guardada en C:\\r\\a\.txt: \S/)
  })

  test('denies a commit while the current branch is main', async ($, on) => {
    let hasRun = false
    on('process.run', async () => ({ value: { exitCode: 0, stdout: 'main\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.call', { tool: 'Bash' }, async () => {
      hasRun = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'git add . && git commit -m "x"' })

    expect(hasRun).toBe(false)
    expect(r.deny).toContain('commit en main')
  })

  test('denies a forbidden command before it runs', async ($, on) => {
    let hasRun = false
    on('tool.call', { tool: 'Bash' }, async () => {
      hasRun = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'git push --force origin dev' })

    expect(hasRun).toBe(false)
    expect(r.deny).toBeDefined()
    expect(r.deny).toContain('push forzado')
  })

  test('denies reading secret files with Read', async ($, on) => {
    let hasRun = false
    on('tool.call', { tool: 'Read' }, async () => {
      hasRun = true
      return { result: 'x' }
    })

    const r = await $.tool.call({ tool: 'Read', file_path: 'C:\\repo\\MyApp.API\\appsettings.Development.json' })

    expect(hasRun).toBe(false)
    expect(r.deny).toBeDefined()
    expect(r.deny).toContain('prohibido')
  })
})

describe('PowerShell hook', () => {
  test('summarizes a dotnet test run through PowerShell too', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
    mock.store(on)
    let ranCommand = ''
    on('tool.call', { tool: 'PowerShell' }, async (_$, e) => {
      ranCommand = e.command
      return { isError: true, result: 'Exit code 1', text: `Exit code 1\n${FAILED_RUN}` }
    })

    const r = await $.tool.call({ tool: 'PowerShell', command: 'dotnet test MyApp.sln' })

    expect(ranCommand).toBe('dotnet test MyApp.sln')
    const stdout = (r.result as { stdout: string }).stdout
    expect(stdout).toContain('311 correctas, 1 fallidas, 2 omitidas, 314 total')
    expect(stdout).toContain('exit 1')
    expect(stdout).toContain('ConfirmSale_ShouldRejectPartialPayment')
    expect(stdout).not.toContain('Determining projects')
  })

  test('blocks forbidden commands in PowerShell', async ($, on) => {
    let hasRun = false
    on('tool.call', { tool: 'PowerShell' }, async () => {
      hasRun = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const r = await $.tool.call({ tool: 'PowerShell', command: 'git push --force --dry-run origin dev' })

    expect(hasRun).toBe(false)
    expect(r.deny).toContain('push forzado')
  })

  test('leaves other PowerShell commands untouched', async ($, on) => {
    let ranCommand = ''
    on('tool.call', { tool: 'PowerShell' }, async (_$, e) => {
      ranCommand = e.command
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    await $.tool.call({ tool: 'PowerShell', command: 'dotnet build MyApp.sln' })

    expect(ranCommand).toBe('dotnet build MyApp.sln')
  })
})
