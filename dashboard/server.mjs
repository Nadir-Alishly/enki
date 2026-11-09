// The dashboard server. One per machine, owned by no session: enki starts it when it's down,
// and it exits by itself after a while with nothing open. View-only: it never changes anything
// except its own cache and its own record in ~/.enki/dashboard.json.
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { enkiHome, writeJsonAtomic } from '../src/state.mjs'
import { buildId, dashboardDir } from './build.mjs'
import { fingerprint, herdrAgents, projectDetail, projectList, projects, taskDetail } from './model.mjs'
import { TokenCache } from './tokens.mjs'

const port = Number(process.env.ENKI_DASHBOARD_PORT || 4747)
const idleMs = Number(process.env.ENKI_DASHBOARD_IDLE_MS || 30 * 60 * 1000)
const pollMs = Number(process.env.ENKI_DASHBOARD_POLL_MS || 2000)
// ENKI_DASHBOARD_BUILD stands in for an older version in tests.
const build = process.env.ENKI_DASHBOARD_BUILD || buildId()
const token = randomBytes(16).toString('hex')
const infoPath = join(enkiHome(), 'dashboard.json')

mkdirSync(enkiHome(), { recursive: true })
const tokens = new TokenCache(join(enkiHome(), 'dashboard.db'))

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
}

const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
const clients = new Set()
let live = null
let version = 0
let lastKey = ''
let openTasks = 0
let idleSince = Date.now()

function send(response, status, body, type = 'application/json; charset=utf-8') {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
  })
  response.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

function shutdown() {
  for (const client of clients) client.end()
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf8'))
    if (info.pid === process.pid) rmSync(infoPath, { force: true })
  } catch {
    // Someone else's record, or none.
  }
  tokens.close()
  process.exit(0)
}

async function refresh() {
  live = await herdrAgents()
  const { key, open } = fingerprint(live, tokens)
  openTasks = open
  if (key !== lastKey) {
    lastKey = key
    version += 1
    for (const client of clients) client.write(`data: ${JSON.stringify({ version })}\n\n`)
  }
  if (openTasks > 0 || clients.size > 0) idleSince = Date.now()
  else if (Date.now() - idleSince > idleMs) shutdown()
}

const server = createServer(async (request, response) => {
  // A page on another site can't reach this through DNS rebinding: only our own host name works.
  if (!allowedHosts.has(request.headers.host ?? '')) return send(response, 403, { error: 'Forbidden host' })
  const url = new URL(request.url, `http://localhost:${port}`)

  if (request.method === 'POST' && url.pathname === '/api/shutdown') {
    if (request.headers['x-enki-token'] !== token) return send(response, 403, { error: 'Bad token' })
    send(response, 200, { ok: true })
    setTimeout(shutdown, 50)
    return
  }
  if (request.method !== 'GET') return send(response, 405, { error: 'View-only' })

  try {
    if (STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      return send(response, 200, readFileSync(join(dashboardDir, 'public', file)), type)
    }
    if (url.pathname === '/favicon.ico') {
      response.writeHead(204, { 'cache-control': 'max-age=86400' })
      return response.end()
    }
    if (url.pathname === '/api/health') return send(response, 200, { app: 'enki-dashboard', build, pid: process.pid, version })
    if (url.pathname === '/api/projects') return send(response, 200, { version, herdr: live !== null, projects: projectList(live) })
    if (url.pathname === '/api/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      response.write(`data: ${JSON.stringify({ version })}\n\n`)
      clients.add(response)
      idleSince = Date.now()
      request.on('close', () => clients.delete(response))
      return
    }
    const projectMatch = /^\/api\/projects\/([\w-]+)$/.exec(url.pathname)
    const taskMatch = /^\/api\/projects\/([\w-]+)\/tasks\/([\w.-]+)$/.exec(url.pathname)
    const project = projects().find(item => item.id === (projectMatch ?? taskMatch)?.[1])
    if (projectMatch) return project ? send(response, 200, projectDetail(project, live, tokens)) : send(response, 404, { error: 'No such project' })
    if (taskMatch) {
      const detail = project && taskDetail(project, taskMatch[2], live, tokens)
      return detail ? send(response, 200, detail) : send(response, 404, { error: 'No such task' })
    }
    return send(response, 404, { error: 'Not found' })
  } catch (error) {
    return send(response, 500, { error: error.message })
  }
})

server.on('error', error => {
  // Another dashboard already has the port: that one serves, this one leaves.
  if (error.code === 'EADDRINUSE') process.exit(0)
  throw error
})

// Polled once before listening, so the first page never shows agents as unknown.
await refresh().catch(() => {})
server.listen(port, '127.0.0.1', () => {
  writeJsonAtomic(infoPath, { pid: process.pid, port, build, token, startedAt: new Date().toISOString() })
  setInterval(() => refresh().catch(() => {}), pollMs)
  // Keeps idle connections from piling up, and lets SSE clients notice a restart.
  setInterval(() => {
    for (const client of clients) client.write(': ping\n\n')
  }, 15000)
})

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
