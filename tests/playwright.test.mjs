import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fakePlaywrightInstall, makeProject } from './helpers/harness.mjs'
import { MCP_VERSION } from '../src/playwright.mjs'

const launch = (project, name) => project.herdr.calls('agent', 'start', name)[0]
const mcp = project => JSON.parse(readFileSync(join(project.taskDir('demo'), 'mcp-qa.json'), 'utf8')).mcpServers.playwright

function teamUp(config, before) {
  const project = makeProject(config)
  before?.(project)
  project.enki(['task', 'new', 'demo'])
  project.approve()
  const result = project.enki(['team', 'start'])
  return { project, result }
}

test('Playwright is the default, and QA gets only its browser', () => {
  const { project, result } = teamUp()
  assert.equal(result.code, 0, result.err)
  const qa = launch(project, 'qa-demo')
  const config = qa[qa.indexOf('--mcp-config') + 1]
  assert.equal(config, join(project.taskDir('demo'), 'mcp-qa.json'))
  assert.ok(qa.includes('--strict-mcp-config'))
  assert.ok(!qa.includes('--chrome'))
  assert.ok(JSON.parse(qa[qa.indexOf('--settings') + 1]).permissions.allow.includes('mcp__playwright'))
  for (const role of ['scout', 'coder', 'tester', 'reviewer']) {
    assert.ok(!launch(project, `${role}-demo`).includes('--mcp-config'), role)
  }
})

test('the browser is headless, isolated, kept to local pages, and saves evidence in the task', () => {
  const { project } = teamUp()
  const server = mcp(project)
  assert.equal(server.command, process.execPath)
  assert.ok(server.args[0].endsWith('@playwright/mcp/cli.js'))
  for (const flag of ['--headless', '--isolated']) assert.ok(server.args.includes(flag), flag)
  const value = flag => server.args[server.args.indexOf(flag) + 1]
  assert.equal(value('--output-dir'), join(project.taskDir('demo'), 'qa-evidence'))
  assert.equal(value('--allowed-origins'), 'http://localhost:4321')
  assert.equal(value('--executable-path'), project.fakeBrowser)
})

test('every repo URL is allowed, and nothing else', () => {
  const { project } = teamUp({
    repos: [
      { path: 'web', url: 'http://localhost:4321/app', devServer: { managedBy: 'user' } },
      { path: 'api', url: 'http://[::1]:8080', devServer: { managedBy: 'user' } },
      { path: 'lib' },
    ],
  })
  const server = mcp(project)
  assert.equal(server.args[server.args.indexOf('--allowed-origins') + 1], 'http://localhost:4321;http://[::1]:8080')
})

test('headless can be turned off', () => {
  const { project } = teamUp({ browser: { headless: false, executable: '/bin/sh' } })
  assert.ok(!mcp(project).args.includes('--headless'))
})

test('the QA role explains its Playwright browser', () => {
  const { project } = teamUp()
  const role = readFileSync(join(project.taskDir('demo'), 'role-qa.md'), 'utf8')
  assert.match(role, /Browser: Playwright/)
  assert.match(role, /qa-evidence/)
  assert.doesNotMatch(role, /Claude in Chrome/)
})

test('a task with no local URL gets no browser', () => {
  const { project, result } = teamUp({ repos: [{ path: 'web' }] })
  assert.equal(result.code, 0, result.err)
  assert.ok(!launch(project, 'qa-demo').includes('--mcp-config'))
  assert.match(readFileSync(join(project.taskDir('demo'), 'role-qa.md'), 'utf8'), /Checks without a browser/)
})

test('without an install, the team does not start, and the message says what will download', () => {
  const { project, result } = teamUp({}, p => rmSync(join(p.env.ENKI_HOME, 'playwright'), { recursive: true }))
  assert.notEqual(result.code, 0)
  assert.match(result.err, new RegExp(`enki playwright install \\(downloads @playwright/mcp ${MCP_VERSION.replaceAll('.', '\\.')}`))
  assert.match(result.err, /Ask the user/)
  assert.equal(project.herdr.calls('agent', 'start').length, 1, 'only the scout from intake')
})

