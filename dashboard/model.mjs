// What the dashboard shows, built from what enki already writes: the project registry, each
// task's state and event log, the activity log, Claude's transcripts and herdr's live list.
// Nothing here writes anything.
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { DEFAULTS, ROLES } from '../src/config.mjs'
import { loadProjectConfig } from '../src/memory.mjs'
import { enkiHome, listTasks, readEvents } from '../src/state.mjs'
import { git, goalOf } from '../src/worktrees.mjs'

const run = promisify(execFile)

export const AGENT_ROLES = ['orchestrator', ...ROLES]
export const ROLE_LABELS = { orchestrator: 'Orchestrator', scout: 'Scout', coder: 'Coder', tester: 'Tester', qa: 'QA', reviewer: 'Reviewer' }

/** herdr's live agents, or null when herdr can't be reached. */
export async function herdrAgents() {
  try {
    const { stdout } = await run(process.env.ENKI_HERDR_BIN || 'herdr', ['agent', 'list'], { timeout: 5000 })
    return JSON.parse(stdout).result.agents ?? []
  } catch {
    return null
  }
}

export function projects() {
  const path = join(enkiHome(), 'projects.json')
  if (!existsSync(path)) return []
  let registry
  try {
    registry = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return []
  }
  return Object.entries(registry)
    .filter(([, entry]) => existsSync(join(entry.root, '.enki', 'config.json')))
    .map(([id, entry]) => ({ id, root: entry.root, name: basename(entry.root), lastUsedAt: entry.lastUsedAt }))
    .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
}

function readLines(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
}

const requirementsGoal = task => {
  const path = join(task.taskDir, 'requirements.md')
  return existsSync(path) ? goalOf(readFileSync(path, 'utf8')) : null
}

/** The goal's first sentence: the goal itself can be a paragraph. */
export const titleOf = goal => (goal ? goal.split(/(?<=[.!?])\s+/)[0].replace(/[.]$/, '') : null)

function finishedAt(events) {
  return events.findLast(event => event.type === 'task.phase' && event.data.to === 'done')?.t ?? null
}

const byName = agents => new Map((agents ?? []).filter(agent => agent.name).map(agent => [agent.name, agent]))

/** One task, short: for lists. */
export function taskSummary(task, events, live) {
  const abandoned = events.some(event => event.type === 'task.abandoned')
  const done = task.phase === 'done'
  const names = byName(live)
  const waiting = !done && Object.values(task.agents ?? {}).some(agent => names.get(agent.name)?.agent_status === 'blocked')
  const status = done ? (abandoned ? 'abandoned' : 'done') : waiting ? 'needs-you' : 'running'
  const end = done ? finishedAt(events) : null
  const goal = requirementsGoal(task)
  return {
    id: task.id,
    slug: task.slug,
    title: titleOf(goal) ?? task.slug,
    goal,
    status,
    phase: task.phase,
    round: task.round,
    branch: task.worktrees?.[0]?.branch ?? null,
    base: task.worktrees?.[0]?.base?.branch ?? null,
    startedAt: task.createdAt,
    finishedAt: end,
    elapsedMs: Date.parse(end ?? new Date().toISOString()) - Date.parse(task.createdAt),
  }
}

const STATES = { working: 'running', blocked: 'needs-you', idle: 'idle', done: 'done' }

/** The orchestrator's sessions: one per start or /clear, recorded at task creation and by the SessionStart hook. */
const orchestratorSessions = (events, task, live) => {
  const sessions = events.filter(event => event.type === 'orchestrator.session').map(event => event.data.session)
  const current = task && (live ?? []).find(agent => agent.pane_id === task.orchestratorPane)?.agent_session?.value
  if (current && task.phase !== 'done') sessions.push(current)
  return [...new Set(sessions.filter(Boolean))]
}

/**
 * The model's context window. Claude Code gives every plan, Pro included, the full 1M window on the
 * models that have one: the 5 family and Opus or Sonnet 4.6 and later. A "[1m]" model name asks for it
 * on older ones. Anything seen above the table's figure means the session had the larger window.
 */
export function windowFor(model, context = 0) {
  const name = model ?? ''
  const large = /\[1m\]$/i.test(name) || /^claude-(fable|mythos|opus|sonnet|haiku)-5/.test(name) || /^claude-(opus|sonnet)-4-([6-9]|\d\d)/.test(name)
  const size = large ? 1000000 : 200000
  return context > size ? 1000000 : size
}

