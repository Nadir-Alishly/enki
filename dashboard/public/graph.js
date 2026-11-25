// Drawing a workflow: the same blocks, ports and lines on a task's page and in the studio, in the
// Palette design system's terms: square blocks, 2px outlines, filled color swatches with dark text.
// Start and End are the orchestrator's two ends of the task (filled orange), Approval is the user's,
// Tests is enki's own check (no agent, no tokens: drawn dashed, with no role swatch), and every other
// block is an agent with a port per outcome. An outcome with no line goes back to the orchestrator:
// it gets a ↩ by its port. Lines run square, and where a line bends can be moved (`routes`).

export const SVG_NS = 'http://www.w3.org/2000/svg'

export function sv(tag, attrs = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) if (value !== undefined && value !== null && value !== false) node.setAttribute(key, String(value))
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue
    node.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return node
}

export const FIXED = ['start', 'spec-approval', 'approval', 'end']
/** The two steps where the user approves: the spec, then the plan. */
const APPROVALS = ['spec-approval', 'approval']
const CARD_W = 176
const HEAD = 52
// On a task, an agent's head also holds its model and a context bar.
const TASK_HEAD = 70
const ROW = 22
const COLUMN_GAP = 72
const ROW_GAP = 32
const STUB = 18
const PORT = 8

export const targetsOf = edge => (Array.isArray(edge.to) ? edge.to : [edge.to])
export const edgeKey = (from, on, to) => `${from}:${on}:${to}`

/** Each block's output ports: Start's request, the approvals' answers, Tests' pass and fail, a role's outcomes. */
export function outputsOf(workflow, node, outcomesOfRole) {
  const own = { start: ['request'], 'spec-approval': ['approved', 'changes'], approval: ['approved', 'change-spec', 'change-plan'], end: [], verify: ['pass', 'fail'] }[node.kind] ?? outcomesOfRole(node)
  const otherwise = workflow.edges.some(edge => edge.from === node.id && edge.on === 'otherwise')
  return otherwise ? [...own, 'otherwise'] : own
}

export function nodeSize(node, outputs, head = HEAD) {
  if (node.kind === 'start' || node.kind === 'end') return { w: 96, h: 40 }
  if (APPROVALS.includes(node.kind)) return { w: 196, h: 24 + Math.max(2, outputs.length) * 26 }
  return { w: CARD_W, h: head + Math.max(1, outputs.length) * ROW + 6, head }
}

/** Where an output port sits, relative to its block. */
export function portPoint(node, size, index) {
  if (node.kind === 'start') return { x: size.w, y: size.h / 2 }
  if (APPROVALS.includes(node.kind)) return { x: size.w, y: 26 + index * 26 }
  return { x: size.w, y: (size.head ?? HEAD) + index * ROW + ROW / 2 }
}

/** Where lines come in. */
export const inputPoint = (node, size) => ({ x: 0, y: node.kind ? size.h / 2 : 26 })

/**
 * Positions for a workflow with none saved: columns by distance from Start along its edges, End
 * last, each column's blocks stacked and centered.
 */
export function autoLayout(workflow, outcomesOfRole) {
  const column = new Map([['start', 0]])
  const queue = ['start']
  while (queue.length > 0) {
    const id = queue.shift()
    for (const edge of workflow.edges.filter(item => item.from === id)) {
      for (const target of targetsOf(edge)) {
        if (column.has(target) || target === 'end') continue
        column.set(target, column.get(id) + 1)
        queue.push(target)
      }
    }
  }
  for (const node of workflow.nodes) if (!column.has(node.id) && node.id !== 'end') column.set(node.id, 1)
  column.set('end', Math.max(0, ...[...column.values()]) + 1)
  const columns = new Map()
  for (const node of workflow.nodes) {
    const c = column.get(node.id)
    if (!columns.has(c)) columns.set(c, [])
    columns.get(c).push(node)
  }
  const sizeOf = node => nodeSize(node, outputsOf(workflow, node, outcomesOfRole))
  const heights = new Map([...columns].map(([c, nodes]) => [c, nodes.reduce((sum, node) => sum + sizeOf(node).h + ROW_GAP, -ROW_GAP)]))
  const tallest = Math.max(...heights.values())
  const layout = {}
  let x = 40
  for (const c of [...columns.keys()].sort((a, b) => a - b)) {
    let y = 40 + (tallest - heights.get(c)) / 2
    const width = Math.max(...columns.get(c).map(node => sizeOf(node).w))
    for (const node of columns.get(c)) {
      const size = sizeOf(node)
      layout[node.id] = { x: Math.round(x + (width - size.w) / 2), y: Math.round(y) }
      y += size.h + ROW_GAP
    }
    x += width + COLUMN_GAP
  }
  return layout
}

