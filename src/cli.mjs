// The `enki` command. Output is short on purpose: it lands in the orchestrator's context.
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { ConfigError, DEFAULTS, findProjectRoot, ROLES } from './config.mjs'
import { loadProjectConfig, loadTaskConfig, migrate, MemoryError, syncMemory } from './memory.mjs'

const loadConfigDefaults = () => ({ ...DEFAULTS, browser: { ...DEFAULTS.browser } })
import { DashboardError, dashboardDisabled, dashboardStatus, dashboardUrl, ensureDashboard, stopDashboard } from './dashboard.mjs'
import * as herdr from './herdr.mjs'
import * as playwright from './playwright.mjs'
import * as task from './task.mjs'
import { EnkiError, EXIT } from './task.mjs'
import { raiseDashboardWindow } from './focus.mjs'
import { writeRules } from './rules.mjs'
import * as library from './library.mjs'
import { LibraryError } from './library.mjs'
import { loadRoles, stepCapabilities } from './agents.mjs'
import { phasesOf, readWorkflowSnapshot, upgradeWorkflow, workflowProblems } from './workflow.mjs'
import { readState, resolveTask } from './state.mjs'
import { loadSecrets, removeSecret, setSecret } from './secrets.mjs'

const USAGE = `enki: orchestration for Claude Code on herdr

Setup     enki doctor | enki init | enki validate | enki skills [--available]
Task      enki task new <name> [--repo <name>]... [--workflow <id>] [--on <task|branch>]
          enki resume <slug> | enki status
Team      enki team start | enki start <step>
Work      enki next | enki ask <step> <brief-file> [--step <n>[,<n>…]] [--report <file>] [--timeout <ms>]
          enki resume <step> [--note "..."] | enki outcome <step> <outcome> --by user [--note "..."]
          enki report <outcome> (workers)
          enki step <n> todo|active|done|failed
          enki verify [--baseline] [--known-failures]
          enki wait <step> [--timeout <ms>] | enki read <step> [--lines <n>]
          enki answer <step> <option|trust> [--by user]
Server    enki server start|stop|restart|status [--repo <name>]
Secrets   enki secret set <name> [<value>] | get <name> | list | remove <name>
Memory    enki migrate --memory repo|private | enki memory sync | enki memory merge <slug>
Progress  enki phase <name> | enki phase done --abandon | enki rules
Workflows enki workflow list | show <id> | use <id> | copy <id> <new-id> [--to library|project]
          enki workflow export <id> [--out <file>] | validate <file> | import <file> --by user
Agents    enki agent list | show <id> | copy <id> <new-id> | export <id> [--out <file>]
          enki agent validate <file> | import <file> --by user
Dashboard enki dashboard [--open] | enki dashboard status|stop|link
Browser   enki playwright status | enki playwright install [--browser]
          enki browser acquire | enki browser release (chrome driver only)

Add --task <slug> to act on a task other than the one bound to this pane.
Exit codes: 0 ok, 1 failed, 2 usage, 3 blocked, 4 timeout, 5 busy, 6 stalled.`

/** Workers may look. A step whose role has the server or browser capability also runs those. */
// Workers may read a secret a brief names, never set or remove one: the command itself checks.
const WORKER_COMMANDS = new Set(['status', 'doctor', 'help', 'report', 'secret'])
const CAPABILITY_COMMANDS = { server: 'server', browser: 'browser' }

/** The step this process is a worker for, if any. ENKI_ROLE is the older name. */
const workerStep = () => process.env.ENKI_STEP || process.env.ENKI_ROLE || null

function workerMay(name) {
  if (WORKER_COMMANDS.has(name)) return true
  const capability = CAPABILITY_COMMANDS[name]
  if (!capability || !process.env.ENKI_TASK) return false
  try {
    return Boolean(stepCapabilities(readState(process.env.ENKI_TASK), workerStep())?.[capability])
  } catch {
    return false
  }
}

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
  memory: { type: 'string' },
  browser: { type: 'boolean' },
  open: { type: 'boolean' },
  quiet: { type: 'boolean' },
  note: { type: 'string' },
  workflow: { type: 'string' },
  on: { type: 'string' },
  to: { type: 'string' },
  out: { type: 'string' },
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

