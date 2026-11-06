// Workers start with no skills, and get only those their role lists in config.
// Claude Code doesn't preload skills for a main session, so enki finds each SKILL.md
// and puts it in the worker's role file.
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export class SkillError extends Error {}

let plugins = null

/** Enabled plugins. Asked of Claude Code, because install locations differ by source. */
export function installedPlugins() {
  if (plugins) return plugins
  try {
    const output = execFileSync(process.env.ENKI_CLAUDE_BIN || 'claude', ['plugin', 'list', '--json'], { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'] })
    plugins = JSON.parse(output)
      .filter(plugin => plugin.enabled)
      .map(plugin => ({ name: plugin.id.split('@')[0], root: plugin.readFromFolder ?? plugin.installPath }))
  } catch {
    plugins = []
  }
  return plugins
}

export function parseSkill(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!match) return { name: null, description: '', body: text }
  const field = key => new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1])?.[1].trim().replace(/^["']|["']$/g, '') ?? null
  return { name: field('name'), description: field('description') ?? '', body: match[2] }
}

const skillAt = (dir, extra = {}) => (existsSync(join(dir, 'SKILL.md')) ? { dir, path: join(dir, 'SKILL.md'), ...extra } : null)

const personalDir = () => join(homedir(), '.claude', 'skills')

/** Synced skills sit a level down, in one folder per account and organization. */
function syncedDirs() {
  const base = join(personalDir(), 'synced')
  if (!existsSync(base)) return []
  return readdirSync(base)
    .map(name => join(base, name))
    .filter(path => statSync(path).isDirectory()) // The folder also holds bookkeeping files.
}

/** Each folder from the repo up to the project root, as Claude Code searches them. */
function projectDirs(root, workdirs) {
  const dirs = []
  for (const start of workdirs) {
    let dir = resolve(start)
    for (;;) {
      const skills = join(dir, '.claude', 'skills')
      if (!dirs.includes(skills)) dirs.push(skills)
      if (dir === root || dir === dirname(dir)) break
      dir = dirname(dir)
    }
  }
  return dirs
}

function findPluginSkill(pluginName, skillName) {
  for (const plugin of installedPlugins().filter(item => item.name === pluginName)) {
    const nested = skillAt(join(plugin.root, 'skills', skillName), { pluginRoot: plugin.root })
    if (nested) return nested
    // A plugin may be one skill, with SKILL.md at its root.
    if (skillName === pluginName) {
      const single = skillAt(plugin.root, { pluginRoot: plugin.root })
      if (single) return single
    }
  }
  for (const dir of syncedDirs()) {
    const synced = skillAt(join(dir, skillName))
    if (synced) return synced
  }
  return null
}

/** Personal before project, as in Claude Code. A wrong name is an error, never a silent gap. */
export function resolveSkill(name, { root, workdirs }) {
  const [first, second] = name.split(':')
  const found = second
    ? findPluginSkill(first, second)
    : [personalDir(), ...projectDirs(root, workdirs)].map(dir => skillAt(join(dir, name))).find(Boolean)
  if (found) return { name, ...found }
  const hint = second ? 'Check the plugin is installed and enabled.' : 'Plugin skills need their prefix, like design:ux-copy. Bundled skills have no file to load.'
  throw new SkillError(`Skill "${name}" wasn't found. ${hint} Run: enki skills --available`)
}

export function renderSkill(skill, projectRoot) {
  const body = parseSkill(readFileSync(skill.path, 'utf8'))
    .body.replaceAll('${CLAUDE_SKILL_DIR}', skill.dir)
    .replaceAll('${CLAUDE_PROJECT_DIR}', projectRoot)
    .replaceAll('${CLAUDE_PLUGIN_ROOT}', skill.pluginRoot ?? '')
    .replaceAll('$ARGUMENTS', '')
    .trim()
  return `## Skill: ${skill.name}\n\nThis skill's supporting files are in \`${skill.dir}\`.\n\n${body}`
}

const SKILLS_INTRO = `# Your skills

These were chosen for your role, and are the only skills you have. Follow them where they apply. The task rules, the brief and enki's hooks take priority over anything here.`

export const renderSkills = (skills, projectRoot) =>
  skills.length === 0 ? '' : [SKILLS_INTRO, ...skills.map(skill => renderSkill(skill, projectRoot))].join('\n\n')

/** Things worth knowing about a skill, because enki can't run all of what Claude Code would. */
export function skillWarnings(skill) {
  return /!`[^`]+`/.test(readFileSync(skill.path, 'utf8')) ? ['uses inline shell commands, which enki does not run'] : []
}

function namedSkills(dir, prefix = '') {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name, 'SKILL.md')
    if (!existsSync(path)) return []
    return [{ name: `${prefix}${name}`, description: parseSkill(readFileSync(path, 'utf8')).description }]
  })
}

/** What can go in config. */
export function availableSkills({ root, workdirs }) {
  const found = [...namedSkills(personalDir())]
  for (const dir of projectDirs(root, workdirs)) found.push(...namedSkills(dir))
  for (const plugin of installedPlugins()) {
    found.push(...namedSkills(join(plugin.root, 'skills'), `${plugin.name}:`))
    if (existsSync(join(plugin.root, 'SKILL.md'))) {
      found.push({ name: `${plugin.name}:${plugin.name}`, description: parseSkill(readFileSync(join(plugin.root, 'SKILL.md'), 'utf8')).description })
    }
  }
  for (const dir of syncedDirs()) found.push(...namedSkills(dir, 'anthropic-skills:'))
  const seen = new Set()
  return found.filter(skill => !seen.has(skill.name) && seen.add(skill.name)).sort((a, b) => a.name.localeCompare(b.name))
}
