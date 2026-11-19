import { describe, expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

type On = Parameters<TestBody>[1]

// El carril a través del hook de Bash y PowerShell, con el sistema simulado: cmd (mkdir, rmdir, move), PowerShell
// (quién soy, si un PID vive, pausas), dotnet build-server y $.fs sobre un disco en memoria.
const LOCALAPPDATA = 'C:\\Users\\x\\AppData\\Local'
const LOCK = `${LOCALAPPDATA}\\socio-tecnico\\carril\\turno`

function fakeWindows(on: On, options: { mkdirFails?: boolean } = {}) {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const log: string[] = []
  const toasts: string[] = []
  const done = (stdout = '', exitCode = 0) => ({
    value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  })

  on('process.run', async (_$, e) => {
    const argv = e.argv as readonly string[]
    if (argv[0] === 'cmd') {
      const [verb, ...args] = argv.slice(3)
      log.push(`${verb} ${args.join(' ')}`)
      if (verb === 'mkdir') {
        if (options.mkdirFails || dirs.has(args[0]!)) return done('', 1)
        dirs.add(args[0]!)
        return done()
      }
      if (verb === 'rmdir') {
        const dir = args[2]!
        dirs.delete(dir)
        for (const f of [...files.keys()]) if (f.startsWith(`${dir}\\`)) files.delete(f)
        return done()
      }
      return done('', 1)
    }
    if (argv[0] === 'dotnet') {
      log.push(`dotnet ${argv.slice(1).join(' ')}`)
      return done()
    }
    const script = argv[argv.length - 1]!
    if (script.includes('ParentProcessId')) return done('4242 133000000000000000\r\n')
    if (script.includes('Get-Process -Id')) return done('')
    if (script.startsWith('Start-Sleep')) return done()
    return done('', 1)
  })
  on('fs.exists', async (_$, e) => ({ value: dirs.has(e.path) || files.has(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    log.push(`write ${e.path.split('\\').pop()}`)
    return { value: undefined }
  })
  on('fs.stat', async () => ({ value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }))
  on('ui.toast', async (_$, e) => {
    toasts.push(JSON.stringify(e))
    return { value: undefined }
  })
  on('ui.status', async () => ({ value: undefined }))
  return { log, dirs, toasts }
}

describe('carril pesado en el hook', () => {
  test('takes the turn before a heavy command and lets go after it, also when it fails', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 10, 19, 12) })
    mock.store(on)
    mock.env(on, { LOCALAPPDATA })
    const { log, dirs } = fakeWindows(on)
    on('tool.call', { tool: 'Bash' }, async () => {
      log.push('jest corre')
      expect(dirs.has(LOCK)).toBe(true)
      return { isError: true, result: 'Exit code 1', text: 'Exit code 1\nTests: 1 failed' }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'cd app && npx jest' })

    expect(r.isError).toBe(true)
    expect(log).toEqual([`mkdir ${LOCK}`, 'write dueno.json', 'jest corre', `rmdir /s /q ${LOCK}`])
    expect(dirs.has(LOCK)).toBe(false)
  })

  test('runs dotnet build-server shutdown after a dotnet command, before letting go', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 10, 19, 12) })
    mock.store(on)
    mock.env(on, { LOCALAPPDATA })
    const { log } = fakeWindows(on)
    on('tool.call', { tool: 'PowerShell' }, async () => {
      log.push('build corre')
      return { result: { stdout: 'Build succeeded.', stderr: '', interrupted: false } }
    })

    await $.tool.call({ tool: 'PowerShell', command: 'dotnet build BarberShop.sln' })

    expect(log.slice(2)).toEqual(['build corre', 'dotnet build-server shutdown', `rmdir /s /q ${LOCK}`])
  })

  test('denies a heavy command in the background', async ($, on) => {
    mock.env(on, { LOCALAPPDATA })
    let hasRun = false
    on('tool.call', { tool: 'Bash' }, async () => {
      hasRun = true
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'dotnet test BarberShop.sln', run_in_background: true })

    expect(hasRun).toBe(false)
    expect(r.deny).toContain('segundo plano')
  })

  test('leaves light commands alone (no turn taken)', async ($, on) => {
    mock.env(on, { LOCALAPPDATA })
    const { log } = fakeWindows(on)
    on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))

    await $.tool.call({ tool: 'Bash', command: 'gh issue create --body "turno (dotnet test, jest)"' })

    expect(log).toEqual([])
  })

  test('runs the command without a turn (and says so) when the turn folder cannot be created', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 10, 19, 12) })
    mock.store(on)
    mock.env(on, { LOCALAPPDATA })
    const { toasts } = fakeWindows(on, { mkdirFails: true })
    let hasRun = false
    on('tool.call', { tool: 'Bash' }, async () => {
      hasRun = true
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    const r = await $.tool.call({ tool: 'Bash', command: 'npx jest' })

    expect(r.deny).toBeUndefined()
    expect(hasRun).toBe(true)
    expect(toasts.join()).toContain('corre sin turno')
  })

  test('warns once when LOCALAPPDATA is missing and runs without a turn', async ($, on) => {
    mock.clock(on, { now: Date.UTC(2026, 10, 19, 12) })
    mock.store(on)
    mock.env(on, {})
    const { toasts } = fakeWindows(on)
    let runs = 0
    on('tool.call', { tool: 'Bash' }, async () => {
      runs++
      return { result: { stdout: 'ok', stderr: '', interrupted: false } }
    })

    await $.tool.call({ tool: 'Bash', command: 'npx jest' })
    await $.tool.call({ tool: 'Bash', command: 'npx jest' })

    expect(runs).toBe(2)
    expect(toasts.filter(t => t.includes('LOCALAPPDATA'))).toHaveLength(1)
  })
})
