// The settings page's read and write path, without the server.
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { applyChanges, builtIns, editableValues, readSettings, saveSettings, SettingsError } from '../dashboard/settings.mjs'
import { modelCatalog } from '../dashboard/models.mjs'
import { makeProject } from './helpers/harness.mjs'

const fails = (raw, changes) => {
  try {
    applyChanges(raw, changes)
  } catch (error) {
    assert.ok(error instanceof SettingsError)
    assert.equal(error.status, 422)
    return error.problems
  }
  assert.fail('expected the change to be refused')
}

test('values come from the file, with defaults and timeouts in minutes', () => {
  const values = editableValues({ timeouts: { coder: 90000 }, team: { coder: { model: 'claude-opus-4-5', skills: ['design:ux-copy'] } } })
  assert.equal(values.timeouts.coder, 1.5, 'a value that isn’t whole minutes keeps its decimals')
  assert.equal(values.timeouts.scout, 15)
  assert.deepEqual(values.team.coder, { model: 'claude-opus-4-5', effort: 'high', skills: ['design:ux-copy'] })
  assert.deepEqual(values.team.scout.skills, [])
  assert.equal(values.mode, 'auto')
  assert.deepEqual(values.ports, { from: 4400, to: 4999 })
  assert.deepEqual(values.database, { enabled: false, default: 'copy', copy: '', drop: '', env: [] }, 'no section shows copying off')
  assert.equal(editableValues({ database: { copy: 'a {task}' } }).database.enabled, true)
  assert.equal(editableValues({ database: { copy: 'a {task}', enabled: false } }).database.enabled, false)
})

test('a change touches only its own field, and keeps key order and unknown keys', () => {
  const raw = { id: 'p', policy: { secrets: ['x'] }, team: { coder: { model: 'claude-sonnet-5-5', effort: 'high' } }, timeouts: { coder: 90000 }, repos: [] }
  const next = applyChanges(raw, { 'team.coder.effort': 'max', 'team.scout.skills': ['a', 'design:ux-copy'], 'timeouts.scout': 2, maxFixRounds: 5 })
  assert.deepEqual(Object.keys(next), ['id', 'policy', 'team', 'timeouts', 'repos', 'maxFixRounds'])
  assert.deepEqual(next.team.coder, { model: 'claude-sonnet-5-5', effort: 'max' })
  assert.deepEqual(next.team.scout, { skills: ['a', 'design:ux-copy'] })
  assert.deepEqual(next.timeouts, { coder: 90000, scout: 120000 }, 'an untouched timeout keeps its exact value')
  assert.deepEqual(next.policy, { secrets: ['x'] })
  assert.equal(raw.team.coder.effort, 'high', 'the input is not changed')
})

test('a port range gets both ends, and from may equal to', () => {
  assert.deepEqual(applyChanges({}, { 'ports.to': 4400 }).ports, { from: 4400, to: 4400 })
  assert.equal(fails({}, { 'ports.from': 5000, 'ports.to': 4000 })[0].path, 'ports')
  assert.equal(fails({}, { 'ports.from': 80 })[0].path, 'ports.from')
})

test('database copying switches on with commands, and off keeps them', () => {
  const on = applyChanges({}, { 'database.enabled': true, 'database.copy': 'createdb app_{task}', 'database.drop': 'dropdb app_{task}', 'database.env': [['DATABASE_URL', 'postgres://localhost/app_{task}']] })
  assert.deepEqual(on.database, { enabled: true, copy: 'createdb app_{task}', drop: 'dropdb app_{task}', env: { DATABASE_URL: 'postgres://localhost/app_{task}' } })
  const off = applyChanges(on, { 'database.enabled': false })
  assert.equal(off.database.enabled, false)
  assert.equal(off.database.copy, 'createdb app_{task}')
  assert.deepEqual(applyChanges({}, { 'database.default': 'none' }).database, { enabled: false, default: 'none' }, 'a new section starts switched off')
})

test('database commands need {task} or {port}, but only when the save touches them', () => {
  const problems = fails({}, { 'database.enabled': true, 'database.copy': 'createdb app' })
  assert.deepEqual(problems.map(item => item.path).sort(), ['database.copy', 'database.drop'])
  assert.match(problems.find(item => item.path === 'database.copy').message, /\{task\} or \{port\}/)
  const older = { database: { copy: 'createdb app', drop: 'dropdb app' } }
  assert.equal(applyChanges(older, { maxFixRounds: 2 }).maxFixRounds, 2, 'an unrelated save still works')
})

test('env names are checked one by one', () => {
  const problems = fails({ database: { enabled: false } }, { 'database.env': [['GOOD', 'a'], ['1BAD', 'b'], ['GOOD', 'c'], [' ', 'd']] })
  assert.deepEqual(problems.map(item => item.path), ['database.env.1', 'database.env.2', 'database.env.3'])
})

