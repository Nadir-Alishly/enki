import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { makeProject } from './helpers/harness.mjs'

const freePort = () =>
  new Promise(resolve => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })

const serve = port => `node -e "require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')"`

async function setup(devServer, config = {}) {
  const port = await freePort()
  const start = devServer === 'default' ? { start: serve(port) } : devServer
  const project = makeProject({
    repos: [{ path: 'web', url: `http://127.0.0.1:${port}`, testGlobs: ['tests/**'], devServer: start }],
    timeouts: { server: 4000 },
    ports: { from: port, to: port },
    ...config,
  })
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  return { project, port }
}

const up = port => fetch(`http://127.0.0.1:${port}`).then(() => true, () => false)
const stop = project => project.enki(['server', 'stop'])

test('team start leaves the server to QA, and QA starts it in its own tab', async t => {
  const { project, port } = await setup('default')
  t.after(() => stop(project))
  project.approve()
  assert.equal(project.enki(['team', 'start']).code, 0)
  assert.equal(project.herdr.calls('pane', 'run').length, 0)
  const result = project.enki(['server', 'start'], project.asWorker('qa'))
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /web: started/)
  assert.ok(await up(port))
  const { tab, pane } = project.state('demo').servers.web
  assert.notEqual(tab, project.state('demo').herdr.tab)
  assert.equal(project.herdr.read().panes[pane].env.ENKI_ROLE, undefined)
  assert.ok(project.events('demo').some(event => event.type === 'server.started'))
})

test('the start command runs through sh, whatever the login shell is', async t => {
  const { project } = await setup('default')
  t.after(() => stop(project))
  project.enki(['server', 'start'])
  const script = join(project.taskDir('demo'), 'server-web.sh')
  assert.deepEqual(project.herdr.calls('pane', 'run')[0].slice(3), [`sh '${script}'`])
  assert.match(readFileSync(script, 'utf8'), /createServer/)
})

