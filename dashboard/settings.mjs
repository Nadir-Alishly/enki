// The settings page's read and write path: the only thing the dashboard changes in a project.
// It edits only the fields the page shows, leaves every other key as it was, and refuses a
// save when the file changed since the page read it.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPath, DATABASE_MODES, DEFAULTS, EFFORTS, isBranchName, ROLES, SKILL_NAME, validateConfig } from '../src/config.mjs'
import { listWorkflows } from '../src/library.mjs'
import { loadProjectConfig } from '../src/memory.mjs'
import { builtinRoles, loadRoles } from '../src/agents.mjs'
import { availableSkills } from '../src/skills.mjs'
import { writeJsonAtomic } from '../src/state.mjs'
import { git } from '../src/worktrees.mjs'
import { modelCatalog } from './models.mjs'

export class SettingsError extends Error {
  constructor(status, message, problems = []) {
    super(message)
    this.status = status
    this.problems = problems
  }
}

const MINUTE = 60000

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLACEHOLDER = /\{(task|port(:[\w./-]+)?)\}/

export const hashText = text => createHash('sha256').update(text).digest('hex')

function readRaw(root) {
  const text = readFileSync(configPath(root), 'utf8')
  return { text, hash: hashText(text), raw: JSON.parse(text) }
}

/** Each registered project's config fingerprint, for the live stream. */
export function configHashes(projects) {
  const hashes = {}
  for (const project of projects) {
    try {
      hashes[project.id] = hashText(readFileSync(configPath(project.root), 'utf8'))
    } catch {
      hashes[project.id] = null
    }
  }
  return hashes
}

const minutes = ms => Math.round((ms / MINUTE) * 100) / 100

/** The editable values as the page shows them, from the raw file with defaults filled in. */
/** Enki's own roles first, in their usual order, then the library's and the project's. */
const roleOrder = roles => [...ROLES.filter(id => roles.has(id)), ...[...roles.keys()].filter(id => !ROLES.includes(id))]

export function editableValues(raw, roles = builtinRoles()) {
  const database = raw.database ?? null
  return {
    workflow: raw.workflow ?? DEFAULTS.workflow,
    mode: raw.mode ?? DEFAULTS.mode,
    worktrees: raw.worktrees ?? DEFAULTS.worktrees,
    baseBranch: raw.baseBranch ?? DEFAULTS.baseBranch,
    timeouts: Object.fromEntries(Object.keys(DEFAULTS.timeouts).map(key => [key, minutes(raw.timeouts?.[key] ?? DEFAULTS.timeouts[key])])),
    browser: { driver: raw.browser?.driver ?? DEFAULTS.browser.driver, headless: raw.browser?.headless ?? DEFAULTS.browser.headless },
    ports: { from: raw.ports?.from ?? DEFAULTS.ports.from, to: raw.ports?.to ?? DEFAULTS.ports.to },
    database: {
      enabled: Boolean(database) && database.enabled !== false,
      default: database?.default ?? 'copy',
      copy: database?.copy ?? '',
      drop: database?.drop ?? '',
      env: Object.entries(database?.env ?? {}),
    },
  }
}

/** What the page shows but never changes. The repo settings may live in each repo's memory. */
function readOnly(project, raw) {
  const memory = raw.memory ?? DEFAULTS.memory
  let repos = []
  let problem = null
  try {
    repos = loadProjectConfig(project.root).repos.map(repo => {
      const dir = join(project.root, repo.path)
      return {
        name: repo.name,
        path: repo.path,
        branch: existsSync(dir) ? git(dir, ['branch', '--show-current'], { allowFail: true }) || null : null,
        // To warn when the working branch is missing from a repo.
        branches: existsSync(dir) ? (git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], { allowFail: true }) ?? '').split('\n').filter(Boolean) : [],
        test: repo.test,
        devServer: repo.devServer.managedBy === 'user' ? 'Started by you' : repo.devServer.start ?? null,
      }
    })
  } catch (error) {
    problem = error.message
  }
  return { memory, permissionMode: raw.permissionMode ?? DEFAULTS.permissionMode, repos, problem }
}

