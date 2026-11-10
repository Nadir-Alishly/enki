// The dashboard: its token reader, its server's lifecycle and safety, and what it shows.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TokenCache } from '../dashboard/tokens.mjs'
import { titleOf, windowFor } from '../dashboard/model.mjs'
import { makeProject } from './helpers/harness.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))
const enkiBin = join(repoRoot, 'bin/enki')
let nextPort = 47100 + Math.floor(Math.random() * 700)
const sleep = ms => new Promise(done => setTimeout(done, ms))

/** A raw request, so the Host header can be anything. */
function call(port, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, agent: false, headers: { host: `localhost:${port}`, ...headers } }, res => {
      let body = ''
      res.on('data', chunk => (body += chunk))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body, json: () => JSON.parse(body) }))
    })
    req.on('error', reject)
    req.setTimeout(2000, () => req.destroy(new Error('timeout')))
    req.end(body)
  })
}

async function waitFor(check, ms = 8000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return true
    await sleep(100)
  }
  return false
}

function dashboardFor(t, project, extra = {}) {
  const port = nextPort++
  const env = { ENKI_DASHBOARD: 'on', ENKI_DASHBOARD_PORT: String(port), ENKI_DASHBOARD_POLL_MS: '150', CLAUDE_CONFIG_DIR: join(project.base, 'claude'), ...extra }
  const fullEnv = { ...project.env, ...env }
  const infoPath = join(project.env.ENKI_HOME, 'dashboard.json')
  const health = () => call(port, '/api/health').then(response => response.json(), () => null)
  const pids = new Set()
  const remember = () => {
    try {
      pids.add(JSON.parse(readFileSync(infoPath, 'utf8')).pid)
    } catch {
      // Not written yet.
    }
  }
  const run = (args = [], cwd = project.root, more = {}) => {
    const result = spawnSync(process.execPath, [enkiBin, 'dashboard', ...args], { cwd, env: { ...fullEnv, ...more }, encoding: 'utf8' })
    remember()
    return { code: result.status, out: result.stdout, err: result.stderr }
  }
  t.after(async () => {
    remember()
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // Already gone.
      }
    }
  })
  return { port, env, fullEnv, run, health, infoPath, remember, pids, get: (path, options) => call(port, path, options) }
}

