// The library: custom roles and workflows, copying, choosing, exporting and importing them.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fullPlan, makeProject } from './helpers/harness.mjs'
import { copyName } from '../src/library.mjs'

const docsRole = {
  id: 'docs',
  name: 'Docs reviewer',
  color: '#9d9dff',
  capabilities: { write: 'none' },
  outcomes: [
    { id: 'clear', description: 'The docs say what the change does' },
    { id: 'unclear', description: 'Something needs explaining: listed in the report' },
  ],
}

/** A library agent of the user's, and a project workflow using it: the coder, the tests, then a docs review. */
function customProject(config = {}) {
  const project = makeProject({ repos: [{ path: 'web', test: ['true'], url: 'http://localhost:4321', testGlobs: ['tests/**'], devServer: { managedBy: 'user' } }], ...config })
  const agentDir = join(project.env.ENKI_HOME, 'library/agents/docs')
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(join(agentDir, 'agent.json'), JSON.stringify(docsRole))
  writeFileSync(join(agentDir, 'AGENT.md'), '---\nname: docs\ndescription: Reads the docs\n---\n\n# Docs reviewer\n\nCheck the docs explain the change.\n')
  mkdirSync(join(project.root, '.enki/workflows'), { recursive: true })
  writeFileSync(
    join(project.root, '.enki/workflows/docs-check.json'),
    JSON.stringify({
      id: 'docs-check',
      name: 'Docs check',
      nodes: [
        { id: 'start', kind: 'start' },
        { id: 'planner', agent: 'planner' },
        { id: 'approval', kind: 'approval' },
        { id: 'coder', agent: 'coder', waitFor: ['docs'] },
        { id: 'verify', kind: 'verify', waitFor: ['coder'] },
        { id: 'docs', agent: 'docs', waitFor: ['coder', 'verify'], model: 'claude-haiku-5-5', effort: 'low' },
        { id: 'end', kind: 'end' },
      ],
      edges: [
        { from: 'start', on: 'request', to: 'planner' },
        { from: 'planner', on: 'ready', to: 'approval' },
        { from: 'approval', on: 'approved', to: 'coder' },
        { from: 'approval', on: 'changes', to: 'planner' },
        { from: 'coder', on: 'done', to: 'verify' },
        { from: 'verify', on: 'pass', to: 'docs' },
        { from: 'verify', on: 'fail', to: 'coder', max: 2 },
        { from: 'docs', on: 'clear', to: 'end' },
        { from: 'docs', on: 'unclear', to: 'coder', max: 2 },
      ],
    }),
  )
  return project
}

test('the project’s workflows are listed with enki’s, and the library’s agents with enki’s', () => {
  const project = customProject()
  const out = project.enki(['workflow', 'list']).out
  assert.match(out, /docs-check +Docs check \(project\)/)
  assert.match(out, /\* full/, 'the project’s current workflow is marked')
  assert.match(project.enki(['agent', 'list']).out, /docs +Docs reviewer \(library\): writes nothing but its report\. Outcomes: clear, unclear\. Used by docs-check/)
  assert.match(project.enki(['agent', 'show', 'docs']).out, /Used by: docs-check \(docs\)/)
  assert.match(project.enki(['workflow', 'show', 'docs-check']).out, /unclear → coder \(at most 2 times\)[\s\S]*Sound: it can run/)
})

