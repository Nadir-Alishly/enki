// A repo's codebase map: a pyramid of Markdown files under <memory>/map. The root is
// map/README.md; an area with children is a folder with its own README.md, a leaf is <name>.md.
// Each parent's "## Areas" list links its children, and is the only place they're described.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, normalize, relative, sep } from 'node:path'
import { readMainMemory } from './memory.mjs'

export const ROOT_LIMIT = 3 * 1024
export const FILE_LIMIT = 4 * 1024

export const mapDir = memoryDir => join(memoryDir, 'map')
export const hasMap = memoryDir => Boolean(memoryDir) && existsSync(join(mapDir(memoryDir), 'README.md'))
export const rootText = memoryDir => readFileSync(join(mapDir(memoryDir), 'README.md'), 'utf8')

/** The stub root that init and migrate write, for the map task to fill in. */
export const STUB_ROOT = name => `# ${name}\n\nWhat this repo is, its stack, how it runs and is tested, and its conventions. Each area below has its own file.\n\n## Areas\n\n## Gotchas\n`

/** Does a root's text list any areas yet? A stub's list is empty. */
export const listsAreas = text => areaLinks(text).length > 0
export const mapIsEmpty = memoryDir => !hasMap(memoryDir) || !listsAreas(rootText(memoryDir))

const toPosix = path => path.split(sep).join('/')

/** Notes from branches older than the map, still to fold into it: see settleOldNotes in memory.mjs. */
export const unmappedDir = memoryDir => join(memoryDir, 'unmapped')
export function unmappedNotes(memoryDir) {
  if (!memoryDir || !existsSync(unmappedDir(memoryDir))) return []
  const dir = unmappedDir(memoryDir)
  return readdirSync(dir).map(name => ({ path: `unmapped/${name}`, empty: readFileSync(join(dir, name), 'utf8').trim() === '' }))
}

function walk(dir, base = dir) {
  const files = []
  const folders = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      folders.push(toPosix(relative(base, path)))
      const inner = walk(path, base)
      files.push(...inner.files)
      folders.push(...inner.folders)
    } else if (entry.name.endsWith('.md')) files.push(toPosix(relative(base, path)))
  }
  return { files, folders }
}

const LINK = /\[[^\]]*\]\(([^)\s]+)\)/g
const links = text => [...text.matchAll(LINK)].map(match => match[1])

/** The links in a file's "## Areas" section. */
function areaLinks(text) {
  const lines = []
  let inside = false
  for (const line of text.split('\n')) {
    const heading = /^##\s+(.+?)\s*$/.exec(line)
    if (heading) inside = heading[1].toLowerCase() === 'areas'
    else if (inside) lines.push(line)
  }
  return links(lines.join('\n'))
}

const isExternal = link => /^[a-z][a-z0-9+.-]*:\/\//i.test(link) || link.startsWith('mailto:') || link.startsWith('#')
/** `melda-server:api/livekit.md`: a repo's name, a colon, then a path in that repo's map. */
const CROSS = /^([A-Za-z0-9._-]+):(?!\/\/)(.+)$/

/** The file that should list `file` in its Areas: its folder's README, or the folder above's for a README. */
function parentOf(file) {
  const dir = dirname(file)
  if (file.endsWith('/README.md') || file === 'README.md') return dir === '.' ? null : toPosix(join(dirname(dir), 'README.md'))
  return toPosix(join(dir, 'README.md'))
}

function filesLine(text) {
  const line = text.split('\n').find(item => /^Files:/.test(item.trim()))
  if (!line) return []
  return line.trim().slice('Files:'.length).split(',').map(item => item.trim().replaceAll('`', '').replace(/\/$/, '')).filter(item => item && !/[*?]/.test(item))
}

/**
 * Checks one repo's map. Errors block the task's end: a missing root, a folder without a README,
 * a link that goes nowhere, a file its parent doesn't list. Warnings don't: sizes, paths in
 * "Files:" lines that no longer exist, links to other repos that can't be found.
 * `resolveRepo(name, path)` says whether another repo's map has that file: true, false, or null
 * for a repo enki doesn't know.
 */
export function checkMap({ dir, codeDir = null, resolveRepo = () => null }) {
  const errors = []
  const warnings = []
  if (!existsSync(join(dir, 'README.md'))) return { errors: ['map/README.md is missing: the map needs a root'], warnings }
  const { files, folders } = walk(dir)
  const known = new Set(files)
  for (const folder of folders) {
    if (!known.has(`${folder}/README.md`)) errors.push(`map/${folder}/ has no README.md: an area with children needs one, listing them`)
  }
  const listed = new Map()
  for (const file of files) {
    const text = readFileSync(join(dir, file), 'utf8')
    const size = statSync(join(dir, file)).size
    const limit = file === 'README.md' ? ROOT_LIMIT : FILE_LIMIT
    if (size > limit) warnings.push(`map/${file} is ${(size / 1024).toFixed(1)} KB, over ${limit / 1024} KB: split it into areas`)
    for (const link of links(text)) {
      if (isExternal(link)) continue
      const target = link.split('#')[0]
      const cross = CROSS.exec(target)
      if (cross) {
        const found = resolveRepo(cross[1], cross[2])
        if (found === null) warnings.push(`map/${file}: ${link} names a repo enki doesn't know`)
        else if (!found) warnings.push(`map/${file}: ${link} isn't in ${cross[1]}'s map yet`)
        continue
      }
      if (!target.endsWith('.md')) continue
      const resolved = toPosix(normalize(join(dirname(file), target)))
      if (resolved.startsWith('..') || !known.has(resolved)) errors.push(`map/${file}: the link ${link} goes nowhere`)
    }
    listed.set(file, new Set(areaLinks(text).filter(link => !isExternal(link) && !CROSS.test(link)).map(link => toPosix(normalize(join(dirname(file), link.split('#')[0]))))))
    if (codeDir) {
      for (const path of filesLine(text)) {
        if (!existsSync(join(codeDir, path))) warnings.push(`map/${file}: ${path} (in Files:) doesn't exist`)
      }
    }
  }
  for (const file of files) {
    const parent = parentOf(file)
    if (parent && known.has(parent) && !listed.get(parent).has(file)) errors.push(`map/${file} isn't in map/${parent}'s Areas list`)
  }
  return { errors, warnings }
}

