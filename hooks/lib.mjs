// Shared by the hook scripts: works out who this session is, or that enki has no business here.
import { readFileSync } from 'node:fs'
import { findProjectRoot } from '../src/config.mjs'

export function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    return {}
  }
}

/** Cheap check that runs in every session on the machine, so it reads no config. */
export function locate(input, env = process.env) {
  // ENKI_ROLE is the name workers started before steps had their own had.
  const step = env.ENKI_STEP || env.ENKI_ROLE
  if (step) return { role: step, root: env.ENKI_PROJECT ?? null, worker: true }
  const root = findProjectRoot(input.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd())
  return root ? { role: 'orchestrator', root, worker: false } : null
}

export function out(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
