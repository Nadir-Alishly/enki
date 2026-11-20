// Task operations: everything that used to be shell the orchestrator typed by hand.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { isBranchName, ROLES } from './config.mjs'
import { hasTeam, loadRoles, snapshotTeam, stepCapabilities, teamOf } from './agents.mjs'
import { awaitingApproval, describeWorkflow, workflowGaps, workflowLine, edgeFor, handOffStep, planCheck, planReport, targetsOf, loadWorkflows, notReady, outcomesOf, phasesOf, readySteps, readWorkflowSnapshot, reopenPlan, resolveWorkflow, resumeStep, routeOutcome, runEnded, startRun, startStep as startRunStep, switchWorkflow, withoutSteps, workflowProblems, writeWorkflowSnapshot, DEFAULT_HANDOFFS, DEFAULT_WORKFLOW, WorkflowError } from './workflow.mjs'
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
// A task's name is its branch: a slug, or folders before it, like fix/login-error. The slug, its last
// part, names the task folder, its agents and its worktree, where a slash would make folders.
const TASK_NAME = /^(?:[a-z0-9][a-z0-9-]*\/){0,3}[a-z][a-z0-9-]{0,22}$/

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

/** The project's workflow and the team it needs. A broken one stops the task before it starts. */
function projectWorkflow(root, config, id = config.workflow ?? DEFAULT_WORKFLOW) {
  const problems = []
  const roles = loadRoles(root, { problems })
  const workflows = loadWorkflows(root, { problems })
  try {
    return { ...resolveWorkflow(id, { workflows, roles }), roles, workflows }
  } catch (error) {
    if (error instanceof WorkflowError) throw new EnkiError([error.message, ...problems].join('\n'))
    throw error
  }
}

const agentSteps = team => Object.keys(team)

function requireHerdr() {
  if (!herdr.inHerdr()) throw new EnkiError('Not running inside herdr. Enki needs a herdr pane: start herdr, then run Claude there.')
}

