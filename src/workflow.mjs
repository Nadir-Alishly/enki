// Workflows: how a team's steps connect, from the user's request to the end of the task. A graph of
// steps (an agent, or a built-in step) and edges from each step's outcomes to the steps
// that run next. Three built-in steps frame every workflow: Start (the orchestrator passes on the
// request), Approval (the user approves the plan a planning step wrote) and End. An outcome with no
// edge hands the step back to the orchestrator, a call that returns. Enki runs the graph: the
// orchestrator briefs the steps it says are ready, and can't start the rest.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginRoot } from './paths.mjs'
import { EFFORTS, SKILL_NAME } from './config.mjs'
import { ENGINE_OUTCOMES, libraryDir, RESERVED_IDS, ROLE_ID, teamEntry } from './agents.mjs'

export const builtinWorkflowsDir = join(pluginRoot, 'templates', 'workflows')
export const DEFAULT_WORKFLOW = 'full'
export const WORKFLOW_VERSION = 2
/** Panes in one herdr tab stay usable up to about this many. */
export const MAX_AGENT_STEPS = 8
/** How many times a step may be handed to the orchestrator before enki stops the task. */
export const DEFAULT_HANDOFFS = 2
/** What each built-in step can report. */
export const BUILTIN_STEPS = { start: ['request'], approval: ['approved', 'changes'], verify: ['pass', 'fail'], end: [] }
/** Built-in steps every workflow has exactly one of, each with its kind as its id. */
export const FIXED_STEPS = ['start', 'approval', 'end']

const WORKFLOW_KEYS = new Set(['id', 'name', 'description', 'version', 'nodes', 'edges', 'layout', 'routes'])
const NODE_KEYS = new Set(['id', 'agent', 'kind', 'handoffs', 'model', 'effort', 'skills'])
const EDGE_KEYS = new Set(['from', 'on', 'to', 'max'])

export class WorkflowError extends Error {
  constructor(problems, where = 'workflow') {
    super(`Invalid ${where}:\n${problems.map(problem => `  - ${problem}`).join('\n')}`)
    this.problems = problems
  }
}

export const targetsOf = edge => (Array.isArray(edge.to) ? edge.to : [edge.to])
const isFixed = node => FIXED_STEPS.includes(node?.kind)

/** What a step can report: its role's declared outcomes, or a built-in step's own. */
export function outcomesOf(node, roles) {
  if (node.kind) return BUILTIN_STEPS[node.kind] ?? []
  return roles.get(node.agent)?.outcomes.map(outcome => (typeof outcome === 'string' ? outcome : outcome.id)) ?? []
}

/** The edge an outcome takes: its own, else the step's `otherwise`, else none (a hand-off). */
export function edgeFor(workflow, step, outcome) {
  return workflow.edges.find(edge => edge.from === step && edge.on === outcome) ?? workflow.edges.find(edge => edge.from === step && edge.on === 'otherwise') ?? null
}

/** Every step reachable from `from` along edges, never passing through `stop`. */
function reach(workflow, from, { stop = null } = {}) {
  const reached = new Set()
  const queue = [...from]
  while (queue.length > 0) {
    const id = queue.shift()
    if (reached.has(id)) continue
    reached.add(id)
    if (id === stop) continue
    queue.push(...workflow.edges.filter(edge => edge.from === id).flatMap(targetsOf))
  }
  return reached
}

/**
 * The steps before the plan is approved (reached from Start without passing Approval) and after it
 * (reached from Approval's `approved`), without the built-in Start, Approval and End.
 */
export function phasesOf(workflow) {
  const fixed = id => FIXED_STEPS.includes(id)
  const startEdge = workflow.edges.find(edge => edge.from === 'start' && edge.on === 'request')
  const approved = workflow.edges.find(edge => edge.from === 'approval' && edge.on === 'approved')
  const before = reach(workflow, startEdge ? targetsOf(startEdge) : [], { stop: 'approval' })
  const after = reach(workflow, approved ? targetsOf(approved) : [], { stop: 'approval' })
  return { before: new Set([...before].filter(id => !fixed(id))), after: new Set([...after].filter(id => !fixed(id))), reachesApproval: before.has('approval'), endBeforeApproval: before.has('end'), endAfterApproval: after.has('end'), approvalAfter: after.has('approval') }
}