/** A step's id. Which steps exist depends on the task's workflow, so the task checks the rest. */
const role = value => {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value)) throw new EnkiError('Name a step, such as coder or qa.', EXIT.usage)
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
      const config = loadProjectConfig(root)
      add(config.repos.length > 0, `Project config: ${config.repos.length} repo(s)`, config.repos.length > 0 ? '' : 'add repos to .enki/config.json')
      const migrated = JSON.parse(readFileSync(join(root, '.enki', 'config.json'), 'utf8')).memory !== undefined
      add(migrated, migrated ? `Memory: ${config.memory}` : 'Memory', migrated ? '' : 'old shared layout: run enki migrate --memory repo, or private for team repos')
      for (const warning of task.portWarnings(config)) console.log(warning)
      if (config.browser.driver === 'playwright' && config.repos.some(repo => repo.url)) {
        const problem = playwright.playwrightProblem(config)
        add(!problem, 'Playwright for QA', problem ?? '')
      }
    } catch (error) {
      add(false, 'Project config', error.message)
    }
  }
  for (const check of checks) console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.label}${check.detail ? `: ${check.detail}` : ''}`)
  return checks.every(check => check.ok) ? EXIT.ok : EXIT.failed
}

async function openInBrowser(url) {
  // ENKI_OPEN_BIN stands in for the system's opener in tests.
  const opener = process.env.ENKI_OPEN_BIN || (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open')
  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref()
  } catch {
    // No opener: the URL is printed anyway.
    return
  }
  // The browser may be on another virtual desktop, where the desktop won't hand it the focus.
  await raiseDashboardWindow()
}

/** The open task this pane orchestrates, when run inside an enki project; else null. */
function boundTask(slug) {
  const root = findProjectRoot()
  if (!root) return null
  try {
    const found = resolveTask(root, { slug })
    return found && found.phase !== 'done' ? found : null
  } catch {
    return null
  }
}

const taskPage = (url, found) => `${url}#/p/${encodeURIComponent(found.projectId)}/t/${encodeURIComponent(found.id)}`

/** Works from any folder: the dashboard covers every project, so it needs none. */
async function dashboard(args, flags) {
  if (args[0] === 'status') return console.log(await dashboardStatus())
  if (args[0] === 'stop') return console.log(await stopDashboard())
  if (args[0] === 'link') {
    // For the band above the orchestrator's prompt: what to show, without starting anything.
    const found = dashboardDisabled() ? null : boundTask(flags.task)
    return console.log(JSON.stringify({ url: dashboardUrl(), task: found && { slug: found.slug, phase: found.phase, url: taskPage(dashboardUrl(), found) } }))
  }
  if (args.length > 0) throw new EnkiError('Usage: enki dashboard [--open] | enki dashboard status|stop|link', EXIT.usage)
  try {
    const result = await ensureDashboard()
    // --quiet only silences the output: the prompt band's button relies on --open still opening.
    if (result.status === 'disabled') {
      if (!flags.quiet) console.log('The dashboard is turned off (ENKI_DASHBOARD=off).')
      return flags.open ? EXIT.failed : EXIT.ok
    }
    const said = { started: 'Started', updated: 'Updated and restarted', running: 'Running', starting: 'Starting' }[result.status]
    if (!flags.quiet) console.log(`${said}: ${result.url}`)
    // From an orchestrator's pane, straight to its task's page.
    const found = flags.open ? boundTask(flags.task) : null
    if (flags.open) await openInBrowser(found ? taskPage(result.url, found) : result.url)
  } catch (error) {
    if (flags.quiet) return EXIT.failed
    throw error
  }
}

