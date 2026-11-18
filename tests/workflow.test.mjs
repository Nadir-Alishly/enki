// The order of work, and what each role is allowed to see.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fullPlan, makeProject } from './helpers/harness.mjs'

const passing = (config = {}) =>
  makeProject({
    repos: [{ path: 'web', test: ['test -f ok.flag'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }],
    ...config,
  })

function ready(plan, config) {
  const project = passing(config)
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  project.approve(plan)
  assert.equal(project.enki(['team', 'start']).code, 0)
  project.report('demo', 'requirements.md', '# Requirements\n')
  project.report('demo', 'tests.md')
  return project
}

const flag = (project, on) => {
  const path = join(project.root, 'web/ok.flag')
  if (on) writeFileSync(path, '')
  else rmSync(path, { force: true })
}

const greenRound = project => {
  flag(project, true)
  assert.equal(project.enki(['verify']).code, 0)
}

const askErr = (project, role) => project.enki(['ask', role, project.brief()]).err

// What waits for what

const working = (project, role) => project.herdr.script((script, state) => { state.agents[`${role}-demo`].status = 'working' })

const ask = (project, step, ...extra) => project.enki(['ask', step, project.brief(), ...extra])
/** The coder and tester, the Full workflow's start steps, each reporting their first outcome. */
const writers = project => {
  assert.equal(ask(project, 'coder').code, 0)
  assert.equal(ask(project, 'tester', '--report', 'tests.md').code, 0)
}
const notSent = step => new RegExp(`nothing has sent work to ${step}`, 'i')

test('the tester and coder can start at the same time', () => {
  const project = ready()
  assert.deepEqual(project.enki(['next']).out.match(/^- (\w+): ready/gm), ['- coder: ready', '- tester: ready'])
  assert.equal(ask(project, 'coder').code, 0)
  assert.equal(ask(project, 'tester', '--report', 'tests.md').code, 0)
  assert.match(askErr(project, 'tester'), notSent('tester'), 'a step runs when the workflow sends it work, not on demand')
})

test('the team starts together, and everyone reports', () => {
  const project = ready()
  assert.deepEqual(Object.keys(project.state('demo').agents).sort(), ['coder', 'planner', 'qa', 'reviewer', 'scout', 'tester'])
})

test('a startup failure in a parallel start still stops the team start', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  project.approve()
  project.herdr.script(script => { script.blockStart = ['qa-demo'] })
  const result = project.enki(['team', 'start'])
  assert.equal(result.code, 3)
  assert.match(result.err, /qa-demo is waiting on a prompt/)
})

test('the tester and QA work from the requirements enki takes from the approved plan, not the plan', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  project.approve('# Plan\n\nThe approach: a secret.\n\n## Requirements\n\nUsers see a greeting.\n')
  project.enki(['team', 'start'])
  const requirements = readFileSync(join(project.taskDir('demo'), 'requirements.md'), 'utf8')
  assert.match(requirements, /Users see a greeting/)
  assert.doesNotMatch(requirements, /secret/)
  rmSync(join(project.taskDir('demo'), 'requirements.md'))
  assert.match(askErr(project, 'tester'), /requirements\.md/)
  project.report('demo', 'requirements.md')
  assert.equal(project.enki(['ask', 'tester', project.brief()]).code, 0)
})

test('tests are written to their own report', () => {
  const project = ready()
  project.enki(['ask', 'tester', project.brief(), '--report', 'tests.md'])
  const prompt = project.herdr.calls('agent', 'prompt', 'tester-demo')[0][3]
  assert.match(readFileSync(prompt.slice(5, -' and follow it.'.length), 'utf8'), /tests\.md/)
})

test('QA starts once the coder reports, alongside the tests rather than after them', () => {
  const project = ready()
  assert.match(askErr(project, 'qa'), notSent('qa'))
  assert.equal(ask(project, 'coder').code, 0)
  assert.match(project.enki(['verify']).err, /waits for tester/, 'the tests mean nothing while the tester is still writing them')
  assert.equal(ask(project, 'qa').code, 0)
})

