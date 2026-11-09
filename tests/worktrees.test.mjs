// Worktrees for parallel tasks, against real git repositories.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import test from 'node:test'
import { makeProject } from './helpers/harness.mjs'
import { allocatePorts } from '../src/ports.mjs'
import { changedSource } from '../src/checks.mjs'

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' }

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } })
  return result.stdout.trim()
}

/** A project shaped like test-website: the git repo is the `web` folder. */
function gitProject(config = {}, { branch = 'feature', commit = true } = {}) {
  const project = makeProject({
    worktrees: true,
    repos: [{ path: 'web', url: 'http://127.0.0.1:4321', test: ['true'], testGlobs: ['tests/**'], devServer: { start: 'serve --port {port}' } }],
    ports: { from: 47100, to: 47199 },
    ...config,
  })
  const web = join(project.root, 'web')
  writeFileSync(join(web, 'src/app.js'), 'app\n')
  writeFileSync(join(web, '.gitignore'), 'node_modules\n.env\n.env.*\n!.env.example\n')
  writeFileSync(join(web, '.env.example'), 'API_KEY=\n')
  git(web, 'init', '-q', '-b', branch)
  if (commit) {
    git(web, 'add', '-A')
    git(web, 'commit', '-qm', 'init')
  }
  writeFileSync(join(web, '.env'), 'SECRET=real-value\nPORT=3000\n')
  writeFileSync(join(web, '.env.local'), 'LOCAL=1\n')
  mkdirSync(join(web, 'node_modules/pkg'), { recursive: true })
  writeFileSync(join(web, 'node_modules/pkg/index.js'), '')
  const env = { ...IDENTITY }
  const enki = (args, extra = {}) => project.enki(args, { ...env, ...extra })
  return { ...project, web, enki, gitIn: (...args) => git(web, ...args) }
}

const worktreeOf = (project, slug = 'demo') => join(project.root, '.enki/worktrees', slug, 'web')

function started(config, options) {
  const project = gitProject(config, options)
  const result = project.enki(['task', 'new', 'demo'])
  assert.equal(result.code, 0, result.err)
  return project
}

/** Takes a task to the point it may finish: approved, tested, reviewed. */
function readyToFinish(project, plan = '# Plan\n', slug = 'demo', pane = {}) {
  project.write(join(project.taskDir(slug), 'scout.md'), 'x')
  project.enki(['phase', 'planning'], pane)
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan } }, { ...IDENTITY, ...pane })
  const team = project.enki(['team', 'start'], pane)
  assert.equal(team.code, 0, team.err)
  project.write(join(project.taskDir(slug), 'requirements.md'), '# Requirements\n\nGoal: say hello properly.\n')
  project.write(join(project.taskDir(slug), 'tests.md'), 'x')
  assert.equal(project.enki(['verify'], pane).code, 0)
  project.write(join(project.taskDir(slug), 'qa-r1.md'), 'x')
  project.write(join(project.taskDir(slug), 'reviewer-r1.md'), 'x')
}

// Refusals: nothing is created when any check fails

