// Bloqueos de comandos peligrosos. Mejor esfuerzo sobre el texto del comando:
// un comando ofuscado (variables, eval, alias) puede escapar.

const SECRET_FILE = /^(\.env(\..+)?|secrets\.json|appsettings\.development\.json)$/i
const SECRET_TEMPLATE = /^\.env\.(example|sample|template)$/i

export function isSecretPath(path: string): boolean {
  const base = path.replace(/["'`]/g, '').split(/[\\/]/).pop() ?? ''
  return SECRET_FILE.test(base) && !SECRET_TEMPLATE.test(base)
}

function segments(command: string): string[][] {
  return command
    .split(/&&|\|\||[;|\n&]/)
    .map(s => s.trim().split(/\s+/).map(t => t.replace(/^["']|["']$/g, '')).filter(Boolean))
    .filter(t => t.length > 0)
}

// Devuelve el subcomando de git y sus argumentos, saltando opciones globales.
function gitCall(tokens: string[]): { sub: string; args: string[]; dir: string | null } | null {
  const at = tokens.findIndex(t => /(^|[\\/])git(\.exe)?$/i.test(t))
  if (at < 0) return null
  let dir: string | null = null
  let i = at + 1
  while (i < tokens.length && tokens[i].startsWith('-')) {
    if (tokens[i] === '-C') dir = tokens[i + 1] ?? null
    i += tokens[i] === '-C' || tokens[i] === '-c' ? 2 : 1
  }
  if (i >= tokens.length) return null
  return { sub: tokens[i], args: tokens.slice(i + 1), dir }
}

const isMainRef = (ref: string) => /^(\+?)(.*:)?(refs\/heads\/)?main$/.test(ref)
// "rama:dev" empuja a dev con otro nombre de origen; "git push origin dev" pasa por la regla ask de settings.
const isRenamedDevRef = (ref: string) => /^\+?[^:]+:(refs\/heads\/)?dev$/.test(ref)

// Subcomandos que crean commits o reescriben la rama actual.
const WRITES_CURRENT_BRANCH = new Set(['commit', 'revert', 'merge', 'cherry-pick', 'rebase', 'am'])

export type GuardContext = { branchOf: (dir: string | null) => Promise<string | null> }

export async function checkCommand(command: string, ctx: GuardContext): Promise<string | null> {
  for (const tokens of segments(command)) {
    const secret = tokens.find(isSecretPath)
    if (secret) return `leer ${secret} está prohibido (secretos fuera del chat).`

    const ef = tokens.findIndex(t => /(^|[\\/])dotnet(\.exe)?$/i.test(t))
    if (ef >= 0 && tokens[ef + 1] === 'ef' && tokens[ef + 2] === 'database' && tokens[ef + 3] === 'update')
      return 'dotnet ef database update requiere aprobación explícita del propietario.'

    const git = gitCall(tokens)
    if (!git) continue
    const { sub, args, dir } = git

    if (args.includes('--no-verify')) return '--no-verify está prohibido.'

    if (sub === 'reset' && args.includes('--hard')) return 'git reset --hard está prohibido.'

    if (sub === 'branch' && args.some(a => /^-[a-zA-Z]*D/.test(a) || a === '--delete' && args.some(b => b === '--force' || b === '-f')))
      return 'borrar ramas (git branch -D) está prohibido.'

    if (sub === 'commit' && args.some(a => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a)))
      return 'git commit -n (--no-verify) está prohibido.'

    if (WRITES_CURRENT_BRANCH.has(sub) && (await ctx.branchOf(dir)) === 'main')
      return `git ${sub} en main está prohibido: main lo integra solo el propietario.`

    if (sub === 'push') {
      if (args.some(a => a === '-f' || /^--force(-with-lease|-if-includes)?(=.*)?$/.test(a) || /^-[a-zA-Z]*f/.test(a) && !a.startsWith('--') || a.startsWith('+')))
        return 'push forzado está prohibido.'
      const refs = args.filter(a => !a.startsWith('-')).slice(1)
      if (refs.some(isMainRef)) return 'push a main está prohibido: main lo integra solo el propietario.'
      if (refs.some(isRenamedDevRef)) return 'push a dev con "rama:dev" está prohibido: usa git push origin dev, con OK del propietario.'
      if (refs.length === 0 && (await ctx.branchOf(dir)) === 'main')
        return 'push desde main está prohibido: main lo integra solo el propietario.'
    }
  }
  return null
}
