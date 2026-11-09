// Facts enki works out for itself: what the coder changed, and whether the tests pass.
// Neither depends on an agent's report.
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, lstatSync, openSync, readFileSync, readlinkSync, writeSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { matchesGlobs } from './policy.mjs'

function dirtyFiles(workdir) {
  try {
    const output = execFileSync('git', ['ls-files', '-m', '-o', '--exclude-standard', '-z'], { cwd: workdir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return output.split('\0').filter(Boolean).map(file => join(workdir, file))
  } catch {
    return [] // Not a git repo: enki can't tell what changed.
  }
}

function hashOf(path) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return null
  }
  // A linked folder such as node_modules: its target is what matters, not its contents.
  if (stat.isSymbolicLink()) return `link:${readlinkSync(path)}`
  if (stat.isDirectory()) return 'dir'
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** The tree before coding starts, so the user's own uncommitted work isn't counted as the coder's. */
export function snapshotTree(repos) {
  const snapshot = {}
  for (const repo of repos) {
    for (const path of dirtyFiles(repo.workdir)) snapshot[path] = hashOf(path)
  }
  return snapshot
}

/** Source files that differ from the snapshot. Test files stay visible: they're the tester's own. */
export function changedSource(repos, snapshot) {
  const changed = []
  for (const repo of repos) {
    // Only the repo's own .enki folder: the worktree itself lives under the project's.
    const enkiDir = join(repo.workdir, '.enki') + sep
    for (const path of dirtyFiles(repo.workdir)) {
      if (path.startsWith(enkiDir)) continue
      if (matchesGlobs(relative(repo.workdir, path).split(sep).join('/'), repo.testGlobs ?? [])) continue
      if (snapshot[path] === undefined || snapshot[path] !== hashOf(path)) changed.push(path)
    }
  }
  return changed
}

function runCommand(command, cwd, logPath, timeout, env = {}) {
  return new Promise(done => {
    const log = openSync(logPath, 'a')
    writeSync(log, `\n$ ${command}\n`)
    const child = spawn('sh', ['-c', command], { cwd, stdio: ['ignore', log, log], detached: true, env: { ...process.env, ...env } })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }, timeout)
    const finish = code => {
      clearTimeout(timer)
      closeSync(log)
      done(timedOut ? 124 : (code ?? 1))
    }
    child.once('error', () => finish(127))
    child.once('close', finish)
  })
}

const tail = (path, lines) => readFileSync(path, 'utf8').trimEnd().split('\n').slice(-lines).join('\n')

/** Runs each repo's test, lint and gate commands. */
export async function runChecks({ repos, config, taskDir, label, timeout, envFor = () => ({}) }) {
  const results = []
  for (const repo of repos) {
    const source = config.repos.find(item => item.name === repo.name)
    const commands = [...source.test, ...source.lint, ...(source.gate?.commands ?? [])]
    const logPath = join(taskDir, `verify-${label}-${repo.name.replaceAll('/', '-')}.log`)
    for (const command of commands) {
      const code = await runCommand(command, repo.workdir, logPath, timeout, envFor(repo))
      results.push({ repo: repo.name, command, code, logPath, tail: code === 0 ? '' : tail(logPath, 20) })
    }
  }
  return results
}