test('team start refuses until the start command is known', async () => {
  const { project } = await setup({})
  project.approve()
  const result = project.enki(['team', 'start'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /Nobody has recorded how to start web/)
  assert.equal(project.herdr.calls('agent', 'start').length, 1)
})

test('a learned command in config lets the team start', async t => {
  const { project, port } = await setup({})
  t.after(() => stop(project))
  project.approve()
  assert.notEqual(project.enki(['team', 'start']).code, 0)
  const path = join(project.root, '.enki/config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.repos[0].devServer.start = serve(port)
  project.write(path, JSON.stringify(config))
  assert.equal(project.enki(['team', 'start']).code, 0)
  assert.equal(project.enki(['server', 'start']).code, 0)
  assert.ok(await up(port))
})

test('with no QA, the start command is not needed', async () => {
  const { project } = await setup({})
  project.approve('# Plan\n\nQA: none\n')
  assert.equal(project.enki(['team', 'start']).code, 0)
})

test('a user-managed server is left alone', async () => {
  const { project } = await setup({ managedBy: 'user' })
  project.approve()
  assert.equal(project.enki(['team', 'start']).code, 0)
  assert.equal(project.herdr.calls('pane', 'run').length, 0)
  assert.match(project.enki(['server', 'start']).err, /managed by the user/)
})

test('restart replaces the server', async t => {
  const { project, port } = await setup('default')
  t.after(() => stop(project))
  assert.equal(project.enki(['server', 'start']).code, 0)
  const first = project.state('demo').servers.web.tab
  const result = project.enki(['server', 'restart'])
  assert.equal(result.code, 0, result.err)
  assert.notEqual(project.state('demo').servers.web.tab, first)
  assert.ok(await up(port))
})

test('restart with nothing running just starts it', async t => {
  const { project, port } = await setup('default')
  t.after(() => stop(project))
  const result = project.enki(['server', 'restart'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /web: started/)
  assert.ok(await up(port))
})

test('starting twice does not start a second server', async t => {
  const { project } = await setup('default')
  t.after(() => stop(project))
  project.enki(['server', 'start'])
  assert.match(project.enki(['server', 'start']).out, /running at/)
  assert.equal(project.herdr.calls('pane', 'run').length, 1)
})

test('a server enki did not start is used but never stopped', async t => {
  const { project, port } = await setup('default')
  const other = makeProject()
  const { spawn } = await import('node:child_process')
  const child = spawn('sh', ['-c', `exec ${serve(port)}`], { stdio: 'ignore' })
  t.after(() => child.kill())
  for (let i = 0; i < 40 && !(await up(port)); i++) await new Promise(done => setTimeout(done, 50))
  assert.match(project.enki(['server', 'start']).out, /not started by enki/)
  assert.equal(project.herdr.calls('pane', 'run').length, 0)
  assert.match(project.enki(['server', 'stop']).err, /wasn't started by enki/)
  assert.match(project.enki(['server', 'restart']).err, /wasn't started by enki/)
  assert.ok(await up(port))
  assert.ok(other)
})

test('a failed start reports the output, closes its tab and records the failure', async () => {
  const { project } = await setup({ start: 'exit 1' }, { timeouts: { server: 700 } })
  const result = project.enki(['server', 'start'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /didn't bring web up/)
  assert.match(result.err, /server log line/)
  assert.equal(project.state('demo').servers.web, undefined)
  assert.equal(project.herdr.calls('tab', 'close').length, 1)
  assert.ok(project.events('demo').some(event => event.type === 'server.failed'))
})

test('a start command without {port} gets a hint when it fails', async () => {
  const { project } = await setup({ start: 'exit 1' }, { timeouts: { server: 700 } })
  const result = project.enki(['server', 'start'])
  assert.match(result.err, /this start command has no \{port\} in it/)
  assert.match(result.err, /npm run dev -- --port \{port\} --strictPort/)
  assert.match(result.err, /bin\/rails server -p \{port\}/)
})

test('a start command with {port} gets no port hint', async () => {
  const { project } = await setup({ start: 'exit 1 # {port}' }, { timeouts: { server: 700 } })
  assert.doesNotMatch(project.enki(['server', 'start']).err, /has no \{port\}/)
})

test('validate and doctor warn about a start command without {port}', () => {
  const project = makeProject({ repos: [
    { path: 'web', url: 'http://localhost:4321', devServer: { start: 'npm run dev' } },
    { path: 'api', url: 'http://localhost:8000', devServer: { start: 'python manage.py runserver {port}' } },
    { path: 'own', url: 'http://localhost:9000', devServer: { managedBy: 'user', start: 'npm run dev' } },
  ] })
  const result = project.enki(['validate'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /warning: web: devServer\.start has no \{port\}.*reads the PORT variable/)
  assert.doesNotMatch(result.out, /warning: api/)
  assert.doesNotMatch(result.out, /warning: own/)
  assert.match(project.enki(['doctor']).out, /warning: web/)
})

test('a server that died is started again', async t => {
  const { project, port } = await setup('default')
  t.after(() => stop(project))
  project.enki(['server', 'start'])
  const { pane } = project.state('demo').servers.web
  process.kill(-project.herdr.read().panes[pane].pid, 'SIGTERM')
  for (let i = 0; i < 40 && (await up(port)); i++) await new Promise(done => setTimeout(done, 50))
  assert.match(project.enki(['server', 'start']).out, /started at/)
  assert.ok(await up(port))
})

test('finishing the task stops what it started', async () => {
  const { project, port } = await setup('default')
  project.approve()
  project.enki(['team', 'start'])
  project.enki(['server', 'start'])
  const result = project.enki(['phase', 'done', '--abandon'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /web: stopped/)
  assert.equal(await up(port), false)
})

/** A server that outlives its start command, like `docker compose up -d`. */
function daemon(project, port) {
  project.write(
    join(project.root, 'web/daemon.mjs'),
    `import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
const child = spawn(process.execPath, ['-e', "require('http').createServer((q,r)=>r.end('ok')).listen(${port},'127.0.0.1')"], { detached: true, stdio: 'ignore' })
child.unref()
writeFileSync('daemon.pid', String(child.pid))
`,
  )
}

const killDaemon = project => {
  try {
    process.kill(Number(readFileSync(join(project.root, 'web/daemon.pid'), 'utf8')))
  } catch {}
}

test('devServer.stop stops a server that runs in the background', async t => {
  const { project, port } = await setup({ start: 'node daemon.mjs', stop: 'kill $(cat daemon.pid)' })
  t.after(() => killDaemon(project))
  daemon(project, port)
  assert.equal(project.enki(['server', 'start']).code, 0)
  assert.ok(await up(port))
  const result = project.enki(['server', 'stop'])
  assert.equal(result.code, 0, result.err)
  assert.equal(await up(port), false)
})

test('restart works for a background server', async t => {
  const { project, port } = await setup({ start: 'node daemon.mjs', stop: 'kill $(cat daemon.pid)' })
  t.after(() => killDaemon(project))
  daemon(project, port)
  project.enki(['server', 'start'])
  const result = project.enki(['server', 'restart'])
  assert.equal(result.code, 0, result.err)
  assert.ok(await up(port))
})

test('a background server with no stop command says how to fix it', async t => {
  const { project, port } = await setup({ start: 'node daemon.mjs' }, { timeouts: { server: 1500 } })
  t.after(() => killDaemon(project))
  daemon(project, port)
  assert.equal(project.enki(['server', 'start']).code, 0)
  const result = project.enki(['server', 'stop'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /still responds/)
  assert.match(result.err, /set devServer\.stop/)
})

test('a failing stop command is reported, and the server still stops if closing its tab was enough', async t => {
  const { project, port } = await setup({ stop: 'exit 3' })
  t.after(() => stop(project))
  const path = join(project.root, '.enki/config.json')
  const config = JSON.parse(readFileSync(path, 'utf8'))
  config.repos[0].devServer.start = serve(port)
  project.write(path, JSON.stringify(config))
  project.enki(['server', 'start'])
  const result = project.enki(['server', 'stop'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /stopped, but "exit 3" reported/)
  assert.equal(await up(port), false)
})

test('a failed start cleans up with the stop command', async () => {
  const { project } = await setup({ start: 'exit 1', stop: 'touch cleaned.marker' }, { timeouts: { server: 700 } })
  assert.notEqual(project.enki(['server', 'start']).code, 0)
  assert.ok(existsSync(join(project.root, 'web/cleaned.marker')))
})

test('status reports up, down and who started it', async t => {
  const { project } = await setup('default')
  t.after(() => stop(project))
  assert.match(project.enki(['server', 'status']).out, /web: down at /)
  assert.doesNotMatch(project.enki(['server', 'status']).out, /started by/)
  project.enki(['server', 'start'])
  assert.match(project.enki(['server', 'status']).out, /up .*started by enki/)
})

test('QA runs servers through enki, and nobody runs them directly', async () => {
  const { project } = await setup('default')
  for (const role of ['tester', 'coder', 'scout', 'reviewer']) {
    assert.match(project.enki(['server', 'start'], project.asWorker(role)).err, /Workers can't/)
  }
  const direct = project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'npm run dev' } }, project.asWorker('qa'))
  assert.equal(direct.json.hookSpecificOutput.permissionDecision, 'deny')
})

test('other workers cannot control servers, directly or through enki', async () => {
  const { project } = await setup('default')
  const worker = project.asWorker('tester')
  assert.match(project.enki(['server', 'start'], worker).err, /Workers can't/)
  const direct = project.hook('pre-tool-use', { tool_name: 'Bash', tool_input: { command: 'npm run dev' } }, worker)
  assert.equal(direct.json.hookSpecificOutput.permissionDecision, 'deny')
  assert.match(direct.json.hookSpecificOutput.permissionDecisionReason, /enki server/)
})

test('a repo without a URL has nothing to manage', async () => {
  const project = makeProject({ repos: [{ path: 'web' }] })
  project.enki(['task', 'new', 'demo'])
  project.approve()
  assert.equal(project.enki(['team', 'start']).code, 0)
  assert.match(project.enki(['server', 'status']).out, /No repo in this task has a URL/)
})

test('usage errors', async () => {
  const { project } = await setup('default')
  assert.equal(project.enki(['server', 'dance']).code, 2)
  assert.equal(project.enki(['server', 'start', '--repo', 'nope']).code, 2)
})
