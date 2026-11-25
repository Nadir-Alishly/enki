// Builds a throwaway project and runs the real CLI and hook scripts against the fake herdr.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MCP_VERSION } from '../../src/playwright.mjs'
import { APPROVALS } from '../../src/workflow.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const enkiBin = join(repoRoot, 'bin/enki')
const fakeHerdr = join(repoRoot, 'tests/helpers/fake-herdr.mjs')

/** A stand-in for `enki playwright install`, so team starts don't need the network. */
const DEFAULT_STEPS = ['1. [Scout] Explore', '2. [Tester] Write tests', '3. [Coder] Implement', '4. [QA] Check by hand', '5. [Reviewer] Review', '6. [Orchestrator] Report'].join('\n')
/** A spec as the spec writer would write it, with the sections enki needs before it goes to the user. */
export const DEFAULT_SPEC = '# Spec\n\n## Goal\n\nThe work.\n\n## Acceptance criteria\n\n1. It works.\n\n## Public interface\n\nNone.\n'

/** A plan as the planner would write it: plans without steps get a default list, unless the test is about that. */
export function fullPlan(plan, { steps = true } = {}) {
  let text = plan
  if (steps && !/\[[a-z][\w-]*\]/i.test(text)) text = `${text}\n${DEFAULT_STEPS}`
  return text
}
const DEFAULT_STEP = { tester: '2', coder: '3', qa: '4', reviewer: '5' }

export function fakePlaywrightInstall(enkiHome, version = MCP_VERSION) {
  const dir = join(enkiHome, 'playwright/node_modules/@playwright/mcp')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@playwright/mcp', version }))
  writeFileSync(join(dir, 'cli.js'), '')
}

/**
 * A project workflow that is enki's Full with some steps tuned (`{ coder: { skills, model } }`):
 * how a project gives its agents another model, effort or skills.
 */
function tunedWorkflow(root, steps) {
  const full = JSON.parse(readFileSync(join(repoRoot, 'templates/workflows/full.json'), 'utf8'))
  const workflow = { ...full, id: 'tuned', name: 'Tuned', nodes: full.nodes.map(node => ({ ...node, ...steps[node.id] })) }
  mkdirSync(join(root, '.enki/workflows'), { recursive: true })
  writeFileSync(join(root, '.enki/workflows/tuned.json'), JSON.stringify(workflow))
}

