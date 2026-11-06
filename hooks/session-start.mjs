// Injects the orchestrator role, and reports a worker's hooks as live so `enki` can verify them.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from '../src/config.mjs'
import { pluginRoot } from '../src/paths.mjs'
import { readState, recordEvent, resolveTask } from '../src/state.mjs'
import { locate, out, readInput } from './lib.mjs'

const input = readInput()
const where = locate(input)

function context(text) {
  out({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
}

function run() {
  if (!where) return
  if (where.worker) {
    if (process.env.ENKI_TASK) {
      recordEvent(process.env.ENKI_TASK, 'worker.hooks_ready', { role: where.role, source: input.source ?? null })
    }
    return
  }
  let config
  try {
    config = loadConfig(where.root)
  } catch (error) {
    context(`Enki: this project's config is invalid, so orchestration is off until it's fixed.\n${error.message}`)
    return
  }
  const task = resolveTask(where.root)
  if (config.mode !== 'auto' && !task) return
  const prompt = readFileSync(join(pluginRoot, 'prompts', 'orchestrator.md'), 'utf8')
  const bound = task
    ? `\n\n## This session\n\nYou are running task \`${task.slug}\` (phase: ${readState(task.taskDir).phase}). Run \`enki resume ${task.slug}\` before anything else, and continue from the recorded phase.\n`
    : ''
  context(prompt + bound)
}

try {
  run()
} catch (error) {
  // A failed role injection mustn't stop the session, but it shouldn't pass silently either.
  context(`Enki: failed to load the orchestrator role: ${error.message}`)
}
