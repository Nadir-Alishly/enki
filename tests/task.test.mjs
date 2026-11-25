import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { DEFAULT_SPEC, fullPlan, makeProject } from './helpers/harness.mjs'

const started = (project, slug = 'demo') => {
  const result = project.enki(['task', 'new', slug])
  assert.equal(result.code, 0, result.err)
  return project
}

const approved = (project, plan) => {
  started(project)
  project.approve(plan)
  return project
}

const envelopeOf = (project, name, index) => {
  const prompt = project.herdr.calls('agent', 'prompt', name).at(index)[3]
  return readFileSync(prompt.slice(5, -' and follow it.'.length), 'utf8')
}

const launch = (project, name) => project.herdr.calls('agent', 'start', name)[0]

test('task new creates state, a verified grid and the steps before the plan, and nothing else', () => {
  const project = started(makeProject())
  const state = project.state('demo')
  assert.equal(state.phase, 'intake')
  assert.equal(state.approved, false)
  assert.equal(state.orchestratorPane, 'w1:orch')
  assert.deepEqual(state.repos[0], { name: 'web', workdir: join(project.root, 'web'), url: 'http://localhost:4321', port: 4321, testGlobs: ['tests/**'] })
  assert.deepEqual(Object.keys(state.herdr.panes).sort(), ['coder', 'planner', 'qa', 'reviewer', 'scout', 'spec-writer', 'tester'])
  assert.deepEqual(Object.keys(state.agents), ['scout', 'spec-writer', 'planner'])
  assert.ok(existsSync(join(project.taskDir('demo'), 'rules.md')))
  assert.equal(project.herdr.calls('agent', 'start').length, 3)
  assert.deepEqual(state.run.steps.scout.inputs, [{ from: 'request' }], 'Start passed the request on: the scout is queued')
  assert.match(project.enki(['next']).out, /scout: ready, visit 1\. Sent by the user's request/)
})

test('each pane knows its step and task', () => {
  const project = started(makeProject())
  const { panes } = project.state('demo').herdr
  const fake = project.herdr.read().panes
  for (const role of ['scout', 'planner', 'coder', 'tester', 'qa', 'reviewer']) {
    assert.equal(fake[panes[role]].env.ENKI_STEP, role)
    assert.equal(fake[panes[role]].env.ENKI_TASK, project.taskDir('demo'))
  }
})

test('workers launch with explicit models and permission mode, and only QA gets Chrome', () => {
  const project = approved(makeProject({ browser: { driver: 'chrome' } }))
  assert.equal(project.enki(['team', 'start']).code, 0)
  const scout = launch(project, 'scout-demo')
  const coder = launch(project, 'coder-demo')
  const tester = launch(project, 'tester-demo')
  const qa = launch(project, 'qa-demo')
  const reviewer = launch(project, 'reviewer-demo')
  for (const call of [scout, coder, tester, qa, reviewer]) {
    assert.equal(call[call.indexOf('--permission-mode') + 1], 'auto')
    assert.equal(call[call.indexOf('--disallowedTools') + 1], 'AskUserQuestion,EnterPlanMode,ExitPlanMode')
    assert.ok(call.includes('--append-system-prompt-file'))
    assert.equal(call[call.indexOf('--add-dir') + 1], project.taskDir('demo'))
    assert.equal(JSON.parse(call[call.indexOf('--settings') + 1]).permissions.allow[0], `Edit(/${project.taskDir('demo')}/**)`)
  }
  assert.equal(scout[scout.indexOf('--model') + 1], 'claude-haiku-5-5')
  assert.equal(coder[coder.indexOf('--model') + 1], 'claude-sonnet-5-5')
  assert.ok(qa.includes('--chrome'))
  for (const call of [scout, coder, tester, reviewer]) assert.ok(!call.includes('--chrome'))
})

test('the none browser driver leaves Chrome off for everyone', () => {
  const project = approved(makeProject({ browser: { driver: 'none' } }))
  project.enki(['team', 'start'])
  assert.ok(!launch(project, 'qa-demo').includes('--chrome'))
})

test('team models and permission mode come from config', () => {
  const project = started(makeProject({ permissionMode: 'acceptEdits', steps: { scout: { model: 'custom-model' } } }))
  const scout = launch(project, 'scout-demo')
  assert.equal(scout[scout.indexOf('--model') + 1], 'custom-model')
  assert.equal(scout[scout.indexOf('--permission-mode') + 1], 'acceptEdits')
})

test('the role file carries the QA browser notes and playbook sections', () => {
  const project = makeProject({ browser: { driver: 'chrome' } })
  writeFileSync(join(project.root, '.enki/playbook.md'), '## All\n\nShared rule XYZ.\n\n## QA\n\nQA rule ABC.\n\n## Coder\n\nCoder rule.\n')
  approved(project)
  project.enki(['team', 'start'])
  const qa = readFileSync(join(project.taskDir('demo'), 'role-qa.md'), 'utf8')
  assert.match(qa, /QA rule ABC/)
  assert.match(qa, /Don't leave empty tabs/)
  assert.match(qa, /enki server start/)
  assert.doesNotMatch(qa, /stays open/)
  assert.doesNotMatch(qa, /Coder rule/)
  assert.doesNotMatch(readFileSync(join(project.taskDir('demo'), 'role-tester.md'), 'utf8'), /Claude in Chrome/)
  assert.match(readFileSync(join(project.taskDir('demo'), 'rules.md'), 'utf8'), /Shared rule XYZ/)
})

test('a duplicate open slug and bad slugs are refused', () => {
  const project = started(makeProject())
  assert.match(project.enki(['task', 'new', 'demo']).err, /already open/)
  assert.equal(project.enki(['task', 'new', 'Bad_Slug']).code, 2)
  assert.equal(project.enki(['task', 'new', 'x'.repeat(30)]).code, 2)
})

test('outside herdr, enki refuses to start a task', () => {
  const project = makeProject()
  const result = project.enki(['task', 'new', 'demo'], { HERDR_ENV: '' })
  assert.notEqual(result.code, 0)
  assert.match(result.err, /Not running inside herdr/)
})

test('an unknown repo is refused', () => {
  const project = makeProject()
  assert.match(project.enki(['task', 'new', 'demo', '--repo', 'nope']).err, /Unknown repo/)
})

test('a grid that comes out wrong stops the task', () => {
  const project = makeProject()
  project.herdr.script(script => { script.brokenLayout = true })
  const result = project.enki(['task', 'new', 'demo'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /expected grid/)
})

// The approval gate

test('the team cannot start before approval', () => {
  const project = started(makeProject())
  const result = project.enki(['team', 'start'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /isn't approved/)
  assert.equal(project.herdr.calls('agent', 'start').length, 3)
})

test('a role cannot be started around the gate', () => {
  const project = started(makeProject())
  assert.match(project.enki(['start', 'coder']).err, /can start before it is approved/)
})

test('approval cannot be claimed through the CLI', () => {
  const project = started(makeProject())
  assert.match(project.enki(['phase', 'approved']).err, /Only the user/)
  assert.equal(project.state('demo').approved, false)
})

test('later phases cannot be reached before approval', () => {
  const project = started(makeProject())
  assert.match(project.enki(['phase', 'coding']).err, /isn't approved/)
})

test('the ExitPlanMode hook approves, saves the plan and reads team and scope', () => {
  const project = started(makeProject())
  const result = project.approve('# Plan\n\nScope: deps\n- Scope: infra\n')
  assert.match(result.json.hookSpecificOutput.additionalContext, /scope: deps, infra/)
  const state = project.state('demo')
  assert.equal(state.approved, true)
  assert.equal(state.phase, 'approved')
  assert.deepEqual(state.scope, ['deps', 'infra'])
  assert.match(readFileSync(join(project.taskDir('demo'), 'approved-plan.md'), 'utf8'), /Scope: deps/)
})

test('planning begins when the planner reports a plan, not by hand', () => {
  const project = started(makeProject())
  const result = project.enki(['phase', 'planning'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /workflow sets this phase/)
  assert.equal(project.state('demo').phase, 'intake')
  project.planReady()
  assert.equal(project.state('demo').phase, 'planning')
  assert.match(project.enki(['next']).out, /Approval: the plan waits for the user\. Present .*planner-r1\.md exactly as written/)
})

test('a request is written before the first step works', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo', '--no-request'])
  assert.match(project.enki(['ask', 'scout', project.brief()]).err, /Write the user's request to .*request\.md first/)
})

test('the planner’s questions go to the user through the orchestrator, and it resumes with the answers', () => {
  const project = started(makeProject())
  project.herdr.script(script => { script.report = { 'planner-demo': ['questions'] } })
  project.specApproved()
  const asked = project.enki(['ask', 'planner', project.brief()])
  assert.match(asked.out, /planner has questions only the user can answer: .*planner-r1\.md\. Ask the user them with AskUserQuestion/)
  assert.match(asked.out, /enki resume planner --note "answers added to request\.md"/)
  assert.equal(project.enki(['resume', 'planner', '--note', 'answers added to request.md']).code, 0)
  const second = project.enki(['ask', 'planner', project.brief()])
  assert.equal(second.code, 0, second.err)
  const envelope = envelopeOf(project, 'planner-demo', 1)
  assert.match(envelope, /The user's request, with every answer they have given since: .*request\.md/)
  assert.match(envelope, /From the orchestrator: answers added to request\.md/)
  assert.match(envelope, /The spec the user approved: .*spec\.md/, 'the planner plans from the approved spec')
})

test('the planner learns the workflow from its graph: never from its description, which agents can’t read', () => {
  const project = makeProject()
  mkdirSync(join(project.root, '.enki/workflows'), { recursive: true })
  const full = JSON.parse(readFileSync(join(import.meta.dirname, '../templates/workflows/full.json'), 'utf8'))
  // A Full that lost its tester, QA and reviewer, still described as the whole team.
  const lean = {
    ...full,
    id: 'lean',
    name: 'Lean',
    nodes: full.nodes.filter(node => !['tester', 'qa', 'reviewer'].includes(node.id)),
    edges: [...full.edges.filter(edge => ['start', 'scout', 'spec-writer', 'spec-approval', 'planner', 'approval'].includes(edge.from)).map(edge => (edge.from === 'approval' && edge.on === 'approved' ? { ...edge, to: 'coder' } : edge)), { from: 'coder', on: 'done', to: 'verify' }, { from: 'verify', on: 'pass', to: 'end' }],
  }
  writeFileSync(join(project.root, '.enki/workflows/lean.json'), JSON.stringify(lean))
  project.enki(['task', 'new', 'demo', '--workflow', 'lean'])
  assert.equal(JSON.parse(readFileSync(join(project.taskDir('demo'), 'workflow.json'), 'utf8')).description, undefined, 'the task’s copy has no description')
  project.specApproved()
  project.report('demo', 'planner-r1.md', fullPlan('# Plan\n\n1. [Coder] Add the toggle and its tests\n'))
  const asked = project.enki(['ask', 'planner', project.brief()])
  const envelope = envelopeOf(project, 'planner-demo', 0)
  assert.doesNotMatch(envelope, /whole team|work in parallel/)
  assert.match(envelope, /- coder \(Coder: writes code, never tests\)\. done → verify; blocked → back to the orchestrator\./)
  assert.match(envelope, /No step can write tests/)
  assert.match(envelope, /When the tests \(verify\) fail, nothing goes back to fix them/)
  assert.match(envelope, /- full \("Full"\): coder, tester, qa, tests, reviewer/, 'the others it could switch to')
  // The plan counted on tests nobody can write: it goes back to the planner, not to the user.
  assert.match(asked.out, /no step in lean can write tests, so the plan has to say "Tests: none"/)
  assert.equal(project.state('demo').run.steps.approval.status, 'idle')
  project.enki(['resume', 'planner', '--note', 'No step can write tests.'])
  project.report('demo', 'planner-r2.md', fullPlan('# Plan\n\nTests: none\n\n1. [Coder] Add the toggle\n'))
  project.enki(['ask', 'planner', project.brief()])
  assert.equal(project.state('demo').run.steps.approval.status, 'queued')
  // Tests that fail with nowhere to go: the orchestrator is told what it can and can't do.
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: readFileSync(join(project.taskDir('demo'), 'planner-r2.md'), 'utf8') }, noAutoSteps: true })
  project.enki(['team', 'start'])
  project.enki(['ask', 'coder', project.brief(), '--step', '1'])
  const failed = project.enki(['verify'])
  assert.match(failed.out, /sends failing tests nowhere, so the run waits\. You can't fix code/)
})

test('a plan that isn’t the planner’s can’t be presented or approved', () => {
  const project = started(makeProject())
  const early = project.hook('pre-tool-use', { tool_name: 'ExitPlanMode', tool_input: { plan: '# My plan' } })
  assert.match(JSON.stringify(early.json), /Nothing is waiting for approval.*never writes either itself/)
  const plan = project.planReady('# Plan\n\nAdd a button.\n')
  const edited = project.hook('pre-tool-use', { tool_name: 'ExitPlanMode', tool_input: { plan: `${plan}\nAlso rewrite the API.` } })
  assert.match(JSON.stringify(edited.json), /isn't the planner's plan as written/)
  assert.equal(project.hook('pre-tool-use', { tool_name: 'ExitPlanMode', tool_input: { plan: plan.replace(/\n/g, '\n\n') } }).json, null, 'spacing doesn’t matter')
  const result = project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: '# Something else' }, noAutoSteps: true })
  assert.match(result.json.hookSpecificOutput.additionalContext, /did NOT record this approval: This isn't the planner's plan/)
  assert.equal(project.state('demo').approved, false)
})

test('a plan approved outside the planning phase is not recorded, and the session is told', () => {
  const project = started(makeProject())
  const result = project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: '# Plan' } })
  assert.match(result.json.hookSpecificOutput.additionalContext, /did NOT record/)
  assert.equal(project.state('demo').approved, false)
})

