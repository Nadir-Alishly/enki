// The Enki dashboard page. The project and task views are view-only; the settings page is the one
// form, and it lives in settings.js. Everything agents or users wrote goes in as text, never as HTML.
import { createAgents } from './agents.js'
import { arrowDefs, autoLayout, drawGraph } from './graph.js'
import { createLibrary } from './library.js'
import { createMap } from './map.js'
import { createSettings } from './settings.js'
import { createStudio } from './studio.js'

/** A stripe for a patterned role, as QA's, in its own color. */
const stripes = color => `repeating-linear-gradient(135deg, ${color} 0 4px, var(--black-950) 4px 7px)`

/** Stripes both ways, as the spec writer's. */
const cross = color => `repeating-linear-gradient(45deg, ${color} 0 3px, transparent 3px 7px), repeating-linear-gradient(135deg, ${color} 0 3px, var(--black-950) 3px 7px)`

/** A dashed outline in a role's color, as a background, so it works wherever a fill does. */
const dashed = color =>
  ['top', 'bottom'].map(side => `repeating-linear-gradient(90deg, ${color} 0 4px, transparent 4px 7px) ${side} / 100% 2px no-repeat`)
    .concat(['left', 'right'].map(side => `repeating-linear-gradient(0deg, ${color} 0 4px, transparent 4px 7px) ${side} / 2px 100% no-repeat`))
    .join(', ')

/** Enki's own roles. A task's own steps (another role, or a second coder) are learned from the server. */
const BUILTIN_ROLE = {
  orchestrator: { label: 'Orchestrator', fill: 'var(--orange)', deep: 'var(--maroon)' },
  // The scout and the planner share lavender, as QA and the tester share green: the scout's is striped.
  scout: { label: 'Scout', fill: stripes('var(--lavender)'), deep: 'var(--indigo)', line: 'var(--lavender)', pattern: 'stripes' },
  planner: { label: 'Planner', fill: 'var(--lavender)', deep: 'var(--indigo)' },
  coder: { label: 'Coder', fill: 'var(--yellow)', deep: 'var(--brown)' },
  tester: { label: 'Tester', fill: 'var(--green)', deep: 'var(--forest)' },
  // Its fill is a stripe, which a border can't draw: outlines use the tester's green.
  qa: { label: 'QA', fill: 'var(--qa-fill)', deep: 'var(--black-950)', line: 'var(--green)', pattern: 'stripes' },
  reviewer: { label: 'Reviewer', fill: 'var(--white-100)', deep: 'var(--black-950)' },
}
const ROLE_ORDER = Object.keys(BUILTIN_ROLE)
const learnedRoles = {}


/** Remembers how the server labels and colors each step, so every view shows them the same way. */
function learnRoles(styles) {
  for (const [id, style] of Object.entries(styles ?? {})) {
    // Enki's own look wins, and clears what another view learned under the same id.
    if (BUILTIN_ROLE[id] && (style.role === id || id === 'orchestrator')) {
      delete learnedRoles[id]
      continue
    }
    const color = style.color ?? BUILTIN_ROLE[style.role]?.line ?? (BUILTIN_ROLE[style.role]?.fill?.startsWith('var(') ? BUILTIN_ROLE[style.role].fill : null) ?? 'var(--border)'
    learnedRoles[id] = { label: style.label ?? id, fill: style.pattern === 'stripes' ? stripes(color) : style.pattern === 'cross' ? cross(color) : style.pattern === 'dashed' ? dashed(color) : color, deep: 'var(--black-950)', line: color, pattern: style.pattern ?? null }
  }
}

/** A step's label and colors: learned from the server, else enki's own, else neutral. */
const roleOf = id => learnedRoles[id] ?? BUILTIN_ROLE[id] ?? { label: id, fill: 'var(--border)', deep: 'var(--black-950)', line: 'var(--border)' }

/** The chart's roles: enki's own first, in their order, then the project's own. */
// The spec writer's type comes from the server, and sits between the scout and the planner when a task used it.
const chartRoles = project => {
  const order = ROLE_ORDER.flatMap(id => (id === 'scout' && project.roles?.spec ? [id, 'spec'] : [id]))
  return [...order, ...Object.keys(project.roles ?? {}).filter(id => !order.includes(id))]
}

const AGENT_STATE = {
  running: { label: 'Running', color: 'var(--green)', pulse: true },
  'needs-you': { label: 'Needs you', color: 'var(--yellow)' },
  idle: { label: 'Idle', color: 'var(--ink-muted)' },
  done: { label: 'Done', color: 'var(--ink-muted)' },
  stopped: { label: 'Stopped', color: 'var(--ink-muted)' },
  error: { label: 'Error', color: 'var(--danger)' },
  'not-started': { label: 'Not started', color: 'var(--border-subtle)' },
}
const TASK_STATE = {
  running: { label: 'Running', color: 'var(--green)', pulse: true, ongoing: true },
  'needs-you': { label: 'Needs you', color: 'var(--yellow)', ongoing: true },
  done: { label: 'Done', color: 'var(--ink-muted)' },
  abandoned: { label: 'Abandoned', color: 'var(--danger)' },
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const SIDEBAR_LIMIT = 5

const agents = createAgents({
  h: (...args) => h(...args),
  svg: (...args) => svg(...args),
  getJson: path => getJson(path),
  postJson: (path, body) => postJson(path, body),
  learnRoles: styles => learnRoles(styles),
  roleOf: id => roleOf(id),
  agentsHref: id => agentsHref(id),
  agentHref: (id, agent) => agentHref(id, agent),
  newAgentHref: id => newAgentHref(id),
  workflowHref: (id, workflow) => editHref(id, workflow),
})

const studio = createStudio({
  h: (...args) => h(...args),
  getJson: path => getJson(path),
  postJson: (path, body) => postJson(path, body),
  learnRoles: styles => learnRoles(styles),
  roleOf: id => roleOf(id),
  libraryHref: id => libraryHref(id),
  editHref: (id, workflow) => editHref(id, workflow),
  onSaved: id => library.refresh(id),
  agentHref: (id, agent) => agentHref(id, agent),
  newAgentHref: id => newAgentHref(id),
})

const library = createLibrary({
  h: (...args) => h(...args),
  svg: (...args) => svg(...args),
  getJson: path => getJson(path),
  postJson: (path, body) => postJson(path, body),
  learnRoles: styles => learnRoles(styles),
  roleOf: id => roleOf(id),
  editHref: (id, workflow) => editHref(id, workflow),
})

const map = createMap({
  h: (...args) => h(...args),
  getJson: path => getJson(path),
})

const settings = createSettings({
  h: (...args) => h(...args),
  svg: (...args) => svg(...args),
  chip: (...args) => chip(...args),
  getJson: path => getJson(path),
  learnRoles: styles => learnRoles(styles),
  libraryHref: id => libraryHref(id),
  // The sidebar's "N unsaved" badge follows the draft.
  onDirty: () => {
    renderSidebar()
    fitTasks()
  },
})

const view = {
  projects: [],
  herdr: true,
  project: null,
  task: null,
  error: null,
  connected: true,
  menuOpen: false,
  moreOpen: false,
  range: readSetting('range', 30),
  focus: null,
}

// ---------- small helpers ----------

function readSetting(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(`enki.${key}`))
    return value ?? fallback
  } catch {
    return fallback
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(`enki.${key}`, JSON.stringify(value))
  } catch {
    // Private windows: the setting just isn't remembered.
  }
}