/** Everything wrong with a workflow, given the roles it may use. Empty when it's sound. */
export function workflowProblems(workflow, roles) {
  const problems = []
  if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) return ['must be a JSON object']
  for (const key of Object.keys(workflow)) if (!WORKFLOW_KEYS.has(key)) problems.push(`unknown key "${key}"`)
  if (typeof workflow.id !== 'string' || !ROLE_ID.test(workflow.id)) problems.push('id: lowercase letters, digits and dashes, starting with a letter')
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) problems.push('name: required')
  if (workflow.layout !== undefined && (workflow.layout === null || typeof workflow.layout !== 'object' || Array.isArray(workflow.layout) || !Object.values(workflow.layout).every(point => Number.isFinite(point?.x) && Number.isFinite(point?.y)))) {
    problems.push('layout: positions by step id, each { "x": number, "y": number }')
  }
  if (workflow.routes !== undefined && (workflow.routes === null || typeof workflow.routes !== 'object' || Array.isArray(workflow.routes) || !Object.values(workflow.routes).every(route => Array.isArray(route) && route.length % 2 === 1 && route.every(Number.isFinite)))) {
    problems.push('routes: where each line runs, by "from:outcome:to": an odd-length list of numbers, alternately the x of an upright and the y of a crossing')
  }
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) return [...problems, 'nodes: at least Start, Approval and End']
  if (!Array.isArray(workflow.edges)) return [...problems, 'edges: required, a list']

  const nodes = new Map()
  for (const [index, node] of workflow.nodes.entries()) {
    const label = `nodes[${index}]`
    if (node === null || typeof node !== 'object') {
      problems.push(`${label}: must be an object`)
      continue
    }
    for (const key of Object.keys(node)) if (!NODE_KEYS.has(key)) problems.push(`${label}: unknown key "${key}"`)
    if (typeof node.id !== 'string' || !ROLE_ID.test(node.id)) problems.push(`${label}.id: lowercase letters, digits and dashes`)
    else if (RESERVED_IDS.has(node.id) && !(node.kind && node.id === node.kind)) problems.push(`${label}.id: "${node.id}" is reserved`)
    else if (nodes.has(node.id)) problems.push(`${label}.id: "${node.id}" is used twice`)
    if (node.kind !== undefined) {
      if (!(node.kind in BUILTIN_STEPS)) problems.push(`${label}.kind: one of ${Object.keys(BUILTIN_STEPS).join(', ')}`)
      else if (isFixed(node) && node.id !== node.kind) problems.push(`${label}: the ${node.kind} step's id is "${node.kind}"`)
      if (node.agent !== undefined) problems.push(`${label}: a built-in step has no agent`)
      if (isFixed(node) && node.handoffs !== undefined) problems.push(`${label}: ${node.kind} has no handoffs`)
    } else if (typeof node.agent !== 'string' || !roles.has(node.agent)) problems.push(`${label}.agent: no agent "${node.agent}"`)
    if (node.handoffs !== undefined && !(Number.isInteger(node.handoffs) && node.handoffs >= 0)) problems.push(`${label}.handoffs: a whole number, 0 or more`)
    if ((node.model !== undefined || node.effort !== undefined) && node.kind) problems.push(`${label}: only an agent step has a model and effort`)
    if (node.model !== undefined && !(typeof node.model === 'string' && node.model.trim())) problems.push(`${label}.model: a model name`)
    if (node.effort !== undefined && !EFFORTS.includes(node.effort)) problems.push(`${label}.effort: one of ${EFFORTS.join(', ')}`)
    if (node.skills !== undefined && (node.kind || !(Array.isArray(node.skills) && node.skills.every(name => typeof name === 'string' && SKILL_NAME.test(name))))) problems.push(`${label}.skills: ${node.kind ? 'only an agent step has skills' : 'a list of skill names, like "design:ux-copy"'}`)
    if (typeof node.id === 'string') nodes.set(node.id, node)
  }
  for (const kind of FIXED_STEPS) {
    const count = [...nodes.values()].filter(node => node.kind === kind).length
    if (count !== 1) problems.push(`nodes: ${count === 0 ? 'no' : 'more than one'} ${kind} step (every workflow has exactly one)`)
  }
  const agentSteps = [...nodes.values()].filter(node => !node.kind)
  if (agentSteps.length > MAX_AGENT_STEPS) problems.push(`nodes: at most ${MAX_AGENT_STEPS} agent steps, so their panes stay usable (this has ${agentSteps.length})`)

  const seen = new Set()
  for (const [index, edge] of workflow.edges.entries()) {
    const label = `edges[${index}]`
    if (edge === null || typeof edge !== 'object') {
      problems.push(`${label}: must be an object`)
      continue
    }
    for (const key of Object.keys(edge)) if (!EDGE_KEYS.has(key)) problems.push(`${label}: unknown key "${key}"`)
    const from = nodes.get(edge.from)
    if (!from) {
      problems.push(`${label}.from: no step "${edge.from}"`)
      continue
    }
    if (from.kind === 'end') {
      problems.push(`${label}: nothing leaves End`)
      continue
    }
    const outcomes = outcomesOf(from, roles)
    if (ENGINE_OUTCOMES.includes(edge.on)) problems.push(`${label}.on: "${edge.on}" always goes to the orchestrator`)
    else if (edge.on === 'otherwise' && isFixed(from)) problems.push(`${label}.on: ${from.kind} has no "otherwise"`)
    else if (edge.on !== 'otherwise' && !outcomes.includes(edge.on)) problems.push(`${label}.on: "${edge.from}" has no outcome "${edge.on}" (it has ${outcomes.join(', ')})`)
    const key = `${edge.from}:${edge.on}`
    if (seen.has(key)) problems.push(`${label}: "${edge.from}" already has an edge for "${edge.on}"`)
    seen.add(key)
    const targets = targetsOf(edge)
    if (targets.length === 0) problems.push(`${label}.to: at least one target`)
    for (const target of targets) {
      if (target === 'orchestrator') problems.push(`${label}.to: an outcome goes back to the orchestrator when it has no edge: remove this one`)
      else if (typeof target !== 'string' || !nodes.has(target)) problems.push(`${label}.to: no step "${target}"`)
      else if (target === 'start') problems.push(`${label}.to: nothing leads back to Start`)
    }
    if (targets.length > 1 && targets.some(target => target === 'end' || target === 'approval')) problems.push(`${label}.to: End and Approval stand alone, not in a list`)
    if (edge.max !== undefined && !(Number.isInteger(edge.max) && edge.max > 0)) problems.push(`${label}.max: a whole number, 1 or more`)
  }
  if (problems.length > 0) return problems

  const has = (from, on) => workflow.edges.some(edge => edge.from === from && edge.on === on)
  if (!has('start', 'request')) problems.push('start: its "request" goes nowhere: connect it to the first step')
  if (!has('approval', 'approved')) problems.push('approval: "approved" goes nowhere: connect it to the steps that do the work')
  if (!has('approval', 'changes')) problems.push('approval: "changes" goes nowhere: connect it back to the planning step')
  // A test run has no agent to hand back: where its results go has to be wired.
  for (const node of nodes.values()) {
    if (node.kind === 'verify' && !has(node.id, 'pass')) problems.push(`${node.id}: "pass" goes nowhere: connect it to the next check, or to End`)
  }
  if (problems.length > 0) return problems

  const roleOf = id => roles.get(nodes.get(id)?.agent)
  const plans = id => Boolean(roleOf(id)?.capabilities.plans)
  const phases = phasesOf(workflow)
  const { before, after } = phases

  // Before the plan: read-only agents, ending in a planning step that leads into Approval.
  if (!phases.reachesApproval) problems.push('approval: can\'t be reached from Start: a planning step leads into it')
  if (phases.endBeforeApproval) problems.push('end: reached before the plan is approved: every path from Start passes Approval first')
  for (const id of before) {
    const node = nodes.get(id)
    if (after.has(id)) problems.push(`${id}: runs both before and after the plan is approved: use two steps`)
    else if (node.kind) problems.push(`${id}: ${node.kind} runs after the plan is approved, not before`)
    else if (roleOf(id)?.capabilities.write !== 'none') problems.push(`${id}: can write, and nothing may be written before the plan is approved`)
  }
  for (const edge of workflow.edges.filter(item => targetsOf(item).includes('approval'))) {
    if (!before.has(edge.from) || !plans(edge.from)) problems.push(`${edge.from}: only a planning step (a role that plans, before Approval) leads into Approval`)
  }
  for (const target of targetsOf(workflow.edges.find(edge => edge.from === 'approval' && edge.on === 'changes'))) {
    if (!before.has(target) || !plans(target)) problems.push(`approval: "changes" goes back to a planning step before Approval, not to "${target}"`)
  }
  for (const id of after) if (plans(id)) problems.push(`${id}: plans, and a plan comes before Approval, not after`)
  if (!phases.endAfterApproval) problems.push('end: can\'t be reached after the plan is approved')
  for (const node of nodes.values()) {
    if (isFixed(node)) continue
    if (!before.has(node.id) && !after.has(node.id)) problems.push(`${node.id}: can't be reached from Start`)
  }
  if (problems.length > 0) return problems

  // Each step can still get somewhere: before the plan to Approval, after it to End.
  const next = id => workflow.edges.filter(edge => edge.from === id).flatMap(targetsOf)
  const leadsTo = (id, goal) => {
    const visited = new Set()
    const stack = [id]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === goal) return true
      if (visited.has(current) || current === 'approval') continue
      visited.add(current)
      stack.push(...next(current))
    }
    return false
  }
  for (const id of before) if (!leadsTo(id, 'approval')) problems.push(`${id}: never leads to Approval`)
  for (const id of after) if (!leadsTo(id, 'end')) problems.push(`${id}: never leads to End`)

  // A loop needs a limit: look for a cycle among edges that have none. The user drives the
  // Approval → planner loop, so it needs none.
  const unlimited = id => workflow.edges.filter(edge => edge.from === id && edge.max === undefined).flatMap(targetsOf).filter(target => nodes.has(target) && !isFixed(nodes.get(target)))
  const state = new Map()
  const cycle = []
  const visit = id => {
    state.set(id, 'open')
    cycle.push(id)
    for (const target of unlimited(id)) {
      if (state.get(target) === 'open') return [...cycle.slice(cycle.indexOf(target)), target]
      if (!state.has(target)) {
        const found = visit(target)
        if (found) return found
      }
    }
    cycle.pop()
    state.set(id, 'done')
    return null
  }
  for (const id of [...before, ...after]) {
    if (state.has(id)) continue
    const found = visit(id)
    if (found) {
      problems.push(`the loop ${found.join(' → ')} has no limit: give one of its edges a "max"`)
      break
    }
  }

  // Work that changes code is checked before the end: by verify, or by a read-only role.
  const isChecker = id => {
    const node = nodes.get(id)
    return node?.kind === 'verify' || (!node?.kind && roles.get(node?.agent)?.capabilities.write === 'none')
  }
  const writes = id => ['code', 'all'].includes(roleOf(id)?.capabilities.write)
  for (const id of [...after].filter(writes)) {
    const visited = new Set()
    const stack = [...next(id)]
    while (stack.length > 0) {
      const current = stack.pop()
      if (current === 'end') {
        problems.push(`${id} changes code, and a path from it reaches the end without verify or a read-only check`)
        break
      }
      if (visited.has(current) || isChecker(current)) continue
      visited.add(current)
      stack.push(...next(current))
    }
  }
  return problems
}