test('QA runs again for each change of code', () => {
  const project = ready()
  flag(project, false)
  writers(project)
  assert.equal(ask(project, 'qa').code, 0)
  assert.equal(project.enki(['verify']).code, 1, 'the tests fail')
  assert.match(askErr(project, 'qa'), notSent('qa'))
  assert.equal(ask(project, 'coder').code, 0, 'the failure sent the coder back')
  assert.equal(project.state('demo').run.steps.qa.status, 'queued')
  assert.equal(ask(project, 'qa').code, 0)
  assert.equal(project.state('demo').run.steps.qa.visits, 2)
})

test('verify waits for the coder and tester, because a run mid-work means nothing', () => {
  const project = ready()
  flag(project, true)
  assert.equal(ask(project, 'coder').code, 0)
  const early = project.enki(['verify'])
  assert.equal(early.code, 5)
  assert.match(early.err, /waits for tester/)
  assert.equal(ask(project, 'tester', '--report', 'tests.md').code, 0)
  working(project, 'coder')
  assert.match(project.enki(['verify']).err, /coder is still working/, 'and never while anything that writes is busy')
  project.herdr.script((script, state) => { state.agents['coder-demo'].status = 'done' })
  assert.equal(project.enki(['verify']).code, 0)
})

test('a plan can opt out of writing tests', () => {
  const project = ready('# Plan\n\nTests: none\n')
  assert.equal(project.herdr.calls('agent', 'start', 'tester-demo').length, 0)
  flag(project, true)
  assert.equal(ask(project, 'coder').code, 0)
  assert.equal(project.enki(['verify']).code, 0, 'no tester to wait for')
})

test('a baseline can run before any tests exist', () => {
  const project = ready()
  rmSync(join(project.taskDir('demo'), 'tests.md'))
  assert.doesNotMatch(project.enki(['verify', '--baseline']).err, /tests\.md/)
})

test('the reviewer waits for passing tests, and only that', () => {
  const project = ready()
  assert.match(askErr(project, 'reviewer'), notSent('reviewer'))
  writers(project)
  greenRound(project)
  working(project, 'qa')
  assert.equal(ask(project, 'reviewer').code, 0, 'QA still working doesn’t hold it up')
})

test('a failing build never reaches the reviewer', () => {
  const project = ready()
  writers(project)
  project.enki(['verify'])
  assert.match(askErr(project, 'reviewer'), notSent('reviewer'))
  assert.equal(project.herdr.calls('agent', 'prompt', 'reviewer-demo').length, 0)
})

test('a change after a passing run needs a new run before review', () => {
  const project = ready()
  project.herdr.script(script => { script.report = { 'qa-demo': ['bug'] } })
  writers(project)
  greenRound(project)
  assert.equal(ask(project, 'qa').code, 0, 'QA finds a bug, which sends the coder and tester back')
  assert.match(askErr(project, 'reviewer'), /waits for coder/)
  writers(project)
  assert.match(askErr(project, 'reviewer'), /waits for verify/)
  greenRound(project)
  assert.equal(ask(project, 'reviewer').code, 0)
})

test('a baseline run does not open the gate', () => {
  const project = ready()
  flag(project, true)
  project.enki(['verify', '--baseline'])
  assert.match(askErr(project, 'reviewer'), notSent('reviewer'))
})

test('a plan can opt out of QA, which then needs no agent', () => {
  const project = ready('# Plan\n\nQA: none\n')
  assert.equal(project.herdr.calls('agent', 'start', 'qa-demo').length, 0)
  flag(project, true)
  project.runWorkflow('demo')
  assert.equal(project.enki(['phase', 'notes']).code, 0)
})

