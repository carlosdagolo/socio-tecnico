import type { EngineInterface } from 'claude-code'

import type { CarrilOps, Lock, Me, Owner } from './carril'

// Las operaciones del carril en Windows, con $.process.run (crear y borrar carpetas, ver si un PID vive) y $.fs.
// Crear una carpeta es atómico: si dos procesos la crean a la vez, a uno le falla porque ya existe.

const ok = (r: { exitCode: number }) => r.exitCode === 0

/** La cuenta: "cuenta 1" sin CLAUDE_CONFIG_DIR; "cuenta N" si la carpeta dice cuentaN; si no, el nombre de la carpeta. */
export function accountOf(configDir: string | undefined): string {
  if (!configDir) return 'cuenta 1'
  const n = /cuenta-?(\d+)/i.exec(configDir)?.[1]
  return n ? `cuenta ${n}` : configDir.split(/[\\/]/).filter(Boolean).pop() ?? configDir
}

// PID y hora de inicio del proceso que lanza los comandos (la sesión de Claude): el padre de este PowerShell.
const WHO_AM_I =
  '$p=(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId;' +
  '"$p $((Get-Process -Id $p).StartTime.ToFileTimeUtc()) $((Get-Process -Id $p).ProcessName)"'

// "VIVO <inicio>" o "MUERTO": cualquier otra salida (error, Access denied, tiempo agotado) no prueba que murió.
const STATUS_OF = (pid: number) =>
  `$x=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($x) { "VIVO $($x.StartTime.ToFileTimeUtc())" } else { "MUERTO" }`

const powershell = (script: string) => ['powershell', '-NoProfile', '-NonInteractive', '-Command', script]

/** Interpreta la salida de STATUS_OF: false solo con MUERTO o con otro proceso en el mismo PID. */
export function aliveFrom(exitCode: number, stdout: string, pidStart: string): boolean {
  const out = stdout.trim()
  if (exitCode === 0 && out === 'MUERTO') return false
  const started = /^VIVO (\S+)$/.exec(out)?.[1]
  if (exitCode === 0 && started) return started === pidStart
  return true
}

export async function whoAmI($: EngineInterface): Promise<Me & { processName: string }> {
  const account = accountOf(await $.env.get('CLAUDE_CONFIG_DIR'))
  const r = await $.process.run(powershell(WHO_AM_I), { timeoutMs: 30_000 })
  const [pid, pidStart, processName = '?'] = r.stdout.trim().split(/\s+/)
  if (!ok(r) || !/^\d+$/.test(pid ?? '') || !pidStart) throw new Error(`no se pudo leer el PID de la sesión (${r.stderr.trim()})`)
  return { account, pid: Number(pid), pidStart, processName }
}

export function processOps($: EngineInterface, dir: string): CarrilOps {
  const lock = `${dir}\\turno`
  const ownerFile = `${lock}\\dueno.json`
  // Candado de quien libera un turno vencido: uno a la vez, así nadie borra un turno recién tomado por otro.
  const evicting = `${dir}\\liberando`
  const cmd = (...args: string[]) => $.process.run(['cmd', '/d', '/c', ...args], { timeoutMs: 30_000 })

  async function readLock(): Promise<Lock> {
    if (!(await $.fs.exists(lock))) return { kind: 'none' }
    try {
      const owner = JSON.parse(await $.fs.read(ownerFile)) as Owner
      if (typeof owner.token === 'string' && Number.isInteger(owner.pid) && typeof owner.pidStart === 'string')
        return { kind: 'owner', owner }
    } catch {
      // Sin dueno.json legible: la carpeta quedó a medias o la están creando.
    }
    try {
      return { kind: 'partial', mtimeMs: (await $.fs.stat(lock)).mtimeMs }
    } catch {
      return { kind: 'none' }
    }
  }

  async function remove(path: string): Promise<boolean> {
    await cmd('rmdir', '/s', '/q', path)
    return !(await $.fs.exists(path))
  }

  return {
    now: () => $.clock.now(),
    newToken: () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
    async tryCreate() {
      const r = await cmd('mkdir', lock)
      if (ok(r)) return true
      if (await $.fs.exists(lock)) return false
      throw new Error(`no se pudo crear ${lock}: ${r.stderr.trim() || r.stdout.trim()}`)
    },
    writeOwner: owner => $.fs.write(ownerFile, JSON.stringify(owner)),
    readLock,
    async isAlive(pid, pidStart) {
      try {
        const r = await $.process.run(powershell(STATUS_OF(pid)), { timeoutMs: 30_000 })
        return aliveFrom(r.exitCode, r.stdout, pidStart)
      } catch {
        return true // no se pudo saber: se asume vivo y se sigue esperando
      }
    },
    async evict(token) {
      if (!ok(await cmd('mkdir', evicting))) {
        // Otro lo está liberando; si su candado quedó colgado (más de 30 s), se quita para el próximo intento.
        const stat = await $.fs.stat(evicting).catch(() => null)
        if (stat && (await $.clock.now()) - stat.mtimeMs > 30_000) await remove(evicting)
        return false
      }
      try {
        // Con el candado puesto, se confirma que sigue siendo el mismo turno vencido antes de borrarlo.
        const now = await readLock()
        const current = now.kind === 'owner' ? now.owner.token : now.kind === 'partial' ? null : undefined
        if (current === undefined) return true // ya no hay turno
        if (current !== token) return false // alguien lo tomó en medio: no se toca
        return await remove(lock)
      } finally {
        await remove(evicting)
      }
    },
    remove: () => remove(lock),
    async sleep(ms) {
      // Una pausa hecha por un proceso: mientras corre, no gasta el presupuesto de tiempo del hook ($.clock.sleep sí).
      await $.process.run(powershell(`Start-Sleep -Milliseconds ${Math.round(ms)}`), { timeoutMs: ms + 30_000 })
    },
    async shutdownDotnet() {
      await $.process.run(['dotnet', 'build-server', 'shutdown'], { timeoutMs: 60_000 })
    },
  }
}