function transcript(project, session, lines) {
  const dir = join(project.base, 'claude', 'projects', '-some-folder')
  mkdirSync(dir, { recursive: true })
  appendFileSync(join(dir, `${session}.jsonl`), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
}

const usageLine = (id, at, usage, model = 'claude-sonnet-5-5') => ({ type: 'assistant', timestamp: at, message: { id, model, usage } })

// The token reader

test('tokens count each message once, and only complete lines', t => {
  const project = makeProject()
  const db = new TokenCache(join(project.base, 'tokens.db'))
  t.after(() => db.close())
  process.env.CLAUDE_CONFIG_DIR = join(project.base, 'claude')
  t.after(() => delete process.env.CLAUDE_CONFIG_DIR)
  const usage = { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 5000, output_tokens: 90 }
  const first = usageLine('m1', '2026-11-08T10:00:00.000Z', usage)
  transcript(project, 's1', [first, first, first, { type: 'user', message: { content: 'hi' } }])
  assert.deepEqual(db.session('s1'), { spent: 1100, context: 6010, model: 'claude-sonnet-5-5', at: '2026-11-08T10:00:00.000Z' })

  // A line still being written is left for next time.
  const dir = join(project.base, 'claude', 'projects', '-some-folder', 's1.jsonl')
  const second = JSON.stringify(usageLine('m2', '2026-11-08T11:00:00.000Z', { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 7000, output_tokens: 20 }, 'claude-haiku-5-5'))
  appendFileSync(dir, second.slice(0, 40))
  assert.equal(db.session('s1').spent, 1100)
  appendFileSync(dir, `${second.slice(40)}\n`)
  assert.deepEqual(db.session('s1'), { spent: 1125, context: 7005, model: 'claude-haiku-5-5', at: '2026-11-08T11:00:00.000Z' })
  assert.equal(db.daily('s1').reduce((sum, day) => sum + day.spent, 0), 1125)
  assert.equal(db.session('missing'), null)
})

test('a task title is the first sentence of its goal', () => {
  assert.equal(titleOf('The cart gets its own screen. The cat opens it from the header.'), 'The cart gets its own screen')
  assert.equal(titleOf('Fix the "v1.2" banner'), 'Fix the "v1.2" banner')
  assert.equal(titleOf(null), null)
})

// The server's lifecycle

test('enki dashboard starts the server from any folder, and a second call reuses it', async t => {
  const project = makeProject()
  const dash = dashboardFor(t, project)
  const first = dash.run([], project.base)
  assert.equal(first.code, 0, first.err)
  assert.match(first.out, new RegExp(`Started: http://localhost:${dash.port}/`))
  const { pid } = await dash.health()
  const second = dash.run([], project.base)
  assert.match(second.out, /Running:/)
  assert.equal((await dash.health()).pid, pid)
  assert.match(dash.run(['status']).out, new RegExp(`running at http://localhost:${dash.port}/ \\(pid ${pid}`))
  assert.equal(JSON.parse(readFileSync(dash.infoPath, 'utf8')).pid, pid)
  assert.match(dash.run(['stop']).out, /stopped/)
  assert.equal(await dash.health(), null)
  assert.equal(existsSync(dash.infoPath), false)
  assert.match(dash.run(['status']).out, /not running/)
})

test('the dashboard restarts after it was killed', async t => {
  const project = makeProject()
  const dash = dashboardFor(t, project)
  dash.run()
  const { pid } = await dash.health()
  process.kill(pid, 'SIGKILL')
  assert.ok(await waitFor(async () => (await dash.health()) === null))
  const again = dash.run()
  assert.match(again.out, /Started/)
  assert.notEqual((await dash.health()).pid, pid)
})

test('an older dashboard is replaced by the current one', async t => {
  const project = makeProject()
  const dash = dashboardFor(t, project)
  const old = spawn(process.execPath, [join(repoRoot, 'dashboard/server.mjs')], { env: { ...dash.fullEnv, ENKI_DASHBOARD_BUILD: 'old' }, stdio: 'ignore', detached: true })
  old.unref()
  dash.pids.add(old.pid)
  assert.ok(await waitFor(async () => (await dash.health())?.build === 'old'))
  const result = dash.run()
  assert.match(result.out, /Updated and restarted/)
  const now = await dash.health()
  assert.notEqual(now.build, 'old')
  assert.notEqual(now.pid, old.pid)
})

test('two starts at once leave one server', async t => {
  const project = makeProject()
  const dash = dashboardFor(t, project)
  const start = () =>
    new Promise(resolve => {
      const child = spawn(process.execPath, [enkiBin, 'dashboard'], { cwd: project.root, env: dash.fullEnv })
      let out = ''
      child.stdout.on('data', chunk => (out += chunk))
      child.on('close', code => resolve({ code, out }))
    })
  const results = await Promise.all([start(), start(), start()])
  dash.remember()
  for (const result of results) assert.equal(result.code, 0)
  assert.ok(results.some(result => /Started/.test(result.out)))
  const { pid } = await dash.health()
  assert.equal(JSON.parse(readFileSync(dash.infoPath, 'utf8')).pid, pid)
})

test('the dashboard exits when idle, but not while a task is open', async t => {
  const idle = makeProject()
  const quiet = dashboardFor(t, idle, { ENKI_DASHBOARD_IDLE_MS: '600' })
  quiet.run()
  assert.ok(await quiet.health())
  assert.ok(await waitFor(async () => (await quiet.health()) === null, 6000), 'idle server should exit')

  const busy = makeProject()
  busy.enki(['task', 'new', 'demo'])
  const dash = dashboardFor(t, busy, { ENKI_DASHBOARD_IDLE_MS: '600' })
  dash.run()
  await sleep(2000)
  assert.ok(await dash.health(), 'a server with an open task stays up')
})

test('the port taken by another program is reported, not fought over', async t => {
  const project = makeProject()
  const dash = dashboardFor(t, project)
  // In its own process: this one is blocked while the CLI runs.
  const other = spawn(process.execPath, ['-e', `require('node:http').createServer((q, s) => s.end('hello')).listen(${dash.port}, '127.0.0.1')`], { stdio: 'ignore' })
  t.after(() => other.kill())
  assert.ok(await waitFor(async () => (await dash.get('/').catch(() => null))?.body === 'hello'))
  const result = dash.run()
  assert.equal(result.code, 1)
  assert.match(result.err, /used by another program/)
})

test('workers cannot run enki dashboard, and tests keep it off', async t => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  const dash = dashboardFor(t, project)
  const result = dash.run([], project.root, project.asWorker('coder'))
  assert.equal(result.code, 1)
  assert.match(result.err, /Workers can't run "enki dashboard"/)
  assert.match(project.enki(['dashboard']).out, /turned off/)
})

// Safety

test('the server answers only its own host name, has no CORS, and writes nothing but settings', async t => {
  const project = makeProject()
  const dash = dashboardFor(t, project)
  dash.run()
  assert.equal((await dash.get('/api/projects', { headers: { host: `evil.example:${dash.port}` } })).status, 403)
  assert.equal((await dash.get('/', { headers: { host: 'localhost' } })).status, 403)
  const ok = await dash.get('/api/projects', { headers: { origin: 'http://evil.example' } })
  assert.equal(ok.status, 200)
  assert.equal(Object.keys(ok.headers).some(name => name.startsWith('access-control-')), false)
  assert.equal((await dash.get('/api/shutdown', { method: 'POST' })).status, 403)
  assert.equal((await dash.get('/api/shutdown', { method: 'POST', headers: { 'x-enki-token': 'wrong' } })).status, 403)
  assert.equal((await dash.get('/api/projects', { method: 'PUT' })).status, 405)
  assert.ok(await dash.health(), 'still running')
  const page = await dash.get('/')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /default-src 'self'/)
  assert.equal((await dash.get('/app.js')).status, 200)
  assert.equal((await dash.get('/../server.mjs')).status, 404)
})