test('a task approved before workflows keeps its fixed flow', () => {
  const project = ready()
  const path = join(project.taskDir('demo'), 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  for (const key of ['tests', 'qa', 'treeSnapshot', 'run', 'workflow', 'team']) delete state[key]
  writeFileSync(path, JSON.stringify(state))
  assert.equal(project.enki(['ask', 'coder', project.brief()]).code, 0)
  assert.match(askErr(project, 'reviewer'), /wait for passing tests/)
  greenRound(project)
  assert.equal(project.enki(['ask', 'reviewer', project.brief()]).code, 0)
})

// The reviewer can't be skipped

for (const plan of ['# Plan\n\nTeam: light\n', '# Plan\n\nReviewer: none\n', '# Plan\n\nQA: none\nTests: none\n']) {
  test(`the reviewer starts whatever the plan says: ${plan.split('\n')[2]}`, () => {
    const project = ready(plan)
    assert.equal(project.herdr.calls('agent', 'start', 'reviewer-demo').length, 1)
  })
}

test('a plan that skips the reviewer never reaches the user: the workflow would end without a check', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  assert.equal(ask(project, 'scout').code, 0)
  project.report('demo', 'planner-r1.md', fullPlan('# Plan\n\nSkip: reviewer\n'))
  const result = ask(project, 'planner')
  assert.match(result.out, /the plan can't go to the user yet: .*verify: "pass" goes nowhere/)
  assert.match(result.out, /enki resume planner --note/)
  assert.equal(project.state('demo').run.steps.approval.status, 'idle')
  assert.equal(project.state('demo').run.steps.planner.status, 'handed-off')
})

test('light team options are gone', () => {
  const project = ready()
  assert.equal(project.enki(['team', 'start', '--light']).code, 2)
  assert.equal(project.enki(['team', 'add-reviewer']).code, 2)
})

for (const phase of ['notes', 'reporting', 'done']) {
  test(`a task can't reach ${phase} before its workflow ends`, () => {
    const project = ready()
    writers(project)
    greenRound(project)
    assert.equal(ask(project, 'qa').code, 0)
    const result = project.enki(['phase', phase])
    assert.notEqual(result.code, 0)
    assert.match(result.err, /the workflow to reach its end: reviewer is queued/)
    assert.notEqual(project.state('demo').phase, phase)
  })
}

test('a review before the last change does not count', () => {
  const project = ready()
  flag(project, true)
  project.herdr.script(script => { script.report = { 'qa-demo': ['bug', 'pass'] } })
  writers(project)
  greenRound(project)
  assert.equal(ask(project, 'reviewer').code, 0, 'the reviewer approves')
  assert.equal(ask(project, 'qa').code, 0, 'then QA finds a bug')
  assert.match(project.enki(['phase', 'notes']).err, /reach its end/)
  project.runWorkflow('demo')
  const { run } = project.state('demo')
  assert.equal(run.steps.reviewer.visits, 2, 'QA’s bug came after the first review, so the reviewer read the change again')
  assert.equal(project.enki(['phase', 'notes']).code, 0)
})

test('abandoning is the only way out, and it is on the record', () => {
  const project = ready()
  assert.equal(project.enki(['phase', 'done', '--abandon']).code, 0)
  const event = project.events('demo').find(item => item.type === 'task.abandoned')
  assert.ok(event.data.missing.some(item => item.includes('reach its end')))
})

test('--abandon only finishes a task', () => {
  const project = ready()
  assert.equal(project.enki(['phase', 'notes', '--abandon']).code, 2)
})

// enki verify

test('verify runs tests, lint and gate commands, and reports each', () => {
  const project = passing({ repos: [{ path: 'web', test: ['true'], lint: ['true'], gate: { commands: ['true'] } }] })
  project.enki(['task', 'new', 'demo'])
  const result = project.enki(['verify', '--baseline'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /\[passed\]/)
  assert.equal(result.out.match(/ok {3}web/g).length, 3)
  assert.ok(project.events('demo').some(event => event.type === 'verify.finished' && event.data.passed))
})

test('a failure shows the output, and the full log is kept', () => {
  const project = passing({ repos: [{ path: 'web', test: ['echo broken thing; exit 3'] }] })
  project.enki(['task', 'new', 'demo'])
  const result = project.enki(['verify', '--baseline'])
  assert.equal(result.code, 1)
  assert.match(result.out, /\[failed\]/)
  assert.match(result.out, /broken thing/)
  assert.match(readFileSync(join(project.taskDir('demo'), 'verify-baseline-web.log'), 'utf8'), /broken thing/)
})

test('a hung test is killed at the limit and counts as failed', () => {
  const project = passing({ repos: [{ path: 'web', test: ['sleep 30'] }] })
  project.enki(['task', 'new', 'demo'])
  const started = Date.now()
  assert.equal(project.enki(['verify', '--baseline', '--timeout', '300']).code, 1)
  assert.ok(Date.now() - started < 5000)
})

test('nothing to run still passes, and says so', () => {
  const project = passing({ repos: [{ path: 'web' }] })
  project.enki(['task', 'new', 'demo'])
  const result = project.enki(['verify', '--baseline'])
  assert.equal(result.code, 0)
  assert.match(result.out, /nothing to run/)
})

test('known failures are accepted only if the baseline failed too', () => {
  const project = ready()
  project.enki(['verify', '--baseline'])
  writers(project)
  assert.equal(project.enki(['verify', '--known-failures']).code, 0)
  assert.match(project.enki(['status']).out, /Tests since the last change: accepted/)
  assert.equal(project.enki(['ask', 'reviewer', project.brief()]).code, 0)
})

test('new failures cannot be waved through', () => {
  const project = ready()
  flag(project, true)
  project.enki(['verify', '--baseline'])
  flag(project, false)
  writers(project)
  const result = project.enki(['verify', '--known-failures'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /failures are new/)
  assert.match(askErr(project, 'reviewer'), notSent('reviewer'))
})

test('workers cannot verify', () => {
  const project = ready()
  assert.match(project.enki(['verify'], project.asWorker('tester')).err, /Workers can't/)
})

// What the tester and QA can see

function blindProject() {
  const project = passing()
  mkdirSync(join(project.root, 'web/tests'))
  project.write(join(project.root, 'web/src/old.js'), 'old\n')
  project.write(join(project.root, 'web/src/users.js'), 'mine\n')
  project.write(join(project.root, '.gitignore'), '.enki/tasks/\nnode_modules\n')
  project.git('init', '-q')
  project.git('add', '-A')
  project.git('commit', '-qm', 'init')
  project.write(join(project.root, 'web/src/users.js'), 'mine, uncommitted\n') // The user's own work.
  project.enki(['task', 'new', 'demo'])
  project.approve()
  project.enki(['team', 'start'])
  project.report('demo', 'requirements.md')
  project.report('demo', 'tests.md')
  // The coder's round.
  project.write(join(project.root, 'web/src/old.js'), 'changed\n')
  project.write(join(project.root, 'web/src/new.js'), 'created\n')
  project.write(join(project.root, 'web/tests/new.test.js'), 'test\n')
  return project
}

const decision = result => result.json?.hookSpecificOutput?.permissionDecision ?? null
const read = (project, role, path) => decision(project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: path } }, project.asWorker(role)))
const bash = (project, role, command) => decision(project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command } }, project.asWorker(role), join(project.root, 'web')))
const grep = (project, role, path) => decision(project.hook('pre-tool-use', { tool_name: 'Grep', tool_input: { pattern: 'x', path } }, project.asWorker(role), join(project.root, 'web')))

