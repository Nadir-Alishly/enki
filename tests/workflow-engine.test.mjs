// The workflow graph on its own: checking workflows, and running them step by step.
import assert from 'node:assert/strict'
import test from 'node:test'
import { builtinRoles } from '../src/agents.mjs'
import { awaitingApproval, describeWorkflow, workflowGaps, workflowWarnings, waitsFor, loadWorkflows, notReady, phasesOf, readySteps, reopenPlan, reopenSpec, resolveWorkflow, savedBeforeSpecs, waitingApproval, resumeStep, routeOutcome, runEnded, startRun, startStep, switchWorkflow, upgradeWorkflow, withoutSteps, workflowProblems } from '../src/workflow.mjs'

const roles = builtinRoles()
const workflows = loadWorkflows(null)
const full = resolveWorkflow('full', { workflows, roles }).workflow
const problemsOf = workflow => workflowProblems(workflow, roles)

/** Runs a step to an outcome: it has to be ready. */
function step(run, workflow, id, outcome, options) {
  assert.equal(notReady(run, workflow, id), null, `${id} should be ready`)
  startStep(run, id)
  return routeOutcome(run, workflow, id, outcome, options)
}

const firstOutcome = (workflow, id) => roles.get(workflow.nodes.find(node => node.id === id).agent).outcomes[0].id

/** A run past its plan: the steps before the spec report, the user approves it, then the planning steps, and the user approves the plan. */
function approved(workflow) {
  const run = startRun(workflow)
  const { beforeSpec, between } = phasesOf(workflow)
  for (const id of beforeSpec) step(run, workflow, id, firstOutcome(workflow, id))
  assert.equal(waitingApproval(run), 'spec-approval')
  routeOutcome(run, workflow, 'spec-approval', 'approved')
  for (const id of between) step(run, workflow, id, firstOutcome(workflow, id))
  assert.equal(waitingApproval(run), 'approval')
  routeOutcome(run, workflow, 'approval', 'approved')
  return run
}

test('the built-in templates are sound', () => {
  for (const id of ['full', 'map', 'quick-fix', 'research']) assert.doesNotThrow(() => resolveWorkflow(id, { workflows, roles }), id)
  const { team } = resolveWorkflow('full', { workflows, roles })
  assert.deepEqual(Object.keys(team), ['scout', 'spec-writer', 'planner', 'coder', 'tester', 'qa', 'reviewer'], 'built-in steps get no agent')
  assert.deepEqual([...phasesOf(full).beforeSpec], ['scout', 'spec-writer'])
  assert.deepEqual([...phasesOf(full).between], ['planner'], 'the planner’s way back to the spec writer doesn’t make it a step before the spec')
  assert.deepEqual([...phasesOf(full).before], ['scout', 'spec-writer', 'planner'])
  assert.deepEqual([...phasesOf(full).after].sort(), ['coder', 'qa', 'reviewer', 'tester', 'verify'])
})

const base = {
  id: 'mini',
  name: 'Mini',
  nodes: [{ id: 'start', kind: 'start' }, { id: 'spec-writer', agent: 'spec-writer' }, { id: 'spec-approval', kind: 'spec-approval' }, { id: 'planner', agent: 'planner' }, { id: 'approval', kind: 'approval' }, { id: 'coder', agent: 'coder' }, { id: 'verify', kind: 'verify' }, { id: 'end', kind: 'end' }],
  edges: [
    { from: 'start', on: 'request', to: 'spec-writer' },
    { from: 'spec-writer', on: 'ready', to: 'spec-approval' },
    { from: 'spec-approval', on: 'approved', to: 'planner' },
    { from: 'spec-approval', on: 'changes', to: 'spec-writer' },
    { from: 'planner', on: 'ready', to: 'approval' },
    { from: 'planner', on: 'spec', to: 'spec-writer' },
    { from: 'approval', on: 'approved', to: 'coder' },
    { from: 'approval', on: 'change-plan', to: 'planner' },
    { from: 'approval', on: 'change-spec', to: 'spec-writer' },
    { from: 'coder', on: 'done', to: 'verify' },
    { from: 'verify', on: 'pass', to: 'end' },
    { from: 'verify', on: 'fail', to: 'coder', max: 2 },
  ],
}
const swap = (workflow, from, on, edge) => ({ ...workflow, edges: [...workflow.edges.filter(item => !(item.from === from && item.on === on)), ...(edge ? [edge] : [])] })

