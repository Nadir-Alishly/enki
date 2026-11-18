// Records plan approval. This event fires only after the user accepts the plan dialog,
// so approval can't be claimed by the model and a cancelled plan can't pass the gate.
import { resolveTask } from '../src/state.mjs'
import { approvePlan, EnkiError } from '../src/task.mjs'
import { locate, out, readInput } from './lib.mjs'

const input = readInput()
const where = locate(input)

function context(text) {
  out({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } })
}

function run() {
  if (!where || where.worker || input.tool_name !== 'ExitPlanMode') return
  const task = resolveTask(where.root)
  if (!task || task.approved) return
  const plan = input.tool_response?.plan
  if (typeof plan !== 'string' || plan.trim() === '') return
  if (task.phase !== 'planning') {
    context(`Enki did NOT record this approval: task ${task.slug} is in phase ${task.phase}, not planning. ${task.run ? 'No plan is waiting for approval: see enki next.' : 'Finish intake (scout report, then enki phase planning) and present the plan again.'}`)
    return
  }
  let next
  try {
    next = approvePlan(task, plan)
  } catch (error) {
    if (!(error instanceof EnkiError)) throw error
    context(`Enki did NOT record this approval: ${error.message} Tell the user, then present it again.`)
    return
  }
  context(`Enki recorded the approved plan for task ${next.slug} (scope: ${next.scope.join(', ') || 'none'}). Continue with the enki:execute skill.`)
}

try {
  run()
} catch (error) {
  context(`Enki couldn't record the plan approval: ${error.message}. Tell the user before going on.`)
}