/** Builds an element. Children may be strings (added as text), elements, arrays or nothing. */
function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'style') {
      for (const [name, rule] of Object.entries(value)) {
        if (name.startsWith('--')) node.style.setProperty(name, rule)
        else node.style[name] = rule
      }
    }
    else if (key === 'text') node.textContent = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value)
    else node.setAttribute(key, value === true ? '' : value)
  }
  append(node, children)
  return node
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
}

function svg(size, paths, { stroke = 'currentColor', width = 2, cls, box = 16 } = {}) {
  const ns = 'http://www.w3.org/2000/svg'
  const node = document.createElementNS(ns, 'svg')
  node.setAttribute('width', size)
  node.setAttribute('height', size)
  node.setAttribute('viewBox', `0 0 ${box} ${box}`)
  node.setAttribute('fill', 'none')
  node.setAttribute('stroke', stroke)
  node.setAttribute('stroke-width', width)
  node.setAttribute('aria-hidden', 'true')
  if (cls) node.setAttribute('class', cls)
  for (const [tag, attrs] of paths) {
    const child = document.createElementNS(ns, tag)
    for (const [key, value] of Object.entries(attrs)) child.setAttribute(key, value)
    node.append(child)
  }
  return node
}

const chevron = open => svg(16, [['path', { d: 'M4 6l4 4 4-4' }]], { cls: `chev${open ? ' chev--open' : ''}` })
const check = (color = 'currentColor') => svg(12, [['path', { d: 'M3 8.5l3.2 3L13 4.5' }]], { stroke: color, width: 2.5 })
const eye = () => svg(14, [['path', { d: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z' }], ['circle', { cx: 8, cy: 8, r: 2 }]], { width: 1.6 })

function tokens(n) {
  if (!n) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
  return `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)}M`
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

function ago(iso) {
  if (!iso) return ''
  const ms = Date.now() - Date.parse(iso)
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  // By calendar day, as the token chart counts them.
  const date = new Date(iso)
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 86400000)
  if (days === 1) return 'yesterday'
  if (days < 7) return WEEKDAYS[date.getDay()]
  return `${MONTHS[date.getMonth()]} ${date.getDate()}`
}

const clock = iso => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
const dayLabel = key => {
  const [y, m, d] = key.split('-').map(Number)
  return `${MONTHS[m - 1]} ${d}`
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const elapsed = task => (task.finishedAt ? task.elapsedMs : Date.now() - Date.parse(task.startedAt))

function dot(color, pulse) {
  return h('span', { class: `dot${pulse ? ' pulse' : ''}`, style: { background: color } })
}

function stateLabel(state) {
  return h('span', { class: 'state', style: { color: state.color } }, dot(state.color, state.pulse), state.label)
}

function badge(state) {
  return h('span', { class: 'badge', style: { color: state.color } }, dot(state.color, state.pulse), state.label)
}

function chip(role, size) {
  return h('span', { class: 'chip', 'aria-hidden': 'true', style: { width: `${size}px`, height: `${size}px`, background: roleOf(role)?.fill ?? 'transparent' } })
}

// ---------- routing and data ----------

function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent)
  return {
    project: parts[0] === 'p' ? parts[1] : null,
    task: parts[2] === 't' ? parts[3] : null,
    settings: parts[2] === 'settings',
    library: parts[2] === 'library',
    map: parts[2] === 'map',
    edit: parts[2] === 'workflows' ? parts[3] ?? null : null,
    // The Agents page: the list, one agent's editor, or a new one.
    agents: parts[2] === 'agents' ? { id: parts[3] ?? null } : parts[2] === 'new-agent' ? { id: '+new' } : null,
  }
}

const projectHref = id => `#/p/${encodeURIComponent(id)}`
const taskHref = (project, task) => `${projectHref(project)}/t/${encodeURIComponent(task)}`
const settingsHref = id => `${projectHref(id)}/settings`
const libraryHref = id => `${projectHref(id)}/library`
const mapHref = id => `${projectHref(id)}/map`
const agentsHref = id => `${projectHref(id)}/agents`
const agentHref = (id, agent) => `${agentsHref(id)}/${encodeURIComponent(agent)}`
const newAgentHref = id => `${projectHref(id)}/new-agent`
const editHref = (id, workflow) => `${projectHref(id)}/workflows/${encodeURIComponent(workflow)}`

let editToken = null
/** A write through the dashboard's guard: JSON, from this page, with its edit token. */
async function postJson(path, body) {
  try {
    editToken ??= (await getJson('/api/session')).editToken
    const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-enki-edit': editToken }, body: JSON.stringify(body) })
    const parsed = await response.json().catch(() => ({}))
    if (response.status === 403) editToken = null
    return { ok: response.ok, status: response.status, body: parsed }
  } catch (error) {
    return { ok: false, status: 0, body: { error: error.message } }
  }
}

async function getJson(path) {
  const response = await fetch(path, { cache: 'no-store' })
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(body.error ?? `HTTP ${response.status}`)
  }
  return response.json()
}

let loading = 0
async function load() {
  const ticket = ++loading
  try {
    const list = await getJson('/api/projects')
    const r = route()
    const projectId = r.project ?? list.projects[0]?.id
    const entry = list.projects.find(p => p.id === projectId)
    // The settings page loads its own data, and keeps it while live updates come in.
    const project = !entry ? null : r.settings || r.library || r.edit || r.agents || r.map ? { id: entry.id, name: entry.name } : await getJson(`/api/projects/${encodeURIComponent(projectId)}`)
    const task = project && r.task ? await getJson(`/api/projects/${encodeURIComponent(project.id)}/tasks/${encodeURIComponent(r.task)}`).catch(() => null) : null
    learnRoles(project?.roles)
    learnRoles(task?.roles)
    if (ticket !== loading) return
    // The map page keeps its own data, and reloads it when the project changes.
    if (project && r.map) map.refresh(project.id)
    Object.assign(view, { projects: list.projects, herdr: list.herdr, project, task, error: null })
  } catch (error) {
    if (ticket !== loading) return
    view.error = error.message
  }
  render()
}

// ---------- sidebar ----------

function renderSidebar() {
  const side = document.querySelector('.side')
  const list = view.projects
  const current = list.find(p => p.id === view.project?.id)
  const r = route()
  const nodes = [h('div', { class: 'brand' }, h('div', { class: 'brand__mark', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'), h('span'), h('span')), h('span', { class: 'brand__name' }, 'Enki'))]

  if (current) {
    const menu = view.menuOpen
      ? h(
          'div',
          { class: 'switcher__menu', role: 'listbox', 'aria-label': 'Switch project' },
          list.map(project => {
            const selected = project.id === current.id
            const sub = [project.running && `${project.running} running`, project.needsYou && `${project.needsYou} need you`].filter(Boolean).join(' · ') || plural(project.total, 'task')
            return h(
              'button',
              {
                class: 'option',
                role: 'option',
                'aria-selected': String(selected),
                onClick: () => {
                  view.menuOpen = false
                  location.hash = r.settings ? settingsHref(project.id) : r.map ? mapHref(project.id) : projectHref(project.id)
                },
              },
              h('span', { class: 'option__text' }, h('span', { class: 'option__name' }, project.name), h('span', { class: 'option__sub' }, sub)),
              selected && check(),
            )
          }),
        )
      : null
    nodes.push(
      h(
        'div',
        { class: 'switcher' },
        h(
          'button',
          {
            class: 'switcher__button',
            'aria-haspopup': 'listbox',
            'aria-expanded': String(view.menuOpen),
            onClick: () => {
              view.menuOpen = !view.menuOpen
              render()
            },
          },
          h('span', { class: 'switcher__text' }, h('span', { class: 'switcher__label' }, 'Project'), h('span', { class: 'switcher__name' }, current.name)),
          chevron(view.menuOpen),
        ),
        menu,
      ),
    )
    nodes.push(
      h(
        'a',
        { class: 'navitem', href: projectHref(current.id), 'aria-current': r.task || r.settings || r.library || r.edit || r.agents || r.map ? null : 'page' },
        svg(16, [['rect', { x: 1.5, y: 1.5, width: 13, height: 13 }], ['path', { d: 'M1.5 6.5h13M6.5 6.5v8' }]], { width: 1 }),
        'Project overview',
      ),
    )

    const ongoing = current.tasks.filter(task => TASK_STATE[task.status]?.ongoing)
    const finished = current.tasks.filter(task => !TASK_STATE[task.status]?.ongoing)
    const groups = []
    for (const [label, tasks] of [
      ['Ongoing', ongoing],
      ['Finished', finished],
    ]) {
      if (tasks.length === 0) continue
      groups.push(
        h(
          'div',
          { class: 'group' },
          h('div', { class: 'group__head' }, h('span', {}, label), h('span', {}, String(tasks.length))),
          tasks.map(task => {
            const state = TASK_STATE[task.status]
            return h(
              'a',
              { class: 'taskitem', href: taskHref(current.id, task.id), 'aria-current': r.task === task.id ? 'page' : null, title: task.goal ?? task.title },
              h('span', { class: 'taskitem__title' }, task.title),
              h(
                'span',
                { class: 'taskitem__meta' },
                h('span', { class: 'state' }, dot(state.color, state.pulse), state.label),
                h('span', { 'aria-hidden': 'true' }, '·'),
                h('span', {}, task.slug),
                h('span', { 'aria-hidden': 'true' }, '·'),
                h('span', {}, ago(task.finishedAt ?? task.startedAt)),
              ),
            )
          }),
        ),
      )
    }
    nodes.push(h('nav', { class: `tasknav${view.moreOpen ? ' tasknav--more' : ''}`, 'aria-label': 'Tasks' }, groups.length ? groups : h('p', { class: 'muted', style: { margin: '0 8px', fontSize: '14px' } }, 'No tasks yet.')))
    // fitTasks() decides after layout whether this is needed and what it says.
    nodes.push(
      h(
        'button',
        {
          class: 'more',
          hidden: true,
          'aria-expanded': String(view.moreOpen),
          onClick: () => {
            view.moreOpen = !view.moreOpen
            render()
          },
        },
        chevron(view.moreOpen),
        h('span', {}),
      ),
    )
  }

  if (current) {
    const count = settings.unsaved(current.id)
    nodes.push(
      h(
        'div',
        { class: 'side__foot' },
        h(
          'a',
          { class: 'navitem', href: mapHref(current.id), 'aria-current': r.map ? 'page' : null },
          svg(16, [['circle', { cx: 8, cy: 8, r: 2.5 }], ['circle', { cx: 2.5, cy: 3, r: 1.5 }], ['circle', { cx: 13.5, cy: 4, r: 1.5 }], ['circle', { cx: 4, cy: 13.5, r: 1.5 }], ['path', { d: 'M3.6 4.1l2.6 2.3M12.2 4.8l-2.1 1.9M5 12.4l1.4-2.3' }]], { width: 1.2 }),
          h('span', { class: 'navitem__text' }, 'Codebase map'),
        ),
        h(
          'a',
          { class: 'navitem', href: libraryHref(current.id), 'aria-current': r.library || r.edit ? 'page' : null },
          svg(16, [['rect', { x: 5.5, y: 1.5, width: 5, height: 3 }], ['rect', { x: 1.5, y: 11.5, width: 5, height: 3 }], ['rect', { x: 9.5, y: 11.5, width: 5, height: 3 }], ['path', { d: 'M8 4.5v3.5M4 11.5V8h8v3.5' }]], { width: 1 }),
          h('span', { class: 'navitem__text' }, 'Workflows'),
        ),
        h(
          'a',
          { class: 'navitem', href: agentsHref(current.id), 'aria-current': r.agents ? 'page' : null },
          svg(16, [['circle', { cx: 8, cy: 5, r: 3 }], ['path', { d: 'M2.5 14.5c.6-3 2.8-4.5 5.5-4.5s4.9 1.5 5.5 4.5' }]], { width: 1.2 }),
          h('span', { class: 'navitem__text' }, 'Agents'),
        ),
        h(
          'a',
          { class: 'navitem', href: settingsHref(current.id), 'aria-current': r.settings ? 'page' : null },
          gear(),
          h('span', { class: 'navitem__text' }, 'Project settings'),
          count > 0 && h('span', { class: 'navitem__badge' }, `${count} unsaved`),
        ),
      ),
    )
  }
  side.replaceChildren(...nodes)
}

/**
 * Shows as many tasks as the sidebar has room for, newest first, and puts the rest behind
 * "Show N more". On narrow screens, where the sidebar sits above the page, it shows five.
 */
function fitTasks() {
  const nav = document.querySelector('.tasknav')
  const more = document.querySelector('.more')
  if (!nav || !more) return
  const items = [...nav.querySelectorAll('.taskitem')]
  const label = more.querySelector('span:last-child')
  const show = count => {
    items.forEach((item, i) => (item.hidden = i >= count))
    for (const group of nav.querySelectorAll('.group')) group.hidden = !group.querySelector('.taskitem:not([hidden])')
  }
  show(items.length)
  more.hidden = true
  if (view.moreOpen) {
    more.hidden = false
    label.textContent = 'Show fewer'
    return
  }
  let fits
  if (window.matchMedia('(min-width: 901px)').matches) {
    const bottom = () => nav.getBoundingClientRect().bottom + 0.5
    const fitting = () => items.findIndex(item => item.getBoundingClientRect().bottom > bottom())
    fits = fitting()
    if (fits === -1) return
    // Room for the button comes out of the list.
    more.hidden = false
    show(items.length)
    fits = fitting()
    if (fits === -1) fits = items.length
    show(fits)
  } else {
    fits = Math.min(items.length, SIDEBAR_LIMIT)
    show(fits)
  }
  const hidden = items.length - fits
  more.hidden = hidden === 0
  label.textContent = `Show ${hidden} more`
}

let refit = 0
window.addEventListener('resize', () => {
  cancelAnimationFrame(refit)
  refit = requestAnimationFrame(fitTasks)
})

/** "claude-sonnet-5-5" reads better as "Sonnet 5.5". */
function shortModel(model) {
  if (!model) return '—'
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model)
  if (!match) return model
  return `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] && match[3].length < 3 ? `.${match[3]}` : ''}`
}

// ---------- shared page parts ----------

/** Shown only when something is wrong with live updates. */
function liveBadge() {
  if (!view.connected) return h('span', { class: 'pill pill--off', role: 'status' }, eye(), 'Reconnecting…')
  if (!view.herdr) return h('span', { class: 'pill pill--off', role: 'status', title: 'herdr could not be reached, so live agent states are unknown' }, eye(), 'herdr offline')
  return null
}

// A cog, from the Lucide icon set (ISC licence).
const gear = () =>
  svg(
    16,
    [
      ['path', { d: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z' }],
      ['circle', { cx: 12, cy: 12, r: 3 }],
    ],
    { box: 24, width: 2 },
  )

function stats(items) {
  return h(
    'div',
    { class: 'stats' },
    items.map(item => h('div', { class: 'stat', title: item.title }, h('span', { class: 'stat__label' }, item.label), h('span', { class: 'stat__value' }, item.value), h('span', { class: 'stat__note' }, item.note))),
  )
}

function sectionHead(id, title, note) {
  return h('div', { class: 'section__head' }, h('h2', { id }, title), note && h('span', { class: 'section__note num' }, note))
}

// ---------- task view ----------

function agentCard(agent, lead) {
  const state = AGENT_STATE[agent.state] ?? AGENT_STATE.idle
  const role = roleOf(agent.role)
  const quiet = agent.state === 'not-started' ? ' agent--absent' : agent.state === 'idle' || agent.state === 'done' || agent.state === 'stopped' ? ' agent--quiet' : ''
  const pct = agent.contextWindow ? Math.min(100, (agent.context / agent.contextWindow) * 100) : 0
  const model = agent.model ? shortModel(agent.model) : null
  const sub = [model ?? (lead ? 'Your session' : 'Model unknown'), (lead || agent.calls > 0) && plural(agent.calls, 'tool call'), agent.spent > 0 && `${tokens(agent.spent)} spent`].filter(Boolean).join(' · ')
  const step = agent.step
    ? `Step ${agent.step.n}: ${agent.step.text}`
    : agent.state === 'not-started'
      ? 'Not part of this task'
      : agent.state === 'done'
        ? 'Finished'
        : 'No step in progress'
  return h(
    'article',
    { class: `agent${lead ? ' agent--lead' : ''}${quiet}`, 'aria-label': `${role.label}: ${state.label}`, ...focusable(agent.role) },
    h(
      'div',
      { class: 'agent__top' },
      h('span', { class: 'swatch', 'aria-hidden': 'true', style: { background: role.fill } }, h('span', { style: { background: role.deep } })),
      h('span', { class: 'agent__who' }, h('span', { class: 'agent__name' }, role.label), h('span', { class: 'agent__model' }, sub)),
      lead && h('span', { class: 'agent__lead-state' }, stateLabel(state)),
    ),
    !lead && stateLabel(state),
    h('div', { class: 'agent__work' }, h('span', { class: 'agent__step' }, step)),
    h(
      'div',
      { class: 'meter' },
      h('span', { class: 'meter__label' }, h('span', {}, 'Context'), h('span', { class: 'num' }, agent.contextWindow ? `${tokens(agent.context)} / ${tokens(agent.contextWindow)}` : 'No data')),
      h('span', { class: 'bar' }, h('span', { class: 'bar__fill', style: { width: `${pct.toFixed(1)}%`, background: role.fill } })),
    ),
  )
}

// ---------- the workflow graph ----------

const SVG_NS = 'http://www.w3.org/2000/svg'

/** An SVG element. Text goes in as text, never markup. */
function sv(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value))
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

const STEP_WORD = { running: 'running', queued: 'waiting', 'handed-off': 'with the orchestrator', waiting: 'waiting for you', done: 'done', idle: 'idle' }

/**
 * A task's workflow, drawn as in the studio and fitted to the page: no scrolling, no zoom. It is the
 * team view too: each agent step shows its state, model, effort and context, and the orchestrator
 * sits top left.
 */
function workflowGraph(task) {
  const workflow = task.workflow
  const definition = { nodes: workflow.nodes.map(({ id, kind, agent }) => ({ id, ...(kind ? { kind } : { agent }) })), edges: workflow.edges.map(({ from, on, to, max }) => ({ from, on, to, ...(max ? { max } : {}) })) }
  const outcomesOfRole = node => workflow.nodes.find(item => item.id === node.id)?.outcomes ?? []
  const auto = autoLayout(definition, outcomesOfRole)
  const layout = Object.fromEntries(definition.nodes.map(node => [node.id, workflow.layout?.[node.id] ?? auto[node.id]]))
  const styleOf = node => {
    const look = roleOf(node.id)
    return { label: look.label, color: look.line ?? look.fill, pattern: look.pattern ?? null, roleName: '' }
  }
  const { group, bounds } = drawGraph(definition, { layout, routes: workflow.routes ?? {}, outcomesOfRole, styleOf, status: workflow, format: { model: shortModel, tokens } })
  const label = `Workflow ${workflow.name}: ${workflow.nodes.filter(node => !node.kind || node.kind === 'verify').map(node => `${node.label} ${STEP_WORD[node.status] ?? node.status}`).join(', ')}`
  const svgNode = sv('svg', { class: 'wf-svg', viewBox: `${bounds.x} ${bounds.y} ${bounds.w} ${bounds.h}`, role: 'img', 'aria-label': label }, arrowDefs(), group)
  svgNode.style.maxWidth = `${Math.round(bounds.w * 1.1)}px`
  const open = workflow.nodes.filter(node => node.status === 'handed-off').length
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'wf-h' },
    h(
      'div',
      { class: 'section__head' },
      h('h2', { id: 'wf-h' }, h('span', { class: 'section__kicker' }, 'Workflow'), workflow.name),
      h('span', { class: 'section__note' }, [workflow.ended ? 'Reached its end' : open ? `${open} with the orchestrator` : null, h('a', { href: editHref(task.project.id, workflow.id) }, 'Open in the studio')].filter(Boolean).flatMap((item, index) => (index ? [' · ', item] : [item]))),
    ),
    h('div', { class: 'panel wf' }, svgNode, h('p', { class: 'wf-legend' }, '↩ an outcome with no line goes back to the orchestrator')),
  )
}

function renderTask(task) {
  const state = TASK_STATE[task.status]
  const lead = task.agents.find(agent => agent.role === 'orchestrator')
  const workers = task.agents.filter(agent => agent.role !== 'orchestrator')
  const totalContext = task.agents.reduce((sum, agent) => sum + agent.context, 0)
  const meta = [
    h('a', { href: projectHref(task.project.id) }, task.project.name),
    h('span', { 'aria-hidden': 'true' }, '/'),
    h('span', {}, task.id),
    task.branch && [h('span', { 'aria-hidden': 'true' }, '·'), h('span', {}, task.continues ? `${task.branch} · continues ${task.continues}` : task.base ? `${task.branch} from ${task.base}` : task.branch)],
    h('span', { 'aria-hidden': 'true' }, '·'),
    h('span', {}, `started ${ago(task.startedAt)}`),
  ]
  const phase = task.status === 'done' || task.status === 'abandoned' ? null : `Phase: ${task.phase}`

  const header = h(
    'section',
    { class: 'section', style: { gap: '20px' } },
    h(
      'div',
      { class: 'head' },
      h('div', { class: 'head__text' }, h('div', { class: 'crumbs' }, meta), h('h1', { title: task.goal ?? '' }, task.title), h('div', { class: 'crumbs' }, badge(state), phase && h('span', {}, phase), task.workflow && [h('span', { 'aria-hidden': 'true' }, '·'), h('span', {}, `Workflow: ${task.workflow.name}`)])),
      liveBadge(),
    ),
    task.alerts.length > 0 && h('div', { class: 'alerts' }, task.alerts.map(alert => h('div', { class: `alert alert--${alert.kind}`, role: 'status' }, h('strong', {}, alert.word), h('span', {}, alert.text)))),
    stats([
      { label: 'Elapsed', value: duration(elapsed(task)), note: task.finishedAt ? `finished ${ago(task.finishedAt)}` : `started ${ago(task.startedAt)}` },
      { label: 'Agents active', value: `${task.stats.active} / ${task.stats.agents}`, note: 'running now' },
      { label: 'Tokens spent', value: tokens(task.stats.spent), note: 'all agents, cache reads not counted', title: 'New input, cache writes and output, over every message of every agent. Cache reads are left out: they cost about a tenth as much. Each agent card shows its share.' },
      { label: 'Plan', value: task.stats.steps ? `${task.stats.stepsDone} / ${task.stats.steps}` : '—', note: task.stats.steps ? 'steps done' : 'no steps recorded' },
    ]),
  )

  const working = task.agents.filter(agent => agent.state === 'running').length
  const waiting = task.agents.filter(agent => agent.state === 'needs-you').length
  const team = h(
    'section',
    { class: 'section', 'aria-labelledby': 'team-h' },
    sectionHead('team-h', 'Agent team', [working && `${working} running`, waiting && `${waiting} need you`].filter(Boolean).join(' · ') || null),
    h(
      'div',
      {},
      h('div', { class: 'lead' }, agentCard(lead, true), h('span', { class: 'vline', 'aria-hidden': 'true' })),
      h(
        'div',
        { class: 'team', style: { gridTemplateColumns: `repeat(${Math.min(workers.length, 5)}, minmax(0, 1fr))` } },
        workers.map(agent => h('div', { class: 'member' }, h('div', { class: 'rail', 'aria-hidden': 'true' }), agentCard(agent, false))),
      ),
    ),
  )

  const withContext = task.agents.filter(agent => agent.context > 0)
  // Each card names the agent and, under it, the step that ran it.
  const agentName = agent => task.roles?.[agent.role]?.name ?? roleOf(agent.role).label
  const ctxLabel = agent => (agent.role === 'orchestrator' ? agentName(agent) : `${agentName(agent)} (${agent.role})`)
  const context = h(
    'section',
    { class: 'section panel', 'aria-labelledby': 'ctx-h', style: { gap: '12px' } },
    sectionHead('ctx-h', 'Context in use by agent', `${tokens(totalContext)} in context now, all agents together`),
    h(
      'div',
      { class: `segments${withContext.length ? '' : ' segments--empty'}`, role: 'img', 'aria-label': `Context by agent: ${task.agents.map(agent => `${ctxLabel(agent)} ${tokens(agent.context)}`).join(', ')}` },
      withContext.map(agent => h('span', { class: 'segment', title: `${ctxLabel(agent)}: ${tokens(agent.context)}`, ...focusable(agent.role, false), style: { flex: `${agent.context} 1 0`, background: roleOf(agent.role).fill, '--role': roleOf(agent.role).line ?? roleOf(agent.role).fill } })),
    ),
    h(
      'div',
      { class: 'totals' },
      task.agents.map(agent =>
        h(
          'div',
          { class: 'total', 'aria-label': `${ctxLabel(agent)}: ${tokens(agent.context)} tokens of context`, ...focusable(agent.role) },
          chip(agent.role, 14),
          h(
            'span',
            { class: 'total__text' },
            h('span', { class: 'total__label' }, agentName(agent), agent.role !== 'orchestrator' && h('span', { class: 'total__step' }, agent.role)),
            h('span', { class: 'total__value' }, tokens(agent.context), ' ', h('span', { class: 'total__pct' }, totalContext ? `${Math.round((agent.context / totalContext) * 100)}%` : '0%')),
          ),
        ),
      ),
    ),
  )

  const plan = h(
    'section',
    { class: 'section', 'aria-labelledby': 'plan-h' },
    h('h2', { id: 'plan-h' }, 'Plan'),
    task.steps.length
      ? h(
          'ol',
          { class: 'plan' },
          task.steps.map(step =>
            h(
              'li',
              { 'data-role': step.owner },
              h('span', { class: `mark mark--${step.status}`, 'aria-hidden': 'true' }, step.status === 'done' && check('var(--black-950)')),
              h('span', { class: `plan__text plan__text--${step.status}` }, h('span', { class: 'sr-only' }, `Step ${step.n}, ${step.status === 'todo' ? 'to do' : step.status}: `), step.text),
              h('span', { class: 'plan__owner' }, chip(step.owner, 12), roleOf(step.owner)?.label ?? step.owner),
            ),
          ),
        )
      : h('p', { class: 'empty' }, ['intake', 'spec', 'planning'].includes(task.phase) ? 'The plan appears here once it is approved.' : 'This task was planned before enki recorded steps.'),
  )

  const feed = h(
    'section',
    { class: 'section', 'aria-labelledby': 'act-h' },
    h('h2', { id: 'act-h' }, 'Activity'),
    task.feed.length
      ? h(
          'ol',
          { class: 'feed' },
          task.feed.map(item => h('li', { 'data-role': item.role }, h('time', { datetime: item.at, title: new Date(item.at).toLocaleString() }, clock(item.at)), chip(item.role, 12), h('span', { class: 'feed__text' }, h('strong', {}, item.label), ' ', h('span', { class: 'muted' }, item.text)))),
        )
      : h('p', { class: 'empty' }, 'Nothing has happened yet.'),
  )

  // With a workflow, its graph is the team: each step shows its agent. Older tasks keep their cards.
  return [header, task.workflow ? workflowGraph(task) : team, context, plan, feed]
}

// ---------- picking an agent ----------
// Hovering an agent's card, context segment, chart bar or total lights it up everywhere it appears,
// plan and activity included. Clicking (or Enter) keeps it lit until clicked again or Escape.

let hovered = null

/** Props that make an element pick its agent. Segments are too small to tab to: their totals are. */
function focusable(role, keyboard = true) {
  const pick = () => {
    view.focus = view.focus === role ? null : role
    applyFocus()
  }
  return {
    'data-role': role,
    style: { '--role': roleOf(role)?.line ?? roleOf(role)?.fill },
    tabindex: keyboard ? '0' : null,
    role: keyboard ? 'button' : null,
    'aria-pressed': keyboard ? String(view.focus === role) : null,
    onClick: pick,
    onKeydown: event => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      pick()
    },
  }
}

function applyFocus() {
  const role = hovered ?? view.focus
  const main = document.getElementById('main')
  main.classList.toggle('picking', Boolean(role))
  for (const node of main.querySelectorAll('[data-role]')) {
    node.classList.toggle('is-picked', role !== null && node.dataset.role === role)
    node.classList.toggle('is-dim', role !== null && node.dataset.role !== role)
    if (node.hasAttribute('aria-pressed')) node.setAttribute('aria-pressed', String(view.focus === node.dataset.role))
  }
}

// Delegated, so it survives the live re-renders that replace the elements under the pointer.
const PICKERS = '.agent[data-role], .segment[data-role], .total[data-role], .tbar__part[data-role], .wf-node[data-role]'
document.getElementById('main').addEventListener('mouseover', event => {
  const role = event.target.closest(PICKERS)?.dataset.role ?? null
  if (role === hovered) return
  hovered = role
  applyFocus()
})
document.getElementById('main').addEventListener('mouseleave', () => {
  hovered = null
  applyFocus()
})

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && view.focus) {
    view.focus = null
    applyFocus()
  }
})

