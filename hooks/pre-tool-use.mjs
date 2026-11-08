// Enforces the policy. Inside an enki session it fails closed: an error here denies the call.
import { basename, dirname } from 'node:path'
import { changedSource } from '../src/checks.mjs'
import { ConfigError } from '../src/config.mjs'
import { loadProjectConfig, loadTaskConfig } from '../src/memory.mjs'
import { BLIND_ROLES, decide } from '../src/policy.mjs'
import { readState, recordEvent, resolveTask } from '../src/state.mjs'
import { locate, out, readInput } from './lib.mjs'

const input = readInput()
const where = locate(input)

function deny(reason) {
  out({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `enki: ${reason} If this blocks the task, stop and report it. Don't work around it.`,
    },
  })
}

/** A broken config must stay fixable: refusing everything would lock the user out of the fix. */
function repairsConfig() {
  const path = input.tool_input?.file_path
  if (path && basename(path) === 'config.json' && basename(dirname(path)) === '.enki') return true
  return input.tool_name === 'Bash' && /^enki\s+(validate|doctor)\b/.test(input.tool_input?.command ?? '')
}

function run() {
  if (!where) return
  const taskDir = process.env.ENKI_TASK
  const worker = where.worker
  const root = where.root
  if (worker && (!root || !taskDir)) {
    deny('This worker is missing ENKI_PROJECT or ENKI_TASK.')
    return
  }
  const state = worker ? readState(taskDir) : resolveTask(root)
  const config = state ? loadTaskConfig(state) : loadProjectConfig(root)
  if (!worker && config.mode !== 'auto' && !state) return

  // Worked out on every call: the tester runs alongside the coder, so a stale list would leak.
  if (worker && BLIND_ROLES.has(where.role) && state.treeSnapshot) {
    state.blindFiles = changedSource(state.repos, state.treeSnapshot)
  }

  const ctx = { role: where.role, root, cwd: input.cwd ?? process.cwd(), config, state }
  const reason = decide(ctx, input.tool_name, input.tool_input)
  if (!reason) return
  if (state) {
    const target = input.tool_input?.command ?? input.tool_input?.file_path ?? ''
    recordEvent(state.taskDir, 'policy.denied', { role: where.role, tool: input.tool_name, target: String(target).slice(0, 120), reason })
  }
  deny(reason)
}

try {
  run()
} catch (error) {
  if (error instanceof ConfigError && !where.worker && repairsConfig()) process.exit(0)
  deny(`The policy check failed (${error.message}), so this call is refused.`)
}
