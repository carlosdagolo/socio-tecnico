import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 10 },
    view: {},
  },
} as const

const measure = (percent: number) => ({
  context: { window: 200000, tokens: percent * 2000, percent },
  rateLimits: [{ kind: 'seven_day', percentUsed: 31, resetsAt: '2026-10-16T19:00:00Z' }],
  changed: ['context' as const, 'rateLimits' as const],
})

test('band shows context, weekly limit and toasts once past 85%', async ($, on) => {
  mock.store(on)
  on('session.measure', async (_$, e) => ({ changed: e.changed }))
  const toasts: string[] = []
  on('ui.toast', async (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })

  await $.session.measure(measure(80))
  expect(toasts).toHaveLength(0)
  await $.session.measure(measure(90))
  await $.session.measure(measure(92))
  expect(toasts).toHaveLength(1)
  expect(toasts[0]).toContain('90 %')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'socio-tecnico', surface, ...BAND })
    expect((await ui.find({ type: 'Text', text: /^ctx/ }))?.text).toBe('ctx 92%')
    expect((await ui.find({ type: 'Text', text: /sem/ }))?.text).toMatch(/sem 31% ↻ \S+ \d\d:\d\d/)
    await ui.unmount()
  }
})

const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

test('band shows branch, last test run and CI after a turn', async ($, on) => {
  mock.store(on)
  mock.clock(on)
  mock.env(on, { TEMP: 'C:/Temp' })
  const argvs: string[][] = []
  on('process.run', async (_$, e) => {
    argvs.push([...e.argv])
    if (e.argv[0] === 'git') return ok('feat/socio\n')
    return ok('[{"status":"completed","conclusion":"failure","workflowName":"ci"}]')
  })
  on('tool.call', { tool: 'Bash' }, async () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  on('fs.read', async () => ({ value: 'Passed!  - Failed:     0, Passed:   12, Skipped:     1, Total:    13, Duration: 3 s - X.dll' }))
  on('turn.complete', async (_$, e) => ({ text: e.answer }))

  await $.tool.call({ tool: 'Bash', command: 'dotnet test --filter Sales' })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', text: 'ok' })

  expect(argvs).toContainEqual(['gh', 'run', 'list', '--branch', 'feat/socio', '--limit', '1', '--json', 'status,conclusion,workflowName'])
  const ui = await $.ui.mount({ plugin: 'socio-tecnico', surface: 'terminal', ...BAND })
  const rest = (await ui.find({ type: 'Text', text: /tests/ }))?.text
  expect(rest).toContain('⎇ feat/socio')
  expect(rest).toContain('tests ✓ 12/0/1')
  expect(rest).toContain('CI ✗ failure')
  await ui.unmount()
})

test('band hides CI when gh is missing', async ($, on) => {
  mock.store(on)
  on('process.run', async (_$, e) => {
    if (e.argv[0] === 'git') return ok('dev\n')
    throw new Error('spawn gh ENOENT')
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))

  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', text: 'ok' })

  const ui = await $.ui.mount({ plugin: 'socio-tecnico', surface: 'terminal', ...BAND })
  const rest = (await ui.find({ type: 'Text', text: /⎇/ }))?.text
  expect(rest).toContain('⎇ dev')
  expect(rest).not.toContain('CI')
  await ui.unmount()
})
