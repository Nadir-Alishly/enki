// Repo memory that follows git, in both modes, against real git repositories.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { makeProject } from './helpers/harness.mjs'

const IDENTITY = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...IDENTITY } }).stdout.trim()

/**
 * A project with one or more git repos, each on `dev`. Repo settings start in config.json,
 * with old-style shared notes, so `enki migrate` has something to move.
 */
function project({ repos = ['web'], memory, extra = {} } = {}) {
  const p = makeProject({
    worktrees: true,
    ports: { from: 47600, to: 47699 },
    repos: repos.map(name => ({ path: name, test: ['true'], testGlobs: ['tests/**'], url: 'http://127.0.0.1:4321', devServer: { start: 'x' } })),
    ...extra,
  })
  for (const name of repos) {
    const dir = join(p.root, name)
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/app.js'), 'app\n')
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
    git(dir, 'init', '-q', '-b', 'dev')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'init')
    mkdirSync(join(p.root, '.enki/notes'), { recursive: true })
    writeFileSync(join(p.root, '.enki/notes', `${name}.md`), `# ${name} notes\n\nOriginal fact.\n`)
  }
  const enki = (args, env = {}) => p.enki(args, { ...IDENTITY, ...env })
  if (memory) {
    const result = enki(['migrate', '--memory', memory])
    assert.equal(result.code, 0, result.err)
    if (memory === 'repo') {
      for (const name of repos) {
        git(join(p.root, name), 'add', '-A')
        git(join(p.root, name), 'commit', '-qm', 'enki memory')
      }
    }
  }
  return { ...p, enki, repo: name => join(p.root, name) }
}

const taskRepo = (p, slug, name = 'web') => p.state(slug).repos.find(repo => repo.name === name)

function start(p, slug, pane = 'w1:a') {
  const result = p.enki(['task', 'new', slug], { HERDR_PANE_ID: pane })
  assert.equal(result.code, 0, result.err)
  return { HERDR_PANE_ID: pane }
}

/** Approve, test, review: everything the finish gate needs. */
function finish(p, slug, pane, { abandon = false } = {}) {
  if (!abandon) {
    p.write(join(p.taskDir(slug), 'scout.md'), 'x')
    p.enki(['phase', 'planning'], pane)
    p.hook('post-tool-use', { tool_name: 'ExitPlanMode', tool_response: { plan: '# Plan\n' } }, { ...IDENTITY, ...pane })
    assert.equal(p.enki(['team', 'start'], pane).code, 0)
    p.write(join(p.taskDir(slug), 'requirements.md'), `# Requirements\n\n## Goal\n\n${slug} work.\n`)
    p.write(join(p.taskDir(slug), 'tests.md'), 'x')
    assert.equal(p.enki(['verify'], pane).code, 0)
    p.write(join(p.taskDir(slug), 'qa-r1.md'), 'x')
    p.write(join(p.taskDir(slug), 'reviewer-r1.md'), 'x')
  }
  const result = p.enki(['phase', 'done', ...(abandon ? ['--abandon'] : [])], pane)
  assert.equal(result.code, 0, result.err)
  return result.out
}

/** A task that changes code and adds a line to its notes, as the orchestrator would. */
function taskWithNote(p, slug, pane, note, name = 'web') {
  const repo = taskRepo(p, slug, name)
  writeFileSync(join(repo.workdir, 'src', `${slug}.js`), `${slug}\n`)
  const notes = join(repo.memoryDir, 'notes.md')
  writeFileSync(notes, `${readFileSync(notes, 'utf8')}${note}\n`)
}

const decision = result => result.json?.hookSpecificOutput?.permissionDecision ?? null
const write = (p, path, env = {}) => decision(p.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: path, content: 'x' } }, env))

// Migration

