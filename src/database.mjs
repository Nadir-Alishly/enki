// A task's database, decided in its plan: its own copy, the shared one, or none at all.
import { execFileSync } from 'node:child_process'

export const DATABASE_MODES = ['copy', 'shared', 'none']

export class DatabaseError extends Error {}

/** `{task}` is the slug with underscores, so it works inside database names. */
export function fill(text, values) {
  return text.replace(/\{(task|port(?::([\w./-]+))?)\}/g, (match, key, repo) => {
    if (key === 'task') return values.task
    const port = repo ? values.ports[repo] : values.port
    if (port === undefined) throw new DatabaseError(`${match} has no port: ${repo ? `no repo "${repo}" in this task has a URL` : 'this repo has no URL'}.`)
    return String(port)
  })
}

export const taskToken = slug => slug.replaceAll('-', '_')

function run(command, cwd) {
  try {
    execFileSync('sh', ['-c', command], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 })
  } catch (error) {
    throw new DatabaseError(`"${command}" failed: ${String(error.stderr || error.message).trim().slice(0, 600)}`)
  }
}

/** The env values the plan's mode gives the task. */
export function databaseEnv(database, mode, values) {
  // Until the plan decides, enki writes nothing, so the decision is the plan's alone.
  if (!database || !mode || mode === 'shared') return {}
  const env = {}
  for (const [key, value] of Object.entries(database.env ?? {})) env[key] = mode === 'none' ? '' : fill(value, values)
  return env
}

export function copyDatabase(database, values, cwd) {
  if (database?.copy) run(fill(database.copy, values), cwd)
}

export function dropDatabase(database, values, cwd) {
  if (database?.drop) run(fill(database.drop, values), cwd)
}
