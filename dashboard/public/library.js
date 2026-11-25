// The Workflows page, as designed in the Enki canvas: every workflow the project can use, each with
// its steps, whether it can run here, and duplicate, export and open; the project's default is marked,
// and any other can be made the default. Importing shows what each new agent may do, and saves only
// when the person confirms it here.

const ID = /^[a-z][a-z0-9-]{0,30}$/
const WRITE_WORDS = { none: 'writes nothing but its report', tests: 'writes test files only', code: 'writes code, never tests', all: 'writes code and tests', map: 'writes the codebase map, nothing else' }
const capabilityText = caps =>
  [caps.specs ? 'writes the spec, nothing else' : caps.plans ? 'writes the plan, nothing else' : WRITE_WORDS[caps.write], caps.blind && 'blind', caps.browser && 'has a browser', caps.server && 'starts the dev server'].filter(Boolean).join(', ')

/** The name the server gives a copy: "Full (copy)", or "Full (copy 2)" when that is taken. */
const copyName = (name, taken) => {
  const names = new Set(taken.map(item => item.trim().toLowerCase()))
  let candidate = `${name} (copy)`
  for (let n = 2; names.has(candidate.toLowerCase()); n++) candidate = `${name} (copy ${n})`
  return candidate
}

export function createLibrary({ h, getJson, postJson, learnRoles, roleOf, editHref, svg }) {
  const stores = new Map()

  function store(id) {
    if (!stores.has(id)) stores.set(id, { id, root: h('div', { class: 'libpage' }), data: null, ui: {} })
    return stores.get(id)
  }

  const base = s => `/api/projects/${encodeURIComponent(s.id)}/library`

  async function load(s) {
    try {
      s.data = await getJson(base(s))
      learnRoles(Object.fromEntries(s.data.roles.map(role => [role.id, { label: role.name, role: role.id, color: role.color, pattern: role.pattern }])))
      s.error = null
    } catch (error) {
      s.error = error.message
    }
    render(s)
  }

  const check = () => svg(18, [['path', { d: 'M3 8.5l3.2 3L13 4.5' }]], { stroke: 'var(--green)', width: 2 })
  const cross = () => svg(12, [['path', { d: 'M3 3l6 6M9 3l-6 6' }]], { width: 1.5, box: 12 })
  const tag = (label, kind) => h('span', { class: `tag tag--${kind}` }, label)

  function message(s) {
    const { notice } = s.ui
    if (!notice) return null
    if (notice.kind === 'danger') return h('div', { class: 'msgbar msgbar--danger', role: 'alert' }, h('span', {}, h('strong', {}, 'Error: '), notice.text), h('button', { class: 'msgbar__x', type: 'button', 'aria-label': 'Dismiss', onClick: () => { s.ui.notice = null; render(s) } }, cross()))
    return h('div', { class: 'msgbar', role: 'status' }, check(), h('span', {}, notice.text), h('button', { class: 'msgbar__x', type: 'button', 'aria-label': 'Dismiss', onClick: () => { s.ui.notice = null; render(s) } }, cross()))
  }

  async function act(s, body, done) {
    const result = await postJson(base(s), body)
    if (result.ok) {
      s.ui.notice = done(result.body) ?? null
      await load(s)
    } else {
      s.ui.notice = { kind: 'danger', text: [result.body.error ?? 'That didn’t work.', ...(result.body.problems ?? []).map(problem => problem.message)].join(' ') }
      render(s)
    }
  }

  /** A free id for a copy: full-copy, full-copy-2… */
  const freeId = (s, id) => {
    const taken = new Set(s.data.workflows.map(workflow => workflow.id))
    let newId = `${id}-copy`
    for (let n = 2; taken.has(newId); n++) newId = `${id}-copy-${n}`
    return newId
  }

  /** Asks for the copy's ID first: prefilled with a free one, checked before it goes to the server. */
  function dupField(s, item) {
    const dup = s.ui.dup
    if (dup?.from !== item.id) return null
    const go = () => {
      const id = dup.id.trim()
      dup.err = !ID.test(id) ? 'Use lower-case letters, digits and dashes, starting with a letter.' : s.data.workflows.some(workflow => workflow.id === id) ? 'Another workflow already uses this ID.' : null
      if (dup.err) return render(s)
      s.ui.dup = null
      duplicate(s, item, id)
    }
    const field = h('input', { id: `wfdup-${item.id}`, class: 'ainput ainput--mono', type: 'text', spellcheck: 'false', value: dup.id, 'aria-invalid': String(Boolean(dup.err)) })
    field.addEventListener('input', () => {
      dup.id = field.value
      dup.err = null
      field.setAttribute('aria-invalid', 'false')
      field.closest('[role=group]')?.querySelector('.aform__err')?.remove()
    })
    field.addEventListener('keydown', event => { if (event.key === 'Enter') go(); if (event.key === 'Escape') { s.ui.dup = null; render(s) } })
    requestAnimationFrame(() => field.isConnected && document.activeElement !== field && field.focus())
    return h(
      'div',
      { class: 'aform dupbar', role: 'group', 'aria-label': `Duplicate ${item.name}` },
      h('label', { for: field.id }, 'ID of the copy'),
      h('div', { class: 'askill__add' }, field, h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { s.ui.dup = null; render(s) } }, 'Cancel'), h('button', { class: 'btn btn--primary', type: 'button', onClick: go }, 'Duplicate')),
      h('span', { class: 'aform__help' }, 'Projects and tasks name the workflow by it.'),
      dup.err && h('span', { class: 'aform__err' }, `Error: ${dup.err}`),
    )
  }

  /** A copy in the library under the id given. */
  function duplicate(s, item, newId) {
    act(s, { action: 'copy', id: item.id, newId, to: 'library' }, () => ({ kind: 'success', text: `Duplicated ${item.name} into your library as “${copyName(item.name, s.data.workflows.map(x => x.name))}”.` }))
  }

  /** A step's chip: the agent's square, then the step (and its agent, when they differ); Tests dashed. */
  function stepChip(node) {
    if (node.kind === 'verify') return h('li', { class: 'stepchip stepchip--builtin' }, node.id)
    const look = roleOf(node.agent)
    const fill = look.pattern === 'dashed' ? 'transparent' : look.fill
    return h('li', { class: 'stepchip' }, h('span', { 'aria-hidden': 'true', class: 'agentswatch', style: { width: '10px', height: '10px', background: fill, border: look.pattern === 'dashed' ? `1.5px dashed ${look.line}` : '0' } }), node.id === node.agent ? node.id : `${node.id} (${node.agent})`)
  }

  function workflowCard(s, item) {
    const workflow = item.workflow
    const own = item.source !== 'builtin'
    const isDefault = s.data.current === item.id
    const cant = item.problems.length > 0
    const warnings = item.warnings ?? []
    return h(
      'article',
      { class: `libcard2 libcard2--wf${isDefault ? ' libcard2--default' : ''}`, 'aria-labelledby': `wf-${item.id}` },
      h(
        'div',
        { class: 'libcard2__head' },
        h('h3', { id: `wf-${item.id}` }, item.name),
        h('span', { class: 'libcard2__tags' }, tag(own ? (item.source === 'project' ? 'This project' : 'Your library') : 'Enki', own ? (item.source === 'project' ? 'project' : 'lib') : 'enki'), isDefault && tag('Default here', 'default')),
      ),
      item.description && h('p', { class: 'libcard2__text' }, item.description),
      h('ul', { class: 'libcard2__list', 'aria-label': 'Steps' }, workflow.nodes.filter(node => !node.kind || node.kind === 'verify').map(stepChip)),
      cant
        ? h('details', { class: 'libcard__problems' }, h('summary', {}, `Can’t run: ${item.problems.length} problem${item.problems.length === 1 ? '' : 's'}`), h('ul', {}, item.problems.map(problem => h('li', {}, problem))))
        : h('span', { class: `libcard2__run${warnings.length ? ' libcard2__run--bad' : ''}` }, warnings.length ? `Can run, with ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : 'Can run'),
      !cant && warnings.length > 0 && h('details', { class: 'libcard__warnings' }, h('summary', {}, 'What to know'), h('ul', {}, warnings.map(warning => h('li', {}, warning)))),
      h(
        'div',
        { class: 'libcard2__actions' },
        h('button', { class: 'btn btn--secondary', type: 'button', 'aria-label': `Duplicate ${item.name}`, onClick: () => { s.ui.dup = { from: item.id, id: freeId(s, item.id) }; render(s) } }, 'Duplicate'),
        h('a', { class: 'btn btn--secondary', href: `${base(s)}/export/${encodeURIComponent(item.id)}`, download: `${item.id}.enki-workflow.json`, 'aria-label': `Export ${item.name}`, onClick: () => { s.ui.notice = { kind: 'success', text: `Exported ${item.name} as ${item.id}.enki-workflow.json. Send the file to share this workflow.` }; setTimeout(() => render(s)) } }, 'Export'),
        h('a', { class: 'btn btn--secondary btn--open', href: editHref(s.id, item.id), 'aria-label': `${own ? 'Edit' : 'Open'} ${item.name}` }, own ? 'Edit' : 'Open'),
        !isDefault && !cant && h('button', { class: 'linkbtn linkbtn--quiet', type: 'button', onClick: () => act(s, { action: 'use', id: item.id }, () => ({ kind: 'success', text: `${item.name} is now the default workflow for ${s.name}. New tasks here will use it.` })) }, 'Make default here'),
      ),
      dupField(s, item),
    )
  }

  function importPanel(s) {
    const pending = s.ui.import
    const input = h('input', { type: 'file', accept: '.json,application/json', id: `wf-import-${s.id}` })
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      let bundle
      try {
        bundle = JSON.parse(await file.text())
      } catch {
        s.ui.notice = { kind: 'danger', text: `${file.name} isn’t a JSON file.` }
        return render(s)
      }
      const to = 'library'
      const result = await postJson(base(s), { action: 'inspect', bundle, to })
      s.ui.import = { name: file.name, bundle, to, ...(result.ok ? result.body : { problems: [result.body.error], warnings: [], agents: [] }) }
      s.ui.notice = null
      render(s)
    })
    const body = pending
      ? h(
          'div',
          { class: 'importbox', role: 'region', 'aria-label': `Importing ${pending.name}` },
          h('p', {}, h('strong', {}, pending.bundle?.workflow?.name ?? pending.name), ` from ${pending.name}`),
          pending.problems.length > 0
            ? h('div', { class: 'msgbar msgbar--danger', role: 'alert' }, h('span', {}, h('strong', {}, 'Can’t import: '), pending.problems.join(' · ')))
            : [
                h('p', { class: 'aform__help' }, pending.agents.length ? 'Importing adds these agents to your library, with their permissions. Check them before you confirm:' : 'It uses only enki’s own agents, so it grants nothing new.'),
                pending.agents.length > 0 && h('ul', { class: 'importroles' }, pending.agents.map(agent => h('li', {}, h('strong', {}, agent.name), h('span', { class: 'mono muted' }, ` ${agent.id}`), ': ', capabilityText(agent.capabilities)))),
                pending.warnings.map(warning => h('p', { class: 'aform__warn' }, warning)),
              ],
          h(
            'div',
            { class: 'libcard2__actions' },
            pending.problems.length === 0 &&
              h('button', { class: 'btn btn--primary', type: 'button', onClick: () => act(s, { action: 'import', bundle: pending.bundle, to: pending.to, approve: true }, result => { s.ui.import = null; return { kind: 'success', text: result.text.split('\n')[0] } }) }, 'Import'),
            h('button', { class: 'btn btn--secondary', type: 'button', onClick: () => { s.ui.import = null; render(s) } }, 'Cancel'),
          ),
        )
      : h('div', { class: 'filepick' }, input, h('label', { for: `wf-import-${s.id}` }, 'Choose a workflow file…'))
    return h('section', { class: 'libsec libsec--tight', 'aria-labelledby': 'imp-h' }, h('div', {}, h('h2', { id: 'imp-h' }, 'Import'), h('p', { class: 'libsec__sub' }, 'A workflow someone exported, with its own agents. It goes into your library, never over something that’s already there.')), body)
  }

  function render(s) {
    if (!s.data) {
      s.root.replaceChildren(s.error ? h('div', { class: 'msgbar msgbar--danger', role: 'alert' }, h('span', {}, h('strong', {}, 'Error: '), `the workflows couldn’t be loaded: ${s.error}`)) : h('p', { class: 'muted' }, 'Loading the workflows…'))
      return
    }
    const focus = document.activeElement?.id
    s.root.replaceChildren(
      h(
        'section',
        { class: 'libpage__top' },
        h('div', { class: 'libpage__crumbs' }, `${s.name} / Library`),
        h('h1', {}, 'Workflows'),
        h('div', { class: 'libpage__note', role: 'note' }, 'Enki’s own workflows can’t be changed: open one to look, and duplicate it to make it yours. Your library is on this computer, for every project; this project’s own are in its .enki folder. Export a workflow to share it.'),
        message(s),
      ),
      h('section', { class: 'libsec', 'aria-labelledby': 'wfl-h' }, h('div', {}, h('h2', { id: 'wfl-h' }, 'Workflows'), h('p', { class: 'libsec__sub' }, 'Each runs a team: its steps, and where each outcome sends the work.')), h('div', { class: 'libgrid2' }, s.data.workflows.map(item => workflowCard(s, item)))),
      importPanel(s),
    )
    if (focus) document.getElementById(focus)?.focus()
  }

  return {
    mount(id, name) {
      const s = store(id)
      s.name = name ?? id
      if (!s.data && !s.loading) {
        s.loading = true
        load(s).finally(() => (s.loading = false))
      }
      render(s)
      return s.root
    },
    refresh(id) {
      if (stores.has(id)) load(stores.get(id))
    },
  }
}