test('repo mode: migrate moves notes and settings into the repo, for you to commit', () => {
  const p = project()
  const result = p.enki(['migrate', '--memory', 'repo'])
  assert.equal(result.code, 0, result.err)
  assert.match(readFileSync(join(p.repo('web'), '.enki/notes.md'), 'utf8'), /Original fact/)
  assert.deepEqual(JSON.parse(readFileSync(join(p.repo('web'), '.enki/repo.json'), 'utf8')).test, ['true'])
  const config = JSON.parse(readFileSync(join(p.root, '.enki/config.json'), 'utf8'))
  assert.deepEqual(config.repos, [{ path: 'web' }])
  assert.equal(config.memory, 'repo')
  assert.ok(existsSync(join(p.root, '.enki/notes/web.md.migrated')), 'the old file is kept, renamed')
  assert.match(git(p.repo('web'), 'status', '--porcelain'), /\.enki\//, 'left for you to review and commit')
  assert.equal(p.enki(['validate']).code, 0)
})

test('private mode: migrate creates a hidden memory repo and adds nothing to the code', () => {
  const p = project({ memory: 'private' })
  assert.equal(git(p.repo('web'), 'status', '--porcelain'), '')
  const memory = join(p.root, '.enki/memory/web')
  assert.equal(git(memory, 'rev-parse', '--is-bare-repository'), 'true')
  assert.match(git(memory, 'show', 'dev:notes.md'), /Original fact/)
  assert.deepEqual(JSON.parse(git(memory, 'show', 'dev:repo.json')).test, ['true'])
})

test('private mode: a repo at the project root hides .enki through the clone\'s own exclude file', () => {
  const p = makeProject({ worktrees: true, repos: [{ path: '.', test: ['true'] }] })
  writeFileSync(join(p.root, 'app.js'), 'x\n')
  git(p.root, 'init', '-q', '-b', 'dev')
  git(p.root, 'add', 'app.js')
  git(p.root, 'commit', '-qm', 'init')
  assert.equal(p.enki(['migrate', '--memory', 'private'], IDENTITY).code, 0)
  assert.match(readFileSync(join(p.root, '.git/info/exclude'), 'utf8'), /^\/\.enki\/$/m)
  assert.equal(git(p.root, 'status', '--porcelain'), '', 'the team sees nothing')
  assert.ok(!existsSync(join(p.root, '.gitignore')), 'no committed ignore file')
})

test('migrate warns about knowledge from unmerged task branches', () => {
  const p = project()
  const pane = start(p, 'cart-page')
  writeFileSync(join(taskRepo(p, 'cart-page').workdir, 'src/cart.js'), 'cart\n')
  finish(p, 'cart-page', pane)
  const result = p.enki(['migrate', '--memory', 'repo'])
  assert.match(result.out, /warning: web's old notes may include what these unmerged tasks learned: cart-page/)
})

test('an unmigrated project keeps its old shared notes, and never writes into the code repo', () => {
  const p = project()
  start(p, 'demo')
  assert.equal(taskRepo(p, 'demo').memoryDir, undefined)
  assert.match(readFileSync(join(p.taskDir('demo'), 'rules.md'), 'utf8'), new RegExp(`Notes: \`${join(p.root, '.enki/notes/web.md')}\``))
  assert.ok(!existsSync(join(taskRepo(p, 'demo').workdir, '.enki')))
})

// Repo mode

test('repo mode: a task reads its own branch\'s settings, not the main tree\'s', () => {
  const p = project({ memory: 'repo' })
  start(p, 'demo')
  const repoJson = join(taskRepo(p, 'demo').workdir, '.enki/repo.json')
  writeFileSync(repoJson, JSON.stringify({ test: ['echo branch-only-command; false'] }))
  const result = p.enki(['verify'], { HERDR_PANE_ID: 'w1:a' })
  assert.equal(result.code, 1)
  assert.match(result.out, /branch-only-command/)
  assert.deepEqual(JSON.parse(readFileSync(join(p.repo('web'), '.enki/repo.json'), 'utf8')).test, ['true'], 'the main tree is untouched')
})

test('repo mode: rules point at the task\'s notes', () => {
  const p = project({ memory: 'repo' })
  start(p, 'demo')
  const notes = join(taskRepo(p, 'demo').workdir, '.enki/notes.md')
  assert.ok(readFileSync(join(p.taskDir('demo'), 'rules.md'), 'utf8').includes(`Notes: \`${notes}\``))
})

test('repo mode: notes changes are committed with the code, and reach dev only through the merge', () => {
  const p = project({ memory: 'repo' })
  const pane = start(p, 'demo')
  taskWithNote(p, 'demo', pane, 'Learned in demo.')
  const out = finish(p, 'demo', pane)
  assert.match(out, /Committed 2 file\(s\) to branch demo/)
  assert.match(git(p.repo('web'), 'show', 'demo:.enki/notes.md'), /Learned in demo/)
  assert.doesNotMatch(readFileSync(join(p.repo('web'), '.enki/notes.md'), 'utf8'), /Learned in demo/, 'dev is unchanged')
  git(p.repo('web'), 'merge', '-q', '--no-edit', 'demo')
  assert.match(readFileSync(join(p.repo('web'), '.enki/notes.md'), 'utf8'), /Learned in demo/, 'the merge brings it')
})

test('repo mode: an abandoned task leaves dev\'s notes alone', () => {
  const p = project({ memory: 'repo' })
  const pane = start(p, 'demo')
  taskWithNote(p, 'demo', pane, 'Abandoned idea.')
  finish(p, 'demo', pane, { abandon: true })
  assert.doesNotMatch(readFileSync(join(p.repo('web'), '.enki/notes.md'), 'utf8'), /Abandoned idea/)
})

test('repo mode: uncommitted memory in the main tree stops a task, like any other change', () => {
  const p = project({ memory: 'repo' })
  writeFileSync(join(p.repo('web'), '.enki/notes.md'), 'edited but not committed\n')
  assert.match(p.enki(['task', 'new', 'demo']).err, /uncommitted changes.*\.enki\/notes\.md/s)
})

test('a root repo\'s memory files count as dirty, but enki\'s own files do not', () => {
  const p = makeProject({ worktrees: true, memory: 'repo', repos: [{ path: '.', test: ['true'] }] })
  writeFileSync(join(p.root, 'app.js'), 'x\n')
  writeFileSync(join(p.root, '.enki/notes.md'), 'notes\n')
  writeFileSync(join(p.root, '.enki/.gitignore'), 'tasks/\nworktrees/\n')
  git(p.root, 'init', '-q', '-b', 'dev')
  git(p.root, 'add', '-A')
  git(p.root, 'commit', '-qm', 'init')
  writeFileSync(join(p.root, '.enki/config.json'), readFileSync(join(p.root, '.enki/config.json'), 'utf8').replace('"memory"', '"memory" '))
  assert.equal(p.enki(['task', 'new', 'one'], { ...IDENTITY, HERDR_PANE_ID: 'w1:a' }).code, 0, 'config.json changes are ignored')
  writeFileSync(join(p.root, '.enki/notes.md'), 'changed\n')
  assert.match(p.enki(['task', 'new', 'two'], { ...IDENTITY, HERDR_PANE_ID: 'w1:b' }).err, /uncommitted changes.*\.enki\/notes\.md/s)
})

// Who may write memory

test('the orchestrator writes its own task\'s memory files, and nothing else in the worktree', () => {
  const p = project({ memory: 'repo' })
  start(p, 'one', 'w1:a')
  start(p, 'two', 'w1:b')
  const one = taskRepo(p, 'one')
  const orchestrator = { HERDR_PANE_ID: 'w1:a' }
  for (const file of ['notes.md', 'repo.json', 'playbook.md']) assert.equal(write(p, join(one.memoryDir, file), orchestrator), null, file)
  assert.equal(write(p, join(one.memoryDir, 'other.md'), orchestrator), 'deny')
  assert.equal(write(p, join(one.workdir, 'src/app.js'), orchestrator), 'deny')
  assert.equal(write(p, join(taskRepo(p, 'two').memoryDir, 'notes.md'), orchestrator), 'deny', 'another task')
  const main = p.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: join(p.repo('web'), '.enki/notes.md') } }, orchestrator)
  assert.equal(decision(main), 'deny', 'the main tree, during a task')
})

