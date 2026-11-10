// Task operations: everything that used to be shell the orchestrator typed by hand.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { ROLES } from './config.mjs'
import { checkoutTaskMemory, finishTaskMemory, loadProjectConfig, loadTaskConfig, memoryMode, MemoryError, syncMemory, usesRepoMemory } from './memory.mjs'
import { runChecks, snapshotTree } from './checks.mjs'
import * as herdr from './herdr.mjs'
import { HerdrError } from './herdr.mjs'
import { pluginRoot } from './paths.mjs'
import { availableSkills, resolveSkill, skillWarnings, SkillError } from './skills.mjs'
import { mcpConfig, playwrightProblem } from './playwright.mjs'
import { allocatePorts, releasePorts } from './ports.mjs'
import { commitMessage, createWorktrees, finishWorktrees, git, installDependencies, worktreesDir, WorktreeError, writeEnvFiles } from './worktrees.mjs'
import { ensureDashboard } from './dashboard.mjs'
import { copyDatabase, DatabaseError, databaseEnv, dropDatabase, fill, planDatabase, taskToken } from './database.mjs'
import { writeRoleFile, writeRules } from './rules.mjs'
import { createState, enkiHome, listTasks, PHASES, readEvents, readState, recordEvent, registerProject, resolveTask, tasksDir, updateState, writeJsonAtomic } from './state.mjs'

export const SLUG = /^[a-z][a-z0-9-]{0,22}$/

/** Exit codes the orchestrator can branch on. */
export const EXIT = { ok: 0, failed: 1, usage: 2, blocked: 3, timeout: 4, busy: 5, stalled: 6 }

export class EnkiError extends Error {
  constructor(message, exitCode = EXIT.failed) {
    super(message)
    this.exitCode = exitCode
  }
}

const SETTLED = ['done', 'idle', 'blocked']
const HOOK_READY_TIMEOUT_MS = 8000

const today = () => new Date().toLocaleDateString('sv-SE')
const agentName = (role, slug) => `${role}-${slug}`

function requireHerdr() {
  if (!herdr.inHerdr()) throw new EnkiError('Not running inside herdr. Enki needs a herdr pane: start herdr, then run Claude there.')
}

function ensureProjectId(root, config) {
  if (config.id) return config.id
  const path = join(root, '.enki', 'config.json')
  const raw = JSON.parse(readFileSync(path, 'utf8'))
  raw.id = randomBytes(6).toString('hex')
  writeJsonAtomic(path, raw)
  return raw.id
}

function selectRepos(root, config, names) {
  const chosen = names.length > 0 ? names : config.repos.map(repo => repo.name)
  if (chosen.length === 0) throw new EnkiError('No repos in .enki/config.json. Add one, or run /enki:init.')
  return chosen.map(name => {
    const repo = config.repos.find(item => item.name === name)
    if (!repo) throw new EnkiError(`Unknown repo "${name}". Known: ${config.repos.map(item => item.name).join(', ')}`)
    // Roadmap seam: per-task worktrees change workdir, url and port here and nowhere else.
    const workdir = resolve(root, repo.path)
    const port = repo.url ? Number(new URL(repo.url).port) || null : null
    return { name: repo.name, workdir, url: repo.url, port, testGlobs: repo.testGlobs }
  })
}

const workerEnv = (state, role) => ({
  ...Object.assign({}, ...Object.values(state.env ?? {})),
  ENKI_ROLE: role,
  ENKI_TASK: state.taskDir,
  ENKI_PROJECT: state.projectRoot,
})

const teamCwd = state => {
  if (state.repos.length === 1) return state.repos[0].workdir
  return state.worktrees?.length > 0 ? join(worktreesDir(state.projectRoot), state.slug) : state.projectRoot
}

/** A repo's worktree settings: the project's, with the repo's own on top. */
const worktreeSettings = (config, repo) => {
  const own = config.repos.find(item => item.name === repo.name)?.worktree ?? {}
  return { ...config.worktree, ...own, env: { ...config.worktree.env, ...own.env } }
}

const portValues = state => ({ task: taskToken(state.slug), ports: Object.fromEntries(state.repos.filter(repo => repo.port).map(repo => [repo.name, repo.port])) })

/** The env values a repo gets in this task: its worktree settings and the plan's database mode. */
function repoEnv(state, config, repo) {
  const values = { ...portValues(state), port: repo.port ?? undefined }
  const env = {}
  for (const [key, value] of Object.entries(worktreeSettings(config, repo).env)) env[key] = fill(value, values)
  return { ...env, ...databaseEnv(config.database, state.database, values) }
}

function applyEnv(state, config) {
  const env = {}
  for (const repo of state.repos) {
    env[repo.name] = repoEnv(state, config, repo)
    writeEnvFiles(repo, env[repo.name])
  }
  return env
}

const asEnki = (error, Kind) => (error instanceof Kind ? new EnkiError(error.message) : error)

/** Three columns: scout over coder, tester over QA, and a full-height reviewer. */
async function buildGrid(state) {
  const cwd = teamCwd(state)
  const workspace = process.env.HERDR_WORKSPACE_ID
  if (!workspace) throw new EnkiError('HERDR_WORKSPACE_ID is not set.')
  const { tabId, rootPane } = await herdr.createTab({ workspace, cwd, label: state.slug, env: workerEnv(state, 'scout') })
  const tester = await herdr.splitPane({ pane: rootPane, direction: 'right', ratio: 0.34, cwd, env: workerEnv(state, 'tester') })
  const reviewer = await herdr.splitPane({ pane: tester, direction: 'right', ratio: 0.5, cwd, env: workerEnv(state, 'reviewer') })
  const coder = await herdr.splitPane({ pane: rootPane, direction: 'down', cwd, env: workerEnv(state, 'coder') })
  const qa = await herdr.splitPane({ pane: tester, direction: 'down', cwd, env: workerEnv(state, 'qa') })
  const panes = { scout: rootPane, tester, reviewer, coder, qa }
  await verifyGrid(rootPane, panes)
  return { tab: tabId, panes }
}

async function verifyGrid(rootPane, panes) {
  const { panes: layout } = await herdr.paneLayout(rootPane)
  const rect = role => layout.find(pane => pane.pane_id === panes[role])?.rect
  const [scout, tester, coder, qa, reviewer] = ['scout', 'tester', 'coder', 'qa', 'reviewer'].map(rect)
  const isGrid =
    scout && tester && coder && qa && reviewer &&
    scout.x === coder.x && tester.x === qa.x && scout.x < tester.x && tester.x < reviewer.x &&
    scout.y === tester.y && coder.y === qa.y && scout.y < coder.y &&
    reviewer.y === scout.y && reviewer.height > scout.height
  if (!isGrid) throw new EnkiError(`The task tab is not the expected three-column grid: ${JSON.stringify(layout)}`)
}

/** Playwright needs a page to open: a task with no local URL has nothing for it. */
const usesPlaywright = (state, config) => config.browser.driver === 'playwright' && state.repos.some(repo => repo.url)