function refusedCleanly(project, pattern) {
  const result = project.enki(['task', 'new', 'demo'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, pattern)
  assert.ok(!existsSync(join(project.root, '.enki/worktrees/demo')), 'no worktree')
  assert.ok(!existsSync(join(project.base, 'herdr.json')), 'no tab')
  assert.equal(git(project.web, 'branch', '--list', 'demo'), '', 'no branch')
}

test('a repo with no commits is refused, naming the fix', () => {
  refusedCleanly(gitProject({}, { commit: false }), /no commits yet\. Make a first commit/)
})

test('uncommitted changes are refused, and listed', () => {
  const project = gitProject()
  writeFileSync(join(project.web, 'src/app.js'), 'changed\n')
  writeFileSync(join(project.web, 'src/new.js'), 'new\n')
  refusedCleanly(project, /uncommitted changes.*src\/app\.js.*src\/new\.js/s)
})

test('gitignored files and .enki changes do not count as dirty', () => {
  const project = gitProject({}, {})
  writeFileSync(join(project.web, '.env'), 'SECRET=changed\n')
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
})

test('an existing branch with the task name is refused', () => {
  const project = gitProject()
  git(project.web, 'branch', 'demo')
  const result = project.enki(['task', 'new', 'demo'])
  assert.match(result.err, /branch called "demo" already exists/)
})

test('a detached HEAD is refused', () => {
  const project = gitProject()
  git(project.web, 'checkout', '-q', '--detach')
  refusedCleanly(project, /detached HEAD/)
})

test('a folder that is not a git repo is refused, pointing at the setting', () => {
  const project = makeProject({ worktrees: true })
  const result = project.enki(['task', 'new', 'demo'])
  assert.match(result.err, /isn't in a git repository.*"worktrees": false/s)
})

// Creating the worktree

test('the task works in a worktree on its own branch, from the current branch', () => {
  const project = started()
  const tree = worktreeOf(project)
  const state = project.state('demo')
  assert.equal(state.repos[0].workdir, tree)
  assert.equal(state.repos[0].main, project.web)
  assert.equal(git(tree, 'branch', '--show-current'), 'demo')
  assert.equal(state.worktrees[0].base.branch, 'feature')
  assert.equal(state.worktrees[0].base.commit, git(project.web, 'rev-parse', 'HEAD'))
  assert.equal(git(project.web, 'status', '--porcelain'), '', 'the main tree is untouched')
})

test('the team works from the worktree', () => {
  const project = started()
  const fake = project.herdr.read()
  for (const pane of Object.values(fake.panes)) assert.equal(pane.cwd ?? worktreeOf(project), worktreeOf(project))
  assert.match(readFileSync(join(project.taskDir('demo'), 'rules.md'), 'utf8'), /Worktree on branch `demo`, from `feature`.*read-only/)
})

test('.enki/.gitignore keeps worktrees out of git', () => {
  const project = started()
  assert.match(readFileSync(join(project.root, '.enki/.gitignore'), 'utf8'), /^worktrees\/$/m)
})

test('env files are copied, tracked examples are not, and dependencies are linked', () => {
  const project = started()
  const tree = worktreeOf(project)
  assert.match(readFileSync(join(tree, '.env'), 'utf8'), /SECRET=real-value/)
  assert.ok(existsSync(join(tree, '.env.local')))
  assert.ok(lstatSync(join(tree, 'node_modules')).isSymbolicLink())
  assert.equal(readlinkSync(join(tree, 'node_modules')), join(project.web, 'node_modules'))
  assert.deepEqual(project.state('demo').repos[0].copied.sort(), ['.env', '.env.local'])
  assert.equal(git(tree, 'status', '--porcelain'), '', 'git sees none of it')
})

test('copy and link lists are configurable, per project and per repo', () => {
  const project = gitProject({ worktree: { copy: ['data/*.json'], link: [] } })
  mkdirSync(join(project.web, 'data'))
  writeFileSync(join(project.web, 'data/seed.json'), '{}')
  writeFileSync(join(project.web, '.gitignore'), 'node_modules\n.env\n.env.*\ndata/\n')
  git(project.web, 'commit', '-qam', 'ignore data')
  project.enki(['task', 'new', 'demo'])
  const tree = worktreeOf(project)
  assert.ok(existsSync(join(tree, 'data/seed.json')))
  assert.ok(!existsSync(join(tree, '.env')))
  assert.ok(!existsSync(join(tree, 'node_modules')))
})

// Ports

test('each task gets its own free port, and its URL follows', () => {
  const project = gitProject()
  project.enki(['task', 'new', 'one'], { HERDR_PANE_ID: 'w1:a' })
  project.enki(['task', 'new', 'two'], { HERDR_PANE_ID: 'w1:b' })
  const [one, two] = ['one', 'two'].map(slug => project.state(slug).repos[0])
  assert.notEqual(one.port, two.port)
  assert.equal(one.url, `http://127.0.0.1:${one.port}/`)
  assert.ok(one.port >= 47100 && one.port <= 47199)
})

test('a port something else is using is skipped', async t => {
  const blocker = createServer().listen(47200, '127.0.0.1')
  t.after(() => blocker.close())
  await new Promise(done => blocker.once('listening', done))
  const project = started({ ports: { from: 47200, to: 47201 } })
  assert.equal(project.state('demo').repos[0].port, 47201)
})

test('parallel allocations never hand out the same port', async () => {
  const project = makeProject()
  const dirs = [1, 2, 3, 4].map(n => join(project.base, `task-${n}`))
  process.env.ENKI_HOME = project.env.ENKI_HOME
  const results = await Promise.all(dirs.map(taskDir => allocatePorts({ taskDir, names: ['web'], from: 47300, to: 47320 })))
  const ports = results.map(result => result.web)
  assert.equal(new Set(ports).size, 4)
})

test('a full range says how to widen it', () => {
  const project = gitProject({ ports: { from: 47400, to: 47400 } })
  assert.equal(project.enki(['task', 'new', 'one'], { HERDR_PANE_ID: 'w1:a' }).code, 0)
  const second = project.enki(['task', 'new', 'two'], { HERDR_PANE_ID: 'w1:b' })
  assert.match(second.err, /No free port between 47400 and 47400/)
  assert.equal(git(project.web, 'branch', '--list', 'two'), '', 'its worktree and branch were undone')
})

test('a user-managed server keeps its own URL, and gets no port', () => {
  const project = started({ repos: [{ path: 'web', url: 'http://127.0.0.1:4321', devServer: { managedBy: 'user' } }] })
  assert.equal(project.state('demo').repos[0].url, 'http://127.0.0.1:4321')
})

test('the server is told its port by command and by PORT', async () => {
  const project = started({ timeouts: { server: 300 } })
  project.write(join(project.taskDir('demo'), 'scout.md'), 'x')
  await project.enki(['server', 'start'], { ...IDENTITY })
  const script = readFileSync(join(project.taskDir('demo'), 'server-web.sh'), 'utf8')
  const { port } = project.state('demo').repos[0]
  assert.match(script, new RegExp(`export PORT='${port}'`))
  assert.match(script, new RegExp(`serve --port ${port}$`, 'm'))
})

// Env overrides

test('env values fill in ports, and land in copied env files and worker panes', () => {
  const project = started({ worktree: { env: { PORT: '{port}', API_URL: 'http://127.0.0.1:{port:web}/api', TASK_NAME: 'app_{task}' } } })
  const { port } = project.state('demo').repos[0]
  const envFile = readFileSync(join(worktreeOf(project), '.env'), 'utf8')
  assert.match(envFile, new RegExp(`^PORT=${port}$`, 'm'), 'an existing key is replaced')
  assert.doesNotMatch(envFile, /PORT=3000/)
  assert.match(envFile, new RegExp(`^API_URL=http://127.0.0.1:${port}/api$`, 'm'))
  assert.match(envFile, /^TASK_NAME=app_demo$/m)
  assert.match(envFile, /SECRET=real-value/, 'other keys are kept')
  assert.match(readFileSync(join(project.web, '.env'), 'utf8'), /PORT=3000/, 'the main tree is untouched')
  const pane = Object.values(project.herdr.read().panes).find(item => item.env.ENKI_ROLE === 'coder')
  assert.equal(pane.env.API_URL, `http://127.0.0.1:${port}/api`)
})

test('a port placeholder for an unknown repo is an error', () => {
  const project = gitProject({ worktree: { env: { X: '{port:nope}' } } })
  assert.match(project.enki(['task', 'new', 'demo']).err, /no repo "nope"/)
})

// Databases

function databaseProject(plan) {
  const project = gitProject({
    database: {
      copy: 'echo copied {task} >> db.log',
      drop: 'echo dropped {task} >> db.log',
      env: { DATABASE_URL: 'postgres://localhost/app_{task}' },
    },
  })
  project.enki(['task', 'new', 'dark-mode'])
  project.write(join(project.taskDir('dark-mode'), 'scout.md'), 'x')
  project.enki(['phase', 'planning'])
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan } }, IDENTITY)
  return project
}