/** Where a line runs unless it's been moved: one upright going forward; under the blocks and back otherwise. */
export function defaultCourse(from, to, below) {
  if (to.x - from.x >= 2 * STUB) return [Math.round((from.x + to.x) / 2)]
  return [from.x + STUB, below, to.x - STUB]
}

/**
 * A square line from an output port to an input. Its course is a list of positions, alternately
 * the x of an upright and the y of a crossing: out of the port across to the first upright, along
 * the course, and up or down to the input's height to come in from the left. Each position is one
 * segment that can be dragged; the first and last stretches stay on their ports.
 */
export function routeEdge(from, to, course, below) {
  const custom = Array.isArray(course) && course.length % 2 === 1 && course.every(Number.isFinite)
  const c = custom ? course : defaultCourse(from, to, below)
  const points = [from]
  let at = from
  c.forEach((value, index) => {
    at = index % 2 === 0 ? { x: value, y: at.y } : { x: at.x, y: value }
    points.push(at)
  })
  points.push({ x: at.x, y: to.y }, to)
  const segments = c.map((value, index) => {
    const a = points[index + 1]
    const b = points[index + 2]
    return { index, axis: index % 2 === 0 ? 'x' : 'y', a, b, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, length: Math.abs(a.x - b.x) + Math.abs(a.y - b.y) }
  })
  const longest = [...segments].sort((x, y) => y.length - x.length)[0]
  return { d: `M ${points.map(point => `${point.x} ${point.y}`).join(' L ')}`, points, course: c, segments, handle: longest && longest.length > 0 ? longest.mid : { x: (from.x + to.x) / 2, y: from.y }, custom }
}

/** The movable segment of a line nearest a point. */
export function nearestSegment(line, point) {
  let best = null
  for (const segment of line.segments) {
    const x = Math.min(Math.max(point.x, Math.min(segment.a.x, segment.b.x)), Math.max(segment.a.x, segment.b.x))
    const y = Math.min(Math.max(point.y, Math.min(segment.a.y, segment.b.y)), Math.max(segment.a.y, segment.b.y))
    const distance = Math.hypot(point.x - x, point.y - y)
    if (!best || distance < best.distance) best = { ...segment, distance }
  }
  return best
}

const STATUS_WORD = { running: 'Running', queued: 'Waiting', ready: 'Ready', 'handed-off': 'With you', waiting: 'Waiting for you', done: 'Done', idle: '' }
const clip = (text, length) => (text.length > length ? `${text.slice(0, length - 1)}…` : text)

/**
 * The graph as one SVG group, with its bounds.
 * - `outcomesOfRole(node)`: a step's outcomes.
 * - `styleOf(node)`: `{ label, color, stripes, roleName }` for an agent step.
 * - `routes`: each line's course, by edge key (see routeEdge).
 * - `status`: the run, from the server's view of a task (each node's status, visits, reason), or null.
 * - `selected`: `{ type: 'node', id }` or `{ type: 'edge', from, on, to }`.
 * - `bad`: edges to draw as broken, by edge key.
 * - `format`: `{ model, tokens }`, to show each agent's model, effort and context on a task's view.
 */
