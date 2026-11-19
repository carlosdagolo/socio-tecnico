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
  '"$p $((Get-Process -Id $p).StartTime.ToFileTimeUtc())"'

const startOf = (pid: number) =>
  `$x=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($x) { $x.StartTime.ToFileTimeUtc() }`

const powershell = (script: string) => ['powershell', '-NoProfile', '-NonInteractive', '-Command', script]

export async function whoAmI($: EngineInterface): Promise<Me> {
  const account = accountOf(await $.env.get('CLAUDE_CONFIG_DIR'))
  const r = await $.process.run(powershell(WHO_AM_I), { timeoutMs: 30_000 })
  const [pid, pidStart] = r.stdout.trim().split(/\s+/)
  if (!ok(r) || !/^\d+$/.test(pid ?? '') || !pidStart) throw new Error(`no se pudo leer el PID de la sesión (${r.stderr.trim()})`)
  return { account, pid: Number(pid), pidStart }
}

export function processOps($: EngineInterface, dir: string): CarrilOps {
  const lock = `${dir}\\turno`
  const ownerFile = `${lock}\\dueno.json`
  const cmd = (...args: string[]) => $.process.run(['cmd', '/d', '/c', ...args], { timeoutMs: 30_000 })

  async function readLockAt(path: string): Promise<Lock> {
    if (!(await $.fs.exists(path))) return { kind: 'none' }
    try {
      const owner = JSON.parse(await $.fs.read(`${path}\\dueno.json`)) as Owner
      if (typeof owner.token === 'string' && typeof owner.pid === 'number') return { kind: 'owner', owner }
    } catch {
      // Sin dueno.json legible: la carpeta quedó a medias o la están creando.
    }
    try {
      return { kind: 'partial', mtimeMs: (await $.fs.stat(path)).mtimeMs }
    } catch {
      return { kind: 'none' }
    }
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
    readLock: () => readLockAt(lock),
    async isAlive(pid, pidStart) {
      const r = await $.process.run(powershell(startOf(pid)), { timeoutMs: 30_000 })
      return ok(r) && r.stdout.trim() === pidStart
    },
    async evict(token) {
      // Se renombra (atómico) y se confirma que era el vencido; si alguien lo tomó en medio, se devuelve.
      const aside = `${lock}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.viejo`
      if (!ok(await cmd('move', lock, aside))) return
      const moved = await readLockAt(aside)
      const movedToken = moved.kind === 'owner' ? moved.owner.token : null
      if (movedToken !== token && ok(await cmd('move', aside, lock))) return
      await cmd('rmdir', '/s', '/q', aside)
    },
    async remove() {
      await cmd('rmdir', '/s', '/q', lock)
    },
    async sleep(ms) {
      // Una pausa hecha por un proceso: mientras corre, no gasta el presupuesto de tiempo del hook ($.clock.sleep sí).
      await $.process.run(powershell(`Start-Sleep -Milliseconds ${Math.round(ms)}`), { timeoutMs: ms + 30_000 })
    },
    async shutdownDotnet() {
      await $.process.run(['dotnet', 'build-server', 'shutdown'], { timeoutMs: 60_000 })
    },
  }
}
