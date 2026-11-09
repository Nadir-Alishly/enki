import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { makeProject } from './helpers/harness.mjs'

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

const launch = (project, name) => project.herdr.calls('agent', 'start', name)[0]

test('task new creates state, a verified grid and a running scout, and nothing else', () => {
  const project = started(makeProject())
  const state = project.state('demo')
  assert.equal(state.phase, 'intake')
  assert.equal(state.approved, false)
  assert.equal(state.orchestratorPane, 'w1:orch')
  assert.deepEqual(state.repos[0], { name: 'web', workdir: join(project.root, 'web'), url: 'http://localhost:4321', port: 4321, testGlobs: ['tests/**'] })
  assert.deepEqual(Object.keys(state.herdr.panes).sort(), ['coder', 'qa', 'reviewer', 'scout', 'tester'])
  assert.deepEqual(Object.keys(state.agents), ['scout'])
  assert.ok(existsSync(join(project.taskDir('demo'), 'rules.md')))
  assert.equal(project.herdr.calls('agent', 'start').length, 1)
})

test('each pane knows its role and task', () => {
  const project = started(makeProject())
  const { panes } = project.state('demo').herdr
  const fake = project.herdr.read().panes
  for (const role of ['scout', 'coder', 'tester', 'qa', 'reviewer']) {
    assert.equal(fake[panes[role]].env.ENKI_ROLE, role)
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
  const project = started(makeProject({ permissionMode: 'acceptEdits', team: { scout: { model: 'custom-model' } } }))
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
  assert.match(result.err, /three-column grid/)
})

// The approval gate

test('the team cannot start before approval', () => {
  const project = started(makeProject())
  const result = project.enki(['team', 'start'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /isn't approved/)
  assert.equal(project.herdr.calls('agent', 'start').length, 1)
})

test('a role cannot be started around the gate', () => {
  const project = started(makeProject())
  assert.match(project.enki(['start', 'coder']).err, /before the plan is approved/)
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

test('planning cannot begin before the scout has reported', () => {
  const project = started(makeProject())
  const result = project.enki(['phase', 'planning'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /no scout report/)
  assert.equal(project.state('demo').phase, 'intake')
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
  project.approve('# Plan', { ENKI_ROLE: 'coder', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root })
  assert.equal(project.state('demo').approved, false)
})

test('returning to planning withdraws approval', () => {
  const project = approved(makeProject())
  assert.equal(project.enki(['phase', 'planning']).code, 0)
  assert.equal(project.state('demo').approved, false)
  assert.notEqual(project.enki(['phase', 'coding']).code, 0)
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
  assert.match(envelope, /scout\.md/)
  assert.match(envelope, /at most 15 lines/)
})

test('reports are numbered by round', () => {
  const project = approved(makeProject())
  project.enki(['team', 'start'])
  project.enki(['round', 'next'])
  project.enki(['ask', 'coder', project.brief()])
  const prompt = project.herdr.calls('agent', 'prompt', 'coder-demo')[0][3]
  assert.match(readFileSync(prompt.slice(5, -' and follow it.'.length), 'utf8'), /coder-r2\.md/)
})

test('workers other than the scout cannot be asked before approval', () => {
  const project = started(makeProject())
  assert.match(project.enki(['ask', 'coder', project.brief()]).err, /approved/)
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
  assert.match(result.out, /still blocked/)
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

test('fix rounds stop at the limit', () => {
  const project = approved(makeProject())
  for (const expected of [2, 3, 4]) assert.match(project.enki(['round', 'next']).out, new RegExp(`Round: ${expected}`))
  const result = project.enki(['round', 'next'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /limit reached/)
  assert.equal(project.state('demo').round, 4)
})

test('maxFixRounds is configurable', () => {
  const project = approved(makeProject({ maxFixRounds: 1 }))
  assert.equal(project.enki(['round', 'next']).code, 0)
  assert.notEqual(project.enki(['round', 'next']).code, 0)
})

// Workers

test('workers can look, but cannot run the task', () => {
  const project = started(makeProject())
  const worker = { ENKI_ROLE: 'coder', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root }
  for (const args of [['phase', 'coding'], ['team', 'start'], ['round', 'next'], ['ask', 'scout', 'x']]) {
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
  project.enki(['round', 'next'])
  const events = project.events('demo')
  const types = events.map(event => event.type)
  for (const type of ['task.created', 'team.grid_ready', 'agent.started', 'plan.approved', 'team.started', 'agent.asked', 'agent.finished', 'task.phase', 'task.round']) {
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
