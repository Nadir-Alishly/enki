// A repo's memory: what enki has learned (its codebase map, map/, or notes.md before it has one), its commands (repo.json) and its team
// rules (playbook.md). It changes on a task's branch and reaches the base branch only when
// the code does. Two modes, one per project:
//   repo:    <repo>/.enki/, committed with the code. Git does everything.
//   private: .enki/memory/<repo>, a local bare repo whose branches mirror the code's,
//            for team repos where enki files mustn't be committed.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { configPath, loadConfig } from './config.mjs'
import { listTasks, writeJsonAtomic } from './state.mjs'
import { git, worktreesDir } from './worktrees.mjs'
import { STUB_ROOT, unmappedDir } from './map.mjs'

export const MEMORY_FILES = ['notes.md', 'repo.json', 'playbook.md']
const REPO_FIELDS_KEPT = ['path', 'name']

export class MemoryError extends Error {}

const safeName = name => name.replaceAll('/', '-')
export const memoryRepo = (root, name) => join(root, '.enki', 'memory', safeName(name))
const legacyNotes = (root, name) => join(root, '.enki', 'notes', `${name}.md`)

/** The project's mode, read straight from config.json so it's known before repos are layered in. */
export function memoryMode(root) {
  try {
    return JSON.parse(readFileSync(configPath(root), 'utf8')).memory ?? 'repo'
  } catch {
    return 'repo'
  }
}

/** Has this project moved to repo memory? Until then, the old shared layout stays in use. */
export function usesRepoMemory(root, repo) {
  try {
    if (JSON.parse(readFileSync(configPath(root), 'utf8')).memory !== undefined) return true
  } catch {
    return false
  }
  const dir = join(repo.main ?? repo.workdir, '.enki')
  return existsSync(join(dir, 'notes.md')) || existsSync(join(dir, 'repo.json'))
}

const currentBranch = dir => git(dir, ['branch', '--show-current'], { allowFail: true }) || null

/** Reads a memory file from a branch of a private memory repo, or null. */
function showFile(repoDir, branch, file) {
  if (!existsSync(repoDir)) return null
  const ref = git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) ? branch : 'HEAD'
  return git(repoDir, ['show', `${ref}:${file}`], { allowFail: true })
}

/** Outside a task: the memory of the branch you have checked out. */
export function readMainMemory(root, repo, file) {
  const main = join(root, repo.path)
  if (memoryMode(root) === 'private') {
    const branch = existsSync(main) ? currentBranch(main) : null
    return showFile(memoryRepo(root, repo.name ?? repo.path), branch ?? 'HEAD', file)
  }
  const path = join(main, '.enki', file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

/** Every file under a memory folder (`map`) on the checked-out branch, as { relative path: text }. */
export function readMainMemoryTree(root, repo, folder) {
  const main = join(root, repo.path)
  if (memoryMode(root) === 'private') {
    const dir = memoryRepo(root, repo.name ?? repo.path)
    if (!existsSync(dir)) return {}
    const branch = (existsSync(main) ? currentBranch(main) : null) ?? 'HEAD'
    const ref = git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }) ? branch : 'HEAD'
    const names = (git(dir, ['ls-tree', '-r', '--name-only', ref, '--', `${folder}/`], { allowFail: true }) ?? '').split('\n').filter(Boolean)
    return Object.fromEntries(names.map(name => [name.slice(folder.length + 1), showFile(dir, ref, name) ?? '']))
  }
  const base = join(main, '.enki', folder)
  const files = {}
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.isFile()) files[relative(base, path).split(sep).join('/')] = readFileSync(path, 'utf8')
    }
  }
  if (existsSync(base)) walk(base)
  return files
}