/**
 * A workflow saved before Start, Approval and End existed (version 1, with `intake` and `start`
 * lists), in today's form: Start leads to the intake steps, then a planner writes the plan for
 * Approval, which starts the old start steps. Edges to the orchestrator go: an outcome without an
 * edge goes there anyway. Anything else is returned as it is.
 */
export function upgradeWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.nodes)) return workflow
  const v2 = Array.isArray(workflow.start) && Array.isArray(workflow.edges) ? fromVersion1(workflow) : workflow
  // Steps named their "role" before agents were called agents. A step's "waitFor" is gone: a step
  // now waits for everything upstream of it on its own.
  if (!v2.nodes.some(node => node && typeof node === 'object' && ('role' in node || 'waitFor' in node))) return v2
  return {
    ...v2,
    nodes: v2.nodes.map(node => {
      if (!node || typeof node !== 'object') return node
      const { role, waitFor, ...rest } = node
      return 'role' in node && rest.agent === undefined ? { ...rest, agent: role } : rest
    }),
  }
}

function fromVersion1(workflow) {
  const { intake = [], start, ...rest } = workflow
  const taken = new Set(rest.nodes.map(node => node.id))
  const planner = ['planner', 'plan', 'planning'].find(id => !taken.has(id) || rest.nodes.find(node => node.id === id)?.role === 'planner') ?? 'planner-step'
  const chain = [...intake, planner]
  const edges = rest.edges
    .map(edge => ({ ...edge, to: targetsOf(edge).filter(target => target !== 'orchestrator') }))
    .filter(edge => edge.to.length > 0)
    .map(edge => ({ ...edge, to: edge.to.length === 1 ? edge.to[0] : edge.to }))
  return {
    ...rest,
    version: WORKFLOW_VERSION,
    nodes: [
      { id: 'start', kind: 'start' },
      ...rest.nodes.filter(node => intake.includes(node.id)),
      ...(taken.has(planner) ? rest.nodes.filter(node => node.id === planner) : [{ id: planner, role: 'planner' }]),
      { id: 'approval', kind: 'approval' },
      ...rest.nodes.filter(node => !intake.includes(node.id) && node.id !== planner),
      { id: 'end', kind: 'end' },
    ],
    edges: [
      { from: 'start', on: 'request', to: chain[0] },
      ...intake.map((id, index) => ({ from: id, on: 'done', to: chain[index + 1] })),
      { from: planner, on: 'ready', to: 'approval' },
      { from: 'approval', on: 'approved', to: start.length === 1 ? start[0] : start },
      { from: 'approval', on: 'changes', to: planner },
      ...edges,
    ],
  }
}

