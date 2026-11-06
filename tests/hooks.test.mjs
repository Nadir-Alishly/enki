import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { makeProject } from './helpers/harness.mjs'

const decision = result => result.json?.hookSpecificOutput?.permissionDecision ?? null
const write = (path, role) => ({ tool_name: 'Write', tool_input: { file_path: path, content: 'x' }, role })
const context = result => result.json?.hookSpecificOutput?.additionalContext ?? ''

test('outside an enki project every hook stays silent', () => {
  const project = makeProject()
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'enki-plain-')))
  const options = { HERDR_PANE_ID: '' }
  for (const [name, input] of [
    ['session-start', { source: 'startup' }],
    ['pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git push' } }],
    ['pre-tool-use', { tool_name: 'Write', tool_input: { file_path: join(elsewhere, 'a') } }],
    ['post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: 'x' } }],
  ]) {
    const result = project.hook(name, input, options, elsewhere)
    assert.equal(result.code, 0)
    assert.equal(result.out, '')
  }
})

test('session start injects the orchestrator role, on every source', () => {
  const project = makeProject()
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    assert.match(context(project.hook('session-start', { source })), /orchestrator/i)
  }
})

test('the injected core prompt stays small', () => {
  const project = makeProject()
  const size = Buffer.byteLength(context(project.hook('session-start', { source: 'startup' })))
  assert.ok(size > 500, `prompt looks empty: ${size}`)
  assert.ok(size <= 6144, `prompt is ${size} bytes`)
})

test('a subfolder of the project counts as the project', () => {
  const project = makeProject()
  const result = project.hook('session-start', { source: 'startup' }, {}, join(project.root, 'web/src'))
  assert.match(context(result), /orchestrator/i)
})

test('explicit mode leaves sessions alone until a task is bound', () => {
  const project = makeProject({ mode: 'explicit' })
  assert.equal(project.hook('session-start', { source: 'startup' }).out, '')
  assert.equal(decision(project.hook('pre-tool-use', write(join(project.root, 'web/src/a.js')))), null)

  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  assert.match(context(project.hook('session-start', { source: 'clear' })), /orchestrator/i)
  assert.equal(decision(project.hook('pre-tool-use', write(join(project.root, 'web/src/a.js')))), 'deny')
})

test('after /clear the session is told to resume its bound task', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  assert.match(context(project.hook('session-start', { source: 'clear' })), /enki resume demo/)
})

test('a done task no longer binds the session', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  project.approve()
  project.enki(['phase', 'done', '--abandon'])
  assert.doesNotMatch(context(project.hook('session-start', { source: 'clear' })), /You are running task/)
})

test('workers get no orchestrator prompt, and report their hooks as live', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  const worker = { ENKI_ROLE: 'coder', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root }
  const result = project.hook('session-start', { source: 'startup' }, worker)
  assert.equal(result.out, '')
  assert.ok(project.events('demo').some(event => event.type === 'worker.hooks_ready' && event.data.role === 'coder'))
})

test('the orchestrator cannot edit project files', () => {
  const project = makeProject()
  const result = project.hook('pre-tool-use', write(join(project.root, 'web/src/a.js')))
  assert.equal(decision(result), 'deny')
  assert.match(result.json.hookSpecificOutput.permissionDecisionReason, /Delegate/)
})

test('workers are held to their role, and denials land in the event log', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  const as = role => ({ ENKI_ROLE: role, ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root })
  const source = join(project.root, 'web/src/a.js')
  assert.equal(decision(project.hook('pre-tool-use', write(source), as('scout'))), 'deny')
  assert.equal(decision(project.hook('pre-tool-use', write(source), as('tester'))), 'deny')
  assert.equal(decision(project.hook('pre-tool-use', write(join(project.root, '.enki/notes/web.md')), as('coder'))), 'deny')
  assert.equal(decision(project.hook('pre-tool-use', write(source), as('coder'))), null)
  const denials = project.events('demo').filter(event => event.type === 'policy.denied')
  assert.equal(denials.length, 3)
  assert.equal(denials[0].data.target, source)
})

test('a task created by enki gives the hook what it needs to split source from tests', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  const as = role => ({ ENKI_ROLE: role, ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root })
  const testFile = join(project.root, 'web/tests/a.test.mjs')
  assert.equal(decision(project.hook('pre-tool-use', write(testFile), as('tester'))), null)
  assert.equal(decision(project.hook('pre-tool-use', write(testFile), as('coder'))), 'deny')
})

