// Lo que de verdad se ejecuta de un comando de Bash o PowerShell, para reconocer comandos sin dejarse engañar por textos.
// Se quitan el contenido entre comillas, los heredocs (<<EOF ... EOF) y los here-strings de PowerShell (@' ... '@),
// salvo lo que va entre comillas justo después de -Command, -c o /c (powershell, pwsh, bash, sh, cmd): eso también es
// comando y se revisa como tal. Mejor esfuerzo: un comando armado con variables o eval puede escapar.

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
const HERE_STRING = /@(['"])\r?\n[\s\S]*?\r?\n\1@/g
const RUNS_ITS_ARGUMENT = /(^|[\s;&|(])(-command|-c|\/c)\s*$/i

export function executableText(command: string): string {
  const text = command.replace(HEREDOC, m => m.slice(0, m.indexOf('\n'))).replace(HERE_STRING, ' ')
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch !== '"' && ch !== "'") {
      out += ch
      i++
      continue
    }
    // Fin de las comillas: en las dobles, \ y ` escapan el siguiente carácter (Bash y PowerShell).
    let j = i + 1
    while (j < text.length && text[j] !== ch) j += ch === '"' && (text[j] === '\\' || text[j] === '`') ? 2 : 1
    const inner = text.slice(i + 1, j)
    out += RUNS_ITS_ARGUMENT.test(out) ? `;${executableText(inner)};` : ' '
    i = j + 1
  }
  return out
}

// Inicio de un comando: principio, tras ; & | ( { o un salto de línea, con & de PowerShell opcional.
const START = String.raw`(?:^|[;&|({\n])\s*(?:&\s*)?`

export const startsCommand = (body: string) => new RegExp(`${START}(?:${body})`, 'i')