const dbLog = project => (existsSync(join(project.root, 'db.log')) ? readFileSync(join(project.root, 'db.log'), 'utf8') : '')
const envOf = project => readFileSync(join(worktreeOf(project, 'dark-mode'), '.env'), 'utf8')

test('Database: copy makes a copy at team start, points env at it, and drops it at the end', () => {
  const project = databaseProject('# Plan\n\nDatabase: copy\n')
  assert.equal(project.state('dark-mode').database, 'copy')
  assert.equal(project.enki(['team', 'start']).code, 0)
  assert.equal(dbLog(project), 'copied dark_mode\n')
  assert.match(envOf(project), /^DATABASE_URL=postgres:\/\/localhost\/app_dark_mode$/m)
  project.enki(['team', 'start'])
  assert.equal(dbLog(project), 'copied dark_mode\n', 'starting again does not copy twice')
  project.enki(['phase', 'done', '--abandon'])
  assert.equal(dbLog(project), 'copied dark_mode\ndropped dark_mode\n')
})

test('a missing Database line means copy', () => {
  assert.equal(databaseProject('# Plan\n').state('dark-mode').database, 'copy')
})

test('Database: none blanks the keys, so nothing reaches the real database', () => {
  const project = databaseProject('# Plan\n\nDatabase: none\n')
  project.enki(['team', 'start'])
  assert.equal(dbLog(project), '')
  assert.match(envOf(project), /^DATABASE_URL=$/m)
})