// ---------- project view ----------

function heatmap(project) {
  const level = count => (count === 0 ? 0 : count <= 2 ? 1 : count <= 4 ? 2 : count <= 6 ? 3 : 4)
  const days = project.heatmap
  const total = days.reduce((sum, day) => sum + day.count, 0)
  const busiest = Math.max(0, ...days.map(day => day.count))
  const weeks = []
  const months = []
  let previous = null
  for (let w = 0; w < days.length / 7; w++) {
    const week = days.slice(w * 7, w * 7 + 7)
    const month = Number(week[0].day.split('-')[1]) - 1
    months.push(h('span', {}, w > 0 && w < 52 && month !== previous ? MONTHS[month] : ''))
    previous = month
    weeks.push(
      h(
        'div',
        { class: 'heat__week' },
        week.map(day => {
          const weekday = WEEKDAYS[new Date(`${day.day}T12:00:00`).getDay()]
          return h('span', { class: `cell${day.future ? '' : ` lv${level(day.count)}`}`, title: day.future ? null : `${day.count ? plural(day.count, 'task') : 'No tasks'} finished on ${weekday}, ${dayLabel(day.day)}` })
        }),
      ),
    )
  }
  return h(
    'section',
    { class: 'section panel', 'aria-labelledby': 'heat-h' },
    sectionHead('heat-h', 'Task activity', `${plural(total, 'task')} finished in the last year`),
    h(
      'div',
      { class: 'heat-scroll' },
      h(
        'div',
        { class: 'heat', role: 'img', 'aria-label': `${plural(total, 'task')} finished in the last year; busiest day ${plural(busiest, 'task')}` },
        h('div', { class: 'heat__months' }, months),
        h('div', { class: 'heat__grid' }, h('div', { class: 'heat__days', 'aria-hidden': 'true' }, h('span'), h('span', {}, 'Mon'), h('span'), h('span', {}, 'Wed'), h('span'), h('span', {}, 'Fri'), h('span')), weeks),
      ),
    ),
    h('div', { class: 'legend', 'aria-hidden': 'true' }, h('span', { style: { marginRight: '4px' } }, 'Fewer'), [0, 1, 2, 3, 4].map(n => h('span', { class: `cell lv${n}` })), h('span', { style: { marginLeft: '4px' } }, 'More')),
  )
}

