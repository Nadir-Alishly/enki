// Enforces the policy. Inside an enki session it fails closed: an error here denies the call.
import { basename, dirname } from 'node:path'
import { changedSource } from '../src/checks.mjs'
import { ConfigError } from '../src/config.mjs'
import { loadProjectConfig, loadTaskConfig } from '../src/memory.mjs'
import { decide, isBlindStep } from '../src/policy.mjs'
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadSecrets, redact, secretsIn } from '../src/secrets.mjs'
import { readState, recordEvent, resolveTask } from '../src/state.mjs'
import { planCheck } from '../src/workflow.mjs'
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

/** One short line per tool call, for the dashboard: which agent, which tool, on what. */
function logActivity(taskDir, secrets) {
  const toolInput = input.tool_input ?? {}
  const target = toolInput.file_path ?? toolInput.command ?? toolInput.pattern ?? toolInput.url ?? toolInput.description ?? ''
  try {
    appendFileSync(join(taskDir, 'activity.jsonl'), `${JSON.stringify({ t: new Date().toISOString(), role: where.role, tool: input.tool_name, target: redact(String(target).replace(/\s+/g, ' '), secrets).slice(0, 100) })}\n`)
  } catch {
    // The log is for display: it must never block a tool call.
  }
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
  if (worker && isBlindStep(state, where.role) && state.treeSnapshot) {
    state.blindFiles = changedSource(state.repos, state.treeSnapshot)
  }

  const secrets = loadSecrets(state?.projectId ?? config.id)
  if (state) logActivity(state.taskDir, secrets)

  // A secret goes into no file: a brief or report names it, and agents read it with enki secret get.
  const written = [input.tool_input?.content, input.tool_input?.new_string, input.tool_input?.new_source, ...(input.tool_input?.edits ?? []).map(edit => edit?.new_string)].filter(text => typeof text === 'string')
  const leaked = [...new Set(written.flatMap(text => secretsIn(text, secrets)))]
  if (leaked.length > 0) {
    const reason = `That would write the secret ${leaked.join(', ')} into a file. Write its name instead: whoever needs the value runs enki secret get ${leaked[0]}.`
    if (state) recordEvent(state.taskDir, 'policy.denied', { role: where.role, tool: input.tool_name, target: String(input.tool_input?.file_path ?? ''), reason })
    deny(reason)
    return
  }

  // The orchestrator only carries the plan: what the user approves is the planner's, word for word.
  if (!worker && state && input.tool_name === 'ExitPlanMode') {
    const problem = planCheck(state, typeof input.tool_input?.plan === 'string' ? input.tool_input.plan : null)
    if (problem) {
      recordEvent(state.taskDir, 'policy.denied', { role: 'orchestrator', tool: input.tool_name, target: 'plan', reason: problem })
      deny(problem)
      return
    }
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
