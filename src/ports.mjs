// Free ports for task servers. A machine-wide registry stops two tasks claiming the same
// port in the moment before either server binds it.
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { enkiHome, statePath, writeJsonAtomic } from './state.mjs'

const registryPath = () => join(enkiHome(), 'ports.json')
const LOCK_STALE_MS = 10000

async function withRegistry(change) {
  mkdirSync(enkiHome(), { recursive: true })
  const lock = `${registryPath()}.lock`
  const deadline = Date.now() + LOCK_STALE_MS * 2
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx'))
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true })
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}`)
      await new Promise(done => setTimeout(done, 20))
    }
  }
  try {
    const registry = existsSync(registryPath()) ? JSON.parse(readFileSync(registryPath(), 'utf8')) : {}
    const result = await change(registry)
    writeJsonAtomic(registryPath(), registry)
    return result
  } finally {
    rmSync(lock, { force: true })
  }
}

function listens(port, host) {
  return new Promise(done => {
    const server = createServer()
    server.once('error', error => done(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT'))
    server.listen({ port, host, exclusive: true }, () => server.close(() => done(true)))
  })
}

/** Free on both IPv4 and IPv6 loopback, as dev servers bind either. */
export const isFree = async port => (await listens(port, '127.0.0.1')) && (await listens(port, '::1'))

/** A task's entries are stale once its folder is gone or the task finished. */
function isStale(entry) {
  // A task registers its ports a moment before its state file exists, so give it time.
  if (!existsSync(statePath(entry.taskDir))) return Date.now() - Date.parse(entry.at) > 300000
  try {
    return JSON.parse(readFileSync(statePath(entry.taskDir), 'utf8')).phase === 'done'
  } catch {
    return false
  }
}

/** One port per name, from the range, never one another task holds. */
export function allocatePorts({ taskDir, names, from, to }) {
  return withRegistry(async registry => {
    for (const [port, entry] of Object.entries(registry)) if (isStale(entry)) delete registry[port]
    const ports = {}
    for (const name of names) {
      let found = null
      for (let port = from; port <= to && found === null; port++) {
        if (registry[port] || Object.values(ports).includes(port)) continue
        if (await isFree(port)) found = port
      }
      if (found === null) throw new Error(`No free port between ${from} and ${to}. Widen ports.from and ports.to in .enki/config.json.`)
      ports[name] = found
      registry[found] = { taskDir, name, at: new Date().toISOString() }
    }
    return ports
  })
}

export function releasePorts(taskDir) {
  return withRegistry(registry => {
    for (const [port, entry] of Object.entries(registry)) if (entry.taskDir === taskDir) delete registry[port]
  })
}
