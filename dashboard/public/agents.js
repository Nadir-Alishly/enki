// The Agents page and an agent's editor, as designed in the Enki canvas. Agents live in the user's
// library, for every project; enki's own open read-only, to be duplicated. The editor shows what
// enki enforces in plain words, marks every field that needs fixing, refuses an outcome change that
// would break a workflow, and starts new agents from a template. Saves go through the same guarded
// path as settings, and the server checks them with the same rules as the CLI.

const ID = /^[a-z][a-z0-9-]{0,30}$/
const OUTCOME = /^[a-z][a-z0-9-]{0,30}$/
const HEX = /^#[0-9a-fA-F]{6}$/
const SKILL = /^[a-z0-9][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$/
const WRITE = [
  ['none', 'Its report only', 'Changes nothing in the project: it reads, and writes its own report in the task folder.'],
  ['tests', 'Test files only', 'Writes only files that match the repo’s test patterns. It can’t touch the code under test.'],
  ['code', 'Code, never tests', 'Changes source, config and docs. Test files belong to another step.'],
  ['all', 'Code and tests', 'Changes source and tests alike.'],
  ['map', 'The map only', 'Writes only the task’s codebase map, in the repo’s memory. It changes no code.'],
]
const FLAGS = [
  ['blind', 'Blind', 'Sees only its brief and the spec: other steps’ reports, the plan and the code being changed are hidden from it.'],
  ['browser', 'Browser', 'Gets its own Playwright browser (or Claude in Chrome), kept to the project’s local URLs.'],
  ['server', 'Dev server', 'May start and stop the project’s dev server with enki server.'],
  ['specs', 'Writes the spec', 'Writes the spec the user approves first: what to build. A step with this leads into Spec approval, and writes nothing else.'],
  ['plans', 'Plans', 'Writes the plan the user approves after the spec. A step with this leads into Approval, and writes nothing else.'],
]
const EFFORT_WORDS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'extra high', max: 'max' }
const RULE = { none: 'writes nothing but its report', tests: 'writes test files only', code: 'writes code, never tests', all: 'writes code and tests', map: 'writes the codebase map, nothing else' }
// The DOM's own replaceChildren prints false as text; h() skips it, and so does this.
const fill = (node, ...kids) => node.replaceChildren(...kids.filter(kid => kid !== false && kid != null))
const clone = value => JSON.parse(JSON.stringify(value))
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** What an agent may do, in a phrase: "writes code, never tests, has a browser". */
export const ruleOf = caps =>
  [caps.specs ? 'writes the spec, nothing else' : caps.plans ? 'writes the plan, nothing else' : RULE[caps.write], caps.blind && 'blind: never sees the work', caps.browser && 'has a browser', caps.server && 'starts and stops the dev server'].filter(Boolean).join(', ')

