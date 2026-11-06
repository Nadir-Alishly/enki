// Decides whether a tool call is allowed. Pure apart from reading the default policy once,
// so the whole rule set can be tested as a table. `null` means no objection: the normal
// permission flow still applies, because a hook's silence never approves anything.
import { readFileSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseCommand, writeTargets } from './shell.mjs'

const DEFAULT_POLICY = JSON.parse(readFileSync(new URL('../policy/default.json', import.meta.url), 'utf8'))

export const WORKER_ROLES = ['scout', 'coder', 'tester', 'qa', 'reviewer']

/** These roles judge the result from the requirements, so they don't get to see how it was built. */
export const BLIND_ROLES = new Set(['tester', 'qa'])
const HIDDEN_TASK_FILES = /^(coder|reviewer|role-coder|role-reviewer|approved-plan\.md$|plan\.md$)/

const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const STATE_FILES = new Set(['state.json', 'events.jsonl', 'approved-plan.md', 'rules.md'])
const REPORT_PREFIXES = {
  scout: ['scout'],
  coder: ['coder'],
  tester: ['tester', 'tests', 'baseline', 'gate-'],
  qa: ['qa'],
  reviewer: ['reviewer'],
}

export function globToRegExp(glob) {
  let source = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      i += 1
      if (glob[i + 1] === '/') {
        i += 1
        source += '(?:.*/)?'
      } else source += '.*'
    } else if (c === '*') source += '[^/]*'
    else if (c === '?') source += '[^/]'
    else source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${source}$`)
}

/** Patterns without a slash match a file name anywhere, as in .gitignore. */
export function matchesGlobs(path, globs) {
  const name = basename(path)
  return globs.some(glob => globToRegExp(glob).test(glob.includes('/') ? path : name))
}

const isInside = (path, dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** Resolves symlinks in the deepest existing parent, so a link can't point a write elsewhere. */
function canonical(path) {
  let current = path
  const missing = []
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

function toAbsolute(ctx, path) {
  const expanded = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path
  return canonical(isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.cwd, expanded))
}

function isSecret(path, ctx) {
  const name = basename(path)
  if (matchesGlobs(name, DEFAULT_POLICY.secretExceptions)) return false
  const inProject = relative(ctx.root, path).split(sep).join('/')
  return matchesGlobs(name, DEFAULT_POLICY.secrets) || matchesGlobs(inProject, ctx.config?.policy?.secrets ?? [])
}

/** A session's scratch space. Never an exception for the project itself, wherever that lives. */
function isScratch(ctx, path) {
  const dir = join(tmpdir(), `claude-${process.getuid?.() ?? 0}`)
  return isInside(path, dir) && !isInside(path, ctx.root)
}

function repoFor(ctx, path) {
  return ctx.state?.repos.find(repo => isInside(path, repo.workdir)) ?? null
}

function orchestratorWrite(ctx, path) {
  const enkiDir = join(ctx.root, '.enki')
  const home = homedir()
  if (isInside(path, enkiDir)) {
    if (STATE_FILES.has(basename(path)) && isInside(path, join(enkiDir, 'tasks'))) {
      return `${basename(path)} is written by enki, not edited by hand.`
    }
    return null
  }
  if (isInside(path, join(home, '.claude', 'plans'))) return null
  if (/\/\.claude\/projects\/[^/]+\/memory\//.test(`${path}`)) return null
  if (isScratch(ctx, path)) return null
  return 'The orchestrator never edits project files. Delegate this to the coder.'
}

function workerWrite(ctx, path) {
  const { role, state } = ctx
  if (!state) return 'This worker has no task state, so writes are refused.'
  if (isScratch(ctx, path)) return null

  if (isInside(path, state.taskDir)) {
    const name = relative(state.taskDir, path).split(sep)[0].replace(/^\./, '')
    const allowed = REPORT_PREFIXES[role].some(prefix => name.startsWith(prefix))
    return allowed ? null : `${role} may only write its own reports in the task folder, not ${name}.`
  }
  if (isInside(path, join(ctx.root, '.enki'))) return 'Notes, config and the playbook belong to the orchestrator. Suggest changes in your report.'
  if (role === 'scout' || role === 'reviewer' || role === 'qa') return `${role} is read-only, apart from its own report.`

  const repo = repoFor(ctx, path)
  if (!repo) return 'This path is outside the repos of this task.'
  const inRepo = relative(repo.workdir, path).split(sep).join('/')
  const isTest = matchesGlobs(inRepo, repo.testGlobs ?? [])

  if (role === 'tester') {
    return isTest ? null : `The tester only writes test files. Report the bug for the coder (${inRepo}).`
  }
  if (isTest) return `Test files belong to the tester (${inRepo}). Say what's needed in your report.`
  if (matchesGlobs(inRepo, DEFAULT_POLICY.infra) && !state.scope.includes('infra')) {
    return `Infra files need "Scope: infra" in the approved plan (${inRepo}).`
  }
  if (matchesGlobs(inRepo, DEFAULT_POLICY.depManifests) && !state.scope.includes('deps')) {
    return `Dependency files need "Scope: deps" in the approved plan (${inRepo}).`
  }
  return null
}

function checkWrite(ctx, rawPath) {
  const path = toAbsolute(ctx, rawPath)
  if (isSecret(path, ctx)) return `Secrets are off-limits: ${basename(path)}.`
  if (matchesGlobs(relative(ctx.root, path).split(sep).join('/'), ctx.config?.policy?.protected ?? [])) {
    return `This project protects ${relative(ctx.root, path)}.`
  }
  return ctx.role === 'orchestrator' ? orchestratorWrite(ctx, path) : workerWrite(ctx, path)
}

