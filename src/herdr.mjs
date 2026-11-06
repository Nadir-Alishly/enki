// The only module that talks to herdr. A second backend would replace this file's exports.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export class HerdrError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const bin = () => process.env.ENKI_HERDR_BIN || 'herdr'

function parseError(error) {
  const text = error.stderr || error.stdout || error.message
  try {
    const parsed = JSON.parse(text)
    if (parsed.error) return new HerdrError(parsed.error.code, parsed.error.message)
  } catch {
    // Non-JSON output: usage errors, or herdr not installed.
  }
  if (error.code === 'ENOENT') return new HerdrError('herdr_missing', 'herdr was not found on PATH')
  return new HerdrError('herdr_failed', String(text).trim().slice(0, 500))
}

async function call(args, { json = true, timeout = 60000 } = {}) {
  try {
    const { stdout } = await run(bin(), args, { timeout, maxBuffer: 8 * 1024 * 1024 })
    return json ? JSON.parse(stdout).result : stdout
  } catch (error) {
    if (error instanceof SyntaxError) throw new HerdrError('herdr_bad_output', error.message)
    throw parseError(error)
  }
}

const envArgs = env => Object.entries(env).flatMap(([key, value]) => ['--env', `${key}=${value}`])

export const inHerdr = () => process.env.HERDR_ENV === '1'

export async function version() {
  return (await call(['--version'], { json: false })).trim()
}

export async function createTab({ workspace, cwd, label, env }) {
  const result = await call(['tab', 'create', '--workspace', workspace, '--cwd', cwd, '--label', label, '--no-focus', ...envArgs(env)])
  return { tabId: result.tab.tab_id, rootPane: result.root_pane.pane_id }
}

export async function splitPane({ pane, direction, ratio, cwd, env }) {
  const sizing = ratio === undefined ? [] : ['--ratio', String(ratio)]
  const result = await call(['pane', 'split', pane, '--direction', direction, ...sizing, '--cwd', cwd, '--no-focus', ...envArgs(env)])
  return result.pane.pane_id
}

export async function runInPane(pane, command) {
  return call(['pane', 'run', pane, command], { json: false })
}

export async function readPane(pane, lines = 30) {
  return call(['pane', 'read', pane, '--source', 'recent-unwrapped', '--lines', String(lines)], { json: false })
}

export async function closeTab(tab) {
  return call(['tab', 'close', tab])
}

export async function paneLayout(pane) {
  return (await call(['pane', 'layout', '--pane', pane])).layout
}

export async function startAgent({ name, pane, args, timeout = 60000 }) {
  return call(['agent', 'start', name, '--kind', 'claude', '--pane', pane, '--timeout', String(timeout), '--', ...args], { timeout: timeout + 5000 })
}

/** Returns the agent object, or null when no such agent is live. */
export async function getAgent(name) {
  try {
    return (await call(['agent', 'get', name])).agent
  } catch (error) {
    if (error.code === 'agent_not_found') return null
    throw error
  }
}

/** Submits a prompt and waits until the agent is seen working or blocked. */
export async function submitPrompt(name, text, timeout = 30000) {
  const result = await call(
    ['agent', 'prompt', name, text, '--wait', '--until', 'working', '--until', 'blocked', '--timeout', String(timeout)],
    { timeout: timeout + 5000 },
  )
  return result.agent.agent_status
}

export async function waitForAgent(name, until, timeout) {
  const states = until.flatMap(state => ['--until', state])
  const result = await call(['agent', 'wait', name, ...states, '--timeout', String(timeout)], { timeout: timeout + 5000 })
  return result.agent.agent_status
}

/** Reads recent output, falling back to the visible screen while a dialog holds the terminal. */
export async function readAgent(name, lines = 40) {
  try {
    return await call(['agent', 'read', name, '--source', 'recent-unwrapped', '--lines', String(lines)], { json: false })
  } catch (error) {
    if (error.code !== 'agent_not_idle') throw error
    return call(['agent', 'read', name, '--source', 'visible'], { json: false })
  }
}

export async function readScreen(name) {
  return call(['agent', 'read', name, '--source', 'visible'], { json: false })
}

export async function sendKeys(name, keys) {
  return call(['agent', 'send-keys', name, ...keys])
}
