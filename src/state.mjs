// Task state, the event log and the machine-wide registry.
// Files are the source of truth: a task can always be resumed from its folder.
import { randomBytes } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

export const STATE_VERSION = 1
export const EVENT_VERSION = 1

export const PHASES = ['intake', 'planning', 'approved', 'baseline', 'coding', 'testing', 'review', 'fixing', 'notes', 'reporting', 'done']

const LOCK_STALE_MS = 10000
const LOCK_RETRY_MS = 25

export const enkiHome = () => process.env.ENKI_HOME || join(homedir(), '.enki')
export const tasksDir = root => join(root, '.enki', 'tasks')
export const statePath = taskDir => join(taskDir, 'state.json')

export function writeJsonAtomic(path, value) {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(temp, path)
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function withLock(path, fn) {
  const lock = `${path}.lock`
  const deadline = Date.now() + LOCK_STALE_MS * 2
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let age = 0
      try {
        age = Date.now() - statSync(lock).mtimeMs
      } catch {
        continue // Released between the failed open and the stat.
      }
      if (age > LOCK_STALE_MS) rmSync(lock, { force: true })
      else if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`)
      else sleepSync(LOCK_RETRY_MS)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

export function readState(taskDir) {
  return JSON.parse(readFileSync(statePath(taskDir), 'utf8'))
}

/** Read-modify-write under a lock, so two writers can't lose each other's changes. */
export function updateState(taskDir, change) {
  return withLock(statePath(taskDir), () => {
    const state = readState(taskDir)
    const next = change(state) ?? state
    next.updatedAt = new Date().toISOString()
    writeJsonAtomic(statePath(taskDir), next)
    return next
  })
}

/** The single path for recording anything that happened. The dashboard will index this file. */
export function recordEvent(taskDir, type, data = {}) {
  const state = readState(taskDir)
  const line = {
    v: EVENT_VERSION,
    t: new Date().toISOString(),
    project: state.projectId,
    task: state.id,
    type,
    data,
  }
  appendFileSync(join(taskDir, 'events.jsonl'), `${JSON.stringify(line)}\n`)
  return line
}

export function readEvents(taskDir) {
  const path = join(taskDir, 'events.jsonl')
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

export function createState({ taskDir, slug, projectId, projectRoot, repos, orchestratorPane, worktrees = [], env = {} }) {
  const now = new Date().toISOString()
  const state = {
    v: STATE_VERSION,
    id: basename(taskDir),
    slug,
    projectId,
    projectRoot,
    taskDir,
    createdAt: now,
    updatedAt: now,
    phase: 'intake',
    approved: false,
    tests: true,
    qa: true,
    scope: [],
    steps: null,
    verify: null,
    baselinePassed: null,
    treeSnapshot: null,
    round: 1,
    orchestratorPane,
    repos,
    worktrees,
    env,
    database: null,
    herdr: { tab: null, panes: {} },
    agents: {},
    servers: {},
    seq: 0,
  }
  mkdirSync(taskDir, { recursive: true })
  writeJsonAtomic(statePath(taskDir), state)
  return state
}

export function listTasks(root) {
  const dir = tasksDir(root)
  if (!existsSync(dir)) return []
  const tasks = []
  for (const name of readdirSync(dir).sort()) {
    const taskDir = join(dir, name)
    if (existsSync(statePath(taskDir))) tasks.push(readState(taskDir))
  }
  return tasks
}

/** A worker's task comes from its environment, an orchestrator's from its herdr pane. */
export function resolveTask(root, { slug, env = process.env } = {}) {
  if (slug) {
    const matches = listTasks(root).filter(task => task.slug === slug || task.id === slug)
    if (matches.length > 1) throw new Error(`"${slug}" matches several tasks: ${matches.map(task => task.id).join(', ')}`)
    return matches[0] ?? null
  }
  if (env.ENKI_TASK && existsSync(statePath(env.ENKI_TASK))) return readState(env.ENKI_TASK)
  if (!root || !env.HERDR_PANE_ID) return null
  const bound = listTasks(root).filter(task => task.orchestratorPane === env.HERDR_PANE_ID && task.phase !== 'done')
  return bound[bound.length - 1] ?? null
}

export function registerProject({ id, root }) {
  const home = enkiHome()
  mkdirSync(home, { recursive: true })
  const path = join(home, 'projects.json')
  withLock(path, () => {
    const projects = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {}
    projects[id] = { root, lastUsedAt: new Date().toISOString() }
    writeJsonAtomic(path, projects)
  })
}
