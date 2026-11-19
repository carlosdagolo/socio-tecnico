// Lo que de verdad se ejecuta de un comando de Bash o PowerShell, para reconocer comandos sin dejarse engañar por textos.
// Se quitan el contenido entre comillas, los comentarios (#), los heredocs (<<EOF ... EOF) y los here-strings de
// PowerShell (@' ... '@), salvo lo que va entre comillas justo después de -Command, -c, -lc o /c (powershell, pwsh,
// bash, sh, cmd): eso también es comando y se revisa como tal. Mejor esfuerzo: un comando armado con variables o eval
// puede escapar.
//
// Dentro de comillas no se interpretan escapes (\ en Bash, ` en PowerShell): cada shell los entiende distinto, y ante
// la duda conviene cerrar las comillas antes y ver de más (tomar un turno de sobra) que esconder un comando real.

const HEREDOC = /<<-?[ \t]*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g
const HERE_STRING = /@(['"])\r?\n[\s\S]*?\r?\n\1@/g
const RUNS_ITS_ARGUMENT = /(^|[\s;&|(])(-command|-[a-z]*c|\/c)\s*$/i

export function executableText(command: string): string {
  const text = command.replace(HEREDOC, m => m.slice(0, m.indexOf('\n'))).replace(HERE_STRING, ' ')
  let out = ''
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    // Comentario: # al inicio de una palabra, hasta el fin de la línea.
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]!))) {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (ch !== '"' && ch !== "'") {
      out += ch
      i++
      continue
    }
    let j = i + 1
    while (j < text.length && text[j] !== ch) j++
    const inner = text.slice(i + 1, j)
    out += RUNS_ITS_ARGUMENT.test(out) ? `;${executableText(inner)};` : ' '
    i = j + 1
  }
  return out
}

// Inicio de un comando: principio, tras ; & | ( { o un salto de línea, con & de PowerShell opcional, variables de
// entorno delante (CI=1) y envoltorios comunes (timeout 600, time, env, nice, nohup).
const START = String.raw`(?:^|[;&|({\n])\s*(?:&\s*)?(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:timeout\s+\S+|time|env|nice|nohup)\s+)*`

export const startsCommand = (body: string) => new RegExp(`${START}(?:${body})`, 'i')