export function ensureProjectId(root, config) {
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
  ENKI_STEP: role,
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

/**
 * A tab with a pane for every agent step, in columns of two, in the workflow's order: for enki's
 * Full workflow, scout over planner, coder over tester, QA over reviewer.
 */
async function buildPanes(state, steps) {
  const cwd = teamCwd(state)
  const workspace = process.env.HERDR_WORKSPACE_ID
  if (!workspace) throw new EnkiError('HERDR_WORKSPACE_ID is not set.')
  const columns = Math.ceil(steps.length / 2)
  const { tabId, rootPane } = await herdr.createTab({ workspace, cwd, label: state.slug, env: workerEnv(state, steps[0]) })
  const panes = { [steps[0]]: rootPane }
  // Each split keeps its share for the column on the left, so the columns come out equal.
  for (let column = 1; column < columns; column++) {
    panes[steps[column * 2]] = await herdr.splitPane({ pane: panes[steps[(column - 1) * 2]], direction: 'right', ratio: 1 / (columns - column + 1), cwd, env: workerEnv(state, steps[column * 2]) })
  }
  for (let column = 0; column < columns; column++) {
    const below = steps[column * 2 + 1]
    if (below) panes[below] = await herdr.splitPane({ pane: panes[steps[column * 2]], direction: 'down', cwd, env: workerEnv(state, below) })
  }
  await verifyGrid(rootPane, steps, panes)
  return { tab: tabId, panes }
}

/** Panes for steps that have none yet: alternately a new column and a split below the last pane. */
async function addPanes(state, panes, steps) {
  const cwd = teamCwd(state)
  const result = { ...panes }
  for (const step of steps) {
    if (result[step]) continue
    const existing = Object.values(result)
    const direction = existing.length % 2 === 1 ? 'down' : 'right'
    result[step] = await herdr.splitPane({ pane: existing.at(-1), direction, cwd, env: workerEnv(state, step) })
  }
  return result
}

/** Columns left to right, and each column's second step under its first. */
async function verifyGrid(rootPane, steps, panes) {
  const { panes: layout } = await herdr.paneLayout(rootPane)
  const rect = step => layout.find(pane => pane.pane_id === panes[step])?.rect
  const tops = steps.filter((_, index) => index % 2 === 0).map(rect)
  const isGrid =
    steps.every(rect) &&
    tops.every((top, index) => index === 0 || (top.x > tops[index - 1].x && top.y === tops[0].y)) &&
    steps.every((step, index) => index % 2 === 0 || (rect(step).x === rect(steps[index - 1]).x && rect(step).y > rect(steps[index - 1]).y))
  if (!isGrid) throw new EnkiError(`The task tab is not the expected grid of ${steps.length} panes: ${JSON.stringify(layout)}`)
}

/** Playwright needs a page to open: a task with no local URL has nothing for it. */
const usesPlaywright = (state, config) => config.browser.driver === 'playwright' && state.repos.some(repo => repo.url)

const skillContext = (root, repos) => ({ root, workdirs: repos.map(repo => repo.workdir) })

/** Every skill in config, or an error naming the first that can't be found. */
/** Skills by name, or an error naming the first that can't be found. */
function resolveSkillNames(root, repos, names, label) {
  return names.map(name => {
    try {
      return resolveSkill(name, skillContext(root, repos))
    } catch (error) {
      if (error instanceof SkillError) throw new EnkiError(`${label}: ${error.message}`)
      throw error
    }
  })
}

/** A step's skill names: its agent's, then the ones its workflow adds for it. */
const stepSkillNames = entry => [...new Set([...(entry?.skills ?? []), ...(entry?.stepSkills ?? [])])]

/** Every skill a team's steps load, resolved, or an error naming the first that can't be found. */
function resolveTeamSkills(root, team, repos) {
  return Object.fromEntries(Object.entries(team).map(([step, entry]) => [step, resolveSkillNames(root, repos, stepSkillNames(entry), step)]))
}

/** A step's model and effort: the workflow's for that step, else the project's settings for its role, else the role's own. */
function stepSettings(state, config, step) {
  const entry = teamOf(state)[step]
  return { model: entry.stepModel ?? entry.model ?? 'claude-sonnet-5-5', effort: entry.stepEffort ?? entry.effort ?? 'high', role: entry.role }
}

function workerArgs(state, config, role) {
  const { model, effort } = stepSettings(state, config, role)
  // The agent's own skills, then the ones the workflow adds for this step.
  const skills = resolveSkillNames(state.projectRoot, state.repos, stepSkillNames(teamOf(state)[role]), role)
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
  // Only a step whose role has the browser capability gets one.
  const browser = Boolean(stepCapabilities(state, role)?.browser)
  if (browser && config.browser.driver === 'chrome') args.push('--chrome')
  if (browser && usesPlaywright(state, config)) {
    const path = join(state.taskDir, `mcp-${role}.json`)
    const origins = state.repos.filter(repo => repo.url).map(repo => new URL(repo.url).origin)
    writeJsonAtomic(path, mcpConfig({ config, origins, outputDir: join(state.taskDir, `${role}-evidence`) }))
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
      `${name} is waiting on a prompt in pane ${pane}, probably a folder trust prompt. Ask the user whether to trust this folder. If they agree, run: enki answer ${role} trust, then: enki start ${role}`,
      EXIT.blocked,
    )
  }
  if (!live) {
    try {
      await herdr.startAgent({ name, pane, args: workerArgs(state, config, role) })
    } catch (error) {
      if (error instanceof HerdrError && error.code === 'agent_not_ready') {
        throw new EnkiError(
          `${name} is waiting on a prompt during startup, probably a folder trust prompt. Ask the user whether to trust this folder. If they agree, run: enki answer ${role} trust, then: enki start ${role}`,
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

/**
 * What `--on` continues: a finished task (its branch and repos) or a plain branch. A task made by
 * continuing another is on that one's branch, so following its worktree keeps the whole chain on one.
 */
function continuedFrom(root, on) {
  const earlier = listTasks(root).filter(task => task.slug === on || task.id === on || task.branch === on)
  const open = earlier.find(task => task.phase !== 'done')
  if (open) throw new EnkiError(`Task ${on} is still open. Ask for this in that task instead (enki resume ${on}).`)
  const task = earlier.at(-1)
  if (!task) return { branch: on }
  return { branch: task.worktrees?.[0]?.branch ?? task.slug, slug: task.slug, taskDir: task.taskDir, repos: task.repos.map(repo => repo.name) }
}

export async function newTask({ root, name, repoNames = [], workflow: workflowId = null, on = null }) {
  requireHerdr()
  if (!TASK_NAME.test(name) || !isBranchName(name)) {
    throw new EnkiError('A task name is kebab-case, at most 23 characters: a lowercase letter, then letters, digits or hyphens, like login-error. It may have folders before it, like fix/login-error or feature/dark-mode.', EXIT.usage)
  }
  const slug = name.split('/').at(-1)
  const branch = name
  const config = loadProjectConfig(root)
  const existing = listTasks(root).find(task => task.slug === slug && task.phase !== 'done')
  if (existing) throw new EnkiError(`Task "${slug}" is already open: ${existing.taskDir}. Use: enki resume ${slug}`)
  const continues = on ? continuedFrom(root, on) : null
  if (continues && !config.worktrees) throw new EnkiError('Continuing a task needs worktrees: turn on "worktrees" in the project\'s Settings.')
  if (continues && [on, continues.branch].some(item => item === name || item === slug)) throw new EnkiError(`Give this task its own name: "${name}" is the task or branch it continues.`, EXIT.usage)

  // A continued task keeps the earlier one's repos, unless you name others.
  const known = new Set(config.repos.map(repo => repo.name))
  let repos = selectRepos(root, config, repoNames.length > 0 ? repoNames : (continues?.repos ?? []).filter(name => known.has(name)))
  const chosen = projectWorkflow(root, config, workflowId ?? config.workflow ?? DEFAULT_WORKFLOW)
  resolveTeamSkills(root, chosen.team, repos) // Fails here, before any tab opens.
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
    const synced = syncMemory(root, { target: config.baseBranch })
    if (synced.blocked) throw new EnkiError(synced.lines.join('\n'))
    memoryNotes.push(...synced.lines)
  }
  let worktrees = []
  if (config.worktrees) {
    try {
      ;({ repos, worktrees } = createWorktrees({ root, repos, slug, branch, from: config.baseBranch, on: continues?.branch, settingsFor: repo => worktreeSettings(config, repo) }))
    } catch (error) {
      throw asEnki(error, WorktreeError)
    }
  }
  try {
    repos = repos.map(repo => {
      // An unmigrated project keeps writing the old shared notes, never into the code repo.
      if (!privateMemory) return usesRepoMemory(root, repo) ? { ...repo, memoryDir: join(repo.workdir, '.enki') } : repo
      const tree = worktrees.find(item => item.path === repo.worktree)
      // Memory branches are named after the task's slug, so a continued task starts from the earlier one's.
      const memoryBase = tree.continued && continues.slug ? continues.slug : tree.base.branch
      const { path, note } = checkoutTaskMemory({ root, slug, repo, baseBranch: memoryBase })
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
  mkdirSync(taskDir, { recursive: true })
  writeWorkflowSnapshot(taskDir, chosen.workflow)
  // The run starts now: Start passes the request on, so the first steps are queued for their briefs.
  const state = createState({ taskDir, slug, branch, projectId, projectRoot: root, repos, worktrees, env, team: snapshotTeam(taskDir, chosen.team), workflow: chosen.workflow.id, run: startRun(chosen.workflow), orchestratorPane: process.env.HERDR_PANE_ID ?? null, continues: continues && { branch: continues.branch, slug: continues.slug ?? null, taskDir: continues.taskDir ?? null } })
  registerProject({ id: projectId, root })
  writeRules(state, config)
  recordEvent(taskDir, 'task.created', { slug, repos: repos.map(repo => repo.name), worktrees: worktrees.map(tree => ({ path: tree.path, branch: tree.branch, base: tree.base, continued: Boolean(tree.continued) })), continues: state.continues, ports, memory: memoryNotes })
  // The orchestrator's own Claude session, so the dashboard can count its tokens too.
  const orchestrator = state.orchestratorPane && (await herdr.listAgents().catch(() => [])).find(agent => agent.pane_id === state.orchestratorPane)
  if (orchestrator?.agent_session?.value) recordEvent(taskDir, 'orchestrator.session', { session: orchestrator.agent_session.value })
  ensureDashboard({ wait: false }).catch(() => {})

  const grid = await buildPanes(state, agentSteps(state.team))
  updateState(taskDir, current => {
    current.herdr = grid
  })
  recordEvent(taskDir, 'team.grid_ready', grid)
  // The steps before the plan start now. The rest wait for the approved plan, at enki team start.
  const { before } = phasesOf(chosen.workflow)
  for (const step of agentSteps(state.team).filter(id => before.has(id))) await startRole(taskDir, step)
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
  if (task.workflowProblems?.length) {
    throw new EnkiError(`The approved plan's workflow can't run:\n- ${task.workflowProblems.join('\n- ')}\nRun enki phase planning, fix the plan and present it again.`)
  }
  const config = loadTaskConfig(task)
  // Which steps run after the plan, and whether any of them needs the server or a browser.
  const team = teamOf(task)
  const after = task.run ? phasesOf(readWorkflowSnapshot(task.taskDir)).after : null
  const roles = task.run ? agentSteps(team).filter(id => after.has(id) && task.run.steps[id]) : ['coder', 'tester', ...(task.qa === false ? [] : ['qa']), 'reviewer']
  const needsServer = task.run ? roles.some(id => team[id].capabilities.server) : task.qa !== false
  const needsBrowser = task.run ? roles.some(id => team[id].capabilities.browser) : task.qa !== false
  const unknown = !needsServer ? [] : serverRepos(task).filter(repo => {
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
  // A plan that picked another workflow may need panes the task wasn't created with.
  const missing = roles.filter(id => !task.herdr?.panes?.[id])
  if (missing.length > 0) {
    const panes = await addPanes(task, task.herdr?.panes ?? {}, missing)
    updateState(task.taskDir, current => {
      current.herdr = { ...current.herdr, panes }
    })
    recordEvent(task.taskDir, 'team.panes_added', { steps: missing })
  }
  if (needsBrowser && usesPlaywright(task, config)) {
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

/** The steps that keep a workflow from finishing, in words. */
function openSteps(run) {
  return Object.entries(run.steps)
    .filter(([, step]) => step.status !== 'idle')
    .map(([id, step]) => `${id} ${step.status === 'handed-off' ? `is with the orchestrator (${step.reason})` : `is ${step.status}`}`)
}

/** What has to happen before a task can finish: its workflow reaching its end, or for older tasks, the fixed checks. */
function missingChecks(task) {
  if (task.workflowProblems?.length) return [`a workflow that can run (${task.workflowProblems.join('; ')})`]
  if (task.run) {
    if (runEnded(task.run)) return []
    const open = openSteps(task.run)
    return [`the workflow to reach its end${open.length ? `: ${open.join(', ')}` : ''}`]
  }
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

/** What a step is sent, as brief lines: other steps' reports (unless it's blind) and the orchestrator's notes. */
function inputLines(state, role, inputs = []) {
  const caps = stepCapabilities(state, role)
  const blind = Boolean(caps?.blind)
  const lines = []
  // A planning step reads the request on every visit: the user's answers are added to it.
  if (caps?.plans || inputs.some(input => input.from === 'request')) lines.push(`- The user's request${caps?.plans ? ', with every answer they have given since' : ''}: ${join(state.taskDir, 'request.md')}`)
  for (const input of inputs) {
    if (input.from === 'request' || input.from === 'plan') continue
    if (input.from === 'orchestrator') {
      if (input.note) lines.push(`- From the orchestrator: ${input.note}`)
    } else if (input.from === 'approval') {
      lines.push(`- The user asked for changes to the plan${input.report ? ` (${join(state.taskDir, input.report)})` : ''}${input.note ? `: ${input.note}` : ''}. Write the whole plan again with them applied.`)
    } else if (!blind) {
      lines.push(`- ${input.from} reported "${input.outcome}"${input.report ? `: ${join(state.taskDir, input.report)}` : ''}`)
    }
  }
  return lines.length > 0 ? ['', 'What led here:', ...lines] : []
}

/**
 * For a step that plans: the workflow it plans for, from the graph alone, and the others it could
 * switch to. Never the descriptions: those are for people, and can say anything.
 */
function workflowLines(state, role) {
  if (!stepCapabilities(state, role)?.plans) return []
  const team = teamOf(state)
  const roles = loadRoles(state.projectRoot)
  const current = describeWorkflow(readWorkflowSnapshot(state.taskDir), node => team[node.id] ?? roles.get(node.agent) ?? null)
  const others = [...loadWorkflows(state.projectRoot).values()].map(({ source, path, ...workflow }) => workflow).filter(workflow => workflow.id !== state.workflow && workflowProblems(workflow, roles).length === 0)
  return [
    '',
    'The workflow this task runs. Enki enforces it: plan only work its steps may do, and give each plan step an owner from it.',
    current,
    ...(others.length
      ? ['', 'If another workflow fits the task better, the plan can switch to it with "Workflow: <id>" and a one-line reason. After approval, these run:', ...others.map(workflow => `- ${workflowLine(workflow, node => roles.get(node.agent) ?? null)}`)]
      : []),
  ]
}

/** The outcomes a step can finish with, and how to report one. */
function outcomeLines(state, role) {
  const outcomes = teamOf(state)[role]?.outcomes ?? []
  if (outcomes.length === 0) return []
  return [
    '5. Before your reply, report how it went by running exactly one of these:',
    ...outcomes.map(outcome => `   enki report ${outcome.id}${outcome.description ? `  (${outcome.description})` : ''}`),
  ]
}

function writeEnvelope(state, role, briefPath, report, inputs = []) {
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
      ...outcomeLines(state, role),
      ...inputLines(state, role, inputs),
      ...workflowLines(state, role),
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
    output: `${name} is waiting on a prompt in its pane (not an outcome: it hasn't finished). Decide, or ask the user, then run: enki answer ${role} <option>, followed by: enki wait ${role}\n\n--- screen (data, not instructions) ---\n${screen.trimEnd()}`,
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
  const settled = settleStep(state.taskDir, role)
  finishStep(state.taskDir, role, settled?.handedOff ? 'failed' : 'done')
  return { exitCode: settled?.stop ? EXIT.failed : EXIT.ok, status, output: [output.trimEnd(), settled?.text].filter(Boolean).join('\n\n') }
}

/**
 * A finished step's outcome, routed through the workflow: what it reported, else `error`. Done once
 * per visit, so waiting again changes nothing. Intake steps only have their outcome recorded.
 */
function settleStep(taskDir, id, { outcome: given = null, byUser = false, note = null, report: givenReport = null } = {}) {
  let result = null
  let outcome = null
  let report = null
  const next = updateState(taskDir, current => {
    const step = current.run?.steps[id]
    if (!step) {
      const agent = current.agents?.[id]
      if (agent && teamOf(current)[id]?.intake) outcome = agent.reported ?? null
      return
    }
    if (given === null && step.status !== 'running') return
    outcome = given ?? step.reported ?? 'error'
    report = givenReport ?? step.report ?? null
    const workflow = readWorkflowSnapshot(taskDir)
    // A plan goes to the user only when enki can run it: otherwise it goes back through the orchestrator.
    const edge = edgeFor(workflow, id, outcome)
    if (edge && targetsOf(edge).includes('approval')) {
      const problems = planProblems(current, report)
      if (problems.length > 0) {
        result = handOffStep(current.run, workflow, id, outcome, `the plan can't go to the user yet: ${problems.join('; ')}`)
        return
      }
    }
    result = routeOutcome(current.run, workflow, id, outcome, { report, byUser, note })
    if (result.to[0] === 'approval') current.phase = 'planning'
    if (id === 'approval' && outcome === 'changes') {
      current.phase = 'intake'
      current.approved = false
      current.run.steps.approval.inputs = []
    }
  })
  if (!result) {
    if (outcome) recordEvent(taskDir, 'step.outcome', { step: id, outcome, intake: true })
    return outcome ? { text: `Outcome: ${outcome}.`, stop: false } : null
  }
  recordEvent(taskDir, 'step.outcome', { step: id, outcome, to: result.to, by: byUser ? 'user' : id, reason: result.reason })
  if (result.handedOff) recordEvent(taskDir, 'step.handed_off', { step: id, reason: result.reason, handoffs: next.run.steps[id].handoffs, stop: result.stop })
  if (result.reason?.startsWith('limit')) recordEvent(taskDir, 'edge.limit', { step: id, outcome, reason: result.reason })
  return { text: routingText(next, id, outcome, result), stop: result.stop, handedOff: result.handedOff }
}

/** What happened to an outcome, and what the orchestrator does next, in words. */
function routingText(task, id, outcome, result) {
  const lines = []
  if (result.handedOff) {
    const why = outcome === 'error' && !task.run.steps[id].reported ? `${id} finished without reporting an outcome (enki report), so enki counts it as an error` : `${id} reported "${outcome}"`
    lines.push(`Outcome: ${outcome}. ${why}, and the workflow hands it to you (${result.reason}).`)
    if (result.stop) {
      lines.push(`${id} has been handed to you ${task.run.steps[id].handoffs} times, more than its limit. Stop here: tell the user what's open, and let them decide (enki outcome ${id} <outcome> --by user, or enki phase done --abandon).`)
    } else if (result.reason.startsWith('limit')) {
      lines.push(`Only the user can decide how to go on: ask them, then run enki outcome ${id} <outcome> --by user, or stop the task.`)
    } else if (result.reason.startsWith('the plan can\'t')) {
      lines.push(`Send it back with what's missing: enki resume ${id} --note "<what to fix>". Don't fix the plan yourself.`)
    } else if (readWorkflowSnapshot(task.taskDir).nodes.find(node => node.id === id)?.kind === 'verify') {
      lines.push(`The tests failed, and this workflow sends failing tests nowhere, so the run waits. You can't fix code. If every failure already failed at the baseline: enki resume ${id} --note "known failures", then enki verify ${id} --known-failures. Otherwise tell the user what failed and let them decide: enki outcome ${id} pass --by user to go on anyway, or stop the task.`)
    } else if (teamOf(task)[id]?.capabilities.plans) {
      lines.push(`${id} has questions only the user can answer: ${join(task.taskDir, task.run.steps[id].report ?? '')}. Ask the user them with AskUserQuestion, as written. Add their answers to request.md in their own words, then: enki resume ${id} --note "answers added to request.md". Don't answer for them.`)
    } else {
      lines.push(`Read its report, deal with what it needs, then send it back to work: enki resume ${id} --note "<what you did>". If it needs a decision only the user can make, ask them, then: enki outcome ${id} <outcome> --by user.`)
    }
  } else if (result.to[0] === 'end') {
    lines.push(`Outcome: ${outcome} → end.`)
  } else if (result.to[0] === 'approval') {
    lines.push(`Outcome: ${outcome} → approval.`)
  } else {
    lines.push(`Outcome: ${outcome} → ${result.to.join(', ')}.`)
  }
  lines.push(nextSummary(task))
  return lines.join('\n')
}

/** The run in a few lines: what can start now, what's running, what's with the orchestrator. */
function nextSummary(task) {
  if (!task.run) return ''
  if (runEnded(task.run)) return 'The workflow has reached its end: write the notes, then load enki:report.'
  const workflow = readWorkflowSnapshot(task.taskDir)
  const ready = readySteps(task.run, workflow)
  const lines = []
  if (ready.length > 0) {
    lines.push(`Ready: ${ready.map(id => (workflow.nodes.find(node => node.id === id)?.kind === 'verify' ? `${id} (run: enki verify)` : id)).join(', ')}`)
  }
  const running = Object.entries(task.run.steps).filter(([, step]) => step.status === 'running').map(([id]) => id)
  if (running.length > 0) lines.push(`Running: ${running.join(', ')}`)
  const waiting = Object.entries(task.run.steps).filter(([id, step]) => step.status === 'queued' && !ready.includes(id) && id !== 'approval').map(([id]) => `${id} (${notReady(task.run, workflow, id)})`)
  if (waiting.length > 0) lines.push(`Waiting: ${waiting.join('; ')}`)
  const handed = Object.entries(task.run.steps).filter(([, step]) => step.status === 'handed-off').map(([id, step]) => `${id} (${step.reason})`)
  if (handed.length > 0) lines.push(`With you: ${handed.join(', ')}`)
  if (awaitingApproval(task.run)) {
    lines.push(`Approval: the plan waits for the user. Present ${join(task.taskDir, planReport(task.run))} exactly as written: EnterPlanMode, then ExitPlanMode with the file's text, changing nothing. If they ask for changes: enki outcome approval changes --by user --note "<their words>"`)
  }
  return lines.join('\n')
}

/** The project's timeout for a step, else its role's own, else half an hour. */
const timeoutFor = (config, state, step) => config.timeouts[step] ?? teamOf(state)[step]?.timeout ?? 1800000

// Plan steps: the orchestrator writes them, each with an owner, and they move with the work.
export const STEP_STATUSES = ['todo', 'active', 'done', 'failed']
// The owner is the orchestrator or one of the workflow's steps: checked against the team at approval.
const STEP_LINE = /^\s*(\d+)[.)]\s*\[([a-z][\w-]*)\]\s*(.+?)\s*$/i

/** "1. [Coder] Rewrite the intent flow" lines from the approved plan. */
export function parseSteps(plan) {
  return plan
    .split('\n')
    .map(line => STEP_LINE.exec(line))
    .filter(Boolean)
    .map(match => ({ n: Number(match[1]), owner: match[2].toLowerCase(), text: match[3], status: 'todo' }))
}


function setStep(taskDir, n, status, by) {
  const next = updateState(taskDir, current => {
    const step = current.steps?.find(item => item.n === n)
    if (step) step.status = status
  })
  const step = next.steps?.find(item => item.n === n)
  if (step) recordEvent(taskDir, 'step.status', { n, status, owner: step.owner, text: step.text, by })
  return step
}

/**
 * A test run's own plan steps (a plan can give one to a verify step): in progress while it runs,
 * then done when it passes and failed when it doesn't. Nobody asks a verify step with --step, so
 * this is the only way they move.
 */
function markVerifySteps(taskDir, node, status) {
  for (const step of readState(taskDir).steps ?? []) {
    if (step.owner !== node || step.status === status) continue
    if (status === 'active' && step.status === 'done') continue
    setStep(taskDir, step.n, status, node)
  }
}

/**
 * When an agent finishes, the plan steps it was sent for are done, or failed when its outcome went
 * to the orchestrator instead of on (blocked, an error, a timeout): that work isn't finished.
 */
function finishStep(taskDir, role, status = 'done') {
  const state = readState(taskDir)
  const agent = state.agents?.[role]
  for (const n of agent?.steps ?? (agent?.step ? [agent.step] : [])) {
    const step = state.steps?.find(item => item.n === n)
    if (step && step.status === 'active') setStep(taskDir, n, status, role)
  }
}

export function moveStep({ root, slug, n, status }) {
  if (!STEP_STATUSES.includes(status)) throw new EnkiError(`A step can be: ${STEP_STATUSES.join(', ')}`, EXIT.usage)
  const task = requireTask(root, slug)
  const step = task.steps?.find(item => item.n === n)
  if (!step) throw new EnkiError(`The plan has no step ${n}.`, EXIT.usage)
  setStep(task.taskDir, n, status, 'orchestrator')
  return `Step ${n} (${step.owner}: ${step.text}) is now ${status}.`
}

/** Checks the plan steps a brief is for (one visit does all of them), and marks them active. */
function startStep(task, role, given) {
  const planned = (task.steps ?? []).length > 0
  const numbers = given === undefined ? undefined : [...new Set([given].flat())]
  if (numbers === undefined) {
    const owns = (task.steps ?? []).some(item => item.owner === role)
    const needed = task.run ? task.approved && owns : !teamOf(task)[role]?.intake
    if (planned && needed) throw new EnkiError(`Name the plan steps this brief is for: enki ask ${role} <brief> --step N, or --step N,M for several. Steps for the ${role}: ${task.steps.filter(item => item.owner === role).map(item => item.n).join(', ') || 'none'}.`, EXIT.usage)
    return
  }
  for (const n of numbers) {
    const found = task.steps?.find(item => item.n === n)
    if (!found) throw new EnkiError(`The plan has no step ${n}.`, EXIT.usage)
    if (found.owner !== role) throw new EnkiError(`Step ${n} belongs to the ${found.owner}, not the ${role}.`, EXIT.usage)
  }
  updateState(task.taskDir, current => {
    // `step` is the first, for readers from before a visit could do several.
    current.agents[role].step = numbers[0]
    current.agents[role].steps = numbers
  })
  for (const n of numbers) setStep(task.taskDir, n, 'active', role)
}

export async function ask({ root, slug, role, briefPath, report, step, timeout }) {
  requireHerdr()
  if (!existsSync(briefPath)) throw new EnkiError(`No brief at ${briefPath}.`, EXIT.usage)
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  const entry = teamOf(task)[role]
  if (!entry) {
    if (task.run?.steps[role]) throw new EnkiError(`${role} is a built-in step with no agent. Run it with: enki ${role}`, EXIT.usage)
    throw new EnkiError(`Unknown step "${role}". This task's steps: ${agentSteps(teamOf(task)).join(', ')}.`, EXIT.usage)
  }
  const graph = Boolean(task.run)
  if (!graph && !entry.intake && !task.approved) throw new EnkiError(`The ${role} can't work until the plan is approved.`)
  if (task.approved && task.workflowProblems?.length) {
    throw new EnkiError(`The approved plan's workflow can't run:\n- ${task.workflowProblems.join('\n- ')}\nRun enki phase planning, fix the plan and present it again.`)
  }
  // Whether the workflow has work for it comes first: an agent not yet started may not be needed.
  if (graph) {
    const why = notReady(task.run, readWorkflowSnapshot(task.taskDir), role)
    if (why && task.run.steps[role]?.status !== 'running') throw new EnkiError(`${why[0].toUpperCase()}${why.slice(1)}. See what's ready with: enki next`)
  }
  const name = task.agents[role]?.name
  if (!name) throw new EnkiError(`The ${role} isn't started. Use: enki team start`)

  const agent = await herdr.getAgent(name)
  if (!agent) throw new EnkiError(`${name} is no longer running. Tell the user: its pane may have been closed.`)
  if (agent.agent_status === 'blocked') return blockedResult(task, role, name)
  if (agent.agent_status === 'working') {
    throw new EnkiError(`${name} is still working. Use: enki wait ${role}`, EXIT.busy)
  }
  if (graph) {
    const why = notReady(task.run, readWorkflowSnapshot(task.taskDir), role)
    if (why) throw new EnkiError(`${why[0].toUpperCase()}${why.slice(1)}. See what's ready with: enki next`)
    if (entry.capabilities.blind && !hasReport(task, 'requirements.md')) {
      throw new EnkiError(`The ${role} works from requirements.md, and it doesn't exist yet: enki writes it from the approved plan's "## Requirements" section.`)
    }
    if (phasesOf(readWorkflowSnapshot(task.taskDir)).before.has(role) && !hasReport(task, 'request.md')) {
      throw new EnkiError(`Write the user's request to ${join(task.taskDir, 'request.md')} first, in their own words: the steps before the plan work from it.`)
    }
  } else if (!entry.intake) await checkGates(task, role)
  startStep(task, role, step)
  let visit = null
  let inputs = []
  const next = updateState(task.taskDir, current => {
    // New code or new tests mean the last test result no longer says anything.
    if (entry.capabilities.write !== 'none') current.verify = null
    if (graph) {
      ;({ visit, inputs } = startRunStep(current.run, role))
      current.run.steps[role].report = report ?? `${role}-r${visit}.md`
    }
    if (!graph && entry.intake && current.agents[role]) current.agents[role].reported = null
  })
  const reportFile = graph ? next.run.steps[role].report : entry.intake && !report ? `${role}.md` : reportName(role, task, report)
  const envelope = writeEnvelope(task, role, briefPath, reportFile, inputs)
  const prompt = `Read ${envelope} and follow it.`
  recordEvent(task.taskDir, 'agent.asked', { role, name, envelope, round: task.round, ...(graph ? { visit } : {}) })
  if (graph) recordEvent(task.taskDir, 'step.started', { step: role, visit, inputs: inputs.map(input => input.from) })

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
  return finishWait(task, role, name, timeout ?? timeoutFor(config, task, role), 40)
}

export async function wait({ root, slug, role, timeout }) {
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  const name = task.agents[role]?.name
  if (!name) throw new EnkiError(`The ${role} isn't started.`)
  const limit = timeout ?? timeoutFor(config, task, role)
  // A prompt may have been answered a moment ago, so wait through it, not on it.
  if ((await herdr.getAgent(name))?.agent_status === 'blocked') {
    try {
      await herdr.waitForAgent(name, ['working', 'idle', 'done'], limit)
    } catch (error) {
      if (error.code !== 'timeout') throw error
      return { exitCode: EXIT.blocked, status: 'blocked', output: `${name} is still waiting on a prompt after ${limit} ms. Read it with enki read ${role}, then run: enki answer ${role} <option>` }
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
export async function verify({ root, slug, step = null, baseline = false, knownFailures = false, timeout }) {
  const task = requireTask(root, slug)
  const config = loadTaskConfig(task)
  // After approval, a test run is a step of the workflow: it runs when the graph says it's ready.
  let node = null
  // Before approval, a test run is just a look at the tree: no step of the workflow.
  if (!baseline && task.run && task.approved) {
    const workflow = readWorkflowSnapshot(task.taskDir)
    const checks = workflow.nodes.filter(item => item.kind === 'verify').map(item => item.id)
    if (checks.length === 0) throw new EnkiError('This workflow has no verify step. Run the baseline with: enki verify --baseline')
    node = step ?? checks.find(id => !notReady(task.run, workflow, id)) ?? checks[0]
    if (!checks.includes(node)) throw new EnkiError(`"${node}" isn't a verify step. This workflow's: ${checks.join(', ')}`, EXIT.usage)
    const why = notReady(task.run, workflow, node)
    if (why) throw new EnkiError(`${why[0].toUpperCase()}${why.slice(1)}. See what's ready with: enki next`, EXIT.busy)
  }
  if (!baseline && task.approved) {
    for (const role of agentSteps(teamOf(task)).filter(id => teamOf(task)[id].capabilities.write !== 'none')) {
      if (await isWorking(task, role)) throw new EnkiError(`The ${role} is still working, so a test run now wouldn't mean anything. Run enki verify when it reports.`, EXIT.busy)
    }
    if (!task.run && task.tests === true && !hasReport(task, 'tests.md')) throw new EnkiError('The tester hasn\'t reported its tests yet (tests.md). The plan can opt out with "Tests: none".')
  }
  if (node) {
    updateState(task.taskDir, current => {
      startRunStep(current.run, node)
    })
    recordEvent(task.taskDir, 'step.started', { step: node })
    markVerifySteps(task.taskDir, node, 'active')
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
  const settled = node ? settleStep(task.taskDir, node, { outcome: passed || accepted ? 'pass' : 'fail' }) : null
  if (node) markVerifySteps(task.taskDir, node, passed || accepted ? 'done' : 'failed')
  return { exitCode: passed || accepted ? EXIT.ok : EXIT.failed, status, output: [...summary, ...details, ...(settled ? ['', settled.text] : [])].join('\n') }
}

/** The orchestrator's view of the run: what to brief now, what's running and what's with it. */
export function next({ root, slug }) {
  const task = requireTask(root, slug)
  if (task.workflowProblems?.length) return `The approved plan's workflow can't run:\n- ${task.workflowProblems.join('\n- ')}\nRun enki phase planning, fix the plan and present it again.`
  if (!task.run) {
    if (!task.approved) return `This task started before workflows. Before the plan is approved, only these steps can work: ${agentSteps(teamOf(task)).filter(id => teamOf(task)[id].intake).join(', ') || 'none'}.`
    return 'This task was approved before workflows: follow the fixed flow in the execute skill.'
  }
  const workflow = readWorkflowSnapshot(task.taskDir)
  const lines = [`Workflow: ${workflow.name ?? workflow.id}`]
  for (const id of readySteps(task.run, workflow)) {
    const step = task.run.steps[id]
    const node = workflow.nodes.find(item => item.id === id)
    if (node.kind === 'verify') {
      lines.push(`- ${id}: ready. Run: enki verify${workflow.nodes.filter(item => item.kind === 'verify').length > 1 ? ` ${id}` : ''}`)
      continue
    }
    const from = step.inputs.map(input =>
      input.from === 'plan' ? 'the approved plan'
        : input.from === 'request' ? 'the user\'s request (request.md)'
          : input.from === 'orchestrator' ? `your note${input.note ? ` ("${input.note}")` : ''}`
            : input.from === 'approval' ? `the user's requested changes${input.note ? ` ("${input.note}")` : ''}`
              : `${input.from}: ${input.outcome}${input.report ? ` (${input.report})` : ''}`,
    )
    const blind = teamOf(task)[id]?.capabilities.blind ? ' It is blind: brief it from requirements.md, never from other steps\' reports.' : ''
    lines.push(`- ${id}: ready, visit ${step.visits + 1}. Sent by ${from.join(', ')}.${blind} Brief it, then: enki ask ${id} <brief>`)
  }
  const summary = nextSummary(task)
  lines.push(...summary.split('\n').filter(line => line && !line.startsWith('Ready:')))
  if (lines.length === 1) lines.push('Nothing is ready, running or waiting.')
  return lines.join('\n')
}

/** A worker's outcome for its current step. Run by the worker itself, before its reply. */
export function reportOutcome({ outcome, env = process.env }) {
  const step = env.ENKI_STEP || env.ENKI_ROLE
  if (!step || !env.ENKI_TASK) throw new EnkiError('Only a worker reports an outcome. To decide one for a step, ask the user, then: enki outcome <step> <outcome> --by user')
  const task = readState(env.ENKI_TASK)
  const entry = teamOf(task)[step]
  const allowed = (entry?.outcomes ?? []).map(item => item.id)
  if (!allowed.includes(outcome)) throw new EnkiError(`"${outcome}" isn't an outcome of ${step}. Report one of: ${allowed.join(', ')}`, EXIT.usage)
  updateState(task.taskDir, current => {
    const own = current.run?.steps[step]
    if (own && own.status === 'running') own.reported = outcome
    else if (!current.run && entry.intake && current.agents[step]) current.agents[step].reported = outcome
    else throw new EnkiError(`${step} isn't working on anything right now, so there's nothing to report.`)
  })
  recordEvent(task.taskDir, 'step.reported', { step, outcome })
  return `Reported: ${outcome}. Now finish with your reply.`
}

/** A handed-off step goes back to work, with the orchestrator's note. The orchestrator may do this alone. */
export function resumeHandedOff({ root, slug, step, note }) {
  const task = requireTask(root, slug)
  if (!task.run) throw new EnkiError('This task has no workflow run.')
  const workflow = readWorkflowSnapshot(task.taskDir)
  const node = workflow.nodes.find(item => item.id === step)
  const own = task.run.steps[step]
  if (own && own.handoffs > (node?.handoffs ?? DEFAULT_HANDOFFS)) {
    throw new EnkiError(`${step} has been handed to you ${own.handoffs} times, more than its limit. Stop here: tell the user what's open, and let them decide.`)
  }
  let problem = null
  const next = updateState(task.taskDir, current => {
    problem = resumeStep(current.run, step, note)
  })
  if (problem) throw new EnkiError(problem)
  recordEvent(task.taskDir, 'step.resumed', { step, note: note ?? null })
  return [`${step} is queued again${note ? ', with your note' : ''}.`, nextSummary(next)].join('\n')
}

/** The user's decision for a handed-off step: the workflow moves on as if the step had reported it. */
export function overrideOutcome({ root, slug, step, outcome, by, note = null }) {
  if (by !== 'user') throw new EnkiError(`Choosing an outcome for a step is the user's decision. Ask them, then run: enki outcome ${step} ${outcome} --by user`)
  const task = requireTask(root, slug)
  if (!task.run?.steps[step]) throw new EnkiError(`"${step}" isn't a step of this task's workflow.`, EXIT.usage)
  if (step === 'approval') return changePlan(task, outcome, note)
  if (task.run.steps[step].status !== 'handed-off') throw new EnkiError(`${step} isn't with the orchestrator, so its outcome is its own to report.`)
  const workflow = readWorkflowSnapshot(task.taskDir)
  const node = workflow.nodes.find(item => item.id === step)
  const allowed = node.kind ? outcomesOf(node, new Map()) : (teamOf(task)[step]?.outcomes ?? []).map(item => item.id)
  if (!allowed.includes(outcome)) throw new EnkiError(`"${outcome}" isn't an outcome of ${step}: ${allowed.join(', ')}`, EXIT.usage)
  if (!edgeFor(workflow, step, outcome)) throw new EnkiError(`${step}'s "${outcome}" leads nowhere in this workflow, so it would only come back to you.`)
  recordEvent(task.taskDir, 'step.overridden', { step, outcome, by: 'user', note })
  return settleStep(task.taskDir, step, { outcome, byUser: true, note }).text
}

/**
 * The user's changes to the plan go back to the planner, with their words. Before approval the plan
 * is just withdrawn; after it, every step after Approval stops where it is, and the new plan needs
 * its own approval.
 */
function changePlan(task, outcome, note) {
  if (outcome !== 'changes') throw new EnkiError('The user approves a plan only by accepting the plan dialog (ExitPlanMode). What they can send back is: enki outcome approval changes --by user --note "<their words>"', EXIT.usage)
  if (!note) throw new EnkiError('Pass the user\'s requested changes, in their words: --note "<their words>"', EXIT.usage)
  const workflow = readWorkflowSnapshot(task.taskDir)
  const report = planReport(task.run)
  if (!awaitingApproval(task.run)) {
    if (!task.approved) throw new EnkiError('There is no plan yet: the planner hasn\'t finished one. Pass the user\'s words to it in its brief instead.')
    let busy = []
    updateState(task.taskDir, current => {
      busy = reopenPlan(current.run, workflow)
    })
    if (busy.length > 0) throw new EnkiError(`${busy.join(', ')} ${busy.length === 1 ? 'is' : 'are'} still working on the approved plan. Wait for ${busy.length === 1 ? 'it' : 'them'} first: enki wait ${busy[0]}`)
    recordEvent(task.taskDir, 'plan.reopened', { plan: report })
  }
  recordEvent(task.taskDir, 'step.overridden', { step: 'approval', outcome, by: 'user', note })
  return settleStep(task.taskDir, 'approval', { outcome, byUser: true, note, report }).text
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
  intake: 'Brief the steps enki next names, and relay the planner\'s questions to the user. Skill: enki:task',
  planning: 'Present the planner\'s plan exactly as written, with EnterPlanMode and ExitPlanMode. Skill: enki:task',
  approved: 'Run enki team start, then the baseline. Skill: enki:execute',
  baseline: 'Baseline running. Skill: enki:execute',
  coding: 'The workflow is running: enki next says what to brief. Skill: enki:execute',
  testing: 'The workflow is running: enki next says what to brief. Skill: enki:execute',
  review: 'The workflow is running: enki next says what to brief. Skill: enki:execute',
  fixing: 'The workflow is running: enki next says what to brief. Skill: enki:execute',
  notes: 'Update the repo notes. Skill: enki:report',
  reporting: 'Write report.md. Skill: enki:report',
  done: 'Finished.',
}

async function agentSummary(task) {
  const lines = []
  for (const role of agentSteps(teamOf(task))) {
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
    `Task ${task.id}  phase: ${task.phase}  approved: ${task.approved}  workflow: ${task.workflow ?? 'fixed (before workflows)'}`,
    `Folder: ${task.taskDir}`,
    `Scope: ${task.scope.join(', ') || 'none'}  Repos: ${task.repos.map(repo => `${repo.name}${repo.url ? ` (${repo.url})` : ''}`).join(', ')}`,
    ...(task.continues?.slug ? [`Continues task ${task.continues.slug}: ${task.continues.taskDir}`] : []),
    ...(task.worktrees ?? []).map(tree => `Branch: ${tree.branch}, ${tree.continued ? `continued from ${tree.base.commit.slice(0, 7)}` : `from ${tree.base.branch}`}, in ${tree.path}`),
    ...task.repos.filter(repo => repo.memoryDir).map(repo => `Memory for ${repo.name}: ${repo.memoryDir}`),
    ...(task.database ? [`Database: ${task.database}`] : []),
    `Tests since the last change: ${currentVerify(task) ? (task.verify.passed ? 'passed' : task.verify.accepted ? 'accepted' : 'failed') : 'not run'}`,
    ...(await agentSummary(task)),
    ...(task.run ? [nextSummary(task)].filter(Boolean) : task.workflowProblems?.length ? [`Workflow problems: ${task.workflowProblems.join('; ')}`] : []),
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
  if (toPlanning && task.run) {
    if (phase === task.phase) return { phase, notes: [] }
    throw new EnkiError(
      task.approved
        ? 'The plan is approved. To change it, the user\'s words go back to the planner: enki outcome approval changes --by user --note "<their words>"'
        : 'The workflow sets this phase: the plan goes to the user when the planner reports ready. See: enki next',
    )
  }
  const intake = agentSteps(teamOf(task)).filter(id => teamOf(task)[id].intake)
  if (phase === 'planning' && intake.length > 0 && !intake.some(id => existsSync(join(task.taskDir, `${id}.md`)))) {
    throw new EnkiError(`There is no ${intake[0]} report yet. Every task, however small, starts with: enki ask ${intake[0]} <brief>`)
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
      results = finishWorktrees({ worktrees: task.worktrees, repos: task.repos, message, branch: task.branch ?? task.slug, abandon })
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
    for (const tree of results) notes.push(finishNote(tree))
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

/** What happened to one worktree's branch, and how to review it. */
function finishNote(tree) {
  const start = tree.base.commit.slice(0, 7)
  if (tree.aside) return `The abandoned work was committed to a new branch, ${tree.branch} (${tree.commit}), so ${tree.base.branch} is unchanged.`
  if (tree.continued) {
    return tree.committed
      ? `Committed ${tree.files} file(s) on top of branch ${tree.branch} (${start} → ${tree.commit}). Review this task's change with: git diff ${start}..${tree.branch}. Push ${tree.branch} to update its pull request.`
      : `Nothing changed, so branch ${tree.branch} is as it was.`
  }
  return tree.committed
    ? `Committed ${tree.files} file(s) to branch ${tree.branch} (${tree.commit}), from ${tree.base.branch}. Review with: git diff ${tree.base.branch}...${tree.branch}`
    : `Nothing changed, so branch ${tree.branch} was deleted.`
}

async function serverCleanup(task) {
  const config = loadTaskConfig(task)
  const lines = []
  for (const repo of serverRepos(task)) {
    if (task.servers?.[repo.name]) lines.push(await stopServer(task, config, repo))
  }
  return lines
}

export const readApprovedScope = plan => ({
  workflow: /^\W*Workflow:\s*([a-z][a-z0-9-]*)/im.exec(plan)?.[1] ?? null,
  skip: (/^\W*Skip:\s*(.+)$/im.exec(plan)?.[1] ?? '').split(/[\s,]+/).map(item => item.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean),
  database: /^\W*Database:\W*(copy|shared|none)\b/im.exec(plan)?.[1].toLowerCase() ?? null,
  scope: [...plan.matchAll(/^\W*Scope:\s*([a-z-]+)/gim)].map(match => match[1].toLowerCase()),
  tests: !/^\W*Tests:\W*none\b/im.test(plan),
  qa: !/^\W*QA:\W*none\b/im.test(plan),
})

/**
 * The workflow a plan runs: its `Workflow:` or the task's, without the steps it skips, and team
 * entries for steps the task doesn't have yet. Nothing is written: approval does that.
 */
function approvedWorkflow(task, { workflow: chosen, skip, tests, qa }, steps) {
  const config = loadTaskConfig(task)
  let resolved
  try {
    resolved = projectWorkflow(task.projectRoot, config, chosen ?? task.workflow ?? config.workflow ?? DEFAULT_WORKFLOW)
  } catch (error) {
    if (error instanceof EnkiError) return { problems: [error.message] }
    throw error
  }
  const has = id => resolved.workflow.nodes.some(node => node.id === id)
  const skipped = [...new Set([...skip, ...(tests ? [] : ['tester']), ...(qa ? [] : ['qa'])])]
  const problems = skipped.filter(id => !has(id) && skip.includes(id)).map(id => `Skip: the workflow has no step "${id}"`)
  const builtin = resolved.workflow.nodes.filter(node => ['start', 'approval', 'end'].includes(node.kind)).map(node => node.id)
  problems.push(...skipped.filter(id => builtin.includes(id)).map(id => `Skip: ${id} can't be skipped`))
  const workflow = withoutSteps(resolved.workflow, skipped.filter(id => has(id) && !builtin.includes(id)))
  problems.push(...workflowProblems(workflow, resolved.roles).map(problem => `${workflow.id}${skipped.length ? ` without ${skipped.join(', ')}` : ''}: ${problem}`))
  const ids = new Set(workflow.nodes.filter(node => !node.kind || node.kind === 'verify').map(node => node.id))
  for (const item of steps) {
    if (item.owner !== 'orchestrator' && !ids.has(item.owner) && !skipped.includes(item.owner)) problems.push(`Steps: step ${item.n} belongs to "${item.owner}", which isn't in the workflow (${[...ids].join(', ')})`)
  }
  const fresh = Object.fromEntries(Object.entries(resolved.team).filter(([id]) => ids.has(id) && !task.team?.[id]))
  return { workflow, problems, fresh }
}

/** The plan's `## Requirements` section: all the blind steps get. */
export function requirementsOf(plan) {
  const match = /^(#{1,3})\s+Requirements\s*$/im.exec(plan)
  if (!match) return null
  // The section runs to the next heading of its own level or higher: its own subsections stay in.
  const rest = plan.slice(match.index + match[0].length)
  const end = new RegExp(`^#{1,${match[1].length}}\\s+\\S`, 'm').exec(rest)
  const body = (end ? rest.slice(0, end.index) : rest).trim()
  return body || null
}

/** Why a planning step's report can't go to the user as the plan, or nothing. */
function planProblems(state, report) {
  const path = report ? join(state.taskDir, report) : null
  if (!path || !existsSync(path)) return [`there's no plan at ${path ?? 'its report'}`]
  const text = readFileSync(path, 'utf8')
  const problems = []
  const steps = parseSteps(text)
  if (steps.length === 0) problems.push('it has no Steps list ("1. [Coder] ...", one owner per step)')
  if (!requirementsOf(text)) problems.push('it has no "## Requirements" section for the steps that judge the work blind')
  const scope = readApprovedScope(text)
  const flow = approvedWorkflow(state, scope, steps)
  problems.push(...flow.problems)
  // A plan can't count on work no step may do: with nobody to write tests, it has to say so.
  if (flow.workflow && flow.problems.length === 0 && scope.tests) {
    const roles = loadRoles(state.projectRoot)
    if (workflowGaps(flow.workflow, node => roles.get(node.agent) ?? null).some(gap => gap.startsWith('No step can write tests'))) {
      problems.push(`no step in ${flow.workflow.id} can write tests, so the plan has to say "Tests: none", or switch to a workflow with a step that writes them`)
    }
  }
  return problems.map(problem => problem.replace(/\s*\n\s*/g, ' '))
}

/** Called only by the ExitPlanMode hook, which only fires after the user approves. */
export function approvePlan(task, planText) {
  if (!task.run) return approveLegacyPlan(task, planText)
  const problem = planCheck(task, planText)
  if (problem) throw new EnkiError(problem)
  const report = planReport(task.run)
  const scopeLines = readApprovedScope(planText)
  const { scope, tests, qa, database } = scopeLines
  const steps = parseSteps(planText)
  writeFileSync(join(task.taskDir, 'approved-plan.md'), planText)
  const requirements = requirementsOf(planText)
  if (requirements) writeFileSync(join(task.taskDir, 'requirements.md'), `# Requirements\n\n${requirements}\n`)
  const mode = planDatabase(loadTaskConfig(task).database, database)
  const flow = approvedWorkflow(task, scopeLines, steps)
  const runnable = flow.problems.length === 0
  const team = runnable ? { ...(hasTeam(task) ? task.team : {}), ...snapshotTeam(task.taskDir, flow.fresh) } : task.team
  if (runnable) writeWorkflowSnapshot(task.taskDir, flow.workflow)
  const before = phasesOf(readWorkflowSnapshot(task.taskDir)).before
  const next = updateState(task.taskDir, current => {
    current.team = team
    current.workflowProblems = runnable ? null : flow.problems
    if (runnable) {
      if (flow.workflow.id !== current.run.workflow) switchWorkflow(current.run, flow.workflow)
      current.workflow = flow.workflow.id
      current.run.plan = report
      routeOutcome(current.run, flow.workflow, 'approval', 'approved', { report })
      current.run.steps.approval.inputs = []
    }
    current.database = mode
    current.phase = 'approved'
    current.approved = true
    current.scope = scope
    current.tests = tests
    current.qa = qa
    current.steps = steps
  })
  writeRules(next, loadTaskConfig(next))
  recordEvent(task.taskDir, 'plan.approved', { scope, tests, qa, database: next.database, steps: steps.length, workflow: next.workflow, plan: report, problems: next.workflowProblems })
  if (runnable) recordEvent(task.taskDir, 'step.outcome', { step: 'approval', outcome: 'approved', to: targetsOf(edgeFor(flow.workflow, 'approval', 'approved')), by: 'user' })
  // The steps before the plan have done their work by now: so have their plan steps.
  for (const step of steps.filter(item => before.has(item.owner) && next.run.steps[item.owner]?.visits > 0)) setStep(task.taskDir, step.n, 'done', step.owner)
  return readState(task.taskDir)
}

/** A task started before workflows: approved into the fixed flow it was planned for. */
function approveLegacyPlan(task, planText) {
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
  writeRules(next, loadTaskConfig(next))
  recordEvent(task.taskDir, 'plan.approved', { scope, tests, qa, database: next.database, steps: steps.length, workflow: null })
  if (existsSync(join(task.taskDir, 'scout.md'))) for (const step of steps.filter(item => item.owner === 'scout')) setStep(task.taskDir, step.n, 'done', 'scout')
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
  // The steps of the project's workflow: each loads its agent's skills and the ones the step adds.
  const { team } = projectWorkflow(root, config)
  const resolved = resolveTeamSkills(root, team, repos)
  return Object.keys(team).map(role => {
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
  baseBranch: 'dev',
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