test('values are checked, and only the page’s fields can change', () => {
  assert.equal(fails({}, { 'team.coder.effort': 'huge' })[0].path, 'team.coder.effort')
  assert.equal(fails({}, { 'team.coder.skills': ['ok', 'ok'] })[0].message, 'Each skill can be added once.')
  assert.equal(fails({}, { 'team.coder.skills': ['bad name'] })[0].path, 'team.coder.skills')
  assert.equal(fails({}, { 'timeouts.coder': 0 })[0].path, 'timeouts.coder')
  assert.equal(fails({}, { maxFixRounds: 1.5 })[0].path, 'maxFixRounds')
  assert.equal(fails({ memory: 'private' }, { worktrees: false })[0].path, 'memory', 'validateConfig’s problems carry their path')
  for (const path of ['permissionMode', 'policy.secrets', 'repos', 'memory', 'database.other', 'team.boss.model', 'timeouts.lunch']) {
    assert.equal(fails({}, { [path]: 'x' })[0].message, 'This setting can’t be changed here.', path)
  }
  assert.throws(() => applyChanges({}, null), SettingsError)
})

test('saving refuses a file that changed since it was read, and writes otherwise', () => {
  const project = makeProject({ team: { coder: { model: 'claude-sonnet-5-5' } } })
  const target = { id: 'proj1', root: project.root }
  const first = readSettings(target)
  assert.equal(first.readOnly.repos[0].name, 'web')
  assert.deepEqual(first.readOnly.repos[0].test, ['npm test'])
  assert.equal(first.readOnly.repos[0].devServer, 'Started by you')
  assert.equal(first.invalid, null)
  const saved = saveSettings(target, { base: first.hash, changes: { 'team.coder.model': 'claude-opus-5-5' } })
  assert.notEqual(saved.hash, first.hash)
  const path = join(project.root, '.enki/config.json')
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).team.coder.model, 'claude-opus-5-5')
  assert.throws(() => saveSettings(target, { base: first.hash, changes: { maxFixRounds: 1 } }), error => error.status === 409)
  writeFileSync(path, '{"id": "proj1", "maxFixRounds": "lots"}')
  assert.ok(readSettings(target).invalid.some(problem => problem.startsWith('maxFixRounds')), 'an invalid file is reported, not thrown')
})

test('each role shows enki’s own instructions, and QA its browser guide for each driver', () => {
  const built = builtIns()
  assert.deepEqual(Object.keys(built.roles), ['scout', 'coder', 'tester', 'qa', 'reviewer'])
  assert.equal(built.roles.coder.label, 'Enki coder role')
  assert.match(built.roles.coder.description, /^You are the coder/)
  assert.deepEqual(Object.keys(built.browser), ['playwright', 'chrome', 'none'])
  assert.match(built.browser.playwright.description, /Playwright/)
})

test('models come from Claude Code’s newest catalog for the CLI, else enki’s own list', t => {
  const { base } = makeProject()
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = join(base, 'claude')
  t.after(() => (before === undefined ? delete process.env.CLAUDE_CONFIG_DIR : (process.env.CLAUDE_CONFIG_DIR = before)))
  assert.equal(modelCatalog().source, 'enki')
  const dir = join(base, 'claude', 'cache', 'model-catalog')
  mkdirSync(dir, { recursive: true })
  const catalog = (surface, fetchedAt, models) => JSON.stringify({ version: 2, fetchedAt, catalog: { surface, config: { models } } })
  writeFileSync(join(dir, 'desktop.json'), catalog('ccd', 300, [{ id: 'claude-desktop-only', name: 'Desktop' }]))
  writeFileSync(join(dir, 'old.json'), catalog('cc', 100, [{ id: 'claude-old', name: 'Old' }]))
  writeFileSync(join(dir, 'broken.json'), '{')
  writeFileSync(
    join(dir, 'new.json'),
    catalog('cc', 200, [
      { id: 'claude-opus-5-5', name: 'Opus 5.5', description: 'For complex work', section: 'main', runtime: { effort_levels: ['low', 'high', 'turbo'], default_effort: 'high' } },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', section: 'overflow', runtime: { max_input_tokens: 200000 }, auto_permission_mode: 'unavailable', auto_permission_mode_note: 'Requires Claude 4.6 or newer' },
      { id: 'claude-mystery', name: 'Mystery' },
      { name: 'no id' },
    ]),
  )
  const result = modelCatalog()
  assert.equal(result.source, 'claude-code')
  assert.equal(result.fetchedAt, new Date(200).toISOString())
  assert.deepEqual(result.models.map(model => model.id), ['claude-opus-5-5', 'claude-haiku-4-5-20251001', 'claude-mystery'], 'the newest CLI catalog wins, and entries without an id are dropped')
  const [opus, haiku, mystery] = result.models
  assert.deepEqual([opus.label, opus.latest, opus.efforts, opus.defaultEffort], ['Opus 5.5', true, ['low', 'high'], 'high'], 'unknown effort levels are left out')
  assert.deepEqual([haiku.latest, haiku.efforts, haiku.autoMode, haiku.autoModeNote], [false, [], false, 'Requires Claude 4.6 or newer'])
  assert.equal(mystery.efforts, null, 'a model the catalog doesn’t describe keeps every level')
})