const skillContext = (root, repos) => ({ root, workdirs: repos.map(repo => repo.workdir) })

/** Every skill in config, or an error naming the first that can't be found. */
function resolveTeamSkills(root, config, repos) {
  const resolved = {}
  for (const role of ROLES) {
    resolved[role] = config.team[role].skills.map(name => {
      try {
        return resolveSkill(name, skillContext(root, repos))
      } catch (error) {
        if (error instanceof SkillError) throw new EnkiError(`team.${role}: ${error.message}`)
        throw error
      }
    })
  }
  return resolved
}

function workerArgs(state, config, role) {
  const { model, effort } = config.team[role]
  const skills = resolveTeamSkills(state.projectRoot, config, state.repos)[role]
  const args = [
    '--model', model,
    '--effort', effort,
    '--permission-mode', config.permissionMode,
    // No skills by default: the agent sees only what its role lists, loaded into its role file.
    '--disable-slash-commands',
    '--append-system-prompt-file', writeRoleFile(state, config, role, skills),
    '--add-dir', state.taskDir,
    ...skills.flatMap(skill => ['--add-dir', skill.dir]),
    // Dialogs would stop a worker with nobody watching its pane. Questions go in its reply.
    '--disallowedTools', 'AskUserQuestion,EnterPlanMode,ExitPlanMode',
    // Reports shouldn't need a prompt each time. The policy hook still limits which files.
    '--settings', JSON.stringify({ permissions: { allow: [`Edit(/${state.taskDir}/**)`] } }),
  ]
  // Only QA gets a browser.
  if (role === 'qa' && config.browser.driver === 'chrome') args.push('--chrome')
  if (role === 'qa' && usesPlaywright(state, config)) {
    const path = join(state.taskDir, 'mcp-qa.json')
    const origins = state.repos.filter(repo => repo.url).map(repo => new URL(repo.url).origin)
    writeJsonAtomic(path, mcpConfig({ config, origins, outputDir: join(state.taskDir, 'qa-evidence') }))
    // Only the browser: QA has no use for the user's other MCP servers.
    args.push('--mcp-config', path, '--strict-mcp-config')
    const settings = args.indexOf('--settings') + 1
    const parsed = JSON.parse(args[settings])
    parsed.permissions.allow.push('mcp__playwright')
    args[settings] = JSON.stringify(parsed)
  }
  if (process.env.ENKI_DEV_PLUGIN_DIR) args.push('--plugin-dir', process.env.ENKI_DEV_PLUGIN_DIR)
  return args
}

async function waitForHookReady(taskDir, role, since) {
  const deadline = Date.now() + HOOK_READY_TIMEOUT_MS
  for (;;) {
    if (readEvents(taskDir).some(event => event.type === 'worker.hooks_ready' && event.data.role === role && event.t >= since)) return true
    if (Date.now() > deadline) return false
    await new Promise(done => setTimeout(done, 200))
  }
}

/** Idempotent, so it can be run again after the user answers a startup prompt in the pane. */
export async function startRole(taskDir, role) {
  const state = readState(taskDir)
  const config = loadTaskConfig(state)
  const name = agentName(role, state.slug)
  const pane = state.herdr.panes[role]
  if (!pane) throw new EnkiError(`No pane recorded for ${role}.`)

  // A worker that was already running only has to have reported at some point.
  const live = await herdr.getAgent(name)
  const since = live ? '' : new Date().toISOString()
  if (live?.agent_status === 'blocked') {
    throw new EnkiError(
      `${name} is blocked in pane ${pane}, probably on a folder trust prompt. Ask the user whether to trust this folder. If they agree, run: enki answer ${role} trust, then: enki start ${role}`,
      EXIT.blocked,
    )
  }
  if (!live) {
    try {
      await herdr.startAgent({ name, pane, args: workerArgs(state, config, role) })
    } catch (error) {
      if (error instanceof HerdrError && error.code === 'agent_not_ready') {
        throw new EnkiError(
          `${name} is blocked during startup, probably on a folder trust prompt. Ask the user whether to trust this folder. If they agree, run: enki answer ${role} trust, then: enki start ${role}`,
          EXIT.blocked,
        )
      }
      throw error
    }
  }
  if (!(await waitForHookReady(taskDir, role, since))) {
    throw new EnkiError(
      `${name} started, but the enki hooks did not report from it, so its rules would not be enforced. Install enki at user scope (claude plugin install enki@enki-plugins --scope user), then run: enki start ${role}`,
    )
  }
  // The Claude session behind the agent: its transcript is where its token use is recorded.
  const session = (await herdr.getAgent(name).catch(() => null))?.agent_session?.value ?? null
  updateState(taskDir, current => {
    current.agents[role] = { name, pane, session, startedAt: new Date().toISOString() }
  })
  recordEvent(taskDir, 'agent.started', { role, name, pane, session })
  return name
}