function agentCards(task, events, live, tokens, config) {
  const names = byName(live)
  const activity = readLines(join(task.taskDir, 'activity.jsonl'))
  const done = task.phase === 'done'
  const roles = AGENT_ROLES.filter(role => role !== 'qa' || task.qa !== false)
  return roles.map(role => {
    const known = role === 'orchestrator' ? null : task.agents?.[role]
    const herdr = role === 'orchestrator' ? (live ?? []).find(agent => agent.pane_id === task.orchestratorPane) : known && names.get(known.name)
    let state
    if (role !== 'orchestrator' && !known) state = 'not-started'
    else if (done) state = 'done'
    else if (herdr) state = STATES[herdr.agent_status] ?? 'idle'
    else if (role === 'orchestrator' || live === null) state = 'stopped'
    else state = 'error'
    const sessions = role === 'orchestrator' ? orchestratorSessions(events, task, live) : [known?.session].filter(Boolean)
    const usage = sessions.map(session => tokens.session(session)).filter(Boolean)
    const spent = usage.reduce((sum, item) => sum + item.spent, 0)
    const latest = usage.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).at(-1)
    const calls = activity.filter(entry => entry.role === role).length
    const stepN = role === 'orchestrator' ? task.steps?.find(step => step.owner === 'orchestrator' && step.status === 'active')?.n : known?.step
    const step = task.steps?.find(item => item.n === stepN) ?? null
    return {
      role,
      label: ROLE_LABELS[role],
      name: herdr?.name ?? known?.name ?? null,
      state,
      model: latest?.model ?? (role === 'orchestrator' ? null : config?.team?.[role]?.model ?? DEFAULTS.team[role]?.model ?? null),
      step: step ? { n: step.n, text: step.text, status: step.status } : null,
      calls,
      spent,
      context: latest?.context ?? 0,
      contextWindow: latest ? windowFor(latest.model, latest.context) : null,
    }
  })
}

const STEP_WORD = { todo: 'to do', active: 'in progress', done: 'done', failed: 'failed' }

/** A sentence for each event worth showing. Agent-written text stays plain text. */
function feedLine(event) {
  const d = event.data ?? {}
  const who = ROLE_LABELS[d.role] ?? 'Orchestrator'
  switch (event.type) {
    case 'task.created':
      return ['orchestrator', 'started the task']
    case 'plan.approved':
      return ['orchestrator', d.steps ? `got the plan approved, with ${d.steps} steps` : 'got the plan approved']
    case 'team.started':
      return ['orchestrator', 'started the team']
    case 'agent.started':
      return [d.role, 'joined']
    case 'agent.asked':
      return [d.role, 'was given a brief']
    case 'agent.finished':
      return [d.role, 'reported back']
    case 'agent.blocked':
      return [d.role, 'is waiting for an answer']
    case 'agent.answered':
      return ['orchestrator', `answered ${ROLE_LABELS[d.role] ?? d.role}'s prompt: ${d.label}`]
    case 'agent.timeout':
      return [d.role, 'took longer than its time limit']
    case 'step.status':
      return [d.owner, `step ${d.n}, ${d.text}: ${STEP_WORD[d.status] ?? d.status}`]
    case 'verify.finished':
      return ['orchestrator', d.baseline ? `ran the baseline: ${d.passed ? 'passed' : 'failing'}` : d.passed ? `tests passed in round ${d.round}` : d.accepted ? `tests accepted as known failures in round ${d.round}` : `tests failed in round ${d.round}`]
    case 'task.round':
      return ['orchestrator', `started fix round ${d.round}`]
    case 'task.phase':
      return ['orchestrator', `moved to ${d.to}`]
    case 'server.started':
      return ['qa', `started the ${d.repo} server`]
    case 'server.failed':
      return ['qa', `couldn't start the ${d.repo} server`]
    case 'policy.denied':
      return [d.role, `was refused: ${d.reason}`]
    case 'worktree.finished':
      return ['orchestrator', d.results.map(result => (result.committed ? `committed to branch ${result.branch}` : `left branch ${result.branch} empty`)).join(', ')]
    case 'task.abandoned':
      return ['orchestrator', 'abandoned the task']
    default:
      return null
  }
}

function feed(events) {
  return events
    .flatMap(event => {
      const line = feedLine(event)
      return line ? [{ at: event.t, role: line[0] ?? 'orchestrator', label: ROLE_LABELS[line[0]] ?? 'Orchestrator', text: line[1] }] : []
    })
    .reverse()
    .slice(0, 60)
}

