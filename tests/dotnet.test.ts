import { describe, expect, mock, test } from 'claude-code/testing'

import { isDotnetTest, parseOutput, wrapCommand } from '../hooks/dotnet'

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

  test('keeps the exit code by grouping and redirecting', () => {
    expect(wrapCommand('dotnet test', 'C:\\Temp\\a.log')).toBe('{ dotnet test\n} > "C:/Temp/a.log" 2>&1')
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
  test('writes the full output to TEMP and returns only the summary', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 9, 15, 12) })
    mock.env(on, { TEMP: 'C:\\Users\\x\\AppData\\Local\\Temp' })
    mock.store(on)
    let ranCommand = ''
    let readPath = ''
    on('tool.call', { tool: 'Bash' }, async (_$, e) => {
      ranCommand = e.command
      return { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
    })
    on('fs.read', async (_$, e) => {
      readPath = e.path
      return { value: FAILED_RUN }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test MyApp.sln' })

    expect(ranCommand).toMatch(/^\{ dotnet test MyApp\.sln\n\} > "C:\/Users\/x\/AppData\/Local\/Temp\/socio-dotnet-test-\d{8}-\d{6}\.log" 2>&1$/)
    expect(readPath).toMatch(/^C:\\Users\\x\\AppData\\Local\\Temp\\socio-dotnet-test-.*\.log$/)
    expect((r.result as { stdout: string }).stdout).toContain('311 correctas, 1 fallidas, 2 omitidas, 314 total')
    expect((r.result as { stdout: string }).stdout).toContain('exit 1')
    expect((r.result as { stdout: string }).stdout).toContain('ConfirmSale_ShouldRejectPartialPayment')
    expect((r.result as { stdout: string }).stdout).toContain(`Salida completa: ${readPath}`)
    expect((r.result as { stdout: string }).stdout).not.toContain('Determining projects')
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

  test('says where the log was when it cannot be read', async ($, on) => {
    mock.clock(on)
    mock.env(on, { TEMP: 'C:/Temp' })
    on('tool.call', { tool: 'Bash' }, async () => ({ isError: true, result: 'Exit code 1', text: 'Exit code 1' }))
    on('fs.read', async () => {
      throw new Error('ENOENT')
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test' })

    expect((r.result as { stdout: string }).stdout).toContain('no se pudo leer la salida en C:/Temp\\socio-dotnet-test-')
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
    mock.env(on, { TEMP: 'C:/Temp' })
    mock.store(on)
    let ranCommand = ''
    on('tool.call', { tool: 'PowerShell' }, async (_$, e) => {
      ranCommand = e.command
      return { isError: true, result: 'Exit code 1', text: 'Exit code 1' }
    })
    on('fs.read', async () => ({ value: '\uFEFF' + FAILED_RUN }))

    const r = await $.tool.call({ tool: 'PowerShell', command: 'dotnet test MyApp.sln' })

    expect(ranCommand).toMatch(/^& \{\ndotnet test MyApp\.sln\n\} \*>&1 \| Out-File -FilePath 'C:\/Temp\\socio-dotnet-test-\d{8}-\d{6}\.log' -Encoding utf8; exit \$LASTEXITCODE$/)
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