/** In a task: the task's own copy, on its branch. */
export function readTaskMemory(task, repo, file) {
  if (!repo.memoryDir) return null
  const path = join(repo.memoryDir, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

function repoJsonReader(read) {
  return repo => {
    const text = read(repo, 'repo.json')
    if (text === null) return null
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new MemoryError(`${repo.name ?? repo.path}: repo.json isn't valid JSON: ${error.message}`)
    }
  }
}

/** Project config, with each repo's repo.json from the checked-out branch layered on. */
export const loadProjectConfig = root => loadConfig(root, { repoJson: repoJsonReader((repo, file) => readMainMemory(root, repo, file)) })

/** Task config: each repo's repo.json from the task's branch. */
export function loadTaskConfig(task) {
  const byName = new Map(task.repos.map(repo => [repo.name, repo]))
  return loadConfig(task.projectRoot, {
    repoJson: repoJsonReader((repo, file) => {
      const own = byName.get(repo.name ?? repo.path)
      return own?.memoryDir ? readTaskMemory(task, own, file) : readMainMemory(task.projectRoot, repo, file)
    }),
  })
}

/** Notes for one repo in a task, falling back to the old shared file. */
export function taskNotesPath(task, repo) {
  return repo.memoryDir ? join(repo.memoryDir, 'notes.md') : legacyNotes(task.projectRoot, repo.name)
}

/** A playbook section from every level: the project's, then each repo's on the task branch. */
export function playbookTexts(task) {
  const texts = []
  const project = join(task.projectRoot, '.enki', 'playbook.md')
  const projectIsRepo = task.repos.some(repo => repo.memoryDir && join(repo.memoryDir, 'playbook.md') === project)
  if (existsSync(project) && !projectIsRepo) texts.push(readFileSync(project, 'utf8'))
  for (const repo of task.repos) {
    const text = readTaskMemory(task, repo, 'playbook.md')
    if (text !== null && !(projectIsRepo && join(repo.memoryDir, 'playbook.md') === project)) texts.push(text)
  }
  if (projectIsRepo) texts.unshift(readFileSync(project, 'utf8'))
  return texts
}

// Private mode: a bare repo per code repo, written with plumbing so nothing is checked out.

function identityEnv(codeDir) {
  const name = git(codeDir, ['config', 'user.name'], { allowFail: true })
  const email = git(codeDir, ['config', 'user.email'], { allowFail: true })
  return { ...(name ? { GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name } : {}), ...(email ? { GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email } : {}) }
}

function gitEnv(dir, args, env, input) {
  try {
    return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env }, input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    throw new MemoryError(`git ${args.join(' ')} failed: ${String(error.stderr || error.message).trim().slice(0, 500)}`)
  }
}

/** Writes `files` ({'map/README.md': text}) as a tree, one mktree per folder, and returns its id. */
function writeTree(dir, files) {
  const blobs = []
  const folders = new Map()
  for (const [file, text] of Object.entries(files)) {
    const [head, ...rest] = file.split('/')
    if (rest.length === 0) blobs.push(`100644 blob ${gitEnv(dir, ['hash-object', '-w', '--stdin'], {}, text)}\t${head}`)
    else folders.set(head, { ...folders.get(head), [rest.join('/')]: text })
  }
  const entries = [...blobs, ...[...folders].map(([name, inner]) => `040000 tree ${writeTree(dir, inner)}\t${name}`)]
  return gitEnv(dir, ['mktree'], {}, entries.length > 0 ? `${entries.join('\n')}\n` : '')
}

/** Creates the bare memory repo, with one commit of `files` on `branch`. */
export function initPrivateRepo({ root, name, branch, files, codeDir }) {
  const dir = memoryRepo(root, name)
  if (existsSync(dir)) throw new MemoryError(`${dir} already exists.`)
  mkdirSync(dir, { recursive: true })
  gitEnv(dir, ['init', '-q', '--bare', `--initial-branch=${branch}`], {})
  const tree = writeTree(dir, files)
  const commit = gitEnv(dir, ['commit-tree', tree, '-m', 'enki memory'], identityEnv(codeDir))
  gitEnv(dir, ['update-ref', `refs/heads/${branch}`, commit], {})
  return dir
}

/** Keeps .enki out of the team's git, through the clone's own exclude file, never .gitignore. */
export function hideEnkiFromGit(root, codeDir) {
  const top = git(codeDir, ['rev-parse', '--show-toplevel'], { allowFail: true })
  if (!top) return
  const enkiDir = join(root, '.enki')
  const inside = relative(top, enkiDir)
  if (inside.startsWith('..') || inside.startsWith(sep)) return // .enki is outside this repo.
  const exclude = join(git(top, ['rev-parse', '--git-common-dir']).replace(/^(?!\/)/, `${top}/`), 'info', 'exclude')
  mkdirSync(join(exclude, '..'), { recursive: true })
  const pattern = `/${inside.split(sep).join('/')}/`
  const lines = existsSync(exclude) ? readFileSync(exclude, 'utf8').split('\n') : []
  if (!lines.includes(pattern)) writeFileSync(exclude, `${[...lines.filter(Boolean), pattern].join('\n')}\n`)
}

const branchExists = (dir, branch) => Boolean(git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }))
const defaultBranch = dir => git(dir, ['symbolic-ref', '--short', 'HEAD'], { allowFail: true })

/** The memory branch matching a code branch, created from memory's default if it's new. */
function ensureBranch(dir, branch) {
  if (branchExists(dir, branch)) return null
  const from = defaultBranch(dir)
  git(dir, ['branch', branch, from])
  return `Memory had no branch "${branch}" yet, so it was started from "${from}".`
}

