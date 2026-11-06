// The `enki` command. Output is short on purpose: it lands in the orchestrator's context.
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { ConfigError, findProjectRoot, loadConfig, ROLES } from './config.mjs'
import * as herdr from './herdr.mjs'
import * as task from './task.mjs'
import { EnkiError, EXIT } from './task.mjs'
import { writeRules } from './rules.mjs'
import { readState, resolveTask } from './state.mjs'

const USAGE = `enki: orchestration for Claude Code on herdr

Setup     enki doctor | enki init | enki validate | enki skills [--available]
Task      enki task new <slug> [--repo <name>]... | enki resume <slug> | enki status
Team      enki team start | enki start <role>
Work      enki ask <role> <brief-file> [--report <file>] [--step <name>] [--timeout <ms>]
          enki verify [--baseline] [--known-failures]
          enki wait <role> [--timeout <ms>] | enki read <role> [--lines <n>]
          enki answer <role> <option|trust> [--by user]
Server    enki server start|stop|restart|status [--repo <name>]
Progress  enki phase <name> | enki phase done --abandon | enki round next | enki rules
Browser   enki browser acquire | enki browser release

Add --task <slug> to act on a task other than the one bound to this pane.
Exit codes: 0 ok, 1 failed, 2 usage, 3 blocked, 4 timeout, 5 busy, 6 stalled.`

/** Workers may look. QA also runs the browser and the server. The rest belongs to the orchestrator. */
const WORKER_COMMANDS = new Set(['status', 'doctor', 'help'])
const QA_COMMANDS = new Set(['browser', 'server'])

const OPTIONS = {
  task: { type: 'string' },
  repo: { type: 'string', multiple: true },
  abandon: { type: 'boolean' },
  report: { type: 'string' },
  step: { type: 'string' },
  timeout: { type: 'string' },
  lines: { type: 'string' },
  by: { type: 'string' },
  baseline: { type: 'boolean' },
  'known-failures': { type: 'boolean' },
  available: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
}

function requireRoot() {
  const root = process.env.ENKI_PROJECT || findProjectRoot()
  if (!root) throw new EnkiError('This is not an enki project: no .enki/config.json here or above. Run /enki:init.')
  return root
}

const number = value => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new EnkiError(`Not a positive number: ${value}`, EXIT.usage)
  return parsed
}

const role = value => {
  if (!ROLES.includes(value)) throw new EnkiError(`Role must be one of: ${ROLES.join(', ')}`, EXIT.usage)
  return value
}

function emitResult(result) {
  console.log(`[${result.status}]`)
  if (result.output) console.log(result.output)
  return result.exitCode
}

function versionOf(command, args = ['--version']) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

