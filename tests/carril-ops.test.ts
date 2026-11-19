import { describe, expect, test } from 'claude-code/testing'

import { accountOf, aliveFrom } from '../hooks/carril-ops'

describe('carril: si el dueño vive', () => {
  test('only a clear MUERTO or another process in the same PID counts as gone', () => {
    expect(aliveFrom(0, 'MUERTO\r\n', '123')).toBe(false)
    expect(aliveFrom(0, 'VIVO 999\r\n', '123')).toBe(false) // PID reutilizado por otro proceso
    expect(aliveFrom(0, 'VIVO 123\r\n', '123')).toBe(true)
  })

  test('assumes the owner is alive when PowerShell fails or says something else', () => {
    expect(aliveFrom(1, '', '123')).toBe(true) // error, tiempo agotado
    expect(aliveFrom(0, '', '123')).toBe(true) // salida vacía
    expect(aliveFrom(0, 'Get-Process : Access is denied', '123')).toBe(true)
    expect(aliveFrom(1, 'MUERTO', '123')).toBe(true) // con error, ni siquiera MUERTO se cree
  })
})

describe('carril: nombre de la cuenta', () => {
  test('names the account from CLAUDE_CONFIG_DIR', () => {
    expect(accountOf(undefined)).toBe('cuenta 1')
    expect(accountOf('C:\\Users\\carlo\\.claude-cuenta2')).toBe('cuenta 2')
    expect(accountOf('C:\\Users\\carlo\\.claude-trabajo\\')).toBe('.claude-trabajo')
  })
})
