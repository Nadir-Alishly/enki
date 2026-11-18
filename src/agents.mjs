// Agents: what a workflow step runs. Each is a folder holding agent.json (what enki enforces:
// type, capabilities, declared outcomes, and the defaults: model, effort, timeout, skills) and
// AGENT.md (its instructions). They come from enki's own and the user's library, never a project:
// a project tunes an agent on its workflow's steps. Folders from before the rename (role.json and
// SKILL.md, ~/.enki/library/roles) still load. Internally the code still says "role" in places.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EFFORTS, SKILL_NAME } from './config.mjs'
import { pluginRoot } from './paths.mjs'
import { parseSkill } from './skills.mjs'
import { enkiHome } from './state.mjs'

/** What a role may write: only its own reports, test files only, code but not tests, or both. */
export const WRITE_LEVELS = ['none', 'tests', 'code', 'all']
/** Outcomes enki raises itself. A role can't declare or report them. */
export const ENGINE_OUTCOMES = ['timeout', 'error']
/** Step ids a workflow can't give a role: targets and built-in steps. */
export const RESERVED_IDS = new Set(['orchestrator', 'start', 'approval', 'end', 'verify', 'otherwise', 'user', 'request', 'plan'])

export const ROLE_ID = /^[a-z][a-z0-9-]{0,30}$/
const OUTCOME_ID = /^[a-z][a-z0-9-]{0,30}$/
// color and pattern came from before types: still read, never used.
const ROLE_KEYS = new Set(['id', 'name', 'type', 'color', 'pattern', 'capabilities', 'outcomes', 'model', 'effort', 'timeout', 'skills'])
const CAPABILITY_KEYS = new Set(['write', 'blind', 'browser', 'server', 'plans'])
const FLAGS = ['blind', 'browser', 'server', 'plans']

/** What kind of agent it is. The type decides how it looks, and the project's charts count by it. */
export const AGENT_TYPES = {
  scout: { name: 'Scout', color: '#9d9dff', pattern: 'stripes' },
  planner: { name: 'Planner', color: '#9d9dff', pattern: null },
  coder: { name: 'Coder', color: '#ffcd04', pattern: null },
  tester: { name: 'Tester', color: '#85af25', pattern: null },
  qa: { name: 'QA', color: '#85af25', pattern: 'stripes' },
  reviewer: { name: 'Reviewer', color: '#f0f4f7', pattern: null },
}

/**
 * An agent's type, or a task's team entry's: its own, else enki's agent of that id, else a guess
 * from what it does, for agents made before types.
 */
export function typeOf(raw) {
  if (AGENT_TYPES[raw?.type]) return raw.type
  const id = raw?.id ?? raw?.role
  if (AGENT_TYPES[id]) return id
  const caps = raw?.capabilities ?? {}
  if (caps.plans) return 'planner'
  if (['code', 'all'].includes(caps.write)) return 'coder'
  if (caps.write === 'tests') return 'tester'
  if (caps.browser) return 'qa'
  return raw?.pattern === 'stripes' ? 'scout' : 'reviewer'
}

export const builtinRolesDir = join(pluginRoot, 'agents')
/** An agent's two files, and the names they had before agents were called agents. */
const META = ['agent.json', 'role.json']
const INSTRUCTIONS = ['AGENT.md', 'SKILL.md']
const firstIn = (dir, names) => names.map(name => join(dir, name)).find(path => existsSync(path)) ?? join(dir, names[0])
export const libraryDir = () => join(enkiHome(), 'library')