test('the user\'s own changes count once the coder touches them', () => {
  const project = blindProject()
  const path = join(project.root, 'web/src/users.js')
  assert.equal(read(project, 'tester', path), null)
  project.write(path, 'the coder changed this too\n')
  assert.equal(read(project, 'tester', path), 'deny')
})

test('a change is hidden the moment it lands, with the tester already running', () => {
  const project = blindProject()
  const path = join(project.root, 'web/src/brand-new.js')
  project.write(path, 'just written\n')
  assert.equal(read(project, 'tester', path), 'deny')
  assert.equal(bash(project, 'qa', 'cat src/brand-new.js'), 'deny')
})

for (const role of ['tester', 'qa']) {
  test(`${role}: changed source is hidden from every tool`, () => {
    const project = blindProject()
    for (const file of ['web/src/old.js', 'web/src/new.js']) assert.equal(read(project, role, join(project.root, file)), 'deny', file)
    for (const command of ['cat src/old.js', 'head -5 src/new.js', 'sed -n 1,5p src/old.js', 'git diff', 'git diff --stat', 'git show HEAD', 'git log -p', 'git blame src/old.js', 'grep -rn foo src', 'grep -R foo .', 'rg foo']) {
      assert.equal(bash(project, role, command), 'deny', command)
    }
    assert.equal(grep(project, role, join(project.root, 'web/src')), 'deny')
    assert.equal(grep(project, role, join(project.root, 'web/src/old.js')), 'deny')
  })

  test(`${role}: what the coder didn't touch stays readable`, () => {
    const project = blindProject()
    assert.equal(read(project, role, join(project.root, 'web/src/users.js')), null)
    assert.equal(read(project, role, join(project.root, 'web/tests/new.test.js')), null)
    assert.equal(grep(project, role, join(project.root, 'web/tests')), null)
    for (const command of ['cat tests/new.test.js', 'git status', 'npm test', 'ls src']) assert.equal(bash(project, role, command), null, command)
  })

  test(`${role}: the plan and other agents' reports are hidden, and requirements are not`, () => {
    const project = blindProject()
    const task = project.taskDir('demo')
    for (const file of ['approved-plan.md', 'plan.md', 'planner-r1.md', 'scout-r1.md', 'coder-r1.md', 'reviewer-r1.md', 'role-coder.md', 'briefs/003-coder.prompt.md', 'briefs/coder-1.md']) {
      assert.equal(read(project, role, join(task, file)), 'deny', file)
    }
    assert.equal(bash(project, role, `cat ${join(task, 'coder-r1.md')}`), 'deny')
    for (const file of ['requirements.md', 'request.md', 'rules.md', 'briefs/001-tester.prompt.md']) {
      assert.equal(read(project, role, join(task, file)), null, file)
    }
  })
}