const isBlind = ctx => BLIND_ROLES.has(ctx.role) && Boolean(ctx.state)

/** Why a blind role can't read this path, or null. Takes an absolute path. */
function hiddenFrom(ctx, path) {
  if (!isBlind(ctx)) return null
  const { state } = ctx
  if (isInside(path, state.taskDir)) {
    const inTask = relative(state.taskDir, path).split(sep)
    const hidden = HIDDEN_TASK_FILES.test(inTask[0]) || (inTask[0] === 'briefs' && /coder|reviewer/.test(inTask.at(-1)))
    return hidden ? `The ${ctx.role} works from requirements.md, so ${inTask.at(-1)} is hidden.` : null
  }
  return state.blindFiles?.includes(path) ? `The ${ctx.role} works from the requirements, so the coder's change to ${basename(path)} is hidden. Test what it does, not how it's written.` : null
}

function bashRules(ctx) {
  const rules = [...DEFAULT_POLICY.bash, ...(ctx.config?.policy?.bash ?? [])]
  return rules
    .filter(rule => !rule.unlessScope || !ctx.state?.scope.includes(rule.unlessScope))
    .filter(rule => !rule.blindOnly || (isBlind(ctx) && ctx.state.blindFiles?.length > 0))
    .map(rule => ({ ...rule, regex: new RegExp(rule.pattern, rule.flags) }))
}

const isDynamic = word => /[$`]/.test(word)

const NOT_A_SERVER = new Set(['cd', 'export', 'echo', 'sleep', 'true'])

/**
 * Each project's own start and stop commands, so the server ban fits any stack.
 * Only the leading words count: the same server on another port or with other flags still matches.
 */
function serverCommands(ctx) {
  const found = []
  for (const repo of ctx.config?.repos ?? []) {
    for (const command of [repo.devServer?.start, repo.devServer?.stop]) {
      if (!command) continue
      for (const { tokens } of parseCommand(command)) {
        if (NOT_A_SERVER.has(tokens[0])) continue
        const end = tokens.findIndex((token, index) => index > 0 && /^-|^\d|:\d/.test(token))
        found.push(end === -1 ? tokens : tokens.slice(0, end))
      }
    }
  }
  return found
}

function checkBash(ctx, command) {
  const rules = bashRules(ctx)
  const servers = serverCommands(ctx)
  let cwd = ctx.cwd
  let cwdKnown = true
  for (const rule of rules) {
    if (rule.scope === 'command' && rule.regex.test(command)) return rule.reason
  }
  for (const parsed of parseCommand(command)) {
    for (const rule of rules) {
      if (rule.scope !== 'command' && rule.regex.test(parsed.text)) return rule.reason
    }
    if (servers.some(words => words.every((word, index) => parsed.tokens[index] === word))) {
      return 'Agents never start, stop or restart servers. Stop and report: the orchestrator runs enki server.'
    }
    for (const token of parsed.tokens.slice(1)) {
      if (token.startsWith('-')) continue
      if (isSecret(token, ctx)) return `Secrets are off-limits: ${basename(token)}.`
      if (isBlind(ctx) && !isDynamic(token) && (token.includes('.') || token.includes('/')) && cwdKnown) {
        const reason = hiddenFrom(ctx, toAbsolute({ ...ctx, cwd }, token))
        if (reason) return reason
      }
    }
    if (parsed.tokens[0] === 'cd') {
      const target = parsed.tokens[1] ?? homedir()
      cwdKnown = !isDynamic(target)
      if (cwdKnown) cwd = toAbsolute({ ...ctx, cwd }, target)
      continue
    }
    for (const target of writeTargets(parsed)) {
      // A path only the shell can resolve can't be judged here. The README states this limit.
      if (isDynamic(target) || (!cwdKnown && !isAbsolute(target) && !target.startsWith('~'))) continue
      const reason = checkWrite({ ...ctx, cwd }, target)
      if (reason) return reason
    }
  }
  return null
}

/** Returns a denial reason, or null. ctx: { role, root, cwd, config, state }. */
export function decide(ctx, tool, input = {}) {
  if (WRITE_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path
    return path ? checkWrite(ctx, path) : null
  }
  if (READ_TOOLS.has(tool)) {
    const path = input.file_path ?? input.notebook_path
    if (!path) return null
    const absolute = toAbsolute(ctx, path)
    return isSecret(absolute, ctx) ? `Secrets are off-limits: ${basename(path)}.` : hiddenFrom(ctx, absolute)
  }
  if (tool === 'Grep') {
    const target = toAbsolute(ctx, input.path ?? ctx.cwd)
    if (input.path && isSecret(target, ctx)) return `Secrets are off-limits: ${basename(input.path)}.`
    const hidden = hiddenFrom(ctx, target)
    if (hidden) return hidden
    const covers = isBlind(ctx) && ctx.state.blindFiles?.some(file => isInside(file, target))
    return covers ? `This search would reach the coder's changes. Search your test folders, or a file the coder didn't change.` : null
  }
  if (tool === 'Bash') return checkBash(ctx, input.command ?? '')
  return null
}

/** Default policy data, for rendering rules.md. */
export const defaultPolicy = () => DEFAULT_POLICY