export function createAgents({ h, svg, getJson, postJson, learnRoles, agentsHref, agentHref, newAgentHref, workflowHref }) {
  const stores = new Map()

  function store(project) {
    if (!stores.has(project)) stores.set(project, { project, data: null, list: h('div', { class: 'libpage' }), editors: new Map(), ui: {} })
    return stores.get(project)
  }

  const base = s => `/api/projects/${encodeURIComponent(s.project)}/agents`

  async function load(s) {
    try {
      s.data = await getJson(base(s))
      learnRoles(Object.fromEntries(s.data.agents.map(agent => [agent.id, { label: agent.name, role: agent.id, color: agent.color, pattern: agent.pattern }])))
      s.error = null
    } catch (error) {
      s.error = error.message
    }
  }

  // ---------- shared parts ----------

  const icon = {
    check: (color = 'var(--green)') => svg(18, [['path', { d: 'M3 8.5l3.2 3L13 4.5' }]], { stroke: color, width: 2 }),
    cross: () => svg(12, [['path', { d: 'M3 3l6 6M9 3l-6 6' }]], { width: 1.5, box: 12 }),
    plus: () => svg(14, [['path', { d: 'M6 1.5v9M1.5 6h9' }]], { width: 1.6, box: 12 }),
    up: () => svg(14, [['path', { d: 'M8 13V3M4 7l4-4 4 4' }]], { width: 1.6 }),
    down: () => svg(14, [['path', { d: 'M8 3v10M4 9l4 4 4-4' }]], { width: 1.6 }),
    tick: () => svg(12, [['path', { d: 'M3 8.5l3.2 3L13 4.5' }]], { stroke: 'var(--black-950)', width: 2.5 }),
  }

  /** An agent's square, in its color and pattern. */
  function swatch(color, pattern, size) {
    const fill = HEX.test(color ?? '') ? color : 'var(--border)'
    const style = { width: `${size}px`, height: `${size}px` }
    const [on, period] = [Math.max(2, size / 6), Math.max(3, size / 4)]
    if (pattern === 'stripes') style.background = `repeating-linear-gradient(135deg, ${fill} 0 ${on}px, var(--black-950) ${on}px ${period}px)`
    else if (pattern === 'cross') style.background = `repeating-linear-gradient(45deg, ${fill} 0 ${on}px, transparent ${on}px ${period}px), repeating-linear-gradient(135deg, ${fill} 0 ${on}px, var(--black-950) ${on}px ${period}px)`
    else if (pattern === 'dashed') Object.assign(style, { background: 'transparent', border: `2px dashed ${fill}` })
    else style.background = fill
    return h('span', { class: 'agentswatch', 'aria-hidden': 'true', style })
  }
  const tag = enki => h('span', { class: `tag tag--${enki ? 'enki' : 'lib'}` }, enki ? 'Enki’s own' : 'Your library')
  const modelLabel = (s, id) => s.data?.models.find(model => model.id === id)?.label ?? id
  const freeId = (s, wanted) => {
    const taken = new Set(s.data.agents.map(agent => agent.id))
    let id = wanted
    for (let n = 2; taken.has(id); n++) id = `${wanted}-${n}`
    return id
  }
  const okMessage = (text, clear) => h('div', { class: 'msgbar', role: 'status' }, icon.check(), h('span', {}, text), clear && h('button', { class: 'msgbar__x', type: 'button', 'aria-label': 'Dismiss', onClick: clear }, icon.cross()))
  const errMessage = (text, clear) => h('div', { class: 'msgbar msgbar--danger', role: 'alert' }, h('span', {}, h('strong', {}, 'Error: '), text), clear && h('button', { class: 'msgbar__x', type: 'button', 'aria-label': 'Dismiss', onClick: clear }, icon.cross()))

  async function act(s, body) {
    const result = await postJson(base(s), body)
    if (!result.ok) return { error: [result.body.error ?? 'That didn’t work.', ...(result.body.problems ?? []).map(problem => problem.message).filter(message => !(result.body.error ?? '').includes(message))].join(' ') }
    return result.body
  }

  /** Asks for the copy's ID first: prefilled with a free one, checked before it goes to the server. */
  function dupBar(s, agent, redraw, inEditor) {
    const dup = s.ui.dup
    // A bar left open in the editor shouldn't show up on the list's card, and the other way round.
    if (dup?.from !== agent.id || dup.open !== inEditor) return null
    const go = () => {
      const id = dup.id.trim()
      dup.err = !ID.test(id) ? 'Use lower-case letters, digits and dashes, starting with a letter.' : s.data.agents.some(item => item.id === id) ? 'Another agent already uses this ID.' : null
      if (dup.err) return redraw()
      s.ui.dup = null
      duplicate(s, agent, id, { open: dup.open })
    }
    const field = h('input', { id: `dup-${agent.id}`, class: 'ainput ainput--mono', type: 'text', spellcheck: 'false', value: dup.id, 'aria-invalid': String(Boolean(dup.err)) })
    field.addEventListener('input', () => {
      dup.id = field.value
      dup.err = null
      field.setAttribute('aria-invalid', 'false')
      field.closest('[role=group]')?.querySelector('.aform__err')?.remove()
    })
    field.addEventListener('keydown', event => { if (event.key === 'Enter') go(); if (event.key === 'Escape') { s.ui.dup = null; redraw() } })
    requestAnimationFrame(() => field.isConnected && document.activeElement !== field && field.focus())
    return h(
      'div',
      { class: 'aform dupbar', role: 'group', 'aria-label': `Duplicate ${agent.name}` },
      h('label', { for: field.id }, 'ID of the copy'),
      h('div', { class: 'askill__add' }, field, h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { s.ui.dup = null; redraw() } }, 'Cancel'), h('button', { class: 'btn btn--primary', type: 'button', onClick: go }, 'Duplicate')),
      h('span', { class: 'aform__help' }, 'Workflows name the agent by it, and it can’t change later.'),
      dup.err && h('span', { class: 'aform__err' }, `Error: ${dup.err}`),
    )
  }
  const askDuplicate = (s, agent, open, redraw) => {
    s.ui.dup = { from: agent.id, id: freeId(s, `${agent.id}-copy`), open }
    redraw()
  }

  async function duplicate(s, agent, newId, { open = true } = {}) {
    const done = await act(s, { action: 'copy', id: agent.id, newId })
    if (done.error) {
      s.ui.msg = { kind: 'danger', text: done.error }
      return renderList(s)
    }
    await load(s)
    s.ui.msg = { kind: 'ok', text: `Duplicated ${agent.name} into your library as “${s.data.agents.find(item => item.id === newId)?.name ?? `${agent.name} (copy)`}”.` }
    if (open) location.hash = agentHref(s.project, newId)
    else renderList(s)
  }

  // ---------- the list ----------

  function card(s, agent) {
    const enki = agent.source === 'builtin'
    return h(
      'article',
      { class: 'libcard2', 'aria-labelledby': `ag-${agent.id}` },
      h('div', { class: 'libcard2__head libcard2__head--agent' }, swatch(agent.color, agent.pattern, 18), h('h3', { id: `ag-${agent.id}` }, agent.name), tag(enki)),
      h('span', { class: 'libcard2__id' }, `${agent.id} · ${s.data.types[agent.type]?.name ?? agent.type}`),
      h('span', { class: 'libcard2__text' }, ruleOf(agent.capabilities)),
      h('ul', { class: 'libcard2__list', 'aria-label': 'Outcomes' }, agent.outcomes.map(outcome => h('li', { class: 'libcard2__out', title: outcome.description ?? '' }, outcome.id))),
      h('span', { class: 'libcard2__text' }, `Runs on ${modelLabel(s, agent.model ?? 'claude-sonnet-5-5')} · ${EFFORT_WORDS[agent.effort ?? 'high'] ?? agent.effort}`),
      h(
        'span',
        { class: 'libcard2__text' },
        agent.usedBy.length ? ['Used by ', ...agent.usedBy.flatMap((item, index) => [index ? ' ' : '', h('a', { class: 'linkbtn', href: workflowHref(s.project, item.id) }, item.name)])] : h('span', { class: 'libcard2__muted' }, 'Not used by any workflow'),
      ),
      h(
        'div',
        { class: 'libcard2__actions' },
        h('a', { class: 'btn btn--secondary btn--open', href: agentHref(s.project, agent.id), 'aria-label': `${enki ? 'Open' : 'Edit'} ${agent.name}` }, enki ? 'Open' : 'Edit'),
        h('button', { class: 'btn btn--secondary', type: 'button', 'aria-label': `Duplicate ${agent.name}`, onClick: () => askDuplicate(s, agent, false, () => renderList(s)) }, 'Duplicate'),
        h('a', { class: 'btn btn--secondary', href: `${base(s)}/export/${encodeURIComponent(agent.id)}`, download: `${agent.id}.enki-agent.json`, 'aria-label': `Export ${agent.name}`, onClick: () => { s.ui.msg = { kind: 'ok', text: `Exported ${agent.name} as ${agent.id}.enki-agent.json. Send the file to share this agent.` }; setTimeout(() => renderList(s)) } }, 'Export'),
      ),
      dupBar(s, agent, () => renderList(s), false),
    )
  }

  function importPanel(s) {
    const pending = s.ui.import
    const input = h('input', { type: 'file', accept: '.json,application/json', id: `ag-import-${s.project}` })
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      let bundle
      try {
        bundle = JSON.parse(await file.text())
      } catch {
        s.ui.msg = { kind: 'danger', text: `${file.name} isn’t a JSON file.` }
        return renderList(s)
      }
      const inspected = await act(s, { action: 'inspect', bundle })
      s.ui.import = { name: file.name, bundle, ...(inspected.error ? { problems: [inspected.error], warnings: [], agents: [] } : inspected) }
      s.ui.msg = null
      renderList(s)
    })
    const body = pending
      ? h(
          'div',
          { class: 'importbox', role: 'region', 'aria-label': `Importing ${pending.name}` },
          h('p', {}, h('strong', {}, pending.bundle?.agent?.name ?? pending.name), ` from ${pending.name}`),
          pending.problems.length > 0
            ? errMessage(['Can’t import: ', pending.problems.join(' · ')])
            : [
                h('p', { class: 'aform__help' }, 'Importing gives this agent its permissions. Check them before you confirm:'),
                h('ul', { class: 'importroles' }, pending.agents.map(agent => h('li', {}, h('strong', {}, agent.name), h('span', { class: 'mono muted' }, ` ${agent.id}`), `: ${ruleOf(agent.capabilities)}`))),
                pending.warnings.map(warning => h('p', { class: 'aform__warn' }, warning)),
              ],
          h(
            'div',
            { class: 'libcard2__actions' },
            pending.problems.length === 0 &&
              h('button', {
                class: 'btn btn--primary',
                type: 'button',
                onClick: async () => {
                  const done = await act(s, { action: 'import', bundle: pending.bundle, approve: true })
                  s.ui.import = null
                  s.ui.msg = done.error ? { kind: 'danger', text: done.error } : { kind: 'ok', text: done.text.split('\n')[0] }
                  await load(s)
                  renderList(s)
                },
              }, 'Import'),
            h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { s.ui.import = null; renderList(s) } }, 'Cancel'),
          ),
        )
      : h('div', { class: 'filepick' }, input, h('label', { for: `ag-import-${s.project}` }, 'Choose an agent file…'))
    return h('section', { class: 'libsec libsec--tight', 'aria-labelledby': 'agimp-h' }, h('div', {}, h('h2', { id: 'agimp-h' }, 'Import'), h('p', { class: 'libsec__sub' }, 'An agent someone exported. It goes into your library, never over one that’s already there.')), body)
  }

  function renderList(s) {
    if (!s.data) {
      s.list.replaceChildren(s.error ? errMessage(`the agents couldn’t be loaded: ${s.error}`) : h('p', { class: 'muted' }, 'Loading the agents…'))
      return s.list
    }
    const mine = s.data.agents.filter(agent => agent.source !== 'builtin')
    const enki = s.data.agents.filter(agent => agent.source === 'builtin')
    const clear = () => { s.ui.msg = null; renderList(s) }
    fill(s.list,
      h(
        'section',
        { class: 'libpage__top' },
        h(
          'div',
          { class: 'libpage__head' },
          h('div', { class: 'libpage__title' }, h('div', { class: 'libpage__crumbs' }, `${s.name} / Library`), h('h1', {}, 'Agents')),
          h('a', { class: 'btn btn--primary btn--add', href: newAgentHref(s.project) }, icon.plus(), 'New agent'),
        ),
        h('div', { class: 'libpage__note', role: 'note' }, 'An agent is what a workflow step runs: its instructions, what enki lets it change, and the outcomes it reports. Agents live in your library, for every project. Enki’s own are read-only: duplicate one to change it. A project gives an agent another model, effort or skills on its workflow’s steps, in the studio.'),
        s.ui.msg && (s.ui.msg.kind === 'danger' ? errMessage(s.ui.msg.text, clear) : okMessage(s.ui.msg.text, clear)),
      ),
      h(
        'section',
        { class: 'libsec', 'aria-labelledby': 'ag-all-h' },
        h('div', {}, h('h2', { id: 'ag-all-h' }, 'All agents'), h('p', { class: 'libsec__sub' }, 'Yours first, then the team enki’s own workflows use. The tag on each card says which is which.')),
        h('div', { class: 'libgrid2' }, [...mine, ...enki].map(agent => card(s, agent))),
      ),
      s.data.problems.length > 0 && errMessage(['Not loaded: ', s.data.problems.join(' · ')]),
      importPanel(s),
    )
    return s.list
  }

  // ---------- the editor ----------

  function blank(s) {
    let n = 1
    while (s.data.agents.some(agent => agent.id === `agent-${n}`)) n++
    return {
      agent: { id: `agent-${n}`, name: `New agent ${n}`, type: 'reviewer', capabilities: { write: 'none', blind: false, browser: false, server: false, specs: false, plans: false }, outcomes: [{ id: 'done', description: 'The work is finished: it goes to the next step' }, { id: 'blocked', description: 'Something stops the work: the reason is in the report' }], effort: 'high', skills: [] },
      instructions: '',
    }
  }

  function editorFor(s, id) {
    const key = id ?? '+new'
    if (!s.editors.has(key)) {
      const found = id && s.data.agents.find(agent => agent.id === id)
      const e = { key, creating: !id, root: h('div', { class: 'libpage' }), server: { problems: [], warnings: [] }, tab: 'edit', ui: {} }
      if (found) {
        // Colour and pattern come from the type: the draft keeps only what the agent saves.
        const { source, does, description, instructions, warnings, usedBy, color, pattern, ...agent } = found
        e.source = source
        e.usedBy = usedBy
        e.draft = { agent: { skills: [], ...clone(agent) }, instructions }
      } else if (!id) {
        e.draft = blank(s)
        e.source = 'library'
        e.usedBy = []
      } else e.missing = true
      e.saved = JSON.stringify(e.draft ?? null)
      s.editors.set(key, e)
      if (!e.missing && e.creating) fillTemplate(s, e)
      if (!e.missing) check(s, e)
    }
    return s.editors.get(key)
  }

  const dirty = e => JSON.stringify(e.draft) !== e.saved
  const readOnly = e => e.source === 'builtin'

  async function fillTemplate(s, e) {
    const done = await act(s, { action: 'template', agent: e.draft.agent })
    if (done.error || e.draft.instructions) return
    e.draft.instructions = done.instructions
    e.saved = JSON.stringify(e.draft)
    renderEditor(s, e)
  }

  /** What needs fixing, field by field, as the design marks it: checked here as you type. */
  function errorsOf(s, e) {
    const a = e.draft.agent
    const errs = {}
    const others = s.data.agents.filter(agent => agent.id !== (e.creating ? null : a.id))
    if (!a.name.trim()) errs.name = 'Give the agent a name.'
    else if (others.some(agent => agent.name.trim().toLowerCase() === a.name.trim().toLowerCase())) errs.name = 'Another agent already has this name.'
    if (!ID.test(a.id)) errs.id = 'Use lower-case letters, digits and dashes, starting with a letter.'
    else if (e.creating && s.data.agents.some(agent => agent.id === a.id)) errs.id = 'Another agent already uses this ID.'
    if (e.ui.timeout !== undefined && !/^\s*\d*\s*$/.test(e.ui.timeout)) errs.timeout = 'Enter whole minutes, 1 or more.'
    else if (e.ui.timeout !== undefined && e.ui.timeout.trim() && Number(e.ui.timeout) < 1) errs.timeout = 'Enter whole minutes, 1 or more.'
    if (a.capabilities.plans && a.capabilities.write !== 'none') errs.plans = 'A planning step writes only its plan. Choose “Its report only” above, or turn Plans off.'
    if (a.capabilities.specs && a.capabilities.write !== 'none') errs.specs = 'A spec step writes only its spec. Choose “Its report only” above, or turn Writes the spec off.'
    if (a.capabilities.specs && a.capabilities.plans) errs.specs = 'An agent writes the spec or the plan, not both.'
    const seen = new Set()
    a.outcomes.forEach((outcome, index) => {
      if (!OUTCOME.test(outcome.id)) errs[`o${index}`] = `Name outcome ${index + 1} with a short lower-case word, like done or needs-info.`
      else if (seen.has(outcome.id)) errs[`o${index}`] = `${outcome.id} is used twice.`
      else if (!outcome.description?.trim()) errs[`o${index}`] = `Say what ${outcome.id} means, so workflows wire it correctly.`
      seen.add(outcome.id)
    })
    if (!a.outcomes.length) errs.outs = 'Add at least one outcome.'
    if (!e.draft.instructions.trim()) errs.instructions = 'Write the agent’s instructions.'
    return errs
  }

  // Warnings that belong to a flag show under it; the rest above the choices.
  const flagWarning = (warnings, key) => warnings.find(warning => (key === 'browser' && /browser but can't start/.test(warning)) || (key === 'server' && /dev server but has no browser/.test(warning)) || (key === 'blind' && /blind but/.test(warning)))

  let timer = 0
  function change(s, e, fn, { redraw = true } = {}) {
    if (readOnly(e)) return
    fn(e.draft)
    e.ui.savedAt = null
    e.ui.showErr = false
    e.ui.msg = null
    if (redraw) renderEditor(s, e)
    else renderBar(s, e)
    clearTimeout(timer)
    timer = setTimeout(() => check(s, e), 300)
  }

  async function check(s, e) {
    if (readOnly(e)) return
    const sent = JSON.stringify(e.draft)
    const result = await act(s, { action: 'validate', agent: e.draft.agent, creating: e.creating })
    if (sent !== JSON.stringify(e.draft)) return
    e.server = result.error ? { problems: [result.error], warnings: [] } : { problems: result.problems ?? [], warnings: result.warnings ?? [] }
    renderEditor(s, e)
  }

  async function save(s, e) {
    const errs = errorsOf(s, e)
    if (Object.keys(errs).length || e.server.problems.length) {
      e.ui.showErr = true
      return renderEditor(s, e)
    }
    const done = await act(s, { action: 'save', agent: e.draft.agent, instructions: e.draft.instructions, creating: e.creating })
    if (done.error) {
      e.ui.serverErr = done.error
      return renderEditor(s, e)
    }
    e.ui.serverErr = null
    e.saved = JSON.stringify(e.draft)
    await load(s)
    if (e.creating) {
      s.editors.delete(e.key)
      s.ui.msg = { kind: 'ok', text: `Created ${e.draft.agent.name} in your library.` }
      location.hash = agentHref(s.project, e.draft.agent.id)
      return
    }
    e.ui.savedAt = clock()
    renderEditor(s, e)
  }

  async function remove(s, e) {
    const done = await act(s, { action: 'delete', id: e.draft.agent.id })
    if (done.error) {
      e.ui.confirmRemove = false
      e.ui.serverErr = done.error
      return renderEditor(s, e)
    }
    s.editors.delete(e.key)
    s.ui.msg = { kind: 'ok', text: `Removed ${e.draft.agent.name} from your library.` }
    await load(s)
    location.hash = agentsHref(s.project)
  }

  const field = (id, label, control, { help, err, warn } = {}) => h('div', { class: 'aform' }, h('label', { for: id }, label), control, help && h('span', { class: 'aform__help' }, help), err && h('span', { class: 'aform__err' }, `Error: ${err}`), warn && h('span', { class: 'aform__warn' }, `Warning: ${warn}`))
  const input = (e, { id, value, mono, err, onChange, attrs = {} }) => {
    const node = h('input', { id, class: `ainput${mono ? ' ainput--mono' : ''}`, type: 'text', value: value ?? '', readonly: readOnly(e), spellcheck: mono ? 'false' : null, 'aria-invalid': String(Boolean(err)), ...attrs })
    node.addEventListener('change', () => onChange(node.value))
    return node
  }

  function identity(s, e, errs) {
    const a = e.draft.agent
    const ro = readOnly(e)
    return h(
      'section',
      { class: 'libsec', 'aria-labelledby': 'ad-id-h' },
      h('div', {}, h('h2', { id: 'ad-id-h' }, 'Identity'), h('p', { class: 'libsec__sub' }, 'How it shows on graphs, cards and charts.')),
      h(
        'div',
        { class: 'aform__grid' },
        field('ad-name', 'Name', input(e, { id: 'ad-name', value: a.name, err: errs.name, onChange: value => change(s, e, d => { d.agent.name = value }) }), { err: errs.name }),
        field(
          'ad-idf',
          'ID',
          input(e, { id: 'ad-idf', value: a.id, mono: true, err: errs.id, onChange: value => change(s, e, d => { d.agent.id = value.trim() }), attrs: { readonly: ro || !e.creating } }),
          { help: e.creating ? 'Workflows name the agent by it. Lower-case letters, digits and dashes; it can’t change later.' : `Workflows name the agent by it.${e.usedBy.length ? ` Used by ${e.usedBy.map(item => item.name).join(', ')}.` : ''}`, err: errs.id },
        ),
      ),
      h(
        'fieldset',
        { class: 'aset' },
        h('legend', {}, 'Type'),
        h(
          'div',
          { class: 'aswatches', role: 'radiogroup', 'aria-label': 'Type' },
          Object.entries(s.data.types).map(([value, type]) =>
            h('button', { class: 'apattern', type: 'button', role: 'radio', 'aria-checked': String(a.type === value), disabled: ro, onClick: () => change(s, e, d => { d.agent.type = value }) }, swatch(type.color, type.pattern, 16), type.name),
          ),
        ),
        h('span', { class: 'aform__help' }, 'The type sets its colour and pattern on graphs and cards, and the project’s token chart counts by type.'),
      ),
    )
  }

  function enforcement(s, e, errs) {
    const a = e.draft.agent
    const caps = a.capabilities
    const ro = readOnly(e)
    const warnings = e.server.warnings.filter(warning => !/outcome has no description/.test(warning))
    const general = warnings.filter(warning => !FLAGS.some(([key]) => flagWarning([warning], key)))
    return h(
      'section',
      { class: 'libsec', 'aria-labelledby': 'ad-enf-h' },
      h('div', {}, h('h2', { id: 'ad-enf-h' }, 'What enki enforces'), h('p', { class: 'libsec__sub' }, 'Hooks hold the agent to these, whatever its instructions say.')),
      h(
        'div',
        { class: 'aform' },
        h('span', { class: 'aform__label', id: 'ad-chg-l' }, 'What it may change'),
        h(
          'div',
          { class: 'achoices', role: 'radiogroup', 'aria-labelledby': 'ad-chg-l' },
          WRITE.map(([value, label, desc]) =>
            h('button', { class: 'achoice', type: 'button', role: 'radio', 'aria-checked': String(caps.write === value), disabled: ro, onClick: () => change(s, e, d => { d.agent.capabilities.write = value }) }, h('span', { class: 'achoice__dot', 'aria-hidden': 'true' }, h('span', {})), h('span', { class: 'achoice__text' }, h('span', { class: 'achoice__label' }, label), h('span', { class: 'achoice__desc' }, desc))),
          ),
        ),
      ),
      h(
        'div',
        { class: 'aform' },
        h('span', { class: 'aform__label', id: 'ad-else-l' }, 'What else'),
        h(
          'div',
          { class: 'achoices', role: 'group', 'aria-labelledby': 'ad-else-l' },
          FLAGS.map(([key, label, desc]) => {
            const err = errs[key]
            const warn = !err && flagWarning(warnings, key)
            return h(
              'div',
              { class: 'aform' },
              h(
                'button',
                { class: `achoice${err ? ' achoice--err' : warn ? ' achoice--warn' : ''}`, type: 'button', role: 'checkbox', 'aria-checked': String(Boolean(caps[key])), disabled: ro, onClick: () => change(s, e, d => { d.agent.capabilities[key] = !d.agent.capabilities[key] }) },
                h('span', { class: 'achoice__box', 'aria-hidden': 'true' }, caps[key] && icon.tick()),
                h('span', { class: 'achoice__text' }, h('span', { class: 'achoice__label' }, label), h('span', { class: 'achoice__desc' }, desc)),
              ),
              err && h('span', { class: 'aform__err' }, `Error: ${err}`),
              warn && h('span', { class: 'aform__warn' }, `Warning: ${warn}`),
            )
          }),
        ),
      ),
      general.length > 0 && h('div', { class: 'msgbar msgbar--warn', role: 'status' }, h('span', {}, h('strong', {}, 'Warning: '), general.join(' · '))),
      h('div', { class: 'ashort' }, h('span', {}, 'In short:'), h('span', {}, `${a.name.trim() || 'This agent'} ${ruleOf(caps)}.`)),
    )
  }

  function outcomes(s, e, errs) {
    const list = e.draft.agent.outcomes
    const ro = readOnly(e)
    const row = (outcome, index) => {
      const err = errs[`o${index}`]
      const nameBad = err && (!OUTCOME.test(outcome.id) || /twice/.test(err))
      const name = input(e, { value: outcome.id, mono: true, err: nameBad, onChange: value => change(s, e, d => { d.agent.outcomes[index].id = value.trim() }), attrs: { class: 'ainput ainput--mono aout__name', 'aria-label': `Outcome ${index + 1} name` } })
      const description = input(e, { value: outcome.description ?? '', err: err && !nameBad, onChange: value => change(s, e, d => { if (value.trim()) d.agent.outcomes[index].description = value.trim(); else delete d.agent.outcomes[index].description }), attrs: { class: 'ainput aout__desc', 'aria-label': `What ${outcome.id || `outcome ${index + 1}`} means`, placeholder: 'What this outcome means and where the work goes' } })
      const move = by => change(s, e, d => { const [item] = d.agent.outcomes.splice(index, 1); d.agent.outcomes.splice(index + by, 0, item) })
      return h(
        'div',
        { class: 'aout' },
        h(
          'div',
          { class: 'aout__row' },
          name,
          description,
          !ro &&
            h(
              'span',
              { class: 'aout__tools' },
              h('button', { class: 'iconbtn', type: 'button', disabled: index === 0, 'aria-label': `Move ${outcome.id} up`, onClick: () => move(-1) }, icon.up()),
              h('button', { class: 'iconbtn', type: 'button', disabled: index === list.length - 1, 'aria-label': `Move ${outcome.id} down`, onClick: () => move(1) }, icon.down()),
              h('button', { class: 'iconbtn', type: 'button', 'aria-label': `Remove ${outcome.id}`, onClick: () => change(s, e, d => { d.agent.outcomes.splice(index, 1) }) }, icon.cross()),
            ),
        ),
        err && h('span', { class: 'aform__err' }, `Error: ${err}`),
      )
    }
    return h(
      'section',
      { class: 'libsec libsec--tight', 'aria-labelledby': 'ad-out-h' },
      h('div', {}, h('h2', { id: 'ad-out-h' }, 'Outcomes'), h('p', { class: 'libsec__sub' }, 'What it reports when it finishes. Workflows wire each outcome to the next step; one left unwired goes back to the orchestrator.')),
      h('div', { class: 'aouts' }, list.map(row), errs.outs && h('span', { class: 'aform__err' }, `Error: ${errs.outs}`)),
      !ro && h('button', { class: 'addrow', type: 'button', onClick: () => change(s, e, d => { d.agent.outcomes.push({ id: '' }) }) }, icon.plus(), 'Add an outcome'),
    )
  }

  function defaults(s, e, errs) {
    const a = e.draft.agent
    const ro = readOnly(e)
    const model = h('select', { id: 'ad-model', class: 'ainput select', disabled: ro }, h('option', { value: '' }, 'Enki’s default (Sonnet 5.5)'), s.data.models.map(item => h('option', { value: item.id, selected: item.id === a.model }, item.label ?? item.id)), a.model && !s.data.models.some(item => item.id === a.model) && h('option', { value: a.model, selected: true }, a.model))
    model.addEventListener('change', () => change(s, e, d => { if (model.value) d.agent.model = model.value; else delete d.agent.model }))
    const effort = h('select', { id: 'ad-effort', class: 'ainput select', disabled: ro }, h('option', { value: '' }, 'High (enki’s default)'), s.data.efforts.map(item => h('option', { value: item, selected: item === a.effort }, (EFFORT_WORDS[item] ?? item).replace(/^./, c => c.toUpperCase()))))
    effort.addEventListener('change', () => change(s, e, d => { if (effort.value) d.agent.effort = effort.value; else delete d.agent.effort }))
    const minutes = e.ui.timeout ?? (a.timeout ? String(Math.round(a.timeout / 60000)) : '')
    const timeout = input(e, {
      id: 'ad-to',
      value: minutes,
      err: errs.timeout,
      onChange: value => {
        e.ui.timeout = value
        change(s, e, d => { const n = Number(value); if (value.trim() && Number.isInteger(n) && n >= 1) d.agent.timeout = n * 60000; else delete d.agent.timeout })
      },
      attrs: { inputmode: 'numeric', placeholder: '30', style: { width: '100px' } },
    })
    const skills = a.skills ?? []
    const typed = (e.ui.skillIn ?? '').trim().toLowerCase()
    const suggestions = typed ? (s.data.skills ?? []).map(skill => skill.name).filter(name => name.toLowerCase().includes(typed) && !skills.includes(name)).slice(0, 6) : []
    const addSkill = value => {
      const name = (value ?? e.ui.skillIn ?? '').trim()
      if (!name) e.ui.skillErr = 'Type a skill name first.'
      else if (!SKILL.test(name)) e.ui.skillErr = 'Use a skill name like design:ux-copy (lower-case letters, digits and dashes).'
      else if (skills.includes(name)) e.ui.skillErr = `${name} is already added.`
      else {
        e.ui.skillIn = ''
        e.ui.skillErr = null
        return change(s, e, d => { d.agent.skills = [...(d.agent.skills ?? []), name] })
      }
      renderEditor(s, e)
    }
    const skillIn = h('input', { id: 'ad-skill', class: 'ainput ainput--mono', type: 'text', spellcheck: 'false', placeholder: 'Add a skill, e.g. design:ux-copy', value: e.ui.skillIn ?? '', 'aria-invalid': String(Boolean(e.ui.skillErr)), style: { flex: '1 1 auto', width: 'auto' } })
    skillIn.addEventListener('input', () => {
      e.ui.skillIn = skillIn.value
      e.ui.skillErr = null
      renderEditor(s, e)
      const again = document.getElementById('ad-skill')
      again?.focus()
      again?.setSelectionRange(again.value.length, again.value.length)
    })
    skillIn.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); addSkill() } })
    return h(
      'section',
      { class: 'libsec', 'aria-labelledby': 'ad-def-h' },
      h('div', {}, h('h2', { id: 'ad-def-h' }, 'Defaults'), h('p', { class: 'libsec__sub' }, 'What it runs on unless a workflow’s step says otherwise.')),
      h(
        'div',
        { class: 'aform__grid aform__grid--3' },
        field('ad-model', 'Model', model),
        field('ad-effort', 'Effort', effort),
        h('div', { class: 'aform' }, h('label', { for: 'ad-to' }, 'Timeout'), h('div', { class: 'askill__add', style: { alignItems: 'center' } }, timeout, h('span', { class: 'libcard2__muted' }, 'min')), h('span', { class: 'aform__help' }, 'How long one visit may take before enki hands it back.'), errs.timeout && h('span', { class: 'aform__err' }, `Error: ${errs.timeout}`)),
      ),
      h(
        'div',
        { class: 'aform' },
        h('label', { for: 'ad-skill' }, 'Skills'),
        h('div', { class: 'askills' }, skills.length ? skills.map(name => h('span', { class: `askill${ro ? '' : ' askill--x'}` }, name, !ro && h('button', { type: 'button', 'aria-label': `Remove skill ${name}`, onClick: () => change(s, e, d => { d.agent.skills = d.agent.skills.filter(item => item !== name) }) }, icon.cross()))) : h('span', { class: 'aform__help', style: { fontSize: '13px' } }, 'None: it loads only what its instructions need.')),
        !ro && h('div', { class: 'askill__add' }, skillIn, h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => addSkill() }, 'Add')),
        !ro && suggestions.length > 0 && h('div', { class: 'askills', role: 'listbox', 'aria-label': 'Installed skills' }, suggestions.map(name => h('button', { class: 'asuggest', type: 'button', role: 'option', onClick: () => addSkill(name) }, `+ ${name}`))),
        h('span', { class: 'aform__help' }, 'Loaded into the agent’s instructions when it starts. Installed skills are suggested as you type.'),
        e.ui.skillErr && h('span', { class: 'aform__err' }, `Error: ${e.ui.skillErr}`),
      ),
    )
  }

  /** The preview: front matter as a table, then headings, list items and paragraphs, as text only. */
  function preview(e) {
    const lines = e.draft.instructions.split('\n')
    const front = []
    let i = 0
    if (lines[0] === '---') {
      for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
        const match = /^([^:]+):\s*(.*)$/.exec(lines[i])
        if (match) front.push([match[1], match[2]])
      }
      i++
    }
    const inline = text => text.split(/(`[^`]+`|\*\*[^*]+\*\*)/).map(part => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? h('code', {}, part.slice(1, -1)) : part.startsWith('**') && part.endsWith('**') && part.length > 3 ? h('strong', {}, part.slice(2, -2)) : part))
    const blocks = []
    let code = null
    for (; i < lines.length; i++) {
      const line = lines[i]
      if (line.startsWith('```')) {
        if (code) blocks.push(h('pre', {}, code.join('\n')))
        code = code ? null : []
        continue
      }
      if (code) {
        code.push(line)
        continue
      }
      if (!line.trim()) continue
      if (/^#{2,}\s/.test(line)) blocks.push(h('h4', {}, inline(line.replace(/^#+\s+/, ''))))
      else if (/^#\s/.test(line)) blocks.push(h('h3', {}, inline(line.slice(2))))
      else if (/^\s*(?:[-*]|\d+\.)\s/.test(line)) blocks.push(h('div', { class: 'apreview__li' }, h('span', { 'aria-hidden': 'true' }, '•'), h('span', {}, inline(line.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')))))
      else blocks.push(h('p', {}, inline(line)))
    }
    const outs = e.draft.agent.outcomes.map(outcome => outcome.id).filter(Boolean).join(', ') || 'none yet'
    return h('div', { class: 'apreview' }, front.length > 0 && h('dl', {}, front.flatMap(([key, value]) => [h('dt', {}, key), h('dd', {}, value)])), blocks, h('div', { class: 'apreview__foot' }, `Added by enki to every brief — outcomes: ${outs}`))
  }

  function instructions(s, e, errs) {
    const ro = readOnly(e)
    const area = h('textarea', { id: 'ad-instr', class: 'amd', rows: 18, spellcheck: 'false', readonly: ro }, e.draft.instructions)
    area.addEventListener('input', () => change(s, e, d => { d.instructions = area.value }, { redraw: false }))
    const words = e.draft.instructions.trim() ? e.draft.instructions.trim().split(/\s+/).length : 0
    const tab = (id, label) => h('button', { class: 'atab', type: 'button', role: 'tab', 'aria-selected': String(e.tab === id), onClick: () => { e.tab = id; renderEditor(s, e) } }, label)
    return h(
      'section',
      { class: 'libsec libsec--tight', 'aria-labelledby': 'ad-ins-h' },
      h('div', {}, h('h2', { id: 'ad-ins-h' }, 'Instructions'), h('p', { class: 'libsec__sub' }, 'AGENT.md: what the agent is told at the start of every task, along with the task rules. Enki adds the outcomes to every brief.')),
      h('div', { class: 'atabs', role: 'tablist', 'aria-label': 'Instructions view' }, tab('edit', ro ? 'Source' : 'Edit'), tab('preview', 'Preview')),
      e.tab === 'edit'
        ? h('div', { class: 'aform' }, h('label', { for: 'ad-instr', class: 'sr-only' }, 'AGENT.md'), area, h('span', { class: 'aform__help' }, `${words} words · Markdown, with name and description at the top between --- lines.`), errs.instructions && h('span', { class: 'aform__err' }, `Error: ${errs.instructions}`))
        : preview(e),
    )
  }

  /** The save bar: what's unsaved, and how many fields need fixing. */
  function renderBar(s, e) {
    if (!e.bar || readOnly(e)) return
    const errs = errorsOf(s, e)
    const n = Object.keys(errs).length || e.server.problems.length
    const changed = dirty(e) || e.creating || n > 0
    const text = changed ? `${e.creating ? 'Not created yet' : 'Unsaved changes'}${n ? ` · ${n} ${n === 1 ? 'field needs' : 'fields need'} fixing` : ''}` : e.ui.savedAt ? 'All changes saved' : 'No unsaved changes'
    e.bar.replaceChildren(
      h('span', { class: `asavebar__text${changed && n ? ' asavebar__text--bad' : changed ? ' asavebar__text--dirty' : ''}`, 'aria-live': 'polite' }, text),
      h(
        'div',
        {},
        !e.creating && h('button', { class: 'btn btn--secondary', type: 'button', disabled: !dirty(e), onClick: () => { e.draft = JSON.parse(e.saved); e.ui = {}; renderEditor(s, e); check(s, e) } }, 'Discard changes'),
        h('button', { class: 'btn btn--primary', type: 'button', disabled: !changed, onClick: () => save(s, e) }, e.creating ? 'Create agent' : 'Save agent'),
      ),
    )
  }

  function renderEditor(s, e) {
    if (e.missing) {
      e.root.replaceChildren(errMessage(['there is no agent "', e.key, '". ', h('a', { class: 'linkbtn', href: agentsHref(s.project) }, 'Back to the agents')]))
      return e.root
    }
    const ro = readOnly(e)
    const a = e.draft.agent
    const errs = errorsOf(s, e)
    const n = Object.keys(errs).length || e.server.problems.length
    const savedId = JSON.parse(e.saved)?.agent?.id ?? a.id
    const focus = document.activeElement?.id
    e.bar = h('div', { class: 'asavebar' })
    fill(e.root,
      h(
        'section',
        { class: 'libpage__top' },
        h('div', { class: 'libpage__crumbs' }, h('a', { class: 'linkbtn', href: agentsHref(s.project), style: { padding: 0 } }, 'Agents'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', {}, e.creating ? 'New agent' : savedId)),
        h(
          'div',
          { class: 'libpage__head libpage__head--start' },
          h('div', { class: 'libpage__title' }, h('div', { class: 'libpage__name' }, swatch(s.data.types[a.type]?.color, s.data.types[a.type]?.pattern, 32), h('h1', {}, a.name.trim() || 'Unnamed agent')), tag(ro)),
          !e.creating &&
            h(
              'div',
              { class: 'libpage__actions' },
              h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { if (dirty(e)) { e.ui.msg = 'Save or discard your changes first, then duplicate.'; return renderEditor(s, e) } askDuplicate(s, { ...a, id: savedId }, true, () => renderEditor(s, e)) } }, 'Duplicate'),
              h('a', { class: 'btn btn--secondary', href: `${base(s)}/export/${encodeURIComponent(savedId)}`, download: `${savedId}.enki-agent.json`, onClick: () => { e.ui.msg = `Exported ${a.name} as ${savedId}.enki-agent.json${dirty(e) ? ' (the saved version, without your unsaved changes).' : '.'}`; setTimeout(() => renderEditor(s, e)) } }, 'Export'),
              !ro && h('button', { class: 'btn btn--secondary btn--outline-danger', type: 'button', onClick: () => { e.ui.confirmRemove = true; renderEditor(s, e) } }, 'Remove'),
            ),
        ),
        !ro && e.ui.confirmRemove &&
          h(
            'div',
            { class: 'confirmbar', role: 'alert' },
            h('span', {}, h('strong', {}, `Remove ${a.name}?`), ' ', e.usedBy.length ? `Workflows use it (${e.usedBy.map(item => item.name).join(', ')}): take it out of them first.` : 'No workflow uses it. This can’t be undone.'),
            h('span', {}, h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { e.ui.confirmRemove = false; renderEditor(s, e) } }, 'Keep it'), h('button', { class: 'btn btn--fill-danger', type: 'button', disabled: e.usedBy.length > 0, onClick: () => remove(s, e) }, 'Remove agent')),
          ),
        ro && h('div', { class: 'ronote', role: 'note' }, h('span', {}, h('strong', {}, 'Enki’s own agent.'), ' You can read it, but not change it. Duplicate it to make your own.'), h('button', { class: 'btn btn--primary', type: 'button', onClick: () => askDuplicate(s, a, true, () => renderEditor(s, e)) }, 'Duplicate and edit')),
        dupBar(s, { ...a, id: savedId }, () => renderEditor(s, e), true),
        e.ui.msg && h('div', { class: 'msgbar msgbar--info', role: 'status' }, h('span', {}, e.ui.msg)),
        e.ui.savedAt && !dirty(e) && h('div', { class: 'msgbar msgbar--ok', role: 'status' }, icon.check(), h('span', {}, h('strong', {}, 'Saved'), ` at ${e.ui.savedAt}. Steps that run this agent use it from the next task.`)),
        e.ui.serverErr && errMessage(e.ui.serverErr),
        !ro && e.server.problems.length > 0 && h('div', { class: 'msgbar msgbar--danger', role: 'alert' }, h('div', {}, h('strong', {}, 'Can’t save: '), h('ul', {}, e.server.problems.map(problem => h('li', {}, problem))))),
        !ro && e.ui.showErr && n > 0 && errMessage(`${n} ${n === 1 ? 'thing needs' : 'things need'} fixing before you can save. Each one is marked below.`),
      ),
      identity(s, e, errs),
      enforcement(s, e, errs),
      outcomes(s, e, errs),
      defaults(s, e, errs),
      instructions(s, e, errs),
      !ro && e.bar,
    )
    renderBar(s, e)
    if (focus) document.getElementById(focus)?.focus()
    return e.root
  }

  return {
    /** The list, or one agent's editor: `id` is an agent's id, '+new' for a new one, or null for the list. */
    mount(project, id = null, name = project) {
      const s = store(project)
      s.name = name
      const ready = () => {
        if (id === null) return renderList(s)
        const e = editorFor(s, id === '+new' ? null : id)
        return e.root.childElementCount ? e.root : renderEditor(s, e)
      }
      if (!s.data) {
        const holder = id === null ? s.list : h('div', { class: 'libpage' }, h('p', { class: 'muted' }, 'Loading the agent…'))
        if (id === null) renderList(s)
        if (!s.loading) {
          s.loading = true
          load(s).then(() => {
            s.loading = false
            const node = ready()
            if (holder !== node && holder.isConnected) holder.replaceWith(node)
          })
        }
        return holder
      }
      return ready()
    },
    refresh(project) {
      const s = stores.get(project)
      if (s) load(s).then(() => renderList(s))
    },
  }
}