function niceTop(max) {
  if (max <= 0) return 1000
  const magnitude = 10 ** Math.floor(Math.log10(max / 2))
  const half = [1, 2, 2.5, 5, 10].map(step => step * magnitude).find(value => value * 2 >= max)
  return half * 2
}

function tokenChart(project) {
  const range = [7, 30, 90].includes(view.range) ? view.range : 30
  const days = project.tokensByDay.slice(-range)
  const totals = days.map(day => chartRoles(project).reduce((sum, role) => sum + (day.roles[role] ?? 0), 0))
  const rangeTotal = totals.reduce((sum, value) => sum + value, 0)
  const top = niceTop(Math.max(0, ...totals))
  const gap = range === 90 ? '1px' : range === 30 ? '3px' : '12px'
  const every = range === 7 ? 1 : range === 30 ? 5 : 15
  const byRole = chartRoles(project).map(role => ({ role, value: days.reduce((sum, day) => sum + (day.roles[role] ?? 0), 0) }))
  const finishedOn = Object.fromEntries(project.heatmap.map(day => [day.day, day.count]))

  return h(
    'section',
    { class: 'section panel', 'aria-labelledby': 'tok-h' },
    h(
      'div',
      { class: 'section__head', style: { alignItems: 'center' } },
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } }, h('h2', { id: 'tok-h' }, 'Tokens spent'), h('span', { class: 'section__note' }, `${tokens(rangeTotal)} in the last ${range} days, by agent type`)),
      h(
        'div',
        { class: 'ranges', role: 'group', 'aria-label': 'Time range' },
        [7, 30, 90].map(value =>
          h(
            'button',
            {
              class: 'range',
              'aria-pressed': String(value === range),
              onClick: () => {
                view.range = value
                saveSetting('range', value)
                render()
              },
            },
            `${value} days`,
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'chart' },
      h('div', { class: 'chart__y', 'aria-hidden': 'true' }, h('span', {}, tokens(top)), h('span', {}, tokens(top / 2)), h('span', {}, '0')),
      h(
        'div',
        { class: 'chart__body' },
        h(
          'div',
          { class: 'chart__plot' },
          h('span', { class: 'gridline', 'aria-hidden': 'true', style: { top: '0' } }),
          h('span', { class: 'gridline', 'aria-hidden': 'true', style: { top: '50%' } }),
          h(
            'div',
            { class: 'bars', role: 'img', 'aria-label': `${tokens(rangeTotal)} tokens over ${range} days: ${byRole.map(item => `${roleOf(item.role).label} ${tokens(item.value)}`).join(', ')}`, style: { gap } },
            days.map((day, i) =>
              h(
                'div',
                { class: 'tbar', title: `${dayLabel(day.day)}: ${tokens(totals[i])} tokens, ${plural(finishedOn[day.day] ?? 0, 'task')} finished`, style: { height: `${((totals[i] / top) * 100).toFixed(2)}%` } },
                chartRoles(project).map(role => h('span', { class: 'tbar__part', 'data-role': role, style: { height: totals[i] ? `${(((day.roles[role] ?? 0) / totals[i]) * 100).toFixed(2)}%` : '0', background: roleOf(role).fill } })),
              ),
            ),
          ),
        ),
        h(
          'div',
          { class: 'chart__x', 'aria-hidden': 'true', style: { gap } },
          days.map((day, i) => h('span', {}, (days.length - 1 - i) % every === 0 ? (range === 7 ? WEEKDAYS[new Date(`${day.day}T12:00:00`).getDay()] : dayLabel(day.day)) : '')),
        ),
      ),
    ),
    h(
      'div',
      { class: 'totals' },
      byRole.map(item =>
        h(
          'div',
          { class: 'total', 'aria-label': `${roleOf(item.role).label}: ${tokens(item.value)} tokens spent`, ...focusable(item.role) },
          chip(item.role, 12),
          h(
            'span',
            { class: 'total__text' },
            h('span', { class: 'total__label' }, roleOf(item.role).label),
            h('span', { class: 'total__value' }, tokens(item.value), ' ', h('span', { class: 'total__pct' }, `${Math.round((item.value / (rangeTotal || 1)) * 100)}%`)),
          ),
        ),
      ),
    ),
  )
}

