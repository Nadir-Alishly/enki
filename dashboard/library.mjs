// The library page's data and actions: workflows and roles, copied, imported and saved through the
// same guarded write path as settings. Everything here works through src/library.mjs and the
// workflow checks, so the page can never save what the CLI would refuse.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { copyWorkflow, exportWorkflow, importText, inspectImport, LibraryError, listWorkflows, useWorkflow, deleteWorkflow } from '../src/library.mjs'
import { EFFORTS, ROLES } from '../src/config.mjs'
import { modelCatalog } from './models.mjs'
import { loadProjectConfig } from '../src/memory.mjs'
import { libraryDir, loadRoles, roleInstructions } from '../src/agents.mjs'
import { BUILTIN_STEPS, describeWorkflow, loadWorkflows, upgradeWorkflow, workflowProblems, workflowWarnings } from '../src/workflow.mjs'
import { projectSkills, SettingsError } from './settings.mjs'

const strip = ({ source, path, ...workflow }) => workflow
// Enki's own roles first, in their usual order, then the rest.
const order = id => (ROLES.includes(id) ? ROLES.indexOf(id) : ROLES.length)

/** Every workflow and role, with what the page needs to show and edit them. */
export function readLibrary(project) {
  const { workflows, problems } = listWorkflows(project.root)
  const files = loadWorkflows(project.root)
  const roles = loadRoles(project.root)
  let current = null
  try {
    current = loadProjectConfig(project.root).workflow
  } catch {
    // An invalid config still has a library.
  }
  return {
    current,
    workflows: workflows.map(item => ({ ...item, workflow: strip(files.get(item.id)), summary: summaryOf(strip(files.get(item.id)), roles, item.problems) })),
    roles: [...roles.values()].sort((a, b) => order(a.id) - order(b.id)).map(role => ({
      id: role.id,
      name: role.name,
      description: role.description,
      source: role.source,
      color: role.color ?? null,
      pattern: role.pattern ?? null,
      capabilities: role.capabilities,
      outcomes: role.outcomes,
      skills: role.skills ?? [],
      // What a step of this role runs on here unless its workflow says otherwise.
      model: role.model ?? 'claude-sonnet-5-5',
      effort: role.effort ?? 'high',
      instructions: roleInstructions(role).slice(0, 4000),
    })),
    builtinSteps: BUILTIN_STEPS,
    models: modelCatalog().models.map(({ id, label }) => ({ id, label })),
    skills: projectSkills(project),
    efforts: EFFORTS,
    problems,
  }
}

/** What enki makes of a workflow, in the words the planner gets: only for one that can run. */
const summaryOf = (workflow, roles, problems) => (problems.length ? null : describeWorkflow(workflow, node => roles.get(node.agent) ?? null))

export function exportBundle(project, id) {
  return exportWorkflow(project.root, id)
}

const fail = (status, message, problems = []) => {
  throw new SettingsError(status, message, problems)
}

/** Saves a workflow from the editor: checked first, then written where it was asked to go. */
function saveWorkflow(project, { workflow, to = 'library', replace = false }) {
  if (!workflow || typeof workflow !== 'object') fail(400, 'Send a workflow')
  workflow = upgradeWorkflow(workflow)
  const problems = workflowProblems(workflow, loadRoles(project.root))
  if (problems.length > 0) fail(422, 'The workflow can’t run yet', problems.map(message => ({ path: null, message })))
  const existing = loadWorkflows(project.root).get(workflow.id)
  if (existing?.source === 'builtin') fail(409, `"${workflow.id}" is one of enki's own workflows: save it under another id`)
  const dir = to === 'project' ? join(project.root, '.enki', 'workflows') : to === 'library' ? join(libraryDir(), 'workflows') : fail(400, '"to" is library or project')
  const path = join(dir, `${workflow.id}.json`)
  if (existsSync(path) && !replace) fail(409, `${workflow.id} already exists in the ${to}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, `${JSON.stringify(workflow, null, 2)}\n`)
  return { saved: workflow.id, to }
}

/** One library action from the page. Import asks first: `approve` is the user's click on the summary. */
export function libraryAction(project, body) {
  try {
    switch (body?.action) {
      case 'copy':
        return { text: copyWorkflow(project.root, body.id, body.newId, body.to) }
      case 'use':
        return { text: useWorkflow(project.root, body.id) }
      case 'delete':
        return { text: deleteWorkflow(project.root, body.id) }
      case 'inspect':
        return inspectImport(project.root, body.bundle, body.to)
      case 'import':
        if (body.approve !== true) fail(400, 'An import needs the user’s approval')
        return { text: importText(project.root, body.bundle, { to: body.to, by: 'user' }) }
      case 'save':
        return saveWorkflow(project, body)
      case 'validate': {
        const roles = loadRoles(project.root)
        const workflow = upgradeWorkflow(body.workflow)
        const problems = workflowProblems(workflow, roles)
        return { problems, warnings: problems.length ? [] : workflowWarnings(workflow, roles), summary: summaryOf(workflow, roles, problems) }
      }
      default:
        return fail(400, 'Unknown action')
    }
  } catch (error) {
    if (error instanceof LibraryError) throw new SettingsError(409, error.message)
    throw error
  }
}