/**
 * Checks the map of each of a task's repos that has one. A link to another repo resolves in
 * that repo's task copy when the task includes it, else on the branch it has checked out.
 */
export function checkTaskMaps(task, config) {
  const resolveRepo = (name, path) => {
    const own = task.repos.find(repo => repo.name === name)
    if (own?.memoryDir) return existsSync(join(mapDir(own.memoryDir), path))
    const repo = config.repos.find(item => item.name === name)
    return repo ? readMainMemory(task.projectRoot, repo, `map/${path}`) !== null : null
  }
  return task.repos
    .filter(repo => hasMap(repo.memoryDir))
    .map(repo => {
      const { errors, warnings } = checkMap({ dir: mapDir(repo.memoryDir), codeDir: repo.workdir, resolveRepo })
      const left = unmappedNotes(repo.memoryDir).filter(note => !note.empty)
      return { repo: repo.name, errors, warnings: [...warnings, ...left.map(note => `${note.path} has notes the map lacks: fold them into the map, then empty the file`)] }
    })
}

const AREA_LINE = /^\s*[-*]\s*\[([^\]]*)\]\(([^)\s]+)\)\s*:?\s*(.*)$/
const titleOf = text => /^#\s+(.+?)\s*$/m.exec(text)?.[1] ?? null

/**
 * The project's maps as a graph, for the dashboard: a node per map file (and per repo with no map,
 * and one for the project when it has several repos), "tree" edges from each file to its parent, and
 * "link" edges for the other links between map files, across repos too. `repos` is
 * [{ name, files: { 'shop/README.md': text } }]. Each node's `links` resolves its hrefs to node ids.
 */
export function mapGraph(project, repos) {
  const nodes = []
  const edges = []
  const id = (repo, path) => `${repo}:${path}`
  const known = new Set(repos.flatMap(repo => Object.keys(repo.files).filter(path => path.endsWith('.md')).map(path => id(repo.name, path))))
  const hub = repos.length > 1 ? '@project' : null
  if (hub) nodes.push({ id: hub, kind: 'project', title: project, repo: null, depth: 0 })
  const seen = new Set()
  const edge = (from, to, kind) => {
    const key = [from, to].sort().join('|')
    if (from === to || seen.has(key)) return
    seen.add(key)
    edges.push({ from, to, kind })
  }
  for (const repo of repos) {
    if (!known.has(id(repo.name, 'README.md'))) {
      nodes.push({ id: id(repo.name, ''), kind: 'empty', title: repo.name, repo: repo.name, depth: hub ? 1 : 0 })
      if (hub) edge(hub, id(repo.name, ''), 'tree')
      continue
    }
    const listedBy = new Map()
    for (const [path, text] of Object.entries(repo.files)) {
      for (const line of text.split('\n')) {
        const match = AREA_LINE.exec(line)
        if (match && areaLinks(text).includes(match[2])) listedBy.set(toPosix(normalize(join(dirname(path), match[2].split('#')[0]))), { name: match[1], description: match[3] })
      }
    }
    for (const path of Object.keys(repo.files).filter(item => item.endsWith('.md')).sort()) {
      const text = repo.files[path]
      const parent = parentOf(path)
      const depth = path.split('/').length - (path.endsWith('README.md') ? 1 : 0) + (hub ? 1 : 0)
      const resolved = {}
      for (const link of links(text)) {
        if (isExternal(link)) continue
        const target = link.split('#')[0]
        const cross = CROSS.exec(target)
        const to = cross ? id(cross[1], cross[2]) : target.endsWith('.md') ? id(repo.name, toPosix(normalize(join(dirname(path), target)))) : null
        if (to && known.has(to)) resolved[link] = to
      }
      const listed = listedBy.get(path)
      nodes.push({
        id: id(repo.name, path),
        kind: path === 'README.md' ? 'root' : 'area',
        repo: repo.name,
        path,
        title: path === 'README.md' ? repo.name : (titleOf(text) ?? listed?.name ?? path.replace(/(\/README)?\.md$/, '')),
        description: listed?.description ?? null,
        listed: path === 'README.md' || Boolean(listed),
        depth,
        files: filesLine(text),
        size: Buffer.byteLength(text),
        limit: path === 'README.md' ? ROOT_LIMIT : FILE_LIMIT,
        text,
        links: resolved,
      })
      const up = parent && known.has(id(repo.name, parent)) ? id(repo.name, parent) : path === 'README.md' ? hub : id(repo.name, 'README.md')
      if (up) edge(up, id(repo.name, path), 'tree')
    }
  }
  for (const node of nodes) for (const to of Object.values(node.links ?? {})) edge(node.id, to, 'link')
  return { nodes, edges }
}