test('an empty plan response approves nothing', () => {
  const project = started(makeProject())
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: {} })
  assert.equal(project.state('demo').approved, false)
})

test('a worker cannot approve a plan', () => {
  const project = started(makeProject())
  const plan = project.planReady('# Plan')
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan } }, { ENKI_ROLE: 'coder', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root })
  assert.equal(project.state('demo').approved, false)
})

test('the user’s changes send the plan back to the planner, before approval or after it', () => {
  const project = started(makeProject())
  project.planReady()
  assert.match(project.enki(['outcome', 'approval', 'change-plan', '--note', 'x']).err, /the user's decision/)
  assert.match(project.enki(['outcome', 'approval', 'approved', '--by', 'user']).err, /only by accepting the plan dialog/)
  assert.match(project.enki(['outcome', 'approval', 'changes', '--by', 'user', '--note', 'x']).err, /change-plan .* or enki outcome approval change-spec/, 'changes are to the plan or to the spec')
  assert.match(project.enki(['outcome', 'approval', 'change-plan', '--by', 'user']).err, /in their words/)
  const back = project.enki(['outcome', 'approval', 'change-plan', '--by', 'user', '--note', 'Keep the old URL'])
  assert.equal(back.code, 0, back.err)
  assert.match(back.out, /change-plan → planner/)
  assert.equal(project.state('demo').phase, 'planning', 'the spec stays approved')
  assert.equal(project.state('demo').specApproved, true)
  project.report('demo', 'planner-r2.md', fullPlan('# Plan, with the old URL\n'))
  assert.equal(project.enki(['ask', 'planner', project.brief()]).code, 0)
  assert.match(envelopeOf(project, 'planner-demo', -1), /The user asked for changes to the plan \(.*planner-r1\.md\): Keep the old URL\. Write the whole plan again/)
  assert.equal(project.state('demo').run.steps.approval.status, 'queued')

  // After approval, the same: the work stops, and the new plan needs its own approval.
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: readFileSync(join(project.taskDir('demo'), 'planner-r2.md'), 'utf8') }, noAutoSteps: true })
  assert.equal(project.state('demo').approved, true)
  assert.match(project.enki(['phase', 'planning']).err, /enki outcome approval change-plan/)
  assert.equal(project.enki(['outcome', 'approval', 'change-plan', '--by', 'user', '--note', 'Smaller, please']).code, 0)
  const state = project.state('demo')
  assert.equal(state.approved, false)
  assert.deepEqual(Object.entries(state.run.steps).filter(([, step]) => step.status !== 'idle').map(([id]) => id), ['planner'])
  assert.notEqual(project.enki(['phase', 'coding']).code, 0)
})

