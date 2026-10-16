import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { MAX_REPEATS, REPEAT_MS } from '../hooks/alert'

const TURN = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', text: 'ok' } as const
const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

// Cuenta cuántas veces suena (PowerShell en Windows) y responde lo demás.
function world(on: On, os = 'Windows_NT') {
  mock.store(on)
  mock.env(on, { OS: os, TEMP: 'C:/Temp' })
  const clock = mock.clock(on)
  const rings = { count: 0, argv: [] as string[], assets: [] as string[] }
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'powershell') {
      rings.count += 1
      rings.argv = [...e.argv]
      return ok('')
    }
    return e.argv[0] === 'git' ? ok('dev\n') : { deny: 'gh no instalado' }
  })
  on('audio.play', async (_$, e) => {
    rings.count += 1
    if ('asset' in e.clip) rings.assets.push(String(e.clip.asset))
    return { value: undefined }
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('prompt.edit', async (_$, e) => ({ text: e.text, cursor: e.cursor }))
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('classic.PermissionRequest', async () => ({}))
  return { clock, rings }
}

const settle = () => new Promise(r => setTimeout(r, 20))

describe('sound alert', () => {
  test('rings when the turn ends and repeats every 2 minutes, at most 10 times', async ($, on) => {
    const { clock, rings } = world(on)

    await $.turn.complete(TURN)
    await settle()
    expect(rings.count).toBe(1)
    expect(rings.argv.join(' ')).toContain('Media.SoundPlayer')
    expect(rings.argv.join(' ')).toContain('sounds/ping.wav')

    await clock.advance(REPEAT_MS - 1)
    await settle()
    expect(rings.count).toBe(1)
    await clock.advance(1)
    await settle()
    expect(rings.count).toBe(2)

    for (let i = 0; i < MAX_REPEATS + 5; i++) await clock.advance(REPEAT_MS)
    await settle()
    expect(rings.count).toBe(1 + MAX_REPEATS)
  })

  test('stops as soon as the person types or submits', async ($, on) => {
    const { clock, rings } = world(on)

    await $.turn.complete(TURN)
    await $.prompt.edit({ origin: { kind: 'composer' }, text: '', cursor: 0, start: 0, end: 0, inputText: 'h' })
    await clock.advance(REPEAT_MS * 3)
    await settle()
    expect(rings.count).toBe(1)

    await $.turn.complete(TURN)
    await $.prompt.submit({ text: 'hola' })
    await clock.advance(REPEAT_MS * 3)
    await settle()
    expect(rings.count).toBe(2)
  })

  test('rings on a permission request and stops once it is answered', async ($, on) => {
    const { clock, rings } = world(on)

    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default' })
    await settle()
    expect(rings.count).toBe(1)

    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(REPEAT_MS * 3)
    await settle()
    expect(rings.count).toBe(1)
  })

  test('/silencio turns it off and on for the session', async ($, on) => {
    const { rings } = world(on)

    const off = await $.command.run({ command: 'silencio', args: '' })
    expect(off.text).toContain('apagado')
    await $.turn.complete(TURN)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' }, permission_mode: 'default' })
    await settle()
    expect(rings.count).toBe(0)

    const back = await $.command.run({ command: 'silencio', args: '' })
    expect(back.text).toContain('encendido')
    await $.turn.complete(TURN)
    await settle()
    expect(rings.count).toBe(1)
  })

  test('logs every attempt to TEMP so a silent alert can be diagnosed', async ($, on) => {
    world(on)
    const writes: { path: string; text: string }[] = []
    on('fs.read', async () => {
      throw new Error('ENOENT')
    })
    on('fs.write', async (_$, e) => {
      writes.push({ path: e.path, text: e.text })
      return { value: undefined }
    })

    await $.turn.complete(TURN)
    await settle()

    expect(writes).toHaveLength(1)
    expect(writes[0]?.path).toMatch(/^C:[\\/]Temp[\\/]socio-alert\.log$/)
    expect(writes[0]?.text).toMatch(/^\S+Z turn: sonó\n$/)
  })

  test('uses the bundled clip through $.audio.play off Windows', async ($, on) => {
    const { rings } = world(on, 'Darwin')

    await $.turn.complete(TURN)
    await settle()
    expect(rings.assets).toEqual(['sounds/ping.wav'])
  })
})