function taskTable(project) {
  return h(
    'section',
    { class: 'section', 'aria-labelledby': 'tasks-h', style: { gap: '12px' } },
    h('h2', { id: 'tasks-h' }, 'Tasks'),
    project.tasks.length
      ? h(
          'div',
          { class: 'table-scroll' },
          h(
            'div',
            { class: 'table', role: 'table', 'aria-label': 'Tasks in this project' },
            h('div', { class: 'row row--head', role: 'row' }, ['Task ID', 'Task', 'Status', 'Duration', 'Tokens', 'When'].map((label, i) => h('span', { role: 'columnheader', class: i === 3 || i === 4 ? 'right' : null }, label))),
            project.tasks.map(task =>
              h(
                'div',
                { class: 'row', role: 'row' },
                h('span', { role: 'cell', class: 'id', title: task.id }, task.slug),
                h('span', { role: 'cell', style: { minWidth: '0' } }, h('a', { href: taskHref(project.id, task.id), title: task.goal ?? task.title }, task.title)),
                h('span', { role: 'cell' }, badge(TASK_STATE[task.status])),
                h('span', { role: 'cell', class: 'right' }, duration(elapsed(task))),
                h('span', { role: 'cell', class: 'right' }, task.spent ? tokens(task.spent) : '—'),
                h('span', { role: 'cell', class: 'muted' }, ago(task.finishedAt ?? task.startedAt)),
              ),
            ),
          ),
        )
      : h('p', { class: 'empty' }, 'No tasks yet. Ask the orchestrator for one in this project.'),
  )
}

