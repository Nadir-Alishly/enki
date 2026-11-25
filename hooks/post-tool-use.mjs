// Records the approval of the spec or the plan, whichever waits. This event fires only after the
// user accepts the plan dialog, so approval can't be claimed by the model and a cancelled one can't pass the gate.
import { resolveTask } from '../src/state.mjs'
import { approvePlan, approveSpec, EnkiError } from '../src/task.mjs'
import { waitingApproval } from '../src/workflow.mjs'
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
  const waiting = task.run ? waitingApproval(task.run) : task.phase === 'planning' ? 'approval' : null
  if (!waiting) {
    context(`Enki did NOT record this approval: task ${task.slug} is in phase ${task.phase}, and nothing is waiting for the user's approval. ${task.run ? 'See enki next.' : 'Finish intake (scout report, then enki phase planning) and present the plan again.'}`)
    return
  }
  const spec = waiting === 'spec-approval'
  let next
  try {
    next = spec ? approveSpec(task, plan) : approvePlan(task, plan)
  } catch (error) {
    if (!(error instanceof EnkiError)) throw error
    context(`Enki did NOT record this approval: ${error.message} Tell the user, then present it again.`)
    return
  }
  if (spec) context(`Enki recorded the approved spec for task ${next.slug}, saved as spec.md. The planning steps work from it now: see enki next, and continue with the enki:task skill.`)
  else context(`Enki recorded the approved plan for task ${next.slug} (scope: ${next.scope.join(', ') || 'none'}). Continue with the enki:execute skill.`)
}

try {
  run()
} catch (error) {
  context(`Enki couldn't record the approval: ${error.message}. Tell the user before going on.`)
}
