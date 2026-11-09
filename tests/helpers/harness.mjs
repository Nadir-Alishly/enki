// Builds a throwaway project and runs the real CLI and hook scripts against the fake herdr.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_VERSION } from '../../src/playwright.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const enkiBin = join(repoRoot, 'bin/enki')
const fakeHerdr = join(repoRoot, 'tests/helpers/fake-herdr.mjs')

/** A stand-in for `enki playwright install`, so team starts don't need the network. */
const DEFAULT_STEPS = ['1. [Scout] Explore', '2. [Tester] Write tests', '3. [Coder] Implement', '4. [QA] Check by hand', '5. [Reviewer] Review', '6. [Orchestrator] Report'].join('\n')
const DEFAULT_STEP = { tester: '2', coder: '3', qa: '4', reviewer: '5' }

export function fakePlaywrightInstall(enkiHome, version = MCP_VERSION) {
  const dir = join(enkiHome, 'playwright/node_modules/@playwright/mcp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version }))
  writeFileSync(join(dir, 'cli.js'), '')
}

export function makeProject(config = {}) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'enki-test-')))
  const root = join(base, 'project')
  const fakeBrowser = join(base, 'fake-chrome')
  writeFileSync(fakeBrowser, '')
  mkdirSync(join(root, '.enki/tasks'), { recursive: true })
  mkdirSync(join(root, 'web/src'), { recursive: true })
  writeFileSync(
    join(root, '.enki/config.json'),
    JSON.stringify({ id: 'proj1', repos: [{ path: 'web', test: ['npm test'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }], browser: { executable: fakeBrowser }, worktrees: false, ...config }),
  )
  const herdrState = join(base, 'herdr.json')
  const env = {
    PATH: process.env.PATH,
    HOME: join(base, 'home'),
    ENKI_HOME: join(base, 'enki-home'),
    ENKI_HERDR_BIN: fakeHerdr,
    FAKE_HERDR_STATE: herdrState,
    HERDR_ENV: '1',
    HERDR_WORKSPACE_ID: 'w1',
    HERDR_PANE_ID: 'w1:orch',
    ENKI_DASHBOARD: 'off',
  }
  mkdirSync(env.HOME, { recursive: true })
  fakePlaywrightInstall(env.ENKI_HOME)

  const herdr = {
    read: () => JSON.parse(readFileSync(herdrState, 'utf8')),
    script(change) {
      const state = existsSync(herdrState) ? this.read() : { next: 1, panes: {}, agents: {}, calls: [], script: {} }
      change(state.script, state)
      writeFileSync(herdrState, JSON.stringify(state))
    },
    calls(...prefix) {
      return this.read().calls.filter(call => prefix.every((word, index) => call[index] === word))
    },
  }

  const enki = (rawArgs, extraEnv = {}) => {
    // Most tests aren't about steps: name a default one, unless the test opts out.
    let args = rawArgs.filter(arg => arg !== '--no-auto-step')
    if (args[0] === 'ask' && DEFAULT_STEP[args[1]] && !args.includes('--step') && !rawArgs.includes('--no-auto-step')) args = [...args, '--step', DEFAULT_STEP[args[1]]]
    const result = spawnSync(process.execPath, [enkiBin, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8' })
    return { code: result.status, out: result.stdout, err: result.stderr }
  }

  const hook = (name, rawInput, extraEnv = {}, cwd = root) => {
    // Plans without steps get a default list, unless the test is about that.
    let input = rawInput
    const plan = rawInput.tool_response?.plan
    if (name === 'post-tool-use' && typeof plan === 'string' && plan.trim() !== '' && !/\[(scout|coder|tester|qa|reviewer|orchestrator)\]/i.test(plan) && !rawInput.noAutoSteps) {
      input = { ...rawInput, tool_response: { ...rawInput.tool_response, plan: `${plan}\n${DEFAULT_STEPS}` } }
    }
    const result = spawnSync(process.execPath, [join(repoRoot, 'hooks', `${name}.mjs`)], {
      cwd,
      env: { ...env, ...extraEnv },
      encoding: 'utf8',
      input: JSON.stringify({ cwd, ...input }),
    })
    return { code: result.status, out: result.stdout, err: result.stderr, json: result.stdout.trim() ? JSON.parse(result.stdout) : null }
  }

  const taskDir = slug => {
    const tasks = join(root, '.enki/tasks')
    const match = readdirNames(tasks).find(name => name.endsWith(`-${slug}`))
    return join(tasks, match)
  }
  const state = slug => JSON.parse(readFileSync(join(taskDir(slug), 'state.json'), 'utf8'))
  const events = slug => readFileSync(join(taskDir(slug), 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))

  const brief = (name = 'brief.md') => {
    const path = join(base, name)
    writeFileSync(path, 'Do the thing.\n')
    return path
  }

  /** Runs the same hook the real ExitPlanMode approval runs. */
  const approve = (plan = '# Plan\n\nTeam: full\n', extraEnv = {}) => {
    for (const name of readdirNames(join(root, '.enki/tasks'))) writeFileSync(join(root, '.enki/tasks', name, 'scout.md'), 'Report.\n')
    enki(['phase', 'planning'], extraEnv)
    return hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan } }, extraEnv)
  }

  /** Writes a report as a worker would, so gates can see it. */
  const report = (slug, name, text = 'Report.\n') => writeFileSync(join(taskDir(slug), name), text)

  const asWorker = (role, slug = 'demo') => ({ ENKI_ROLE: role, ENKI_TASK: taskDir(slug), ENKI_PROJECT: root })

  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' })

  return { base, root, env, fakeBrowser, herdr, enki, hook, taskDir, state, events, brief, approve, report, asWorker, git, write: writeFileSync }
}

function readdirNames(dir) {
  return spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
}