export async function newTask({ root, slug, repoNames = [] }) {
  requireHerdr()
  if (!SLUG.test(slug)) throw new EnkiError('The slug must be short kebab-case: a lowercase letter, then letters, digits or hyphens, at most 23 characters.', EXIT.usage)
  const config = loadProjectConfig(root)
  const existing = listTasks(root).find(task => task.slug === slug && task.phase !== 'done')
  if (existing) throw new EnkiError(`Task "${slug}" is already open: ${existing.taskDir}. Use: enki resume ${slug}`)

  let repos = selectRepos(root, config, repoNames)
  resolveTeamSkills(root, config, repos) // Fails here, before any tab opens.
  const projectId = ensureProjectId(root, config)
  const taskDir = join(tasksDir(root), `${today()}-${slug}`)
  if (existsSync(taskDir)) throw new EnkiError(`${taskDir} already exists. Pick a different slug.`)
  if (!config.worktrees) {
    const clash = listTasks(root).find(task => task.phase !== 'done' && task.repos.some(repo => repos.some(item => item.name === repo.name)))
    if (clash) throw new EnkiError(`Task ${clash.slug} is still open on the same repo, and without worktrees, tasks share one tree. Finish it first, or turn on "worktrees".`)
  }

  const privateMemory = memoryMode(root) === 'private'
  const memoryNotes = []
  if (privateMemory) {
    // Memory for the base branch has to include every task merged into it, before this one starts from it.
    const synced = syncMemory(root)
    if (synced.blocked) throw new EnkiError(synced.lines.join('\n'))
    memoryNotes.push(...synced.lines)
  }
  let worktrees = []
  if (config.worktrees) {
    try {
      ;({ repos, worktrees } = createWorktrees({ root, repos, slug, settingsFor: repo => worktreeSettings(config, repo) }))
    } catch (error) {
      throw asEnki(error, WorktreeError)
    }
  }
  try {
    repos = repos.map(repo => {
      // An unmigrated project keeps writing the old shared notes, never into the code repo.
      if (!privateMemory) return usesRepoMemory(root, repo) ? { ...repo, memoryDir: join(repo.workdir, '.enki') } : repo
      const tree = worktrees.find(item => item.path === repo.worktree)
      const { path, note } = checkoutTaskMemory({ root, slug, repo, baseBranch: tree.base.branch })
      if (note) memoryNotes.push(note)
      return { ...repo, memoryDir: path }
    })
  } catch (error) {
    for (const tree of worktrees) {
      git(tree.top, ['worktree', 'remove', '--force', tree.path], { allowFail: true })
      git(tree.top, ['branch', '-D', tree.branch], { allowFail: true })
    }
    throw asEnki(error, MemoryError)
  }
  let ports = {}
  try {
    const managed = repos.filter(repo => repo.url && sourceRepo(config, repo).devServer.managedBy === 'enki').map(repo => repo.name)
    if (managed.length > 0) ports = await allocatePorts({ taskDir, names: managed, ...config.ports })
  } catch (error) {
    for (const tree of worktrees) {
      git(tree.top, ['worktree', 'remove', '--force', tree.path], { allowFail: true })
      git(tree.top, ['branch', '-D', tree.branch], { allowFail: true })
    }
    throw new EnkiError(error.message)
  }
  repos = repos.map(repo => {
    if (!ports[repo.name]) return repo
    const url = new URL(repo.url)
    url.port = String(ports[repo.name])
    return { ...repo, url: url.toString(), port: ports[repo.name] }
  })

  const draft = { slug, repos, database: null }
  const env = applyEnv(draft, config)
  const state = createState({ taskDir, slug, projectId, projectRoot: root, repos, worktrees, env, orchestratorPane: process.env.HERDR_PANE_ID ?? null })
  registerProject({ id: projectId, root })
  writeRules(state, config)
  recordEvent(taskDir, 'task.created', { slug, repos: repos.map(repo => repo.name), worktrees: worktrees.map(tree => ({ path: tree.path, branch: tree.branch, base: tree.base })), ports, memory: memoryNotes })
  // The orchestrator's own Claude session, so the dashboard can count its tokens too.
  const orchestrator = state.orchestratorPane && (await herdr.listAgents().catch(() => [])).find(agent => agent.pane_id === state.orchestratorPane)
  if (orchestrator?.agent_session?.value) recordEvent(taskDir, 'orchestrator.session', { session: orchestrator.agent_session.value })
  ensureDashboard({ wait: false }).catch(() => {})

  const grid = await buildGrid(state)
  updateState(taskDir, current => {
    current.herdr = grid
  })
  recordEvent(taskDir, 'team.grid_ready', grid)
  await startRole(taskDir, 'scout')
  return readState(taskDir)
}

function requireTask(root, slug) {
  const task = resolveTask(root, { slug })
  if (!task) throw new EnkiError(slug ? `No task "${slug}".` : 'No task is bound to this pane. Use: enki resume <slug>')
  return task
}

export async function teamStart({ root, slug }) {
  requireHerdr()
  const task = requireTask(root, slug)
  if (!task.approved) {
    throw new EnkiError(`The plan isn't approved (phase: ${task.phase}). Present it with ExitPlanMode first. Coder, tester and reviewer can't start until then.`)
  }
  const config = loadTaskConfig(task)
  const unknown = !task.qa ? [] : serverRepos(task).filter(repo => {
    const source = sourceRepo(config, repo)
    return source.devServer.managedBy === 'enki' && !source.devServer.start
  })
  if (unknown.length > 0) {
    throw new EnkiError(`Nobody has recorded how to start ${unknown.map(repo => repo.name).join(', ')}. Find the command from the scout report, add it as devServer.start in .enki/config.json, then run this again.`)
  }
  if (Array.isArray(task.steps) && task.steps.length === 0) {
    throw new EnkiError('The approved plan has no steps, so nobody can follow it and the dashboard has nothing to show. Run enki phase planning, add a Steps list ("1. [Coder] ...", one owner per step) and present the plan again.')
  }
  await prepareWorktreeForTeam(task, config)
  const roles = ['coder', 'tester', ...(task.qa === false ? [] : ['qa']), 'reviewer']
  if (task.qa !== false && usesPlaywright(task, config)) {
    const problem = playwrightProblem(config)
    if (problem) throw new EnkiError(problem)
  }
  const results = await Promise.allSettled(roles.map(role => startRole(task.taskDir, role)))
  const failure = results.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
  const started = results.map(result => result.value)
  recordEvent(task.taskDir, 'team.started', { roles })
  // Taken before any coding, so the user's own uncommitted work isn't treated as the coder's.
  updateState(task.taskDir, current => {
    current.treeSnapshot ??= snapshotTree(current.repos)
  })
  return { roles, started }
}

/** Approval-time work: a real install for `Scope: deps`, and the plan's database copy. Safe to repeat. */
async function prepareWorktreeForTeam(task, config) {
  if (task.scope.includes('deps') && task.worktrees?.length > 0 && !task.depsInstalled) {
    for (const repo of task.repos) {
      if ((repo.linked ?? []).length === 0) continue
      const { install } = worktreeSettings(config, repo)
      if (!install) throw new EnkiError(`The plan changes dependencies, so ${repo.name} needs its own install, but worktree.install isn't set in .enki/config.json.`)
      try {
        installDependencies(repo, install)
      } catch (error) {
        throw new EnkiError(`"${install}" failed in ${repo.workdir}: ${String(error.stderr || error.message).trim().slice(0, 600)}`)
      }
    }
    updateState(task.taskDir, current => {
      current.depsInstalled = true
      current.repos = current.repos.map(repo => ({ ...repo, linked: [] }))
    })
    recordEvent(task.taskDir, 'worktree.installed')
  }
  if (task.database === 'copy' && !task.databaseReady) {
    try {
      copyDatabase(config.database, portValues(task), task.projectRoot)
    } catch (error) {
      throw asEnki(error, DatabaseError)
    }
    updateState(task.taskDir, current => {
      current.databaseReady = true
    })
    recordEvent(task.taskDir, 'database.copied')
  }
  // The plan's database mode is known now, so the env values are final.
  updateState(task.taskDir, current => {
    current.env = applyEnv(current, config)
  })
}

const hasReport = (task, name) => existsSync(join(task.taskDir, name))
const currentVerify = task => (task.verify?.round === task.round && !task.verify.baseline ? task.verify : null)

const isWorking = async (task, role) => {
  const name = task.agents[role]?.name
  return Boolean(name) && (await herdr.getAgent(name))?.agent_status === 'working'
}