/** At task start, private mode: a memory checkout on branch <slug>, from the code's base branch. */
export function checkoutTaskMemory({ root, slug, repo, baseBranch }) {
  const dir = memoryRepo(root, repo.name)
  if (!existsSync(dir)) throw new MemoryError(`${repo.name} has no private memory yet. Run: enki migrate --memory private`)
  const note = ensureBranch(dir, baseBranch)
  const path = join(worktreesDir(root), slug, `${safeName(repo.name)}.memory`)
  git(dir, ['worktree', 'add', '-q', '-b', slug, path, baseBranch])
  return { path, note }
}

const trailer = (message, key) => new RegExp(`^${key}: (.+)$`, 'm').exec(message)?.[1] ?? null

/**
 * At the end, private mode: commits the task's memory with the code commit it belongs to.
 * With no code commit to wait for, a memory change goes straight onto the base branch.
 */
export function finishTaskMemory({ root, slug, repo, codeCommit, codeTop, baseBranch, message, abandon }) {
  const dir = memoryRepo(root, repo.name)
  const path = repo.memoryDir
  if (!path || !existsSync(path)) return null
  git(path, ['add', '-A'])
  const staged = git(path, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
  let result
  if (staged.length === 0) {
    result = `${repo.name}: no memory changes.`
  } else {
    const trailers = [`Enki-Code-Branch: ${slug}`, ...(codeCommit ? [`Enki-Code-Commit: ${codeCommit}`, `Enki-Code-Repo: ${codeTop}`] : [])]
    gitEnv(path, ['commit', '-q', '-m', `${message}\n\n${trailers.join('\n')}`], identityEnv(codeTop ?? repo.main))
    if (codeCommit) {
      // Keeps the code commit alive after the code branch is deleted. Only branches are pushed by default.
      git(codeTop, ['update-ref', `refs/enki/tasks/${slug}`, codeCommit])
      result = `${repo.name}: memory committed to memory branch ${slug}. It reaches ${baseBranch} once the code does.`
    } else if (!abandon) {
      result = null
    } else {
      result = `${repo.name}: memory kept on memory branch ${slug}, as the task was abandoned.`
    }
  }
  git(dir, ['worktree', 'remove', '--force', path])
  if (staged.length === 0) {
    git(dir, ['branch', '-D', slug], { allowFail: true })
    return result
  }
  if (result === null) {
    // Memory changed but the code didn't: there's no merge to wait for, so it applies now.
    const merged = mergeInto({ root, dir, name: repo.name, target: baseBranch, branch: slug, codeDir: repo.main })
    return merged.conflict ? merged.message : `${repo.name}: memory changed with no code change, so it went straight onto ${baseBranch}.${merged.note}`
  }
  return result
}

const syncState = (root, name) => join(root, '.enki', 'memory', `${safeName(name)}.sync.json`)

/** A merge's conflicted files, each with the stages git has for it: 1 the base, 2 ours, 3 theirs. */
function conflicts(path) {
  const files = new Map()
  for (const line of (git(path, ['ls-files', '-u', '-z'], { allowFail: true }) ?? '').split('\0').filter(Boolean)) {
    const [, sha, stage, file] = /^\d+ (\w+) (\d)\t(.+)$/s.exec(line)
    files.set(file, { ...files.get(file), [stage]: sha })
  }
  return files
}

/**
 * A branch from before the map changed the old notes, and the map has since replaced them: git calls
 * that a conflict, as one side deleted the file. The notes stay deleted, and what the branch changed
 * in them is kept in unmapped/, for the next task to fold into the map. Returns the files it settled.
 */
function settleOldNotes(path, branch) {
  if (!existsSync(join(path, 'map', 'README.md'))) return []
  const settled = [...conflicts(path)].filter(([file, stage]) => /^notes(\.md$|\/)/.test(file) && stage[1] && Boolean(stage[2]) !== Boolean(stage[3]))
  if (settled.length === 0) return []
  const changes = settled.map(([file, stage]) => {
    const diff = git(path, ['diff', '--no-color', '--no-ext-diff', '-U0', stage[1], stage[2] ?? stage[3]])
    return `## ${file}\n\n${diff.slice(diff.indexOf('\n@@') + 1).replace(/^(@@ .*? @@).*$/gm, '$1')}\n`
  })
  const note = join(unmappedDir(path), `${safeName(branch)}.md`)
  mkdirSync(dirname(note), { recursive: true })
  writeFileSync(note, `# Not in the map yet\n\nWhat these old notes gained (+) and lost (-) beside the map, which replaced them. Merged with ${branch}.\n\n${changes.join('\n')}`)
  for (const [file] of settled) git(path, ['rm', '-q', '-f', '--', file])
  git(path, ['add', '--', relative(path, note)])
  return settled.map(([file]) => file)
}

const settledNote = (settled, branch) => (settled.length ? ` The map replaced ${settled.join(', ')}, so what changed there is in unmapped/${safeName(branch)}.md, to fold into the map.` : '')

/** Merges memory branch `branch` into `target` in a temporary checkout. A conflict is left for you. */
function mergeInto({ root, dir, name, target, branch, codeDir }) {
  ensureBranch(dir, target)
  const path = join(worktreesDir(root), 'memory-sync', safeName(name))
  rmSync(path, { recursive: true, force: true })
  git(dir, ['worktree', 'prune'])
  git(dir, ['worktree', 'add', '-q', path, target])
  let settled = []
  try {
    gitEnv(path, ['merge', '--no-edit', '-q', branch], identityEnv(codeDir))
  } catch {
    settled = settleOldNotes(path, branch)
    if (settled.length > 0 && conflicts(path).size === 0) gitEnv(path, ['commit', '-q', '--no-edit'], identityEnv(codeDir))
    else {
      writeJsonAtomic(syncState(root, name), { branch, target, path })
      return { conflict: true, message: `${name}: memory from ${branch} conflicts with ${target}. Resolve the files in ${path}, then run enki memory sync again.` }
    }
  }
  git(dir, ['worktree', 'remove', '--force', path])
  return { conflict: false, note: settledNote(settled, branch) }
}

/** Finishes a merge the user resolved, or reports that it's still waiting. */
function resumePending(root, name, dir, codeDir) {
  const file = syncState(root, name)
  if (!existsSync(file)) return null
  const pending = JSON.parse(readFileSync(file, 'utf8'))
  if (!existsSync(pending.path)) {
    rmSync(file)
    return null
  }
  const settled = settleOldNotes(pending.path, pending.branch)
  // Git lists a file as conflicted until it's staged, so "resolved" means no conflict markers left. A file
  // one side deleted has no markers: it's resolved once it's gone, or staged to keep it.
  const unresolved = [...conflicts(pending.path)]
    .filter(([file, stage]) => existsSync(join(pending.path, file)) && (!stage[2] || !stage[3] || /^(<{7}|>{7}) /m.test(readFileSync(join(pending.path, file), 'utf8'))))
    .map(([file, stage]) => (stage[2] && stage[3] ? file : `${file} (deleted on one side: delete it, or git add it to keep it)`))
  if (unresolved.length > 0) return { blocked: true, message: `${name}: memory merge of ${pending.branch} still has conflicts in ${pending.path}: ${unresolved.join(', ')}` }
  git(pending.path, ['add', '-A'])
  gitEnv(pending.path, ['commit', '-q', '--no-edit'], identityEnv(codeDir))
  git(dir, ['worktree', 'remove', '--force', pending.path])
  rmSync(file)
  return { blocked: false, message: `${name}: finished merging memory from ${pending.branch}.${settledNote(settled, pending.branch)}` }
}

/** Has the code commit reached `branch`? By ancestry, or by the same patch (rebase, squash of one commit). */
function codeReached(codeTop, commit, branch) {
  if (git(codeTop, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true }) === null) return false // Gone, or another clone.
  if (git(codeTop, ['merge-base', '--is-ancestor', commit, branch], { allowFail: true }) !== null) return true
  const cherry = git(codeTop, ['cherry', branch, commit, `${commit}^`], { allowFail: true })
  return cherry !== null && cherry !== '' && cherry.split('\n').every(line => line.startsWith('-'))
}