/** The workflow files under a folder, as `{ id, path }`. */
function workflowFiles(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(name => name.endsWith('.json'))
    .map(name => ({ id: name.slice(0, -5), path: join(dir, name) }))
}

/** Where workflows come from, in order: later sources replace earlier ones of the same id. */
export function workflowSources(root) {
  return [
    { source: 'builtin', dir: builtinWorkflowsDir },
    { source: 'library', dir: join(libraryDir(), 'workflows') },
    ...(root ? [{ source: 'project', dir: join(root, '.enki', 'workflows') }] : []),
  ]
}

/** Every workflow available in a project, by id, unchecked: checking needs the roles. */
export function loadWorkflows(root, { problems = [] } = {}) {
  const workflows = new Map()
  for (const { source, dir } of workflowSources(root)) {
    for (const file of workflowFiles(dir)) {
      try {
        const workflow = upgradeWorkflow(JSON.parse(readFileSync(file.path, 'utf8')))
        if (workflow?.id !== file.id) throw new Error(`id "${workflow?.id}" doesn't match its file name`)
        workflows.set(file.id, { ...workflow, source, path: file.path })
      } catch (error) {
        problems.push(`${file.path}: ${error.message}`)
      }
    }
  }
  return workflows
}

const strip = ({ source, path, ...workflow }) => workflow