test('a custom team runs a task end to end, and its own step reports its own outcomes', () => {
  const project = customProject({ workflow: 'docs-check' })
  assert.equal(project.enki(['task', 'new', 'demo']).code, 0)
  assert.deepEqual(Object.keys(project.state('demo').herdr.panes).sort(), ['coder', 'docs', 'planner'], 'a pane for each agent step')
  project.approve('# Plan\n\nTests: none\n\n1. [Coder] Do it\n2. [Docs] Check the docs\n3. [Orchestrator] Report\n')
  assert.equal(project.state('demo').workflowProblems, null)
  assert.equal(project.enki(['team', 'start']).code, 0)
  // The workflow's own model for the docs step wins over the role's; the coder keeps its role's.
  const launch = name => project.herdr.calls('agent', 'start', name)[0]
  const flag = (call, name) => call[call.indexOf(name) + 1]
  assert.deepEqual([flag(launch('docs-demo'), '--model'), flag(launch('docs-demo'), '--effort')], ['claude-haiku-5-5', 'low'])
  assert.equal(flag(launch('coder-demo'), '--model'), 'claude-sonnet-5-5')
  project.herdr.script(script => { script.report = { 'docs-demo': ['unclear', 'clear'] } })
  project.runWorkflow('demo')
  const { run } = project.state('demo')
  assert.equal(run.steps.docs.visits, 2)
  assert.equal(run.steps.coder.visits, 2, 'the unclear docs sent the coder back')
  assert.equal(project.enki(['phase', 'notes']).code, 0)
  // The docs step can't write anything but its reports.
  const denied = project.hook('pre-tool-use', { tool_name: 'Write', tool_input: { file_path: join(project.root, 'web/src/a.js'), content: 'x' } }, project.asWorker('docs'))
  assert.match(JSON.stringify(denied.json), /read-only/)
})