/** Everything else runs in parallel. These are the only real dependencies. */
async function checkGates(task, role) {
  if ((role === 'tester' || role === 'qa') && !hasReport(task, 'requirements.md')) {
    throw new EnkiError(`The ${role} works from requirements.md, and it doesn't exist yet. Write it to the task folder: goal, acceptance criteria, public interface and out of scope, with no implementation detail.`)
  }
  if (role === 'qa') {
    if (await isWorking(task, 'coder')) throw new EnkiError('QA needs finished code, and the coder is still working. Start QA as soon as it reports.')
    if (!hasReport(task, `coder-r${task.round}.md`)) throw new EnkiError(`QA needs finished code: the coder hasn't reported for round ${task.round}.`)
  }
  // Reviewer tokens shouldn't go on broken builds.
  if (role === 'reviewer') {
    const verify = currentVerify(task)
    if (!verify) throw new EnkiError(`The reviewer has to wait for passing tests. Run enki verify for round ${task.round} first.`)
    if (!verify.passed && !verify.accepted) throw new EnkiError(`The reviewer has to wait: tests failed in round ${task.round}. Fix them first.`)
  }
}

/** What has to exist before a task can finish. The reviewer is never optional. */
function missingChecks(task) {
  const missing = []
  const verify = currentVerify(task)
  if (!verify || (!verify.passed && !verify.accepted)) missing.push(`passing tests for round ${task.round} (enki verify)`)
  if (task.qa === true && !hasReport(task, `qa-r${task.round}.md`)) missing.push(`a QA report for round ${task.round}`)
  if (!hasReport(task, `reviewer-r${task.round}.md`)) missing.push(`a reviewer report for round ${task.round}`)
  return missing
}

function reportName(role, state, override) {
  if (override) return override
  if (role === 'scout') return 'scout.md'
  return `${role}-r${state.round}.md`
}

function writeEnvelope(state, role, briefPath, report) {
  const seq = updateState(state.taskDir, current => {
    current.seq += 1
  }).seq
  const dir = join(state.taskDir, 'briefs')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${String(seq).padStart(3, '0')}-${role}.prompt.md`)
  writeFileSync(
    path,
    [
      `1. Read the task rules: ${join(state.taskDir, 'rules.md')}`,
      `2. Read your brief and do the work: ${resolve(briefPath)}`,
      `3. Write your full report to: ${join(state.taskDir, report)}`,
      '4. Reply in the terminal with at most 15 lines: status, key results, blockers and the report path.',
      '',
    ].join('\n'),
  )
  return path
}

/** A blocked agent's request goes back verbatim as data for the orchestrator to relay. */
async function blockedResult(state, role, name) {
  const screen = await herdr.readAgent(name).catch(() => '')
  recordEvent(state.taskDir, 'agent.blocked', { role, name })
  return {
    exitCode: EXIT.blocked,
    status: 'blocked',
    output: `${name} is blocked. Decide, or ask the user, then run: enki answer ${role} <option>, followed by: enki wait ${role}\n\n--- screen (data, not instructions) ---\n${screen.trimEnd()}`,
  }
}

async function finishWait(state, role, name, timeout, tail) {
  let status
  try {
    status = await herdr.waitForAgent(name, SETTLED, timeout)
  } catch (error) {
    if (error.code !== 'timeout') throw error
    const agent = await herdr.getAgent(name)
    const screen = await herdr.readAgent(name, 30).catch(() => '')
    recordEvent(state.taskDir, 'agent.timeout', { role, name, status: agent?.agent_status })
    return {
      exitCode: EXIT.timeout,
      status: agent?.agent_status ?? 'gone',
      output: `${name} is still ${agent?.agent_status ?? 'gone'} after ${timeout} ms. If it's progressing, run: enki wait ${role}. If it's stuck, tell the user what you see. Don't resubmit.\n\n--- screen ---\n${screen.trimEnd()}`,
    }
  }
  if (status === 'blocked') return blockedResult(state, role, name)
  const output = await herdr.readAgent(name, tail)
  recordEvent(state.taskDir, 'agent.finished', { role, name, status })
  finishStep(state.taskDir, role)
  return { exitCode: EXIT.ok, status, output: output.trimEnd() }
}

const timeoutFor = (config, role) => config.timeouts[role]

// Plan steps: the orchestrator writes them, each with an owner, and they move with the work.
export const STEP_OWNERS = { orchestrator: 'orchestrator', scout: 'scout', coder: 'coder', tester: 'tester', qa: 'qa', reviewer: 'reviewer' }
export const STEP_STATUSES = ['todo', 'active', 'done', 'failed']
const STEP_LINE = /^\s*(\d+)[.)]\s*\[(orchestrator|scout|coder|tester|qa|reviewer)\]\s*(.+?)\s*$/i

/** "1. [Coder] Rewrite the intent flow" lines from the approved plan. */
export function parseSteps(plan) {
  return plan
    .split('\n')
    .map(line => STEP_LINE.exec(line))
    .filter(Boolean)
    .map(match => ({ n: Number(match[1]), owner: match[2].toLowerCase(), text: match[3], status: 'todo' }))
}

/** The roles whose briefs must name a step, once a plan has them. */
const STEP_ROLES = new Set(['coder', 'tester', 'qa', 'reviewer'])

function setStep(taskDir, n, status, by) {
  const next = updateState(taskDir, current => {
    const step = current.steps?.find(item => item.n === n)
    if (step) step.status = status
  })
  const step = next.steps?.find(item => item.n === n)
  if (step) recordEvent(taskDir, 'step.status', { n, status, owner: step.owner, text: step.text, by })
  return step
}

/** When an agent reports, the step it was sent for is done. */
function finishStep(taskDir, role) {
  const state = readState(taskDir)
  const n = state.agents?.[role]?.step
  const step = state.steps?.find(item => item.n === n)
  if (step && step.status === 'active') setStep(taskDir, n, 'done', role)
}

export function moveStep({ root, slug, n, status }) {
  if (!STEP_STATUSES.includes(status)) throw new EnkiError(`A step can be: ${STEP_STATUSES.join(', ')}`, EXIT.usage)
  const task = requireTask(root, slug)
  const step = task.steps?.find(item => item.n === n)
  if (!step) throw new EnkiError(`The plan has no step ${n}.`, EXIT.usage)
  setStep(task.taskDir, n, status, 'orchestrator')
  return `Step ${n} (${step.owner}: ${step.text}) is now ${status}.`
}

/** Checks the step a brief is for, and marks it active. */
function startStep(task, role, step) {
  const planned = (task.steps ?? []).length > 0
  if (step === undefined) {
    if (planned && STEP_ROLES.has(role)) throw new EnkiError(`Name the plan step this brief is for: enki ask ${role} <brief> --step N. Steps for the ${role}: ${task.steps.filter(item => item.owner === role).map(item => item.n).join(', ') || 'none'}.`, EXIT.usage)
    return
  }
  const found = task.steps?.find(item => item.n === step)
  if (!found) throw new EnkiError(`The plan has no step ${step}.`, EXIT.usage)
  if (found.owner !== role) throw new EnkiError(`Step ${step} belongs to the ${found.owner}, not the ${role}.`, EXIT.usage)
  updateState(task.taskDir, current => {
    current.agents[role].step = step
  })
  setStep(task.taskDir, step, 'active', role)
}