export function makeProject(rawConfig = {}) {
  const { steps, ...config } = rawConfig
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'enki-test-')))
  const root = join(base, 'project')
  const fakeBrowser = join(base, 'fake-chrome')
  writeFileSync(fakeBrowser, '')
  mkdirSync(join(root, '.enki/tasks'), { recursive: true })
  mkdirSync(join(root, 'web/src'), { recursive: true })
  if (steps) tunedWorkflow(root, steps)
  writeFileSync(
    join(root, '.enki/config.json'),
    JSON.stringify({ ...(steps ? { workflow: 'tuned' } : {}), id: 'proj1', repos: [{ path: 'web', test: ['npm test'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }], browser: { executable: fakeBrowser }, worktrees: false, ...config }),
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
    let args = rawArgs.filter(arg => arg !== '--no-auto-step' && arg !== '--no-request')
    if (args[0] === 'ask' && DEFAULT_STEP[args[1]] && !args.includes('--step') && !rawArgs.includes('--no-auto-step')) args = [...args, '--step', DEFAULT_STEP[args[1]]]
    const result = spawnSync(process.execPath, [enkiBin, ...args], { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8' })
    // The orchestrator's first job: the user's request, in their words.
    if (args[0] === 'task' && args[1] === 'new' && result.status === 0 && !rawArgs.includes('--no-request')) {
      const dir = /Folder: (.+)/.exec(result.stdout)?.[1]
      if (dir && !existsSync(join(dir, 'request.md'))) writeFileSync(join(dir, 'request.md'), '# Request\n\nDo the thing.\n')
    }
    return { code: result.status, out: result.stdout, err: result.stderr }
  }

  const hook = (name, rawInput, extraEnv = {}, cwd = root) => {
    // Plans without steps get a default list, unless the test is about that.
    let input = rawInput
    const plan = rawInput.tool_response?.plan
    if (name === 'post-tool-use' && typeof plan === 'string' && plan.trim() !== '' && !rawInput.noAutoSteps) {
      input = { ...rawInput, tool_response: { ...rawInput.tool_response, plan: fullPlan(plan) } }
    }
    delete input.noAutoSteps
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

  /** The open task this pane's orchestrator works on. */
  const boundTask = (extraEnv = {}) => {
    const pane = extraEnv.HERDR_PANE_ID ?? env.HERDR_PANE_ID
    const all = readdirNames(join(root, '.enki/tasks')).map(name => JSON.parse(readFileSync(join(root, '.enki/tasks', name, 'state.json'), 'utf8'))).filter(task => task.phase !== 'done')
    return all.find(task => task.orchestratorPane === pane) ?? all[0]
  }

  /**
   * Runs the steps before the plan with the real commands until the plan waits for approval: the
   * scout reports, the spec writer writes `spec`, the user approves it through the real hook, and
   * the planner writes `plan` as its report. Returns the plan as written.
   */
  const planReady = (plan = '# Plan\n', extraEnv = {}, { steps = true, spec = DEFAULT_SPEC, until = 'plan' } = {}) => {
    const text = fullPlan(plan, { steps })
    const task = boundTask(extraEnv)
    if (!task.run) {
      writeFileSync(join(task.taskDir, 'scout.md'), 'Report.\n')
      enki(['phase', 'planning'], extraEnv)
      return text
    }
    const path = brief(`brief-plan-${task.slug}.md`)
    for (let turn = 0; turn < 10; turn++) {
      const current = JSON.parse(readFileSync(join(task.taskDir, 'state.json'), 'utf8'))
      if (current.run.steps.approval?.status === 'queued') return text
      if (current.run.steps['spec-approval']?.status === 'queued') {
        const result = hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: spec }, noAutoSteps: true }, extraEnv)
        if (JSON.parse(readFileSync(join(task.taskDir, 'state.json'), 'utf8')).run.steps['spec-approval'].status === 'queued') throw new Error(`The spec wasn't approved: ${JSON.stringify(result)}`)
        if (until === 'spec') return spec
        continue
      }
      const queued = Object.keys(current.run.steps).filter(id => !APPROVALS.includes(id) && current.run.steps[id].status === 'queued')
      if (queued.length === 0) throw new Error(`The plan never reached approval: ${JSON.stringify(current.run.steps)}`)
      for (const id of queued) {
        if (current.team[id]?.capabilities.plans) writeFileSync(join(task.taskDir, `${id}-r${current.run.steps[id].visits + 1}.md`), text)
        if (current.team[id]?.capabilities.specs) writeFileSync(join(task.taskDir, `${id}-r${current.run.steps[id].visits + 1}.md`), spec)
        const result = enki(['ask', id, path, '--task', task.slug], extraEnv)
        if (result.code !== 0 && !/waits for/.test(result.err)) throw new Error(`${id}: ${result.err}${result.out}`)
      }
    }
    throw new Error('The plan never reached approval.')
  }

  /** Runs the steps before the spec, approves the spec, and stops before the planning steps. */
  const specApproved = (extraEnv = {}, spec = DEFAULT_SPEC) => planReady('', extraEnv, { spec, until: 'spec' })

  /** Runs the steps before the plan, then the same hook the real ExitPlanMode approval runs. */
  const approve = (plan = '# Plan\n\nTeam: full\n', extraEnv = {}, { spec = DEFAULT_SPEC } = {}) => {
    const text = planReady(plan, extraEnv, { spec })
    return hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: text } }, extraEnv)
  }

  /** Writes a report as a worker would, so gates can see it. */
  const report = (slug, name, text = 'Report.\n') => writeFileSync(join(taskDir(slug), name), text)

  const asWorker = (role, slug = 'demo') => ({ ENKI_STEP: role, ENKI_TASK: taskDir(slug), ENKI_PROJECT: root })

  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, encoding: 'utf8' })

  /**
   * Runs an approved task's workflow to its end with the real commands, every agent reporting its
   * role's first outcome: what a task needs before it can finish. Throws on the first refusal.
   */
  const runWorkflow = (slug = 'demo', extraEnv = {}) => {
    const dir = taskDir(slug)
    if (!existsSync(join(dir, 'spec.md'))) writeFileSync(join(dir, 'spec.md'), DEFAULT_SPEC)
    const path = brief(`brief-${slug}.md`)
    for (let turn = 0; turn < 20; turn++) {
      const run = state(slug).run
      const workflow = JSON.parse(readFileSync(join(dir, 'workflow.json'), 'utf8'))
      if (!run) throw new Error('This task has no workflow run.')
      const queued = Object.keys(run.steps).filter(id => !APPROVALS.includes(id) && run.steps[id].status === 'queued')
      if (queued.length === 0) return
      let moved = false
      for (const id of queued) {
        const builtin = workflow.nodes.find(node => node.id === id)?.kind
        // The plan step this step owns, if the plan gives it one.
        const owned = state(slug).steps?.find(item => item.owner === id)?.n
        const result = builtin ? enki(['verify', id], extraEnv) : enki(['ask', id, path, '--task', slug, ...(owned ? ['--step', String(owned)] : [])], extraEnv)
        if (result.code === 0) moved = true
        else if (!/waits for|still working/i.test(result.err)) throw new Error(`${id}: ${result.err}${result.out}`)
      }
      if (!moved) throw new Error(`Nothing could start: ${queued.join(', ')}`)
    }
    throw new Error('The workflow did not end in 20 turns.')
  }

  return { base, root, env, fakeBrowser, herdr, enki, hook, taskDir, state, events, brief, planReady, specApproved, approve, report, asWorker, git, runWorkflow, write: writeFileSync }
}

function readdirNames(dir) {
  return spawnSync('ls', [dir], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
}