test('other roles can see everything', () => {
  const project = blindProject()
  for (const role of ['coder', 'reviewer', 'scout']) {
    assert.equal(read(project, role, join(project.root, 'web/src/new.js')), null)
    assert.equal(bash(project, role, 'git diff'), null)
    assert.equal(read(project, role, join(project.taskDir('demo'), 'approved-plan.md')), null)
  }
})

test('before any code exists, the tester can search freely', () => {
  const project = passing()
  project.git('init', '-q')
  project.enki(['task', 'new', 'demo'])
  project.approve()
  project.enki(['team', 'start'])
  assert.equal(bash(project, 'tester', 'grep -rn foo src'), null)
  assert.equal(bash(project, 'tester', 'git diff'), null)
})

test('in a folder that is not a git repo, nothing breaks', () => {
  const project = ready()
  assert.equal(project.enki(['ask', 'tester', project.brief()]).code, 0)
  assert.equal(read(project, 'tester', join(project.root, 'web/src/a.js')), null)
})

// What each role can write

const write = (project, role, path) => decision(project.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: path, content: 'x' } }, project.asWorker(role)))

test('QA changes nothing except its own evidence', () => {
  const project = ready()
  const task = project.taskDir('demo')
  assert.equal(write(project, 'qa', join(project.root, 'web/src/a.js')), 'deny')
  assert.equal(write(project, 'qa', join(project.root, 'web/tests/a.test.js')), 'deny')
  assert.equal(write(project, 'qa', join(task, 'tester-r1.md')), 'deny')
  assert.equal(write(project, 'qa', join(task, 'qa-r1.md')), null)
  assert.equal(write(project, 'qa', join(task, 'qa-r1-shots/a.png')), null)
})

test('the tester owns its test report', () => {
  const project = ready()
  assert.equal(write(project, 'tester', join(project.taskDir('demo'), 'tests.md')), null)
  assert.equal(write(project, 'coder', join(project.taskDir('demo'), 'tests.md')), 'deny')
})

test('nobody but the orchestrator can write requirements', () => {
  const project = ready()
  for (const role of ['tester', 'qa', 'coder', 'reviewer', 'scout', 'planner']) {
    assert.equal(write(project, role, join(project.taskDir('demo'), 'requirements.md')), 'deny', role)
  }
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: join(project.taskDir('demo'), 'requirements.md') } })), null)
})