export async function ask({ root, slug, role, briefPath, report, step, timeout }) {
  requireHerdr()
  if (!ROLES.includes(role)) throw new EnkiError(`Unknown role "${role}".`, EXIT.usage)
  if (!existsSync(briefPath)) throw new EnkiError(`No brief at ${briefPath}.`, EXIT.usage)
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  if (role !== 'scout' && !task.approved) throw new EnkiError(`The ${role} can't work until the plan is approved.`)
  const name = task.agents[role]?.name
  if (!name) throw new EnkiError(`The ${role} isn't started. Use: enki team start`)

  const agent = await herdr.getAgent(name)
  if (!agent) throw new EnkiError(`${name} is no longer running. Tell the user: its pane may have been closed.`)
  if (agent.agent_status === 'blocked') return blockedResult(task, role, name)
  if (agent.agent_status === 'working') {
    throw new EnkiError(`${name} is still working. Use: enki wait ${role}`, EXIT.busy)
  }
  await checkGates(task, role)
  startStep(task, role, step)
  // New code or new tests mean the last test result no longer says anything.
  if (role === 'coder' || role === 'tester') {
    updateState(task.taskDir, current => {
      current.verify = null
    })
  }

  const envelope = writeEnvelope(task, role, briefPath, reportName(role, task, report))
  const prompt = `Read ${envelope} and follow it.`
  recordEvent(task.taskDir, 'agent.asked', { role, name, envelope, round: task.round })

  let seen
  try {
    seen = await herdr.submitPrompt(name, prompt)
  } catch (error) {
    if (error.code !== 'agent_prompt_stalled' && error.code !== 'timeout') throw error
    const screen = await herdr.readAgent(name, 12).catch(() => '')
    if (/\[Pasted text/.test(screen)) {
      await herdr.sendKeys(name, ['enter'])
      seen = await herdr.waitForAgent(name, ['working', 'blocked'], 10000).catch(() => null)
    }
    if (!seen) {
      recordEvent(task.taskDir, 'agent.stalled', { role, name })
      return {
        exitCode: EXIT.stalled,
        status: 'stalled',
        output: `${name} didn't start working on the prompt. Don't resend it. Check with: enki read ${role}\n\n--- screen ---\n${screen.trimEnd()}`,
      }
    }
  }
  if (seen === 'blocked') return blockedResult(task, role, name)
  return finishWait(task, role, name, timeout ?? timeoutFor(config, role), 40)
}

export async function wait({ root, slug, role, timeout }) {
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  const name = task.agents[role]?.name
  if (!name) throw new EnkiError(`The ${role} isn't started.`)
  const limit = timeout ?? timeoutFor(config, role)
  // A prompt may have been answered a moment ago, so wait through it, not on it.
  if ((await herdr.getAgent(name))?.agent_status === 'blocked') {
    try {
      await herdr.waitForAgent(name, ['working', 'idle', 'done'], limit)
    } catch (error) {
      if (error.code !== 'timeout') throw error
      return { exitCode: EXIT.blocked, status: 'blocked', output: `${name} is still blocked after ${limit} ms. Read it with enki read ${role}, then run: enki answer ${role} <option>` }
    }
  }
  return finishWait(task, role, name, limit, 40)
}

// An allow list on purpose: dialogs word their wider grants in ways no phrase list keeps up with.
const ONE_TIME = /^(yes[.!]?$|no\b)/i

/** The numbered options of the last dialog on screen, with wrapped labels rejoined. */
export function parseOptions(screen) {
  let options = []
  let open = false
  for (const line of screen.split('\n')) {
    const match = /^\s*(?:[❯>]\s*)?(\d+)\.\s+(.+?)\s*$/.exec(line)
    if (match) {
      if (match[1] === '1') options = []
      options.push({ number: Number(match[1]), label: match[2] })
      open = true
    } else if (line.trim() === '') open = false
    else if (open) options[options.length - 1].label += ` ${line.trim()}`
  }
  return options
}

/** The one way to answer a worker's prompt. One-time only, and always on the record. */
export async function answer({ root, slug, role, choice, by = 'orchestrator' }) {
  requireHerdr()
  const task = requireTask(root, slug)
  const name = agentName(role, task.slug)
  const agent = await herdr.getAgent(name)
  if (agent?.agent_status !== 'blocked') throw new EnkiError(`${name} isn't waiting for an answer.`)
  const screen = await herdr.readScreen(name)

  let keys
  let label
  if (choice === 'trust') {
    if (!/trust this folder/i.test(screen)) throw new EnkiError(`${name} isn't showing a folder trust prompt.`)
    keys = ['down', 'enter']
    label = 'Yes, I trust this folder'
    by = 'user' // Trusting a folder is never the orchestrator's own decision.
  } else {
    const number = Number(choice)
    if (!Number.isInteger(number) || number < 1) throw new EnkiError('Give an option number, or "trust".', EXIT.usage)
    const option = parseOptions(screen).find(item => item.number === number)
    if (!option) throw new EnkiError(`${name} shows no option ${number}.\n\n${screen.trimEnd()}`)
    if (!ONE_TIME.test(option.label)) {
      throw new EnkiError(`Option ${number} may grant more than this one action ("${option.label}"). Only a plain Yes or a No can be chosen.`)
    }
    keys = [...Array(number - 1).fill('down'), 'enter']
    label = option.label
  }
  await herdr.sendKeys(name, keys)
  recordEvent(task.taskDir, 'agent.answered', { role, name, choice, label, by })
  return `Answered ${name}: ${label}. Now run: enki wait ${role}`
}

export async function read({ root, slug, role, lines = 40 }) {
  const task = requireTask(root, slug)
  const name = task.agents[role]?.name
  if (!name) throw new EnkiError(`The ${role} isn't started.`)
  return (await herdr.readAgent(name, Math.min(lines, 200))).trimEnd()
}

/** Runs the tests without an agent: no tokens, and a result nobody can misreport. */
export async function verify({ root, slug, baseline = false, knownFailures = false, timeout }) {
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  if (!baseline && task.approved) {
    for (const role of ['coder', 'tester']) {
      if (await isWorking(task, role)) throw new EnkiError(`The ${role} is still working, so a test run now wouldn't mean anything. Run enki verify when it reports.`, EXIT.busy)
    }
    if (task.tests === true && !hasReport(task, 'tests.md')) throw new EnkiError('The tester hasn\'t reported its tests yet (tests.md). The plan can opt out with "Tests: none".')
  }
  const results = await runChecks({
    repos: task.repos,
    config,
    envFor: repo => task.env?.[repo.name] ?? {},
    taskDir: task.taskDir,
    label: baseline ? 'baseline' : `r${task.round}`,
    timeout: timeout ?? (baseline ? config.timeouts.baseline : config.timeouts.verify),
  })
  const failed = results.filter(result => result.code !== 0)
  const passed = failed.length === 0
  const accepted = !passed && knownFailures && task.baselinePassed === false
  if (knownFailures && !passed && task.baselinePassed !== false) {
    throw new EnkiError('These failures are new: the baseline passed, so they can\'t be accepted as known. Send them to the coder.')
  }
  updateState(task.taskDir, current => {
    current.verify = { round: current.round, baseline, passed, accepted, at: new Date().toISOString() }
    if (baseline) current.baselinePassed = passed
  })
  recordEvent(task.taskDir, 'verify.finished', { round: task.round, baseline, passed, accepted, failed: failed.map(result => result.command) })
  const summary = results.map(result => `${result.code === 0 ? 'ok  ' : 'FAIL'} ${result.repo}: ${result.command}`)
  if (results.length === 0) summary.push('No test, lint or gate commands are configured, so there was nothing to run.')
  const details = failed.map(result => `\n--- ${result.repo}: ${result.command} (full log: ${result.logPath})\n${result.tail}`)
  const status = passed ? 'passed' : accepted ? 'accepted' : 'failed'
  return { exitCode: passed || accepted ? EXIT.ok : EXIT.failed, status, output: [...summary, ...details].join('\n') }
}

// Dev servers. Agents never touch these directly: enki runs each one in its own tab.

const STOP_TIMEOUT_MS = 60000
const STOP_WAIT_MS = 10000

/** Runs the project's stop command. Returns what went wrong, or null. */
async function runStopCommand(devServer, repo) {
  if (!devServer.stop) return null
  try {
    await promisify(execFile)('sh', ['-c', devServer.stop], { cwd: repo.workdir, timeout: STOP_TIMEOUT_MS })
    return null
  } catch (error) {
    return String(error.stderr || error.message).trim().slice(0, 400)
  }
}

const PORT_FORMS = [
  'Vite: npm run dev -- --port {port} --strictPort',
  'Next.js: npm run dev -- -p {port}',
  'Django: python manage.py runserver {port}',
  'Rails: bin/rails server -p {port}',
]

function portHint(name, port) {
  return [
    `Each task gives its server its own port (${port} here), and this start command has no {port} in it. Unless the app reads the PORT variable, it is listening somewhere else.`,
    `Put {port} in devServer.start for ${name}, in the form its tool expects:`,
    ...PORT_FORMS.map(form => `  ${form}`),
  ].join('\n')
}

/** Servers enki starts whose command doesn't take the task's port. Fine only if the app reads PORT. */
export function portWarnings(config) {
  return config.repos
    .filter(repo => repo.url && repo.devServer.managedBy === 'enki' && repo.devServer.start && !repo.devServer.start.includes('{port}'))
    .map(repo => `warning: ${repo.name}: devServer.start has no {port}. Each task runs its server on its own port, so this only works if the app reads the PORT variable. Otherwise use a form like: ${PORT_FORMS[0].split(': ')[1]}`)
}

const responds = url =>
  fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' }).then(
    () => true,
    () => false,
  )