test('workers cannot write memory, in either mode', () => {
  for (const mode of ['repo', 'private']) {
    const p = project({ memory: mode })
    start(p, 'demo')
    const repo = taskRepo(p, 'demo')
    for (const role of ['coder', 'tester', 'qa', 'reviewer', 'scout']) {
      const result = p.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: join(repo.memoryDir, 'notes.md') } }, p.asWorker(role))
      assert.equal(decision(result), 'deny', `${mode} ${role}`)
      // Read-only roles are stopped by their own broader rule first.
      if (role === 'coder' || role === 'tester') assert.match(result.json.hookSpecificOutput.permissionDecisionReason, /belongs to the orchestrator/)
    }
  }
})

test('nobody edits the private memory repo directly', () => {
  const p = project({ memory: 'private' })
  assert.equal(write(p, join(p.root, '.enki/memory/web/HEAD')), 'deny')
})

// Private mode

test('private mode: a task\'s memory lands on its own memory branch, with the code commit recorded', () => {
  const p = project({ memory: 'private' })
  const pane = start(p, 'demo')
  taskWithNote(p, 'demo', pane, 'Learned in demo.')
  const out = finish(p, 'demo', pane)
  assert.match(out, /memory committed to memory branch demo/)
  const memory = join(p.root, '.enki/memory/web')
  assert.match(git(memory, 'show', 'demo:notes.md'), /Learned in demo/)
  assert.doesNotMatch(git(memory, 'show', 'dev:notes.md'), /Learned in demo/, 'not on dev yet')
  assert.match(git(memory, 'log', '-1', '--format=%B', 'demo'), new RegExp(`Enki-Code-Commit: ${git(p.repo('web'), 'rev-parse', 'demo')}`))
  assert.equal(git(p.repo('web'), 'show', '--name-only', '--format=', 'demo'), 'src/demo.js', 'no enki files in the code commit')
  assert.equal(git(p.repo('web'), 'rev-parse', 'refs/enki/tasks/demo'), git(p.repo('web'), 'rev-parse', 'demo'))
})

