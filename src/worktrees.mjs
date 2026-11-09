// Each task works in its own git worktree, on its own branch, so tasks in one repo can run
// side by side. Enki makes the worktree, fills in what git doesn't carry (env files,
// dependency folders), and at the end commits the work to the branch and removes it.
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, sep } from 'node:path'
import { globToRegExp } from './policy.mjs'

export class WorktreeError extends Error {}

export function git(cwd, args, { allowFail = false } = {}) {
  try {
    // trimEnd, not trim: status output starts with a meaningful space.
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }).trimEnd()
  } catch (error) {
    if (allowFail) return null
    throw new WorktreeError(`git ${args.join(' ')} failed: ${String(error.stderr || error.message).trim().slice(0, 600)}`)
  }
}

export const worktreesDir = root => join(root, '.enki', 'worktrees')
const ROOT_MEMORY = new Set(['.enki/notes.md', '.enki/repo.json', '.enki/playbook.md'])

/** Groups the task's repos by the git repository they live in. One worktree per repository. */
function repositories(repos) {
  const groups = new Map()
  for (const repo of repos) {
    const top = git(repo.workdir, ['rev-parse', '--show-toplevel'], { allowFail: true })
    if (!top) throw new WorktreeError(`${repo.name} isn't in a git repository. Worktrees need git: run git init and commit, or set "worktrees": false in .enki/config.json.`)
    if (!groups.has(top)) groups.set(top, [])
    groups.get(top).push(repo)
  }
  return groups
}