test('the spec is approved first, through the same dialog, and the user can send it back', () => {
  const project = started(makeProject())
  project.enki(['ask', 'scout', project.brief()])
  project.report('demo', 'spec-writer-r1.md', '# Spec\n\n## Goal\n\nA button.\n')
  const incomplete = project.enki(['ask', 'spec-writer', project.brief()])
  assert.match(incomplete.out, /the spec can't go to the user yet: it has no "## Acceptance criteria", "## Public interface" sections/)
  assert.match(incomplete.out, /Don't fix the spec yourself/)
  project.enki(['resume', 'spec-writer', '--note', 'Add the sections.'])
  const spec = '# Spec\n\n## Goal\n\nA button.\n\n## Acceptance criteria\n\n1. It shows.\n\n## Public interface\n\n#go\n'
  project.report('demo', 'spec-writer-r2.md', spec)
  assert.equal(project.enki(['ask', 'spec-writer', project.brief()]).code, 0)
  assert.equal(project.state('demo').phase, 'spec')
  assert.match(project.enki(['next']).out, /Spec approval: the spec waits for the user\. Present .*spec-writer-r2\.md exactly as written/)
  assert.match(JSON.stringify(project.hook('pre-tool-use', { tool_name: 'ExitPlanMode', tool_input: { plan: `${spec}\nAlso a form.` } }).json), /isn't the spec writer's spec as written/)
  assert.match(project.enki(['ask', 'planner', project.brief()]).err, /no spec|nothing has sent work/i, 'the planner waits for the approved spec')

  // The user sends it back, in their words.
  assert.match(project.enki(['outcome', 'spec-approval', 'change-spec', '--by', 'user', '--note', 'x']).err, /spec-approval changes/)
  assert.equal(project.enki(['outcome', 'spec-approval', 'changes', '--by', 'user', '--note', 'Blue, please']).code, 0)
  assert.equal(project.state('demo').phase, 'intake')
  project.report('demo', 'spec-writer-r3.md', spec.replace('A button.', 'A blue button.'))
  assert.equal(project.enki(['ask', 'spec-writer', project.brief()]).code, 0)
  assert.match(envelopeOf(project, 'spec-writer-demo', -1), /The user asked for changes to the spec \(.*spec-writer-r2\.md\): Blue, please\. Write the whole spec again/)

  const approved = project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: spec.replace('A button.', 'A blue button.') }, noAutoSteps: true })
  assert.match(approved.json.hookSpecificOutput.additionalContext, /recorded the approved spec .* saved as spec\.md/)
  const state = project.state('demo')
  assert.deepEqual([state.specApproved, state.approved, state.phase], [true, false, 'planning'])
  assert.match(readFileSync(join(project.taskDir('demo'), 'spec.md'), 'utf8'), /A blue button/)
  assert.equal(state.run.steps.planner.status, 'queued')
  assert.match(project.enki(['outcome', 'spec-approval', 'changes', '--by', 'user', '--note', 'x']).err, /already approved.*approval change-spec/)
})