export class RoleError extends Error {
  constructor(problems, where = 'role') {
    super(`Invalid ${where}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.problems = problems
  }
}

/** Everything wrong with a role.json, as sentences. Empty when it's fine. */
export function roleProblems(raw) {
  const problems = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['must be a JSON object']
  for (const key of Object.keys(raw)) if (!ROLE_KEYS.has(key)) problems.push(`unknown key "${key}"`)
  if (typeof raw.id !== 'string' || !ROLE_ID.test(raw.id)) problems.push('id: lowercase letters, digits and dashes, starting with a letter')
  else if (RESERVED_IDS.has(raw.id)) problems.push(`id: "${raw.id}" is reserved`)
  if (typeof raw.name !== 'string' || !raw.name.trim()) problems.push('name: required')
  if (raw.type !== undefined && !AGENT_TYPES[raw.type]) problems.push(`type: one of ${Object.keys(AGENT_TYPES).join(', ')}`)
  const caps = raw.capabilities
  if (caps === null || typeof caps !== 'object' || Array.isArray(caps)) problems.push('capabilities: required, an object')
  else {
    for (const key of Object.keys(caps)) if (!CAPABILITY_KEYS.has(key)) problems.push(`capabilities: unknown key "${key}"`)
    if (!WRITE_LEVELS.includes(caps.write)) problems.push(`capabilities.write: one of ${WRITE_LEVELS.join(', ')}`)
    for (const key of FLAGS) {
      if (caps[key] !== undefined && typeof caps[key] !== 'boolean') problems.push(`capabilities.${key}: true or false`)
    }
    if (caps.plans === true && caps.write !== 'none') problems.push('capabilities.plans: a role that plans writes nothing but its plan (write: "none")')
  }
  if (!Array.isArray(raw.outcomes) || raw.outcomes.length === 0) problems.push('outcomes: at least one')
  else {
    const seen = new Set()
    raw.outcomes.forEach((outcome, index) => {
      const id = outcome?.id
      if (typeof id !== 'string' || !OUTCOME_ID.test(id)) problems.push(`outcomes[${index}].id: lowercase letters, digits and dashes`)
      else if (ENGINE_OUTCOMES.includes(id) || id === 'otherwise') problems.push(`outcomes[${index}].id: "${id}" is enki's own`)
      else if (seen.has(id)) problems.push(`outcomes: "${id}" is declared twice`)
      seen.add(id)
      if (outcome?.description !== undefined && typeof outcome.description !== 'string') problems.push(`outcomes[${index}].description: text`)
    })
  }
  if (raw.model !== undefined && !(typeof raw.model === 'string' && raw.model.trim())) problems.push('model: a model name')
  if (raw.effort !== undefined && !EFFORTS.includes(raw.effort)) problems.push(`effort: one of ${EFFORTS.join(', ')}`)
  if (raw.timeout !== undefined && !(Number.isInteger(raw.timeout) && raw.timeout > 0)) problems.push('timeout: milliseconds, more than 0')
  if (raw.skills !== undefined && !(Array.isArray(raw.skills) && raw.skills.every(name => typeof name === 'string' && SKILL_NAME.test(name)))) problems.push('skills: a list of skill names, like "design:ux-copy"')
  return problems
}

/**
 * What an agent's capabilities allow but probably shouldn't: worth a warning, not a refusal.
 */
export function agentWarnings(raw) {
  const caps = raw?.capabilities ?? {}
  const warnings = []
  if (caps.browser && !caps.server) warnings.push('it has a browser but can\'t start the dev server: it can only test while someone else runs it')
  if (caps.server && !caps.browser) warnings.push('it starts the dev server but has no browser to look at it')
  if (caps.blind && ['code', 'all'].includes(caps.write)) warnings.push('it is blind but writes code: it can\'t see the code it changes')
  if (caps.blind && caps.plans) warnings.push('it is blind but plans: it can\'t see the code it plans for')
  if ((raw?.outcomes ?? []).some(outcome => !outcome?.description)) warnings.push('an outcome has no description: the agent is told only its name')
  return warnings
}

/** An agent folder, read and checked. Throws RoleError naming the folder. */
export function readRole(dir, source) {
  const metaPath = firstIn(dir, META)
  const skillPath = firstIn(dir, INSTRUCTIONS)
  let raw
  try {
    raw = JSON.parse(readFileSync(metaPath, 'utf8'))
  } catch (error) {
    throw new RoleError([error.message], `agent in ${dir}`)
  }
  const problems = roleProblems(raw)
  if (!existsSync(skillPath)) problems.push('AGENT.md: missing')
  if (problems.length > 0) throw new RoleError(problems, `agent in ${dir}`)
  const skill = parseSkill(readFileSync(skillPath, 'utf8'))
  const type = typeOf(raw)
  return {
    ...raw,
    type,
    color: AGENT_TYPES[type].color,
    pattern: AGENT_TYPES[type].pattern,
    capabilities: { blind: false, browser: false, server: false, plans: false, ...raw.capabilities },
    description: skill.description,
    dir,
    skillPath,
    source,
  }
}

/** The role folders under a directory, as `{ id, dir }`. */
function roleFolders(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && META.some(name => existsSync(join(dir, entry.name, name))))
    .map(entry => ({ id: entry.name, dir: join(dir, entry.name) }))
}