export function drawGraph(workflow, { layout, outcomesOfRole, styleOf, routes = {}, status = null, selected = null, bad = new Set(), editable = false, format = null }) {
  // Stripes for patterned roles, as QA's, or both ways, as the spec writer's: one pattern per color and kind.
  const patterns = new Map()
  const patternFor = (color, kind) => {
    const key = `${kind}|${color}`
    if (!patterns.has(key)) patterns.set(key, `wf-stripes-${patterns.size}`)
    return `url(#${patterns.get(key)})`
  }
  // A role's square: filled, striped (QA) or a dashed outline (the scout).
  const swatch = (style, x = 12, y = 13) =>
    style.pattern === 'dashed'
      ? sv('rect', { x: x + 1, y: y + 1, width: 14, height: 14, fill: 'none', stroke: style.color, 'stroke-width': 2, 'stroke-dasharray': '3 2', class: 'wf-swatch' })
      : sv('rect', { x, y, width: 16, height: 16, fill: ['stripes', 'cross'].includes(style.pattern) ? patternFor(style.color, style.pattern) : style.color, class: 'wf-swatch' })
  const agentLines = (agent, size, { model, tokens }) => {
    const pct = agent.contextWindow ? Math.min(1, agent.context / agent.contextWindow) : 0
    const said = agent.contextWindow ? `Context: ${tokens(agent.context)} of ${tokens(agent.contextWindow)}` : 'No context data yet'
    // The bar keeps 12px from the sides, and leaves room on its right for the percentage.
    const bar = { x: 12, y: 55, w: size.w - 12 - 12 - 36, h: 4 }
    return [
      sv('text', { x: 12, y: 45, class: 'wf-node__detail' }, clip([agent.model ? model(agent.model) : 'Model unknown', agent.effort].filter(Boolean).join(' · '), 25)),
      sv('rect', { x: bar.x, y: bar.y, width: bar.w, height: bar.h, class: 'wf-ctx' }),
      sv('rect', { x: bar.x, y: bar.y, width: bar.w * pct, height: bar.h, class: 'wf-ctx__fill' }, sv('title', {}, said)),
      sv('text', { x: size.w - 12, y: bar.y + 5, 'text-anchor': 'end', class: 'wf-node__detail' }, agent.contextWindow ? `${Math.round(pct * 100)}%` : '—', sv('title', {}, said)),
    ]
  }
  const nodes = new Map(workflow.nodes.map(node => [node.id, node]))
  const geo = new Map()
  for (const node of workflow.nodes) {
    const outputs = outputsOf(workflow, node, outcomesOfRole)
    geo.set(node.id, { at: layout[node.id] ?? { x: 0, y: 0 }, size: nodeSize(node, outputs, format && !node.kind ? TASK_HEAD : HEAD), outputs })
  }
  const portAt = (id, on) => {
    const { at, size, outputs } = geo.get(id)
    const p = portPoint(nodes.get(id), size, Math.max(0, outputs.indexOf(on)))
    return { x: at.x + p.x, y: at.y + p.y }
  }
  const inputAt = id => {
    const { at, size } = geo.get(id)
    const p = inputPoint(nodes.get(id), size)
    return { x: at.x + p.x, y: at.y + p.y }
  }
  const bottom = id => geo.get(id).at.y + geo.get(id).size.h
  const isSelected = (type, match) => selected?.type === type && Object.entries(match).every(([key, value]) => selected[key] === value)

  const edgeLayer = []
  const tagLayer = []
  const lines = {}
  let backs = 0
  for (const edge of workflow.edges) {
    if (!geo.has(edge.from)) continue
    const from = portAt(edge.from, edge.on)
    const taken = status?.edges?.find(item => item.from === edge.from && item.on === edge.on)?.taken ?? 0
    for (const target of targetsOf(edge)) {
      if (!geo.has(target)) continue
      const to = inputAt(target)
      const key = edgeKey(edge.from, edge.on, target)
      // Lines that run back each get their own lane under the blocks, so they don't sit on each other.
      const back = to.x - from.x < 2 * STUB
      // Under every block it passes, not just its own two.
      const left = Math.min(from.x, to.x) - STUB
      const right = Math.max(from.x, to.x) + STUB
      const floor = Math.max(bottom(edge.from), bottom(target), ...[...geo.values()].filter(({ at, size }) => at.x < right && at.x + size.w > left).map(({ at, size }) => at.y + size.h))
      const line = routeEdge(from, { x: to.x - 1, y: to.y }, routes[key], floor + 20 + (back ? backs++ : 0) * 12)
      lines[key] = line
      const picked = isSelected('edge', { from: edge.from, on: edge.on, to: target })
      const cls = ['wf-edge', taken ? 'wf-edge--taken' : '', bad.has(key) ? 'wf-edge--bad' : '', picked ? 'wf-edge--selected' : ''].filter(Boolean).join(' ')
      edgeLayer.push(
        sv(
          'g',
          { class: 'wf-edgegroup', 'data-edge': key, 'data-role': nodes.get(edge.from)?.kind ? null : edge.from },
          // A wide invisible stroke makes the line easy to grab.
          editable ? sv('path', { d: line.d, class: 'wf-edge__hit' }) : null,
          sv('path', { d: line.d, class: cls, 'marker-end': 'url(#wf-arrow)' }),
        ),
      )
      const tag = edge.max ? (status ? `${taken}/${edge.max}` : `×${edge.max}`) : status && taken > 1 ? `×${taken}` : null
      if (tag) {
        const width = tag.length * 7 + 12
        tagLayer.push(sv('g', { class: 'wf-tag', 'pointer-events': 'none' }, sv('rect', { x: line.handle.x - width / 2, y: line.handle.y - 10, width, height: 20, class: 'wf-tag__box' }), sv('text', { x: line.handle.x, y: line.handle.y + 4, 'text-anchor': 'middle', class: 'wf-tag__text' }, tag)))
      }
      if (editable && picked) {
        // Every movable segment gets a handle; the arrow's end can be dragged to another block.
        for (const segment of line.segments.filter(item => item.length > 0)) {
          tagLayer.push(
            sv('rect', { x: segment.mid.x - 6, y: segment.mid.y - 6, width: 12, height: 12, class: `wf-handle wf-handle--${segment.axis}`, 'data-handle': key, 'data-seg': segment.index, 'data-axis': segment.axis }, sv('title', {}, 'Drag to move this segment. Double-click it to take this bend out.')),
          )
        }
        tagLayer.push(
          sv('rect', { x: to.x - 13, y: to.y - 6, width: 12, height: 12, class: 'wf-handle wf-handle--end', 'data-retarget': key }, sv('title', {}, 'Drag onto another block to send this outcome there')),
          sv('g', { class: 'wf-delete', 'data-delete': key, role: 'button', 'aria-label': 'Remove this line' }, sv('rect', { x: line.handle.x + 10, y: line.handle.y - 22, width: 20, height: 20, class: 'wf-delete__box' }), sv('path', { d: `M ${line.handle.x + 15} ${line.handle.y - 17} L ${line.handle.x + 25} ${line.handle.y - 7} M ${line.handle.x + 25} ${line.handle.y - 17} L ${line.handle.x + 15} ${line.handle.y - 7}`, class: 'wf-delete__x' }), sv('title', {}, 'Remove this line')),
        )
      }
    }
  }

  const nodeLayer = []
  for (const node of workflow.nodes) {
    const { at, size, outputs } = geo.get(node.id)
    const run = status?.nodes?.find(item => item.id === node.id) ?? null
    const state = run ? (run.status === 'queued' && run.ready ? 'ready' : run.status) : null
    const style = node.kind ? null : styleOf(node)
    const picked = isSelected('node', { id: node.id })
    const kind = node.kind ?? 'agent'
    const cls = ['wf-node', `wf-node--${kind}`, state ? `wf-node--${state}` : '', picked ? 'wf-node--selected' : '', editable ? 'wf-node--editable' : ''].filter(Boolean).join(' ')
    const title = { start: 'Start', end: 'End', 'spec-approval': 'Spec approval', approval: 'Approval', verify: 'Tests' }[node.kind] ?? style.label
    const sub = { start: 'The request', end: 'The report', 'spec-approval': 'You approve the spec', approval: 'You approve the plan', verify: 'Built-in · no agent' }[node.kind] ?? style.roleName
    const parts = []
    if (node.kind === 'start' || node.kind === 'end') {
      parts.push(sv('rect', { x: 0, y: 0, width: size.w, height: size.h, class: 'wf-node__box wf-node__box--orchestrator' }))
      parts.push(sv('text', { x: size.w / 2, y: size.h / 2 + 5, 'text-anchor': 'middle', class: 'wf-node__name wf-node__name--on-fill' }, title))
    } else if (APPROVALS.includes(node.kind)) {
      parts.push(sv('rect', { x: 0, y: 0, width: size.w, height: size.h, class: 'wf-node__box wf-node__box--approval' }))
      parts.push(sv('text', { x: 14, y: 26, class: 'wf-node__name' }, title))
      parts.push(sv('text', { x: 14, y: 44, class: 'wf-node__detail' }, run?.status === 'waiting' ? 'Waiting for you' : 'by you'))
    } else {
      const detail = run ? (state === 'handed-off' ? `With you: ${run.reason}` : [STATUS_WORD[state], run.outcome ? `last: ${run.outcome}` : ''].filter(Boolean).join(' · ') || 'Not started') : sub
      parts.push(sv('rect', { x: 0, y: 0, width: size.w, height: size.h, class: `wf-node__box${node.kind === 'verify' ? ' wf-node__box--builtin' : ''}` }))
      if (node.kind === 'verify') {
        // A check mark in a square: enki's own step, not a role.
        parts.push(sv('rect', { x: 12, y: 13, width: 16, height: 16, class: 'wf-icon' }), sv('path', { d: 'M 15.5 21 L 19 24.5 L 25 17.5', class: 'wf-icon__mark' }))
      } else parts.push(swatch(style))
      const name = `${title}${run?.visits > 1 ? ` ×${run.visits}` : ''}`
      const agent = format && run?.agent
      if (agent) {
        // On a task: what the agent runs on and how full its context is, its state beside its name.
        parts.push(sv('text', { x: 38, y: 26, class: 'wf-node__name' }, clip(name, 15)))
        parts.push(...agentLines(agent, size, format))
      } else {
        parts.push(sv('text', { x: 38, y: 26, class: 'wf-node__name' }, clip(name, 17)))
        parts.push(sv('text', { x: 12, y: 44, class: 'wf-node__detail' }, clip(detail, 26)))
      }
      if (state && state !== 'idle') parts.push(sv('circle', { cx: size.w - 12, cy: 21, r: 4, class: `wf-dot wf-dot--${state}${state === 'running' ? ' wf-pulse' : ''}` }))
      parts.push(sv('line', { x1: 0, x2: size.w, y1: size.head ?? HEAD, y2: size.head ?? HEAD, class: 'wf-node__rule' }))
    }
    // Ports: one input on the left (not Start), one output per outcome on the right, all square.
    if (node.kind !== 'start') {
      const p = inputPoint(node, size)
      parts.push(sv('rect', { x: p.x - PORT / 2, y: p.y - PORT / 2, width: PORT, height: PORT, class: 'wf-port wf-port--in', 'data-input': node.id }))
    }
    outputs.forEach((on, index) => {
      const p = portPoint(node, size, index)
      const wired = workflow.edges.some(edge => edge.from === node.id && edge.on === on)
      const handsBack = !wired && !node.kind
      if (node.kind !== 'start') parts.push(sv('text', { x: p.x - 12, y: p.y + 4, 'text-anchor': 'end', class: `wf-port__label${handsBack ? ' wf-port__label--back' : ''}${node.kind === 'start' || node.kind === 'end' ? ' wf-port__label--on-fill' : ''}` }, on))
      const hit = editable ? sv('rect', { x: p.x - 9, y: p.y - 9, width: 18, height: 18, class: 'wf-port__hit', 'data-port': `${node.id}:${on}` }) : null
      parts.push(
        sv('rect', { x: p.x - PORT / 2, y: p.y - PORT / 2, width: PORT, height: PORT, class: `wf-port wf-port--out${wired ? ' wf-port--wired' : ''}`, 'data-port': `${node.id}:${on}` }, sv('title', {}, editable ? `${on}: drag to a block to connect` : on)),
        hit,
      )
      if (handsBack) parts.push(sv('text', { x: p.x + 9, y: p.y + 4, class: 'wf-back' }, '↩', sv('title', {}, `${on}: goes back to the orchestrator`)))
    })
    if (state === 'handed-off' && run?.reason) {
      const text = clip(`With you: ${run.reason}`, 30)
      parts.push(sv('g', { class: 'wf-badge' }, sv('rect', { x: 0, y: -26, width: text.length * 6.6 + 16, height: 20, class: 'wf-badge__box' }), sv('text', { x: 8, y: -12, class: 'wf-badge__text' }, text)))
    }
    nodeLayer.push(
      sv(
        'g',
        {
          class: cls,
          transform: `translate(${at.x} ${at.y})`,
          'data-node': node.id,
          'data-step': node.id,
          'data-role': node.kind ? null : node.id,
          ...(editable ? { tabindex: 0, role: 'button', 'aria-label': `${title}${node.kind ? '' : ` (${node.id})`}: select to edit` } : {}),
        },
        sv('title', {}, `${title}${node.kind ? `: ${sub}` : ` (${node.id})`}${run ? `. ${STATUS_WORD[state] || 'Idle'}${run.visits ? `, visits: ${run.visits}` : ''}${run.reason ? `, ${run.reason}` : ''}` : ''}`),
        parts,
      ),
    )
  }

  const defs = sv(
    'defs',
    {},
    [...patterns].map(([key, id]) => {
      const [kind, color] = key.split('|')
      return sv('pattern', { id, width: 7, height: 7, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        sv('rect', { width: 7, height: 7, fill: 'var(--black-950)' }),
        kind === 'cross' ? [sv('rect', { width: 3, height: 7, fill: color }), sv('rect', { width: 7, height: 3, fill: color })] : sv('rect', { width: 4, height: 7, fill: color }))
    }),
  )
  const xs = [...geo.values()].flatMap(({ at, size }) => [at.x, at.x + size.w])
  const ys = [...geo.values()].flatMap(({ at, size }) => [at.y, at.y + size.h])
  const handles = Object.values(lines).map(line => line.handle.y)
  // On a task, the orchestrator sits top left, above everything: it works beside the graph, not in it.
  const lead = format && status?.orchestrator
  if (lead && xs.length) {
    const size = { w: CARD_W, h: TASK_HEAD }
    const at = { x: Math.min(...xs), y: Math.min(...ys, ...handles) - TASK_HEAD - 36 }
    nodeLayer.push(
      sv(
        'g',
        { class: `wf-node wf-node--lead wf-node--${lead.state === 'running' ? 'running' : 'idle'}`, transform: `translate(${at.x} ${at.y})`, 'data-role': 'orchestrator' },
        sv('title', {}, 'Orchestrator: carries messages between you and the team'),
        sv('rect', { x: 0, y: 0, width: size.w, height: size.h, class: 'wf-node__box' }),
        sv('rect', { x: 12, y: 13, width: 16, height: 16, class: 'wf-swatch', fill: 'var(--orange)' }),
        sv('text', { x: 38, y: 26, class: 'wf-node__name' }, 'Orchestrator'),
        lead.state === 'running' && sv('circle', { cx: size.w - 12, cy: 21, r: 4, class: 'wf-dot wf-dot--running wf-pulse' }),
        agentLines(lead, size, format),
      ),
    )
    ys.push(at.y)
  }
  const top = Math.min(...ys, ...handles)
  const low = Math.max(...ys, ...handles)
  const bounds = xs.length ? { x: Math.min(...xs) - 40, y: top - 48, w: Math.max(...xs) - Math.min(...xs) + 120, h: low - top + 96 } : { x: 0, y: 0, w: 400, h: 200 }
  return { group: sv('g', { class: 'wf-graph' }, defs, sv('g', {}, edgeLayer), sv('g', {}, nodeLayer), sv('g', {}, tagLayer)), bounds, portAt, lines }
}

export const arrowDefs = () =>
  sv('defs', {}, sv('marker', { id: 'wf-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, sv('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'wf-arrow' })))