test('Database: shared leaves the env alone', () => {
  const project = databaseProject('# Plan\n\nDatabase: shared\n')
  project.enki(['team', 'start'])
  assert.equal(dbLog(project), '')
  assert.doesNotMatch(envOf(project), /DATABASE_URL/)
})

test('a failing database copy stops the team from starting', () => {
  const project = gitProject({ database: { copy: 'echo no such template >&2; exit 1' } })
  project.enki(['task', 'new', 'demo'])
  project.write(join(project.taskDir('demo'), 'scout.md'), 'x')
  project.enki(['phase', 'planning'])
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: '# Plan' } }, IDENTITY)
  const result = project.enki(['team', 'start'])
  assert.match(result.err, /no such template/)
  assert.equal(project.herdr.calls('agent', 'start', 'coder-demo').length, 0)
})

test('without a database section, the plan line is ignored', () => {
  const project = started()
  project.write(join(project.taskDir('demo'), 'scout.md'), 'x')
  project.enki(['phase', 'planning'])
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: 'Database: copy' } }, IDENTITY)
  assert.equal(project.state('demo').database, null)
})

// Dependencies

test('Scope: deps replaces the link with a real install', () => {
  const project = started({ worktree: { install: 'mkdir node_modules && touch node_modules/installed' } })
  project.write(join(project.taskDir('demo'), 'scout.md'), 'x')
  project.enki(['phase', 'planning'])
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: 'Scope: deps' } }, IDENTITY)
  assert.equal(project.enki(['team', 'start']).code, 0)
  const modules = join(worktreeOf(project), 'node_modules')
  assert.ok(!lstatSync(modules).isSymbolicLink())
  assert.ok(existsSync(join(modules, 'installed')))
  assert.ok(existsSync(join(project.web, 'node_modules/pkg')), 'the main tree keeps its own')
})

test('Scope: deps without an install command is refused', () => {
  const project = started()
  project.write(join(project.taskDir('demo'), 'scout.md'), 'x')
  project.enki(['phase', 'planning'])
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: 'Scope: deps' } }, IDENTITY)
  assert.match(project.enki(['team', 'start']).err, /worktree\.install isn't set/)
})

// Finishing