const memoryNotes = p => git(join(p.root, '.enki/memory/web'), 'show', 'dev:notes.md')

function finishedPrivateTask(slug = 'demo') {
  const p = project({ memory: 'private' })
  const pane = start(p, slug)
  taskWithNote(p, slug, pane, `Learned in ${slug}.`)
  finish(p, slug, pane)
  return p
}

for (const [how, mergeCode] of [
  ['a merge', p => git(p.repo('web'), 'merge', '-q', '--no-ff', '--no-edit', 'demo')],
  ['a fast-forward', p => git(p.repo('web'), 'merge', '-q', '--ff-only', 'demo')],
  ['a rebase', p => git(p.repo('web'), 'cherry-pick', '-x', 'demo')],
  [
    'a squash',
    p => {
      git(p.repo('web'), 'merge', '-q', '--squash', 'demo')
      git(p.repo('web'), 'commit', '-qm', 'squashed')
    },
  ],
]) {
  test(`private mode: memory follows ${how} into dev`, () => {
    const p = finishedPrivateTask()
    mergeCode(p)
    const result = p.enki(['memory', 'sync'])
    assert.equal(result.code, 0, result.err)
    assert.match(result.out, /merged memory from demo into dev/)
    assert.match(memoryNotes(p), /Learned in demo/)
  })
}

test('private mode: an unmerged task never syncs', () => {
  const p = finishedPrivateTask()
  assert.match(p.enki(['memory', 'sync']).out, /up to date/)
  assert.doesNotMatch(memoryNotes(p), /Learned in demo/)
})

test('private mode: an abandoned task never syncs', () => {
  const p = project({ memory: 'private' })
  const pane = start(p, 'demo')
  taskWithNote(p, 'demo', pane, 'Abandoned idea.')
  finish(p, 'demo', pane, { abandon: true })
  p.enki(['memory', 'sync'])
  assert.doesNotMatch(memoryNotes(p), /Abandoned idea/)
})

test('private mode: a deleted code branch still syncs after its merge', () => {
  const p = finishedPrivateTask()
  git(p.repo('web'), 'merge', '-q', '--no-ff', '--no-edit', 'demo')
  git(p.repo('web'), 'branch', '-D', 'demo')
  p.enki(['memory', 'sync'])
  assert.match(memoryNotes(p), /Learned in demo/)
})

test('private mode: starting a task syncs first, so it starts from merged memory', () => {
  const p = finishedPrivateTask('first')
  git(p.repo('web'), 'merge', '-q', '--no-ff', '--no-edit', 'first')
  start(p, 'second', 'w1:b')
  assert.match(readFileSync(join(taskRepo(p, 'second').memoryDir, 'notes.md'), 'utf8'), /Learned in first/)
})

test('private mode: a memory-only change goes straight onto the base branch', () => {
  const p = project({ memory: 'private' })
  const pane = start(p, 'demo')
  const notes = join(taskRepo(p, 'demo').memoryDir, 'notes.md')
  writeFileSync(notes, `${readFileSync(notes, 'utf8')}Start command learned.\n`)
  const out = finish(p, 'demo', pane)
  assert.match(out, /memory changed with no code change, so it went straight onto dev/)
  assert.match(memoryNotes(p), /Start command learned/)
})