/**
 * The workflow a task runs, checked against the roles it uses, and every agent step's team entry.
 * Throws WorkflowError when it's missing or broken.
 */
export function resolveWorkflow(id, { workflows, roles }) {
  const workflow = workflows.get(id)
  if (!workflow) throw new WorkflowError([`no workflow "${id}" (there are ${[...workflows.keys()].join(', ')})`], `workflow "${id}"`)
  const problems = workflowProblems(strip(workflow), roles)
  if (problems.length > 0) throw new WorkflowError(problems, `workflow "${id}"`)
  const team = Object.fromEntries(workflow.nodes.filter(node => !node.kind).map(node => [node.id, teamEntry(roles.get(node.agent), { node })]))
  return { workflow: strip(workflow), team }
}

/**
 * A copy of the workflow without the given steps, and every edge to them. `Tests: none` and
 * `Skip: qa` in a plan use this. The result is checked again, as removing a step can strand others.
 */
export function withoutSteps(workflow, skipped) {
  if (skipped.length === 0) return workflow
  const gone = new Set(skipped)
  return {
    ...workflow,
    nodes: workflow.nodes.filter(node => !gone.has(node.id)),
    edges: workflow.edges
      .filter(edge => !gone.has(edge.from))
      .map(edge => ({ ...edge, to: targetsOf(edge).filter(target => !gone.has(target)) }))
      .filter(edge => edge.to.length > 0)
      .map(edge => ({ ...edge, to: edge.to.length === 1 ? edge.to[0] : edge.to })),
    ...(workflow.layout ? { layout: Object.fromEntries(Object.entries(workflow.layout).filter(([id]) => !gone.has(id))) } : {}),
  }
}

/**
 * The task's own copy of its workflow. The description is for people choosing a workflow, and can
 * say anything: agents read this file, so it's left out, and they learn the workflow from its graph.
 */
export function writeWorkflowSnapshot(taskDir, workflow) {
  const { description, ...graph } = workflow
  writeFileSync(join(taskDir, 'workflow.json'), `${JSON.stringify(graph, null, 2)}\n`)
}

export const readWorkflowSnapshot = taskDir => upgradeWorkflow(JSON.parse(readFileSync(join(taskDir, 'workflow.json'), 'utf8')))

// ---------- running the graph ----------
// The run lives in state.json as `run`. These functions change it in place, inside updateState,
// and return what happened, for the events and for the orchestrator's output.

const freshStep = () => ({ status: 'idle', visits: 0, handoffs: 0, outcome: null, inputs: [], pending: false, reason: null, reported: null })

/** A run, from the task's creation: Start passes the request on, so the first steps are queued. */
export function startRun(workflow) {
  const steps = {}
  for (const node of workflow.nodes) if (node.kind !== 'start' && node.kind !== 'end') steps[node.id] = freshStep()
  const run = { workflow: workflow.id, steps, edges: {}, endReached: false }
  const edge = edgeFor(workflow, 'start', 'request')
  for (const target of edge ? targetsOf(edge) : []) queue(run, target, { from: 'request' })
  return run
}

/** The plan is with the user: a planning step finished, and Approval waits for them. */
export const awaitingApproval = run => run?.steps.approval?.status === 'queued'

/** The steps that send a step work (an edge into it). Built-in Start and Approval are never waited for. */
export function waitsFor(workflow, id) {
  const fixed = new Set(workflow.nodes.filter(node => FIXED_STEPS.includes(node.kind)).map(node => node.id))
  const inputs = workflow.edges.filter(edge => targetsOf(edge).includes(id)).map(edge => edge.from)
  return [...new Set(inputs)].filter(other => other !== id && !fixed.has(other))
}

const WRITE_WORDS = { none: 'writes nothing but its report', tests: 'writes test files only', code: 'writes code, never tests', all: 'writes code and tests' }

/** What a role may do, in words. */
export const capabilityWords = caps =>
  [caps.plans ? 'writes the plan, nothing else' : WRITE_WORDS[caps.write], caps.blind && 'blind: never sees the work', caps.browser && 'has a browser', caps.server && 'starts and stops the dev server'].filter(Boolean).join(', ')

const outputsOfStep = (node, role) => (node.kind ? BUILTIN_STEPS[node.kind] ?? [] : (role?.outcomes ?? []).map(outcome => (typeof outcome === 'string' ? outcome : outcome.id)))
const targetWord = id => ({ end: 'End', approval: 'Approval' })[id] ?? id

