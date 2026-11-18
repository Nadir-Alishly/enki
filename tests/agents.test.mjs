// Agents as data: what an agent.json may say, where agents come from, and the policy following them.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { decide } from '../src/policy.mjs'
import { agentWarnings, builtinRoles, loadRoles, roleProblems, snapshotTeam, stepCapabilities, teamEntry, teamOf } from '../src/agents.mjs'

const good = { id: 'docs', name: 'Docs writer', capabilities: { write: 'none' }, outcomes: [{ id: 'done' }] }

/** An agent folder: agent.json and AGENT.md, or with `old`, the names from before the rename. */
function writeRole(dir, meta, skill = '---\nname: x\ndescription: An agent\n---\n\n# Agent\n\nDo the thing.\n', { old = false } = {}) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, old ? 'role.json' : 'agent.json'), JSON.stringify(meta))
  writeFileSync(join(dir, old ? 'SKILL.md' : 'AGENT.md'), skill)
}

test('enki’s own roles load, with the capabilities today’s policy had, and a planner that writes nothing but the plan', () => {
  const roles = builtinRoles()
  assert.deepEqual([...roles.keys()].sort(), ['coder', 'planner', 'qa', 'reviewer', 'scout', 'tester'])
  const caps = id => roles.get(id).capabilities
  assert.deepEqual([caps('scout').write, caps('planner').write, caps('coder').write, caps('tester').write, caps('qa').write, caps('reviewer').write], ['none', 'none', 'code', 'tests', 'none', 'none'])
  assert.deepEqual([...roles.values()].filter(role => role.capabilities.plans).map(role => role.id), ['planner'])
  assert.deepEqual(roles.get('planner').outcomes.map(outcome => outcome.id), ['ready', 'questions'])
  assert.deepEqual([...roles.values()].filter(role => role.capabilities.blind).map(role => role.id).sort(), ['qa', 'tester'])
  assert.equal(caps('qa').browser && caps('qa').server, true)
  assert.deepEqual(roles.get('reviewer').outcomes.map(outcome => outcome.id), ['approve', 'changes'])
})

test('a role.json is checked: ids, capabilities, outcomes and the rest', () => {
  assert.deepEqual(roleProblems(good), [])
  const bad = [
    [{ ...good, id: 'Docs' }, /^id:/],
    [{ ...good, id: 'end' }, /reserved/],
    [{ ...good, capabilities: { write: 'everything' } }, /capabilities\.write/],
    [{ ...good, capabilities: { write: 'none', root: true } }, /unknown key "root"/],
    [{ ...good, capabilities: { write: 'code', plans: true } }, /a role that plans writes nothing but its plan/],
    [{ ...good, id: 'approval' }, /reserved/],
    [{ ...good, outcomes: [] }, /at least one/],
    [{ ...good, outcomes: [{ id: 'timeout' }] }, /enki's own/],
    [{ ...good, outcomes: [{ id: 'done' }, { id: 'done' }] }, /declared twice/],
    [{ ...good, effort: 'huge' }, /^effort/],
    [{ ...good, type: 'designer' }, /^type/],
    [{ ...good, extra: 1 }, /unknown key "extra"/],
  ]
  for (const [raw, pattern] of bad) assert.ok(roleProblems(raw).some(problem => pattern.test(problem)), JSON.stringify(raw))
})

test('agents come from enki and the library, never a project; enki’s own can’t be replaced, and a broken one is reported', t => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'enki-agents-')))
  const before = process.env.ENKI_HOME
  process.env.ENKI_HOME = join(base, 'home')
  t.after(() => (before === undefined ? delete process.env.ENKI_HOME : (process.env.ENKI_HOME = before)))
  const root = join(base, 'project')
  const library = join(base, 'home', 'library')
  writeRole(join(library, 'roles', 'docs'), { ...good, name: 'Old docs' }, undefined, { old: true })
  writeRole(join(library, 'agents', 'docs'), { ...good, name: 'Docs writer' })
  writeRole(join(library, 'roles', 'legacy'), { ...good, id: 'legacy', name: 'Legacy' }, undefined, { old: true })
  writeRole(join(library, 'agents', 'coder'), { ...good, id: 'coder', name: 'Our coder', capabilities: { write: 'all' } })
  writeRole(join(library, 'agents', 'broken'), { ...good, id: 'broken', capabilities: {} })
  writeRole(join(library, 'agents', 'renamed'), { ...good, id: 'other' })
  writeRole(join(root, '.enki', 'roles', 'mine'), { ...good, id: 'mine', name: 'Project only' })
  const problems = []
  const roles = loadRoles(root, { problems })
  assert.equal(roles.get('docs').name, 'Docs writer', 'the agents folder wins over the one from before the rename')
  assert.equal(roles.get('legacy').source, 'library', 'old library folders still load')
  assert.equal(roles.get('coder').source, 'builtin', 'enki’s own coder stays')
  assert.ok(problems.some(problem => /"coder" is one of enki's own agents, which can't be replaced/.test(problem)))
  assert.equal(roles.has('mine'), false, 'a project’s own folder isn’t read')
  assert.equal(roles.has('broken'), false)
  assert.ok(problems.some(problem => /doesn't match its folder/.test(problem)))
})