test('private mode: a conflict stops with a path, and a rerun finishes it', () => {
  const p = project({ memory: 'private' })
  for (const [slug, pane] of [['one', 'w1:a'], ['two', 'w1:b']]) {
    start(p, slug, pane)
    const repo = taskRepo(p, slug)
    writeFileSync(join(repo.workdir, 'src', `${slug}.js`), `${slug}\n`)
    writeFileSync(join(repo.memoryDir, 'notes.md'), `# web notes\n\nThe fact is ${slug}.\n`)
    finish(p, slug, { HERDR_PANE_ID: pane })
  }
  git(p.repo('web'), 'merge', '-q', '--no-edit', 'one')
  git(p.repo('web'), 'merge', '-q', '--no-edit', 'two')
  const first = p.enki(['memory', 'sync'])
  assert.equal(first.code, 1)
  const path = /Resolve the files in (\S+), then/.exec(first.out)[1]
  assert.match(readFileSync(join(path, 'notes.md'), 'utf8'), /<<<<<<</)
  assert.match(p.enki(['memory', 'sync']).out, /still has conflicts/)
  assert.notEqual(p.enki(['task', 'new', 'three'], { HERDR_PANE_ID: 'w1:c' }).code, 0, 'no task starts from half-merged memory')
  writeFileSync(join(path, 'notes.md'), '# web notes\n\nThe facts are one and two.\n')
  const done = p.enki(['memory', 'sync'])
  assert.equal(done.code, 0, done.out)
  assert.match(done.out, /finished merging memory/)
  assert.match(memoryNotes(p), /one and two/)
})

test('private mode: enki memory merge takes a task\'s memory by hand', () => {
  const p = finishedPrivateTask()
  writeFileSync(join(p.repo('web'), 'src/other.js'), 'x\n')
  git(p.repo('web'), 'add', '-A')
  git(p.repo('web'), 'commit', '-qm', 'unrelated work mixed into the squash')
  assert.doesNotMatch(memoryNotes(p), /Learned in demo/)
  const result = p.enki(['memory', 'merge', 'demo'])
  assert.equal(result.code, 0, result.err)
  assert.match(memoryNotes(p), /Learned in demo/)
})

test('private mode: a new code branch gets memory from memory\'s default, and says so', () => {
  const p = project({ memory: 'private' })
  git(p.repo('web'), 'checkout', '-q', '-b', 'feature')
  const result = p.enki(['task', 'new', 'demo'])
  assert.equal(result.code, 0, result.err)
  assert.ok(p.events('demo')[0].data.memory.some(line => /no branch "feature" yet, so it was started from "dev"/.test(line)))
  assert.match(readFileSync(join(taskRepo(p, 'demo').memoryDir, 'notes.md'), 'utf8'), /Original fact/)
})

test('private mode needs worktrees', async () => {
  const { validateConfig, ConfigError } = await import('../src/config.mjs')
  assert.throws(() => validateConfig({ memory: 'private', worktrees: false }), ConfigError)
  assert.throws(() => validateConfig({ memory: 'shared' }), ConfigError)
})

// Several repos

for (const mode of ['repo', 'private']) {
  test(`${mode} mode: a task across two repos keeps each repo's memory to its own merge`, () => {
    const p = project({ repos: ['frontend', 'backend'], memory: mode })
    const pane = start(p, 'api')
    taskWithNote(p, 'api', pane, 'Frontend calls /api/cart.', 'frontend')
    taskWithNote(p, 'api', pane, 'Backend serves /api/cart in cents.', 'backend')
    finish(p, 'api', pane)
    git(p.repo('frontend'), 'merge', '-q', '--no-ff', '--no-edit', 'api')
    p.enki(['memory', 'sync'])
    const notes = name =>
      mode === 'repo' ? readFileSync(join(p.repo(name), '.enki/notes.md'), 'utf8') : git(join(p.root, '.enki/memory', name), 'show', 'dev:notes.md')
    assert.match(notes('frontend'), /Frontend calls \/api\/cart/)
    assert.doesNotMatch(notes('backend'), /Backend serves/, 'the backend branch is not merged')
  })
}

// Settings layering

test('a field in both config.json and repo.json is reported, and the repo wins', () => {
  const p = project({ memory: 'repo' })
  const config = JSON.parse(readFileSync(join(p.root, '.enki/config.json'), 'utf8'))
  config.repos[0].test = ['from-config']
  p.write(join(p.root, '.enki/config.json'), JSON.stringify(config))
  const result = p.enki(['validate'])
  assert.match(result.out, /warning: repos\[0\]\.test is set in both/)
})

test('repo.json cannot move a repo', () => {
  const p = project({ memory: 'repo' })
  p.write(join(p.repo('web'), '.enki/repo.json'), JSON.stringify({ path: 'elsewhere' }))
  assert.match(p.enki(['validate']).err, /repo\.json can't set "path"/)
})