test('finishing commits to the branch, keeps secrets out, and removes the worktree', () => {
  const project = started()
  readyToFinish(project)
  const tree = worktreeOf(project)
  writeFileSync(join(tree, 'src/app.js'), 'hello properly\n')
  writeFileSync(join(tree, 'src/new.js'), 'new\n')
  const result = project.enki(['phase', 'done'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Committed 2 file\(s\) to branch demo .*from feature\. Review with: git diff feature\.\.\.demo/)
  assert.ok(!existsSync(tree), 'worktree removed')
  const files = git(project.web, 'show', '--name-only', '--format=', 'demo').split('\n').sort()
  assert.deepEqual(files, ['src/app.js', 'src/new.js'])
  assert.equal(git(project.web, 'log', '-1', '--format=%s', 'demo'), 'demo: say hello properly.')
  assert.match(git(project.web, 'log', '-1', '--format=%b', 'demo'), /Enki-Task: .*-demo/)
  assert.equal(git(project.web, 'rev-parse', 'feature'), project.state('demo').worktrees[0].base.commit, 'the base branch is unchanged')
  assert.equal(git(project.web, 'status', '--porcelain'), '')
  assert.equal(project.state('demo').phase, 'done')
})

test('nothing changed means no commit and no branch', () => {
  const project = started()
  readyToFinish(project)
  const result = project.enki(['phase', 'done'])
  assert.match(result.out, /Nothing changed, so branch demo was deleted/)
  assert.equal(git(project.web, 'branch', '--list', 'demo'), '')
})

test('a linked folder git can see is still not committed', () => {
  // With a `node_modules/` rule, git ignores the real folder but sees the link in its place.
  const project = gitProject()
  writeFileSync(join(project.web, '.gitignore'), 'node_modules/\n.env\n.env.*\n')
  git(project.web, 'commit', '-qam', 'folder-only ignore')
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  assert.match(git(worktreeOf(project), 'status', '--porcelain'), /node_modules/, 'git sees the link')
  readyToFinish(project)
  writeFileSync(join(worktreeOf(project), 'src/app.js'), 'changed\n')
  assert.equal(project.enki(['phase', 'done']).code, 0)
  assert.equal(git(project.web, 'show', '--name-only', '--format=', 'demo'), 'src/app.js')
  const report = project.state('demo').steps.find(step => step.owner === 'orchestrator')
  assert.equal(report.status, 'done', 'finishing the task finishes the orchestrator\'s own steps')
})

test('a git hook that refuses the commit leaves the task open and its worktree working', () => {
  const project = started()
  readyToFinish(project)
  const hook = join(project.web, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho lint says no >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  const tree = worktreeOf(project)
  writeFileSync(join(tree, 'src/app.js'), 'changed\n')
  const result = project.enki(['phase', 'done'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /lint says no/)
  assert.notEqual(project.state('demo').phase, 'done')
  assert.ok(existsSync(join(tree, 'src/app.js')))
  assert.ok(existsSync(join(tree, '.env')), 'copies are back')
  assert.ok(lstatSync(join(tree, 'node_modules')).isSymbolicLink(), 'links are back')
  assert.equal(git(tree, 'diff', '--cached', '--name-only'), '', 'nothing left staged')
})

test('a task can be abandoned before its plan is approved', () => {
  const project = started()
  assert.equal(project.enki(['phase', 'done', '--abandon']).code, 0)
  assert.ok(!existsSync(worktreeOf(project)))
})

test('abandoning commits the work as WIP, even past a failing hook', () => {
  const project = started()
  const hook = join(project.web, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  writeFileSync(join(worktreeOf(project), 'src/app.js'), 'half done\n')
  const result = project.enki(['phase', 'done', '--abandon'])
  assert.equal(result.code, 0, result.err)
  assert.equal(git(project.web, 'log', '-1', '--format=%s', 'demo'), 'demo: WIP (abandoned)')
  assert.ok(!existsSync(worktreeOf(project)))
})

test('finishing frees the task\'s ports', () => {
  const project = gitProject({ ports: { from: 47500, to: 47500 } })
  project.enki(['task', 'new', 'one'], { HERDR_PANE_ID: 'w1:a' })
  project.enki(['phase', 'done', '--abandon'], { HERDR_PANE_ID: 'w1:a' })
  assert.equal(project.enki(['task', 'new', 'two'], { HERDR_PANE_ID: 'w1:b' }).code, 0)
  assert.equal(project.state('two').repos[0].port, 47500)
})

// Two tasks in one repo

test('two tasks in one repo each get their own tree, branch and port, and finish separately', () => {
  const project = gitProject()
  const a = { HERDR_PANE_ID: 'w1:a' }
  const b = { HERDR_PANE_ID: 'w1:b' }
  assert.equal(project.enki(['task', 'new', 'one'], a).code, 0)
  assert.equal(project.enki(['task', 'new', 'two'], b).code, 0)
  writeFileSync(join(worktreeOf(project, 'one'), 'src/app.js'), 'from one\n')
  writeFileSync(join(worktreeOf(project, 'two'), 'src/app.js'), 'from two\n')
  readyToFinish(project, '# Plan\n', 'one', a)
  readyToFinish(project, '# Plan\n', 'two', b)
  assert.equal(project.enki(['phase', 'done'], a).code, 0)
  assert.equal(project.enki(['phase', 'done'], b).code, 0)
  assert.equal(git(project.web, 'show', 'one:src/app.js'), 'from one')
  assert.equal(git(project.web, 'show', 'two:src/app.js'), 'from two')
  assert.equal(readFileSync(join(project.web, 'src/app.js'), 'utf8'), 'app\n')
})

// What each role may touch

const decision = result => result.json?.hookSpecificOutput?.permissionDecision ?? null
const write = (project, path, env = {}) => decision(project.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: path, content: 'x' } }, env))

test('the coder writes in its own worktree, and nowhere else', () => {
  const project = gitProject()
  project.enki(['task', 'new', 'one'], { HERDR_PANE_ID: 'w1:a' })
  project.enki(['task', 'new', 'two'], { HERDR_PANE_ID: 'w1:b' })
  const coder = project.asWorker('coder', 'one')
  assert.equal(write(project, join(worktreeOf(project, 'one'), 'src/app.js'), coder), null)
  assert.equal(write(project, join(project.web, 'src/app.js'), coder), 'deny', 'the main tree')
  const other = project.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: join(worktreeOf(project, 'two'), 'src/app.js') } }, coder)
  assert.equal(decision(other), 'deny')
  assert.match(other.json.hookSpecificOutput.permissionDecisionReason, /another task's worktree/)
})