test('changes to the spec at plan approval, or a plan that can’t meet it, need the spec approved again', () => {
  const project = started(makeProject())
  project.planReady()
  const back = project.enki(['outcome', 'approval', 'change-spec', '--by', 'user', '--note', 'Only on mobile'])
  assert.equal(back.code, 0, back.err)
  assert.match(back.out, /change-spec → spec-writer/)
  let state = project.state('demo')
  assert.deepEqual([state.specApproved, state.approved, state.phase], [false, false, 'intake'])
  assert.deepEqual(Object.entries(state.run.steps).filter(([, step]) => step.status !== 'idle').map(([id]) => id), ['spec-writer'])
  project.report('demo', 'spec-writer-r2.md', DEFAULT_SPEC.replace('The work.', 'The work, on mobile.'))
  project.enki(['ask', 'spec-writer', project.brief()])
  assert.match(envelopeOf(project, 'spec-writer-demo', -1), /The user asked for changes to the spec, when they saw the plan .*: Only on mobile/)
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: DEFAULT_SPEC.replace('The work.', 'The work, on mobile.') }, noAutoSteps: true })
  assert.equal(project.state('demo').specApproved, true)

  // The planner finds the new spec can't be met: back to the spec writer, never planned around.
  project.herdr.script(script => { script.report = { 'planner-demo': ['spec'] } })
  project.report('demo', 'planner-r2.md', 'Mobile has no such screen.\n')
  const cant = project.enki(['ask', 'planner', project.brief()])
  assert.match(cant.out, /spec → spec-writer/)
  assert.match(envelopeOf(project, 'planner-demo', -1), /The spec the user approved, changed since your last plan/)
  state = project.state('demo')
  assert.deepEqual([state.specApproved, state.phase], [false, 'intake'])
  project.enki(['ask', 'spec-writer', project.brief()])
  assert.match(envelopeOf(project, 'spec-writer-demo', -1), /planner can't meet the approved spec, for the reasons in .*planner-r2\.md/)
})

