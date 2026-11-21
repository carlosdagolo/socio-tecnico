import { describe, expect, test } from 'claude-code/testing'

import { LIMITS, release, take, waitMessage, withTurn, type CarrilOps, type Heavy, type Me, type Owner } from '../hooks/carril'

// Un PC falso: la carpeta del turno en memoria (crearla es atómico, como mkdir), procesos vivos y un reloj que avanza
// solo con las pausas. Cada cuenta recibe sus propias operaciones sobre el mismo PC.
function fakePc(start = Date.UTC(2026, 10, 19, 12)) {
  const pc = {
    now: start,
    lock: null as null | { mtimeMs: number; owner?: Owner },
    alive: new Map<number, string>(),
    sleeps: 0,
    shutdowns: 0,
    removes: 0,
    /** La carpeta del turno no se deja borrar (antivirus, indexador). */
    locked: false,
  }
  let tokens = 0
  const ops: CarrilOps = {
    now: async () => pc.now,
    newToken: () => `t${++tokens}`,
    tryCreate: async () => {
      if (pc.lock) return false
      pc.lock = { mtimeMs: pc.now }
      return true
    },
    writeOwner: async owner => {
      if (pc.lock) pc.lock.owner = owner
    },
    readLock: async () =>
      !pc.lock ? { kind: 'none' } : pc.lock.owner ? { kind: 'owner', owner: pc.lock.owner } : { kind: 'partial', mtimeMs: pc.lock.mtimeMs },
    isAlive: async (pid, pidStart) => pc.alive.get(pid) === pidStart,
    evict: async token => {
      if (pc.locked) return false
      if ((pc.lock?.owner?.token ?? null) !== token) return false
      pc.lock = null
      return true
    },
    remove: async () => {
      pc.removes++
      if (pc.locked) return false
      pc.lock = null
      return true
    },
    sleep: async ms => {
      pc.sleeps++
      pc.now += ms
      await Promise.resolve()
    },
    shutdownDotnet: async () => {
      pc.shutdowns++
    },
  }
  return { pc, ops }
}

const cuenta1: Me = { account: 'cuenta 1', pid: 100, pidStart: 's100' }
const cuenta2: Me = { account: 'cuenta 2', pid: 200, pidStart: 's200' }
const dotnetTest: Heavy = { label: 'dotnet test', isDotnet: true }
const jest: Heavy = { label: 'jest', isDotnet: false }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => (resolve = r))
  return { promise, resolve }
}

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function ownerOf(me: Me, at: number, extra: Partial<Owner> = {}): Owner {
  return { ...me, command: 'dotnet test', at, token: 'ajeno', ...extra }
}

describe('carril: dos tomas a la vez', () => {
  test('two accounts at once: only one runs; the other waits and runs after the first lets go', async () => {
    const { pc, ops } = fakePc()
    pc.alive.set(100, 's100').set(200, 's200')
    const first = deferred()
    const order: string[] = []

    const a = withTurn(ops, cuenta1, dotnetTest, async () => {
      order.push('a empieza')
      await first.promise
      order.push('a termina')
    })
    const b = withTurn(ops, cuenta2, jest, async () => {
      order.push('b corre')
    })
    await flush()

    expect(order).toEqual(['a empieza'])
    expect(pc.sleeps).toBeGreaterThan(0)

    first.resolve()
    await Promise.all([a, b])

    expect(order).toEqual(['a empieza', 'a termina', 'b corre'])
    expect(pc.lock).toBeNull()
  })
})

describe('carril: turno de un dueño que ya no está', () => {
  test('takes the turn at once when the owner PID is dead', async () => {
    const { pc, ops } = fakePc()
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now) } // el PID 200 no está vivo

    const taken = await take(ops, cuenta1, dotnetTest)

    expect(taken.ok).toBe(true)
    expect(pc.sleeps).toBe(0)
    expect(pc.lock?.owner?.account).toBe('cuenta 1')
  })

  test('takes the turn when the PID was reused by another process (different start time)', async () => {
    const { pc, ops } = fakePc()
    pc.alive.set(200, 'otro-inicio')
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now) }

    expect((await take(ops, cuenta1, dotnetTest)).ok).toBe(true)
    expect(pc.sleeps).toBe(0)
  })

  test('takes a half-made turn (folder without owner) older than 10 s, waits on a newer one', async () => {
    const { pc, ops } = fakePc()
    pc.lock = { mtimeMs: pc.now - 11_000 }
    expect((await take(ops, cuenta1, jest)).ok).toBe(true)
    expect(pc.sleeps).toBe(0)

    pc.lock = { mtimeMs: pc.now }
    const limits = { ...LIMITS, maxWaitMs: 4_000, partialMs: 60_000 }
    const taken = await take(ops, cuenta2, jest, { limits })
    expect(taken.ok).toBe(false)
  })
})

describe('carril: turno vencido', () => {
  test('frees a turn older than 30 min even if its owner is alive', async () => {
    const { pc, ops } = fakePc()
    pc.alive.set(200, 's200')
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now - 31 * 60_000) }

    expect((await take(ops, cuenta1, dotnetTest)).ok).toBe(true)
    expect(pc.sleeps).toBe(0)
  })

  test('keeps waiting on a turn of 29 min whose owner is alive', async () => {
    const { pc, ops } = fakePc()
    pc.alive.set(200, 's200')
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now - 29 * 60_000) }

    const taken = await take(ops, cuenta1, dotnetTest, { limits: { ...LIMITS, maxWaitMs: 30_000 } })

    expect(taken.ok).toBe(false)
    expect(pc.lock?.owner?.account).toBe('cuenta 2')
  })
})