test('the orchestrator cannot edit a worktree', () => {
  const project = started()
  assert.equal(write(project, join(worktreeOf(project), 'src/app.js')), 'deny')
})

test('the coder\'s changes in a worktree are hidden from the tester', () => {
  const project = started()
  project.write(join(project.taskDir('demo'), 'scout.md'), 'x')
  project.enki(['phase', 'planning'])
  project.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: '# Plan' } }, IDENTITY)
  project.enki(['team', 'start'])
  const path = join(worktreeOf(project), 'src/app.js')
  writeFileSync(path, 'changed by the coder\n')
  const read = decision(project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: path } }, project.asWorker('tester')))
  assert.equal(read, 'deny')
  const unchanged = decision(project.hook('pre-tool-use', { tool_name: 'Read', tool_input: { file_path: join(worktreeOf(project), '.gitignore') } }, project.asWorker('tester')))
  assert.equal(unchanged, null)
})

test('a linked folder git can see does not break the blindness check', () => {
  const project = gitProject()
  writeFileSync(join(project.web, '.gitignore'), 'node_modules/\n.env\n.env.*\n')
  git(project.web, 'commit', '-qam', 'folder-only ignore')
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  const state = project.state('demo')
  assert.doesNotThrow(() => changedSource(state.repos, {}))
  assert.ok(changedSource(state.repos, {}).some(path => path.endsWith('node_modules')))
})

test('verify runs in the worktree, with the task\'s env', () => {
  const project = gitProject({ worktree: { env: { GREETING: 'from-task' } }, repos: [{ path: 'web', url: 'http://127.0.0.1:4321', test: ['test "$GREETING" = from-task && test -f src/only-in-task.js'], devServer: { start: 'x' } }] })
  project.enki(['task', 'new', 'demo'])
  writeFileSync(join(worktreeOf(project), 'src/only-in-task.js'), '')
  assert.equal(project.enki(['verify']).code, 0)
})

test('worktree, ports and database settings are validated', async () => {
  const { validateConfig, ConfigError } = await import('../src/config.mjs')
  const bad = [
    { worktrees: 'yes' },
    { ports: { from: 5000, to: 4000 } },
    { ports: { from: 80, to: 90 } },
    { worktree: { copy: ['../outside'] } },
    { worktree: { link: ['/abs'] } },
    { worktree: { env: { A: 1 } } },
    { worktree: { extra: true } },
    { database: { copy: 1 } },
    { database: { drop: 'x', other: 1 } },
    { repos: [{ path: 'web', worktree: { install: 5 } }] },
  ]
  for (const config of bad) assert.throws(() => validateConfig(config), ConfigError, JSON.stringify(config))
  validateConfig({ worktrees: true, ports: { from: 4400, to: 4410 }, worktree: { copy: ['.env*'], link: ['node_modules'], install: 'npm ci', env: { A: '{port}' } }, database: { copy: 'a', drop: 'b', env: { DB: 'c' } } })
})

test('init ignores worktrees', () => {
  const project = makeProject()
  const fresh = join(project.base, 'fresh')
  mkdirSync(fresh)
  spawnSync(process.execPath, [join(import.meta.dirname, '../bin/enki'), 'init'], { cwd: fresh, env: project.env })
  assert.match(readFileSync(join(fresh, '.enki/.gitignore'), 'utf8'), /worktrees\//)
})

test('the commit subject comes from the goal, never the "Requirements" title', async () => {
  const { goalOf } = await import('../src/worktrees.mjs')
  assert.equal(goalOf('# Requirements: glass-swatting minigame\n\n## Goal\n\nPlayers swat flies on the glass.\n'), 'Players swat flies on the glass.')
  assert.equal(goalOf('# Requirements\n\nGoal: say hello properly.\n'), 'say hello properly.')
  assert.equal(goalOf('# Requirements: dark mode\n\nSome text.\n'), 'dark mode')
  assert.equal(goalOf('# Requirements\n'), null)
  assert.equal(goalOf(''), null)
})