// What it shows

test('context windows follow the model', () => {
  for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-sonnet-4-5[1m]']) {
    assert.equal(windowFor(model), 1000000, model)
  }
  for (const model of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-opus-4-1', null]) assert.equal(windowFor(model), 200000, String(model))
  assert.equal(windowFor('claude-haiku-4-5', 250000), 1000000, 'a session past 200k had the larger window')
})

test('the scout and orchestrator steps are done without anyone ticking them', () => {
  const project = makeProject({ repos: [{ path: 'web', test: ['true'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }] })
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  project.approve()
  const steps = () => Object.fromEntries(project.state('demo').steps.map(step => [step.n, step.status]))
  assert.equal(steps()[1], 'done', 'the scout reported before the plan existed')
  assert.equal(steps()[6], 'todo')
  assert.equal(project.enki(['phase', 'done', '--abandon']).code, 0)
  assert.equal(steps()[6], 'todo', 'an abandoned task did not do its report')
})

test('the task view follows agents, steps, tokens and activity', async t => {
  const project = makeProject({ repos: [{ path: 'web', test: ['true'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }] })
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  project.write(join(project.taskDir('demo'), 'requirements.md'), '# Requirements\n\n## Goal\n\nShoppers see a cart page. It lists what they picked.\n')
  project.approve()
  assert.equal(project.enki(['team', 'start']).code, 0)
  project.report('demo', 'tests.md')
  const at = new Date().toISOString()
  transcript(project, 'session-coder-demo', [usageLine('c1', at, { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 40000, output_tokens: 900 })])
  transcript(project, 'session-orchestrator', [usageLine('o1', at, { input_tokens: 10, cache_creation_input_tokens: 500, cache_read_input_tokens: 9000, output_tokens: 300 }, 'claude-opus-5-5')])
  // Still working when the ask returns.
  project.herdr.script(script => {
    script.wait = { 'coder-demo': ['timeout'] }
  })
  assert.equal(project.enki(['ask', 'coder', project.brief()]).code, 4)
  project.hook('pre-tool-use', { tool_name: 'Edit', tool_input: { file_path: join(project.root, 'web/src/cart.js') } }, project.asWorker('coder'))
  project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: join(project.root, 'web/src/cart.js') } }, project.asWorker('coder'))

  const dash = dashboardFor(t, project)
  dash.run()
  const id = project.state('demo').id
  const detail = async () => (await dash.get(`/api/projects/proj1/tasks/${id}`)).json()

  let task = await detail()
  assert.equal(task.title, 'Shoppers see a cart page')
  assert.equal(task.status, 'running')
  const coder = task.agents.find(agent => agent.role === 'coder')
  assert.equal(coder.state, 'running')
  assert.deepEqual(coder.step, { n: 3, text: 'Implement', status: 'active' })
  assert.equal(coder.calls, 2)
  assert.equal(coder.spent, 3000)
  assert.equal(coder.context, 42100)
  assert.equal(coder.contextWindow, 1000000, 'Sonnet 5.5 has a 1M window')
  const lead = task.agents.find(agent => agent.role === 'orchestrator')
  assert.equal(lead.state, 'running')
  assert.equal(lead.spent, 810)
  assert.equal(lead.model, 'claude-opus-5-5')
  assert.equal(task.stats.spent, 3810)
  assert.equal(task.steps.find(step => step.n === 3).status, 'active')
  assert.ok(task.feed.some(item => item.role === 'coder' && /step 3, Implement: in progress/.test(item.text)))

  // A blocked agent needs the user, and says so.
  project.herdr.script((script, state) => {
    state.agents['tester-demo'].status = 'blocked'
  })
  assert.ok(await waitFor(async () => (await detail()).status === 'needs-you'))
  task = await detail()
  assert.equal(task.agents.find(agent => agent.role === 'tester').state, 'needs-you')
  assert.ok(task.alerts.some(alert => alert.word === 'Needs you:' && /Tester/.test(alert.text)))

  // A report finishes the step.
  project.herdr.script((script, state) => {
    state.agents['tester-demo'].status = 'idle'
  })
  assert.equal(project.enki(['wait', 'coder']).code, 0)
  assert.ok(await waitFor(async () => (await detail()).steps.find(step => step.n === 3).status === 'done'))
  // herdr is polled, so its state can trail the files by one poll.
  assert.ok(await waitFor(async () => (await detail()).agents.find(agent => agent.role === 'coder').state === 'done'))
  assert.equal((await detail()).stats.stepsDone, 2, 'the scout step and step 3')

  // A vanished agent on an open task is an error.
  project.herdr.script((script, state) => {
    state.agents['reviewer-demo'].gone = true
  })
  assert.ok(await waitFor(async () => (await detail()).agents.find(agent => agent.role === 'reviewer').state === 'error'))
})

