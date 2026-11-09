// The order of work, and what each role is allowed to see.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { makeProject } from './helpers/harness.mjs'

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

test('the tester and coder can start at the same time', () => {
  const project = ready()
  assert.equal(project.enki(['ask', 'coder', project.brief()]).code, 0)
  assert.equal(project.enki(['ask', 'tester', project.brief(), '--report', 'tests.md']).code, 0)
  working(project, 'coder')
  project.herdr.script((script, state) => { state.agents['tester-demo'].status = 'done' })
  assert.equal(project.enki(['ask', 'tester', project.brief()]).code, 0)
})

test('the team starts together, and everyone reports', () => {
  const project = ready()
  assert.deepEqual(Object.keys(project.state('demo').agents).sort(), ['coder', 'qa', 'reviewer', 'scout', 'tester'])
})

test('a startup failure in a parallel start still stops the team start', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  project.approve()
  project.herdr.script(script => { script.blockStart = ['qa-demo'] })
  const result = project.enki(['team', 'start'])
  assert.equal(result.code, 3)
  assert.match(result.err, /qa-demo is blocked/)
})

test('the tester and QA need requirements, not the plan', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  project.approve()
  project.enki(['team', 'start'])
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

test('QA needs the coder finished, but not the tester or the test run', () => {
  const project = ready()
  assert.match(askErr(project, 'qa'), /hasn't reported/)
  working(project, 'coder')
  assert.match(askErr(project, 'qa'), /still working/)
  project.herdr.script((script, state) => { state.agents['coder-demo'].status = 'done' })
  project.report('demo', 'coder-r1.md')
  working(project, 'tester')
  assert.equal(project.enki(['ask', 'qa', project.brief()]).code, 0)
  assert.equal(project.state('demo').verify, null)
})

test('QA reruns for each round of code', () => {
  const project = ready()
  project.report('demo', 'coder-r1.md')
  project.enki(['round', 'next'])
  assert.match(askErr(project, 'qa'), /round 2/)
})

test('verify waits for the coder and tester, because a run mid-work means nothing', () => {
  const project = ready()
  flag(project, true)
  for (const role of ['coder', 'tester']) {
    working(project, role)
    const result = project.enki(['verify'])
    assert.equal(result.code, 5)
    assert.match(result.err, new RegExp(`${role} is still working`))
    project.herdr.script((script, state) => { state.agents[`${role}-demo`].status = 'done' })
  }
  assert.equal(project.enki(['verify']).code, 0)
})

test('verify waits for the tester to have reported', () => {
  const project = ready()
  rmSync(join(project.taskDir('demo'), 'tests.md'))
  flag(project, true)
  assert.match(project.enki(['verify']).err, /tests\.md/)
})

test('a plan can opt out of writing tests', () => {
  const project = ready('# Plan\n\nTests: none\n')
  rmSync(join(project.taskDir('demo'), 'tests.md'))
  flag(project, true)
  assert.equal(project.enki(['verify']).code, 0)
})

test('a baseline can run before any tests exist', () => {
  const project = ready()
  rmSync(join(project.taskDir('demo'), 'tests.md'))
  assert.doesNotMatch(project.enki(['verify', '--baseline']).err, /tests\.md/)
})

test('the reviewer waits for passing tests, and only that', () => {
  const project = ready()
  assert.match(askErr(project, 'reviewer'), /wait for passing tests/)
  greenRound(project)
  working(project, 'qa')
  assert.equal(project.enki(['ask', 'reviewer', project.brief()]).code, 0)
})

test('a failing build never reaches the reviewer', () => {
  const project = ready()
  project.enki(['verify'])
  assert.match(askErr(project, 'reviewer'), /tests failed/)
  assert.equal(project.herdr.calls('agent', 'prompt', 'reviewer-demo').length, 0)
})

for (const role of ['coder', 'tester']) {
  test(`new ${role} work clears the test result`, () => {
    const project = ready()
    greenRound(project)
    project.enki(['ask', role, project.brief()])
    assert.match(askErr(project, 'reviewer'), /wait for passing tests/)
  })
}

test('a new round needs a new test run', () => {
  const project = ready()
  greenRound(project)
  project.enki(['round', 'next'])
  assert.match(askErr(project, 'reviewer'), /round 2/)
  greenRound(project)
  assert.equal(project.enki(['ask', 'reviewer', project.brief()]).code, 0)
})

test('a baseline run does not open the gate', () => {
  const project = ready()
  flag(project, true)
  project.enki(['verify', '--baseline'])
  assert.match(askErr(project, 'reviewer'), /wait for passing tests/)
})

test('a plan can opt out of QA, which then needs no agent', () => {
  const project = ready('# Plan\n\nQA: none\n')
  assert.equal(project.herdr.calls('agent', 'start', 'qa-demo').length, 0)
  greenRound(project)
  project.report('demo', 'reviewer-r1.md')
  assert.equal(project.enki(['phase', 'notes']).code, 0)
})

test('a task started before this workflow keeps working', () => {
  const project = ready()
  const path = join(project.taskDir('demo'), 'state.json')
  const state = JSON.parse(readFileSync(path, 'utf8'))
  delete state.tests
  delete state.qa
  delete state.treeSnapshot
  writeFileSync(path, JSON.stringify(state))
  assert.equal(project.enki(['ask', 'coder', project.brief()]).code, 0)
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

test('light team options are gone', () => {
  const project = ready()
  assert.equal(project.enki(['team', 'start', '--light']).code, 2)
  assert.equal(project.enki(['team', 'add-reviewer']).code, 2)
})

for (const phase of ['notes', 'reporting', 'done']) {
  test(`a task can't reach ${phase} without a review`, () => {
    const project = ready()
    greenRound(project)
    project.report('demo', 'qa-r1.md')
    const result = project.enki(['phase', phase])
    assert.notEqual(result.code, 0)
    assert.match(result.err, /a reviewer report for round 1/)
    assert.notEqual(project.state('demo').phase, phase)
  })
}

test('finishing needs tests, QA and review for the same round', () => {
  const project = ready()
  const missing = () => project.enki(['phase', 'notes']).err
  assert.match(missing(), /passing tests.*QA report.*reviewer report/)
  greenRound(project)
  assert.doesNotMatch(missing(), /passing tests/)
  project.report('demo', 'qa-r1.md')
  assert.doesNotMatch(missing(), /QA report/)
  project.report('demo', 'reviewer-r1.md')
  assert.equal(project.enki(['phase', 'notes']).code, 0)
})

test('a review from an earlier round does not count', () => {
  const project = ready()
  project.report('demo', 'qa-r1.md')
  project.report('demo', 'reviewer-r1.md')
  project.enki(['round', 'next'])
  greenRound(project)
  project.report('demo', 'qa-r2.md')
  assert.match(project.enki(['phase', 'notes']).err, /reviewer report for round 2/)
})

test('abandoning is the only way out, and it is on the record', () => {
  const project = ready()
  assert.equal(project.enki(['phase', 'done', '--abandon']).code, 0)
  const event = project.events('demo').find(item => item.type === 'task.abandoned')
  assert.ok(event.data.missing.some(item => item.includes('reviewer')))
})

test('--abandon only finishes a task', () => {
  const project = ready()
  assert.equal(project.enki(['phase', 'notes', '--abandon']).code, 2)
})

// enki verify

test('verify runs tests, lint and gate commands, and reports each', () => {
  const project = passing({ repos: [{ path: 'web', test: ['true'], lint: ['true'], gate: { commands: ['true'] } }] })
  project.enki(['task', 'new', 'demo'])
  const result = project.enki(['verify'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /\[passed\]/)
  assert.equal(result.out.match(/ok {3}web/g).length, 3)
  assert.ok(project.events('demo').some(event => event.type === 'verify.finished' && event.data.passed))
})

test('a failure shows the output, and the full log is kept', () => {
  const project = passing({ repos: [{ path: 'web', test: ['echo broken thing; exit 3'] }] })
  project.enki(['task', 'new', 'demo'])
  const result = project.enki(['verify'])
  assert.equal(result.code, 1)
  assert.match(result.out, /\[failed\]/)
  assert.match(result.out, /broken thing/)
  assert.match(readFileSync(join(project.taskDir('demo'), 'verify-r1-web.log'), 'utf8'), /broken thing/)
})

test('a hung test is killed at the limit and counts as failed', () => {
  const project = passing({ repos: [{ path: 'web', test: ['sleep 30'] }] })
  project.enki(['task', 'new', 'demo'])
  const started = Date.now()
  assert.equal(project.enki(['verify', '--timeout', '300']).code, 1)
  assert.ok(Date.now() - started < 5000)
})

test('nothing to run still passes, and says so', () => {
  const project = passing({ repos: [{ path: 'web' }] })
  project.enki(['task', 'new', 'demo'])
  const result = project.enki(['verify'])
  assert.equal(result.code, 0)
  assert.match(result.out, /nothing to run/)
})

test('known failures are accepted only if the baseline failed too', () => {
  const project = ready()
  project.enki(['verify', '--baseline'])
  assert.equal(project.enki(['verify', '--known-failures']).code, 0)
  assert.match(project.enki(['status']).out, /Tests this round: accepted/)
  assert.equal(project.enki(['ask', 'reviewer', project.brief()]).code, 0)
})

test('new failures cannot be waved through', () => {
  const project = ready()
  flag(project, true)
  project.enki(['verify', '--baseline'])
  flag(project, false)
  const result = project.enki(['verify', '--known-failures'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /failures are new/)
  assert.match(askErr(project, 'reviewer'), /wait for passing tests/)
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
    for (const file of ['approved-plan.md', 'plan.md', 'coder-r1.md', 'reviewer-r1.md', 'role-coder.md', 'briefs/003-coder.prompt.md', 'briefs/coder-1.md']) {
      assert.equal(read(project, role, join(task, file)), 'deny', file)
    }
    assert.equal(bash(project, role, `cat ${join(task, 'coder-r1.md')}`), 'deny')
    for (const file of ['requirements.md', 'rules.md', 'scout.md', 'briefs/001-tester.prompt.md']) {
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
  for (const role of ['tester', 'qa', 'coder', 'reviewer', 'scout']) {
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

test('five panes make three columns, with a full-height reviewer', () => {
  const project = passing()
  project.enki(['task', 'new', 'demo'])
  const { panes } = project.state('demo').herdr
  const rect = role => project.herdr.read().panes[panes[role]].rect
  assert.equal(rect('scout').x, rect('coder').x)
  assert.equal(rect('tester').x, rect('qa').x)
  assert.ok(rect('tester').x > rect('scout').x && rect('reviewer').x > rect('tester').x)
  assert.equal(rect('reviewer').height, rect('scout').height * 2)
})
