import { describe, expect, test } from 'claude-code/testing'

import { checkCommand, isSecretPath } from '../hooks/guard'

const onDev = { branchOf: async () => 'dev' }
const onMain = { branchOf: async () => 'main' }

describe('guard', () => {
  test('blocks every forbidden command', async () => {
    const blocked = [
      'git push origin main',
      'git push origin HEAD:main',
      'git push --force origin feat/x',
      'git push -f',
      'git push --force-with-lease origin feat/x',
      'git push origin +feat/x',
      'git reset --hard HEAD~1',
      'git branch -D feat/x',
      'git commit -m "x" --no-verify',
      'git commit -nm "x"',
      'git -C ../repo push --no-verify',
      'dotnet ef database update',
      'cd MyApp.API && dotnet ef database update --project ../MyApp.Infrastructure',
      'cat .env',
      'Get-Content MyApp.API/appsettings.Development.json',
      'type "C:\\Users\\user\\AppData\\Roaming\\Microsoft\\UserSecrets\\abc\\secrets.json"',
      'grep KEY .env.local',
    ]
    for (const command of blocked) {
      expect(await checkCommand(command, onDev)).not.toBeNull()
    }
  })

  test('blocks commit and bare push while on main', async () => {
    expect(await checkCommand('git commit -m "x"', onMain)).toContain('main')
    expect(await checkCommand('git push', onMain)).toContain('main')
  })

  test('blocks commands that write to main while on main', async () => {
    for (const command of ['git revert HEAD', 'git merge dev', 'git cherry-pick abc123', 'git rebase dev', 'git am x.patch']) {
      expect(await checkCommand(command, onMain)).toContain('main')
    }
  })

  test('allows revert, merge and rebase on work branches', async () => {
    for (const command of ['git revert --no-edit HEAD', 'git merge --ff-only origin/dev', 'git rebase dev']) {
      expect(await checkCommand(command, onDev)).toBeNull()
    }
  })

  test('blocks pushing a branch onto dev under another name', async () => {
    expect(await checkCommand('git push origin fix/ci:dev', onDev)).toContain('dev')
    expect(await checkCommand('git push -u origin feat/x:refs/heads/dev', onDev)).toContain('dev')
    expect(await checkCommand('git push origin dev', onDev)).toBeNull()
    expect(await checkCommand('git push -u origin fix/ci', onDev)).toBeNull()
  })

  test('allows normal work', async () => {
    const allowed = [
      'git status',
      'git commit -m "feat: algo"',
      'git push -u origin feat/socio',
      'git branch -d feat/merged',
      'git reset --soft HEAD~1',
      'git checkout main',
      'git log main..dev',
      'dotnet test MyApp.sln --filter Sales',
      'dotnet ef migrations add Foo',
      'cat .env.example',
      'dotnet user-secrets list --project MyApp.Tests',
    ]
    for (const command of allowed) {
      expect(await checkCommand(command, onDev)).toBeNull()
    }
  })

  test('recognizes secret paths', () => {
    expect(isSecretPath('C:\\repo\\.env')).toBe(true)
    expect(isSecretPath('/repo/MyApp.API/appsettings.Development.json')).toBe(true)
    expect(isSecretPath('secrets.json')).toBe(true)
    expect(isSecretPath('.env.example')).toBe(false)
    expect(isSecretPath('appsettings.json')).toBe(false)
  })
})