test('settings save only from our own page, with its token, as JSON, over the latest file', async t => {
  const project = makeProject()
  mkdirSync(project.env.ENKI_HOME, { recursive: true })
  writeFileSync(join(project.env.ENKI_HOME, 'projects.json'), JSON.stringify({ proj1: { root: project.root, lastUsedAt: new Date().toISOString() } }))
  const dash = dashboardFor(t, project, { ENKI_CLAUDE_BIN: 'false' })
  dash.run()
  const origin = `http://localhost:${dash.port}`
  const { editToken } = (await dash.get('/api/session')).json()
  const read = (await dash.get('/api/projects/proj1/settings')).json()
  assert.equal(read.values.team.coder.model, 'claude-sonnet-5-5')
  assert.equal(read.options.models.source, 'enki', 'without Claude Code’s catalog, enki’s own list')
  assert.ok(read.options.models.models.some(model => model.id === 'claude-opus-5-5'))
  assert.equal((await dash.get('/api/projects/proj1/skills')).status, 200)
  assert.equal((await dash.get('/api/projects/nope/settings')).status, 404)

  const body = JSON.stringify({ base: read.hash, changes: { 'team.coder.model': 'claude-opus-5-5' } })
  const save = (headers, payload = body) => dash.get('/api/projects/proj1/settings', { method: 'POST', body: payload, headers: { 'content-type': 'application/json', origin, 'x-enki-edit': editToken, ...headers } })
  assert.equal((await save({ origin: 'http://evil.example' })).status, 403)
  assert.equal((await save({ origin: '' })).status, 403)
  assert.equal((await save({ 'x-enki-edit': 'wrong' })).status, 403)
  assert.equal((await save({ 'content-type': 'text/plain' })).status, 415)
  assert.equal((await save({}, 'x'.repeat(70 * 1024))).status, 413)
  assert.equal((await save({}, '{nope')).status, 400)
  assert.equal((await dash.get('/api/projects/nope/settings', { method: 'POST', body, headers: { 'content-type': 'application/json', origin, 'x-enki-edit': editToken } })).status, 404)
  const invalid = await save({}, JSON.stringify({ base: read.hash, changes: { 'team.coder.effort': 'huge', permissionMode: 'dontAsk' } }))
  assert.equal(invalid.status, 422)
  assert.deepEqual(invalid.json().problems.map(item => item.path), ['team.coder.effort', 'permissionMode'])
  const config = () => JSON.parse(readFileSync(join(project.root, '.enki/config.json'), 'utf8'))
  assert.equal(config().team, undefined, 'refused saves write nothing')

  const ok = await save({})
  assert.equal(ok.status, 200)
  assert.equal(config().team.coder.model, 'claude-opus-5-5')
  assert.equal((await save({})).status, 409, 'the page’s copy is now stale')
  assert.equal((await dash.get('/api/projects/proj1/settings', { method: 'PUT' })).status, 405)
})