function alerts(task, events, cards) {
  const list = []
  for (const card of cards) {
    if (card.state === 'needs-you') list.push({ kind: 'warning', word: 'Needs you:', text: `${card.label} is waiting for an answer in its pane.` })
    if (card.state === 'error') list.push({ kind: 'danger', word: 'Error:', text: `${card.label} is no longer running, but the task is still open.` })
  }
  const verify = task.verify
  if (verify && verify.round === task.round && !verify.baseline && !verify.passed && !verify.accepted) {
    list.push({ kind: 'danger', word: 'Error:', text: `Tests failed in round ${task.round}.` })
  }
  if (events.some(event => event.type === 'task.round_limit')) list.push({ kind: 'danger', word: 'Error:', text: 'The fix round limit was reached.' })
  const lastCommitFailure = events.findLast(event => event.type === 'worktree.commit_failed')
  if (lastCommitFailure && task.phase !== 'done') list.push({ kind: 'danger', word: 'Error:', text: 'The final commit failed. A git hook may have refused it.' })
  return list
}

/**
 * Tasks finished before enki marked these steps itself: the scout's step was done before the plan was
 * approved, and the orchestrator's own steps are done once the task finished.
 */
function shownStatus(step, task, events) {
  if (step.status === 'done' || step.status === 'failed') return step.status
  if (step.owner === 'scout' && events.some(event => event.type === 'agent.finished' && event.data.role === 'scout')) return 'done'
  if (step.owner === 'orchestrator' && task.phase === 'done' && !events.some(event => event.type === 'task.abandoned')) return 'done'
  return step.status
}

function readTask(root, id) {
  return listTasks(root).find(task => task.id === id) ?? null
}

/** Everything for the task view. */
export function taskDetail(project, taskId, live, tokens) {
  const task = readTask(project.root, taskId)
  if (!task) return null
  const events = readEvents(task.taskDir)
  let config = null
  try {
    config = loadProjectConfig(project.root)
  } catch {
    // An invalid config still shows the task, without the configured models.
  }
  const cards = agentCards(task, events, live, tokens, config)
  const steps = (task.steps ?? []).map(step => ({ ...step, status: shownStatus(step, task, events), label: ROLE_LABELS[step.owner] }))
  return {
    ...taskSummary(task, events, live),
    project: { id: project.id, name: project.name },
    agents: cards,
    steps,
    feed: feed(events),
    alerts: alerts(task, events, cards),
    stats: {
      active: cards.filter(card => card.state === 'running').length,
      agents: cards.filter(card => card.state !== 'not-started').length,
      spent: cards.reduce((sum, card) => sum + card.spent, 0),
      stepsDone: steps.filter(step => step.status === 'done').length,
      steps: steps.length,
    },
  }
}

const dayKey = date => date.toLocaleDateString('sv-SE')

function settings(project, orchestratorModel = null) {
  let config
  try {
    config = loadProjectConfig(project.root)
  } catch (error) {
    return { rows: [{ label: 'Config', value: `Invalid: ${error.message.split('\n')[0]}` }], models: [], repos: [] }
  }
  const repos = []
  const rows = []
  for (const repo of config.repos) {
    const branch = git(join(project.root, repo.path), ['branch', '--show-current'], { allowFail: true })
    repos.push({ name: repo.name, branch: branch || null })
    rows.push({ label: `Repo ${repo.name}`, value: `${repo.path}${branch ? `, on ${branch}` : ''}` })
    if (repo.test.length) rows.push({ label: 'Tests', value: repo.test.join(', ') })
    if (repo.devServer.start) rows.push({ label: 'Dev server', value: repo.devServer.start })
  }
  rows.push({ label: 'Manual testing', value: config.browser.driver === 'playwright' ? 'Playwright, headless' : config.browser.driver === 'chrome' ? 'Claude in Chrome' : 'None' })
  rows.push({ label: 'Memory', value: config.memory })
  rows.push({ label: 'Worktrees', value: config.worktrees ? `On, ports ${config.ports.from}-${config.ports.to}` : 'Off' })
  rows.push({ label: 'Fix rounds', value: `Up to ${config.maxFixRounds}` })
  const orchestrator = { role: 'orchestrator', label: ROLE_LABELS.orchestrator, model: orchestratorModel, skills: [] }
  return { rows, repos, models: [orchestrator, ...ROLES.map(role => ({ role, label: ROLE_LABELS[role], model: config.team[role].model, skills: config.team[role].skills }))] }
}

