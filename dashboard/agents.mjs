// The Agents page's data and actions: every agent there is (enki's own and the user's library),
// what each may do, which workflows use it, and the editor's saves. Everything goes through
// src/library.mjs and the agent checks, so the page can never save what the CLI would refuse.
import { readFileSync } from 'node:fs'
import { EFFORTS, ROLES } from '../src/config.mjs'
import { AGENT_TYPES, agentWarnings, loadRoles } from '../src/agents.mjs'
import { agentBreakage, agentMeta, agentTemplate, agentUsage, checkAgent, copyAgent, deleteAgent, exportAgent, importText, inspectAgentImport, LibraryError, saveAgent } from '../src/library.mjs'
import { capabilityWords } from '../src/workflow.mjs'
import { modelCatalog } from './models.mjs'
import { projectSkills, SettingsError } from './settings.mjs'

// Enki's own first, in their usual order, then the library's by name.
const order = role => (ROLES.includes(role.id) ? ROLES.indexOf(role.id) : ROLES.length)

/** Every agent, with what the page needs to list and edit it. */
export function readAgents(project) {
  const problems = []
  const roles = loadRoles(project.root, { problems })
  const usage = agentUsage(project.root)
  return {
    agents: [...roles.values()]
      .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
      .map(role => ({
        ...agentMeta(role),
        color: role.color,
        pattern: role.pattern,
        capabilities: role.capabilities,
        source: role.source,
        description: role.description ?? '',
        does: capabilityWords(role.capabilities),
        instructions: readFileSync(role.skillPath, 'utf8'),
        warnings: agentWarnings(role),
        usedBy: usage.get(role.id) ?? [],
      })),
    models: modelCatalog().models.map(({ id, label }) => ({ id, label })),
    efforts: EFFORTS,
    types: AGENT_TYPES,
    skills: projectSkills(project),
    template: agentTemplate(),
    problems,
  }
}

export function exportAgentBundle(project, id) {
  return exportAgent(project.root, id)
}

const fail = (status, message, problems = []) => {
  throw new SettingsError(status, message, problems)
}

/** One action from the page. Import asks first: `approve` is the user's click on the summary. */
export function agentAction(project, body) {
  try {
    switch (body?.action) {
      case 'validate': {
        const { problems, warnings } = checkAgent(project.root, body.agent, { creating: body.creating === true })
        return { problems, warnings, breaks: problems.length ? [] : agentBreakage(project.root, body.agent?.id, body.agent?.outcomes ?? []) }
      }
      case 'template':
        return { instructions: agentTemplate(body.agent ?? {}) }
      case 'save':
        return saveAgent(project.root, { agent: body.agent, instructions: body.instructions, creating: body.creating === true })
      case 'copy':
        return { text: copyAgent(project.root, body.id, body.newId) }
      case 'delete':
        return { text: deleteAgent(project.root, body.id) }
      case 'inspect':
        return inspectAgentImport(project.root, body.bundle)
      case 'import':
        if (body.approve !== true) fail(400, 'An import needs the user’s approval')
        return { text: importText(project.root, body.bundle, { by: 'user' }) }
      default:
        return fail(400, 'Unknown action')
    }
  } catch (error) {
    if (error instanceof LibraryError) throw new SettingsError(409, error.message, (error.problems ?? []).map(message => ({ path: null, message })))
    throw error
  }
}