describe('carril: soltar', () => {
  test('lets go when the command fails with an error', async () => {
    const { pc, ops } = fakePc()

    const ran = withTurn(ops, cuenta1, jest, async () => {
      throw new Error('jest se cayó')
    })

    await expect(ran).rejects.toThrow('jest se cayó')
    expect(pc.lock).toBeNull()
  })

  test('lets go when the command ends with an error result', async () => {
    const { pc, ops } = fakePc()

    const ran = await withTurn(ops, cuenta1, dotnetTest, async () => ({ isError: true, text: 'Exit code 1' }))

    expect(ran.ran).toBe(true)
    expect(pc.lock).toBeNull()
  })

  test('shuts the dotnet build servers down before letting go, only for dotnet', async () => {
    const { pc, ops } = fakePc()
    let lockWhenShutdown: unknown = 'sin llamar'
    const watched: CarrilOps = {
      ...ops,
      shutdownDotnet: async () => {
        lockWhenShutdown = pc.lock?.owner?.account
        await ops.shutdownDotnet()
      },
    }

    await withTurn(watched, cuenta1, dotnetTest, async () => undefined)
    await withTurn(watched, cuenta1, jest, async () => undefined)

    expect(pc.shutdowns).toBe(1)
    expect(lockWhenShutdown).toBe('cuenta 1')
  })

  test('does not remove a turn that another account took after ours expired', async () => {
    const { pc, ops } = fakePc()
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now, { token: 'de-la-cuenta-2' }) }

    await release(ops, 't-viejo-de-la-cuenta-1')

    expect(pc.removes).toBe(0)
    expect(pc.lock?.owner?.token).toBe('de-la-cuenta-2')
  })
})

describe('carril: esperar', () => {
  test('gives up after the max wait with a message naming the account, the command and how long ago', async () => {
    const { pc, ops } = fakePc()
    pc.alive.set(200, 's200')
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now - 3 * 60_000) }
    const seen: string[] = []

    const taken = await take(ops, cuenta1, jest, { onWait: m => seen.push(m) })

    expect(taken).toEqual({ ok: false, message: 'esperando turno de cuenta 2 (dotnet test, hace 12 min)' })
    expect(seen[0]).toBe('esperando turno de cuenta 2 (dotnet test, hace 3 min)')
    expect(pc.now - Date.UTC(2026, 10, 19, 12)).toBe(LIMITS.maxWaitMs)
  })

  test('stops waiting when the call is cancelled', async () => {
    const { pc, ops } = fakePc()
    pc.alive.set(200, 's200')
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now) }
    const controller = new AbortController()
    controller.abort()

    const taken = await take(ops, cuenta1, jest, { signal: controller.signal })

    expect(taken.ok).toBe(false)
    expect(pc.sleeps).toBe(0)
  })

  test('waitMessage says when the turn is being taken and has no owner yet', () => {
    expect(waitMessage(null, 0)).toContain('esperando turno')
  })
})

describe('carril: hallazgos del /code-review', () => {
  test('does not spin forever when an expired turn cannot be freed: waits with pauses and gives up', async () => {
    const { pc, ops } = fakePc()
    pc.locked = true
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now) } // dueño muerto, pero la carpeta no se deja borrar

    const taken = await take(ops, cuenta1, jest, { limits: { ...LIMITS, maxWaitMs: 60_000 } })

    expect(taken.ok).toBe(false)
    if (!taken.ok) expect(taken.message).toContain('no se pudo liberar')
    expect(pc.sleeps).toBe(12)
  })

  test('does not spin forever when freeing says it worked but the turn is still there', async () => {
    const { pc, ops } = fakePc()
    pc.lock = { mtimeMs: pc.now, owner: ownerOf(cuenta2, pc.now) } // dueño muerto
    const lying: CarrilOps = { ...ops, evict: async () => true } // dice que lo quitó, pero sigue ahí

    const taken = await take(lying, cuenta1, jest, { limits: { ...LIMITS, maxWaitMs: 30_000 } })

    expect(taken.ok).toBe(false)
    expect(pc.sleeps).toBe(6)
  })

  test('tells when its own turn could not be let go, after retrying', async () => {
    const { pc, ops } = fakePc()
    const stuck: string[] = []

    await withTurn(
      ops,
      cuenta1,
      jest,
      async () => {
        pc.locked = true
      },
      { onStuck: m => stuck.push(m) },
    )

    expect(pc.removes).toBe(3)
    expect(stuck).toHaveLength(1)
    expect(stuck[0]).toContain('Remove-Item')
  })

  test('removes the half-made folder when writing the owner fails', async () => {
    const { pc, ops } = fakePc()
    const failing: CarrilOps = {
      ...ops,
      writeOwner: async () => {
        throw new Error('disco lleno')
      },
    }

    await expect(take(failing, cuenta1, jest)).rejects.toThrow('disco lleno')
    expect(pc.lock).toBeNull()
  })
})