test('a workflow is checked before it can run', () => {
  assert.deepEqual(problemsOf(base), [], 'unwired outcomes, like the coder’s blocked, go back to the orchestrator')
  const early = { ...base, nodes: [...base.nodes, { id: 'early', agent: 'coder' }], edges: [...swap(base, 'start', 'request', { from: 'start', on: 'request', to: 'early' }).edges, { from: 'early', on: 'done', to: 'spec-writer' }] }
  const withScout = { ...base, nodes: [...base.nodes, { id: 'scout', agent: 'scout' }], edges: [...swap(base, 'start', 'request', { from: 'start', on: 'request', to: 'scout' }).edges, { from: 'scout', on: 'done', to: 'spec-writer' }] }
  const replanner = { ...base, nodes: [...base.nodes, { id: 'replan', agent: 'planner' }], edges: [...base.edges, { from: 'coder', on: 'blocked', to: 'replan' }, { from: 'replan', on: 'ready', to: 'coder', max: 1 }] }
  const cases = [
    [{ ...base, nodes: [...base.nodes, { id: 'coder', agent: 'coder' }] }, /used twice/],
    [{ ...base, nodes: [...base.nodes, { id: 'x', agent: 'designer' }] }, /no agent "designer"/],
    [{ ...base, edges: [...base.edges, { from: 'coder', on: 'shipped', to: 'end' }] }, /no outcome "shipped"/],
    [swap(base, 'verify', 'fail', { from: 'verify', on: 'fail', to: 'coder' }), /loop coder → verify → coder has no limit/],
    [{ ...base, edges: [...base.edges, { from: 'coder', on: 'blocked', to: 'end' }] }, /reaches the end without verify/],
    [swap(base, 'verify', 'pass'), /verify: "pass" goes nowhere/],
    [{ ...base, nodes: [...base.nodes, { id: 'lost', agent: 'reviewer' }], edges: [...base.edges, { from: 'lost', on: 'approve', to: 'end' }] }, /lost: can't be reached/],
    [swap(base, 'verify', 'pass', { from: 'verify', on: 'pass', to: 'coder', max: 1 }), /end: can't be reached after the plan is approved/],
    [early, /early: can write, and nothing may be written before the plan/],
    [{ ...base, edges: [...base.edges, { from: 'coder', on: 'error', to: 'end' }] }, /always goes to the orchestrator/],
    [{ ...base, edges: [...base.edges, { from: 'coder', on: 'blocked', to: 'orchestrator' }] }, /has no edge: remove this one/],
    [{ ...base, nodes: base.nodes.filter(node => node.id !== 'start'), edges: base.edges.filter(edge => edge.from !== 'start') }, /no start step/],
    [swap(base, 'start', 'request'), /"request" goes nowhere/],
    [swap(base, 'approval', 'change-plan'), /"change-plan" goes nowhere/],
    [swap(base, 'approval', 'change-spec'), /"change-spec" goes nowhere/],
    [swap(base, 'spec-approval', 'changes'), /spec-approval: "changes" goes nowhere/],
    [swap(base, 'approval', 'change-plan', { from: 'approval', on: 'change-plan', to: 'coder' }), /goes back to a planning step/],
    [swap(base, 'approval', 'change-spec', { from: 'approval', on: 'change-spec', to: 'planner' }), /"change-spec" goes back to a spec step/],
    [swap(base, 'spec-approval', 'changes', { from: 'spec-approval', on: 'changes', to: 'planner' }), /"changes" goes back to a spec step/],
    [{ ...base, nodes: base.nodes.filter(node => node.kind !== 'spec-approval'), edges: base.edges.filter(edge => edge.from !== 'spec-approval' && edge.to !== 'spec-approval') }, /no spec-approval step/],
    [swap(base, 'start', 'request', { from: 'start', on: 'request', to: 'planner' }), /planner: plans, and the plan comes after Spec approval/],
    [swap(base, 'spec-writer', 'ready', { from: 'spec-writer', on: 'ready', to: 'approval' }), /approval: reached before the spec is approved/],
    [{ ...base, edges: [...base.edges, { from: 'planner', on: 'questions', to: 'spec-approval' }] }, /only a spec step .* leads into Spec approval/],
    [{ ...withScout, edges: [...withScout.edges, { from: 'planner', on: 'questions', to: 'scout' }] }, /goes back before Spec approval, to "scout": only a spec step/],
    [{ ...base, edges: [...base.edges, { from: 'coder', on: 'blocked', to: 'approval' }] }, /only a planning step .* leads into Approval/],
    [{ ...base, edges: [...base.edges, { from: 'planner', on: 'questions', to: 'end' }] }, /reached before the plan is approved/],
    [replanner, /replan: plans, and a plan comes before Approval/],
    [{ ...base, edges: [...base.edges, { from: 'verify', on: 'pass', to: 'start' }] }, /already has an edge|nothing leads back to Start/],
    [{ ...base, nodes: [...base.nodes, ...Array.from({ length: 8 }, (_, i) => ({ id: `extra${i}`, agent: 'scout' }))] }, /at most 8 agent steps/],
    [{ ...base, layout: { coder: { x: 'left' } } }, /layout: positions/],
    [{ ...base, nodes: base.nodes.map(node => (node.id === 'coder' ? { ...node, effort: 'huge' } : node)) }, /nodes\[\d+\]\.effort: one of/],
    [{ ...base, nodes: base.nodes.map(node => (node.id === 'verify' ? { ...node, model: 'claude-opus-5-5' } : node)) }, /only an agent step has a model/],
  ]
  for (const [workflow, pattern] of cases) assert.ok(problemsOf(workflow).some(problem => pattern.test(problem)), `${pattern}: ${problemsOf(workflow).join('; ')}`)
  const otherwise = { ...base, edges: [...base.edges, { from: 'coder', on: 'otherwise', to: 'verify' }] }
  assert.deepEqual(problemsOf(otherwise), [], 'otherwise covers the rest')
  assert.deepEqual(problemsOf({ ...base, layout: { coder: { x: 10, y: 20 } } }), [], 'positions are for the dashboard')
  assert.deepEqual(problemsOf(withScout), [], 'read-only steps may come before the spec')
})

test('a workflow saved before specs gets the spec writer and Spec approval before its planning step', () => {
  // The mini workflow as it was saved before specs: one approval, whose "changes" went to the planner.
  const old = {
    ...base,
    nodes: base.nodes.filter(node => !['spec-writer', 'spec-approval'].includes(node.id)),
    edges: [{ from: 'start', on: 'request', to: 'planner' }, { from: 'planner', on: 'ready', to: 'approval' }, { from: 'approval', on: 'approved', to: 'coder' }, { from: 'approval', on: 'changes', to: 'planner' }, ...base.edges.filter(edge => ['coder', 'verify'].includes(edge.from))],
    routes: { 'coder:done:verify': [300, 120, 340] },
    layout: { start: { x: 0, y: 100 }, planner: { x: 160, y: 96 }, approval: { x: 400, y: 96 }, coder: { x: 640, y: 80 } },
  }
  assert.equal(savedBeforeSpecs(old), true)
  const upgraded = upgradeWorkflow(old)
  assert.deepEqual(problemsOf(upgraded), [])
  assert.equal(savedBeforeSpecs(upgraded), false)
  assert.deepEqual(upgraded.nodes.map(node => node.id), ['start', 'spec-writer', 'spec-approval', 'planner', 'approval', 'coder', 'verify', 'end'])
  const edge = (from, on) => upgraded.edges.find(item => item.from === from && item.on === on)?.to
  assert.deepEqual([edge('start', 'request'), edge('spec-writer', 'ready'), edge('spec-approval', 'approved'), edge('spec-approval', 'changes')], ['spec-writer', 'spec-approval', 'planner', 'spec-writer'])
  assert.deepEqual([edge('approval', 'change-plan'), edge('approval', 'change-spec'), edge('approval', 'changes'), edge('planner', 'spec')], ['planner', 'spec-writer', undefined, 'spec-writer'])
  assert.equal(upgraded.routes, undefined, 'line routes no longer fit')
  assert.deepEqual(upgraded.layout, { start: { x: 0, y: 100 }, 'spec-writer': { x: 160, y: 96 }, 'spec-approval': { x: 408, y: 96 }, planner: { x: 680, y: 96 }, approval: { x: 920, y: 96 }, coder: { x: 1160, y: 80 } }, 'the new steps take the planner’s place, and the rest moves right')
  assert.deepEqual(problemsOf(upgraded), [])
  // A task's own copy keeps its graph: only the renamed outcome changes.
  const snapshot = upgradeWorkflow(old, { addSpec: false })
  assert.equal(snapshot.nodes.length, old.nodes.length)
  assert.equal(snapshot.edges.find(item => item.from === 'approval' && item.to === 'planner').on, 'change-plan')
})

test('a workflow saved before Start and Approval is upgraded: a planner writes the plan', () => {
  const old = { id: 'old', name: 'Old', version: 1, intake: ['scout'], start: ['coder'], nodes: [{ id: 'scout', role: 'scout' }, { id: 'coder', role: 'coder' }, { id: 'verify', kind: 'verify' }], edges: [{ from: 'coder', on: 'done', to: 'verify' }, { from: 'coder', on: 'blocked', to: 'orchestrator' }, { from: 'verify', on: 'pass', to: 'end' }, { from: 'verify', on: 'fail', to: 'coder', max: 2 }] }
  const upgraded = upgradeWorkflow(old)
  assert.deepEqual(problemsOf(upgraded), [])
  assert.deepEqual([...phasesOf(upgraded).before], ['scout', 'spec-writer', 'planner'])
  assert.equal(upgraded.edges.some(edge => edge.to === 'orchestrator'), false)
  assert.equal(upgradeWorkflow(base), base, 'today’s workflows stay as they are')
  const roleKeys = { ...base, nodes: base.nodes.map(({ agent, ...node }) => (agent ? { ...node, role: agent } : node)) }
  assert.deepEqual(upgradeWorkflow(roleKeys).nodes, base.nodes, 'steps that said "role" say "agent"')
  assert.deepEqual(problemsOf(upgradeWorkflow(roleKeys)), [])
})

test('a step waits for the steps that send it work', () => {
  assert.deepEqual(waitsFor(full, 'coder').sort(), ['qa', 'reviewer', 'verify'])
  assert.deepEqual(waitsFor(full, 'verify').sort(), ['coder', 'tester'])
  assert.deepEqual(waitsFor(full, 'reviewer'), ['verify'], 'the coder upstream is waited for too, by notReady')
  assert.deepEqual(waitsFor(full, 'planner'), [], 'Start and the approvals are never waited for')
  assert.deepEqual(waitsFor(full, 'spec-writer'), ['scout'], 'nor the planner sending the work back: that comes only after the spec')
  assert.deepEqual(problemsOf({ ...base, routes: { 'coder:done:verify': [300, 120, 340] } }), [], 'where lines run is for the dashboard')
  assert.ok(problemsOf({ ...base, routes: { 'coder:done:verify': [300, 120] } }).some(problem => /^routes:/.test(problem)), 'a course ends on an upright')
})

test('a workflow is described from its graph, never from its description', () => {
  const roleOf = node => roles.get(node.agent) ?? null
  const lying = { ...base, description: 'The whole team: the coder and tester work in parallel, QA checks it.' }
  const text = describeWorkflow(lying, roleOf)
  assert.doesNotMatch(text, /whole team|parallel/)
  assert.match(text, /- coder \(Coder: writes code, never tests\)\. done → verify; blocked → back to the orchestrator\./)
  assert.match(text, /fail → coder \(at most 2 times\)/)
  assert.match(text, /No step can write tests: the plan must say "Tests: none"/)
  assert.deepEqual(workflowGaps(full, roleOf), [], 'Full can do everything')
  const noFail = swap(base, 'verify', 'fail')
  assert.ok(workflowGaps(noFail, roleOf).some(gap => /the run stops and waits for the user/.test(gap)))
  assert.deepEqual(problemsOf(noFail), [], 'a test run whose failures go nowhere is allowed')
  assert.match(workflowWarnings(noFail, roles).join(' '), /"fail" isn't connected/)
  assert.match(workflowWarnings(lying, roles).join(' '), /mentions QA, Tester, which this workflow doesn't have/)
  assert.deepEqual(workflowWarnings({ ...base, description: 'Small fixes: no QA, no tester.' }, roles), [], '"no QA" says it isn\'t there')
})

test('a run starts with the request, and the plan waits for the user', () => {
  const run = startRun(full)
  assert.deepEqual(readySteps(run, full), ['scout'])
  assert.deepEqual(run.steps.scout.inputs, [{ from: 'request' }])
  assert.equal(run.steps.start, undefined, 'Start and End are no steps of the run')
  step(run, full, 'scout', 'done', { report: 'scout-r1.md' })
  assert.deepEqual(readySteps(run, full), ['spec-writer'])
  step(run, full, 'spec-writer', 'ready', { report: 'spec-writer-r1.md' })
  assert.equal(waitingApproval(run), 'spec-approval')
  assert.match(notReady(run, full, 'spec-approval'), /the spec waits for the user's approval/)
  assert.deepEqual(readySteps(run, full), [], 'nothing runs while the user reads the spec')
  routeOutcome(run, full, 'spec-approval', 'changes', { note: 'Dark mode too', report: 'spec-writer-r1.md' })
  assert.deepEqual(run.steps['spec-writer'].inputs, [{ from: 'spec-approval', outcome: 'changes', report: 'spec-writer-r1.md', note: 'Dark mode too' }])
  step(run, full, 'spec-writer', 'ready', { report: 'spec-writer-r2.md' })
  routeOutcome(run, full, 'spec-approval', 'approved')
  assert.deepEqual(run.steps.planner.inputs, [{ from: 'spec' }])
  step(run, full, 'planner', 'ready', { report: 'planner-r1.md' })
  assert.equal(waitingApproval(run), 'approval')
  assert.equal(awaitingApproval(run), true)
  assert.match(notReady(run, full, 'approval'), /waits for the user's approval/)
  assert.deepEqual(readySteps(run, full), [], 'nothing runs while the user reads the plan')
  routeOutcome(run, full, 'approval', 'change-plan', { note: 'Keep the old URL', report: 'planner-r1.md' })
  assert.deepEqual(run.steps.planner.inputs, [{ from: 'approval', outcome: 'change-plan', report: 'planner-r1.md', note: 'Keep the old URL' }])
  step(run, full, 'planner', 'ready', { report: 'planner-r2.md' })
  routeOutcome(run, full, 'approval', 'approved')
  assert.deepEqual(readySteps(run, full).sort(), ['coder', 'tester'])
  assert.deepEqual(run.steps.coder.inputs, [{ from: 'plan' }])
})

test('the user’s changes to the spec, or a plan that can’t meet it, send the work back to the spec writer', () => {
  const run = approved(full)
  startStep(run, 'coder')
  assert.deepEqual(reopenSpec(run, full), ['coder'], 'the coder is still working on the approved plan')
  routeOutcome(run, full, 'coder', 'done')
  assert.deepEqual(reopenSpec(run, full), [])
  assert.equal(waitingApproval(run), null, 'neither approval waits until there is a new spec')
  routeOutcome(run, full, 'approval', 'change-spec', { note: 'Only the header' })
  assert.deepEqual(readySteps(run, full), ['spec-writer'])
  assert.deepEqual(run.steps.planner.status, 'idle')
  step(run, full, 'spec-writer', 'ready')
  assert.equal(waitingApproval(run), 'spec-approval')
  routeOutcome(run, full, 'spec-approval', 'approved')
  const back = step(run, full, 'planner', 'spec', { report: 'planner-r2.md' })
  assert.deepEqual(back.to, ['spec-writer'])
  assert.equal(notReady(run, full, 'spec-writer'), null, 'the spec writer doesn’t wait for the planner that sent the work back')
})

test('a planner’s questions go back to the orchestrator, which resumes it', () => {
  const run = startRun(base)
  step(run, base, 'spec-writer', 'ready')
  routeOutcome(run, base, 'spec-approval', 'approved')
  const asked = step(run, base, 'planner', 'questions')
  assert.deepEqual([asked.handedOff, asked.reason], [true, 'questions'])
  assert.equal(resumeStep(run, 'planner', 'answers added to request.md'), null)
  assert.equal(notReady(run, base, 'planner'), null)
})

test('the Full workflow runs as today’s team did: code and tests together, then QA, tests and review', () => {
  const run = approved(full)
  assert.deepEqual(readySteps(run, full).sort(), ['coder', 'tester'])
  assert.match(notReady(run, full, 'reviewer'), /nothing has sent work/)
  startStep(run, 'coder')
  startStep(run, 'tester')
  assert.deepEqual(routeOutcome(run, full, 'coder', 'done').to, ['verify', 'qa'])
  assert.match(notReady(run, full, 'verify'), /waits for tester/, 'tests mean nothing while the tester is still writing them')
  assert.deepEqual(readySteps(run, full), ['qa'], 'QA starts as soon as the coder reports')
  routeOutcome(run, full, 'tester', 'done')
  step(run, full, 'verify', 'pass')
  step(run, full, 'qa', 'pass')
  assert.equal(runEnded(run), false, 'the reviewer is still to come')
  step(run, full, 'reviewer', 'approve')
  assert.equal(runEnded(run), true)
})

test('findings go back to the coder together, and a stale test run waits for the new code', () => {
  const run = approved(full)
  step(run, full, 'tester', 'done')
  step(run, full, 'coder', 'done')
  startStep(run, 'qa')
  assert.equal(routeOutcome(run, full, 'verify', 'fail').to[0], 'coder', 'verify ran (it was ready) and failed')
  assert.match(notReady(run, full, 'coder'), /waits for qa/, 'the coder waits for QA, to get both findings at once')
  routeOutcome(run, full, 'qa', 'bug')
  assert.deepEqual(run.steps.coder.inputs.map(input => `${input.from}:${input.outcome}`), ['verify:fail', 'qa:bug'])
  assert.deepEqual(readySteps(run, full).sort(), ['coder', 'tester'])
  step(run, full, 'coder', 'done')
  assert.match(notReady(run, full, 'verify'), /waits for tester/)
  step(run, full, 'tester', 'done')
  assert.deepEqual(readySteps(run, full).sort(), ['qa', 'verify'])
})

test('two queued steps that wait for each other don’t deadlock: the earlier one goes first', () => {
  const run = approved(full)
  step(run, full, 'tester', 'done')
  step(run, full, 'coder', 'done') // queues verify and qa
  step(run, full, 'qa', 'bug') // queues coder and tester, while verify is still queued from before
  assert.equal(notReady(run, full, 'coder'), null, 'the coder goes ahead of the stale test run')
  assert.match(notReady(run, full, 'verify'), /waits for coder/, 'and the test run waits for the new code')
})

test('a loop stops at its limit and goes to the orchestrator; only the user can take it further', () => {
  const run = approved(base)
  step(run, base, 'coder', 'done')
  step(run, base, 'verify', 'fail')
  step(run, base, 'coder', 'done')
  step(run, base, 'verify', 'fail')
  step(run, base, 'coder', 'done')
  const third = step(run, base, 'verify', 'fail')
  assert.equal(third.handedOff, true)
  assert.match(third.reason, /^limit/)
  assert.match(resumeStep(run, 'verify'), /Only the user/)
  const user = routeOutcome(run, base, 'verify', 'fail', { byUser: true })
  assert.deepEqual(user.to, ['coder'])
})

test('an outcome with no edge returns to the step it came from, and too many stop the task', () => {
  const run = approved(base)
  const first = step(run, base, 'coder', 'blocked')
  assert.deepEqual([first.handedOff, first.reason, first.stop], [true, 'blocked', false])
  assert.equal(runEnded(run), false)
  assert.match(notReady(run, base, 'coder'), /with the orchestrator/)
  assert.equal(resumeStep(run, 'coder', 'The server is up on 4410'), null)
  assert.deepEqual(run.steps.coder.inputs.at(-1), { from: 'orchestrator', note: 'The server is up on 4410' })
  assert.equal(step(run, base, 'coder', 'blocked').stop, false)
  resumeStep(run, 'coder')
  assert.equal(step(run, base, 'coder', 'error').stop, true, 'the third hand-off is past the limit of 2')
})

test('an approved plan can be reopened once nothing works on it, and a new plan may switch workflows', () => {
  const run = approved(full)
  startStep(run, 'coder')
  assert.deepEqual(reopenPlan(run, full), ['coder'], 'the coder is still working on the old plan')
  routeOutcome(run, full, 'coder', 'done')
  assert.deepEqual(reopenPlan(run, full), [])
  assert.equal(awaitingApproval(run), true)
  assert.deepEqual(readySteps(run, full), [], 'the old plan’s work is dropped')
  assert.equal(run.steps.coder.visits, 1, 'visits stay, so reports keep their names')
  const quick = resolveWorkflow('quick-fix', { workflows, roles }).workflow
  switchWorkflow(run, quick)
  routeOutcome(run, quick, 'approval', 'approved')
  assert.deepEqual(readySteps(run, quick), ['coder'])
})

test('skipping steps removes them and their edges, and the result is checked again', () => {
  const lite = withoutSteps(full, ['tester', 'qa'])
  assert.deepEqual(lite.edges.find(edge => edge.from === 'approval' && edge.on === 'approved').to, 'coder')
  assert.deepEqual(lite.edges.find(edge => edge.from === 'coder' && edge.on === 'done').to, 'verify')
  assert.deepEqual(problemsOf(lite), [])
  assert.ok(problemsOf(withoutSteps(full, ['reviewer'])).length > 0, 'without the reviewer, a passing test run leads nowhere')
  assert.ok(problemsOf(withoutSteps(full, ['reviewer'])).some(problem => /verify: "pass" goes nowhere/.test(problem)))
})

test('a step starts only once every input has fired, and never while the work it gets is still changing', () => {
  // As a user's copy of Full had it: QA's pass goes to the reviewer too.
  const mine = { ...full, edges: full.edges.map(edge => (edge.from === 'qa' && edge.on === 'pass' ? { ...edge, to: 'reviewer' } : edge)) }
  assert.deepEqual(problemsOf(mine), [])
  const run = approved(mine)
  step(run, mine, 'coder', 'done')
  step(run, mine, 'tester', 'done')
  startStep(run, 'qa')
  step(run, mine, 'verify', 'fail') // back to the coder
  routeOutcome(run, mine, 'qa', 'pass') // QA passed the code the tests just failed
  assert.match(notReady(run, mine, 'reviewer'), /waits for verify \(pass\)/, 'the tests never passed, so the reviewer waits')
  startStep(run, 'coder')
  assert.match(notReady(run, mine, 'reviewer'), /waits for verify \(pass\)/)
  routeOutcome(run, mine, 'coder', 'done') // queues verify and QA again
  step(run, mine, 'tester', 'done') // the failure went to the tester too
  step(run, mine, 'verify', 'pass')
  assert.match(notReady(run, mine, 'reviewer'), /waits for qa to finish first/, 'QA is checking the new code')
  step(run, mine, 'qa', 'pass')
  assert.deepEqual(run.steps.reviewer.inputs.map(input => `${input.from}:${input.outcome}`), ['qa:pass', 'verify:pass', 'qa:pass'])
  step(run, mine, 'reviewer', 'changes') // a later round: both inputs fired before
  step(run, mine, 'coder', 'done')
  step(run, mine, 'verify', 'pass')
  assert.match(notReady(run, mine, 'reviewer'), /waits for qa/, 'an old pass from QA doesn’t count while QA checks again')
  startStep(run, 'qa')
  routeOutcome(run, mine, 'qa', 'bug') // the coder and tester work again
  assert.match(notReady(run, mine, 'reviewer'), /waits for .*coder.* to finish first: the work it gets comes through/, 'nothing goes to review while upstream rework is under way')
})

test('an older workflow’s waitFor loads, and is dropped', () => {
  const old = { ...full, nodes: full.nodes.map(node => (node.id === 'reviewer' ? { ...node, waitFor: ['coder'] } : node)) }
  const upgraded = upgradeWorkflow(old)
  assert.equal(upgraded.nodes.find(node => node.id === 'reviewer').waitFor, undefined)
  assert.deepEqual(problemsOf(upgraded), [])
})

test('failing tests that reach no step able to write tests are warned about', () => {
  const coderOnly = { ...full, edges: full.edges.map(edge => (edge.from === 'verify' && edge.on === 'fail' ? { ...edge, to: 'coder' } : edge)) }
  assert.ok(workflowWarnings(coderOnly, roles).some(warning => /"fail" goes only to coder, which can't write tests.*tester/.test(warning)))
  assert.ok(!workflowWarnings(full, roles).some(warning => /can't write tests/.test(warning)), 'Full sends it to the tester too')
})
