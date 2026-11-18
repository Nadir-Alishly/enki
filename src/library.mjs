// The library: workflows and the agents they use, listed, copied, chosen, edited, exported and
// imported. Agents live in the user's library only (never a project's), enki's own are read-only,
// and nothing in the library can take an enki agent's id. A workflow travels with the agents it uses
// that aren't enki's own; an agent can also travel alone. An import grants permissions (what each
// agent may write), so it needs the user's approval.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configPath } from './config.mjs'
import { agentsDir, agentWarnings, libraryDir, loadRoles, roleProblems, typeOf } from './agents.mjs'
import { pluginRoot } from './paths.mjs'
import { availableSkills } from './skills.mjs'
import { writeJsonAtomic } from './state.mjs'
import { capabilityWords, loadWorkflows, phasesOf, targetsOf, upgradeWorkflow, waitsFor, workflowProblems, workflowWarnings } from './workflow.mjs'

export const EXPORT_FORMAT = 'enki-workflow'
export const EXPORT_VERSION = 2
export const AGENT_FORMAT = 'enki-agent'
export const AGENT_VERSION = 1
const ID = /^[a-z][a-z0-9-]{0,30}$/

export class LibraryError extends Error {}

const strip = ({ source, path, ...workflow }) => workflow

/** Where `--to` puts a workflow: the machine's library, or the project's own folder. Agents always go to the library. */
function destination(root, to = 'library') {
  if (to === 'library') return libraryDir()
  if (to === 'project') {
    if (!root) throw new LibraryError('--to project needs an enki project: run this inside one.')
    return join(root, '.enki')
  }
  throw new LibraryError('--to is "library" or "project".')
}

// ---------- workflows ----------

/** Every workflow the project can use, with where it comes from and whether it can run. */
export function listWorkflows(root) {
  const problems = []
  const roles = loadRoles(root, { problems })
  const workflows = loadWorkflows(root, { problems })
  return {
    workflows: [...workflows.values()].map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      description: workflow.description ?? '',
      source: workflow.source,
      problems: workflowProblems(strip(workflow), roles),
      warnings: workflowWarnings(strip(workflow), roles),
    })),
    roles: [...roles.values()].map(role => ({ id: role.id, name: role.name, source: role.source, capabilities: role.capabilities, outcomes: role.outcomes.map(outcome => outcome.id) })),
    problems,
  }
}