/** What the steps after the plan can't do between them, as sentences for the planner and the studio. */
export function workflowGaps(workflow, roleOf) {
  const { after } = phasesOf(workflow)
  const agents = workflow.nodes.filter(node => after.has(node.id) && !node.kind)
  const can = test => agents.some(node => {
    const role = roleOf(node)
    return role && test(role.capabilities)
  })
  const gaps = []
  if (!can(caps => ['code', 'all'].includes(caps.write))) gaps.push('No step can change code: plan only work that changes nothing, or propose another workflow.')
  if (!can(caps => ['tests', 'all'].includes(caps.write))) gaps.push('No step can write tests: the plan must say "Tests: none", or propose another workflow.')
  if (!can(caps => caps.browser)) gaps.push('No step uses a browser: nobody checks the running software.')
  if (!can(caps => caps.write === 'none' && !caps.plans)) gaps.push('No read-only step reviews the work once it is done.')
  for (const node of workflow.nodes.filter(item => item.kind === 'verify' && after.has(item.id))) {
    if (!edgeFor(workflow, node.id, 'fail')) gaps.push(`When the tests (${node.id}) fail, nothing goes back to fix them: the run stops and waits for the user.`)
  }
  return gaps
}

/**
 * The workflow as enki runs it, in words, made from its graph alone: each step, what its role may
 * do, where each outcome goes, and what no step can do. `roleOf(node)` gives a step's role
 * (`name`, `capabilities`, `outcomes`), or null.
 */
export function describeWorkflow(workflow, roleOf) {
  const { before, after } = phasesOf(workflow)
  const stepLine = node => {
    const role = node.kind ? null : roleOf(node)
    const what = node.kind === 'verify' ? 'built in: enki runs the project\'s test, lint and gate commands, no agent' : role ? `${role.name}: ${capabilityWords(role.capabilities)}` : `no role "${node.agent}" here`
    const routes = outputsOfStep(node, role).map(on => {
      const edge = edgeFor(workflow, node.id, on)
      return edge ? `${on} → ${targetsOf(edge).map(targetWord).join(' and ')}${edge.max ? ` (at most ${edge.max} times)` : ''}` : `${on} → back to the orchestrator`
    })
    const waits = waitsFor(workflow, node.id)
    return `- ${node.id} (${what}). ${routes.join('; ')}.${waits.length ? ` Waits for ${waits.join(', ')}.` : ''}`
  }
  const steps = ids => workflow.nodes.filter(node => ids.has(node.id)).map(stepLine)
  const changes = edgeFor(workflow, 'approval', 'changes')
  const approved = edgeFor(workflow, 'approval', 'approved')
  const gaps = workflowGaps(workflow, roleOf)
  return [
    `Workflow ${workflow.id} ("${workflow.name}"), as enki runs it:`,
    'Before the plan:',
    ...steps(before),
    `- approval (the user approves the plan). approved → ${approved ? targetsOf(approved).map(targetWord).join(' and ') : 'nothing'}; changes → ${changes ? targetsOf(changes).map(targetWord).join(' and ') : 'nothing'}.`,
    'After approval:',
    ...steps(after),
    ...(gaps.length ? ['What no step here does:', ...gaps.map(gap => `- ${gap}`)] : []),
  ].join('\n')
}

/** One line on a workflow, for choosing between them: the agents that work after the plan. */
export function workflowLine(workflow, roleOf) {
  const { after } = phasesOf(workflow)
  const work = workflow.nodes.filter(node => after.has(node.id)).map(node => (node.kind === 'verify' ? 'tests' : node.id === node.agent ? node.id : `${node.id} (${roleOf(node)?.name ?? node.agent})`))
  return `${workflow.id} ("${workflow.name}"): ${work.join(', ') || 'no steps after the plan'}`
}

/**
 * What's allowed but worth knowing: a test run whose failures go nowhere, and a description that
 * names roles the workflow doesn't have (it's for people, but it can mislead them).
 */
