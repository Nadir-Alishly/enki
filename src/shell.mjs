// A small shell reader for policy checks. It finds the commands inside a Bash string,
// including ones behind quotes, substitutions and wrappers. It is not a full parser:
// see the README for what it can't see.

const WRAPPERS = new Set(['env', 'command', 'nohup', 'time', 'exec', 'nice', 'ionice', 'stdbuf', 'builtin'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/
const HEREDOC = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/

function readHeredocEnd(text, from, tag) {
  let lineStart = text.indexOf('\n', from)
  if (lineStart === -1) return text.length
  lineStart += 1
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf('\n', lineStart)
    if (lineEnd === -1) lineEnd = text.length
    if (text.slice(lineStart, lineEnd).trim() === tag) return lineEnd
    if (lineEnd >= text.length) return text.length
    lineStart = lineEnd + 1
  }
  return text.length
}

/** Index just past the `)` matching the `(` at `open`, skipping quotes. */
function closingParen(text, open) {
  let depth = 0
  let quote = null
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === '\\' && quote !== "'") i += 1
    else if (quote) {
      if (c === quote) quote = null
    } else if (c === "'" || c === '"') quote = c
    else if (c === '(') depth += 1
    else if (c === ')' && --depth === 0) return i + 1
  }
  return text.length
}

/** Splits into simple commands and collects the bodies of substitutions. */
function tokenize(text) {
  const segments = []
  const nested = []
  let tokens = []
  let word = null
  let start = 0
  const pendingHeredocs = []

  const flushWord = () => {
    if (word !== null) tokens.push(word)
    word = null
  }
  const flushSegment = end => {
    flushWord()
    if (tokens.length > 0) segments.push({ raw: text.slice(start, end).trim(), tokens })
    tokens = []
  }

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') {
      if (text[i + 1] === '\n') {
        i += 1
        continue
      }
      word = (word ?? '') + (text[i + 1] ?? '')
      i += 1
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end
      word = (word ?? '') + text.slice(i + 1, stop)
      i = stop
    } else if (c === '"') {
      word ??= ''
      for (i += 1; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') word += text[++i] ?? ''
        else if (text[i] === '$' && text[i + 1] === '(') {
          const end = closingParen(text, i + 1)
          nested.push(text.slice(i + 2, end - 1))
          word += text.slice(i, end)
          i = end - 1
        } else if (text[i] === '`') {
          const end = text.indexOf('`', i + 1)
          const stop = end === -1 ? text.length : end
          nested.push(text.slice(i + 1, stop))
          word += text.slice(i, stop + 1)
          i = stop
        } else word += text[i]
      }
    } else if ((c === '$' || c === '<' || c === '>') && text[i + 1] === '(') {
      const end = closingParen(text, i + 1)
      nested.push(text.slice(i + 2, end - 1))
      word = (word ?? '') + text.slice(i, end)
      i = end - 1
    } else if (c === '`') {
      const end = text.indexOf('`', i + 1)
      const stop = end === -1 ? text.length : end
      nested.push(text.slice(i + 1, stop))
      word = (word ?? '') + text.slice(i, stop + 1)
      i = stop
    } else if (c === '(' || c === ')' || c === '{' && (text[i + 1] === ' ' || text[i + 1] === '\n') || c === '}' && word === null) {
      flushSegment(i)
      start = i + 1
    } else if (c === '\n') {
      flushSegment(i)
      start = i + 1
      if (pendingHeredocs.length > 0) {
        // The next line starts the body: jump past the last pending terminator.
        i -= 1
        for (const tag of pendingHeredocs.splice(0)) i = readHeredocEnd(text, i + 1, tag)
        start = i + 1
      }
    } else if (c === ';' || c === '|' || (c === '&' && text[i + 1] !== '>' && text[i - 1] !== '>')) {
      flushSegment(i)
      if ((c === '|' || c === '&') && text[i + 1] === c) i += 1
      else if (c === ';' && text[i + 1] === ';') i += 1
      start = i + 1
    } else if (c === '<' && text[i + 1] === '<') {
      const match = HEREDOC.exec(text.slice(i))
      if (match) {
        flushWord()
        pendingHeredocs.push(match[2])
        i += match[0].length - 1
      } else {
        i += text[i + 2] === '<' ? 2 : 1 // Here-string, or a stray operator.
      }
    } else if (c === '>' || c === '<') {
      if (/^\d+$/.test(word ?? '')) word = null // File descriptor, as in 2>
      flushWord()
      const op = c === '>' && text[i + 1] === '>' ? '>>' : c
      if (op === '>>') i += 1
      if (text[i + 1] === '&') {
        i += 1
        while (i + 1 < text.length && /[\w-]/.test(text[i + 1])) i += 1
      } else tokens.push(op)
    } else if (c === ' ' || c === '\t') {
      flushWord()
    } else if (c === '#' && word === null) {
      const end = text.indexOf('\n', i)
      i = (end === -1 ? text.length : end) - 1
    } else {
      word = (word ?? '') + c
    }
  }
  flushSegment(text.length)
  return { segments, nested }
}