test('only QA gets the browser lock', () => {
  const project = ready()
  assert.match(project.enki(['browser', 'acquire'], project.asWorker('tester')).err, /Workers can't/)
  assert.equal(project.enki(['browser', 'acquire'], project.asWorker('qa')).code, 0)
})

// The grid

test('the Full team makes three columns of two, in the workflow’s order', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  const { panes } = project.state('demo').herdr
  const rect = role => project.herdr.read().panes[panes[role]].rect
  for (const [top, below] of [['scout', 'planner'], ['coder', 'tester'], ['qa', 'reviewer']]) {
    assert.equal(rect(top).x, rect(below).x, `${below} under ${top}`)
    assert.ok(rect(below).y > rect(top).y)
  }
  assert.ok(rect('scout').x < rect('coder').x && rect('coder').x < rect('qa').x)
})

test('a workflow with an odd number of agents leaves the last column whole', () => {
  const project = passing({ workflow: 'quick-fix' })
  project.enki(['task', 'new', 'demo'])
  const { panes } = project.state('demo').herdr
  assert.deepEqual(Object.keys(panes).sort(), ['coder', 'planner', 'reviewer'])
  const rect = role => project.herdr.read().panes[panes[role]].rect
  assert.equal(rect('planner').x, rect('coder').x)
  assert.ok(rect('reviewer').x > rect('planner').x)
  assert.equal(rect('reviewer').height, rect('planner').height * 2)
})

test('a plan step the tests own moves with the test run: active, failed, then done', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  project.approve('# Plan\n\n1. [Tester] Write tests\n2. [Coder] Implement\n3. [verify] Run the tests\n4. [Orchestrator] Report\n')
  project.enki(['team', 'start'])
  project.report('demo', 'requirements.md', '# Requirements\n')
  const step3 = () => project.state('demo').steps.find(step => step.n === 3).status
  assert.equal(ask(project, 'coder', '--step', '2').code, 0)
  assert.equal(ask(project, 'tester', '--step', '1', '--report', 'tests.md').code, 0)
  assert.equal(step3(), 'todo')
  flag(project, false)
  assert.equal(project.enki(['verify']).code, 1)
  assert.equal(step3(), 'failed')
  assert.equal(ask(project, 'coder', '--step', '2').code, 0)
  assert.equal(ask(project, 'tester', '--step', '1', '--report', 'tests.md').code, 0)
  flag(project, true)
  assert.equal(project.enki(['verify']).code, 0)
  assert.equal(step3(), 'done')
  assert.ok(project.events('demo').some(event => event.type === 'step.status' && event.data.n === 3 && event.data.by === 'verify'))
})

test('one visit does all of an agent’s plan steps, and a blocked visit leaves them failed', () => {
  const plan = '# Plan\n\n1. [Coder] Server\n2. [Coder] Client\n3. [Tester] Tests\n4. [Orchestrator] Report\n'
  const started = outcome => {
    const project = passing()
    project.enki(['task', 'new', 'demo'])
    project.approve(plan)
    project.enki(['team', 'start'])
    project.report('demo', 'requirements.md', '# Requirements\n')
    if (outcome) project.herdr.script(script => { script.report = { 'coder-demo': [outcome] } })
    return project
  }
  const status = (project, n) => project.state('demo').steps.find(step => step.n === n).status
  const going = started()
  assert.match(ask(going, 'coder', '--step', '1,3').err, /Step 3 belongs to the tester/, 'every step must be its own')
  assert.equal(status(going, 1), 'todo', 'and nothing starts when one isn’t')
  assert.equal(ask(going, 'coder', '--step', '1,2').code, 0)
  assert.deepEqual([1, 2, 3].map(n => status(going, n)), ['done', 'done', 'todo'], 'a visit that goes on finishes all its steps')
  const stuck = started('blocked')
  ask(stuck, 'coder', '--step', '1,2')
  assert.deepEqual([1, 2].map(n => status(stuck, n)), ['failed', 'failed'], 'blocked: the work isn’t done')
})