/** The library's agents folder. */
export const agentsDir = () => join(libraryDir(), 'agents')

/**
 * Where agents come from: enki's own, then the library (its folder from before the rename first,
 * so an agent saved since wins). Agents are never a project's own.
 */
export function roleSources() {
  return [
    { source: 'builtin', dir: builtinRolesDir },
    { source: 'library', dir: join(libraryDir(), 'roles') },
    { source: 'library', dir: agentsDir() },
  ]
}

/** A project folder of agents from before agents moved to the library only. */
export const projectAgentsDir = root => (root ? join(root, '.enki', 'roles') : null)

/** Every agent there is, by id. A broken one is reported, not loaded, and enki's own can't be replaced. */
export function loadRoles(root, { problems = [] } = {}) {
  const roles = new Map()
  for (const { source, dir } of roleSources()) {
    for (const folder of roleFolders(dir)) {
      try {
        const role = readRole(folder.dir, source)
        if (role.id !== folder.id) throw new RoleError([`id "${role.id}" doesn't match its folder "${folder.id}"`], `agent in ${folder.dir}`)
        if (source !== 'builtin' && roles.get(role.id)?.source === 'builtin') {
          throw new RoleError([`"${role.id}" is one of enki's own agents, which can't be replaced: copy it under a new id`], `agent in ${folder.dir}`)
        }
        roles.set(role.id, role)
      } catch (error) {
        if (!(error instanceof RoleError)) throw error
        problems.push(error.message)
      }
    }
  }
  return roles
}

let builtins = null

/** Enki's own roles, read once. */
export function builtinRoles() {
  if (!builtins) builtins = new Map(roleFolders(builtinRolesDir).map(folder => [folder.id, readRole(folder.dir, 'builtin')]))
  return builtins
}

/** A role's instructions, without the skill front matter. */
export const roleInstructions = role => parseSkill(readFileSync(role.skillPath, 'utf8')).body.trim()

/** The five roles of tasks from before roles were data. */
export const LEGACY_TEAM = ['scout', 'coder', 'tester', 'qa', 'reviewer']

/**
 * Whether a task records its own team. Older tasks have none, or the plan's old team size in its
 * place ("full", "light"): a word, not a team.
 */
export const hasTeam = state => Boolean(state?.team) && typeof state.team === 'object' && !Array.isArray(state.team) && Object.keys(state.team).length > 0

/** A task's team. Tasks from before roles were data have none recorded: enki's own five, the scout as intake. */
export function teamOf(state) {
  if (hasTeam(state)) return state.team
  return Object.fromEntries(LEGACY_TEAM.map(id => [id, teamEntry(builtinRoles().get(id), { intake: id === 'scout' })]))
}

/** What a task's step may do, or null for a step the task doesn't have. */
export const stepCapabilities = (state, step) => teamOf(state)[step]?.capabilities ?? null

/** The part of a role a task keeps for each step, so editing the library mid-task changes nothing. */
export function teamEntry(role, { intake = false, node = null } = {}) {
  return {
    role: role.id,
    name: role.name,
    type: typeOf(role),
    color: role.color ?? null,
    pattern: role.pattern ?? null,
    // Only tasks from before workflows had intake steps: now the graph says what runs before approval.
    ...(intake ? { intake } : {}),
    capabilities: role.capabilities,
    outcomes: role.outcomes.map(outcome => ({ id: outcome.id, description: outcome.description ?? '' })),
    model: role.model ?? null,
    effort: role.effort ?? null,
    // The workflow's own choices for this step: its model and effort win, its skills add to the agent's.
    ...(node?.model ? { stepModel: node.model } : {}),
    ...(node?.effort ? { stepEffort: node.effort } : {}),
    ...(node?.skills?.length ? { stepSkills: node.skills } : {}),
    timeout: role.timeout ?? null,
    skills: role.skills ?? [],
    skillPath: role.skillPath,
  }
}

/**
 * Copies each step's instructions into the task folder and points the team at the copies, so a
 * plugin update or a library edit never changes what a running task's agents are told.
 */
export function snapshotTeam(taskDir, team) {
  const dir = join(taskDir, 'team')
  mkdirSync(dir, { recursive: true })
  return Object.fromEntries(
    Object.entries(team).map(([step, entry]) => {
      const copy = join(dir, `${step}.md`)
      copyFileSync(entry.skillPath, copy)
      return [step, { ...entry, skillPath: copy }]
    }),
  )
}