/** Everything that would stop a worktree, checked before anything is created. */
export function checkRepositories({ root, repos, slug }) {
  const groups = repositories(repos)
  const enkiDir = join(root, '.enki')
  for (const top of groups.keys()) {
    const name = groups.get(top).map(repo => repo.name).join(', ')
    if (!git(top, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })) {
      throw new WorktreeError(`${name} has no commits yet. Make a first commit, then start the task.`)
    }
    const branch = git(top, ['branch', '--show-current'])
    if (!branch) throw new WorktreeError(`${name} isn't on a branch (detached HEAD). Check out the branch the task should build on.`)
    const dirty = git(top, ['status', '--porcelain', '--untracked-files=all'])
      .split('\n')
      .filter(Boolean)
      .map(line => line.slice(3))
      // .enki is enki's own, apart from a root repo's memory files, which the task would start without.
      .filter(path => !(join(top, path).startsWith(enkiDir + sep) || join(top, path) === enkiDir) || ROOT_MEMORY.has(relative(root, join(top, path))))
    if (dirty.length > 0) {
      const shown = dirty.slice(0, 10).join(', ') + (dirty.length > 10 ? `, and ${dirty.length - 10} more` : '')
      throw new WorktreeError(`${name} has uncommitted changes, and a task starts from the last commit. Commit or stash them first: ${shown}`)
    }
    if (git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${slug}`], { allowFail: true })) {
      throw new WorktreeError(`A branch called "${slug}" already exists in ${name}. Pick another task name, or delete that branch.`)
    }
  }
  return groups
}

/** Keeps git, and the user's git status, away from enki's worktrees. */
function ignoreWorktrees(root) {
  const path = join(root, '.enki', '.gitignore')
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : []
  if (!lines.includes('worktrees/')) writeFileSync(path, `${[...lines.filter(Boolean), 'worktrees/'].join('\n')}\n`)
}

/** Paths in `dir` that match a pattern such as ".env*" or "config/local.json". */
function matching(dir, pattern) {
  const folder = join(dir, dirname(pattern))
  if (!existsSync(folder)) return []
  const regex = globToRegExp(basename(pattern))
  return readdirSync(folder).filter(name => regex.test(name)).map(name => join(dirname(pattern), name).replace(/^\.\//, ''))
}

function fillIn(main, workdir, settings) {
  const copied = []
  const linked = []
  for (const pattern of settings.copy) {
    for (const path of matching(main, pattern)) {
      if (existsSync(join(workdir, path))) continue // The commit already has it.
      cpSync(join(main, path), join(workdir, path), { recursive: true })
      copied.push(path)
    }
  }
  for (const path of settings.link) {
    if (!existsSync(join(main, path)) || existsSync(join(workdir, path))) continue
    symlinkSync(join(main, path), join(workdir, path))
    linked.push(path)
  }
  return { copied, linked }
}

/** Creates the worktrees and returns the repos pointing at them. Undoes everything on failure. */
export function createWorktrees({ root, repos, slug, settingsFor }) {
  const groups = checkRepositories({ root, repos, slug })
  ignoreWorktrees(root)
  const created = []
  const worktrees = []
  const result = []
  try {
    for (const [top, members] of groups) {
      const path = join(worktreesDir(root), slug, basename(top))
      const branch = git(top, ['branch', '--show-current'])
      const commit = git(top, ['rev-parse', 'HEAD'])
      git(top, ['worktree', 'add', '-q', '-b', slug, path, branch])
      created.push({ top, path })
      worktrees.push({ top, path, branch: slug, base: { branch, commit } })
      for (const repo of members) {
        const workdir = join(path, relative(top, repo.workdir))
        result.push({ ...repo, main: repo.workdir, workdir, worktree: path, ...fillIn(repo.workdir, workdir, settingsFor(repo)) })
      }
    }
  } catch (error) {
    for (const { top, path } of created.reverse()) {
      git(top, ['worktree', 'remove', '--force', path], { allowFail: true })
      git(top, ['branch', '-D', slug], { allowFail: true })
    }
    throw error
  }
  return { repos: result, worktrees }
}

const ENV_FILE = /^\.env(\..*)?$/

const quote = value => (/^[\w./:@,+-]*$/.test(value) ? value : `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`)

/** Sets keys in the env files enki copied, so dotenv-style tools see the task's values. */
export function writeEnvFiles(repo, values) {
  if (Object.keys(values).length === 0) return
  for (const path of repo.copied ?? []) {
    if (!ENV_FILE.test(basename(path))) continue
    const file = join(repo.workdir, path)
    let text = readFileSync(file, 'utf8')
    for (const [key, value] of Object.entries(values)) {
      const line = `${key}=${quote(value)}`
      const pattern = new RegExp(`^(export\\s+)?${key}=.*$`, 'm')
      text = pattern.test(text) ? text.replace(pattern, line) : `${text.replace(/\n?$/, '\n')}${line}\n`
    }
    writeFileSync(file, text)
  }
}

/** For `Scope: deps`: the task gets its own install, instead of the main tree's. */
export function installDependencies(repo, command) {
  for (const path of repo.linked ?? []) rmSync(join(repo.workdir, path), { force: true })
  execFileSync('sh', ['-c', command], { cwd: repo.workdir, stdio: ['ignore', 'pipe', 'pipe'], timeout: 900000 })
}

function removeFilledIn(repos) {
  for (const repo of repos) {
    for (const path of [...(repo.copied ?? []), ...(repo.linked ?? [])]) {
      const full = join(repo.workdir, path)
      try {
        lstatSync(full)
        rmSync(full, { recursive: !lstatSync(full).isSymbolicLink(), force: true })
      } catch {
        // Already gone.
      }
    }
  }
}

function restoreFilledIn(repos) {
  for (const repo of repos) {
    for (const path of repo.copied ?? []) {
      if (!existsSync(join(repo.workdir, path))) cpSync(join(repo.main, path), join(repo.workdir, path), { recursive: true })
    }
    for (const path of repo.linked ?? []) {
      try {
        lstatSync(join(repo.workdir, path))
      } catch {
        symlinkSync(join(repo.main, path), join(repo.workdir, path))
      }
    }
  }
}

/**
 * Commits each worktree to its branch and removes it. Enki's own copies and links go first,
 * so a secret can't be committed. A failing git hook leaves everything as it was.
 */
export function finishWorktrees({ worktrees, repos, message, abandon = false }) {
  const results = []
  removeFilledIn(repos)
  for (const tree of worktrees) {
    if (!existsSync(tree.path)) continue
    git(tree.path, ['add', '-A'])
    const staged = git(tree.path, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean)
    if (staged.length === 0) {
      results.push({ ...tree, committed: false })
      continue
    }
    try {
      git(tree.path, ['commit', '-q', ...(abandon ? ['--no-verify'] : []), '-m', message])
    } catch (error) {
      git(tree.path, ['reset', '-q'], { allowFail: true })
      restoreFilledIn(repos)
      throw new WorktreeError(`The commit failed, so the task isn't finished and its worktree is unchanged. A git hook may have refused it.\n${error.message}`)
    }
    const fullCommit = git(tree.path, ['rev-parse', 'HEAD'])
    results.push({ ...tree, committed: true, commit: fullCommit.slice(0, 7), fullCommit, files: staged.length })
  }
  for (const tree of results) {
    git(tree.top, ['worktree', 'remove', tree.path])
    // A branch with nothing on it would only be clutter.
    if (!tree.committed) git(tree.top, ['branch', '-D', tree.branch], { allowFail: true })
  }
  return results
}

/** The commit subject: the task, and its goal from requirements.md if there is one. */
export function commitMessage({ slug, id, requirements, abandon }) {
  const subject = abandon ? `${slug}: WIP (abandoned)` : `${slug}: ${goalOf(requirements ?? '') ?? 'enki task'}`
  return `${subject.slice(0, 72)}\n\nEnki-Task: ${id}`
}

/** The goal, in order of preference: a Goal section, a "Goal:" line, then the title. */
export function goalOf(text) {
  const lines = text.split('\n').map(line => line.trim())
  const clean = line => line.replace(/^[#>*\s-]+/, '').trim()
  const section = lines.findIndex(line => /^#+\s*goal\b\s*$/i.test(line))
  if (section !== -1) {
    const first = lines.slice(section + 1).find(line => line && !line.startsWith('#'))
    if (first) return clean(first)
  }
  const inline = lines.find(line => /^[#>*\s-]*goal:\s*\S/i.test(line))
  if (inline) return clean(inline).replace(/^goal:\s*/i, '')
  const title = lines.find(line => /^#\s/.test(line))
  const named = title && clean(title).replace(/^requirements\b:?\s*/i, '')
  return named || null
}
