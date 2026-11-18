// The workflow studio: one screen to build a workflow. A canvas you can pan and zoom, steps you
// drag around, outcomes wired by dragging from a step's port to another step, a library of roles
// to drag in, and an inspector for the selection. Every change is checked by the server with the
// same rules enki runs a workflow with, and Save stays off until the workflow can run. Enki's own
// workflows open read-only: duplicate one to change it. Everything dragging does, the inspector
// can do from the keyboard.
import { arrowDefs, autoLayout, drawGraph, FIXED, nearestSegment, outputsOf, routeEdge, targetsOf } from './graph.js'

const clone = value => JSON.parse(JSON.stringify(value))
const ID = /^[a-z][a-z0-9-]{0,30}$/
const RESERVED = new Set(['orchestrator', 'start', 'approval', 'end', 'verify', 'otherwise', 'user', 'request', 'plan'])
const NARROW = '(max-width: 900px)'
const GRID = 8
const HISTORY = 100
const FIXED_TEXT = {
  start: 'The orchestrator passes on the user’s request. Connect “request” to the first step.',
  approval: 'The user approves the plan here. “approved” starts the work, and “changes” goes back to the planner with their words. Only a planning step leads in.',
  end: 'The workflow is done: the orchestrator writes the notes and the report.',
}
const WRITE_WORD = { none: 'read-only', tests: 'writes tests', code: 'writes code', all: 'writes code and tests' }
const capsText = caps => [WRITE_WORD[caps.write], caps.blind && 'blind', caps.plans && 'plans', caps.browser && 'browser', caps.server && 'server'].filter(Boolean).join(' · ')
const snap = value => Math.round(value / GRID) * GRID
const normalize = edge => ({ ...edge, to: edge.to.length === 1 ? edge.to[0] : edge.to })
/** Forgets where the matching lines bend: a line that's gone, or changed ends, starts straight again. */
function dropRoutes(draft, match) {
  if (!draft.routes) return
  for (const key of Object.keys(draft.routes)) if (match(key.split(':'))) delete draft.routes[key]
  if (Object.keys(draft.routes).length === 0) delete draft.routes
}