test('risky capabilities are warned about, not refused', () => {
  assert.deepEqual(agentWarnings({ ...good, outcomes: [{ id: 'done', description: 'Done' }] }), [])
  assert.match(agentWarnings({ ...good, capabilities: { write: 'none', browser: true } }).join(' '), /browser but can't start the dev server/)
  assert.match(agentWarnings({ ...good, capabilities: { write: 'code', blind: true } }).join(' '), /blind but writes code/)
  assert.match(agentWarnings(good).join(' '), /an outcome has no description/)
  assert.deepEqual(roleProblems({ ...good, capabilities: { write: 'none', browser: true } }), [], 'a warning, not a problem')
})

test('a task keeps its own copy of each step’s instructions', () => {
  const taskDir = realpathSync(mkdtempSync(join(tmpdir(), 'enki-team-')))
  const team = snapshotTeam(taskDir, { coder: teamEntry(builtinRoles().get('coder')) })
  assert.equal(team.coder.skillPath, join(taskDir, 'team', 'coder.md'))
  assert.match(readFileSync(team.coder.skillPath, 'utf8'), /Enki coder/)
  assert.deepEqual(teamOf({}).scout.intake, true, 'tasks from before have enki’s own team, the scout before the plan')
  assert.equal(stepCapabilities({ team }, 'qa'), null, 'a step the task doesn’t have can do nothing')
})

test('the policy follows each step’s capabilities, not role names', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'enki-caps-')))
  const web = join(root, 'web')
  const taskDir = join(root, '.enki/tasks/2026-11-11-demo')
  mkdirSync(join(web, 'src'), { recursive: true })
  mkdirSync(taskDir, { recursive: true })
  const caps = (write, blind = false) => ({ write, blind, browser: false, server: false })
  const state = {
    taskDir,
    scope: [],
    repos: [{ name: 'web', workdir: web, testGlobs: ['tests/**'] }],
    team: {
      docs: { capabilities: caps('none'), intake: false },
      'test-writer': { capabilities: caps('tests', true), intake: false },
      fullstack: { capabilities: caps('all'), intake: false },
      'frontend-coder': { capabilities: caps('code'), intake: false },
    },
  }
  const write = (role, path) => decide({ role, root, cwd: web, config: {}, state }, 'Write', { file_path: join(root, path), content: 'x' })
  assert.match(write('docs', 'web/src/a.js'), /read-only/)
  assert.equal(write('docs', '.enki/tasks/2026-11-11-demo/docs-r1.md'), null, 'its own report')
  assert.match(write('test-writer', 'web/src/a.js'), /only writes test files/)
  assert.equal(write('test-writer', 'web/tests/a.test.js'), null)
  assert.equal(write('fullstack', 'web/src/a.js'), null)
  assert.equal(write('fullstack', 'web/tests/a.test.js'), null, 'write: all covers tests too')
  assert.match(write('frontend-coder', 'web/tests/a.test.js'), /belong to the tester/)
  assert.ok(write('nobody', 'web/src/a.js'), 'a step the task doesn’t have is refused')
  const read = (role, path) => decide({ role, root, cwd: web, config: {}, state }, 'Read', { file_path: join(root, path) })
  assert.match(read('test-writer', '.enki/tasks/2026-11-11-demo/frontend-coder-r1.md'), /hidden/, 'a blind step can’t read a sighted step’s report')
  assert.match(read('test-writer', '.enki/tasks/2026-11-11-demo/fullstack-r1.md'), /hidden/)
  assert.equal(read('test-writer', '.enki/tasks/2026-11-11-demo/requirements.md'), null)
  assert.equal(read('docs', '.enki/tasks/2026-11-11-demo/frontend-coder-r1.md'), null, 'sighted steps read everything')
})