test('the wrong version counts as not installed', () => {
  const { result } = teamUp({}, p => fakePlaywrightInstall(p.env.ENKI_HOME, '0.0.1'))
  assert.match(result.err, /isn't installed/)
})

test('QA: none needs no Playwright', () => {
  const project = makeProject()
  rmSync(join(project.env.ENKI_HOME, 'playwright'), { recursive: true })
  project.enki(['task', 'new', 'demo'])
  project.approve('# Plan\n\nQA: none\n')
  assert.equal(project.enki(['team', 'start']).code, 0)
})

test('a configured browser that does not exist is reported', () => {
  const { result } = teamUp({ browser: { executable: '/nowhere/chrome' } })
  assert.match(result.err, /browser\.executable doesn't exist: \/nowhere\/chrome/)
})

test('with no browser anywhere, it says how to download one', () => {
  const project = makeProject({ browser: {} })
  project.enki(['task', 'new', 'demo'], { PATH: dirname(process.execPath) })
  project.approve()
  const result = project.enki(['team', 'start'], { PATH: dirname(process.execPath) })
  assert.match(result.err, /enki playwright install --browser/)
})

test('a system Chrome on PATH is found', () => {
  const project = makeProject({ browser: {} })
  const bin = join(project.base, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'google-chrome'), '')
  const env = { PATH: `${bin}:${dirname(process.execPath)}` }
  project.enki(['task', 'new', 'demo'], env)
  project.approve()
  assert.equal(project.enki(['team', 'start'], env).code, 0)
  assert.equal(mcp(project).args[mcp(project).args.indexOf('--executable-path') + 1], join(bin, 'google-chrome'))
})

test('a browser enki downloaded is used through Playwright\'s own path', () => {
  const project = makeProject({ browser: {} })
  mkdirSync(join(project.env.ENKI_HOME, 'playwright/browsers/chromium-1234'), { recursive: true })
  const env = { PATH: dirname(process.execPath) }
  project.enki(['task', 'new', 'demo'], env)
  project.approve()
  assert.equal(project.enki(['team', 'start'], env).code, 0)
  const server = mcp(project)
  assert.ok(!server.args.includes('--executable-path'))
  assert.equal(server.env.PLAYWRIGHT_BROWSERS_PATH, join(project.env.ENKI_HOME, 'playwright/browsers'))
})

test('the chrome driver still works, and is the only one with a lock', () => {
  const { project } = teamUp({ browser: { driver: 'chrome' } })
  assert.ok(launch(project, 'qa-demo').includes('--chrome'))
  assert.ok(!launch(project, 'qa-demo').includes('--mcp-config'))
  assert.match(project.enki(['browser', 'acquire'], project.asWorker('qa')).out, /Browser acquired/)
})

test('Playwright needs no browser lock, so tasks test in parallel', () => {
  const { project } = teamUp()
  assert.match(project.enki(['browser', 'acquire'], project.asWorker('qa')).out, /needs no lock/)
})

function fakeNpm(project) {
  const path = join(project.base, 'fake-npm.mjs')
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const prefix = process.argv[process.argv.indexOf('--prefix') + 1]
appendFileSync(join(prefix, 'npm-calls.log'), process.argv.slice(2).join(' ') + '\\n')
const mcp = join(prefix, 'node_modules/@playwright/mcp')
mkdirSync(mcp, { recursive: true })
writeFileSync(join(mcp, 'package.json'), JSON.stringify({ version: process.argv.at(-1).split('@').at(-1) }))
writeFileSync(join(mcp, 'cli.js'), '')
const core = join(prefix, 'node_modules/playwright-core')
mkdirSync(core, { recursive: true })
writeFileSync(join(core, 'cli.js'), "import { mkdirSync } from 'node:fs'; mkdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH + '/chromium-1', { recursive: true })")
`,
  )
  chmodSync(path, 0o755)
  return { ENKI_NPM_BIN: path }
}

test('install fetches the pinned version once, into enki\'s folder, without running package scripts', () => {
  const project = makeProject()
  rmSync(join(project.env.ENKI_HOME, 'playwright'), { recursive: true })
  const env = fakeNpm(project)
  const first = project.enki(['playwright', 'install'], env)
  assert.equal(first.code, 0, first.err)
  assert.match(first.out, new RegExp(`Installed @playwright/mcp ${MCP_VERSION.replaceAll('.', '\\.')}`))
  assert.match(first.out, /Ready\./)
  const log = () => readFileSync(join(project.env.ENKI_HOME, 'playwright/npm-calls.log'), 'utf8')
  assert.match(log(), new RegExp(`--ignore-scripts @playwright/mcp@${MCP_VERSION.replaceAll('.', '\\.')}`))
  assert.match(project.enki(['playwright', 'install'], env).out, /already installed/)
  assert.equal(log().trim().split('\n').length, 1)
})

test('install --browser downloads Chromium into enki\'s folder', () => {
  const project = makeProject({ browser: {} })
  rmSync(join(project.env.ENKI_HOME, 'playwright'), { recursive: true })
  const env = { ...fakeNpm(project), PATH: `${dirname(process.execPath)}` }
  const result = project.enki(['playwright', 'install', '--browser'], env)
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Downloaded Chromium/)
  assert.match(project.enki(['playwright', 'status'], env).out, /Chromium downloaded by enki/)
})

test('status reports the version, browser and mode', () => {
  const project = makeProject()
  const result = project.enki(['playwright', 'status'])
  assert.match(result.out, new RegExp(`@playwright/mcp ${MCP_VERSION.replaceAll('.', '\\.')}`))
  assert.match(result.out, /Browser: .*fake-chrome \(configured\)/)
  assert.match(result.out, /Headless: true/)
})

test('doctor checks Playwright when the project uses it', () => {
  const project = makeProject()
  rmSync(join(project.env.ENKI_HOME, 'playwright'), { recursive: true })
  assert.match(project.enki(['doctor']).out, /FAIL Playwright for QA: Playwright isn't installed/)
})

test('workers cannot install or inspect Playwright', () => {
  const { project } = teamUp()
  assert.match(project.enki(['playwright', 'status'], project.asWorker('qa')).err, /Workers can't/)
})

test('browser settings are validated', async () => {
  const { validateConfig, ConfigError } = await import('../src/config.mjs')
  for (const browser of [{ driver: 'firefox' }, { headless: 'no' }, { executable: 'chrome' }, { colour: 'blue' }]) {
    assert.throws(() => validateConfig({ browser }), ConfigError, JSON.stringify(browser))
  }
  validateConfig({ browser: { driver: 'playwright', headless: false, executable: '/usr/bin/chromium' } })
})
