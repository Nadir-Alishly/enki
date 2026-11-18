// Test accounts and other secrets the user gives for a project: kept outside every repo, readable
// only by the user, and never in what enki writes (events, the activity log, files agents write).
// Briefs name a secret; an agent reads its value with `enki secret get <name>` when it needs it.
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { enkiHome } from './state.mjs'

export const SECRET_NAME = /^[a-z][a-z0-9-]{0,40}$/
// Shorter values would match ordinary text everywhere.
const MIN_LENGTH = 4

const pathFor = projectId => join(enkiHome(), 'secrets', `${projectId}.json`)

/** A project's secrets, `{ name: value }`. Empty when there are none, or no project id yet. */
export function loadSecrets(projectId) {
  if (!projectId) return {}
  try {
    const raw = JSON.parse(readFileSync(pathFor(projectId), 'utf8'))
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  } catch {
    return {}
  }
}

function save(projectId, secrets) {
  const dir = join(enkiHome(), 'secrets')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const path = pathFor(projectId)
  writeFileSync(path, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
}

export function setSecret(projectId, name, value) {
  if (!SECRET_NAME.test(name ?? '')) throw new Error('A secret name: lowercase letters, digits and dashes, like qa-password.')
  if (typeof value !== 'string' || value.length < MIN_LENGTH) throw new Error(`A secret needs a value of ${MIN_LENGTH} characters or more.`)
  save(projectId, { ...loadSecrets(projectId), [name]: value })
}

export function removeSecret(projectId, name) {
  const secrets = loadSecrets(projectId)
  if (!(name in secrets)) return false
  delete secrets[name]
  save(projectId, secrets)
  return true
}

/**
 * Text with every secret's value replaced by `[secret:name]`, and the value of an
 * `enki secret set <name> <value>` command hidden, since it isn't stored until the command runs.
 */
export function redact(text, secrets) {
  let result = String(text).replace(/(enki\s+secret\s+set\s+\S+)\s+\S[^;&|\n]*/g, '$1 [hidden]')
  for (const [name, value] of Object.entries(secrets ?? {})) {
    if (typeof value !== 'string' || value.length < MIN_LENGTH) continue
    // As written, and as it reads inside a JSON string.
    for (const form of new Set([value, JSON.stringify(value).slice(1, -1)])) result = result.split(form).join(`[secret:${name}]`)
  }
  return result
}

/** The names of the secrets a text contains, to refuse writing them into a file. */
export const secretsIn = (text, secrets) =>
  Object.entries(secrets ?? {})
    .filter(([, value]) => typeof value === 'string' && value.length >= MIN_LENGTH && String(text).includes(value))
    .map(([name]) => name)

