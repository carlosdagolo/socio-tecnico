import { describe, expect, test } from 'claude-code/testing'

import { heavyCommand } from '../hooks/carril'
import { isDotnetTest } from '../hooks/dotnet'
import { executableText } from '../hooks/shell'

describe('shell: lo que de verdad se ejecuta', () => {
  test('drops quoted text, heredocs and here-strings, keeps what -Command and -c run', () => {
    expect(executableText('git commit -m "corre dotnet test"')).not.toContain('dotnet')
    expect(executableText("cat > x.md <<'EOF'\n(dotnet test\nEOF\nls")).not.toContain('dotnet')
    expect(executableText("$t = @'\nnpm test\n'@\nWrite-Output $t")).not.toContain('npm')
    expect(executableText('powershell -NoProfile -Command "cd app; npm test"')).toContain('npm test')
    expect(executableText("bash -c 'dotnet build'")).toContain('dotnet build')
    expect(executableText('echo "a \\" dotnet test"; ls')).not.toContain('dotnet')
  })
})

describe('shell: comandos pesados', () => {
  test('recognizes every heavy command, also after cd ... &&', () => {
    const heavy: [string, string][] = [
      ['dotnet test BarberShop.Tests --filter X', 'dotnet test'],
      ['cd C:/repo && dotnet build BarberShop.sln', 'dotnet build'],
      ['& dotnet.exe test', 'dotnet test'],
      ['npx jest __tests__/structure.test.ts', 'jest'],
      ['cd app; npm test -- --ci', 'npm test'],
      ['npm run test', 'npm test'],
      ['npx playwright test e2e/caja.spec.ts', 'playwright'],
      ['npm run e2e', 'npm run e2e'],
      ['npx expo export --platform web', 'expo export'],
      ['powershell -NoProfile -Command "dotnet test"', 'dotnet test'],
    ]
    for (const [command, label] of heavy) expect(heavyCommand(command)?.label).toBe(label)
    expect(heavyCommand('dotnet build x.sln')?.isDotnet).toBe(true)
    expect(heavyCommand('npx jest')?.isDotnet).toBe(false)
  })

  test('ignores commands that only mention a heavy command or are light', () => {
    const light = [
      'gh issue create --title "x" --body "Turno (dotnet test/build, jest, Playwright)"',
      "cat > plan.md <<'EOF'\nnpm test y (dotnet test\nEOF",
      'git commit -m "test: jest con 2 workers"',
      'dotnet run --project BarberShop.API',
      'dotnet list package --vulnerable',
      'npm run lint',
      'npm run typecheck',
      'grep -rn "npx jest" docs',
      'echo dotnet-test',
    ]
    for (const command of light) expect(heavyCommand(command)).toBeNull()
  })
})

describe('shell: resumen de dotnet test sin falsos positivos', () => {
  test('a gh issue body or a heredoc that mentions (dotnet test is not a test run', () => {
    expect(isDotnetTest('gh issue create --body "**Pedido:** turno (dotnet test/build, jest)"')).toBe(false)
    expect(isDotnetTest("cat > a.md <<'EOF'\n(dotnet test\nEOF")).toBe(false)
    expect(isDotnetTest('cd x && dotnet test')).toBe(true)
  })
})