async function doctor() {
  const checks = []
  const add = (ok, label, detail = '') => checks.push({ ok, label, detail })
  const major = Number(process.versions.node.split('.')[0])
  add(major >= 22, `Node ${process.versions.node}`, major >= 22 ? '' : 'Node 22 or newer is required')
  const herdrVersion = await herdr.version().catch(() => null)
  add(Boolean(herdrVersion), herdrVersion ?? 'herdr', herdrVersion ? '' : 'not found: install it from https://herdr.dev')
  add(herdr.inHerdr(), 'Running inside herdr', herdr.inHerdr() ? '' : 'start herdr, then run Claude in a pane')
  const claude = versionOf('claude')
  add(Boolean(claude), claude ?? 'claude', claude ? '' : 'not found on PATH')
  const root = process.env.ENKI_PROJECT || findProjectRoot()
  if (!root) add(false, 'Project config', 'no .enki/config.json: run /enki:init')
  else {
    try {
      const config = loadConfig(root)
      add(config.repos.length > 0, `Project config: ${config.repos.length} repo(s)`, config.repos.length > 0 ? '' : 'add repos to .enki/config.json')
    } catch (error) {
      add(false, 'Project config', error.message)
    }
  }
  for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.label}${check.detail ? `: ${check.detail}` : ''}`)
  return checks.every(check => check.ok) ? EXIT.ok : EXIT.failed
}

const commands = {
  help: () => console.log(USAGE),
  doctor,
  init() {
    const created = task.initProject(process.cwd())
    console.log(created.length > 0 ? `Created ${created.join(', ')}` : 'Already initialized.')
  },
  validate() {
    const root = requireRoot()
    const config = loadConfig(root)
    if (config.repos.length > 0) task.skillsReport({ root })
    console.log(`Valid: ${config.repos.length} repo(s), mode ${config.mode}, browser ${config.browser.driver}.`)
  },
  skills(args, flags) {
    const lines = task.skillsReport({ root: requireRoot(), available: flags.available })
    console.log(lines.length > 0 ? lines.join('\n') : 'None found.')
  },
  async task(args, flags) {
    if (args[0] !== 'new' || !args[1]) throw new EnkiError('Usage: enki task new <slug> [--repo <name>]...', EXIT.usage)
    const state = await task.newTask({ root: requireRoot(), slug: args[1], repoNames: flags.repo ?? [] })
    console.log(`Task ${state.id} created. Scout running: ${state.agents.scout.name}\nFolder: ${state.taskDir}\nTab: ${state.herdr.tab}`)
  },
  async team(args, flags) {
    const root = requireRoot()
    if (args[0] !== 'start') throw new EnkiError('Usage: enki team start', EXIT.usage)
    const { started } = await task.teamStart({ root, slug: flags.task })
    console.log(`Started: ${started.join(', ')}`)
  },
  async start(args, flags) {
    const target = role(args[0])
    const root = requireRoot()
    const current = resolveTask(root, { slug: flags.task })
    if (!current) throw new EnkiError('No task is bound to this pane.')
    if (target !== 'scout' && !current.approved) throw new EnkiError('Only the scout can start before the plan is approved.')
    console.log(`Running: ${await task.startRole(current.taskDir, target)}`)
  },
  async ask(args, flags) {
    if (args.length !== 2) throw new EnkiError('Usage: enki ask <role> <brief-file>', EXIT.usage)
    return emitResult(
      await task.ask({ root: requireRoot(), slug: flags.task, role: role(args[0]), briefPath: args[1], report: flags.report, step: flags.step, timeout: number(flags.timeout) }),
    )
  },
  async wait(args, flags) {
    return emitResult(await task.wait({ root: requireRoot(), slug: flags.task, role: role(args[0]), timeout: number(flags.timeout) }))
  },
  async read(args, flags) {
    console.log(await task.read({ root: requireRoot(), slug: flags.task, role: role(args[0]), lines: number(flags.lines) }))
  },
  async verify(args, flags) {
    return emitResult(
      await task.verify({ root: requireRoot(), slug: flags.task, baseline: flags.baseline, knownFailures: flags['known-failures'], timeout: number(flags.timeout) }),
    )
  },
  async answer(args, flags) {
    if (args.length !== 2) throw new EnkiError('Usage: enki answer <role> <option|trust> [--by user]', EXIT.usage)
    if (flags.by !== undefined && flags.by !== 'user') throw new EnkiError('--by only accepts "user".', EXIT.usage)
    console.log(await task.answer({ root: requireRoot(), slug: flags.task, role: role(args[0]), choice: args[1], by: flags.by }))
  },
  async status(args, flags) {
    console.log(await task.status({ root: requireRoot(), slug: flags.task }))
  },
  async resume(args) {
    if (!args[0]) throw new EnkiError('Usage: enki resume <slug>', EXIT.usage)
    console.log(await task.resume({ root: requireRoot(), slug: args[0] }))
  },
  async phase(args, flags) {
    const { phase, servers } = await task.setPhase({ root: requireRoot(), slug: flags.task, phase: args[0], abandon: flags.abandon })
    console.log([`Phase: ${phase}`, ...servers].join('\n'))
  },
  async server(args, flags) {
    if (!['start', 'stop', 'restart', 'status'].includes(args[0])) throw new EnkiError('Usage: enki server start|stop|restart|status [--repo <name>]', EXIT.usage)
    const lines = await task.serverCommand({ root: requireRoot(), slug: flags.task, action: args[0], repoName: flags.repo?.[0] })
    console.log(lines.length > 0 ? lines.join('\n') : 'No repo in this task has a URL.')
  },
  round(args, flags) {
    if (args[0] !== 'next') throw new EnkiError('Usage: enki round next', EXIT.usage)
    console.log(`Round: ${task.nextRound({ root: requireRoot(), slug: flags.task })}`)
  },
  rules(args, flags) {
    const root = requireRoot()
    const current = resolveTask(root, { slug: flags.task })
    if (!current) throw new EnkiError('No task is bound to this pane.')
    const state = readState(current.taskDir)
    writeRules(state, loadConfig(root))
    console.log(`${state.taskDir}/rules.md`)
  },
  browser(args, flags) {
    const root = requireRoot()
    if (args[0] === 'acquire') console.log(task.browserAcquire({ root, slug: flags.task }))
    else if (args[0] === 'release') console.log(task.browserRelease({ root, slug: flags.task }))
    else throw new EnkiError('Usage: enki browser acquire|release', EXIT.usage)
  },
}

export async function main(argv) {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (error) {
    console.error(error.message)
    return EXIT.usage
  }
  const [name = 'help', ...args] = parsed.positionals
  const command = commands[parsed.values.help ? 'help' : name]
  if (!command) {
    console.error(`Unknown command "${name}".\n\n${USAGE}`)
    return EXIT.usage
  }
  const qaCommand = process.env.ENKI_ROLE === 'qa' && QA_COMMANDS.has(name)
  if (process.env.ENKI_ROLE && !WORKER_COMMANDS.has(name) && !qaCommand) {
    console.error(`Workers can't run "enki ${name}". Put what you need in your report.`)
    return EXIT.failed
  }
  try {
    return (await command(args, parsed.values)) ?? EXIT.ok
  } catch (error) {
    if (error instanceof EnkiError) {
      console.error(error.message)
      return error.exitCode
    }
    if (error instanceof ConfigError || error instanceof herdr.HerdrError) {
      console.error(error.message)
      return EXIT.failed
    }
    throw error
  }
}