/**
 * Brings each repo's memory up to date with a code branch, the one you have checked out unless
 * `target` names another: every task whose code has reached it gets its memory merged in.
 */
export function syncMemory(root, { only, target: into = null } = {}) {
  const config = loadConfig(root)
  const lines = []
  let blocked = false
  for (const repo of config.repos) {
    const dir = memoryRepo(root, repo.name)
    const codeDir = join(root, repo.path)
    if (!existsSync(dir)) continue
    const pending = resumePending(root, repo.name, dir, codeDir)
    if (pending) {
      lines.push(pending.message)
      if (pending.blocked) {
        blocked = true
        continue
      }
    }
    const target = into ?? currentBranch(codeDir)
    if (!target) continue
    const created = ensureBranch(dir, target)
    if (created) lines.push(`${repo.name}: ${created}`)
    const branches = git(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']).split('\n').filter(Boolean)
    for (const branch of branches) {
      if (branch === target || (only && branch !== only)) continue
      if (git(dir, ['merge-base', '--is-ancestor', branch, target], { allowFail: true }) !== null) continue
      const message = git(dir, ['log', '-1', '--format=%B', branch])
      const commit = trailer(message, 'Enki-Code-Commit')
      const codeTop = trailer(message, 'Enki-Code-Repo') ?? codeDir
      if (!commit) continue
      if (!only && !codeReached(codeTop, commit, target)) continue
      const merged = mergeInto({ root, dir, name: repo.name, target, branch, codeDir })
      if (merged.conflict) {
        lines.push(merged.message)
        blocked = true
        break
      }
      lines.push(`${repo.name}: merged memory from ${branch} into ${target}.${merged.note}`)
    }
  }
  return { lines, blocked }
}

/** Finished task branches the current code branch doesn't contain, for the migration warning. */
function unmergedTaskBranches(root, codeDir) {
  const branch = currentBranch(codeDir)
  if (!branch) return []
  return listTasks(root)
    .filter(task => task.phase === 'done')
    .flatMap(task => task.worktrees ?? [])
    .filter(tree => git(codeDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${tree.branch}`], { allowFail: true }))
    .filter(tree => git(codeDir, ['merge-base', '--is-ancestor', tree.branch, branch], { allowFail: true }) === null)
    .map(tree => tree.branch)
}

/** Moves a project's notes, repo settings and playbook into each repo's memory, in either mode. */
export function migrate(root, mode) {
  if (!['repo', 'private'].includes(mode)) throw new MemoryError('Use: enki migrate --memory repo|private')
  const raw = JSON.parse(readFileSync(configPath(root), 'utf8'))
  const repos = raw.repos ?? []
  const lines = []
  const projectPlaybook = join(root, '.enki', 'playbook.md')
  for (const repo of repos) {
    const name = repo.name ?? repo.path
    const codeDir = join(root, repo.path)
    const settings = Object.fromEntries(Object.entries(repo).filter(([key]) => !REPO_FIELDS_KEPT.includes(key)))
    // Old notes stay as notes.md until a map task folds them into the map; a new repo starts with an empty map.
    const memory = existsSync(legacyNotes(root, name)) ? { 'notes.md': readFileSync(legacyNotes(root, name), 'utf8') } : { 'map/README.md': STUB_ROOT(name) }
    const files = { ...memory, 'repo.json': `${JSON.stringify(settings, null, 2)}\n` }
    if (repos.length === 1 && existsSync(projectPlaybook)) files['playbook.md'] = readFileSync(projectPlaybook, 'utf8')
    const unmerged = existsSync(codeDir) ? unmergedTaskBranches(root, codeDir) : []
    if (unmerged.length > 0) {
      lines.push(`warning: ${name}'s old notes may include what these unmerged tasks learned: ${unmerged.join(', ')}. Check notes.md before it becomes your current branch's.`)
    }
    if (mode === 'repo') {
      const target = join(codeDir, '.enki')
      mkdirSync(target, { recursive: true })
      for (const [file, text] of Object.entries(files)) {
        if (existsSync(join(target, file)) && join(target, file) !== projectPlaybook) throw new MemoryError(`${join(target, file)} already exists. Nothing was changed for ${name}.`)
      }
      for (const [file, text] of Object.entries(files)) {
        mkdirSync(dirname(join(target, file)), { recursive: true })
        writeFileSync(join(target, file), text)
      }
      lines.push(`${name}: wrote ${Object.keys(files).join(', ')} to ${target}. Review them, then commit them to your current branch.`)
    } else {
      const branch = (existsSync(codeDir) && currentBranch(codeDir)) || 'main'
      initPrivateRepo({ root, name, branch, files, codeDir })
      hideEnkiFromGit(root, codeDir)
      lines.push(`${name}: created private memory at ${memoryRepo(root, name)}, on branch ${branch}. Nothing is added to the code repo.`)
    }
    if (existsSync(legacyNotes(root, name))) renameSync(legacyNotes(root, name), `${legacyNotes(root, name)}.migrated`)
    for (const key of Object.keys(settings)) delete repo[key]
  }
  if (repos.length === 1 && existsSync(projectPlaybook) && !(mode === 'repo' && repos[0].path === '.')) {
    renameSync(projectPlaybook, `${projectPlaybook}.migrated`)
  }
  raw.memory = mode
  writeJsonAtomic(configPath(root), raw)
  lines.push(`Set "memory": "${mode}" in .enki/config.json. Old files were renamed to *.migrated, not deleted.`)
  return lines
}