function renderProject(project) {
  const sum = list => list.reduce((total, day) => total + day.count, 0)
  const past = project.heatmap.filter(day => !day.future)
  const last30 = sum(past.slice(-30))
  const before = sum(past.slice(-60, -30))
  const change = before ? Math.round(((last30 - before) / before) * 100) : null
  const cutoff = Date.now() - 30 * 86400000
  const recent = project.tasks.filter(task => task.finishedAt && Date.parse(task.finishedAt) >= cutoff)
  const done = recent.filter(task => task.status === 'done')
  const abandoned = recent.length - done.length
  const average = done.length ? done.reduce((total, task) => total + task.elapsedMs, 0) / done.length : null
  const spent30 = project.tokensByDay.slice(-30).reduce((total, day) => total + Object.values(day.roles).reduce((a, b) => a + b, 0), 0)
  const running = project.tasks.filter(task => task.status === 'running').length
  const waiting = project.tasks.filter(task => task.status === 'needs-you').length
  const repos = project.repos ?? []
  const where = [project.root, repos.length === 1 && repos[0].branch ? `on ${repos[0].branch}` : repos.length > 1 ? plural(repos.length, 'repo') : null].filter(Boolean).join(' · ')

  const header = h(
    'section',
    { class: 'section', style: { gap: '20px' } },
    h(
      'div',
      { class: 'head' },
      h(
        'div',
        { class: 'head__text' },
        h('div', { class: 'crumbs' }, where),
        h('h1', {}, project.name),
        h('span', { class: 'line' }, dot(running ? 'var(--green)' : 'var(--ink-muted)', running > 0), `${running} running · ${waiting} need you · ${plural(project.agentsWorking, 'agent')} working`),
      ),
      h('div', { class: 'head__actions' }, liveBadge(), h('a', { class: 'btn btn--secondary', href: settingsHref(project.id) }, gear(), 'Project settings')),
    ),
    stats([
      { label: 'Tasks finished', value: String(last30), note: change === null ? 'in the last 30 days' : `${change >= 0 ? '+' : ''}${change}% vs previous 30 days` },
      { label: 'Completed', value: recent.length ? `${Math.round((done.length / recent.length) * 100)}%` : '—', note: `${plural(abandoned, 'task')} abandoned in 30 days` },
      { label: 'Avg task duration', value: average === null ? '—' : duration(average), note: 'from start to commit' },
      { label: 'Tokens spent', value: tokens(spent30), note: last30 ? `about ${tokens(spent30 / last30)} per task, 30 days` : 'in the last 30 days' },
    ]),
  )
  return [header, heatmap(project), tokenChart(project), taskTable(project)]
}

