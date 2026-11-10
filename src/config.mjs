// Project discovery and config loading. Everything project-specific lives in .enki/config.json.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const ROLES = ['scout', 'coder', 'tester', 'qa', 'reviewer']
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']
export const BROWSER_DRIVERS = ['playwright', 'chrome', 'none']
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
export const DATABASE_MODES = ['copy', 'shared', 'none']
/**
 * The dashboard's fallback list, for when Claude Code's own model catalog can't be read.
 * Any other model name still works in config.json.
 */
export const MODELS = [
  { id: 'claude-fable-5-2', label: 'Fable 5.2' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
]

export const DEFAULTS = {
  version: 1,
  mode: 'auto',
  permissionMode: 'auto',
  browser: { driver: 'playwright', headless: true },
  repos: [],
  team: {
    scout: { model: 'claude-haiku-5-5', effort: 'high' },
    coder: { model: 'claude-sonnet-5-5', effort: 'high' },
    tester: { model: 'claude-haiku-5-5', effort: 'high' },
    qa: { model: 'claude-haiku-5-5', effort: 'high' },
    reviewer: { model: 'claude-sonnet-5-5', effort: 'high' },
  },
  timeouts: {
    scout: 900000,
    baseline: 600000,
    coder: 1800000,
    tests: 1800000,
    tester: 1800000,
    qa: 1800000,
    verify: 600000,
    reviewer: 900000,
    server: 120000,
  },
  maxFixRounds: 3,
  policy: { secrets: [], protected: [], bash: [] },
  memory: 'repo',
  worktrees: true,
  ports: { from: 4400, to: 4999 },
  worktree: { copy: ['.env', '.env.*'], link: ['node_modules'], install: null, env: {} },
  database: null,
}

const DEFAULT_TEST_GLOBS = [
  'test/**', 'tests/**', 'spec/**', 'src/test/**', '**/__tests__/**',
  '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/*_spec.rb', '**/*Test.java', '**/*Tests.cs',
]

const TOP_KEYS = new Set(['$schema', 'id', ...Object.keys(DEFAULTS)])
const REPO_KEYS = new Set(['name', 'path', 'test', 'lint', 'url', 'testGlobs', 'devServer', 'gate', 'worktree'])
const WORKTREE_KEYS = new Set(['copy', 'link', 'install', 'env'])
const DATABASE_KEYS = new Set(['copy', 'drop', 'env', 'enabled', 'default'])
const isStringMap = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(item => typeof item === 'string')

function validateWorktree(value, label, problems) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    problems.push(`${label}: must be an object`)
    return
  }
  checkUnknown(value, WORKTREE_KEYS, label, problems)
  for (const key of ['copy', 'link']) {
    if (value[key] !== undefined && !isStringArray(value[key])) problems.push(`${label}.${key}: must be an array of paths`)
    else if (value[key]?.some(path => path.startsWith('/') || path.split('/').includes('..'))) problems.push(`${label}.${key}: paths must be inside the repo`)
  }
  if (value.install !== undefined && value.install !== null && typeof value.install !== 'string') problems.push(`${label}.install: must be a command`)
  if (value.env !== undefined && !isStringMap(value.env)) problems.push(`${label}.env: must map names to strings`)
}
const DEV_SERVER_KEYS = new Set(['managedBy', 'start', 'stop', 'reload', 'restartFor'])
const GATE_KEYS = new Set(['commands', 'fast', 'suppressions'])
const POLICY_KEYS = new Set(['secrets', 'protected', 'bash'])
const TEAM_KEYS = new Set(['model', 'effort', 'skills'])
const BROWSER_KEYS = new Set(['driver', 'headless', 'executable'])
export const SKILL_NAME = /^[A-Za-z0-9][\w.-]*(:[A-Za-z0-9][\w.-]*)?$/

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid .enki/config.json:\n${problems.map(p => `  - ${p}`).join('\n')}`)
    this.problems = problems
  }
}

export const configPath = root => join(root, '.enki', 'config.json')

/** Walks up from `start` to the nearest directory holding .enki/config.json. */
export function findProjectRoot(start = process.cwd()) {
  let dir = resolve(start)
  for (;;) {
    if (existsSync(join(dir, '.enki', 'config.json'))) return realpathOr(dir)
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function realpathOr(path) {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string')

function checkUnknown(obj, allowed, label, problems) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) problems.push(`${label}: unknown key "${key}"`)
  }
}

function validateRepo(repo, index, problems, names) {
  const label = `repos[${index}]`
  if (repo === null || typeof repo !== 'object' || Array.isArray(repo)) {
    problems.push(`${label}: must be an object`)
    return
  }
  checkUnknown(repo, REPO_KEYS, label, problems)
  if (typeof repo.path !== 'string' || repo.path === '') problems.push(`${label}.path: required string`)
  else if (repo.path.startsWith('/') || repo.path.split('/').includes('..')) {
    problems.push(`${label}.path: must be relative to the project root, without ".."`)
  }
  const name = repo.name ?? repo.path
  if (names.has(name)) problems.push(`${label}: duplicate repo name "${name}"`)
  names.add(name)
  for (const key of ['test', 'lint', 'testGlobs']) {
    if (repo[key] !== undefined && !isStringArray(repo[key])) problems.push(`${label}.${key}: must be an array of strings`)
  }
  if (repo.url !== undefined && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(String(repo.url))) {
    problems.push(`${label}.url: must be a localhost URL`)
  }
  if (repo.devServer !== undefined) {
    if (typeof repo.devServer !== 'object' || repo.devServer === null) problems.push(`${label}.devServer: must be an object`)
    else {
      checkUnknown(repo.devServer, DEV_SERVER_KEYS, `${label}.devServer`, problems)
      if (!['enki', 'user'].includes(repo.devServer.managedBy ?? 'enki')) problems.push(`${label}.devServer.managedBy: must be "enki" or "user"`)
      for (const key of ['start', 'stop']) {
        if (repo.devServer[key] !== undefined && typeof repo.devServer[key] !== 'string') problems.push(`${label}.devServer.${key}: must be a string`)
      }
      if (repo.devServer.restartFor !== undefined && !isStringArray(repo.devServer.restartFor)) {
        problems.push(`${label}.devServer.restartFor: must be an array of strings`)
      }
    }
  }
  if (repo.worktree !== undefined) validateWorktree(repo.worktree, `${label}.worktree`, problems)
  if (repo.gate !== undefined) {
    if (typeof repo.gate !== 'object' || repo.gate === null) problems.push(`${label}.gate: must be an object`)
    else {
      checkUnknown(repo.gate, GATE_KEYS, `${label}.gate`, problems)
      if (!isStringArray(repo.gate.commands ?? [])) problems.push(`${label}.gate.commands: must be an array of strings`)
    }
  }
}

function validateBashRule(rule, index, problems) {
  const label = `policy.bash[${index}]`
  if (typeof rule?.pattern !== 'string' || typeof rule?.reason !== 'string') {
    problems.push(`${label}: needs string "pattern" and "reason"`)
    return
  }
  try {
    new RegExp(rule.pattern)
  } catch (error) {
    problems.push(`${label}.pattern: ${error.message}`)
  }
}

export function validateConfig(raw) {
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError(['must be a JSON object'])
  checkUnknown(raw, TOP_KEYS, 'config', problems)
  if (raw.mode !== undefined && !['auto', 'explicit'].includes(raw.mode)) problems.push('mode: must be "auto" or "explicit"')
  if (raw.permissionMode !== undefined && !PERMISSION_MODES.includes(raw.permissionMode)) {
    problems.push(`permissionMode: must be one of ${PERMISSION_MODES.join(', ')}`)
  }
  if (raw.browser !== undefined) {
    checkUnknown(raw.browser, BROWSER_KEYS, 'browser', problems)
    if (raw.browser.driver !== undefined && !BROWSER_DRIVERS.includes(raw.browser.driver)) {
      problems.push(`browser.driver: must be one of ${BROWSER_DRIVERS.join(', ')}`)
    }
    if (raw.browser.headless !== undefined && typeof raw.browser.headless !== 'boolean') problems.push('browser.headless: must be true or false')
    if (raw.browser.executable !== undefined && (typeof raw.browser.executable !== 'string' || !raw.browser.executable.startsWith('/'))) {
      problems.push('browser.executable: must be an absolute path')
    }
  }
  if (raw.maxFixRounds !== undefined && (!Number.isInteger(raw.maxFixRounds) || raw.maxFixRounds < 0)) {
    problems.push('maxFixRounds: must be a non-negative integer')
  }
  if (raw.repos !== undefined && !Array.isArray(raw.repos)) problems.push('repos: must be an array')
  const names = new Set()
  if (Array.isArray(raw.repos)) raw.repos.forEach((repo, index) => validateRepo(repo, index, problems, names))
  for (const [role, settings] of Object.entries(raw.team ?? {})) {
    if (!ROLES.includes(role)) {
      problems.push(`team: unknown role "${role}"`)
      continue
    }
    checkUnknown(settings, TEAM_KEYS, `team.${role}`, problems)
    if (settings.model !== undefined && (typeof settings.model !== 'string' || settings.model.trim() === '')) problems.push(`team.${role}.model: must be a model name`)
    if (settings.effort !== undefined && !EFFORTS.includes(settings.effort)) problems.push(`team.${role}.effort: must be one of ${EFFORTS.join(', ')}`)
    if (settings.skills !== undefined && !(isStringArray(settings.skills) && settings.skills.every(name => SKILL_NAME.test(name)))) {
      problems.push(`team.${role}.skills: must be an array of skill names, like "frontend-design" or "design:ux-copy"`)
    }
  }
  for (const [key, value] of Object.entries(raw.timeouts ?? {})) {
    if (!(key in DEFAULTS.timeouts)) problems.push(`timeouts: unknown step "${key}"`)
    else if (!Number.isInteger(value) || value <= 0) problems.push(`timeouts.${key}: must be a positive integer of milliseconds`)
  }
  if (raw.policy !== undefined) {
    checkUnknown(raw.policy, POLICY_KEYS, 'policy', problems)
    for (const key of ['secrets', 'protected']) {
      if (raw.policy[key] !== undefined && !isStringArray(raw.policy[key])) problems.push(`policy.${key}: must be an array of strings`)
    }
    if (raw.policy.bash !== undefined) {
      if (!Array.isArray(raw.policy.bash)) problems.push('policy.bash: must be an array')
      else raw.policy.bash.forEach((rule, index) => validateBashRule(rule, index, problems))
    }
  }
  if (raw.memory !== undefined && !['repo', 'private'].includes(raw.memory)) problems.push('memory: must be "repo" or "private"')
  if (raw.memory === 'private' && raw.worktrees === false) problems.push('memory: "private" needs worktrees, because memory follows the task branch enki commits')
  if (raw.worktrees !== undefined && typeof raw.worktrees !== 'boolean') problems.push('worktrees: must be true or false')
  if (raw.worktree !== undefined) validateWorktree(raw.worktree, 'worktree', problems)
  if (raw.ports !== undefined) {
    const { from, to } = raw.ports
    const valid = port => Number.isInteger(port) && port >= 1024 && port <= 65535
    if (!valid(from) || !valid(to) || from > to) problems.push('ports: needs "from" and "to", between 1024 and 65535, with from <= to')
  }
  if (raw.database !== undefined && raw.database !== null) {
    if (typeof raw.database !== 'object' || Array.isArray(raw.database)) problems.push('database: must be an object')
    else {
      checkUnknown(raw.database, DATABASE_KEYS, 'database', problems)
      for (const key of ['copy', 'drop']) {
        if (raw.database[key] !== undefined && typeof raw.database[key] !== 'string') problems.push(`database.${key}: must be a command`)
      }
      if (raw.database.env !== undefined && !isStringMap(raw.database.env)) problems.push('database.env: must map names to strings')
      if (raw.database.enabled !== undefined && typeof raw.database.enabled !== 'boolean') problems.push('database.enabled: must be true or false')
      if (raw.database.default !== undefined && !DATABASE_MODES.includes(raw.database.default)) problems.push(`database.default: must be one of ${DATABASE_MODES.join(', ')}`)
    }
  }
  if (problems.length > 0) throw new ConfigError(problems)
}

function normalizeRepo(repo) {
  return {
    name: repo.name ?? repo.path,
    path: repo.path,
    test: repo.test ?? [],
    lint: repo.lint ?? [],
    url: repo.url ?? null,
    testGlobs: repo.testGlobs ?? DEFAULT_TEST_GLOBS,
    devServer: { managedBy: 'enki', ...repo.devServer },
    worktree: repo.worktree ?? {},
    gate: repo.gate ?? null,
  }
}

/**
 * Reads, validates and fills defaults. Throws ConfigError on a bad file.
 * `repoJson(repo)` returns a repo's own settings from its memory (repo.json), which win over
 * the same fields in config.json. The same validation applies wherever a field lives.
 */
export function loadConfig(root, { repoJson } = {}) {
  let raw
  try {
    raw = JSON.parse(readFileSync(configPath(root), 'utf8'))
  } catch (error) {
    throw new ConfigError([error.message])
  }
  const warnings = []
  if (repoJson && Array.isArray(raw.repos)) {
    const problems = []
    raw.repos = raw.repos.map((repo, index) => {
      let own
      try {
        own = repoJson(repo)
      } catch (error) {
        problems.push(error.message)
        return repo
      }
      if (!own) return repo
      const name = repo.name ?? repo.path
      if (typeof own !== 'object' || Array.isArray(own)) {
        problems.push(`${name}: repo.json must be an object`)
        return repo
      }
      for (const key of ['path', 'name']) if (key in own) problems.push(`${name}: repo.json can't set "${key}", which belongs in .enki/config.json`)
      for (const key of Object.keys(own)) if (key in repo && !['path', 'name'].includes(key)) warnings.push(`repos[${index}].${key} is set in both config.json and ${name}'s repo.json. The repo's value is used.`)
      return { ...repo, ...own, path: repo.path, ...(repo.name ? { name: repo.name } : {}) }
    })
    if (problems.length > 0) throw new ConfigError(problems)
  }
  validateConfig(raw)
  const team = {}
  for (const role of ROLES) team[role] = { skills: [], ...DEFAULTS.team[role], ...raw.team?.[role] }
  return {
    ...DEFAULTS,
    ...raw,
    browser: { ...DEFAULTS.browser, ...raw.browser },
    repos: (raw.repos ?? []).map(normalizeRepo),
    team,
    timeouts: { ...DEFAULTS.timeouts, ...raw.timeouts },
    policy: { ...DEFAULTS.policy, ...raw.policy },
    ports: { ...DEFAULTS.ports, ...raw.ports },
    worktree: { ...DEFAULTS.worktree, ...raw.worktree, env: { ...raw.worktree?.env } },
    warnings,
  }
}
