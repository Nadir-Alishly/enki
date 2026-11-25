// The Map page: the project's codebase map as a graph, like Obsidian's graph view. Each map file is a
// bubble, joined to its parent by a solid line and to the files it links to by a dashed one. Bubbles
// settle under a small force simulation and can be dragged; the canvas pans and zooms. Clicking a
// bubble opens its file on the right. Map text is written by agents, so it is only ever shown as text.
import { sv } from './graph.js'

// One color per repo, from Palette's swatches. Orange is kept for the selected bubble.
const REPO_COLORS = ['var(--lavender)', 'var(--cyan)', 'var(--green)', 'var(--white-100)', 'var(--yellow)']
const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

export function createMap({ h, getJson }) {
  const stores = new Map()

  function store(id) {
    if (!stores.has(id)) stores.set(id, { id, root: h('div', { class: 'mappage' }), data: null, error: null, pos: new Map(), view: { x: 0, y: 0, k: 1 }, selected: null, hovered: null })
    return stores.get(id)
  }

  /** The page for a project: the same element each time, loaded the first time. */
  function mount(id) {
    const s = store(id)
    if (!s.data && !s.loading) refresh(id)
    else if (s.data && !s.frame) queueMicrotask(() => start(s))
    return s.root
  }

  /** Reloads the map, keeping where each bubble already is. */
  async function refresh(id) {
    const s = store(id)
    s.loading = true
    try {
      const data = await getJson(`/api/projects/${encodeURIComponent(id)}/map`)
      const same = s.data && JSON.stringify([s.data.nodes.map(node => [node.id, node.text]), s.data.edges]) === JSON.stringify([data.nodes.map(node => [node.id, node.text]), data.edges])
      s.error = null
      if (!same) {
        s.data = data
        build(s)
      }
    } catch (error) {
      s.error = error.message
      if (!s.data) render(s)
    }
    s.loading = false
  }

  // ---------- the graph ----------

  function build(s) {
    const { nodes, edges } = s.data
    s.byId = new Map(nodes.map(node => [node.id, node]))
    s.repoColor = new Map((s.data.branches ?? []).map((repo, index) => [repo.name, REPO_COLORS[index % REPO_COLORS.length]]))
    s.children = new Map()
    s.parent = new Map()
    s.near = new Map(nodes.map(node => [node.id, new Set()]))
    for (const edge of edges) {
      s.near.get(edge.from)?.add(edge.to)
      s.near.get(edge.to)?.add(edge.from)
      if (edge.kind === 'tree') {
        s.parent.set(edge.to, edge.from)
        s.children.set(edge.from, [...(s.children.get(edge.from) ?? []), edge.to])
      }
    }
    const descendants = id => (s.children.get(id) ?? []).reduce((sum, child) => sum + 1 + descendants(child), 0)
    for (const node of nodes) node.r = node.kind === 'project' ? 16 : node.kind === 'root' ? 13 : node.kind === 'empty' ? 10 : 5 + Math.min(7, 1.6 * Math.sqrt(descendants(node.id)))
    seed(s)
    if (s.selected && !s.byId.has(s.selected)) s.selected = null
    render(s)
  }

  /** Starting places: a radial tree around the top, so the simulation only has to relax it. */
  function seed(s) {
    const tops = s.data.nodes.filter(node => !s.parent.has(node.id))
    const leaves = id => {
      const kids = s.children.get(id) ?? []
      return kids.length ? kids.reduce((sum, kid) => sum + leaves(kid), 0) : 1
    }
    const place = (id, from, to, depth, origin) => {
      const angle = (from + to) / 2
      const radius = depth * 90
      if (!s.pos.has(id)) s.pos.set(id, { x: origin.x + Math.cos(angle) * radius + Math.random() - 0.5, y: origin.y + Math.sin(angle) * radius + Math.random() - 0.5, vx: 0, vy: 0 })
      const kids = s.children.get(id) ?? []
      const total = kids.reduce((sum, kid) => sum + leaves(kid), 0)
      let at = from
      for (const kid of kids) {
        const share = ((to - from) * leaves(kid)) / total
        place(kid, at, at + share, depth + 1, origin)
        at += share
      }
    }
    tops.forEach((top, index) => place(top.id, 0, Math.PI * 2, 0, { x: index * 400, y: 0 }))
    for (const id of [...s.pos.keys()]) if (!s.byId.has(id)) s.pos.delete(id)
  }

  /** One step of the simulation: bubbles push apart, lines pull like springs, everything drifts to the middle. */
  function tick(s) {
    const { nodes, edges } = s.data
    const alpha = s.alpha
    const list = nodes.map(node => [node, s.pos.get(node.id)])
    for (let i = 0; i < list.length; i++) {
      const [a, pa] = list[i]
      for (let j = i + 1; j < list.length; j++) {
        const [b, pb] = list[j]
        let dx = pb.x - pa.x
        let dy = pb.y - pa.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
          d2 = 1
        }
        const d = Math.sqrt(d2)
        // Charge, plus a hard push when the bubbles and their labels would overlap.
        let force = (-260 * alpha) / d2
        const room = a.r + b.r + 18
        if (d < room) force -= ((room - d) / d) * 0.5
        pa.vx += dx * force
        pa.vy += dy * force
        pb.vx -= dx * force
        pb.vy -= dy * force
      }
    }
    for (const edge of edges) {
      const pa = s.pos.get(edge.from)
      const pb = s.pos.get(edge.to)
      if (!pa || !pb) continue
      const a = s.byId.get(edge.from)
      const b = s.byId.get(edge.to)
      const dx = pb.x + pb.vx - pa.x - pa.vx
      const dy = pb.y + pb.vy - pa.y - pa.vy
      const d = Math.hypot(dx, dy) || 1
      const length = edge.kind === 'tree' ? 46 + a.r + b.r : 150
      const strength = edge.kind === 'tree' ? 0.5 : 0.04
      const pull = ((d - length) / d) * alpha * strength
      pb.vx -= dx * pull * 0.5
      pb.vy -= dy * pull * 0.5
      pa.vx += dx * pull * 0.5
      pa.vy += dy * pull * 0.5
    }
    for (const [node, p] of list) {
      if (s.drag?.id === node.id) {
        p.vx = 0
        p.vy = 0
        continue
      }
      p.vx -= p.x * 0.02 * alpha
      p.vy -= p.y * 0.02 * alpha
      p.vx *= 0.6
      p.vy *= 0.6
      p.x += p.vx
      p.y += p.vy
    }
    s.alpha += ((s.drag ? 0.3 : 0) - s.alpha) * 0.0228
  }

  function heat(s, alpha) {
    s.alpha = Math.max(s.alpha ?? 0, alpha)
    if (!s.frame) start(s)
  }

  function start(s) {
    if (s.frame || !s.data || !s.els) return
    if (reduceMotion()) {
      // No motion: settle at once and draw the result.
      while (s.alpha > 0.005) tick(s)
      place(s)
      return
    }
    const step = () => {
      // The page was left: stop until it's mounted again.
      if (!s.root.isConnected) {
        s.frame = null
        return
      }
      if (s.alpha > 0.005 || s.drag) tick(s)
      place(s)
      if (!s.touched && s.alpha > 0.005) fit(s)
      s.frame = s.alpha > 0.005 || s.drag ? requestAnimationFrame(step) : null
    }
    s.frame = requestAnimationFrame(step)
  }

  /** Moves the drawn bubbles and lines to where the simulation has them. */
  function place(s) {
    for (const [id, el] of s.els.nodes) {
      const p = s.pos.get(id)
      el.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`)
    }
    for (const [edge, el] of s.els.edges) {
      const a = s.pos.get(edge.from)
      const b = s.pos.get(edge.to)
      el.setAttribute('x1', a.x.toFixed(1))
      el.setAttribute('y1', a.y.toFixed(1))
      el.setAttribute('x2', b.x.toFixed(1))
      el.setAttribute('y2', b.y.toFixed(1))
    }
  }

  // ---------- view: pan, zoom, fit ----------

  function applyView(s) {
    const { x, y, k } = s.view
    s.els.world.setAttribute('transform', `translate(${x} ${y}) scale(${k})`)
    s.els.canvas.style.backgroundSize = `${24 * k}px ${24 * k}px`
    s.els.canvas.style.backgroundPosition = `${x}px ${y}px`
    s.els.zoom.textContent = `${Math.round(k * 100)}%`
    // Labels fade out when zoomed far out, as in Obsidian, except where the eye is.
    s.els.svg.classList.toggle('mapgraph--far', k < 0.55)
  }

  function zoomAt(s, factor, cx, cy) {
    s.touched = true
    const k = Math.min(3, Math.max(0.2, s.view.k * factor))
    s.view.x = cx - ((cx - s.view.x) * k) / s.view.k
    s.view.y = cy - ((cy - s.view.y) * k) / s.view.k
    s.view.k = k
    applyView(s)
  }

  function fit(s) {
    const rect = s.els.canvas.getBoundingClientRect()
    if (rect.width < 50 || rect.height < 50) return
    const points = [...s.pos.values()]
    const pad = 40
    const x0 = Math.min(...points.map(p => p.x)) - pad
    const x1 = Math.max(...points.map(p => p.x)) + pad
    const y0 = Math.min(...points.map(p => p.y)) - pad
    const y1 = Math.max(...points.map(p => p.y)) + pad + 16
    const k = Math.min(1.4, Math.max(0.2, Math.min(rect.width / (x1 - x0), rect.height / (y1 - y0))))
    s.view = { k, x: rect.width / 2 - ((x0 + x1) / 2) * k, y: rect.height / 2 - ((y0 + y1) / 2) * k }
    applyView(s)
  }

  const toWorld = (s, event) => {
    const rect = s.els.canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left - s.view.x) / s.view.k, y: (event.clientY - rect.top - s.view.y) / s.view.k }
  }

  function wire(s) {
    const { svg, canvas } = s.els
    svg.addEventListener('pointerdown', event => {
      if (event.button !== 0) return
      const el = event.target.closest('[data-node]')
      if (el) {
        const id = el.getAttribute('data-node')
        const p = toWorld(s, event)
        const at = s.pos.get(id)
        s.drag = { id, dx: p.x - at.x, dy: p.y - at.y, sx: event.clientX, sy: event.clientY, moved: false }
      } else s.pan = { x: event.clientX - s.view.x, y: event.clientY - s.view.y }
      svg.setPointerCapture(event.pointerId)
      event.preventDefault()
    })
    svg.addEventListener('pointermove', event => {
      if (s.drag) {
        if (!s.drag.moved && Math.hypot(event.clientX - s.drag.sx, event.clientY - s.drag.sy) < 4) return
        if (!s.drag.moved) {
          s.drag.moved = true
          s.touched = true
          canvas.classList.add('is-dragging')
          if (!reduceMotion()) heat(s, 0.3)
        }
        const p = toWorld(s, event)
        Object.assign(s.pos.get(s.drag.id), { x: p.x - s.drag.dx, y: p.y - s.drag.dy, vx: 0, vy: 0 })
        if (reduceMotion()) place(s)
      } else if (s.pan) {
        s.touched = true
        s.view.x = event.clientX - s.pan.x
        s.view.y = event.clientY - s.pan.y
        applyView(s)
      } else hover(s, event.target.closest?.('[data-node]')?.getAttribute('data-node') ?? null)
    })
    const end = () => {
      if (s.drag && !s.drag.moved) select(s, s.drag.id)
      else if (s.drag) hover(s, null)
      s.drag = null
      s.pan = null
      canvas.classList.remove('is-dragging')
    }
    svg.addEventListener('pointerup', end)
    svg.addEventListener('pointercancel', end)
    svg.addEventListener('pointerleave', () => !s.drag && hover(s, null))
    svg.addEventListener(
      'wheel',
      event => {
        event.preventDefault()
        const rect = canvas.getBoundingClientRect()
        if (!event.ctrlKey && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          s.touched = true
          s.view.x -= event.deltaX
          applyView(s)
          return
        }
        zoomAt(s, Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top)
      },
      { passive: false },
    )
    svg.addEventListener('keydown', event => {
      const id = event.target.closest?.('[data-node]')?.getAttribute('data-node')
      if (id && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault()
        select(s, id)
      }
    })
    svg.addEventListener('focusin', event => hover(s, event.target.closest?.('[data-node]')?.getAttribute('data-node') ?? null))
    svg.addEventListener('focusout', () => hover(s, null))
    s.root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && s.selected) select(s, null)
    })
  }

  /** Hovering a bubble lights it, its neighbours and the lines between them, and dims the rest. */
  function hover(s, id) {
    if (s.hovered === id) return
    s.hovered = id
    paint(s)
  }

  function paint(s) {
    const lit = s.hovered
    s.els.svg.classList.toggle('mapgraph--lit', Boolean(lit))
    const near = lit ? s.near.get(lit) : null
    for (const [id, el] of s.els.nodes) {
      el.classList.toggle('is-near', Boolean(lit) && (id === lit || near.has(id)))
      el.classList.toggle('is-selected', id === s.selected)
    }
    for (const [edge, el] of s.els.edges) el.classList.toggle('is-near', Boolean(lit) && (edge.from === lit || edge.to === lit))
  }

  function select(s, id) {
    s.selected = id
    paint(s)
    renderInspector(s)
    s.els.body.classList.toggle('mappage__body--open', Boolean(id))
    if (id) s.els.inspector.querySelector('h2')?.focus({ preventScroll: true })
    else s.els.svg.querySelector(`[data-node="${CSS.escape(s.lastSelected ?? '')}"]`)?.focus({ preventScroll: true })
    if (id) s.lastSelected = id
  }

  // ---------- drawing ----------

  const colorOf = (s, node) => (node.kind === 'project' ? 'var(--white-100)' : (s.repoColor.get(node.repo) ?? 'var(--border)'))
  const kindWord = node => ({ project: 'project', root: 'map root', empty: 'repo with no map yet', area: 'area' })[node.kind]

  function render(s) {
    if (s.frame) cancelAnimationFrame(s.frame)
    s.frame = null
    const data = s.data
    const head = h('div', { class: 'mappage__bar' }, h('h1', {}, 'Codebase map'), data && legend(s))
    if (!data) {
      s.root.replaceChildren(head, h('div', { class: 'mappage__note' }, h('p', { class: s.error ? 'empty' : 'muted' }, s.error ? `The map couldn't load: ${s.error}` : 'Loading the map…')))
      s.els = null
      return
    }
    if (!data.nodes.some(node => node.kind === 'root')) {
      s.root.replaceChildren(
        head,
        h(
          'div',
          { class: 'mappage__note' },
          h('p', { class: 'empty' }, 'No codebase map yet. Ask the orchestrator to map a repo: it runs a task on the Map workflow, which writes a map/ folder in the repo’s memory, and it shows up here once that task is done.'),
        ),
      )
      s.els = null
      return
    }
    const edgeLayer = sv('g', { class: 'mapgraph__edges' })
    const nodeLayer = sv('g', { class: 'mapgraph__nodes' })
    const world = sv('g', {}, edgeLayer, nodeLayer)
    const svg = sv('svg', { class: 'mapgraph', role: 'group', 'aria-label': `Codebase map: ${data.nodes.length} files. Tab to a bubble and press Enter to read it.` }, world)
    const nodes = new Map()
    const edges = new Map()
    for (const edge of data.edges) {
      const line = sv('line', { class: `map-edge map-edge--${edge.kind}` })
      edges.set(edge, line)
      edgeLayer.append(line)
    }
    for (const node of data.nodes) {
      const warn = node.size > node.limit || node.listed === false
      const color = colorOf(s, node)
      const g = sv(
        'g',
        { class: `map-node map-node--${node.kind}${warn ? ' map-node--warn' : ''}`, 'data-node': node.id, tabindex: 0, role: 'button', 'aria-label': `${node.title}, ${kindWord(node)}${node.repo && node.kind === 'area' ? ` in ${node.repo}` : ''}` },
        sv('circle', { class: 'map-node__hit', r: node.r + 6 }),
        sv('circle', { class: 'map-node__dot', r: node.r }),
        sv('text', { class: 'map-node__label', y: node.r + 15, 'text-anchor': 'middle' }, node.title),
      )
      // Through the CSSOM: the page's CSP refuses style attributes.
      g.style.setProperty('--node', color)
      nodes.set(node.id, g)
      nodeLayer.append(g)
    }
    const canvas = h('div', { class: 'mappage__canvas' }, svg)
    const zoom = h('span', { class: 'studio__zoomvalue', 'aria-live': 'polite' }, '100%')
    const center = () => {
      const rect = canvas.getBoundingClientRect()
      return [rect.width / 2, rect.height / 2]
    }
    const tools = h(
      'div',
      { class: 'studio__zoom' },
      h('button', { type: 'button', class: 'studio__tool', 'aria-label': 'Zoom out', onclick: () => zoomAt(s, 1 / 1.25, ...center()) }, '−'),
      zoom,
      h('button', { type: 'button', class: 'studio__tool', 'aria-label': 'Zoom in', onclick: () => zoomAt(s, 1.25, ...center()) }, '+'),
      h('button', { type: 'button', class: 'studio__tool studio__tool--text', onclick: () => fit(s) }, 'Fit'),
      h('button', { type: 'button', class: 'studio__tool studio__tool--text', onclick: () => heat(s, 1) }, 'Shake'),
    )
    canvas.append(tools)
    const inspector = h('aside', { class: 'mapinspector', 'aria-label': 'Map file' })
    const body = h('div', { class: `mappage__body${s.selected ? ' mappage__body--open' : ''}` }, canvas, inspector)
    s.els = { svg, world, canvas, zoom, inspector, body, nodes, edges }
    s.root.replaceChildren(head, body)
    wire(s)
    paint(s)
    renderInspector(s)
    // A quick, silent head start, then the rest is animated. A reload only nudges what's there.
    s.alpha = s.drawn ? 0.3 : 1
    s.drawn = true
    for (let i = 0; i < 120; i++) tick(s)
    place(s)
    requestAnimationFrame(() => {
      if (!s.touched) fit(s)
      else applyView(s)
      start(s)
    })
  }

  function legend(s) {
    const repos = s.data.branches ?? []
    const files = s.data.nodes.filter(node => node.kind === 'root' || node.kind === 'area').length
    return h(
      'div',
      { class: 'mappage__legend' },
      repos.map(repo => h('span', { class: 'mappage__repo' }, h('span', { class: 'mappage__swatch', style: { background: s.repoColor?.get(repo.name) ?? 'var(--border)' } }), repo.name, repo.branch && h('span', { class: 'muted' }, `on ${repo.branch}`))),
      h('span', { class: 'mappage__key' }, h('span', { class: 'mappage__line' }), 'parent'),
      h('span', { class: 'mappage__key' }, h('span', { class: 'mappage__line mappage__line--link' }), 'link'),
      h('span', { class: 'muted' }, `${files} ${files === 1 ? 'file' : 'files'}`),
    )
  }

  // ---------- the inspector ----------

  function nodeButton(s, id, note) {
    const node = s.byId.get(id)
    return h(
      'li',
      {},
      h(
        'button',
        { type: 'button', class: 'mapinspector__item', onclick: () => select(s, id) },
        h('span', { class: 'mappage__swatch mappage__swatch--round', style: { background: colorOf(s, node) } }),
        h('span', { class: 'mapinspector__itemtext' }, h('span', {}, node.title), (note ?? node.description) && h('span', { class: 'muted' }, note ?? node.description)),
      ),
    )
  }

  function renderInspector(s) {
    const box = s.els?.inspector
    if (!box) return
    const node = s.selected && s.byId.get(s.selected)
    if (!node) return box.replaceChildren()
    const close = h('button', { type: 'button', class: 'btn btn--icon', 'aria-label': 'Close', title: 'Close (Esc)', onclick: () => select(s, null) }, '×')
    const where = node.kind === 'project' ? 'Project' : node.kind === 'empty' ? node.repo : `${node.repo} · map/${node.path}`
    const parts = [h('div', { class: 'mapinspector__head' }, h('span', { class: 'mapinspector__where' }, h('span', { class: 'mappage__swatch mappage__swatch--round', style: { background: colorOf(s, node) } }), where), close), h('h2', { tabindex: -1 }, node.title)]
    if (node.description) parts.push(h('p', { class: 'mapinspector__desc' }, node.description))
    if (node.kind === 'project') {
      parts.push(h('p', { class: 'mapinspector__desc' }, 'Each repo keeps its own map. Its root lists its top areas, and each area lists its own.'))
      parts.push(section('Repos', h('ul', { class: 'mapinspector__list' }, (s.children.get(node.id) ?? []).map(id => nodeButton(s, id, branchOf(s, s.byId.get(id).repo))))))
    } else if (node.kind === 'empty') {
      parts.push(h('p', { class: 'notice notice--dashed' }, `${node.repo} has no codebase map yet. Ask the orchestrator to map it: a task on the Map workflow writes one.`))
    } else {
      if (node.listed === false) parts.push(h('p', { class: 'mapinspector__warn' }, 'Its parent’s Areas list doesn’t link it, so enki’s check will refuse the next task’s end until it does.'))
      if (node.size > node.limit) parts.push(h('p', { class: 'mapinspector__warn' }, `${kb(node.size)} KB, over the ${kb(node.limit)} KB limit: split it into areas.`))
      const meta = [h('dt', {}, 'Size'), h('dd', {}, `${kb(node.size)} of ${kb(node.limit)} KB`)]
      if (node.files.length) meta.unshift(h('dt', {}, 'Files'), h('dd', { class: 'mapinspector__files' }, node.files.map(file => h('code', {}, file))))
      if (node.kind === 'root' && branchOf(s, node.repo)) meta.push(h('dt', {}, 'Branch'), h('dd', {}, branchOf(s, node.repo)))
      parts.push(h('dl', { class: 'mapinspector__meta' }, meta))
      parts.push(h('div', { class: 'mapinspector__md' }, markdown(s, node)))
      const kids = s.children.get(node.id) ?? []
      if (kids.length) parts.push(section('Areas', h('ul', { class: 'mapinspector__list' }, kids.map(id => nodeButton(s, id)))))
    }
    const parent = s.parent.get(node.id)
    const linked = [...s.near.get(node.id)].filter(id => id !== parent && !(s.children.get(node.id) ?? []).includes(id))
    if (linked.length) parts.push(section('Linked', h('ul', { class: 'mapinspector__list' }, linked.map(id => nodeButton(s, id, s.byId.get(id).repo !== node.repo ? s.byId.get(id).repo : null)))))
    if (parent) parts.push(section('Part of', h('ul', { class: 'mapinspector__list' }, nodeButton(s, parent, ''))))
    box.replaceChildren(...parts)
    box.scrollTop = 0
  }

  const kb = bytes => (bytes / 1024).toFixed(1)
  const branchOf = (s, repo) => s.data.branches?.find(item => item.name === repo)?.branch ?? null
  const section = (title, ...children) => h('section', { class: 'mapinspector__section' }, h('h3', {}, title), ...children)

  /**
   * The file as text: headings, paragraphs, lists, code, inline code, bold and links. Its title, its
   * Files: line and its Areas list are shown above and below instead. Links to other map files open them.
   */
  function markdown(s, node) {
    const lines = node.text.split('\n')
    const blocks = []
    let para = []
    let list = null
    let code = null
    let skip = false
    const flush = () => {
      if (para.length) blocks.push(h('p', {}, inline(s, node, para.join(' '))))
      para = []
      if (list) blocks.push(list)
      list = null
    }
    for (const line of lines) {
      if (code) {
        if (line.trimStart().startsWith('```')) {
          blocks.push(h('pre', {}, code.join('\n')))
          code = null
        } else code.push(line)
        continue
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line)
      if (heading) {
        flush()
        skip = heading[1].length === 2 && heading[2].trim().toLowerCase() === 'areas'
        if (heading[1].length > 1 && !skip) blocks.push(h(heading[1].length === 2 ? 'h4' : 'h5', {}, inline(s, node, heading[2])))
        continue
      }
      if (skip) continue
      if (line.trimStart().startsWith('```')) {
        flush()
        code = []
      } else if (!line.trim()) flush()
      else if (/^Files:/.test(line.trim())) flush()
      else if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) {
        if (para.length) {
          blocks.push(h('p', {}, inline(s, node, para.join(' '))))
          para = []
        }
        list ??= h('ul', {})
        list.append(h('li', {}, inline(s, node, line.replace(/^\s*(?:[-*]|\d+\.)\s+/, ''))))
      } else if (list && /^\s{2,}\S/.test(line)) list.lastChild.append(' ', ...inline(s, node, line.trim()))
      else para.push(line.trim())
    }
    if (code) blocks.push(h('pre', {}, code.join('\n')))
    flush()
    return blocks
  }

  function inline(s, node, text) {
    return text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]*\]\([^)\s]+\))/).filter(Boolean).map(part => {
      if (part.startsWith('`') && part.endsWith('`') && part.length > 1) return h('code', {}, part.slice(1, -1))
      if (part.startsWith('**') && part.endsWith('**') && part.length > 3) return h('strong', {}, part.slice(2, -2))
      const link = /^\[([^\]]*)\]\(([^)\s]+)\)$/.exec(part)
      if (!link) return part
      const target = node.links?.[link[2]]
      if (target) return h('button', { type: 'button', class: 'mapinspector__link', onclick: () => select(s, target) }, link[1])
      if (/^https?:\/\//i.test(link[2])) return h('a', { href: link[2], target: '_blank', rel: 'noreferrer noopener' }, link[1])
      return h('span', { class: 'mapinspector__dead', title: `${link[2]} isn’t in the map` }, link[1])
    })
  }

  return { mount, refresh }
}