export function createStudio({ h, getJson, postJson, learnRoles, roleOf, libraryHref, editHref, onSaved, agentHref = () => '#/', newAgentHref = () => '#/' }) {
  const stores = new Map()
  const narrow = window.matchMedia(NARROW)

  function store(project, id) {
    const key = `${project}/${id}`
    if (!stores.has(key)) {
      const s = { key, project, id, data: null, item: null, draft: null, saved: null, problems: [], selected: null, undo: [], redo: [], view: { x: 0, y: 0, k: 1 }, fitted: false, sideOpen: window.innerWidth >= 1600, inspectorOpen: true, problemsOpen: false, search: '', notice: null, picker: null }
      frame(s)
      stores.set(key, s)
    }
    return stores.get(key)
  }

  // ---------- the draft ----------

  const roleById = (s, id) => s.data?.roles.find(role => role.id === id) ?? null
  const outcomesOfRole = s => node => (roleById(s, node.agent)?.outcomes ?? []).map(outcome => outcome.id)
  const nodeOf = (s, id) => s.draft.nodes.find(node => node.id === id)
  const edgeOf = (s, from, on) => s.draft.edges.find(edge => edge.from === from && edge.on === on)
  const dirty = s => s.draft && JSON.stringify(s.draft) !== s.saved
  const editable = s => Boolean(s.item) && s.item.source !== 'builtin' && !narrow.matches
  const styleOf = s => node => {
    const role = roleById(s, node.agent)
    // A step looks like its role: a second scout is as purple as the first.
    const look = roleOf(node.agent)
    return {
      label: node.id === node.agent ? role?.name ?? node.id : node.id,
      color: look.line ?? look.fill,
      pattern: look.pattern ?? null,
      // A step with its own model says so; otherwise what its role may do.
      roleName: [node.id !== node.agent ? role?.name ?? node.agent : null, node.model ? s.data.models?.find(item => item.id === node.model)?.label ?? node.model : role ? capsText(role.capabilities) : 'no such role'].filter(Boolean).join(' · '),
    }
  }
  const titleOf = (s, node) => (node.kind === 'verify' ? `Tests (${node.id})` : node.kind ? node.kind[0].toUpperCase() + node.kind.slice(1) : styleOf(s)(node).label)

  /** Fills in positions for steps that have none, keeping the ones saved. */
  function withLayout(s, workflow) {
    const auto = autoLayout(workflow, outcomesOfRole(s))
    return { ...workflow, layout: Object.fromEntries(workflow.nodes.map(node => [node.id, workflow.layout?.[node.id] ?? auto[node.id]])) }
  }

  /** One undoable change: snapshot, change, redraw, and a server check a moment later. */
  function commit(s, change, { before = null } = {}) {
    const snapshot = before ?? JSON.stringify(s.draft)
    change(s.draft)
    if (snapshot === JSON.stringify(s.draft)) return
    s.undo.push(snapshot)
    if (s.undo.length > HISTORY) s.undo.shift()
    s.redo = []
    s.notice = null
    renderAll(s)
    scheduleCheck(s)
  }

  function travel(s, from, to) {
    if (from.length === 0) return
    to.push(JSON.stringify(s.draft))
    s.draft = JSON.parse(from.pop())
    if (s.selected?.type === 'node' && !nodeOf(s, s.selected.id)) s.selected = null
    if (s.selected?.type === 'edge' && !edgeOf(s, s.selected.from, s.selected.on)) s.selected = null
    renderAll(s)
    scheduleCheck(s)
  }

  let timer = 0
  function scheduleCheck(s) {
    clearTimeout(timer)
    timer = setTimeout(() => check(s), 250)
  }

  async function check(s) {
    const sent = JSON.stringify(s.draft)
    const result = await postJson(`/api/projects/${encodeURIComponent(s.project)}/library`, { action: 'validate', workflow: s.draft })
    if (sent !== JSON.stringify(s.draft)) return
    s.problems = result.ok ? result.body.problems : [result.body.error ?? 'The check failed']
    s.warnings = result.ok ? result.body.warnings ?? [] : []
    s.summary = result.ok ? result.body.summary ?? null : null
    renderBar(s)
    renderCanvas(s)
    renderProblems(s)
  }

  /** Edges of a loop the server says has no limit: drawn red. */
  function badEdges(s) {
    const bad = new Set()
    for (const problem of s.problems) {
      const match = /the loop (.+) has no limit/.exec(problem)
      if (!match) continue
      const ids = match[1].split(' → ')
      for (let i = 0; i < ids.length - 1; i++) {
        for (const edge of s.draft.edges.filter(item => item.from === ids[i] && targetsOf(item).includes(ids[i + 1]))) bad.add(`${edge.from}:${edge.on}:${ids[i + 1]}`)
      }
    }
    return bad
  }

  function freeId(s, base) {
    let id = base
    for (let n = 2; s.draft.nodes.some(node => node.id === id) || (RESERVED.has(id) && id !== 'verify'); n++) id = `${base}-${n}`
    return id
  }

  /** A new step from the library: a role, or a test run. Returns its id. */
  function addStep(s, what, at) {
    const id = freeId(s, what === 'verify' ? 'verify' : what)
    commit(s, draft => {
      const node = what === 'verify' ? { id, kind: 'verify' } : { id, agent: what }
      const end = draft.nodes.findIndex(item => item.kind === 'end')
      draft.nodes.splice(end === -1 ? draft.nodes.length : end, 0, node)
      draft.layout[id] = { x: snap(at.x - 82), y: snap(at.y - 30) }
    })
    s.selected = { type: 'node', id }
    renderAll(s)
    return id
  }

  function connect(s, from, on, to) {
    if (to === 'start') return say(s, 'danger', 'Nothing leads back to Start.')
    commit(s, draft => {
      const edge = draft.edges.find(item => item.from === from && item.on === on)
      if (!edge) {
        draft.edges.push({ from, on, to })
        return
      }
      let targets = targetsOf(edge)
      if (targets.includes(to)) return
      // End and Approval stand alone: connecting to one replaces the rest, and the other way round.
      targets = to === 'end' || to === 'approval' || targets.some(target => target === 'end' || target === 'approval') ? [to] : [...targets, to]
      edge.to = targets.length === 1 ? targets[0] : targets
      dropRoutes(draft, ([f, o, t]) => f === from && o === on && !targets.includes(t))
    })
    s.selected = { type: 'edge', from, on, to }
    renderAll(s)
  }

  function disconnect(s, from, on, to) {
    commit(s, draft => {
      draft.edges = draft.edges
        .map(edge => (edge.from === from && edge.on === on ? { ...edge, to: targetsOf(edge).filter(target => target !== to) } : edge))
        .filter(edge => targetsOf(edge).length > 0)
        .map(edge => (Array.isArray(edge.to) ? normalize(edge) : edge))
      dropRoutes(draft, ([f, o, t]) => f === from && o === on && t === to)
    })
    if (s.selected?.type === 'edge') s.selected = null
    renderAll(s)
  }

  /** An outcome's line moved to another block, keeping its other targets. */
  function retarget(s, from, on, was, to) {
    if (to === 'start') return say(s, 'danger', 'Nothing leads back to Start.')
    commit(s, draft => {
      const edge = draft.edges.find(item => item.from === from && item.on === on)
      let targets = targetsOf(edge).filter(target => target !== was)
      targets = to === 'end' || to === 'approval' || targets.some(target => target === 'end' || target === 'approval') ? [to] : [...new Set([...targets, to])]
      edge.to = targets.length === 1 ? targets[0] : targets
      dropRoutes(draft, ([f, o, t]) => f === from && o === on && !targets.includes(t))
      dropRoutes(draft, ([f, o, t]) => f === from && o === on && t === was)
    })
    s.selected = { type: 'edge', from, on, to }
    renderAll(s)
  }

  /** A bend added where a segment was pressed twice: the segment steps aside there. */
  function addBend(s, key, segment, point) {
    const course = [...s.lines[key].course]
    const at = segment.axis === 'x' ? point.y : point.x
    course.splice(segment.index + 1, 0, snap(at), course[segment.index] + 32)
    commit(s, draft => {
      draft.routes = { ...draft.routes, [key]: course }
    })
  }

  /** A bend taken out: two positions go, and the segments either side join. */
  function removeBend(s, key, index) {
    const course = [...s.lines[key].course]
    if (course.length < 3) return say(s, 'danger', 'That line has no bend to take out. Straighten it from the inspector instead.')
    course.splice(index + 1 < course.length ? index : index - 1, 2)
    commit(s, draft => {
      draft.routes = { ...draft.routes, [key]: course }
    })
  }

  function removeStep(s, id) {
    const node = nodeOf(s, id)
    if (!node || FIXED.includes(node.kind)) return
    commit(s, draft => {
      draft.nodes = draft.nodes.filter(item => item.id !== id)
      draft.edges = draft.edges
        .filter(edge => edge.from !== id)
        .map(edge => ({ ...edge, to: targetsOf(edge).filter(target => target !== id) }))
        .filter(edge => edge.to.length > 0)
        .map(normalize)
      delete draft.layout[id]
      dropRoutes(draft, ([f, , t]) => f === id || t === id)
    })
    s.selected = null
    renderAll(s)
  }

  function rename(s, from, to) {
    if (from === to) return
    if (!ID.test(to)) return say(s, 'danger', 'A step’s id: lowercase letters, digits and dashes, starting with a letter.')
    if (RESERVED.has(to) || s.draft.nodes.some(node => node.id === to)) return say(s, 'danger', `"${to}" is taken.`)
    commit(s, draft => {
      for (const node of draft.nodes) {
        if (node.id === from) node.id = to
      }
      for (const edge of draft.edges) {
        if (edge.from === from) edge.from = to
        if (Array.isArray(edge.to)) edge.to = edge.to.map(id => (id === from ? to : id))
        else if (edge.to === from) edge.to = to
      }
      draft.layout[to] = draft.layout[from]
      delete draft.layout[from]
      if (draft.routes) draft.routes = Object.fromEntries(Object.entries(draft.routes).map(([key, route]) => [key.split(':').map((part, index) => (index !== 1 && part === from ? to : part)).join(':'), route]))
    })
    s.selected = { type: 'node', id: to }
    renderAll(s)
  }

  function setRole(s, id, role) {
    const outcomes = (roleById(s, role)?.outcomes ?? []).map(outcome => outcome.id)
    commit(s, draft => {
      draft.nodes.find(node => node.id === id).agent = role
      // Outcomes the new role doesn't have lose their edges.
      draft.edges = draft.edges.filter(edge => edge.from !== id || edge.on === 'otherwise' || outcomes.includes(edge.on))
      dropRoutes(draft, ([f, o]) => f === id && o !== 'otherwise' && !outcomes.includes(o))
    })
  }

  function setStepSetting(s, id, key, value) {
    commit(s, draft => {
      const node = draft.nodes.find(item => item.id === id)
      if (Array.isArray(value) ? value.length : value) node[key] = value
      else delete node[key]
    })
  }

  function setMax(s, from, on, value) {
    const max = value === '' ? undefined : Number(value)
    if (max !== undefined && !(Number.isInteger(max) && max > 0)) return say(s, 'danger', 'A limit is a whole number, 1 or more.')
    commit(s, draft => {
      const edge = draft.edges.find(item => item.from === from && item.on === on)
      if (max === undefined) delete edge.max
      else edge.max = max
    })
  }

  function say(s, kind, text) {
    s.notice = { kind, text }
    renderBar(s)
  }

  // ---------- the view ----------

  function toCanvas(s, event) {
    const rect = s.els.canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left - s.view.x) / s.view.k, y: (event.clientY - rect.top - s.view.y) / s.view.k }
  }

  function applyView(s) {
    const { x, y, k } = s.view
    s.els.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`)
    s.els.canvas.style.backgroundSize = `${24 * k}px ${24 * k}px`
    s.els.canvas.style.backgroundPosition = `${x}px ${y}px`
    s.els.zoom.textContent = `${Math.round(k * 100)}%`
  }

  function zoomAt(s, factor, cx, cy) {
    s.touched = true
    const k = Math.min(2, Math.max(0.25, s.view.k * factor))
    s.view.x = cx - ((cx - s.view.x) * k) / s.view.k
    s.view.y = cy - ((cy - s.view.y) * k) / s.view.k
    s.view.k = k
    applyView(s)
  }

  function fit(s) {
    const rect = s.els.canvas.getBoundingClientRect()
    if (!s.bounds || rect.width < 50 || rect.height < 50) return false
    const b = s.bounds
    const k = Math.min(1.1, Math.max(0.3, Math.min((rect.width - 48) / b.w, (rect.height - 48) / b.h)))
    s.view = { k, x: (rect.width - b.w * k) / 2 - b.x * k, y: (rect.height - b.h * k) / 2 - b.y * k }
    applyView(s)
    return true
  }

  function arrange(s) {
    commit(s, draft => {
      draft.layout = autoLayout(draft, outcomesOfRole(s))
      delete draft.routes
    })
    requestAnimationFrame(() => fit(s))
  }

  // ---------- the frame ----------

  function frame(s) {
    const canvas = h('div', { class: 'studio__canvas', tabindex: -1 })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'studio__svg')
    svg.setAttribute('aria-label', 'Workflow canvas')
    svg.setAttribute('role', 'application')
    const world = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    svg.append(arrowDefs(), world)
    const zoom = h('span', { class: 'studio__zoomvalue', 'aria-live': 'polite' }, '100%')
    const button = (label, title, onClick, extra = {}) => h('button', { class: 'studio__tool', type: 'button', title, 'aria-label': title, onClick, ...extra }, label)
    const tools = h(
      'div',
      { class: 'studio__zoom', role: 'toolbar', 'aria-label': 'Zoom' },
      button('−', 'Zoom out', () => zoomCenter(s, 1 / 1.2)),
      zoom,
      button('+', 'Zoom in', () => zoomCenter(s, 1.2)),
      button('Fit', 'Fit the workflow on screen', () => fit(s), { class: 'studio__tool studio__tool--text' }),
    )
    const picker = h('div', { class: 'studio__picker', role: 'menu', hidden: true })
    // The orchestrator isn't a step: it works beside every workflow, so it stays in the corner.
    const lead = h(
      'div',
      { class: 'studio__lead', role: 'note' },
      h('span', { class: 'studio__swatch', 'aria-hidden': 'true', style: { background: 'var(--orange)' } }),
      h('span', { class: 'studio__rolename' }, h('strong', {}, 'Orchestrator'), h('span', { class: 'muted' }, 'Carries messages: passes on the request at Start, relays the planner’s questions and plan, writes the report at End.')),
    )
    canvas.append(svg, lead, tools, picker)
    const root = h(
      'div',
      { class: 'studio' },
      h('div', { class: 'studio__bar' }),
      h('div', { class: 'studio__body' }, h('aside', { class: 'studio__side', 'aria-label': 'Steps to add' }), canvas, h('aside', { class: 'studio__inspector', 'aria-label': 'Inspector' })),
      h('div', { class: 'sr-only', 'aria-live': 'polite' }),
    )
    s.els = { root, canvas, svg, world, zoom, picker, bar: root.querySelector('.studio__bar'), side: root.querySelector('.studio__side'), inspector: root.querySelector('.studio__inspector'), live: root.lastElementChild }
    wireCanvas(s)
    root.addEventListener('keydown', event => keys(s, event))
    // Until the user moves the view, it keeps the whole workflow in sight as the canvas changes size.
    new ResizeObserver(() => {
      if (!s.touched && s.bounds) s.fitted = fit(s)
    }).observe(canvas)
    narrow.addEventListener('change', () => s.draft && renderAll(s))
  }

  function zoomCenter(s, factor) {
    const rect = s.els.canvas.getBoundingClientRect()
    zoomAt(s, factor, rect.width / 2, rect.height / 2)
  }

  function wireCanvas(s) {
    const { svg, canvas } = s.els
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0 || !s.draft) return
      closePicker(s)
      // Keys (undo, delete, arrows) go to the studio after a click on the canvas.
      canvas.focus({ preventScroll: true })
      const p = toCanvas(s, event)
      const port = event.target.closest('[data-port]')
      const node = event.target.closest('[data-node]')
      const handle = event.target.closest('[data-handle]')
      const retarget = event.target.closest('[data-retarget]')
      const remove = event.target.closest('[data-delete]')
      const edge = event.target.closest('[data-edge]')
      if (remove && editable(s)) {
        const [from, on, to] = remove.getAttribute('data-delete').split(':')
        disconnect(s, from, on, to)
        return
      }
      if (retarget && editable(s)) {
        // The arrow's end, dragged to another block: the outcome goes there instead.
        const [from, on, to] = retarget.getAttribute('data-retarget').split(':')
        s.wire = { from, on, replace: to, end: p, sx: event.clientX, sy: event.clientY }
      } else if ((handle || edge) && editable(s)) {
        // A segment of a line moves across (an upright) or up and down (a crossing).
        const key = handle ? handle.getAttribute('data-handle') : edge.getAttribute('data-edge')
        const line = s.lines[key]
        const segment = handle ? line.segments[Number(handle.getAttribute('data-seg'))] : nearestSegment(line, p)
        // Twice on a segment adds a bend there, twice on its handle takes one out. Redraws replace
        // the line between clicks, so the browser's own dblclick can't be relied on here.
        const now = Date.now()
        const again = s.lastPress?.key === key && s.lastPress.index === segment?.index && now - s.lastPress.at < 450
        s.lastPress = { key, index: segment?.index, at: now }
        if (again && segment) {
          s.lastPress = null
          if (handle) removeBend(s, key, segment.index)
          else addBend(s, key, segment, p)
          return
        }
        const [from, on, to] = key.split(':')
        s.bend = { key, from, on, to, segment, course: [...line.course], start: p, sx: event.clientX, sy: event.clientY, moved: false, before: JSON.stringify(s.draft) }
      } else if (port && editable(s)) {
        const [from, on] = port.getAttribute('data-port').split(':')
        s.wire = { from, on, end: p, sx: event.clientX, sy: event.clientY }
      } else if (node) {
        const id = node.getAttribute('data-node')
        const at = s.draft.layout[id]
        s.drag = { id, dx: p.x - at.x, dy: p.y - at.y, sx: event.clientX, sy: event.clientY, moved: false, before: JSON.stringify(s.draft) }
      } else if (edge) {
        const [from, on, to] = edge.getAttribute('data-edge').split(':')
        s.selected = { type: 'edge', from, on, to }
        renderAll(s)
        return
      } else {
        s.pan = { x: event.clientX - s.view.x, y: event.clientY - s.view.y, sx: event.clientX, sy: event.clientY, moved: false }
      }
      svg.setPointerCapture(event.pointerId)
      event.preventDefault()
    })
    svg.addEventListener('pointermove', event => {
      const far = start => Math.hypot(event.clientX - start.sx, event.clientY - start.sy) > 4
      if (s.wire) {
        s.wire.end = toCanvas(s, event)
        drawWire(s)
      } else if (s.bend) {
        if (!s.bend.moved && !far(s.bend)) return
        s.bend.moved = true
        const { segment, course, start, key } = s.bend
        if (!segment) return
        const p = toCanvas(s, event)
        const moved = [...course]
        moved[segment.index] = snap(course[segment.index] + p[segment.axis] - start[segment.axis])
        s.draft.routes = { ...s.draft.routes, [key]: moved }
        renderCanvas(s)
      } else if (s.drag) {
        if (!s.drag.moved && !far(s.drag)) return
        s.drag.moved = true
        if (!editable(s)) return
        const p = toCanvas(s, event)
        s.draft.layout[s.drag.id] = { x: snap(p.x - s.drag.dx), y: snap(p.y - s.drag.dy) }
        renderCanvas(s)
      } else if (s.pan) {
        if (!s.pan.moved && !far(s.pan)) return
        s.pan.moved = true
        s.touched = true
        s.view.x = event.clientX - s.pan.x
        s.view.y = event.clientY - s.pan.y
        applyView(s)
      }
    })
    const end = event => {
      if (s.wire) {
        const { from, on, sx, sy, replace } = s.wire
        s.wire = null
        const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-node]')
        // A click on a port is no drag: nothing to connect.
        if (Math.hypot(event.clientX - sx, event.clientY - sy) < 6) renderCanvas(s)
        else if (replace) {
          if (hit && hit.getAttribute('data-node') !== replace) retarget(s, from, on, replace, hit.getAttribute('data-node'))
          else renderCanvas(s)
        } else if (hit) connect(s, from, on, hit.getAttribute('data-node'))
        else if (event.type === 'pointerup' && s.els.canvas.contains(document.elementFromPoint(event.clientX, event.clientY))) openPicker(s, event, { from, on })
        else renderCanvas(s)
      } else if (s.bend) {
        const { key, from, on, to, moved, before } = s.bend
        s.bend = null
        if (moved) {
          const route = s.draft.routes[key]
          s.draft = JSON.parse(before)
          commit(s, draft => {
            draft.routes = { ...draft.routes, [key]: route }
          })
        } else {
          s.selected = { type: 'edge', from, on, to }
          renderAll(s)
        }
      } else if (s.drag) {
        const { id, moved, before } = s.drag
        s.drag = null
        if (moved && editable(s)) {
          const after = s.draft.layout[id]
          s.draft = JSON.parse(before)
          commit(s, draft => {
            draft.layout[id] = after
          })
        } else {
          s.selected = { type: 'node', id }
          renderAll(s)
        }
      } else if (s.pan) {
        const moved = s.pan.moved
        s.pan = null
        if (!moved && s.selected) {
          s.selected = null
          renderAll(s)
        }
      }
    }
    svg.addEventListener('pointerup', end)
    svg.addEventListener('pointercancel', end)
    svg.addEventListener(
      'wheel',
      event => {
        event.preventDefault()
        const rect = canvas.getBoundingClientRect()
        // Pinch on a trackpad arrives as a wheel with ctrl: zoom. Otherwise, a plain wheel zooms too,
        // and a two-finger scroll sideways pans.
        if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          s.view.x -= event.deltaX
          s.touched = true
          applyView(s)
          return
        }
        zoomAt(s, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top)
      },
      { passive: false },
    )
    svg.addEventListener('focusin', event => {
      const node = event.target.closest?.('[data-node]')
      if (node) s.focusNode = node.getAttribute('data-node')
    })
    // Roles dragged in from the library.
    canvas.addEventListener('dragover', event => {
      if (editable(s) && event.dataTransfer.types.includes('text/x-enki-step')) event.preventDefault()
    })
    canvas.addEventListener('drop', event => {
      const what = event.dataTransfer.getData('text/x-enki-step')
      if (!what || !editable(s)) return
      event.preventDefault()
      addStep(s, what, toCanvas(s, event))
    })
  }

  function drawWire(s) {
    s.els.world.querySelector('.wf-edge--draft')?.remove()
    if (!s.wire || !s.portAt) return
    const from = s.portAt(s.wire.from, s.wire.on)
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', routeEdge(from, s.wire.end, undefined, Math.max(from.y, s.wire.end.y) + 40).d)
    path.setAttribute('class', 'wf-edge wf-edge--draft')
    s.els.world.append(path)
  }

  /** Dropped a wire on empty canvas: pick what to create there, already connected. */
  function openPicker(s, event, wire) {
    const rect = s.els.canvas.getBoundingClientRect()
    const at = toCanvas(s, event)
    const item = (label, detail, what) =>
      h('button', {
        class: 'studio__pick',
        type: 'button',
        role: 'menuitem',
        onClick: () => {
          closePicker(s)
          const id = what === 'end' ? 'end' : addStep(s, what, at)
          connect(s, wire.from, wire.on, id)
        },
      }, h('span', {}, label), detail && h('span', { class: 'muted' }, detail))
    s.els.picker.replaceChildren(
      h('p', { class: 'studio__pickhead' }, `Connect “${wire.on}” to a new step`),
      ...s.data.roles.map(role => item(role.name, capsText(role.capabilities), role.id)),
      item('Tests', 'enki runs the checks', 'verify'),
      item('End', 'the workflow is done', 'end'),
    )
    s.els.picker.hidden = false
    s.els.picker.style.left = `${Math.min(event.clientX - rect.left, rect.width - 250)}px`
    s.els.picker.style.top = `${Math.min(event.clientY - rect.top, rect.height - 320)}px`
    s.els.picker.querySelector('button')?.focus()
    renderCanvas(s)
  }

  function closePicker(s) {
    if (s.els.picker.hidden) return
    s.els.picker.hidden = true
    s.els.picker.replaceChildren()
  }

  function keys(s, event) {
    if (!s.draft) return
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)
    const mod = event.ctrlKey || event.metaKey
    if (event.key === 'Escape') {
      if (!s.els.picker.hidden) closePicker(s)
      else if (s.problemsOpen) s.problemsOpen = false
      else if (!typing) s.selected = null
      renderAll(s)
      return
    }
    if (typing) return
    if (mod && event.key.toLowerCase() === 'z' && editable(s)) {
      event.preventDefault()
      if (event.shiftKey) travel(s, s.redo, s.undo)
      else travel(s, s.undo, s.redo)
      return
    }
    if (mod && event.key.toLowerCase() === 'y' && editable(s)) {
      event.preventDefault()
      travel(s, s.redo, s.undo)
      return
    }
    const node = event.target.closest?.('[data-node]')
    if (node && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      s.selected = { type: 'node', id: node.getAttribute('data-node') }
      renderAll(s)
      s.els.inspector.querySelector('input, select, button')?.focus()
      return
    }
    if (!editable(s)) return
    if ((event.key === 'Delete' || event.key === 'Backspace') && s.selected) {
      event.preventDefault()
      if (s.selected.type === 'node') removeStep(s, s.selected.id)
      else disconnect(s, s.selected.from, s.selected.on, s.selected.to)
      return
    }
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key]
    if (step && s.selected?.type === 'node') {
      event.preventDefault()
      const by = event.shiftKey ? GRID * 5 : GRID
      const id = s.selected.id
      commit(s, draft => {
        const at = draft.layout[id]
        draft.layout[id] = { x: at.x + step[0] * by, y: at.y + step[1] * by }
      })
    }
  }

  // ---------- rendering ----------

  function renderAll(s) {
    renderBar(s)
    renderSide(s)
    renderCanvas(s)
    renderInspector(s)
    s.els.root.classList.toggle('studio--noside', !s.sideOpen || !editable(s))
    s.els.root.classList.toggle('studio--noinspector', !s.inspectorOpen)
  }

  function renderCanvas(s) {
    if (!s.draft) return
    const { group, bounds, portAt, lines } = drawGraph(s.draft, { layout: s.draft.layout, routes: s.draft.routes ?? {}, outcomesOfRole: outcomesOfRole(s), styleOf: styleOf(s), selected: s.selected, bad: badEdges(s), editable: true })
    s.bounds = bounds
    s.portAt = portAt
    s.lines = lines
    s.els.world.replaceChildren(group)
    drawWire(s)
    applyView(s)
    // Redrawing replaces the nodes: keep the keyboard on the one it was on.
    if (s.focusNode && (document.activeElement === document.body || !document.contains(document.activeElement))) {
      s.els.world.querySelector(`[data-node="${CSS.escape(s.focusNode)}"]`)?.focus({ preventScroll: true })
    }
    if (!s.fitted) s.fitted = fit(s)
  }

  function renderBar(s) {
    const own = s.item?.source === 'builtin'
    const count = s.problems.length
    const warns = count ? 0 : (s.warnings ?? []).length
    const canSave = editable(s) && dirty(s) && count === 0
    const sourceWord = { builtin: 'Enki’s own', library: 'Your library', project: 'This project' }[s.item?.source] ?? ''
    const toggle = (open, label, onClick) => h('button', { class: `studio__tool studio__tool--text${open ? ' is-on' : ''}`, type: 'button', 'aria-pressed': String(open), onClick }, label)
    s.els.bar.replaceChildren(
      h('a', { class: 'studio__back', href: libraryHref(s.project) }, '← Workflows'),
      h('div', { class: 'studio__title' }, h('h1', {}, s.draft?.name ?? s.id), h('span', { class: `srcbadge srcbadge--${s.item?.source ?? 'library'}` }, sourceWord), dirty(s) && h('span', { class: 'studio__dirty' }, 'Unsaved changes')),
      h(
        'div',
        { class: 'studio__status' },
        h('button', { class: `studio__pill ${count ? 'studio__pill--bad' : warns ? 'studio__pill--warn' : 'studio__pill--ok'}`, type: 'button', 'aria-expanded': String(s.problemsOpen), onClick: () => { s.problemsOpen = !s.problemsOpen; renderBar(s) } }, count ? `${count} problem${count === 1 ? '' : 's'}` : warns ? `Can run · ${warns} warning${warns === 1 ? '' : 's'}` : 'Can run'),
        s.problemsOpen && h('div', { class: 'studio__popover', role: 'dialog', 'aria-label': 'Problems and warnings' }, checkList(s)),
      ),
      h(
        'div',
        { class: 'studio__actions' },
        s.notice && h('span', { class: `studio__notice studio__notice--${s.notice.kind}`, role: s.notice.kind === 'danger' ? 'alert' : 'status' }, s.notice.text),
        editable(s) && toggle(s.sideOpen, 'Library', () => { s.sideOpen = !s.sideOpen; renderAll(s); requestAnimationFrame(() => applyView(s)) }),
        toggle(s.inspectorOpen, 'Inspector', () => { s.inspectorOpen = !s.inspectorOpen; renderAll(s) }),
        editable(s) && h('button', { class: 'studio__tool studio__tool--text', type: 'button', disabled: s.undo.length === 0, title: 'Undo (Ctrl+Z)', onClick: () => travel(s, s.undo, s.redo) }, 'Undo'),
        editable(s) && h('button', { class: 'studio__tool studio__tool--text', type: 'button', disabled: s.redo.length === 0, title: 'Redo (Ctrl+Shift+Z)', onClick: () => travel(s, s.redo, s.undo) }, 'Redo'),
        editable(s) && h('button', { class: 'studio__tool studio__tool--text', type: 'button', title: 'Lay the steps out again', onClick: () => arrange(s) }, 'Arrange'),
        editable(s) && !s.confirmRemove && h('button', { class: 'btn btn--secondary btn--outline-danger', type: 'button', onClick: () => { s.confirmRemove = true; renderBar(s) } }, 'Remove'),
        s.confirmRemove &&
          h(
            'span',
            { class: 'studio__confirm', role: 'alert' },
            h('span', {}, h('strong', {}, `Remove ${s.draft?.name ?? s.id}?`), ' Running tasks keep their copy. This can’t be undone.'),
            h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { s.confirmRemove = false; renderBar(s) } }, 'Keep it'),
            h('button', { class: 'btn btn--fill-danger', type: 'button', onClick: () => remove(s) }, 'Remove workflow'),
          ),
        s.dup && dupField(s),
        own
          ? !s.dup && h('button', { class: 'btn btn--primary', type: 'button', onClick: () => askDuplicate(s) }, 'Duplicate to edit')
          : editable(s) && h('button', { class: 'btn btn--primary', type: 'button', disabled: !canSave, title: count ? 'Fix the problems first' : dirty(s) ? 'Save' : 'Nothing to save', onClick: () => save(s) }, 'Save'),
      ),
    )
  }

  /** A library entry: click to add it in the middle of the view, or drag it where it goes. */
  function addable(s, id, swatch, name, detail) {
    return h(
      'li',
      {},
      h(
        'button',
        {
          class: 'studio__role',
          type: 'button',
          draggable: 'true',
          onClick: () => {
            const rect = s.els.canvas.getBoundingClientRect()
            addStep(s, id, { x: (rect.width / 2 - s.view.x) / s.view.k, y: (rect.height / 2 - s.view.y) / s.view.k })
          },
          onDragstart: event => {
            event.dataTransfer.setData('text/x-enki-step', id)
            event.dataTransfer.effectAllowed = 'copy'
          },
        },
        swatch,
        h('span', { class: 'studio__rolename' }, h('strong', {}, name), h('span', { class: 'muted' }, detail)),
      ),
    )
  }

  function renderSide(s) {
    if (!s.data || !editable(s)) {
      s.els.side.replaceChildren()
      return
    }
    const tab = s.sideTab ?? 'agents'
    const tabButton = (id, label) =>
      h('button', { class: 'studio__tab', type: 'button', role: 'tab', id: `studio-tab-${id}`, 'aria-selected': String(tab === id), 'aria-controls': 'studio-tabpanel', tabindex: tab === id ? 0 : -1, onClick: () => { s.sideTab = id; renderSide(s); s.els.side.querySelector(`#studio-tab-${id}`)?.focus() } }, label)
    let panel
    if (tab === 'agents') {
      const query = s.search.trim().toLowerCase()
      const roles = s.data.roles.filter(role => !query || `${role.name} ${role.id} ${capsText(role.capabilities)}`.toLowerCase().includes(query))
      const search = h('input', { class: 'input studio__search', type: 'search', placeholder: 'Search agents', 'aria-label': 'Search agents', value: s.search })
      search.addEventListener('input', () => {
        s.search = search.value
        renderSide(s)
        const again = s.els.side.querySelector('.studio__search')
        again.focus()
        again.setSelectionRange(again.value.length, again.value.length)
      })
      panel = [
        search,
        h('p', { class: 'field__help' }, 'Each runs as its own Claude agent. Drag one onto the canvas, or click to add it.'),
        h('a', { class: 'btn btn--secondary studio__newagent', href: newAgentHref(s.project) }, 'New agent'),
        h('ul', { class: 'studio__roles' }, roles.map(role => addable(s, role.id, h('span', { class: 'studio__swatch', 'aria-hidden': 'true', style: { background: roleOf(role.id).fill } }), role.name, capsText(role.capabilities)))),
        roles.length === 0 && h('p', { class: 'field__help' }, 'No agent matches.'),
      ]
    } else {
      const fixed = [['Start', 'The orchestrator passes on the request'], ['Approval', 'The user approves the plan'], ['End', 'The orchestrator writes the report']]
      panel = [
        h('p', { class: 'field__help' }, 'Enki runs these itself: no agent, no tokens.'),
        h('ul', { class: 'studio__roles' }, addable(s, 'verify', h('span', { class: 'studio__swatch studio__swatch--builtin', 'aria-hidden': 'true' }, '✓'), 'Tests', 'Runs the project’s test, lint and gate commands. Reports pass or fail')),
        h('h3', { class: 'studio__h3' }, 'In every workflow'),
        h('ul', { class: 'studio__fixed' }, fixed.map(([name, detail]) => h('li', {}, h('strong', {}, name), h('span', { class: 'muted' }, detail)))),
      ]
    }
    s.els.side.replaceChildren(
      h('div', { class: 'studio__sidehead' }, h('h2', {}, 'Library'), h('button', { class: 'studio__tool', type: 'button', 'aria-label': 'Close the library', title: 'Close', onClick: () => { s.sideOpen = false; renderAll(s) } }, '×')),
      h('div', { class: 'studio__tabs', role: 'tablist', 'aria-label': 'Library' }, tabButton('agents', 'Agents'), tabButton('builtin', 'Built-in')),
      h('div', { class: 'studio__tabpanel', role: 'tabpanel', id: 'studio-tabpanel', 'aria-labelledby': `studio-tab-${tab}` }, panel),
    )
  }

  const field = (label, control, help) => h('label', { class: 'field' }, h('span', { class: 'field__label' }, label), control, help && h('span', { class: 'field__help' }, help))

  /** Problems stop it running; warnings are allowed, but worth knowing. */
  function checkList(s) {
    if (s.problems.length) return h('ul', { class: 'editor__problems' }, s.problems.map(problem => h('li', {}, h('strong', {}, 'Error: '), problem)))
    const warnings = s.warnings ?? []
    return [h('p', { class: 'libcard__ok' }, 'Can run'), warnings.length > 0 && h('ul', { class: 'studio__warnings' }, warnings.map(warning => h('li', {}, h('strong', {}, 'Warning: '), warning)))]
  }

  function renderProblems(s) {
    s.els.problems?.replaceChildren(...[checkList(s)].flat().filter(Boolean))
    s.els.summary?.replaceChildren(s.summary ?? 'Shown once the workflow can run.')
  }

  function renderInspector(s) {
    s.els.problems = null
    if (!s.draft) return s.els.inspector.replaceChildren()
    const can = editable(s)
    const head = (title, extra) => h('div', { class: 'studio__sidehead' }, h('h2', {}, title), extra, h('button', { class: 'studio__tool', type: 'button', 'aria-label': 'Close the inspector', title: 'Close', onClick: () => { s.inspectorOpen = false; renderAll(s) } }, '×'))
    const notes = []
    if (s.item?.source === 'builtin') notes.push(h('p', { class: 'notice' }, 'Enki’s own workflow: look around, then duplicate it to make changes.'))
    else if (narrow.matches) notes.push(h('p', { class: 'notice' }, 'Editing needs a wider screen. You can look around here.'))
    let body
    if (s.selected?.type === 'node' && nodeOf(s, s.selected.id)) body = nodePanel(s, nodeOf(s, s.selected.id), can, head)
    else if (s.selected?.type === 'edge' && edgeOf(s, s.selected.from, s.selected.on)) body = edgePanel(s, s.selected, can, head)
    else body = workflowPanel(s, can, head)
    s.els.inspector.replaceChildren(...notes, ...body)
  }

  function workflowPanel(s, can, head) {
    const name = h('input', { class: 'input', value: s.draft.name, disabled: !can, required: true })
    name.addEventListener('change', () => commit(s, draft => { draft.name = name.value.trim() || draft.name }))
    const description = h('textarea', { class: 'input', rows: 3, disabled: !can }, s.draft.description ?? '')
    description.addEventListener('change', () => commit(s, draft => { if (description.value.trim()) draft.description = description.value.trim(); else delete draft.description }))
    s.els.problems = h('div', { class: 'studio__problems', 'aria-live': 'polite' })
    s.els.summary = h('pre', { class: 'studio__summary' })
    renderProblems(s)
    return [
      head('Workflow'),
      field('Name', name),
      field('Description', description, 'For people choosing a workflow. Agents never see it: they get what enki reads from the graph, below.'),
      h('p', { class: 'field__help mono' }, `id: ${s.draft.id}`),
      h('h3', { class: 'studio__h3' }, 'Check'),
      s.els.problems,
      h('details', { class: 'studio__more' }, h('summary', {}, 'What the planner is told about this workflow'), s.els.summary),
      h('h3', { class: 'studio__h3' }, 'How it works'),
      h(
        'ul',
        { class: 'studio__help' },
        h('li', {}, 'Drag from an outcome’s port to a step to connect it. Drop on empty canvas to create one.'),
        h('li', {}, 'An outcome you leave unconnected (↩) goes back to the orchestrator.'),
        h('li', {}, 'Drag empty canvas to move around; scroll or pinch to zoom.'),
        h('li', {}, 'Select a step, then arrow keys move it, Delete removes it. Ctrl+Z undoes.'),
        h('li', {}, 'Every loop needs a limit: select a line to set one.'),
      ),
    ]
  }

  function targetChoices(s, node) {
    return [
      ...s.draft.nodes.filter(item => item.kind !== 'start' && item.kind !== 'end').map(item => [item.id, item.kind === 'approval' ? 'Approval' : item.kind === 'verify' ? `Tests (${item.id})` : item.id]),
      ['end', 'End'],
    ]
  }

  function outcomeRows(s, node, can) {
    const outputs = outputsOf(s.draft, node, outcomesOfRole(s))
    const descriptions = Object.fromEntries((roleById(s, node.agent)?.outcomes ?? []).map(outcome => [outcome.id, outcome.description ?? '']))
    return outputs.map(on => {
      const edge = edgeOf(s, node.id, on)
      const targets = edge ? targetsOf(edge) : []
      const add = h('select', { class: 'input select', 'aria-label': `Connect ${on} to`, disabled: !can }, h('option', { value: '' }, targets.length ? 'Also to…' : 'Connect to…'), targetChoices(s, node).filter(([id]) => !targets.includes(id)).map(([id, label]) => h('option', { value: id }, label)))
      add.addEventListener('change', () => add.value && connect(s, node.id, on, add.value))
      const max = h('input', { class: 'input studio__max', type: 'number', min: 1, step: 1, inputmode: 'numeric', value: edge?.max ?? '', placeholder: 'no limit', disabled: !can, 'aria-label': `Limit for ${on}` })
      max.addEventListener('change', () => setMax(s, node.id, on, max.value))
      return h(
        'div',
        { class: 'studio__out' },
        h('div', { class: 'studio__outhead' }, h('span', { class: 'outchip' }, on), descriptions[on] && h('span', { class: 'field__help' }, descriptions[on])),
        targets.length
          ? h('div', { class: 'studio__targets' }, targets.map(target => h('span', { class: 'studio__target' }, target === 'end' ? 'End' : target, can && h('button', { type: 'button', class: 'studio__x', 'aria-label': `Disconnect ${on} from ${target}`, onClick: () => disconnect(s, node.id, on, target) }, '×'))))
          : h('p', { class: 'field__help' }, node.kind ? 'Not connected yet.' : '↩ Goes back to the orchestrator.'),
        can && add,
        edge && h('label', { class: 'studio__maxrow' }, h('span', { class: 'field__help' }, 'At most'), max, h('span', { class: 'field__help' }, 'times')),
      )
    })
  }

  function nodePanel(s, node, can, head) {
    const fixed = FIXED.includes(node.kind)
    const parts = [head(titleOf(s, node))]
    if (fixed) parts.push(h('p', { class: 'field__help' }, FIXED_TEXT[node.kind]))
    else {
      if (node.kind === 'verify') parts.push(h('p', { class: 'field__help' }, 'Built in: enki runs the project’s test, lint and gate commands itself, with no agent and no tokens. Every command passing is “pass”, anything else is “fail”.'))
      const id = h('input', { class: 'input input--mono', value: node.id, disabled: !can, spellcheck: 'false', autocomplete: 'off' })
      id.addEventListener('change', () => rename(s, node.id, id.value.trim()))
      parts.push(field('Step id', id, 'Plans name steps by this id: [Coder] in a plan means the step "coder".'))
      if (!node.kind) {
        const role = h('select', { class: 'input select', disabled: !can }, s.data.roles.map(item => h('option', { value: item.id, selected: item.id === node.agent }, `${item.name} (${item.id})`)))
        role.addEventListener('change', () => setRole(s, node.id, role.value))
        const info = roleById(s, node.agent)
        parts.push(field('Agent', role, info ? capsText(info.capabilities) : 'This agent doesn’t exist here.'), h('a', { class: 'field__link', href: agentHref(s.project, node.agent) }, info?.source === 'builtin' ? 'Open this agent' : 'Edit this agent'))
        // What this step runs on: the agent's own, unless this workflow chooses for it.
        const models = s.data.models ?? []
        const labelOf = id => models.find(item => item.id === id)?.label ?? id
        const model = h(
          'select',
          { class: 'input select', disabled: !can },
          h('option', { value: '' }, `The agent’s: ${labelOf(info?.model ?? 'claude-sonnet-5-5')}`),
          models.map(item => h('option', { value: item.id, selected: item.id === node.model }, item.label ?? item.id)),
          node.model && !models.some(item => item.id === node.model) && h('option', { value: node.model, selected: true }, node.model),
        )
        model.addEventListener('change', () => setStepSetting(s, node.id, 'model', model.value))
        const effort = h(
          'select',
          { class: 'input select', disabled: !can },
          h('option', { value: '' }, `The agent’s: ${info?.effort ?? 'high'}`),
          (s.data.efforts ?? []).map(item => h('option', { value: item, selected: item === node.effort }, item)),
        )
        effort.addEventListener('change', () => setStepSetting(s, node.id, 'effort', effort.value))
        // Skills this workflow adds for the step, on top of the agent's own.
        const own = info?.skills ?? []
        const extra = node.skills ?? []
        const addSkill = h('input', { class: 'input', list: `step-skills-${node.id}`, placeholder: 'Add a skill', disabled: !can, 'aria-label': `Add a skill to ${node.id}` })
        const add = () => {
          const name = addSkill.value.trim()
          if (!name || extra.includes(name) || own.includes(name)) return
          setStepSetting(s, node.id, 'skills', [...extra, name])
        }
        addSkill.addEventListener('change', add)
        addSkill.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); add() } })
        parts.push(
          h('div', { class: 'studio__pair' }, field('Model', model), field('Effort', effort)),
          h(
            'div',
            { class: 'field' },
            h('span', { class: 'field__label' }, 'Skills'),
            h(
              'div',
              { class: 'studio__targets' },
              own.map(name => h('span', { class: 'studio__target studio__target--locked', title: 'The agent’s own' }, name)),
              extra.map(name => h('span', { class: 'studio__target' }, name, can && h('button', { type: 'button', class: 'studio__x', 'aria-label': `Remove ${name}`, onClick: () => setStepSetting(s, node.id, 'skills', extra.filter(item => item !== name)) }, '×'))),
              own.length + extra.length === 0 && h('span', { class: 'field__help' }, 'None'),
            ),
            can && addSkill,
            h('datalist', { id: `step-skills-${node.id}` }, (s.data.skills ?? []).map(skill => h('option', { value: skill.name }))),
          ),
          h('p', { class: 'field__help' }, 'Chosen here, they’re this step’s in this workflow: the model and effort win over the agent’s own, and skills add to its own.'),
        )
      }
    }
    if (node.kind !== 'end') parts.push(h('h3', { class: 'studio__h3' }, 'Where each outcome goes'), ...outcomeRows(s, node, can))
    if (!fixed) {
      // A step waits for the steps that send it work, and for anything further back that's still busy.
      const inputs = [...new Set(s.draft.edges.filter(edge => targetsOf(edge).includes(node.id)).map(edge => edge.from))].filter(id => id !== node.id && !FIXED.includes(nodeOf(s, id)?.kind))
      parts.push(
        h('h3', { class: 'studio__h3' }, 'Waits for'),
        h('p', { class: 'field__help' }, inputs.length ? `${inputs.join(', ')}: the steps that send it work. It starts once each has sent it work (a loop’s line, one with a limit, is enough on its own) and nothing before it is still working.` : 'Nothing: no step sends it work but Approval.'),
      )
      if (!node.kind) {
        const handoffs = h('input', { class: 'input studio__max', type: 'number', min: 0, step: 1, value: node.handoffs ?? '', placeholder: '2', disabled: !can })
        handoffs.addEventListener('change', () =>
          commit(s, draft => {
            const target = draft.nodes.find(item => item.id === node.id)
            if (handoffs.value === '') delete target.handoffs
            else target.handoffs = Math.max(0, Math.round(Number(handoffs.value)))
          }),
        )
        parts.push(field('Hand-offs before the task stops', handoffs, 'How many times it may come back to the orchestrator. Enki’s default is 2.'))
      }
      if (can) parts.push(h('button', { class: 'btn btn--danger', type: 'button', onClick: () => removeStep(s, node.id) }, 'Remove step'))
    }
    return parts
  }

  function edgePanel(s, { from, on, to }, can, head) {
    const edge = edgeOf(s, from, on)
    const key = `${from}:${on}:${to}`
    const line = s.lines?.[key]
    const max = h('input', { class: 'input studio__max', type: 'number', min: 1, step: 1, value: edge.max ?? '', placeholder: 'no limit', disabled: !can, 'aria-label': 'Limit' })
    max.addEventListener('change', () => setMax(s, from, on, max.value))
    const target = h('select', { class: 'input select', disabled: !can, 'aria-label': 'Goes to' }, targetChoices(s, nodeOf(s, from)).map(([id, label]) => h('option', { value: id, selected: id === to }, label)))
    target.addEventListener('change', () => target.value !== to && retarget(s, from, on, to, target.value))
    const bends = line ? (line.course.length - 1) / 2 : 0
    return [
      head('Connection'),
      h('p', {}, h('strong', { class: 'mono' }, from), ' reports ', h('span', { class: 'outchip' }, on)),
      field('Goes to', target, 'Or drag the line’s end onto another block.'),
      h('label', { class: 'studio__maxrow' }, h('span', { class: 'field__help' }, 'At most'), max, h('span', { class: 'field__help' }, 'times')),
      h('p', { class: 'field__help' }, 'Every loop needs a limit: past it, only the user decides how to go on.'),
      h('h3', { class: 'studio__h3' }, 'The line'),
      h('p', { class: 'field__help' }, `${s.draft.routes?.[key] ? 'Placed by hand' : 'Drawn by enki'}, ${bends === 0 ? 'no extra bends' : `${bends} bend${bends === 1 ? '' : 's'} under the blocks or added`}. Drag any segment to move it. Double-click a segment to add a bend there, or its handle to take one out.`),
      can &&
        h(
          'div',
          { class: 'libcard__actions' },
          h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { const longest = [...line.segments].sort((x, y) => y.length - x.length)[0]; addBend(s, key, longest, longest.mid) } }, 'Add a bend'),
          h('button', { class: 'btn btn--secondary', type: 'button', disabled: !s.draft.routes?.[key], onClick: () => commit(s, draft => dropRoutes(draft, parts => parts.join(':') === key)) }, 'Straighten'),
        ),
      h('div', { class: 'libcard__actions' }, h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { s.selected = { type: 'node', id: from }; renderAll(s) } }, `Select ${from}`), can && h('button', { class: 'btn btn--danger', type: 'button', onClick: () => disconnect(s, from, on, to) }, 'Remove line')),
    ]
  }

  // ---------- loading and saving ----------

  async function load(s) {
    try {
      s.data = await getJson(`/api/projects/${encodeURIComponent(s.project)}/library`)
      learnRoles(Object.fromEntries(s.data.roles.map(role => [role.id, { label: role.name, role: role.id, color: role.color, pattern: role.pattern }])))
      s.item = s.data.workflows.find(workflow => workflow.id === s.id) ?? null
      if (s.item) {
        s.draft = withLayout(s, clone(s.item.workflow))
        s.saved = JSON.stringify(s.draft)
        s.problems = s.item.problems
        s.warnings = s.item.warnings ?? []
        s.summary = s.item.summary ?? null
      }
    } catch (error) {
      s.error = error.message
    }
    if (!s.item) {
      s.els.root.replaceChildren(h('div', { class: 'alert alert--danger', role: 'alert' }, h('span', {}, h('strong', {}, 'Error: '), s.error ? `the library couldn’t be loaded: ${s.error}` : `there is no workflow "${s.id}".`), ' ', h('a', { href: libraryHref(s.project) }, 'Back to the workflows')))
      return
    }
    renderAll(s)
    requestAnimationFrame(() => {
      if (!s.fitted) s.fitted = fit(s)
    })
  }

  async function save(s) {
    const to = s.item.source === 'project' ? 'project' : 'library'
    const result = await postJson(`/api/projects/${encodeURIComponent(s.project)}/library`, { action: 'save', workflow: s.draft, to, replace: true })
    if (result.ok) {
      s.saved = JSON.stringify(s.draft)
      s.notice = { kind: 'success', text: to === 'project' ? 'Saved to this project.' : 'Saved to your library.' }
      onSaved(s.project)
    } else {
      s.notice = { kind: 'danger', text: [result.body.error ?? 'That didn’t save.', ...(result.body.problems ?? []).map(problem => problem.message)].join(' ') }
    }
    renderBar(s)
  }

  async function remove(s) {
    s.confirmRemove = false
    const result = await postJson(`/api/projects/${encodeURIComponent(s.project)}/library`, { action: 'delete', id: s.id })
    if (!result.ok) return say(s, 'danger', result.body.error ?? 'That didn’t work.')
    stores.delete(`${s.project}/${s.id}`)
    onSaved(s.project)
    location.hash = libraryHref(s.project)
  }

  function askDuplicate(s) {
    const taken = new Set(s.data.workflows.map(workflow => workflow.id))
    let id = `${s.id}-copy`
    for (let n = 2; taken.has(id); n++) id = `${s.id}-copy-${n}`
    s.dup = { id }
    renderBar(s)
  }

  /** The copy's ID, asked for in the bar: prefilled with a free one, checked before it goes to the server. */
  function dupField(s) {
    const dup = s.dup
    const go = () => {
      const id = dup.id.trim()
      dup.err = !/^[a-z][a-z0-9-]{0,30}$/.test(id) ? 'Use lower-case letters, digits and dashes, starting with a letter.' : s.data.workflows.some(workflow => workflow.id === id) ? 'Another workflow already uses this ID.' : null
      if (dup.err) return renderBar(s)
      s.dup = null
      duplicate(s, id)
    }
    const field = h('input', { id: 'studio-dup', class: 'ainput ainput--mono', type: 'text', spellcheck: 'false', value: dup.id, 'aria-label': 'ID of the copy', 'aria-invalid': String(Boolean(dup.err)), style: { width: '200px' } })
    field.addEventListener('input', () => {
      dup.id = field.value
      dup.err = null
      field.setAttribute('aria-invalid', 'false')
      field.closest('[role=group]')?.querySelector('.aform__err')?.remove()
    })
    field.addEventListener('keydown', event => { if (event.key === 'Enter') go(); if (event.key === 'Escape') { s.dup = null; renderBar(s) } })
    requestAnimationFrame(() => field.isConnected && document.activeElement !== field && field.focus())
    return h(
      'span',
      { class: 'studio__confirm studio__confirm--ok', role: 'group', 'aria-label': 'Duplicate this workflow' },
      h('label', { for: 'studio-dup' }, 'ID of the copy'),
      field,
      dup.err && h('span', { class: 'aform__err' }, dup.err),
      h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { s.dup = null; renderBar(s) } }, 'Cancel'),
      h('button', { class: 'btn btn--primary', type: 'button', onClick: go }, 'Duplicate'),
    )
  }

  async function duplicate(s, newId) {
    const result = await postJson(`/api/projects/${encodeURIComponent(s.project)}/library`, { action: 'copy', id: s.id, newId, to: 'library' })
    if (!result.ok) return say(s, 'danger', result.body.error ?? 'That didn’t work.')
    onSaved(s.project)
    location.hash = editHref(s.project, newId)
  }

  return {
    mount(project, id) {
      const s = store(project, id)
      if (!s.data && !s.loading) {
        s.loading = true
        s.els.bar.replaceChildren(h('p', { class: 'muted studio__loading' }, 'Loading the workflow…'))
        load(s).finally(() => {
          s.loading = false
        })
      }
      return s.els.root
    },
  }
}