test('the project view lists tasks, finished days and tokens by role', async t => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  const at = new Date().toISOString()
  transcript(project, 'session-orchestrator', [usageLine('o1', at, { input_tokens: 0, cache_creation_input_tokens: 700, cache_read_input_tokens: 0, output_tokens: 300 })])
  project.enki(['phase', 'done', '--abandon'])
  const dash = dashboardFor(t, project)
  dash.run()
  const list = (await dash.get('/api/projects')).json()
  assert.equal(list.projects.length, 1)
  assert.equal(list.projects[0].id, 'proj1')
  assert.equal(list.projects[0].tasks[0].status, 'abandoned')
  const detail = (await dash.get('/api/projects/proj1')).json()
  assert.equal(detail.tasks[0].spent, 1000)
  assert.equal(detail.heatmap.length, 53 * 7)
  assert.equal(detail.tokensByDay.length, 90)
  assert.equal(detail.tokensByDay.at(-1).roles.orchestrator, 1000)
  assert.equal(detail.heatmap.reduce((sum, day) => sum + day.count, 0), 0, 'abandoned tasks are not counted as finished')
  assert.equal(detail.settings, undefined, 'settings have their own page')
  assert.equal((await dash.get('/api/projects/nope')).status, 404)
  assert.equal((await dash.get('/api/projects/proj1/tasks/nope')).status, 404)
})

test('the orchestrator session is recorded at session start, for its bound task', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  assert.ok(project.events('demo').some(event => event.type === 'orchestrator.session' && event.data.session === 'session-orchestrator'))
  project.hook('session-start', { source: 'clear', session_id: 'after-clear' })
  assert.ok(project.events('demo').some(event => event.type === 'orchestrator.session' && event.data.session === 'after-clear' && event.data.source === 'clear'))
})

test('every tool call is logged for the dashboard, without changing the policy', () => {
  const project = makeProject()
  project.enki(['task', 'new', 'demo'])
  const allowed = project.hook('pre-tool-use', { tool_name: 'Grep', tool_input: { pattern: 'cart' } }, project.asWorker('scout'))
  assert.equal(allowed.json, null)
  const denied = project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'git push' } }, project.asWorker('coder'))
  assert.equal(denied.json.hookSpecificOutput.permissionDecision, 'deny')
  const log = readFileSync(join(project.taskDir('demo'), 'activity.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(log.map(entry => [entry.role, entry.tool]), [['scout', 'Grep'], ['coder', 'Bash']])
  assert.equal(log[1].target, 'git push')
})