// Asking workers

test('ask sends a short prompt, wraps the brief and returns the summary', () => {
  const project = started(makeProject())
  const result = project.enki(['ask', 'scout', project.brief()])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /\[done\]/)
  assert.match(result.out, /summary from scout-demo/)
  const prompt = project.herdr.calls('agent', 'prompt', 'scout-demo')[0][3]
  assert.match(prompt, /^Read .*001-scout\.prompt\.md and follow it\.$/)
  assert.ok(prompt.length < 400)
  const envelope = readFileSync(prompt.slice(5, -' and follow it.'.length), 'utf8')
  assert.match(envelope, /rules\.md/)
  assert.match(envelope, /scout-r1\.md/)
  assert.match(envelope, /The user's request: .*request\.md/)
  assert.match(envelope, /at most 15 lines/)
})


test('reports are numbered by visit, and the brief lists the outcomes to report', () => {
  const project = approved(makeProject({ repos: [{ path: 'web', test: ['true'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }] }))
  project.enki(['team', 'start'])
  project.herdr.script(script => {
    script.report = { 'reviewer-demo': ['changes'] }
  })
  project.runWorkflow('demo')
  const first = envelopeOf(project, 'coder-demo', 0)
  assert.match(first, /coder-r1\.md/)
  assert.match(first, /enki report done {2}\(The brief is implemented/)
  assert.match(first, /enki report blocked/)
  const second = envelopeOf(project, 'coder-demo', 1)
  assert.match(second, /coder-r2\.md/)
  assert.match(second, /reviewer reported "changes": .*reviewer-r1\.md/, 'the coder is told what sent it back')
})

test('a loop stops at its limit, and only the user can take it further', () => {
  const project = approved(makeProject({ repos: [{ path: 'web', test: ['true'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }] }))
  project.enki(['team', 'start'])
  project.herdr.script(script => {
    script.report = { 'reviewer-demo': ['changes', 'changes', 'changes', 'changes'] }
  })
  project.runWorkflow('demo') // stops when nothing is left to start: the reviewer is with the orchestrator
  const run = project.state('demo').run
  assert.equal(run.steps.reviewer.status, 'handed-off')
  assert.match(run.steps.reviewer.reason, /^limit/)
  assert.equal(run.edges['reviewer:changes'], 3)
  assert.match(project.enki(['resume', 'reviewer']).err, /Only the user/)
  assert.match(project.enki(['outcome', 'reviewer', 'approve']).err, /the user's decision/)
  const user = project.enki(['outcome', 'reviewer', 'approve', '--by', 'user'])
  assert.equal(user.code, 0, user.err)
  assert.match(user.out, /approve → end/)
  assert.ok(project.events('demo').some(event => event.type === 'step.overridden' && event.data.by === 'user'))
})


test('workers after the plan cannot be asked before approval', () => {
  const project = started(makeProject())
  assert.match(project.enki(['ask', 'coder', project.brief()]).err, /Nothing has sent work to coder yet/)
})

test('a blocked worker returns at once with exit 3, the screen and the way to answer', () => {
  const project = started(makeProject())
  project.herdr.script(script => { script.prompt = { 'scout-demo': ['blocked'] } })
  const result = project.enki(['ask', 'scout', project.brief()])
  assert.equal(result.code, 3)
  assert.match(result.out, /Do you want to proceed/)
  assert.match(result.out, /enki answer scout <option>/)
  assert.equal(project.herdr.calls('agent', 'wait').length, 0)
  assert.equal(project.herdr.calls('agent', 'send-keys').length, 0)
})

test('a worker that blocks later is caught during the wait', () => {
  const project = started(makeProject())
  project.herdr.script(script => { script.wait = { 'scout-demo': ['blocked'] } })
  assert.equal(project.enki(['ask', 'scout', project.brief()]).code, 3)
})

test('enki wait waits through a prompt the user answers in the pane', () => {
  const project = started(makeProject())
  project.herdr.script((script, state) => {
    state.agents['scout-demo'].status = 'blocked'
    script.wait = { 'scout-demo': ['working', 'done'] }
  })
  const result = project.enki(['wait', 'scout'])
  assert.equal(result.code, 0, result.out)
  assert.match(result.out, /summary from scout-demo/)
  assert.equal(project.herdr.calls('agent', 'send-keys').length, 0)
})

test('enki wait gives up on an unanswered prompt with exit 3', () => {
  const project = started(makeProject())
  project.herdr.script((script, state) => {
    state.agents['scout-demo'].status = 'blocked'
    script.wait = { 'scout-demo': ['timeout'] }
  })
  const result = project.enki(['wait', 'scout', '--timeout', '1000'])
  assert.equal(result.code, 3)
  assert.match(result.out, /still waiting on a prompt/)
})

test('an already blocked worker gets no new prompt', () => {
  const project = started(makeProject())
  project.herdr.script((script, state) => { state.agents['scout-demo'].status = 'blocked' })
  assert.equal(project.enki(['ask', 'scout', project.brief()]).code, 3)
  assert.equal(project.herdr.calls('agent', 'prompt').length, 0)
})

test('a busy worker gets no new prompt', () => {
  const project = started(makeProject())
  project.herdr.script((script, state) => { state.agents['scout-demo'].status = 'working' })
  const result = project.enki(['ask', 'scout', project.brief()])
  assert.equal(result.code, 5)
  assert.match(result.err, /enki wait scout/)
})

test('a stalled prompt is reported and never resent', () => {
  const project = started(makeProject())
  project.herdr.script(script => { script.prompt = { 'scout-demo': ['stall'] } })
  const result = project.enki(['ask', 'scout', project.brief()])
  assert.equal(result.code, 6)
  assert.match(result.out, /Don't resend/)
  assert.equal(project.herdr.calls('agent', 'prompt').length, 1)
  assert.equal(project.herdr.calls('agent', 'send-keys').length, 0)
})

test('a prompt stuck as pasted text gets Enter once', () => {
  const project = started(makeProject())
  project.herdr.script(script => {
    script.prompt = { 'scout-demo': ['pasted'] }
    script.wait = { 'scout-demo': ['working', 'done'] }
  })
  assert.equal(project.enki(['ask', 'scout', project.brief()]).code, 0)
  assert.equal(project.herdr.calls('agent', 'send-keys', 'scout-demo', 'enter').length, 1)
  assert.equal(project.herdr.calls('agent', 'prompt').length, 1)
})

test('a timeout reports status and does not resubmit', () => {
  const project = started(makeProject())
  project.herdr.script(script => { script.wait = { 'scout-demo': ['timeout'] } })
  const result = project.enki(['ask', 'scout', project.brief()])
  assert.equal(result.code, 4)
  assert.match(result.out, /Don't resubmit/)
  assert.equal(project.herdr.calls('agent', 'prompt').length, 1)
})

test('role timeouts come from config', () => {
  const project = started(makeProject({ timeouts: { scout: 12345 } }))
  project.enki(['ask', 'scout', project.brief()])
  const call = project.herdr.calls('agent', 'wait')[0]
  assert.equal(call[call.indexOf('--timeout') + 1], '12345')
})

test('a missing brief is a usage error', () => {
  const project = started(makeProject())
  assert.equal(project.enki(['ask', 'scout', '/nope.md']).code, 2)
})

// Answering prompts

const DIALOG = `
1. Validation in the transcript
─────────────
 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp/some/very/long/path/that
      wraps/onto/the/next/line from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
`

const blocked = (project, screen = DIALOG) =>
  project.herdr.script((script, state) => {
    state.agents['scout-demo'].status = 'blocked'
    script.screen = screen
  })

test('option 1 presses Enter, and the answer goes on the record', () => {
  const project = started(makeProject())
  blocked(project)
  const result = project.enki(['answer', 'scout', '1'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Answered scout-demo: Yes\./)
  assert.deepEqual(project.herdr.calls('agent', 'send-keys')[0].slice(3), ['enter'])
  const answered = project.events('demo').find(event => event.type === 'agent.answered')
  assert.deepEqual([answered.data.label, answered.data.by], ['Yes', 'orchestrator'])
})

test('a later option moves down to it', () => {
  const project = started(makeProject())
  blocked(project)
  assert.equal(project.enki(['answer', 'scout', '4']).code, 0)
  assert.deepEqual(project.herdr.calls('agent', 'send-keys')[0].slice(3), ['down', 'down', 'down', 'enter'])
})

test('persistent grants are refused, even with the wording wrapped', () => {
  const project = started(makeProject())
  blocked(project)
  for (const option of ['2', '3']) {
    assert.match(project.enki(['answer', 'scout', option]).err, /more than this one action/)
  }
  blocked(project, ' ❯ 1. Yes\n   2. Yes, and don\'t ask\n      again for curl commands\n   3. No\n')
  assert.notEqual(project.enki(['answer', 'scout', '2']).code, 0)
  blocked(project, ' ❯ 1. Yes\n   2. Yes, allow reading from /tmp/x\n      during this session\n   3. No\n')
  assert.notEqual(project.enki(['answer', 'scout', '2']).code, 0)
  assert.equal(project.herdr.calls('agent', 'send-keys').length, 0)
})

test('No is always available, whatever follows it', () => {
  const project = started(makeProject())
  blocked(project, ' ❯ 1. Yes\n   2. No, and tell Claude what to do differently\n')
  assert.equal(project.enki(['answer', 'scout', '2']).code, 0)
})

test('--by user is recorded', () => {
  const project = started(makeProject())
  blocked(project)
  project.enki(['answer', 'scout', '1', '--by', 'user'])
  assert.equal(project.events('demo').find(event => event.type === 'agent.answered').data.by, 'user')
})

test('nothing is sent to a worker that is not blocked, or for an option it does not show', () => {
  const project = started(makeProject())
  assert.match(project.enki(['answer', 'scout', '1']).err, /isn't waiting/)
  blocked(project)
  assert.match(project.enki(['answer', 'scout', '9']).err, /no option 9/)
  assert.equal(project.enki(['answer', 'scout', 'yes']).code, 2)
  assert.match(project.enki(['answer', 'scout', 'trust']).err, /trust prompt/)
  assert.equal(project.herdr.calls('agent', 'send-keys').length, 0)
})

test('a worker cannot answer prompts', () => {
  const project = started(makeProject())
  blocked(project)
  const worker = { ENKI_ROLE: 'coder', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root }
  assert.match(project.enki(['answer', 'scout', '1'], worker).err, /Workers can't/)
})

// Startup failures

test('a trust prompt stops startup, and continues once the user agrees through the orchestrator', () => {
  const project = makeProject()
  project.herdr.script(script => {
    script.blockStart = ['scout-demo']
    script.screen = ' ❯ No, exit\n   Yes, I trust this folder\n'
  })
  const result = project.enki(['task', 'new', 'demo'])
  assert.equal(result.code, 3)
  assert.match(result.err, /Ask the user whether to trust/)
  assert.equal(project.herdr.calls('agent', 'send-keys').length, 0)

  assert.equal(project.enki(['answer', 'scout', 'trust']).code, 0)
  assert.deepEqual(project.herdr.calls('agent', 'send-keys')[0].slice(3), ['down', 'enter'])
  const answered = project.events('demo').find(event => event.type === 'agent.answered')
  assert.equal(answered.data.by, 'user')

  project.herdr.script((script, state) => { delete state.agents['scout-demo'] })
  assert.equal(project.enki(['start', 'scout']).code, 0)
  assert.ok(project.state('demo').agents.scout)
})

test('a worker whose hooks never report is treated as a failure', () => {
  const project = makeProject()
  project.herdr.script(script => { script.noHooks = true })
  const result = project.enki(['task', 'new', 'demo'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /hooks did not report/)
})

// Rounds



// Workers

test('workers can look, but cannot run the task', () => {
  const project = started(makeProject())
  const worker = { ENKI_ROLE: 'coder', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root }
  for (const args of [['phase', 'coding'], ['team', 'start'], ['next'], ['resume', 'coder'], ['outcome', 'coder', 'done', '--by', 'user'], ['ask', 'scout', 'x']]) {
    assert.match(project.enki(args, worker).err, /Workers can't/)
  }
  assert.equal(project.enki(['status'], worker).code, 0)
})

// Parallel tasks

test('two orchestrators in one project each see only their own task', () => {
  const project = makeProject({ repos: [{ path: 'web', devServer: { managedBy: 'user' } }, { path: 'api', devServer: { managedBy: 'user' } }] })
  assert.equal(project.enki(['task', 'new', 'one', '--repo', 'web'], { HERDR_PANE_ID: 'w1:a' }).code, 0)
  assert.equal(project.enki(['task', 'new', 'two', '--repo', 'api'], { HERDR_PANE_ID: 'w1:b' }).code, 0)
  assert.match(project.enki(['status'], { HERDR_PANE_ID: 'w1:a' }).out, /-one /)
  assert.match(project.enki(['status'], { HERDR_PANE_ID: 'w1:b' }).out, /-two /)
  assert.notEqual(project.enki(['status'], { HERDR_PANE_ID: 'w1:c' }).code, 0)
  project.approve('# Plan', { HERDR_PANE_ID: 'w1:a' })
  assert.equal(project.state('one').approved, true)
  assert.equal(project.state('two').approved, false)
})

test('without worktrees, a second task on the same repo is refused', () => {
  const project = makeProject()
  assert.equal(project.enki(['task', 'new', 'one'], { HERDR_PANE_ID: 'w1:a' }).code, 0)
  const second = project.enki(['task', 'new', 'two'], { HERDR_PANE_ID: 'w1:b' })
  assert.notEqual(second.code, 0)
  assert.match(second.err, /share one tree/)
})

test('the browser lock is shared across tasks', () => {
  const project = makeProject({ browser: { driver: 'chrome' }, repos: [{ path: 'web', devServer: { managedBy: 'user' } }, { path: 'api', devServer: { managedBy: 'user' } }] })
  project.enki(['task', 'new', 'one', '--repo', 'web'], { HERDR_PANE_ID: 'w1:a' })
  project.enki(['task', 'new', 'two', '--repo', 'api'], { HERDR_PANE_ID: 'w1:b' })
  assert.equal(project.enki(['browser', 'acquire'], { HERDR_PANE_ID: 'w1:a' }).code, 0)
  const second = project.enki(['browser', 'acquire'], { HERDR_PANE_ID: 'w1:b' })
  assert.equal(second.code, 5)
  assert.match(second.err, /in use by task/)
  assert.notEqual(project.enki(['browser', 'release'], { HERDR_PANE_ID: 'w1:b' }).code, 0)
  assert.equal(project.enki(['browser', 'release'], { HERDR_PANE_ID: 'w1:a' }).code, 0)
  assert.equal(project.enki(['browser', 'acquire'], { HERDR_PANE_ID: 'w1:b' }).code, 0)
})

test('a task with another browser driver needs no lock', () => {
  const project = started(makeProject({ browser: { driver: 'none' } }))
  assert.match(project.enki(['browser', 'acquire']).out, /needs no lock/)
})

// Resume

test('resume rebinds the task and reports the phase without restarting anything', () => {
  const project = approved(makeProject())
  project.enki(['team', 'start'])
  project.enki(['phase', 'coding'])
  const starts = project.herdr.calls('agent', 'start').length
  const result = project.enki(['resume', 'demo'], { HERDR_PANE_ID: 'w1:new' })
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /phase: coding/)
  assert.match(result.out, /approved-plan\.md/)
  assert.equal(project.state('demo').orchestratorPane, 'w1:new')
  assert.equal(project.herdr.calls('agent', 'start').length, starts)
  assert.equal(project.enki(['status'], { HERDR_PANE_ID: 'w1:new' }).code, 0)
})

// Event log

test('every step lands in the event log with stable IDs', () => {
  const project = approved(makeProject())
  project.enki(['team', 'start'])
  project.enki(['ask', 'coder', project.brief()])
  project.enki(['phase', 'coding'])
  const events = project.events('demo')
  const types = events.map(event => event.type)
  for (const type of ['task.created', 'team.grid_ready', 'agent.started', 'plan.approved', 'team.started', 'agent.asked', 'step.started', 'step.reported', 'agent.finished', 'step.outcome', 'task.phase']) {
    assert.ok(types.includes(type), `missing ${type}`)
  }
  for (const event of events) {
    assert.equal(event.v, 1)
    assert.equal(event.project, 'proj1')
    assert.match(event.task, /-demo$/)
  }
})

test('task new registers the project machine-wide', () => {
  const project = started(makeProject())
  const projects = JSON.parse(readFileSync(join(project.env.ENKI_HOME, 'projects.json'), 'utf8'))
  assert.equal(projects.proj1.root, project.root)
})

test('rules.md renders the repo, with no leftover placeholders', () => {
  const project = started(makeProject())
  const rules = readFileSync(join(project.taskDir('demo'), 'rules.md'), 'utf8')
  assert.match(rules, /npm test/)
  assert.match(rules, /localhost:4321/)
  assert.doesNotMatch(rules, /\{\{/)
})

test('init creates the project skeleton and is safe to rerun', () => {
  const project = makeProject()
  const fresh = join(project.base, 'fresh')
  writeFileSync(join(project.root, 'marker'), '')
  const run = () => project.enki(['init'])
  assert.match(run().out, /Already initialized|Created/)
  assert.ok(existsSync(join(project.root, '.enki/playbook.md')))
  assert.ok(!existsSync(fresh))
  assert.match(run().out, /Already initialized/)
})

test('usage errors exit 2', () => {
  const project = makeProject()
  assert.equal(project.enki(['nonsense']).code, 2)
  assert.equal(project.enki(['ask']).code, 2)
  assert.equal(project.enki(['--bogus']).code, 2)
})
