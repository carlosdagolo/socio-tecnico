import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionContextUsage, SessionRateLimit } from 'claude-code'

import type { CiRun, GitInfo, TestRun, Usage } from '../types'
import { checkCommand, isSecretPath } from './guard'
import { formatSeconds, formatSummary, isDotnetTest, looksCut, parseOutput } from './dotnet'
import { startAlert, stopAlert, waitReason } from './alert'

const usageAtom = atom({ plugin: 'socio-tecnico', key: 'usage' } as const, null)
const gitAtom = atom({ plugin: 'socio-tecnico', key: 'git' } as const, null)
const lastTestAtom = atom({ plugin: 'socio-tecnico', key: 'lastTest' } as const, null)
const isMutedAtom = atom({ plugin: 'socio-tecnico', key: 'isMuted' } as const, false)

const CONTEXT_WARN = 85
const STORE_LAST_TEST = 'lastTest'

function toUsage(context: SessionContextUsage, limits: readonly SessionRateLimit[]): Usage {
  const week = limits.find(l => l.kind === 'seven_day')
  return {
    contextPercent: context.percent ?? null,
    weekPercent: week?.percentUsed ?? null,
    weekResetsAt: week?.resetsAt ?? null,
  }
}

const DAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

export function formatReset(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '?'
  return `${DAYS[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function branchOf($: EngineInterface, dir: string | null): Promise<string | null> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir ? { cwd: dir } : {})
    return r.exitCode === 0 ? r.stdout.trim() : null
  } catch {
    return null
  }
}

async function latestRun($: EngineInterface, branch: string): Promise<CiRun | null> {
  try {
    const r = await $.process.run(
      ['gh', 'run', 'list', '--branch', branch, '--limit', '1', '--json', 'status,conclusion,workflowName'],
      { timeoutMs: 15000 },
    )
    if (r.exitCode !== 0) return null
    const [run] = JSON.parse(r.stdout) as { status: string; conclusion: string; workflowName: string }[]
    return run ? { status: run.status, conclusion: run.conclusion, workflow: run.workflowName } : null
  } catch {
    return null // gh no instalado, sin sesión o repo sin remoto en GitHub.
  }
}

async function refreshGit($: EngineInterface) {
  const branch = await branchOf($, null)
  const ci = branch ? await latestRun($, branch) : null
  const info: GitInfo = { branch, ci }
  await update($, gitAtom, () => info)
}

// Resume lo que devolvió la herramienta (el comando corre sin reescribir, así el modo automático lo revisa tal cual).
// Si la salida era grande, la herramienta la guardó en un archivo: se lee de ahí. Guarda el resultado para la franja.
async function summarizeRun(
  $: EngineInterface,
  ran: { isError?: true; text?: string; result?: unknown },
  startedAt: number,
): Promise<string> {
  const result = (ran.result ?? {}) as { stdout?: unknown; stderr?: unknown; persistedOutputPath?: unknown }
  const persistedPath = typeof result.persistedOutputPath === 'string' ? result.persistedOutputPath : undefined
  let output: string
  if (persistedPath) {
    try {
      output = await $.fs.read(persistedPath)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return `dotnet test: no se pudo leer la salida guardada en ${persistedPath}: ${reason}\n${ran.text ?? ''}`
    }
  } else if (ran.isError) {
    output = ran.text ?? ''
  } else {
    output = [result.stdout, result.stderr].filter((s): s is string => typeof s === 'string' && s !== '').join('\n')
  }
  const exitCode = ran.isError ? Number(/Exit code (\d+)/.exec(ran.text ?? '')?.[1] ?? 1) : 0
  const summary = parseOutput(output)
  const run: TestRun = {
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    total: summary.total,
    hasSummary: summary.hasSummary,
    seconds: ((await $.clock.now()) - startedAt) / 1000,
    exitCode,
    ...(persistedPath ? { logPath: persistedPath } : {}),
  }
  await update($, lastTestAtom, () => run)
  await $.store.set(STORE_LAST_TEST, run)
  return formatSummary(summary, run, looksCut(output))
}

function ciLabel(ci: CiRun): string {
  if (ci.status !== 'completed') return `CI … ${ci.status}`
  return `CI ${ci.conclusion === 'success' ? '✓' : '✗'} ${ci.conclusion}`
}

export const register: Register = on => {
  let hasWarned = false

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({ name: 'silencio', description: 'Apaga o enciende el aviso sonoro de espera en esta sesión.' })
    const stored = (await $.store.get(STORE_LAST_TEST)) as TestRun | undefined
    if (stored) await update($, lastTestAtom, () => stored)
    const { context, rateLimits } = await $.session.usage()
    const usage = toUsage(context, rateLimits)
    await update($, usageAtom, () => usage)
    await refreshGit($)
    $.clock.every(120000, () => void refreshGit($))
    return result
  })

  on('session.measure', async ($, e, next) => {
    const usage = toUsage(e.context, e.rateLimits)
    await update($, usageAtom, () => usage)
    const percent = usage.contextPercent ?? 0
    if (percent > CONTEXT_WARN && !hasWarned) {
      hasWarned = true
      $.ui.toast(`Contexto al ${percent} %: considera /compact o cerrar la unidad de trabajo.`)
    } else if (percent <= CONTEXT_WARN) {
      hasWarned = false
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && !e.isAborted && !(await read($, isMutedAtom))) startAlert($, 'turn')
    await refreshGit($)
    return result
  })

  // Aviso sonoro: empieza al pedir permiso o preguntar; para al escribir o responder.
  on('classic.PermissionRequest', async ($, e, next) => {
    if (!(await read($, isMutedAtom))) startAlert($, 'permission')
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.tool === 'AskUserQuestion' && !(await read($, isMutedAtom))) startAlert($, 'question')
    try {
      return await next(e)
    } finally {
      if (waitReason() === 'permission' || waitReason() === 'question') stopAlert()
    }
  }).catch(($, e, next) => next(e))

  on('prompt.edit', ($, e, next) => {
    stopAlert()
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    stopAlert()
    return next(e)
  })

  on('command.run', { command: 'silencio' }, async $ => {
    const isMuted = !(await read($, isMutedAtom))
    await update($, isMutedAtom, () => isMuted)
    if (isMuted) stopAlert()
    return { text: isMuted ? 'Aviso sonoro apagado en esta sesión.' : 'Aviso sonoro encendido.' }
  })

  // Bloqueos + resumen de dotnet test, en Bash y en PowerShell.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const reason = await checkCommand(e.command, { branchOf: dir => branchOf($, dir) })
    if (reason) return { deny: `socio-tecnico: ${reason}` }

    if (!isDotnetTest(e.command) || e.run_in_background) return next(e)

    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    return { result: { stdout: await summarizeRun($, ran, startedAt), stderr: '', interrupted: false } }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'socio-tecnico: el guardia falló; comando bloqueado por seguridad.' }))

  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const reason = await checkCommand(e.command, { branchOf: dir => branchOf($, dir) })
    if (reason) return { deny: `socio-tecnico: ${reason}` }

    if (!isDotnetTest(e.command) || e.run_in_background) return next(e)

    const startedAt = await $.clock.now()
    const ran = await next(e)
    if (ran.deny !== undefined) return ran
    return { result: { stdout: await summarizeRun($, ran, startedAt), stderr: '', interrupted: false } }
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'socio-tecnico: el guardia falló; comando bloqueado por seguridad.' }))

  on('tool.call', { tool: 'Read' }, ($, e, next) =>
    isSecretPath(e.file_path) ? { deny: `socio-tecnico: leer ${e.file_path} está prohibido (secretos fuera del chat).` } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: 'socio-tecnico: el guardia falló; lectura bloqueada.' }))

  on('tool.call', { tool: 'Grep' }, ($, e, next) =>
    e.path && isSecretPath(e.path) ? { deny: `socio-tecnico: buscar en ${e.path} está prohibido (secretos fuera del chat).` } : next(e),
  ).catch(($, e, next) => (next.called ? next(e) : { deny: 'socio-tecnico: el guardia falló; búsqueda bloqueada.' }))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const usage = await read($, usageAtom)
    const git = await read($, gitAtom)
    const test = await read($, lastTestAtom)
    const { Box, Text } = $.ui.resolve(e)

    const ctx = usage?.contextPercent ?? null
    const parts: string[] = []
    if (usage?.weekPercent != null)
      parts.push(`sem ${usage.weekPercent}%${usage.weekResetsAt ? ` ↻ ${formatReset(usage.weekResetsAt)}` : ''}`)
    if (git?.branch) parts.push(`⎇ ${git.branch}`)
    if (test)
      parts.push(test.hasSummary
        ? `tests ${test.failed === 0 ? '✓' : '✗'} ${test.passed}/${test.failed}/${test.skipped} ${formatSeconds(test.seconds)}`
        : `tests ✗ sin resumen (exit ${test.exitCode})`)
    if (git?.ci) parts.push(ciLabel(git.ci))
    if (await read($, isMutedAtom)) parts.push('🔇')

    return (
      <Box>
        <Text color={ctx != null && ctx > CONTEXT_WARN ? 'red' : undefined} dimColor={ctx == null || ctx <= CONTEXT_WARN}>
          {`ctx ${ctx ?? '–'}%`}
        </Text>
        <Text dimColor wrap="truncate-end">{parts.length ? ` · ${parts.join(' · ')}` : ''}</Text>
      </Box>
    )
  })
}