export function workflowWarnings(workflow, roles) {
  const warnings = []
  for (const node of (workflow.nodes ?? []).filter(item => item.kind === 'verify')) {
    if (!(workflow.edges ?? []).some(edge => edge.from === node.id && (edge.on === 'fail' || edge.on === 'otherwise'))) warnings.push(`${node.id}: "fail" isn't connected, so when tests fail the run stops and waits for the user`)
    // A failing test or coverage gate may need new or fixed tests: someone the failure reaches must be able to write them.
    const writesTests = id => ['tests', 'all'].includes(roles.get((workflow.nodes ?? []).find(item => item.id === id)?.agent)?.capabilities?.write)
    const fail = (workflow.edges ?? []).find(edge => edge.from === node.id && edge.on === 'fail')
    const testWriters = (workflow.nodes ?? []).filter(item => !item.kind && writesTests(item.id)).map(item => item.id)
    if (fail && testWriters.length && !targetsOf(fail).some(writesTests)) {
      warnings.push(`${node.id}: "fail" goes only to ${targetsOf(fail).join(', ')}, which can't write tests: a broken test or a coverage gate has no way to be fixed. Send it to ${testWriters.join(' or ')} too.`)
    }
  }
  if (typeof workflow.description === 'string' && workflow.description.trim()) {
    const used = new Set((workflow.nodes ?? []).map(node => node.agent).filter(Boolean))
    // "No QA" or "without a reviewer" says the role isn't there: only a plain mention counts.
    const mentions = word => [...workflow.description.matchAll(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}s?\\b`, 'gi'))].some(match => !/\b(no|not|without|nor)\b[\w\s,]{0,16}$/i.test(workflow.description.slice(Math.max(0, match.index - 24), match.index)))
    const named = [...roles.values()].filter(role => !used.has(role.id) && [role.id, role.name].some(mentions))
    if (named.length) warnings.push(`the description mentions ${named.map(role => role.name).join(', ')}, which this workflow doesn't have`)
  }
  return warnings
}

/** Why a step can't start now, or null. */
export function notReady(run, workflow, id) {
  const step = run.steps[id]
  if (!step) return `"${id}" isn't a step of this workflow`
  const node = workflow.nodes.find(item => item.id === id)
  if (node?.kind === 'approval') return step.status === 'queued' ? 'the plan waits for the user\'s approval' : 'no plan is waiting for approval'
  if (step.status === 'running') return `${id} is already running`
  if (step.status === 'handed-off') return `${id} is with the orchestrator (${step.reason}): resume it with enki resume ${id}, or ask the user`
  if (step.status !== 'queued') return `nothing has sent work to ${id} yet`
  const order = workflow.nodes.map(item => item.id)
  // A step waits for those it lists that are running, and for queued ones listed before it in the
  // workflow: two queued steps that list each other would otherwise wait forever, so the earlier goes first.
  const waiting = waitsFor(workflow, id).filter(other => {
    const step = run.steps[other]
    if (other === id || !step) return false
    return step.status === 'running' || (step.status === 'queued' && order.indexOf(other) < order.indexOf(id))
  })
  if (waiting.length > 0) return `${id} waits for ${waiting.join(', ')} to finish first`
  // Edges without a "max" run one way (loops need one), so they say what a step is built on. It
  // waits until every step feeding it that way has sent it work at least once…
  const fixed = new Set(workflow.nodes.filter(node => FIXED_STEPS.includes(node.kind)).map(node => node.id))
  const forward = workflow.edges.filter(edge => edge.max === undefined && !fixed.has(edge.from))
  const into = target => forward.filter(edge => targetsOf(edge).includes(target))
  const missing = [...new Set(into(id).map(edge => edge.from))].filter(from => !into(id).some(edge => edge.from === from && (run.edges[`${from}:${edge.on}`] ?? 0) > 0))
  if (missing.length > 0) return `${id} waits for ${missing.map(from => `${from} (${into(id).filter(edge => edge.from === from).map(edge => edge.on).join(' or ')})`).join(', ')} first`
  // …and while anything further back is still busy, since what it would get is about to change.
  const upstream = new Set()
  const climb = target => {
    for (const edge of into(target)) {
      if (upstream.has(edge.from)) continue
      upstream.add(edge.from)
      climb(edge.from)
    }
  }
  climb(id)
  const busy = [...upstream].filter(other => other !== id && ['running', 'queued', 'handed-off'].includes(run.steps[other]?.status))
  if (busy.length > 0) return `${id} waits for ${busy.join(', ')} to finish first: the work it gets comes through ${busy.length === 1 ? 'it' : 'them'}`
  return null
}

export const readySteps = (run, workflow) => Object.keys(run.steps).filter(id => !notReady(run, workflow, id))

/** Marks a ready step running, and returns its visit number and the inputs it was sent. */
export function startStep(run, id) {
  const step = run.steps[id]
  step.status = 'running'
  step.visits += 1
  step.reported = null
  const inputs = step.inputs
  step.inputs = []
  step.pending = false
  return { visit: step.visits, inputs }
}

function queue(run, target, input) {
  const step = run.steps[target]
  run.endReached = false
  if (step.status === 'running') {
    // Busy: it runs again once it's done, with this as its input.
    step.pending = true
    step.inputs.push(input)
    return
  }
  if (step.status === 'handed-off') {
    step.inputs.push(input)
    return
  }
  step.status = 'queued'
  step.inputs.push(input)
}

/**
 * A step's outcome, routed. Returns `{ to, handedOff, reason, stop }`: where the work went, or that
 * the step went to the orchestrator, and whether its hand-offs ran out (stop the task).
 * `byUser` lets the user take an edge past its limit. `note` travels with the work (the user's
 * requested changes, from Approval).
 */
export function routeOutcome(run, workflow, id, outcome, { report = null, byUser = false, note = null } = {}) {
  const step = run.steps[id]
  const node = workflow.nodes.find(item => item.id === id)
  const handOff = reason => handOffStep(run, workflow, id, outcome, reason)
  step.outcome = outcome
  step.status = 'idle'
  if (ENGINE_OUTCOMES.includes(outcome)) return handOff(outcome)
  const edge = edgeFor(workflow, id, outcome)
  if (!edge) return handOff(outcome)
  const targets = targetsOf(edge)
  const key = `${id}:${edge.on}`
  if (edge.max !== undefined && (run.edges[key] ?? 0) >= edge.max && !byUser) return handOff(`limit: ${id} → ${targets.join(', ')} has run ${edge.max} times`)
  run.edges[key] = (run.edges[key] ?? 0) + 1
  step.reason = null
  if (targets[0] === 'end') run.endReached = true
  else {
    // Approval passes on the plan itself: what each step then reads depends on whether it's blind.
    const input = node.kind === 'approval' && outcome === 'approved' ? { from: 'plan' } : { from: id, outcome, report, ...(note ? { note } : {}) }
    for (const target of targets) queue(run, target, input)
  }
  if (step.pending) step.status = 'queued'
  return { to: targets, handedOff: false, reason: null, stop: false }
}

/** A step goes to the orchestrator instead of on: the call that returns, with enki resume. */
export function handOffStep(run, workflow, id, outcome, reason) {
  const step = run.steps[id]
  const node = workflow.nodes.find(item => item.id === id)
  step.outcome = outcome
  step.status = 'handed-off'
  step.reason = reason
  step.handoffs += 1
  const limit = node?.handoffs ?? DEFAULT_HANDOFFS
  return { to: ['orchestrator'], handedOff: true, reason, stop: step.handoffs > limit }
}

/** The plan waiting for approval, or last approved: the report of the planning step that led to Approval. */
export const planReport = run => [...(run?.steps.approval?.inputs ?? [])].reverse().find(input => input.report)?.report ?? run?.plan ?? null

/** A handed-off step goes back to work: queued again, the orchestrator's note as its input. */
export function resumeStep(run, id, note) {
  const step = run.steps[id]
  if (step?.status !== 'handed-off') return `${id} isn't with the orchestrator`
  if (step.reason?.startsWith('limit')) return `${id} reached a loop limit. Only the user can decide how to go on: enki outcome ${id} <outcome> --by user, or stop the task`
  step.status = 'queued'
  step.reason = null
  step.inputs.push({ from: 'orchestrator', note: note ?? null })
  return null
}

/**
 * The approved plan goes back to the planner: every step after Approval is reset (their visits
 * stay counted, so reports keep distinct names) and Approval waits again, so the planner's
 * new plan can be approved. Returns what's still running after Approval, which blocks it.
 */
export function reopenPlan(run, workflow) {
  const { after } = phasesOf(workflow)
  const busy = [...after].filter(id => run.steps[id]?.status === 'running')
  if (busy.length > 0) return busy
  for (const id of after) if (run.steps[id]) Object.assign(run.steps[id], { status: 'idle', inputs: [], pending: false, reason: null, reported: null, outcome: null })
  run.edges = Object.fromEntries(Object.entries(run.edges).filter(([key]) => !after.has(key.split(':')[0])))
  run.endReached = false
  run.steps.approval.status = 'queued'
  return []
}

/** At Approval the plan may pick another workflow: its steps join the run, and the work so far stays. */
export function switchWorkflow(run, workflow) {
  for (const node of workflow.nodes) if (node.kind !== 'start' && node.kind !== 'end' && !run.steps[node.id]) run.steps[node.id] = freshStep()
  run.workflow = workflow.id
}

const sameText = (a, b) => a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim()

/**
 * Whether the plan the orchestrator is about to present can be approved: one is waiting, and it's
 * the planner's, word for word. Null when it can. `text` may be unknown before the dialog opens.
 */
export function planCheck(task, text = null) {
  if (!task?.run || task.approved) return null
  if (!awaitingApproval(task.run)) {
    return 'No plan is waiting for approval. The planner writes the plan, and enki next says when it\'s ready. The orchestrator never writes one itself.'
  }
  const file = join(task.taskDir, planReport(task.run))
  if (typeof text === 'string' && !sameText(readFileSync(file, 'utf8'), text)) {
    return `This isn't the planner's plan as written. Present the text of ${file} exactly, changing nothing. If the user wants changes, they go back to the planner: enki outcome approval changes --by user --note "<their words>"`
  }
  return null
}

const quiet = run => Object.values(run.steps).every(step => step.status === 'idle')

/** The workflow has done its work: it reached the end, and nothing is running, queued or handed off. */
export const runEnded = run => run.endReached && quiet(run)
