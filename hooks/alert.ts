import type { EngineInterface, Timer } from 'claude-code'

// Aviso sonoro mientras Claude espera al propietario.
export const REPEAT_MS = 120000
export const MAX_REPEATS = 10
const SOUND = 'sounds/ping.wav'

export type WaitReason = 'turn' | 'permission' | 'question'

let timer: Timer | null = null
let reason: WaitReason | null = null

export const waitReason = () => reason

async function play($: EngineInterface) {
  // En Windows la terminal no tiene reproductor: $.audio.play no suena.
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const path = `${$.plugin.root}/${SOUND}`.replace(/'/g, "''")
    await $.process.run(
      ['powershell', '-NoProfile', '-NonInteractive', '-Command', `(New-Object Media.SoundPlayer '${path}').PlaySync()`],
      { timeoutMs: 10000 },
    )
  } else {
    await $.audio.play({ asset: SOUND })
  }
}

// Cada intento queda en %TEMP%\socio-alert.log (últimas 100 líneas) para diagnosticar.
async function logRing($: EngineInterface, line: string) {
  const temp = (await $.env.get('TEMP')) ?? (await $.env.get('TMP'))
  if (!temp) return
  const path = `${temp.replace(/[\\/]+$/, '')}\\socio-alert.log`
  let previous = ''
  try {
    previous = await $.fs.read(path)
  } catch {
    // primera línea
  }
  const stamp = new Date(await $.clock.now()).toISOString()
  const lines = previous.split('\n').filter(Boolean).concat(`${stamp} ${line}`).slice(-100)
  await $.fs.write(path, lines.join('\n') + '\n')
}

function ring($: EngineInterface) {
  const why = reason
  play($)
    .then(() => logRing($, `${why}: sonó`))
    .catch((error: unknown) => logRing($, `${why}: falló: ${String(error)}`))
    .catch(() => undefined)
}

export function stopAlert() {
  timer?.cancel()
  timer = null
  reason = null
}

export function startAlert($: EngineInterface, why: WaitReason) {
  stopAlert()
  reason = why
  ring($)
  let repeats = 0
  timer = $.clock.every(REPEAT_MS, () => {
    repeats += 1
    ring($)
    if (repeats >= MAX_REPEATS) stopAlert()
  })
}