const commands = {
  help: () => console.log(USAGE),
  dashboard,
  doctor,
  init() {
    const created = task.initProject(process.cwd())
    console.log(created.length > 0 ? `Created ${created.join(', ')}` : 'Already initialized.')
  },
  validate() {
    const root = requireRoot()
    const config = loadProjectConfig(root)
    if (config.repos.length > 0) task.skillsReport({ root })
    for (const warning of task.portWarnings(config)) console.log(warning)
    for (const warning of config.warnings) console.log(`warning: ${warning}`)
    console.log(`Valid: ${config.repos.length} repo(s), mode ${config.mode}, memory ${config.memory}, browser ${config.browser.driver}.`)
  },
  migrate(args, flags) {
    console.log(migrate(requireRoot(), flags.memory).join('\n'))
  },
  memory(args) {
    const root = requireRoot()
    if (args[0] === 'sync') {
      const { lines, blocked } = syncMemory(root)
      console.log(lines.length > 0 ? lines.join('\n') : 'Memory is up to date.')
      return blocked ? EXIT.failed : EXIT.ok
    }
    if (args[0] === 'merge' && args[1]) {
      const { lines, blocked } = syncMemory(root, { only: args[1] })
      console.log(lines.length > 0 ? lines.join('\n') : `No unmerged memory branch called ${args[1]}.`)
      return blocked ? EXIT.failed : EXIT.ok
    }
    throw new EnkiError('Usage: enki memory sync | enki memory merge <slug>', EXIT.usage)
  },
  secret(args) {
    const [action, name, ...rest] = args
    const root = requireRoot()
    if (workerStep() && !['get', 'list'].includes(action)) throw new EnkiError('Workers only read secrets: enki secret get <name>.', EXIT.usage)
    const config = loadProjectConfig(root)
    if (action === 'list') {
      const names = Object.keys(loadSecrets(config.id))
      return console.log(names.length ? names.join('\n') : 'No secrets. Store one with: enki secret set <name> <value>')
    }
    if (!name) throw new EnkiError('Usage: enki secret set <name> [<value>] | get <name> | list | remove <name>', EXIT.usage)
    if (action === 'get') {
      const value = loadSecrets(config.id)[name]
      if (value === undefined) throw new EnkiError(`No secret "${name}". See: enki secret list`, EXIT.failed)
      return process.stdout.write(`${value}\n`)
    }
    if (action === 'remove') return console.log(removeSecret(config.id, name) ? `Removed ${name}.` : `No secret "${name}".`)
    if (action !== 'set') throw new EnkiError('Usage: enki secret set <name> [<value>] | get <name> | list | remove <name>', EXIT.usage)
    // From the argument, else from stdin, so a value can stay off the command line.
    const value = rest.length ? rest.join(' ') : process.stdin.isTTY ? '' : readFileSync(0, 'utf8').replace(/\r?\n$/, '')
    try {
      setSecret(task.ensureProjectId(root, config), name, value)
    } catch (error) {
      throw new EnkiError(error.message, EXIT.usage)
    }
    console.log(`Stored ${name}, outside the repo. Name it in briefs: an agent reads it with enki secret get ${name}. Enki keeps its value out of its logs, and refuses to write it into files.`)
  },
  skills(args, flags) {
    const lines = task.skillsReport({ root: requireRoot(), available: flags.available })
    console.log(lines.length > 0 ? lines.join('\n') : 'None found.')
  },
  async task(args, flags) {
    if (args[0] !== 'new' || !args[1]) throw new EnkiError('Usage: enki task new <name> [--repo <name>]... [--workflow <id>] [--on <task|branch>]', EXIT.usage)
    const state = await task.newTask({ root: requireRoot(), name: args[1], repoNames: flags.repo ?? [], workflow: flags.workflow ?? null, on: flags.on ?? null })
    const running = Object.values(state.agents).map(agent => agent.name)
    console.log(
      [
        `Task ${state.id} created, workflow ${state.workflow}. Running: ${running.join(', ') || 'nothing yet'}`,
        `Folder: ${state.taskDir}`,
        ...state.worktrees.map(tree => (tree.continued ? `Continues branch ${tree.branch}, at ${tree.base.commit.slice(0, 7)}` : `Branch ${tree.branch}, from ${tree.base.branch}`)),
        ...(state.continues?.slug ? [`Earlier task: ${state.continues.taskDir} (its requirements.md, approved plan and report are what's already there)`] : []),
        `Tab: ${state.herdr.tab}`,
        `Next: write the user's request to ${state.taskDir}/request.md in their own words, then: enki next`,
      ].join('\n'),
    )
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
    const early = current.run ? phasesOf(readWorkflowSnapshot(current.taskDir)).before.has(target) : current.team?.[target]?.intake
    if (!early && !current.approved) throw new EnkiError('Only the steps before the plan (such as the scout and the planner) can start before it is approved.')
    console.log(`Running: ${await task.startRole(current.taskDir, target)}`)
  },
  async ask(args, flags) {
    if (args.length !== 2) throw new EnkiError('Usage: enki ask <step> <brief-file>', EXIT.usage)
    return emitResult(
      await task.ask({ root: requireRoot(), slug: flags.task, role: role(args[0]), briefPath: args[1], report: flags.report, step: flags.step === undefined ? undefined : String(flags.step).split(',').map(item => number(item.trim())), timeout: number(flags.timeout) }),
    )
  },
  async wait(args, flags) {
    return emitResult(await task.wait({ root: requireRoot(), slug: flags.task, role: role(args[0]), timeout: number(flags.timeout) }))
  },
  async read(args, flags) {
    console.log(await task.read({ root: requireRoot(), slug: flags.task, role: role(args[0]), lines: number(flags.lines) }))
  },
  step(args, flags) {
    if (args.length !== 2) throw new EnkiError('Usage: enki step <n> todo|active|done|failed', EXIT.usage)
    console.log(task.moveStep({ root: requireRoot(), slug: flags.task, n: number(args[0]), status: args[1] }))
  },
  async verify(args, flags) {
    return emitResult(
      await task.verify({ root: requireRoot(), slug: flags.task, step: args[0] ?? null, baseline: flags.baseline, knownFailures: flags['known-failures'], timeout: number(flags.timeout) }),
    )
  },
  workflow(args, flags) {
    const root = findProjectRoot()
    const [action, id, extra] = args
    if (action === 'list' || action === undefined) return console.log(library.listText(root, root ? loadProjectConfig(root).workflow : null))
    if (action === 'show' && id) return console.log(library.showText(root, id))
    if (action === 'use' && id) return console.log(library.useWorkflow(requireRoot(), id))
    if (action === 'copy' && id && extra) return console.log(library.copyWorkflow(root, id, extra, flags.to))
    if (action === 'export' && id) {
      const bundle = `${JSON.stringify(library.exportWorkflow(root, id), null, 2)}\n`
      if (!flags.out) return process.stdout.write(bundle)
      writeFileSync(flags.out, bundle)
      return console.log(`Exported ${id} to ${flags.out}.`)
    }
    if (action === 'validate' && id) {
      const bundle = library.readBundle(id)
      const { problems, warnings } = bundle.format ? library.inspectImport(root, bundle, flags.to) : { problems: workflowProblems(upgradeWorkflow(bundle), loadRoles(root)), warnings: [] }
      console.log([problems.length ? `Problems:\n${problems.map(problem => `  - ${problem}`).join('\n')}` : 'Sound: it can be used.', ...warnings.map(warning => `warning: ${warning}`)].join('\n'))
      return problems.length ? EXIT.failed : EXIT.ok
    }
    if (action === 'import' && id) {
      if (flags.by !== undefined && flags.by !== 'user') throw new EnkiError('--by only accepts "user".', EXIT.usage)
      return console.log(library.importText(root, library.readBundle(id), { to: flags.to, by: flags.by }))
    }
    throw new EnkiError('Usage: enki workflow list | show <id> | use <id> | copy <id> <new-id> [--to library|project] | export <id> [--out <file>] | validate <file> | import <file> [--to library|project] --by user', EXIT.usage)
  },
  /** Agents live in the user's library, for every project. */
  agent(args, flags) {
    const root = findProjectRoot()
    const [action, id, extra] = args
    if (action === 'list' || action === undefined) return console.log(library.listAgentsText(root))
    if (action === 'show' && id) return console.log(library.showAgentText(root, id))
    if (action === 'copy' && id && extra) return console.log(library.copyAgent(root, id, extra))
    if (action === 'export' && id) {
      const bundle = `${JSON.stringify(library.exportAgent(root, id), null, 2)}\n`
      if (!flags.out) return process.stdout.write(bundle)
      writeFileSync(flags.out, bundle)
      return console.log(`Exported ${id} to ${flags.out}.`)
    }
    if (action === 'validate' && id) {
      const { problems, warnings } = library.inspectAgentImport(root, library.readBundle(id))
      console.log([problems.length ? `Problems:\n${problems.map(problem => `  - ${problem}`).join('\n')}` : 'Sound: it can be imported.', ...warnings.map(warning => `warning: ${warning}`)].join('\n'))
      return problems.length ? EXIT.failed : EXIT.ok
    }
    if (action === 'import' && id) {
      if (flags.by !== undefined && flags.by !== 'user') throw new EnkiError('--by only accepts "user".', EXIT.usage)
      const bundle = library.readBundle(id)
      if (bundle?.format !== library.AGENT_FORMAT) throw new EnkiError(`${id} isn't an agent export. A workflow imports with: enki workflow import ${id} --by user`, EXIT.usage)
      return console.log(library.importText(root, bundle, { by: flags.by }))
    }
    throw new EnkiError('Usage: enki agent list | show <id> | copy <id> <new-id> | export <id> [--out <file>] | validate <file> | import <file> --by user', EXIT.usage)
  },
  next(args, flags) {
    console.log(task.next({ root: requireRoot(), slug: flags.task }))
  },
  report(args) {
    if (args.length !== 1) throw new EnkiError('Usage: enki report <outcome>', EXIT.usage)
    console.log(task.reportOutcome({ outcome: args[0] }))
  },
  outcome(args, flags) {
    if (args.length !== 2) throw new EnkiError('Usage: enki outcome <step> <outcome> --by user [--note "..."]', EXIT.usage)
    console.log(task.overrideOutcome({ root: requireRoot(), slug: flags.task, step: role(args[0]), outcome: args[1], by: flags.by, note: flags.note ?? null }))
  },
  async answer(args, flags) {
    if (args.length !== 2) throw new EnkiError('Usage: enki answer <step> <option|trust> [--by user]', EXIT.usage)
    if (flags.by !== undefined && flags.by !== 'user') throw new EnkiError('--by only accepts "user".', EXIT.usage)
    console.log(await task.answer({ root: requireRoot(), slug: flags.task, role: role(args[0]), choice: args[1], by: flags.by }))
  },
  async status(args, flags) {
    console.log(await task.status({ root: requireRoot(), slug: flags.task }))
  },
  async resume(args, flags) {
    if (!args[0]) throw new EnkiError('Usage: enki resume <step> [--note "..."] | enki resume <slug>', EXIT.usage)
    const root = requireRoot()
    // A step of the bound task that's with the orchestrator goes back to work; anything else is a task to pick up.
    const bound = resolveTask(root, { slug: flags.task })
    if (bound?.run?.steps[args[0]]?.status === 'handed-off') return console.log(task.resumeHandedOff({ root, slug: flags.task, step: args[0], note: flags.note }))
    if (flags.note !== undefined) throw new EnkiError(`${args[0]} isn't a step that's with you, so there's nothing to resume with a note.`)
    console.log(await task.resume({ root, slug: args[0] }))
  },
  async phase(args, flags) {
    const { phase, notes } = await task.setPhase({ root: requireRoot(), slug: flags.task, phase: args[0], abandon: flags.abandon })
    console.log([`Phase: ${phase}`, ...notes].join('\n'))
  },
  async server(args, flags) {
    if (!['start', 'stop', 'restart', 'status'].includes(args[0])) throw new EnkiError('Usage: enki server start|stop|restart|status [--repo <name>]', EXIT.usage)
    const lines = await task.serverCommand({ root: requireRoot(), slug: flags.task, action: args[0], repoName: flags.repo?.[0] })
    console.log(lines.length > 0 ? lines.join('\n') : 'No repo in this task has a URL.')
  },
  rules(args, flags) {
    const root = requireRoot()
    const current = resolveTask(root, { slug: flags.task })
    if (!current) throw new EnkiError('No task is bound to this pane.')
    const state = readState(current.taskDir)
    writeRules(state, loadTaskConfig(state))
    console.log(`${state.taskDir}/rules.md`)
  },
  playwright(args, flags) {
    const root = process.env.ENKI_PROJECT || findProjectRoot()
    const config = root ? loadProjectConfig(root) : loadConfigDefaults()
    if (args[0] === 'status') console.log(playwright.status(config).join('\n'))
    else if (args[0] === 'install') {
      console.log(playwright.install({ browser: flags.browser }).join('\n'))
      const problem = playwright.playwrightProblem(config)
      console.log(problem ? `Still needed: ${problem}` : 'Ready.')
    } else throw new EnkiError('Usage: enki playwright status | enki playwright install [--browser]', EXIT.usage)
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
  if (workerStep() && !workerMay(name)) {
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
    if (error instanceof ConfigError || error instanceof herdr.HerdrError || error instanceof MemoryError || error instanceof DashboardError || error instanceof LibraryError) {
      console.error(error.message)
      return EXIT.failed
    }
    throw error
  }
}