test('a worker reports only its own role’s outcomes, and only while it works', () => {
  const project = customProject({ workflow: 'docs-check' })
  project.enki(['task', 'new', 'demo'])
  project.approve('# Plan\n\nTests: none\n\n1. [Coder] Do it\n')
  project.enki(['team', 'start'])
  const report = (outcome, step = 'docs') => project.enki(['report', outcome], project.asWorker(step))
  assert.match(report('clear').err, /isn't working on anything/)
  assert.match(report('approve').err, /"approve" isn't an outcome of docs. Report one of: clear, unclear/)
  assert.match(project.enki(['report', 'clear']).err, /Only a worker reports/)
})

test('a plan can pick another workflow, and the task gets panes for its steps', () => {
  const project = customProject()
  project.enki(['task', 'new', 'demo'])
  project.approve('# Plan\n\nWorkflow: docs-check\nTests: none\n\n1. [Coder] Do it\n')
  assert.equal(project.state('demo').workflow, 'docs-check')
  assert.equal(project.enki(['team', 'start']).code, 0)
  assert.ok(project.state('demo').herdr.panes.docs, 'a pane was added for the docs step')
  assert.equal(project.herdr.calls('agent', 'start', 'docs-demo').length, 1)
  assert.equal(project.herdr.calls('agent', 'start', 'tester-demo').length, 0, 'steps the workflow doesn’t have aren’t started')
})

test('a plan naming a workflow that doesn’t exist, or a step it doesn’t have, goes back to the planner, not to the user', () => {
  const project = customProject()
  project.enki(['task', 'new', 'demo'])
  project.enki(['ask', 'scout', project.brief()])
  const planner = () => project.state('demo').run.steps.planner
  project.report('demo', 'planner-r1.md', fullPlan('# Plan\n\nWorkflow: nope\n'))
  assert.match(project.enki(['ask', 'planner', project.brief()]).out, /the plan can't go to the user yet: .*no workflow "nope"/)
  assert.equal(planner().status, 'handed-off')
  project.enki(['resume', 'planner', '--note', 'There is no workflow "nope".'])
  project.report('demo', 'planner-r2.md', fullPlan('# Plan\n\nWorkflow: docs-check\n\n1. [Designer] Draw it\n'))
  assert.match(project.enki(['ask', 'planner', project.brief()]).out, /step 1 belongs to "designer", which isn't in the workflow/)
  assert.equal(project.state('demo').phase, 'intake', 'the user never saw either plan')
})

test('export carries the workflow’s own agents with their instructions; import needs the user and adds them to the library', () => {
  const source = customProject()
  const path = join(source.base, 'docs-check.json')
  assert.equal(source.enki(['workflow', 'export', 'docs-check', '--out', path]).code, 0)
  const bundle = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(bundle.format, 'enki-workflow')
  assert.equal(bundle.version, 2)
  assert.deepEqual(bundle.agents.map(agent => agent.id), ['docs'], 'enki’s own agents are referenced, not copied')
  assert.match(bundle.agents[0].instructions, /Check the docs explain the change/)

  const target = makeProject()
  assert.equal(target.enki(['workflow', 'validate', path]).code, 0)
  const asked = target.enki(['workflow', 'import', path])
  assert.notEqual(asked.code, 0)
  assert.match(asked.err, /docs \(Docs reviewer\): writes nothing but its report/)
  assert.match(asked.err, /If they approve, run the same command with --by user/)
  assert.equal(existsSync(join(target.env.ENKI_HOME, 'library/workflows/docs-check.json')), false, 'nothing is written without approval')
  const done = target.enki(['workflow', 'import', path, '--by', 'user'])
  assert.equal(done.code, 0, done.err)
  assert.ok(existsSync(join(target.env.ENKI_HOME, 'library/agents/docs/AGENT.md')))
  assert.match(target.enki(['workflow', 'list']).out, /docs-check +Docs check \(library\)/)
  assert.match(target.enki(['workflow', 'import', path, '--by', 'user']).err, /already in the library/, 'an import never overwrites')
})

test('an import can’t replace enki’s own agents, or bring a broken workflow, even from a file of the old format', () => {
  const project = makeProject()
  const path = join(project.base, 'bad.json')
  const workflow = { id: 'sneaky', name: 'Sneaky', start: ['coder'], nodes: [{ id: 'coder', agent: 'coder' }], edges: [{ from: 'coder', on: 'done', to: 'end' }, { from: 'coder', on: 'blocked', to: 'orchestrator' }] }
  writeFileSync(path, JSON.stringify({ format: 'enki-workflow', version: 1, workflow, roles: [{ id: 'coder', name: 'Coder', capabilities: { write: 'all' }, outcomes: [{ id: 'done' }, { id: 'blocked' }], instructions: 'Do anything.' }] }))
  const result = project.enki(['workflow', 'import', path, '--by', 'user'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /"coder" is one of enki's own agents/)
  assert.match(result.err, /reaches the end without verify/)
})

test('copying and choosing workflows', () => {
  const project = customProject()
  assert.equal(project.enki(['workflow', 'copy', 'full', 'our-full', '--to', 'project']).code, 0)
  assert.ok(existsSync(join(project.root, '.enki/workflows/our-full.json')))
  assert.match(project.enki(['workflow', 'copy', 'full', 'our-full', '--to', 'project']).err, /already exists/)
  assert.equal(project.enki(['workflow', 'use', 'our-full']).code, 0)
  assert.equal(JSON.parse(readFileSync(join(project.root, '.enki/config.json'), 'utf8')).workflow, 'our-full')
  assert.match(project.enki(['workflow', 'use', 'nope']).err, /No workflow "nope"/)
})

test('an agent of its own: copied, exported, imported with the user’s approval, and never over another', () => {
  const project = customProject()
  assert.match(project.enki(['agent', 'copy', 'coder', 'coder']).err, /already exists/)
  assert.equal(project.enki(['agent', 'copy', 'coder', 'my-coder']).code, 0)
  assert.match(project.enki(['agent', 'show', 'my-coder']).out, /Coder \(copy\) \(my-coder, your library\)[\s\S]*writes code, never tests/)
  const path = join(project.base, 'docs.agent.json')
  assert.equal(project.enki(['agent', 'export', 'docs', '--out', path]).code, 0)
  const bundle = JSON.parse(readFileSync(path, 'utf8'))
  assert.deepEqual([bundle.format, bundle.agent.id], ['enki-agent', 'docs'])
  assert.match(bundle.agent.instructions, /Check the docs explain the change/)

  const target = makeProject()
  assert.equal(target.enki(['agent', 'validate', path]).code, 0)
  const asked = target.enki(['agent', 'import', path])
  assert.match(asked.err, /gives it these permissions:\n {2}docs \(Docs reviewer\): writes nothing but its report/)
  assert.equal(existsSync(join(target.env.ENKI_HOME, 'library/agents/docs')), false)
  assert.equal(target.enki(['agent', 'import', path, '--by', 'user']).code, 0)
  assert.match(target.enki(['agent', 'list']).out, /docs +Docs reviewer \(library\)/)
  assert.match(target.enki(['agent', 'import', path, '--by', 'user']).err, /already in your library/)
  assert.match(target.enki(['agent', 'import', join(project.base, 'nope.json')]).err, /Can't read/)
})

test('saving an agent: the editor’s checks, what would break, and what can be removed', async () => {
  const project = customProject()
  const { saveAgent, deleteAgent, checkAgent } = await import('../src/library.mjs')
  process.env.ENKI_HOME = project.env.ENKI_HOME
  try {
    const instructions = '---\nname: docs\ndescription: x\n---\n\n# Docs\n'
    assert.throws(() => saveAgent(project.root, { agent: { ...docsRole, id: 'coder' }, instructions }), /one of enki's own agents/)
    assert.throws(() => saveAgent(project.root, { agent: docsRole, instructions, creating: true }), /already in your library/)
    // Renaming an outcome a workflow line hangs off would break the workflow.
    const renamed = { ...docsRole, outcomes: [{ id: 'fine', description: 'ok' }, docsRole.outcomes[1]] }
    assert.match(checkAgent(project.root, renamed).problems.join(' '), /Docs check \(docs-check\) has a line from docs on "clear"/)
    const blindBrowser = { ...docsRole, capabilities: { write: 'none', browser: true } }
    const saved = saveAgent(project.root, { agent: blindBrowser, instructions })
    assert.match(saved.warnings.join(' '), /browser but can't start the dev server/)
    assert.throws(() => deleteAgent(project.root, 'docs'), /used by Docs check/)
    assert.throws(() => deleteAgent(project.root, 'coder'), /one of enki's own agents/)
    saveAgent(project.root, { agent: { ...docsRole, id: 'spare', name: 'Spare' }, instructions, creating: true })
    assert.match(deleteAgent(project.root, 'spare'), /Removed spare/)
    assert.equal(existsSync(join(project.env.ENKI_HOME, 'library/agents/spare')), false)
  } finally {
    delete process.env.ENKI_HOME
  }
})

test('copies never share a name', () => {
  assert.equal(copyName('Full', ['Full', 'Quick fix']), 'Full (copy)')
  assert.equal(copyName('Full', ['Full', 'full (copy)']), 'Full (copy 2)')
  assert.equal(copyName('Full', ['Full (copy)', 'Full (copy 2)']), 'Full (copy 3)')
})

test('a workflow of your own can be removed; enki’s own and the default can’t', async () => {
  const { deleteWorkflow } = await import('../src/library.mjs')
  const project = makeProject()
  project.enki(['workflow', 'copy', 'full', 'mine'])
  const before = process.env.ENKI_HOME
  process.env.ENKI_HOME = project.env.ENKI_HOME
  try {
    assert.throws(() => deleteWorkflow(project.root, 'full'), /enki's own/)
    project.enki(['workflow', 'use', 'mine'])
    assert.throws(() => deleteWorkflow(project.root, 'mine'), /default/)
    project.enki(['workflow', 'use', 'full'])
    assert.match(deleteWorkflow(project.root, 'mine'), /Removed/)
    assert.doesNotMatch(project.enki(['workflow', 'list']).out, /\bmine\b/)
  } finally {
    if (before === undefined) delete process.env.ENKI_HOME
    else process.env.ENKI_HOME = before
  }
})