async function poll(check, timeout) {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await new Promise(done => setTimeout(done, 300))
  }
}

const serverRepos = task => task.repos.filter(repo => repo.url)
const sourceRepo = (config, repo) => config.repos.find(item => item.name === repo.name)

async function startServer(task, config, repo) {
  const { devServer } = sourceRepo(config, repo)
  const owned = task.servers?.[repo.name]
  if (await responds(repo.url)) {
    return owned ? `${repo.name}: running at ${repo.url}` : `${repo.name}: already running at ${repo.url}, and not started by enki, so enki won't restart it`
  }
  if (devServer.managedBy === 'user') throw new EnkiError(`${repo.name} is managed by the user and isn't responding at ${repo.url}. Ask them to start it.`)
  if (!devServer.start) throw new EnkiError(`No start command for ${repo.name}. Add devServer.start to .enki/config.json.`)
  if (owned) await herdr.closeTab(owned.tab).catch(() => {}) // Its server died: replace the leftover tab.

  const { tabId, rootPane } = await herdr.createTab({
    workspace: process.env.HERDR_WORKSPACE_ID,
    cwd: repo.workdir,
    label: `${task.slug}-${repo.name}`.replaceAll('/', '-'),
    env: {},
  })
  // Panes run the user's login shell, which may be fish. A script keeps the command in plain sh.
  const script = join(task.taskDir, `server-${repo.name.replaceAll('/', '-')}.sh`)
  const env = { ...(repo.port ? { PORT: String(repo.port) } : {}), ...task.env?.[repo.name] }
  const exports = Object.entries(env).map(([key, value]) => `export ${key}='${String(value).replaceAll("'", "'\\''")}'`)
  const command = repo.port ? fill(devServer.start, { ...portValues(task), port: repo.port }) : devServer.start
  writeFileSync(script, `${[...exports, command].join('\n')}\n`)
  await herdr.runInPane(rootPane, `sh '${script}'`)
  if (!(await poll(() => responds(repo.url), config.timeouts.server))) {
    const log = await herdr.readPane(rootPane).catch(() => '')
    await herdr.closeTab(tabId).catch(() => {})
    await runStopCommand(devServer, repo) // Clears anything a partial start left behind.
    recordEvent(task.taskDir, 'server.failed', { repo: repo.name, command: devServer.start })
    const hint = repo.port && !devServer.start.includes('{port}') ? `\n\n${portHint(repo.name, repo.port)}` : ''
    throw new EnkiError(`"${devServer.start}" didn't bring ${repo.name} up at ${repo.url} within ${config.timeouts.server} ms. If the command or URL is wrong, correct .enki/config.json and the repo notes.${hint}\n\n--- server output ---\n${log.trimEnd()}`)
  }
  updateState(task.taskDir, current => {
    current.servers = { ...current.servers, [repo.name]: { tab: tabId, pane: rootPane, startedAt: new Date().toISOString() } }
  })
  recordEvent(task.taskDir, 'server.started', { repo: repo.name, command: devServer.start, tab: tabId })
  return `${repo.name}: started at ${repo.url}`
}

async function stopServer(task, config, repo) {
  const owned = readState(task.taskDir).servers?.[repo.name]
  if (!owned) throw new EnkiError(`${repo.name} wasn't started by enki, so enki won't stop it. Ask the user.`)
  const { devServer } = sourceRepo(config, repo)
  const stopFailure = await runStopCommand(devServer, repo)
  await herdr.closeTab(owned.tab).catch(error => {
    if (error.code !== 'tab_not_found') throw error
  })
  const down = await poll(async () => !(await responds(repo.url)), Math.min(STOP_WAIT_MS, config.timeouts.server))
  updateState(task.taskDir, current => {
    delete current.servers[repo.name]
  })
  recordEvent(task.taskDir, 'server.stopped', { repo: repo.name, down, stopFailure })
  if (!down) {
    const hint = stopFailure ? `"${devServer.stop}" failed: ${stopFailure}` : devServer.stop ? `"${devServer.stop}" didn't stop it.` : 'Its start command may run in the background: set devServer.stop in .enki/config.json.'
    throw new EnkiError(`${repo.name} still responds at ${repo.url} after its tab closed. ${hint}`)
  }
  if (stopFailure) return `${repo.name}: stopped, but "${devServer.stop}" reported: ${stopFailure}`
  return `${repo.name}: stopped`
}