test('default test globs reach the policy when a repo sets none', () => {
  const project = makeProject({ repos: [{ path: 'web' }] })
  project.enki(['task', 'new', 'demo'])
  const tester = { ENKI_ROLE: 'tester', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root }
  assert.equal(decision(project.hook('pre-tool-use', write(join(project.root, 'web/src/a.test.ts')), tester)), null)
})

test('default test globs cover common languages', () => {
  const project = makeProject({ repos: [{ path: 'web' }] })
  project.enki(['task', 'new', 'demo'])
  const tester = { ENKI_ROLE: 'tester', ENKI_TASK: project.taskDir('demo'), ENKI_PROJECT: project.root }
  for (const file of ['app/test_views.py', 'app/views_test.py', 'pkg/a_test.go', 'spec/a_spec.rb', 'lib/a_spec.rb', 'src/test/java/A.java', 'src/AppTest.java']) {
    assert.equal(decision(project.hook('pre-tool-use', write(join(project.root, 'web', file)), tester)), null, file)
  }
  assert.equal(decision(project.hook('pre-tool-use', write(join(project.root, 'web/app/views.py')), tester)), 'deny')
})

test('a project start command is blocked in the real hook', () => {
  const project = makeProject({ repos: [{ path: 'web', url: 'http://localhost:4321', devServer: { start: 'cargo run' } }] })
  const result = project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'cargo run' } })
  assert.equal(decision(result), 'deny')
})

test('a git push and a .env read are denied in the real hook', () => {
  const project = makeProject()
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git push' } })), 'deny')
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'cat .env' } })), 'deny')
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: join(project.root, 'web/.env') } })), 'deny')
})

test('a worker missing its task fails closed', () => {
  const project = makeProject()
  const result = project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: 'a' } }, { ENKI_ROLE: 'coder' })
  assert.equal(decision(result), 'deny')
})

test('a worker whose state file is unreadable fails closed', () => {
  const project = makeProject()
  const worker = { ENKI_ROLE: 'coder', ENKI_TASK: join(project.base, 'gone'), ENKI_PROJECT: project.root }
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: 'a' } }, worker)), 'deny')
})

test('a broken config refuses work but stays fixable', () => {
  const project = makeProject()
  const path = join(project.root, '.enki/config.json')
  writeFileSync(path, '{ broken')
  assert.match(context(project.hook('session-start', { source: 'startup' })), /invalid/)
  assert.equal(decision(project.hook('pre-tool-use', write(join(project.root, 'web/src/a.js')))), 'deny')
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: path } })), null)
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: path } })), null)
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'enki validate' } })), null)
})

test('tool_input with no path gets no objection', () => {
  const project = makeProject()
  assert.equal(decision(project.hook('pre-tool-use', { tool_name: 'Write', tool_input: {} })), null)
})

test('config validation', async () => {
  const { validateConfig, ConfigError } = await import('../src/config.mjs')
  const bad = [
    [{ mode: 'sometimes' }, /mode/],
    [{ permissionMode: 'bypassPermissions' }, /permissionMode/],
    [{ browser: { driver: 'safari' } }, /browser.driver/],
    [{ repos: [{}] }, /path/],
    [{ repos: [{ path: '../up' }] }, /relative/],
    [{ repos: [{ path: '/abs' }] }, /relative/],
    [{ repos: [{ path: 'a', url: 'https://example.com' }] }, /localhost/],
    [{ repos: [{ path: 'a' }, { path: 'a' }] }, /duplicate/],
    [{ repos: [{ path: 'a', devServer: { managedBy: 'someone' } }] }, /"enki" or "user"/],
    [{ team: { designer: {} } }, /unknown role/],
    [{ timeouts: { coder: -1 } }, /positive/],
    [{ timeouts: { lunch: 5 } }, /unknown step/],
    [{ maxFixRounds: 1.5 }, /integer/],
    [{ policy: { bash: [{ pattern: '(', reason: 'x' }] } }, /pattern/],
    [{ typo: true }, /unknown key/],
  ]
  for (const [config, message] of bad) {
    assert.throws(() => validateConfig(config), error => error instanceof ConfigError && message.test(error.message), JSON.stringify(config))
  }
  validateConfig({ mode: 'explicit', repos: [{ path: 'web', url: 'http://localhost:3000/app' }] })
})

test('a project with a real subfolder config does not leak upward', () => {
  const project = makeProject()
  const inner = join(project.base, 'other')
  mkdirSync(inner)
  assert.equal(project.hook('session-start', { source: 'startup' }, {}, inner).out, '')
})