/** Removes env assignments and wrapper commands, returning the command that really runs. */
function unwrap(tokens) {
  let rest = tokens
  for (;;) {
    while (rest.length > 0 && ASSIGNMENT.test(rest[0])) rest = rest.slice(1)
    const head = rest[0]
    if (WRAPPERS.has(head)) {
      rest = rest.slice(1)
      while (rest[0]?.startsWith('-') || (head === 'nice' && /^\d+$/.test(rest[0] ?? ''))) rest = rest.slice(1)
    } else if (head === 'timeout') {
      rest = rest.slice(1)
      while (rest[0]?.startsWith('-')) rest = rest.slice(1)
      rest = rest.slice(1) // The duration.
    } else if (head === 'xargs') {
      rest = rest.slice(1)
      while (rest[0]?.startsWith('-')) rest = rest.slice(rest[0].length === 2 && 'InLPds'.includes(rest[0][1]) ? 2 : 1)
    } else return rest
  }
}

const baseName = word => word?.split('/').pop()

/** Every simple command in `command`, each as { text, tokens }, wrappers removed. */
export function parseCommand(command, depth = 0) {
  if (depth > 6) return [] // Stops pathological nesting. The outer layers were still checked.
  const { segments, nested } = tokenize(command)
  const commands = []

  for (const { tokens } of segments) {
    const real = unwrap(tokens)
    if (real.length === 0) continue
    commands.push({ text: real.join(' '), tokens: real })

    const head = baseName(real[0])
    if (SHELLS.has(head)) {
      const flag = real.findIndex(token => /^-[a-z]*c[a-z]*$/.test(token))
      if (flag !== -1 && real[flag + 1] !== undefined) commands.push(...parseCommand(real[flag + 1], depth + 1))
    } else if (head === 'eval') {
      commands.push(...parseCommand(real.slice(1).join(' '), depth + 1))
    } else if (head === 'find') {
      real.forEach((token, index) => {
        if (['-exec', '-execdir', '-ok', '-okdir'].includes(token)) {
          const rest = real.slice(index + 1)
          const end = rest.findIndex(word => word === ';' || word === '+')
          commands.push(...parseCommand((end === -1 ? rest : rest.slice(0, end)).join(' '), depth + 1))
        }
      })
    }
  }
  for (const body of nested) commands.push(...parseCommand(body, depth + 1))
  return commands
}

const READ_ONLY_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty'])

function words(tokens) {
  return tokens.filter(token => token !== '>' && token !== '>>' && token !== '<')
}

/** Paths a simple command visibly writes or deletes. Scripts and build tools can't be seen here. */
export function writeTargets({ tokens }) {
  const targets = []
  tokens.forEach((token, index) => {
    if ((token === '>' || token === '>>') && tokens[index + 1] !== undefined) targets.push(tokens[index + 1])
  })
  const clean = []
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] === '>' || tokens[i] === '>>' || tokens[i] === '<') i += 1
    else clean.push(tokens[i])
  }
  const head = baseName(clean[0])
  const args = words(clean.slice(1)).filter(arg => !arg.startsWith('-'))
  if (head === 'tee' || head === 'touch' || head === 'rm' || head === 'rmdir' || head === 'mkdir' || head === 'truncate') {
    targets.push(...args)
  } else if ((head === 'cp' || head === 'mv' || head === 'ln' || head === 'install' || head === 'rsync') && args.length >= 2) {
    targets.push(args[args.length - 1])
    if (head === 'mv') targets.push(...args.slice(0, -1))
  } else if (head === 'sed' && clean.slice(1).some(arg => /^-[a-zA-Z]*i/.test(arg) || arg === '--in-place')) {
    const operands = []
    let scripted = false
    for (let i = 1; i < clean.length; i++) {
      if (clean[i] === '-e' || clean[i] === '-f') {
        scripted = true
        i += 1
      } else if (!clean[i].startsWith('-')) operands.push(clean[i])
    }
    targets.push(...(scripted ? operands : operands.slice(1)))
  }
  return targets.filter(target => !READ_ONLY_TARGETS.has(target))
}