export async function serverCommand({ root, slug, action, repoName }) {
  requireHerdr()
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  let repos = serverRepos(task)
  if (repoName) repos = repos.filter(repo => repo.name === repoName)
  if (repoName && repos.length === 0) throw new EnkiError(`No repo "${repoName}" with a URL in this task.`, EXIT.usage)

  const lines = []
  for (const repo of repos) {
    if (action === 'status') {
      const up = await responds(repo.url)
      const owner = task.servers?.[repo.name] ? 'started by enki' : 'not started by enki'
      lines.push(up ? `${repo.name}: up at ${repo.url} (${owner})` : `${repo.name}: down at ${repo.url}`)
    } else if (action === 'stop') lines.push(await stopServer(task, config, repo))
    else {
      // Nothing to stop is fine: a restart just has to leave the server running.
      if (action === 'restart' && (task.servers?.[repo.name] || (await responds(repo.url)))) await stopServer(task, config, repo)
      lines.push(await startServer(readState(task.taskDir), config, repo))
    }
  }
  return lines
}

const NEXT_STEP = {
  intake: 'Finish intake: scout report, clarifying questions. Skill: enki:task',
  planning: 'Present the plan with ExitPlanMode. Skill: enki:task',
  approved: 'Run enki team start, then the baseline. Skill: enki:execute',
  baseline: 'Baseline running. Skill: enki:execute',
  coding: 'The tester and coder are working in parallel. Skill: enki:execute',
  testing: 'QA and enki verify run in parallel. Skill: enki:execute',
  review: 'The reviewer starts once tests pass, alongside QA. Skill: enki:execute',
  fixing: 'Fix loop in progress. Skill: enki:execute',
  notes: 'Update the repo notes. Skill: enki:report',
  reporting: 'Write report.md. Skill: enki:report',
  done: 'Finished.',
}

async function agentSummary(task) {
  const lines = []
  for (const role of ROLES) {
    const known = task.agents[role]
    if (!known) continue
    const live = await herdr.getAgent(known.name).catch(() => null)
    lines.push(`  ${role}: ${known.name} (${live?.agent_status ?? 'not running'})`)
  }
  return lines
}

export async function status({ root, slug }) {
  const task = requireTask(root, slug)
  return [
    `Task ${task.id}  phase: ${task.phase}  approved: ${task.approved}  round: ${task.round}`,
    `Folder: ${task.taskDir}`,
    `Scope: ${task.scope.join(', ') || 'none'}  Repos: ${task.repos.map(repo => `${repo.name}${repo.url ? ` (${repo.url})` : ''}`).join(', ')}`,
    ...(task.worktrees ?? []).map(tree => `Branch: ${tree.branch}, from ${tree.base.branch}, in ${tree.path}`),
    ...task.repos.filter(repo => repo.memoryDir).map(repo => `Memory for ${repo.name}: ${repo.memoryDir}`),
    ...(task.database ? [`Database: ${task.database}`] : []),
    `Tests this round: ${currentVerify(task) ? (task.verify.passed ? 'passed' : task.verify.accepted ? 'accepted' : 'failed') : 'not run'}`,
    ...(await agentSummary(task)),
    `Next: ${NEXT_STEP[task.phase]}`,
  ].join('\n')
}

/** Binds a task to this pane and reports where to continue. It never restarts finished work. */
export async function resume({ root, slug }) {
  const task = resolveTask(root, { slug })
  if (!task) throw new EnkiError(`No task "${slug}".`)
  const pane = process.env.HERDR_PANE_ID ?? null
  if (pane && task.orchestratorPane !== pane) {
    const previous = task.orchestratorPane
    updateState(task.taskDir, current => {
      current.orchestratorPane = pane
    })
    recordEvent(task.taskDir, 'task.rebound', { from: previous, to: pane })
  }
  return [await status({ root, slug }), `Plan: ${join(task.taskDir, task.approved ? 'approved-plan.md' : 'plan.md')}`].join('\n')
}

export async function setPhase({ root, slug, phase, abandon = false }) {
  if (!PHASES.includes(phase)) throw new EnkiError(`Unknown phase. Use one of: ${PHASES.join(', ')}`, EXIT.usage)
  if (phase === 'approved') throw new EnkiError('Only the user can approve a plan, through ExitPlanMode.')
  const task = requireTask(root, slug)
  const toPlanning = PHASES.indexOf(phase) <= PHASES.indexOf('planning')
  if (!toPlanning && !task.approved && !abandon) throw new EnkiError(`Can't move to ${phase}: the plan isn't approved.`)
  if (phase === 'planning' && !existsSync(join(task.taskDir, 'scout.md'))) {
    throw new EnkiError('There is no scout report yet. Every task, however small, starts with: enki ask scout <brief>')
  }
  if (abandon && phase !== 'done') throw new EnkiError('--abandon only works with: enki phase done --abandon', EXIT.usage)
  if (!abandon && PHASES.indexOf(phase) >= PHASES.indexOf('notes')) {
    const missing = missingChecks(task)
    if (missing.length > 0) throw new EnkiError(`This task can't finish yet. Still needed: ${missing.join('; ')}.`)
  }
  // Finishing commits the work first. If that fails, the task isn't done, and stays as it was.
  const notes = phase === 'done' ? await finishTask(task, abandon) : []
  if (abandon) recordEvent(task.taskDir, 'task.abandoned', { from: task.phase, missing: missingChecks(task) })
  updateState(task.taskDir, current => {
    current.phase = phase
    // Replanning withdraws the approval: the new plan needs its own.
    if (toPlanning) current.approved = false
  })
  recordEvent(task.taskDir, 'task.phase', { from: task.phase, to: phase })
  // A finished task has done the orchestrator's own steps (notes, the report), whether or not it ticked them.
  if (phase === 'done' && !abandon) {
    for (const step of task.steps ?? []) {
      if (step.owner === 'orchestrator' && step.status !== 'done' && step.status !== 'failed') setStep(task.taskDir, step.n, 'done', 'orchestrator')
    }
  }
  return { phase, notes }
}

