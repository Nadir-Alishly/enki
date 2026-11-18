import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { makeProject } from './helpers/harness.mjs'
import { parseSkill } from '../src/skills.mjs'

function skill(dir, name, body = `Body of ${name}.`, description = `About ${name}`) {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`)
}

/** A stand-in for `claude plugin list --json`. */
function fakeClaude(project, plugins) {
  const path = join(project.base, 'fake-claude.mjs')
  writeFileSync(path, `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(plugins))})\n`)
  chmodSync(path, 0o755)
  return { ENKI_CLAUDE_BIN: path }
}

const personal = project => join(project.env.HOME, '.claude/skills')
const projectSkills = project => join(project.root, '.claude/skills')
/** The coder's step gets these skills, through the project's own workflow. */
const team = (coder, extra = {}) => ({ steps: { coder: { skills: coder }, ...extra } })
const launch = (project, name) => project.herdr.calls('agent', 'start', name)[0]
const role = (project, name) => readFileSync(join(project.taskDir('demo'), `role-${name}.md`), 'utf8')

function started(config, setup, env = {}) {
  const project = makeProject(config)
  setup?.(project)
  const created = project.enki(['task', 'new', 'demo'], env)
  assert.equal(created.code, 0, created.err)
  project.approve()
  const team = project.enki(['team', 'start'], env)
  assert.equal(team.code, 0, team.err)
  return project
}

test('every worker starts with no skills, and the flag is there with or without a list', () => {
  const project = started(team(['tidy']), p => skill(personal(p), 'tidy'))
  for (const name of ['scout', 'coder', 'tester', 'qa', 'reviewer']) {
    assert.ok(launch(project, `${name}-demo`).includes('--disable-slash-commands'), name)
  }
})

test('a listed skill loads into that role and no other', () => {
  const project = started(team(['tidy']), p => skill(personal(p), 'tidy', 'Keep everything tidy.'))
  assert.match(role(project, 'coder'), /## Skill: tidy/)
  assert.match(role(project, 'coder'), /Keep everything tidy\./)
  for (const name of ['scout', 'tester', 'qa', 'reviewer']) assert.doesNotMatch(role(project, name), /Keep everything tidy/, name)
})

test('a role with no skills gets no skills section', () => {
  const project = started({})
  assert.doesNotMatch(role(project, 'coder'), /# Your skills/)
})

test('frontmatter stays out, and variables are filled in', () => {
  const body = 'Run ${CLAUDE_SKILL_DIR}/go.sh in ${CLAUDE_PROJECT_DIR}. Args: $ARGUMENTS.'
  const project = started(team(['tidy']), p => skill(personal(p), 'tidy', body))
  const text = role(project, 'coder')
  assert.doesNotMatch(text, /description: About tidy/)
  assert.ok(text.includes(`Run ${join(personal(project), 'tidy')}/go.sh in ${project.root}. Args: .`))
})

test('the skill folder is readable, so supporting files work', () => {
  const project = started(team(['tidy']), p => skill(personal(p), 'tidy'))
  const args = launch(project, 'coder-demo')
  assert.ok(args.some((arg, index) => arg === '--add-dir' && args[index + 1] === join(personal(project), 'tidy')))
  const other = launch(project, 'tester-demo')
  assert.equal(other.filter(arg => arg === '--add-dir').length, 1)
})

test('project skills are found from the repo up to the project root', () => {
  const project = started(team(['near', 'far']), p => {
    skill(join(p.root, 'web/.claude/skills'), 'near')
    skill(projectSkills(p), 'far')
  })
  assert.match(role(project, 'coder'), /Body of near/)
  assert.match(role(project, 'coder'), /Body of far/)
})

test('a personal skill wins over a project skill of the same name', () => {
  const project = started(team(['both']), p => {
    skill(personal(p), 'both', 'From personal.')
    skill(projectSkills(p), 'both', 'From project.')
  })
  assert.match(role(project, 'coder'), /From personal/)
  assert.doesNotMatch(role(project, 'coder'), /From project/)
})

test('plugin skills load by prefix, from where the plugin really reads', () => {
  const project = makeProject(team(['design:copy', 'solo:solo']))
  const folder = join(project.base, 'plugin-src')
  const single = join(project.base, 'solo-plugin')
  mkdirSync(single)
  skill(join(folder, 'skills'), 'copy', 'Plugin copy skill, root is ${CLAUDE_PLUGIN_ROOT}.')
  writeFileSync(join(single, 'SKILL.md'), '---\nname: solo\n---\nA one-skill plugin.\n')
  const env = fakeClaude(project, [
    { id: 'design@market', enabled: true, installPath: '/stale/cache', readFromFolder: folder },
    { id: 'solo@market', enabled: true, installPath: single },
    { id: 'off@market', enabled: false, installPath: '/nope' },
  ])
  assert.equal(project.enki(['task', 'new', 'demo'], env).code, 0)
  project.approve()
  assert.equal(project.enki(['team', 'start'], env).code, 0)
  assert.ok(role(project, 'coder').includes(`Plugin copy skill, root is ${folder}.`))
  assert.match(role(project, 'coder'), /A one-skill plugin/)
})

test('a plugin\'s nested skills, listed in its plugin.json, are found and load', () => {
  const project = makeProject(team(['matt:grilling']))
  const folder = join(project.base, 'matt-src')
  skill(join(folder, 'skills', 'productivity'), 'grilling', 'Grill the user.')
  mkdirSync(join(folder, '.claude-plugin'))
  writeFileSync(join(folder, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'matt', skills: ['./skills/productivity/grilling'] }))
  const env = fakeClaude(project, [{ id: 'matt@market', enabled: true, installPath: folder }])
  assert.match(project.enki(['skills', '--available'], env).out, /matt:grilling/)
  assert.equal(project.enki(['task', 'new', 'demo'], env).code, 0)
  project.approve()
  assert.equal(project.enki(['team', 'start'], env).code, 0)
  assert.match(role(project, 'coder'), /Grill the user/)
})

test('a disabled plugin\'s skill is not found', () => {
  const project = makeProject(team(['off:thing']))
  const folder = join(project.base, 'off-src')
  skill(join(folder, 'skills'), 'thing')
  const env = fakeClaude(project, [{ id: 'off@market', enabled: false, installPath: folder }])
  assert.match(project.enki(['task', 'new', 'demo'], env).err, /wasn't found/)
})

test('synced skills load through their prefix', () => {
  const project = started(team(['anthropic-skills:pdf']), p => skill(join(personal(p), 'synced/account1'), 'pdf', 'Synced PDF skill.'))
  assert.match(role(project, 'coder'), /Synced PDF skill/)
})

test('a missing skill stops the task before any tab opens, and names the role', () => {
  const project = makeProject(team(['nope']))
  const result = project.enki(['task', 'new', 'demo'])
  assert.notEqual(result.code, 0)
  assert.match(result.err, /coder: Skill "nope" wasn't found/)
  assert.match(result.err, /enki skills --available/)
  assert.ok(!existsSync(join(project.base, 'herdr.json')), 'herdr was never called')
})

test('a skill removed after the task began stops that worker, instead of starting without it', () => {
  const project = makeProject(team(['tidy']))
  skill(personal(project), 'tidy')
  project.enki(['task', 'new', 'demo'])
  project.approve()
  const path = join(personal(project), 'tidy/SKILL.md')
  rmSync(path)
  assert.match(project.enki(['team', 'start']).err, /wasn't found/)
  assert.equal(project.herdr.calls('agent', 'start', 'coder-demo').length, 0)
})

test('the old team setting is ignored, with a warning that says where skills go now', () => {
  const project = makeProject({ team: { coder: { skills: ['tidy'] } } })
  skill(personal(project), 'tidy', 'Late addition.')
  const validated = project.enki(['validate'])
  assert.equal(validated.code, 0, validated.err)
  assert.match(validated.out, /warning: team is no longer used: .*Agents page.*workflow's steps/)
  project.enki(['task', 'new', 'demo'])
  project.approve()
  assert.equal(project.enki(['team', 'start']).code, 0)
  assert.doesNotMatch(role(project, 'coder'), /Late addition/)
})

test('skills sit alongside model settings', () => {
  const project = started({ steps: { coder: { model: 'custom' } } })
  const args = launch(project, 'coder-demo')
  assert.equal(args[args.indexOf('--model') + 1], 'custom')
  assert.equal(args[args.indexOf('--effort') + 1], 'high')
})

test('enki skills shows each role, with size and warnings', () => {
  const project = makeProject(team(['tidy'], { qa: { skills: ['shell'] } }))
  skill(personal(project), 'tidy')
  skill(personal(project), 'shell', 'Today is !`date`.')
  const result = project.enki(['skills'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /coder:\n {2}tidy \(\d+ KB\)/)
  assert.match(result.out, /reviewer: none/)
  assert.match(result.out, /warning: uses inline shell commands/)
})

test('enki skills --available lists personal, project and plugin skills', () => {
  const project = makeProject()
  skill(personal(project), 'mine', 'x', 'A personal one')
  skill(projectSkills(project), 'ours')
  skill(join(personal(project), 'synced/account1'), 'pdf')
  writeFileSync(join(personal(project), 'synced/.bucket-account1'), 'bookkeeping')
  const folder = join(project.base, 'plugin-src')
  skill(join(folder, 'skills'), 'copy')
  const result = project.enki(['skills', '--available'], fakeClaude(project, [{ id: 'design@m', enabled: true, installPath: folder }]))
  assert.match(result.out, /^mine {2}A personal one$/m)
  assert.match(result.out, /^ours /m)
  assert.match(result.out, /^design:copy /m)
  assert.match(result.out, /^anthropic-skills:pdf /m)
})

test('enki validate catches a bad skill name', () => {
  const project = makeProject(team(['nope']))
  assert.match(project.enki(['validate']).err, /wasn't found/)
})

test('workers cannot look up or change skills', () => {
  const project = started({})
  assert.match(project.enki(['skills'], project.asWorker('coder')).err, /Workers can't/)
})

test('the orchestrator keeps its skills, because only workers get the flag', () => {
  const project = makeProject()
  const context = project.hook('session-start', { source: 'startup' }).json.hookSpecificOutput.additionalContext
  assert.match(context, /enki:task/)
})

test('skill names on a step are checked with the workflow', async () => {
  const { workflowProblems, loadWorkflows } = await import('../src/workflow.mjs')
  const { builtinRoles } = await import('../src/agents.mjs')
  const { source, path, ...full } = loadWorkflows(null).get('full')
  const withSkills = skills => ({ ...full, nodes: full.nodes.map(node => (node.id === 'coder' ? { ...node, skills } : node)) })
  for (const skills of ['tidy', ['bad name'], ['a:b:c']]) assert.ok(workflowProblems(withSkills(skills), builtinRoles()).some(problem => /skills/.test(problem)), JSON.stringify(skills))
  assert.deepEqual(workflowProblems(withSkills(['tidy', 'design:ux-copy', 'a.b_c-d']), builtinRoles()), [])
  const onVerify = { ...full, nodes: full.nodes.map(node => (node.id === 'verify' ? { ...node, skills: ['tidy'] } : node)) }
  assert.ok(workflowProblems(onVerify, builtinRoles()).some(problem => /only an agent step has skills/.test(problem)))
})

test('parseSkill handles files with and without frontmatter', () => {
  assert.deepEqual(parseSkill('---\nname: x\ndescription: "Quoted"\n---\nBody'), { name: 'x', description: 'Quoted', body: 'Body' })
  assert.deepEqual(parseSkill('Just text'), { name: null, description: '', body: 'Just text' })
})