// ---------- page ----------

function render() {
  const main = document.getElementById('main')
  renderSidebar()
  const r = route()
  let content
  if (view.error && !view.project) content = [h('h1', {}, 'Enki'), h('p', { class: 'empty' }, `The dashboard couldn't load its data: ${view.error}`)]
  else if (view.projects.length === 0) content = [h('h1', {}, 'Enki'), h('p', { class: 'empty' }, 'No enki projects yet. Run /enki:init in a project, then ask the orchestrator for a task. Projects show up here after their first task.')]
  else if (!view.project) content = [h('h1', {}, 'Not found'), h('p', { class: 'empty' }, 'That project is not registered with enki on this computer. ', h('a', { href: '#/' }, 'Go to the first project'))]
  else if (r.task && !view.task) content = [h('h1', {}, 'Not found'), h('p', { class: 'empty' }, 'That task is not in this project. ', h('a', { href: projectHref(view.project.id) }, 'Back to the project'))]
  else if (r.settings) content = [settings.mount(view.project.id, view.project.name)]
  else if (r.library) content = [library.mount(view.project.id, view.project.name)]
  else if (r.edit) content = [studio.mount(view.project.id, r.edit)]
  else if (r.agents) content = [agents.mount(view.project.id, r.agents.id, view.project.name)]
  else if (r.map) content = [map.mount(view.project.id)]
  else content = view.task ? renderTask(view.task) : renderProject(view.project)
  // The settings page is the same element each time, so re-renders never touch what's being typed.
  // The studio is one screen: it fills the pane instead of scrolling in it.
  main.classList.toggle('mainpane--studio', Boolean(r.edit && view.project))
  main.classList.toggle('mainpane--map', Boolean(r.map && view.project))
  // The canvas gets the whole width: the studio has its own way back.
  document.querySelector('.shell')?.classList.toggle('shell--studio', Boolean(r.edit && view.project))
  const nodes = content.filter(Boolean)
  if (!(nodes.length === 1 && main.childElementCount === 1 && main.firstElementChild === nodes[0])) main.replaceChildren(...nodes)
  applyFocus()
  fitTasks()
  document.title = r.settings && view.project ? `Settings · ${view.project.name} · Enki` : (r.library || r.edit) && view.project ? `Workflows · ${view.project.name} · Enki` : r.agents && view.project ? `Agents · Enki` : r.map && view.project ? `Map · ${view.project.name} · Enki` : view.task ? `${view.task.title} · Enki` : view.project ? `${view.project.name} · Enki` : 'Enki dashboard'
}

function connect() {
  const stream = new EventSource('/api/stream')
  let seen = null
  stream.onmessage = message => {
    const { version, configs } = JSON.parse(message.data)
    if (configs) settings.configsChanged(configs)
    if (!view.connected) {
      view.connected = true
      render()
    }
    if (version !== seen) {
      seen = version
      load()
    }
  }
  stream.onerror = () => {
    // EventSource reconnects by itself; a restarted server starts its versions over, so reload then.
    view.connected = false
    seen = null
    render()
  }
}

window.addEventListener('hashchange', () => {
  view.menuOpen = false
  view.focus = null
  hovered = null
  const main = document.getElementById('main')
  load().then(() => main.scrollTo(0, 0))
})
document.addEventListener('click', event => {
  if (view.menuOpen && !event.target.closest('.switcher')) {
    view.menuOpen = false
    render()
  }
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && view.menuOpen) {
    view.menuOpen = false
    render()
    document.querySelector('.switcher__button')?.focus()
  }
})
// Relative times ("5m ago") and running elapsed times move on even when nothing else changes.
setInterval(render, 30000)

load()
connect()