export function listText(root, current) {
  const { workflows, problems } = listWorkflows(root)
  const lines = ['Workflows:']
  for (const workflow of workflows) {
    const mark = workflow.id === current ? '*' : ' '
    lines.push(`${mark} ${workflow.id.padEnd(16)} ${workflow.name} (${workflow.source})${workflow.problems.length ? `: can't run, ${workflow.problems.length} problem(s), see enki workflow show ${workflow.id}` : ''}`)
  }
  if (problems.length > 0) lines.push('', 'Not loaded:', ...problems.map(problem => `  ${problem.split('\n').join('\n  ')}`))
  if (current) lines.push('', `* the project's workflow`)
  lines.push('', 'The agents they use: enki agent list')
  return lines.join('\n')
}

/** One workflow in words: its steps, what each outcome does, and anything wrong with it. */
export function showText(root, id) {
  const problems = []
  const roles = loadRoles(root, { problems })
  const workflow = loadWorkflows(root, { problems }).get(id)
  if (!workflow) throw new LibraryError(`No workflow "${id}". See: enki workflow list`)
  // The description is for people choosing in the dashboard. What enki runs is the graph, below.
  const lines = [`${workflow.name} (${workflow.id}, ${workflow.source})`]
  const { before, after } = phasesOf(workflow)
  lines.push('', `Before the plan: ${[...before].join(', ') || 'nothing'}`, `After approval: ${[...after].join(', ') || 'nothing'}`, '', 'Steps:')
  for (const node of workflow.nodes) {
    if (node.kind === 'end') continue
    const role = node.kind ? null : roles.get(node.agent)
    const builtin = { start: 'the orchestrator passes on the request', approval: 'the user approves the plan', verify: 'enki runs the checks' }
    const what = node.kind ? `built-in: ${builtin[node.kind] ?? node.kind}` : `${role?.name ?? node.agent}${role ? `: ${capabilityWords(role.capabilities)}` : ' (no such agent)'}`
    const waits = node.kind && node.kind !== 'verify' ? [] : waitsFor(workflow, node.id)
    lines.push(`  ${node.id}: ${what}${waits.length ? `. Waits for ${waits.join(', ')}` : ''}`)
    for (const edge of workflow.edges.filter(item => item.from === node.id)) {
      lines.push(`    ${edge.on} → ${targetsOf(edge).join(' and ')}${edge.max ? ` (at most ${edge.max} times)` : ''}`)
    }
    const unwired = node.kind ? [] : (role?.outcomes ?? []).map(outcome => outcome.id).filter(outcome => !workflow.edges.some(edge => edge.from === node.id && (edge.on === outcome || edge.on === 'otherwise')))
    if (unwired.length > 0) lines.push(`    ${unwired.join(', ')} → back to the orchestrator`)
  }
  const own = workflowProblems(strip(workflow), roles)
  lines.push('', own.length ? `Can't run:\n${own.map(problem => `  - ${problem}`).join('\n')}` : 'Sound: it can run.')
  const warnings = workflowWarnings(strip(workflow), roles).filter(warning => !warning.startsWith('the description'))
  if (warnings.length) lines.push(...warnings.map(warning => `Note: ${warning}`))
  return lines.join('\n')
}

/** The project's default workflow. */
export function useWorkflow(root, id) {
  const { workflows } = listWorkflows(root)
  const workflow = workflows.find(item => item.id === id)
  if (!workflow) throw new LibraryError(`No workflow "${id}". See: enki workflow list`)
  if (workflow.problems.length > 0) throw new LibraryError(`${id} can't run:\n${workflow.problems.map(problem => `  - ${problem}`).join('\n')}`)
  const raw = JSON.parse(readFileSync(configPath(root), 'utf8'))
  raw.workflow = id
  writeJsonAtomic(configPath(root), raw)
  return `The project now runs ${workflow.name} (${id}) for new tasks. Tasks already running keep theirs.`
}

/** Removes one of the user's workflows. Tasks keep their own snapshot, so running ones are unaffected. */
export function deleteWorkflow(root, id) {
  const workflow = loadWorkflows(root).get(id)
  if (!workflow) throw new LibraryError(`No workflow "${id}".`)
  if (workflow.source === 'builtin') throw new LibraryError(`"${id}" is one of enki's own workflows: it can't be removed.`)
  // shortcut: only this project's default is checked; another project defaulting to it gets "no workflow" on its next task.
  if (JSON.parse(readFileSync(configPath(root), 'utf8')).workflow === id) throw new LibraryError(`${workflow.name} is this project's default: make another workflow the default first.`)
  rmSync(workflow.path, { force: true })
  return `Removed ${workflow.name}.`
}

/** "Full (copy)", or "Full (copy 2)" when that name is taken: copies never share a name. */
export function copyName(name, taken) {
  const names = new Set([...taken].map(item => item.trim().toLowerCase()))
  let candidate = `${name} (copy)`
  for (let n = 2; names.has(candidate.toLowerCase()); n++) candidate = `${name} (copy ${n})`
  return candidate
}

/** A copy under a new id, to change without touching the original. */
export function copyWorkflow(root, id, newId, to = 'library') {
  const workflows = loadWorkflows(root)
  const workflow = workflows.get(id)
  if (!workflow) throw new LibraryError(`No workflow "${id}". See: enki workflow list`)
  if (!ID.test(newId ?? '')) throw new LibraryError('The new id: lowercase letters, digits and dashes, starting with a letter.')
  const dir = join(destination(root, to), 'workflows')
  const path = join(dir, `${newId}.json`)
  if (existsSync(path)) throw new LibraryError(`${path} already exists.`)
  mkdirSync(dir, { recursive: true })
  // A copy starts without the original's description: it would describe the original, not what the copy becomes.
  const { description, ...rest } = strip(workflow)
  writeFileSync(path, `${JSON.stringify({ ...rest, id: newId, name: copyName(workflow.name, [...workflows.values()].map(item => item.name)) }, null, 2)}\n`)
  return `Copied ${id} to ${path}. Edit it there, or in the dashboard's studio.`
}

// ---------- agents ----------

/** An agent as its agent.json holds it: no file paths, no defaults filled in. */
export function agentMeta(role) {
  const flags = Object.fromEntries(['blind', 'browser', 'server', 'plans'].filter(key => role.capabilities?.[key]).map(key => [key, true]))
  return {
    id: role.id,
    name: role.name,
    type: typeOf(role),
    capabilities: { write: role.capabilities.write, ...flags },
    outcomes: role.outcomes.map(outcome => ({ id: outcome.id, ...(outcome.description ? { description: outcome.description } : {}) })),
    ...(role.model ? { model: role.model } : {}),
    ...(role.effort ? { effort: role.effort } : {}),
    ...(role.timeout ? { timeout: role.timeout } : {}),
    ...(role.skills?.length ? { skills: role.skills } : {}),
  }
}

const agentBundleEntry = role => ({ ...agentMeta(role), instructions: readFileSync(role.skillPath, 'utf8') })

/** Which workflows use each agent, as `{ id, name, steps }`. */
export function agentUsage(root) {
  const usage = new Map()
  for (const workflow of loadWorkflows(root).values()) {
    for (const node of workflow.nodes ?? []) {
      if (node.kind || !node.agent) continue
      if (!usage.has(node.agent)) usage.set(node.agent, [])
      const entry = usage.get(node.agent).find(item => item.id === workflow.id)
      if (entry) entry.steps.push(node.id)
      else usage.get(node.agent).push({ id: workflow.id, name: workflow.name, source: workflow.source, steps: [node.id] })
    }
  }
  return usage
}

/** Lines in workflows that hang off outcomes this agent would no longer have. */
export function agentBreakage(root, id, outcomes) {
  const keep = new Set(outcomes.map(outcome => (typeof outcome === 'string' ? outcome : outcome.id)))
  const broken = []
  for (const workflow of loadWorkflows(root).values()) {
    const steps = new Set((workflow.nodes ?? []).filter(node => !node.kind && node.agent === id).map(node => node.id))
    for (const edge of workflow.edges ?? []) {
      if (steps.has(edge.from) && edge.on !== 'otherwise' && !keep.has(edge.on)) broken.push(`${workflow.name} (${workflow.id}) has a line from ${edge.from} on "${edge.on}"`)
    }
  }
  return broken
}

/** An agent's folder in the library, written whole. */
function writeAgent(meta, instructions) {
  const dir = join(agentsDir(), meta.id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent.json'), `${JSON.stringify(meta, null, 2)}\n`)
  writeFileSync(join(dir, 'AGENT.md'), instructions.endsWith('\n') ? instructions : `${instructions}\n`)
  return dir
}

/** The starting instructions for a new agent: the sections a good agent file has. */
export function agentTemplate({ id = 'my-agent', name = 'My agent', capabilities = { write: 'none' }, outcomes = [] } = {}) {
  const writes = {
    none: 'You change nothing but your own report.',
    tests: 'You write test files only, where the repo keeps them. You never change the code under test.',
    code: 'You change code, never tests: the tests belong to another step.',
    all: 'You change code and tests.',
  }[capabilities.write] ?? ''
  return readFileSync(join(pluginRoot, 'templates', 'agent.md'), 'utf8')
    .replaceAll('{{id}}', id)
    .replaceAll('{{name}}', name)
    .replaceAll('{{writes}}', [writes, capabilities.blind ? 'You work blind: you see the requirements, never the code being changed or other steps\' reports.' : ''].filter(Boolean).join(' '))
    .replaceAll('{{outcomes}}', outcomes.length ? outcomes.map(outcome => `- **${outcome.id}:** ${outcome.description ?? ''}`).join('\n') : '- **done:** the work is finished: say what changed in the report.')
}

/** Checks a whole agent as the editor sends it: problems stop the save, warnings don't. */
export function checkAgent(root, meta, { creating = false } = {}) {
  const problems = roleProblems(meta)
  const roles = loadRoles(root)
  const existing = roles.get(meta?.id)
  if (existing?.source === 'builtin') problems.push(`"${meta.id}" is one of enki's own agents: copy it under a new id`)
  else if (creating && existing) problems.push(`an agent "${meta.id}" is already in your library`)
  if (problems.length === 0) problems.push(...agentBreakage(root, meta.id, meta.outcomes).map(line => `${line}: keep that outcome, or change the workflow first`))
  return { problems, warnings: problems.length ? [] : agentWarnings(meta) }
}

/** Saves an agent to the library: a new one, or a change to one of the user's own. */
export function saveAgent(root, { agent, instructions, creating = false }) {
  if (typeof instructions !== 'string' || !instructions.trim()) throw new LibraryError('The agent needs instructions.')
  const { problems, warnings } = checkAgent(root, agent, { creating })
  if (problems.length > 0) {
    const error = new LibraryError(`This agent can't be saved:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    error.problems = problems
    throw error
  }
  const existing = loadRoles(root).get(agent.id)
  writeAgent(agentMeta({ ...agent, capabilities: { blind: false, browser: false, server: false, plans: false, ...agent.capabilities } }), instructions)
  // An agent from before the rename moves to the new folder when it's saved.
  if (existing && existing.dir !== join(agentsDir(), agent.id)) rmSync(existing.dir, { recursive: true, force: true })
  return { saved: agent.id, warnings }
}

/** A copy of an agent in the library, under a new id. */
export function copyAgent(root, id, newId) {
  const roles = loadRoles(root)
  const role = roles.get(id)
  if (!role) throw new LibraryError(`No agent "${id}". See: enki agent list`)
  if (!ID.test(newId ?? '')) throw new LibraryError('The new id: lowercase letters, digits and dashes, starting with a letter.')
  if (roles.has(newId)) throw new LibraryError(`An agent "${newId}" already exists.`)
  const dir = writeAgent({ ...agentMeta(role), id: newId, name: copyName(role.name, [...roles.values()].map(item => item.name)) }, readFileSync(role.skillPath, 'utf8'))
  return `Copied ${id} to ${dir}. Edit it on the dashboard's Agents page.`
}

/** Removes one of the user's own agents, when no workflow uses it. */
export function deleteAgent(root, id) {
  const role = loadRoles(root).get(id)
  if (!role) throw new LibraryError(`No agent "${id}".`)
  if (role.source === 'builtin') throw new LibraryError(`"${id}" is one of enki's own agents: it can't be removed.`)
  const users = agentUsage(root).get(id) ?? []
  if (users.length) throw new LibraryError(`${id} is used by ${users.map(item => item.name).join(', ')}: take it out of those workflows first.`)
  rmSync(role.dir, { recursive: true, force: true })
  return `Removed ${id} from your library.`
}

export function listAgentsText(root) {
  const problems = []
  const roles = loadRoles(root, { problems })
  const usage = agentUsage(root)
  const lines = ['Agents:']
  for (const role of roles.values()) {
    const used = usage.get(role.id) ?? []
    lines.push(`  ${role.id.padEnd(16)} ${role.name} (${role.source === 'builtin' ? 'enki' : 'library'}): ${capabilityWords(role.capabilities)}. Outcomes: ${role.outcomes.map(outcome => outcome.id).join(', ')}${used.length ? `. Used by ${used.map(item => item.id).join(', ')}` : ''}`)
  }
  if (problems.length > 0) lines.push('', 'Not loaded:', ...problems.map(problem => `  ${problem.split('\n').join('\n  ')}`))
  return lines.join('\n')
}

export function showAgentText(root, id) {
  const role = loadRoles(root).get(id)
  if (!role) throw new LibraryError(`No agent "${id}". See: enki agent list`)
  const used = agentUsage(root).get(id) ?? []
  return [
    `${role.name} (${role.id}, ${role.source === 'builtin' ? 'enki\'s own' : 'your library'})`,
    `May: ${capabilityWords(role.capabilities)}`,
    `Outcomes: ${role.outcomes.map(outcome => `${outcome.id}${outcome.description ? ` (${outcome.description})` : ''}`).join('; ')}`,
    `Runs on: ${[role.model ?? 'the default model', role.effort ?? 'high effort'].join(', ')}${role.skills?.length ? `, with ${role.skills.join(', ')}` : ''}`,
    `Used by: ${used.map(item => `${item.id} (${item.steps.join(', ')})`).join('; ') || 'no workflow'}`,
    ...agentWarnings(role).map(warning => `Note: ${warning}`),
    `Instructions: ${role.skillPath}`,
  ].join('\n')
}

/** The export file for one agent, with its instructions. */
export function exportAgent(root, id) {
  const role = loadRoles(root).get(id)
  if (!role) throw new LibraryError(`No agent "${id}". See: enki agent list`)
  return { format: AGENT_FORMAT, version: AGENT_VERSION, exportedAt: new Date().toISOString(), agent: agentBundleEntry(role) }
}

/** Checks agents arriving in an import, against what the library already has. */
function incomingAgents(root, entries, where) {
  const problems = []
  const known = loadRoles(root)
  const incoming = new Map()
  for (const [index, entry] of entries.entries()) {
    const { instructions, ...meta } = entry ?? {}
    const label = `${where}[${index}] (${meta.id ?? '?'})`
    const own = roleProblems(meta).map(problem => `${label}: ${problem}`)
    if (typeof instructions !== 'string' || !instructions.trim()) own.push(`${label}: its instructions are missing`)
    if (known.get(meta.id)?.source === 'builtin') own.push(`${label}: "${meta.id}" is one of enki's own agents, which an import can't replace`)
    else if (known.has(meta.id)) own.push(`${label}: an agent "${meta.id}" is already in your library: remove or rename it first`)
    problems.push(...own)
    if (own.length === 0) incoming.set(meta.id, { ...meta, instructions, capabilities: { blind: false, browser: false, server: false, plans: false, ...meta.capabilities }, source: 'import' })
  }
  return { problems, incoming, known }
}

const skillWarningsFor = (root, agents) => {
  const installed = new Set(availableSkills({ root, workdirs: [] }).map(skill => skill.name))
  return agents.flatMap(agent => (agent.skills ?? []).filter(skill => !installed.has(skill)).map(skill => `${agent.id} uses the skill "${skill}", which isn't installed here: tasks will stop at team start until it is`))
}

/** What importing one agent would do: problems, warnings, and its permissions for the user to approve. */
export function inspectAgentImport(root, bundle) {
  if (bundle?.format !== AGENT_FORMAT) return { problems: [`not an enki agent export (format "${bundle?.format}")`], warnings: [], agents: [] }
  const problems = bundle.version === AGENT_VERSION ? [] : [`version ${bundle.version}: this enki reads version ${AGENT_VERSION}`]
  const found = incomingAgents(root, [bundle.agent], 'agent')
  problems.push(...found.problems)
  const agents = [...found.incoming.values()]
  return { problems, warnings: [...skillWarningsFor(root, agents), ...agents.flatMap(agent => agentWarnings(agent).map(warning => `${agent.id}: ${warning}`))], agents }
}

/**
 * What importing a workflow would do, without doing it: problems that stop it, warnings, and each
 * new agent's capabilities for the user to approve. Version 1 files called agents "roles".
 */
export function inspectImport(root, bundle, to = 'library') {
  const warnings = []
  if (bundle?.format === AGENT_FORMAT) return inspectAgentImport(root, bundle)
  if (bundle?.format !== EXPORT_FORMAT) return { problems: [`not an enki workflow export (format "${bundle?.format}")`], warnings, agents: [] }
  const problems = [1, 2].includes(bundle.version) ? [] : [`version ${bundle.version}: this enki reads versions 1 and 2`]
  const entries = Array.isArray(bundle.agents) ? bundle.agents : Array.isArray(bundle.roles) ? bundle.roles : []
  const found = incomingAgents(root, entries, 'agents')
  problems.push(...found.problems)
  const workflow = upgradeWorkflow(bundle.workflow)
  const dir = destination(root, to)
  if (workflow?.id && existsSync(join(dir, 'workflows', `${workflow.id}.json`))) problems.push(`a workflow "${workflow.id}" is already in the ${to}: remove or rename it first`)
  problems.push(...workflowProblems(workflow, new Map([...found.known, ...found.incoming])).map(problem => `workflow: ${problem}`))
  const agents = [...found.incoming.values()]
  warnings.push(...skillWarningsFor(root, agents))
  return { problems, warnings, agents }
}

const permissionLines = agents => agents.map(agent => `  ${agent.id} (${agent.name}): ${capabilityWords(agent.capabilities)}`)

/** Imports a workflow with its agents, or one agent. Needs the user's approval: `by: 'user'`. */
export function importText(root, bundle, { to = 'library', by } = {}) {
  const single = bundle?.format === AGENT_FORMAT
  const { problems, warnings, agents } = inspectImport(root, bundle, to)
  if (problems.length > 0) throw new LibraryError(`This file can't be imported:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
  const what = single ? `the agent ${bundle.agent.name} (${bundle.agent.id})` : `${bundle.workflow.name} (${bundle.workflow.id})`
  if (by !== 'user') {
    throw new LibraryError(
      [
        `Importing ${what} gives ${single ? 'it these permissions' : 'these agents their permissions'}:`,
        ...(agents.length ? permissionLines(agents) : ['  (only enki\'s own agents)']),
        ...warnings.map(warning => `warning: ${warning}`),
        '',
        'Show this to the user. If they approve, run the same command with --by user.',
      ].join('\n'),
    )
  }
  for (const agent of agents) {
    const { source, instructions, ...meta } = agent
    writeAgent(agentMeta(meta), instructions)
  }
  if (!single) {
    const dir = join(destination(root, to), 'workflows')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${bundle.workflow.id}.json`), `${JSON.stringify(upgradeWorkflow(bundle.workflow), null, 2)}\n`)
  }
  const into = single ? 'into your library' : `into the ${to}, with ${agents.length} agent(s) in your library`
  return [`Imported ${what} ${into}.`, ...permissionLines(agents), ...warnings.map(warning => `warning: ${warning}`)].join('\n')
}

/** The export file: the workflow, and every agent it uses that isn't enki's own, with its instructions. */
export function exportWorkflow(root, id) {
  const roles = loadRoles(root)
  const workflow = loadWorkflows(root).get(id)
  if (!workflow) throw new LibraryError(`No workflow "${id}". See: enki workflow list`)
  const used = [...new Set(workflow.nodes.filter(node => !node.kind).map(node => node.agent))]
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    workflow: strip(workflow),
    agents: used.map(name => roles.get(name)).filter(role => role && role.source !== 'builtin').map(agentBundleEntry),
  }
}

export const readBundle = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new LibraryError(`Can't read ${path}: ${error.message}`)
  }
}

