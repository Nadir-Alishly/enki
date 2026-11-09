// Starting, checking and stopping the dashboard server. Any enki session or command may call
// ensureDashboard(); the server belongs to none of them, so it outlives whichever started it.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { buildId, dashboardDir } from '../dashboard/build.mjs'
import { enkiHome } from './state.mjs'

export const dashboardPort = () => Number(process.env.ENKI_DASHBOARD_PORT || 4747)
export const dashboardUrl = () => `http://localhost:${dashboardPort()}/`
const infoPath = () => join(enkiHome(), 'dashboard.json')
const lockPath = () => join(enkiHome(), 'dashboard.lock')

export class DashboardError extends Error {}

/** Disabled in tests and wherever someone opts out. */
export const dashboardDisabled = () => process.env.ENKI_DASHBOARD === 'off'

/** null when nothing answers; { app } otherwise, so a stranger on the port is recognisable. */
async function health() {
  try {
    const response = await fetch(`http://127.0.0.1:${dashboardPort()}/api/health`, { signal: AbortSignal.timeout(500), headers: { host: `localhost:${dashboardPort()}` } })
    try {
      return await response.json()
    } catch {
      return { app: 'something else' }
    }
  } catch {
    return null
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

async function waitFor(check, ms) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await check()) return true
    if (Date.now() > deadline) return false
    await sleep(100)
  }
}

function readInfo() {
  try {
    return JSON.parse(readFileSync(infoPath(), 'utf8'))
  } catch {
    return null
  }
}

async function askToExit() {
  const info = readInfo()
  if (!info?.token) return false
  try {
    await fetch(`http://127.0.0.1:${dashboardPort()}/api/shutdown`, { method: 'POST', headers: { 'x-enki-token': info.token, host: `localhost:${dashboardPort()}` }, signal: AbortSignal.timeout(1000) })
  } catch {
    return false
  }
  return waitFor(async () => (await health()) === null, 5000)
}

function launch() {
  mkdirSync(enkiHome(), { recursive: true })
  const log = openSync(join(enkiHome(), 'dashboard.log'), 'a')
  const child = spawn(process.execPath, [join(dashboardDir, 'server.mjs')], { detached: true, stdio: ['ignore', log, log], env: process.env })
  child.unref()
  closeSync(log)
}

/** One starter at a time: whoever loses waits for the winner's server instead of starting a second. */
function takeLock() {
  mkdirSync(enkiHome(), { recursive: true })
  try {
    closeSync(openSync(lockPath(), 'wx'))
    return true
  } catch {
    try {
      if (Date.now() - statSync(lockPath()).mtimeMs > 15000) {
        rmSync(lockPath(), { force: true })
        closeSync(openSync(lockPath(), 'wx'))
        return true
      }
    } catch {
      // Taken by someone else meanwhile.
    }
    return false
  }
}

/** Makes sure the current dashboard is running. Returns what it did. */
export async function ensureDashboard({ wait = true } = {}) {
  if (dashboardDisabled()) return { url: dashboardUrl(), status: 'disabled' }
  const build = buildId()
  const current = await health()
  if (current?.app === 'enki-dashboard' && current.build === build) return { url: dashboardUrl(), status: 'running' }
  if (current && current.app !== 'enki-dashboard') {
    throw new DashboardError(`Port ${dashboardPort()} is used by another program. Set ENKI_DASHBOARD_PORT to a free port.`)
  }
  if (!takeLock()) {
    const up = wait && (await waitFor(async () => (await health())?.build === build, 6000))
    return { url: dashboardUrl(), status: up ? 'running' : 'starting' }
  }
  try {
    let replaced = false
    if (current) {
      replaced = await askToExit()
      if (!replaced) throw new DashboardError('An older dashboard is running and would not stop. Run: enki dashboard stop')
    }
    launch()
    const up = wait ? await waitFor(async () => (await health())?.build === build, 6000) : true
    if (!up) throw new DashboardError(`The dashboard didn't start. See ${join(enkiHome(), 'dashboard.log')}`)
    return { url: dashboardUrl(), status: replaced ? 'updated' : 'started' }
  } finally {
    rmSync(lockPath(), { force: true })
  }
}

/** Starts it without waiting: for hooks, which mustn't slow Claude down. */
export function ensureDashboardInBackground(enkiBin) {
  if (dashboardDisabled()) return
  const child = spawn(process.execPath, [enkiBin, 'dashboard', '--quiet'], { detached: true, stdio: 'ignore', env: { ...process.env, ENKI_ROLE: '' } })
  child.unref()
}

export async function dashboardStatus() {
  const current = await health()
  if (!current) return 'The dashboard is not running. Start it with: enki dashboard'
  if (current.app !== 'enki-dashboard') return `Port ${dashboardPort()} is used by another program.`
  const info = readInfo()
  return `The dashboard is running at ${dashboardUrl()} (pid ${current.pid}${info?.startedAt ? `, since ${info.startedAt}` : ''}${current.build === buildId() ? '' : ', an older version'}).`
}

export async function stopDashboard() {
  const current = await health()
  if (!current) return 'The dashboard was not running.'
  if (current.app !== 'enki-dashboard') throw new DashboardError(`Port ${dashboardPort()} is used by another program, not the dashboard.`)
  if (!(await askToExit())) throw new DashboardError('The dashboard did not stop.')
  return 'The dashboard stopped.'
}

export const hasDashboardInfo = () => existsSync(infoPath())
