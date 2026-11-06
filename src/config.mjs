// Project discovery and config loading. Everything project-specific lives in .enki/config.json.
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export const ROLES = ['scout', 'coder', 'tester', 'qa', 'reviewer']
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk']
export const BROWSER_DRIVERS = ['chrome', 'none']

export const DEFAULTS = {
  version: 1,
  mode: 'auto',
  permissionMode: 'auto',
  browser: { driver: 'chrome' },
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
}

const DEFAULT_TEST_GLOBS = [
  'test/**', 'tests/**', 'spec/**', 'src/test/**', '**/__tests__/**',
  '**/*.test.*', '**/*.spec.*', '**/test_*.py', '**/*_test.py', '**/*_test.go', '**/*_spec.rb', '**/*Test.java', '**/*Tests.cs',
]

const TOP_KEYS = new Set(['$schema', 'id', ...Object.keys(DEFAULTS)])
const REPO_KEYS = new Set(['name', 'path', 'test', 'lint', 'url', 'testGlobs', 'devServer', 'gate'])
const DEV_SERVER_KEYS = new Set(['managedBy', 'start', 'stop', 'reload', 'restartFor'])
const GATE_KEYS = new Set(['commands', 'fast', 'suppressions'])
const POLICY_KEYS = new Set(['secrets', 'protected', 'bash'])
const TEAM_KEYS = new Set(['model', 'effort', 'skills'])
const SKILL_NAME = /^[A-Za-z0-9][\w.-]*(:[A-Za-z0-9][\w.-]*)?$/

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
  if (raw.browser?.driver !== undefined && !BROWSER_DRIVERS.includes(raw.browser.driver)) {
    problems.push(`browser.driver: must be one of ${BROWSER_DRIVERS.join(', ')}`)
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
    gate: repo.gate ?? null,
  }
}

/** Reads, validates and fills defaults. Throws ConfigError on a bad file. */
export function loadConfig(root) {
  let raw
  try {
    raw = JSON.parse(readFileSync(configPath(root), 'utf8'))
  } catch (error) {
    throw new ConfigError([error.message])
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
  }
}
