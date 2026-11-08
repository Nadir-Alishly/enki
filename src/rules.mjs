// Renders the per-task rules.md every worker reads first, and role files with browser instructions.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pluginRoot } from './paths.mjs'
import { renderSkills } from './skills.mjs'
import { playbookTexts, taskNotesPath } from './memory.mjs'

const fill = (template, values) =>
  template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match))

function repoLines(state, config) {
  return state.repos
    .map(repo => {
      const source = config.repos.find(item => item.name === repo.name)
      const lines = [`- **${repo.name}** at \`${repo.workdir}\``]
      const tree = state.worktrees?.find(item => item.path === repo.worktree)
      if (tree) lines.push(`  - Worktree on branch \`${tree.branch}\`, from \`${tree.base.branch}\`. Work only here: the main tree at \`${repo.main}\` is read-only`)
      lines.push(`  - Notes: \`${taskNotesPath(state, repo)}\``)
      if (repo.url) lines.push(`  - Local URL: ${repo.url}`)
      if (source?.test.length) lines.push(`  - Tests: \`${source.test.join('`, `')}\``)
      if (source?.lint.length) lines.push(`  - Lint: \`${source.lint.join('`, `')}\``)
      if (source?.gate?.commands?.length) lines.push(`  - Quality gate: \`${source.gate.commands.join('`, `')}\``)
      if (source?.gate?.fast) lines.push(`  - Fast gate for the coder: \`${source.gate.fast}\``)
      lines.push(`  - Test files: \`${source?.testGlobs.join('`, `')}\``)
      if (source?.devServer.reload) lines.push(`  - Dev server reload: ${source.devServer.reload}`)
      if (source?.devServer.restartFor?.length) lines.push(`  - Needs a user restart for: ${source.devServer.restartFor.join(', ')}`)
      return lines.join('\n')
    })
    .join('\n')
}

/** One heading's text from every playbook in the task: the project's, then each repo's. */
export function playbookSection(state, heading) {
  return playbookTexts(state)
    .map(text => sectionOf(text, heading))
    .filter(Boolean)
    .join('\n\n')
}

function sectionOf(text, heading) {
  const wanted = heading.toLowerCase()
  let collecting = false
  const lines = []
  for (const line of text.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line)
    if (match) collecting = match[1].toLowerCase() === wanted
    else if (collecting) lines.push(line)
  }
  return lines
    .filter(line => !/^<!--.*-->$/.test(line.trim()))
    .join('\n')
    .trim()
}

export function renderRules(state, config) {
  const template = readFileSync(join(pluginRoot, 'templates', 'rules.md'), 'utf8')
  const playbook = playbookSection(state, 'All')
  return fill(template, {
    slug: state.slug,
    taskDir: state.taskDir,
    projectRoot: state.projectRoot,
    repos: repoLines(state, config),
    scope: state.scope.length > 0 ? state.scope.join(', ') : 'none',
    playbook: playbook === '' ? '' : `## Project rules\n\n${playbook}\n`,
  })
}

export function writeRules(state, config) {
  writeFileSync(join(state.taskDir, 'rules.md'), renderRules(state, config))
}

/** A worker's role prompt: the plugin's role, its browser notes and the project's playbook. */
export function writeRoleFile(state, config, role, skills = []) {
  const parts = [readFileSync(join(pluginRoot, 'roles', `${role}.md`), 'utf8').trim()]
  if (role === 'qa') {
    const driver = config.browser.driver === 'playwright' && !state.repos.some(repo => repo.url) ? 'none' : config.browser.driver
    parts.push(readFileSync(join(pluginRoot, 'roles', 'browser', `${driver}.md`), 'utf8').trim())
  }
  const playbook = playbookSection(state, role)
  if (playbook !== '') parts.push(`## Project rules for the ${role}\n\n${playbook}`)
  const skillText = renderSkills(skills, state.projectRoot)
  if (skillText !== '') parts.push(skillText)
  const path = join(state.taskDir, `role-${role}.md`)
  writeFileSync(path, `${parts.join('\n\n')}\n`)
  return path
}