/** Stops what the task started, commits its worktrees to their branch, and frees its port and database. */
async function finishTask(task, abandon) {
  const config = loadTaskConfig(task)
  const notes = await serverCleanup(task)
  if (task.worktrees?.length > 0) {
    const requirementsPath = join(task.taskDir, 'requirements.md')
    const message = commitMessage({ slug: task.slug, id: task.id, requirements: existsSync(requirementsPath) ? readFileSync(requirementsPath, 'utf8') : null, abandon })
    let results
    try {
      results = finishWorktrees({ worktrees: task.worktrees, repos: task.repos, message, abandon })
    } catch (error) {
      recordEvent(task.taskDir, 'worktree.commit_failed', { message: error.message.slice(0, 300) })
      throw asEnki(error, WorktreeError)
    }
    if (memoryMode(task.projectRoot) === 'private') {
      for (const repo of task.repos) {
        const tree = results.find(item => item.path === repo.worktree) ?? task.worktrees.find(item => item.path === repo.worktree)
        try {
          const line = finishTaskMemory({
            root: task.projectRoot,
            slug: task.slug,
            repo,
            codeCommit: tree?.committed ? tree.fullCommit : null,
            codeTop: tree?.top ?? repo.main,
            baseBranch: tree?.base.branch,
            message,
            abandon,
          })
          if (line) notes.push(line)
        } catch (error) {
          notes.push(`${repo.name}: memory wasn't saved: ${error.message}`)
        }
      }
    }
    for (const tree of results) {
      notes.push(
        tree.committed
          ? `Committed ${tree.files} file(s) to branch ${tree.branch} (${tree.commit}), from ${tree.base.branch}. Review with: git diff ${tree.base.branch}...${tree.branch}`
          : `Nothing changed, so branch ${tree.branch} was deleted.`,
      )
    }
    recordEvent(task.taskDir, 'worktree.finished', { results: results.map(tree => ({ branch: tree.branch, committed: tree.committed, commit: tree.commit ?? null })) })
  }
  if (task.databaseReady) {
    try {
      dropDatabase(config.database, portValues(task), task.projectRoot)
      notes.push('Dropped the task\'s database copy.')
    } catch (error) {
      notes.push(`The database copy wasn't dropped: ${error.message}`)
    }
  }
  await releasePorts(task.taskDir)
  return notes
}

async function serverCleanup(task) {
  const config = loadTaskConfig(task)
  const lines = []
  for (const repo of serverRepos(task)) {
    if (task.servers?.[repo.name]) lines.push(await stopServer(task, config, repo))
  }
  return lines
}

export function nextRound({ root, slug }) {
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  const fixRounds = task.round - 1
  if (fixRounds >= config.maxFixRounds) {
    recordEvent(task.taskDir, 'task.round_limit', { round: task.round })
    throw new EnkiError(`Fix round limit reached (${config.maxFixRounds}). Stop and report the open issues to the user.`)
  }
  const next = updateState(task.taskDir, current => {
    current.round += 1
  })
  recordEvent(task.taskDir, 'task.round', { round: next.round })
  return next.round
}

export const readApprovedScope = plan => ({
  database: /^\W*Database:\W*(copy|shared|none)\b/im.exec(plan)?.[1].toLowerCase() ?? null,
  scope: [...plan.matchAll(/^\W*Scope:\s*([a-z-]+)/gim)].map(match => match[1].toLowerCase()),
  tests: !/^\W*Tests:\W*none\b/im.test(plan),
  qa: !/^\W*QA:\W*none\b/im.test(plan),
})

/** Called only by the ExitPlanMode hook, which only fires after the user approves. */
export function approvePlan(task, planText) {
  const { scope, tests, qa, database } = readApprovedScope(planText)
  const steps = parseSteps(planText)
  writeFileSync(join(task.taskDir, 'approved-plan.md'), planText)
  const mode = planDatabase(loadTaskConfig(task).database, database)
  const next = updateState(task.taskDir, current => {
    current.database = mode
    current.phase = 'approved'
    current.approved = true
    current.scope = scope
    current.tests = tests
    current.qa = qa
    current.steps = steps
  })
  const config = loadTaskConfig(next)
  writeRules(next, config)
  recordEvent(task.taskDir, 'plan.approved', { scope, tests, qa, database: next.database, steps: steps.length })
  // The scout reports before the plan exists, so its steps are already done when the plan is approved.
  if (existsSync(join(task.taskDir, 'scout.md'))) {
    for (const step of steps.filter(item => item.owner === 'scout')) setStep(task.taskDir, step.n, 'done', 'scout')
  }
  return readState(task.taskDir)
}

const browserLock = () => join(enkiHome(), 'browser.lock')

export function browserAcquire({ root, slug }) {
  const task = requireTask(root, slug)
  if (loadTaskConfig(task).browser.driver !== 'chrome') return 'This browser driver needs no lock.'
  mkdirSync(enkiHome(), { recursive: true })
  try {
    const fd = openSync(browserLock(), 'wx')
    writeSync(fd, JSON.stringify({ task: task.id, project: task.projectId, at: new Date().toISOString() }))
    closeSync(fd)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const holder = JSON.parse(readFileSync(browserLock(), 'utf8'))
    if (holder.task === task.id) return 'This task already holds the browser.'
    throw new EnkiError(`The browser is in use by task ${holder.task} since ${holder.at}. Finish code tests and try again.`, EXIT.busy)
  }
  recordEvent(task.taskDir, 'browser.acquired')
  return 'Browser acquired.'
}

export function browserRelease({ root, slug }) {
  const task = requireTask(root, slug)
  if (!existsSync(browserLock())) return 'The browser was not held.'
  const holder = JSON.parse(readFileSync(browserLock(), 'utf8'))
  if (holder.task !== task.id) throw new EnkiError(`The browser is held by task ${holder.task}, not this one.`)
  rmSync(browserLock())
  recordEvent(task.taskDir, 'browser.released')
  return 'Browser released.'
}

/** What each role loads, or everything that could be listed. */
export function skillsReport({ root, available = false }) {
  const config = loadProjectConfig(root)
  const repos = selectRepos(root, config, [])
  if (available) {
    return availableSkills(skillContext(root, repos)).map(skill => `${skill.name}  ${skill.description.slice(0, 70)}`)
  }
  const resolved = resolveTeamSkills(root, config, repos)
  return ROLES.map(role => {
    if (resolved[role].length === 0) return `${role}: none`
    const lines = resolved[role].flatMap(skill => {
      const size = Math.round(readFileSync(skill.path).length / 1024)
      return [`  ${skill.name} (${size} KB) ${skill.path}`, ...skillWarnings(skill).map(warning => `    warning: ${warning}`)]
    })
    return [`${role}:`, ...lines].join('\n')
  })
}

const INIT_CONFIG = {
  mode: 'auto',
  repos: [],
}

export function initProject(root) {
  const enki = join(root, '.enki')
  const created = []
  mkdirSync(join(enki, 'notes'), { recursive: true })
  mkdirSync(join(enki, 'tasks'), { recursive: true })
  const write = (name, content) => {
    const path = join(enki, name)
    if (!existsSync(path)) {
      writeFileSync(path, content)
      created.push(`.enki/${name}`)
    }
  }
  write('config.json', `${JSON.stringify({ id: randomBytes(6).toString('hex'), ...INIT_CONFIG }, null, 2)}\n`)
  write('.gitignore', 'tasks/\nworktrees/\n')
  write('playbook.md', readFileSync(join(pluginRoot, 'templates', 'playbook.md'), 'utf8'))
  return created
}

export { ROLES }