/** The model the user's own sessions ran on most recently: the orchestrator has no configured model. */
function latestOrchestratorModel(withEvents, live, tokens) {
  const usage = withEvents.flatMap(({ task, events }) => orchestratorSessions(events, task, live).map(session => tokens.session(session))).filter(item => item?.model)
  return usage.sort((a, b) => (a.at ?? '').localeCompare(b.at ?? '')).at(-1)?.model ?? null
}

/** Everything for the project view: tasks, a year of finished tasks, 90 days of tokens by role. */
export function projectDetail(project, live, tokens) {
  const tasks = listTasks(project.root)
  const withEvents = tasks.map(task => ({ task, events: readEvents(task.taskDir) }))
  const sessionsOf = ({ task, events }) => [
    ...orchestratorSessions(events, task, live).map(session => ['orchestrator', session]),
    ...Object.entries(task.agents ?? {}).filter(([, agent]) => agent.session).map(([role, agent]) => [role, agent.session]),
  ]
  const summaries = withEvents
    .map(item => ({ ...taskSummary(item.task, item.events, live), spent: sessionsOf(item).reduce((sum, [, session]) => sum + (tokens.session(session)?.spent ?? 0), 0) }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  const names = byName(live)
  const agentsWorking = withEvents
    .filter(({ task }) => task.phase !== 'done')
    .reduce((sum, { task }) => sum + Object.values(task.agents ?? {}).filter(agent => names.get(agent.name)?.agent_status === 'working').length, 0)

  const finished = {}
  for (const summary of summaries) {
    if (summary.status !== 'done' || !summary.finishedAt) continue
    const key = dayKey(new Date(summary.finishedAt))
    finished[key] = (finished[key] ?? 0) + 1
  }
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const start = new Date(today)
  start.setDate(start.getDate() - 52 * 7 - today.getDay())
  const heatmap = []
  for (let i = 0; i < 53 * 7; i++) {
    const date = new Date(start)
    date.setDate(start.getDate() + i)
    const key = dayKey(date)
    heatmap.push({ day: key, count: finished[key] ?? 0, future: date > today })
  }

  const byDay = {}
  for (const item of withEvents) {
    for (const [role, session] of sessionsOf(item)) {
      for (const row of tokens.daily(session)) {
        byDay[row.day] ??= {}
        byDay[row.day][role] = (byDay[row.day][role] ?? 0) + row.spent
      }
    }
  }
  const tokensByDay = []
  for (let i = 89; i >= 0; i--) {
    const date = new Date(today)
    date.setDate(today.getDate() - i)
    const key = dayKey(date)
    tokensByDay.push({ day: key, roles: byDay[key] ?? {} })
  }

  return {
    id: project.id,
    name: project.name,
    root: project.root,
    tasks: summaries,
    agentsWorking,
    heatmap,
    tokensByDay,
    settings: settings(project, latestOrchestratorModel(withEvents, live, tokens)),
  }
}

/** The sidebar's project list, with counts. */
export function projectList(live) {
  return projects().map(project => {
    const summaries = listTasks(project.root).map(task => taskSummary(task, readEvents(task.taskDir), live))
    return {
      id: project.id,
      name: project.name,
      running: summaries.filter(summary => summary.status === 'running').length,
      needsYou: summaries.filter(summary => summary.status === 'needs-you').length,
      total: summaries.length,
      tasks: summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    }
  })
}

/** Cheap to compute every two seconds: changes whenever anything the page shows could change. */
export function fingerprint(live, tokens) {
  const parts = [JSON.stringify((live ?? []).map(agent => [agent.name, agent.pane_id, agent.agent_status]))]
  const registry = join(enkiHome(), 'projects.json')
  if (existsSync(registry)) parts.push(statSync(registry).mtimeMs)
  let open = 0
  for (const project of projects()) {
    for (const task of listTasks(project.root)) {
      if (task.phase !== 'done') open += 1
      for (const file of ['state.json', 'events.jsonl', 'activity.jsonl']) {
        const path = join(task.taskDir, file)
        if (existsSync(path)) parts.push(statSync(path).mtimeMs)
      }
      if (task.phase !== 'done') {
        for (const agent of Object.values(task.agents ?? {})) parts.push(tokens.size(agent.session))
        for (const session of orchestratorSessions(readEvents(task.taskDir), task, live)) parts.push(tokens.size(session))
      }
    }
  }
  return { key: parts.join('|'), open }
}
