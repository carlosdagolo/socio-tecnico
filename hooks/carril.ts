import { executableText, startsCommand } from './shell'

// Carril pesado: un solo comando pesado a la vez en el PC, aunque lo pidan dos cuentas de Claude distintas.
// El turno es una carpeta local (%LOCALAPPDATA%\socio-tecnico\carril\turno) que se crea de forma atómica; adentro,
// dueno.json dice quién la tiene. Se suelta apenas termina el comando, también si falla.

export type Heavy = { label: string; isDotnet: boolean }

const HEAVY: [RegExp, string, boolean][] = [
  [startsCommand(String.raw`dotnet(?:\.exe)?\s+test\b`), 'dotnet test', true],
  [startsCommand(String.raw`dotnet(?:\.exe)?\s+build\b`), 'dotnet build', true],
  [startsCommand(String.raw`(?:npx\s+)?(?:\S*[\\/])?playwright\s+test\b`), 'playwright', false],
  [startsCommand(String.raw`npm(?:\.cmd)?\s+(?:--?\S+\s+)*run\s+e2e\b`), 'npm run e2e', false],
  [startsCommand(String.raw`npm(?:\.cmd)?\s+(?:--?\S+\s+)*(?:test|t|run\s+test)\b`), 'npm test', false],
  [startsCommand(String.raw`(?:npx\s+)?(?:\S*[\\/])?jest\b`), 'jest', false],
  [startsCommand(String.raw`(?:npx\s+)?expo\s+export\b`), 'expo export', false],
]

/** El primer comando pesado que el comando ejecuta de verdad (no el que solo menciona en un texto), o null. */
export function heavyCommand(command: string): Heavy | null {
  const text = executableText(command)
  for (const [pattern, label, isDotnet] of HEAVY) if (pattern.test(text)) return { label, isDotnet }
  return null
}

export type Owner = {
  account: string
  pid: number
  pidStart: string
  command: string
  at: number
  token: string
}

export type Me = Pick<Owner, 'account' | 'pid' | 'pidStart'>

export type Lock = { kind: 'none' } | { kind: 'partial'; mtimeMs: number } | { kind: 'owner'; owner: Owner }

/** Lo que el carril necesita del sistema. En la sesión lo hace processOps; en las pruebas, un sistema falso. */
export type CarrilOps = {
  now(): Promise<number>
  newToken(): string
  /** Crea la carpeta del turno de forma atómica: true si la creó esta llamada, false si ya existía. */
  tryCreate(): Promise<boolean>
  writeOwner(owner: Owner): Promise<void>
  readLock(): Promise<Lock>
  isAlive(pid: number, pidStart: string): Promise<boolean>
  /** Quita un turno vencido sin pisar uno nuevo: solo si sigue teniendo ese token (null: sin dueno.json). */
  evict(token: string | null): Promise<void>
  remove(): Promise<void>
  sleep(ms: number): Promise<void>
  shutdownDotnet(): Promise<void>
}

export const LIMITS = {
  /** Cuánto espera un comando por el turno antes de rechazarse. */
  maxWaitMs: 9 * 60_000,
  /** Pausa entre intentos. */
  stepMs: 5_000,
  /** Última red: un turno más viejo que esto se libera aunque su dueño viva (la corrida más larga medida: 9 min 16 s). */
  staleMs: 30 * 60_000,
  /** Una carpeta sin dueno.json más vieja que esto quedó a medias (su dueño murió al crearla). */
  partialMs: 10_000,
}

export type Limits = typeof LIMITS

export function waitMessage(owner: Owner | null, now: number): string {
  if (!owner) return 'esperando turno (otra cuenta lo está tomando)'
  const minutes = Math.max(0, Math.floor((now - owner.at) / 60_000))
  return `esperando turno de ${owner.account} (${owner.command}, hace ${minutes} min)`
}

export type Taken = { ok: true; token: string } | { ok: false; message: string }

async function isStale(ops: CarrilOps, lock: Lock, now: number, limits: Limits): Promise<boolean> {
  if (lock.kind === 'partial') return now - lock.mtimeMs > limits.partialMs
  if (lock.kind !== 'owner') return false
  return now - lock.owner.at > limits.staleMs || !(await ops.isAlive(lock.owner.pid, lock.owner.pidStart))
}

/** Toma el turno; si lo tiene otro, espera (avisando con onWait) hasta maxWaitMs y entonces se rinde con el aviso. */
export async function take(
  ops: CarrilOps,
  me: Me,
  heavy: Heavy,
  options: { limits?: Limits; signal?: AbortSignal; onWait?: (message: string) => void } = {},
): Promise<Taken> {
  const limits = options.limits ?? LIMITS
  const startedAt = await ops.now()
  const token = ops.newToken()
  for (;;) {
    if (await ops.tryCreate()) {
      await ops.writeOwner({ ...me, command: heavy.label, at: await ops.now(), token })
      return { ok: true, token }
    }
    const lock = await ops.readLock()
    const now = await ops.now()
    if (lock.kind === 'none') continue // se soltó entre los dos pasos: intentar de nuevo
    if (await isStale(ops, lock, now, limits)) {
      await ops.evict(lock.kind === 'owner' ? lock.owner.token : null)
      continue
    }
    const message = waitMessage(lock.kind === 'owner' ? lock.owner : null, now)
    if (options.signal?.aborted) return { ok: false, message: `cancelado mientras ${message}` }
    if (now - startedAt >= limits.maxWaitMs) return { ok: false, message }
    options.onWait?.(message)
    await ops.sleep(limits.stepMs)
  }
}

/** Suelta el turno solo si sigue siendo de este token (si se venció y otro lo tomó, no lo toca). */
export async function release(ops: CarrilOps, token: string): Promise<void> {
  const lock = await ops.readLock()
  if (lock.kind === 'owner' && lock.owner.token === token) await ops.remove()
}

export type CarrilResult<T> = { ran: true; value: T } | { ran: false; message: string }

/** Corre `run` con el turno tomado y lo suelta al terminar, también si falla. Con dotnet, antes apaga sus servidores. */
export async function withTurn<T>(
  ops: CarrilOps,
  me: Me,
  heavy: Heavy,
  run: () => Promise<T>,
  options: { limits?: Limits; signal?: AbortSignal; onWait?: (message: string) => void } = {},
): Promise<CarrilResult<T>> {
  const taken = await take(ops, me, heavy, options)
  if (!taken.ok) return { ran: false, message: taken.message }
  try {
    return { ran: true, value: await run() }
  } finally {
    if (heavy.isDotnet) await ops.shutdownDotnet().catch(() => undefined)
    await release(ops, taken.token).catch(() => undefined)
  }
}

export const BACKGROUND_DENIED =
  'corre en primer plano: el carril pesado no puede seguir un comando pesado en segundo plano (no sabe cuándo termina).'