export function readSettings(project) {
  const { hash, raw } = readRaw(project.root)
  let problem = null
  try {
    validateConfig(raw)
  } catch (error) {
    problem = error.problems ?? [error.message]
  }
  const roles = loadRoles(project.root)
  const { workflows } = listWorkflows(project.root)
  return {
    hash,
    values: editableValues(raw, roles),
    readOnly: readOnly(project, raw),
    invalid: problem,
    options: {
      models: modelCatalog(),
      efforts: EFFORTS,
      drivers: ['playwright', 'chrome', 'none'],
      databaseModes: DATABASE_MODES,
      roles: roleOrder(roles).map(id => {
        const role = roles.get(id)
        return { id, name: role.name, color: role.color ?? null, pattern: role.pattern ?? null, source: role.source, skills: role.skills ?? [] }
      }),
      workflows: workflows.map(workflow => ({ id: workflow.id, name: workflow.name, description: workflow.description, source: workflow.source, runnable: workflow.problems.length === 0 })),
    },
  }
}

const skillCache = new Map()

/** Skills the page offers while typing. Asking Claude Code for plugins is slow, so it's cached. */
export function projectSkills(project) {
  const cached = skillCache.get(project.id)
  if (cached && Date.now() - cached.at < 60000) return cached.skills
  let workdirs = [project.root]
  try {
    workdirs = loadProjectConfig(project.root).repos.map(repo => join(project.root, repo.path))
  } catch {
    // An invalid config still has the project's own skills folder.
  }
  const skills = availableSkills({ root: project.root, workdirs }).map(({ name, description }) => ({ name, description }))
  skillCache.set(project.id, { at: Date.now(), skills })
  return skills
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const isNumber = value => typeof value === 'number' && Number.isFinite(value)

/** Sets one field, creating its parents. Existing keys keep their place in the file. */
function put(raw, path, value) {
  const keys = path.split('.')
  let target = raw
  for (const key of keys.slice(0, -1)) {
    if (!isObject(target[key])) target[key] = {}
    target = target[key]
  }
  target[keys.at(-1)] = value
}

/**
 * Applies the page's changes to the raw config. Only these paths can be set, and each is
 * checked for its type here; validateConfig checks the result as a whole.
 */
export function applyChanges(raw, changes, { roles = new Set(ROLES), workflows = null } = {}) {
  if (!isObject(changes)) throw new SettingsError(400, 'Changes must be an object')
  const problems = []
  const next = structuredClone(raw)
  const bad = (path, message) => problems.push({ path, message })
  for (const [path, value] of Object.entries(changes)) {
    const timeout = /^timeouts\.(\w+)$/.exec(path)
    if (path === 'workflow') {
      if (typeof value !== 'string' || (workflows && !workflows.has(value))) bad(path, 'Choose a workflow that can run.')
      else next.workflow = value
    } else if (timeout && timeout[1] in DEFAULTS.timeouts) {
      if (!isNumber(value) || value <= 0) bad(path, 'Enter minutes, more than 0.')
      else put(next, path, Math.round(value * MINUTE))
    } else if (path === 'maxFixRounds') {
      if (!Number.isInteger(value) || value < 0) bad(path, 'Enter a whole number, 0 or more.')
      else next.maxFixRounds = value
    } else if (path === 'mode') {
      if (!['auto', 'explicit'].includes(value)) bad(path, 'Choose auto or explicit.')
      else next.mode = value
    } else if (path === 'baseBranch') {
      if (!isBranchName(value)) bad(path, 'Enter a branch name, like dev.')
      else next.baseBranch = value
    } else if (path === 'worktrees' || path === 'browser.headless') {
      if (typeof value !== 'boolean') bad(path, 'Must be on or off.')
      else put(next, path, value)
    } else if (path === 'browser.driver') {
      if (!['playwright', 'chrome', 'none'].includes(value)) bad(path, 'Choose Playwright, Chrome or None.')
      else put(next, path, value)
    } else if (path === 'ports.from' || path === 'ports.to') {
      if (!Number.isInteger(value) || value < 1024 || value > 65535) bad(path, 'Enter a whole number between 1024 and 65535.')
      else {
        // The file needs both ends of the range, so a missing one gets its default.
        if (!isObject(next.ports)) next.ports = { ...DEFAULTS.ports }
        next.ports[path.split('.')[1]] = value
      }
    } else if (path.startsWith('database.')) {
      // A section created here starts switched off, so it never copies before it has commands.
      if (!isObject(next.database)) next.database = { enabled: false }
      const field = path.slice('database.'.length)
      if (field === 'enabled') {
        if (typeof value !== 'boolean') bad(path, 'Must be on or off.')
        else next.database.enabled = value
      } else if (field === 'default') {
        if (!DATABASE_MODES.includes(value)) bad(path, `Choose one of ${DATABASE_MODES.join(', ')}.`)
        else next.database.default = value
      } else if (field === 'copy' || field === 'drop') {
        if (typeof value !== 'string') bad(path, 'Must be a command.')
        else if (value.trim()) next.database[field] = value.trim()
        else delete next.database[field]
      } else if (field === 'env') {
        if (!Array.isArray(value) || !value.every(pair => Array.isArray(pair) && pair.length === 2 && pair.every(item => typeof item === 'string'))) {
          bad(path, 'Must be a list of names and values.')
          continue
        }
        const seen = new Set()
        value.forEach(([name], index) => {
          const key = name.trim()
          if (!key) bad(`${path}.${index}`, 'Enter a name.')
          else if (!ENV_NAME.test(key)) bad(`${path}.${index}`, 'Use letters, digits and underscores, and don’t start with a digit.')
          else if (seen.has(key)) bad(`${path}.${index}`, `${key} is already used.`)
          seen.add(key)
        })
        next.database.env = Object.fromEntries(value.map(([name, text]) => [name.trim(), text]))
      } else bad(path, 'This setting can’t be changed here.')
    } else bad(path, 'This setting can’t be changed here.')
  }

  // Database commands are checked only when this save touches them, so an older config with
  // other commands still saves its unrelated changes.
  const database = next.database
  const touched = ['database.enabled', 'database.copy', 'database.drop'].some(path => path in changes)
  if (touched && isObject(database) && database.enabled !== false) {
    for (const field of ['copy', 'drop']) {
      const command = database[field] ?? ''
      if (!command) bad(`database.${field}`, `Enter a ${field} command, or turn database copying off.`)
      else if (!PLACEHOLDER.test(command)) bad(`database.${field}`, 'Include {task} or {port}, so each task gets its own database.')
    }
  }
  if (problems.length === 0) {
    try {
      validateConfig(next)
    } catch (error) {
      for (const message of error.problems ?? [error.message]) {
        const split = /^([\w.[\]]+): (.*)$/.exec(message)
        problems.push(split ? { path: split[1], message: split[2] } : { path: null, message })
      }
    }
  }
  if (problems.length > 0) throw new SettingsError(422, 'Some settings need fixing', problems)
  return next
}

/** Saves the page's changes, unless the file changed since the page read it. */
export function saveSettings(project, { base, changes } = {}) {
  const { hash, raw } = readRaw(project.root)
  if (base !== hash) throw new SettingsError(409, 'The settings file changed since this page read it')
  const roles = new Set(loadRoles(project.root).keys())
  const workflows = new Set(listWorkflows(project.root).workflows.filter(workflow => workflow.problems.length === 0).map(workflow => workflow.id))
  const next = applyChanges(raw, changes, { roles, workflows })
  writeJsonAtomic(configPath(project.root), next)
  return readSettings(project)
}
