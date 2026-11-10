// The settings page: the dashboard's only form. Each project's draft lives here until it's saved
// or the browser page is reloaded. The form is built once per load and then updated in place, so
// live updates and re-renders never wipe what you're typing.

const ROLES = ['scout', 'coder', 'tester', 'qa', 'reviewer']
const EFFORT_LABELS = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max' }
const DRIVER_LABELS = { playwright: 'Playwright', chrome: 'Claude in Chrome', none: 'None' }
const TIMEOUTS = [['scout', 'Scout'], ['baseline', 'Baseline'], ['coder', 'Coder'], ['tests', 'Tests'], ['tester', 'Tester'], ['qa', 'QA'], ['verify', 'Verify'], ['reviewer', 'Reviewer'], ['server', 'Server start']]
const DATABASE_HELP = { copy: 'New plans get their own copy of the database.', shared: 'New plans use the shared database.', none: 'New plans run without a database.' }
// The same rules as the server's, so most mistakes show before saving.
const SKILL_NAME = /^[A-Za-z0-9][\w.-]*(:[A-Za-z0-9][\w.-]*)?$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const PLACEHOLDER = /\{(task|port(:[\w./-]+)?)\}/
const WHOLE = /^\s*\d+\s*$/
const DECIMAL = /^\s*\d+(\.\d+)?\s*$/

const clone = value => JSON.parse(JSON.stringify(value))
const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

/** The form's copy of the values: numbers stay the text typed into their inputs. */
function toDraft(values) {
  return {
    team: clone(values.team),
    maxFixRounds: String(values.maxFixRounds),
    mode: values.mode,
    worktrees: values.worktrees,
    timeouts: Object.fromEntries(Object.entries(values.timeouts).map(([key, value]) => [key, String(value)])),
    driver: values.browser.driver,
    headless: values.browser.headless,
    portFrom: String(values.ports.from),
    portTo: String(values.ports.to),
    db: {
      enabled: values.database.enabled,
      default: values.database.default,
      copy: values.database.copy,
      drop: values.database.drop,
      env: values.database.env.map(([name, value]) => ({ name, value })),
    },
  }
}

const asNumber = (text, pattern) => (pattern.test(text) ? Number(text) : text.trim())
const envPairs = env => env.map(item => [item.name.trim(), item.value])

/** Every field that differs from the saved copy, in the server's units. */
function changesOf(draft, saved) {
  const changes = {}
  const diff = (path, now, before, value = now) => {
    if (JSON.stringify(now) !== JSON.stringify(before)) changes[path] = value
  }
  for (const role of ROLES) {
    for (const key of ['model', 'effort', 'skills']) diff(`team.${role}.${key}`, draft.team[role][key], saved.team[role][key])
  }
  diff('maxFixRounds', asNumber(draft.maxFixRounds, WHOLE), Number(saved.maxFixRounds))
  diff('mode', draft.mode, saved.mode)
  diff('worktrees', draft.worktrees, saved.worktrees)
  for (const [key] of TIMEOUTS) diff(`timeouts.${key}`, asNumber(draft.timeouts[key], DECIMAL), Number(saved.timeouts[key]))
  diff('browser.driver', draft.driver, saved.driver)
  diff('browser.headless', draft.headless, saved.headless)
  diff('ports.from', asNumber(draft.portFrom, WHOLE), Number(saved.portFrom))
  diff('ports.to', asNumber(draft.portTo, WHOLE), Number(saved.portTo))
  diff('database.enabled', draft.db.enabled, saved.db.enabled)
  diff('database.default', draft.db.default, saved.db.default)
  diff('database.copy', draft.db.copy.trim(), saved.db.copy.trim())
  diff('database.drop', draft.db.drop.trim(), saved.db.drop.trim())
  diff('database.env', envPairs(draft.db.env), envPairs(saved.db.env))
  return changes
}

/** Problems keyed by field. Database rules apply only when this save touches them, as on the server. */
/** The effort levels a model offers: null when the catalog doesn't say, so any level goes. */
const effortsOf = (catalog, id) => catalog.models.find(model => model.id === id)?.efforts ?? null

function problemsOf(draft, changes, catalog) {
  const errs = {}
  for (const role of ROLES) {
    const { model, effort } = draft.team[role]
    const levels = effortsOf(catalog, model)
    const touched = `team.${role}.model` in changes || `team.${role}.effort` in changes
    if (touched && levels?.length && !levels.includes(effort)) {
      const label = catalog.models.find(item => item.id === model)?.label ?? model
      errs[`team.${role}.effort`] = `${label} doesn’t offer ${EFFORT_LABELS[effort] ?? effort} effort. Choose another level.`
    }
  }
  if (!WHOLE.test(draft.maxFixRounds)) errs.maxFixRounds = 'Enter a whole number, 0 or more.'
  for (const [key] of TIMEOUTS) {
    const text = draft.timeouts[key]
    if (!DECIMAL.test(text) || Number(text) <= 0) errs[`timeouts.${key}`] = 'Enter minutes, more than 0.'
  }
  const port = text => WHOLE.test(text) && Number(text) >= 1024 && Number(text) <= 65535
  if (!port(draft.portFrom)) errs['ports.from'] = 'Enter a whole number between 1024 and 65535.'
  if (!port(draft.portTo)) errs['ports.to'] = 'Enter a whole number between 1024 and 65535.'
  else if (port(draft.portFrom) && Number(draft.portTo) < Number(draft.portFrom)) errs['ports.to'] = 'To can’t be lower than From.'
  const touched = ['database.enabled', 'database.copy', 'database.drop'].some(path => path in changes)
  if (touched && draft.db.enabled) {
    for (const field of ['copy', 'drop']) {
      const command = draft.db[field].trim()
      if (!command) errs[`database.${field}`] = `Enter a ${field} command, or turn database copying off.`
      else if (!PLACEHOLDER.test(command)) errs[`database.${field}`] = 'Include {task} or {port}, so each task gets its own database.'
    }
  }
  if ('database.env' in changes) {
    const seen = new Set()
    draft.db.env.forEach((item, index) => {
      const name = item.name.trim()
      if (!name) errs[`database.env.${index}`] = 'Enter a name.'
      else if (!ENV_NAME.test(name)) errs[`database.env.${index}`] = 'Use letters, digits and underscores, and don’t start with a digit.'
      else if (seen.has(name)) errs[`database.env.${index}`] = `${name} is already used.`
      seen.add(name)
    })
  }
  return errs
}

// The server names a few problems by a broader path than the field that shows them.
const fieldOf = path => ({ ports: 'ports.to', memory: 'worktrees' })[path] ?? path

export function createSettings({ h, svg, chip, getJson, onDirty }) {
  const stores = new Map()
  let editToken = null
  let skillsCache = new Map()

  const icon = {
    info: () => svg(18, [['circle', { cx: 8, cy: 8, r: 6.5 }], ['path', { d: 'M8 7.2v4.3M8 4.8v.1' }]], { stroke: 'var(--lavender)', width: 1.4 }),
    check: () => svg(18, [['path', { d: 'M3 8.5l3.2 3L13 4.5' }]], { stroke: 'var(--green)', width: 2 }),
    close: size => svg(size, [['path', { d: 'M4 4l8 8M12 4l-8 8' }]], { width: 1.6 }),
    plus: () => svg(12, [['path', { d: 'M8 2.5v11M2.5 8h11' }]], { width: 1.6 }),
    eye: () => svg(16, [['path', { d: 'M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z' }], ['circle', { cx: 8, cy: 8, r: 2 }]], { width: 1.3 }),
    lock: () => svg(12, [['rect', { x: 3, y: 7, width: 10, height: 7 }], ['path', { d: 'M5 7V5a3 3 0 0 1 6 0v2' }]], { width: 1.5 }),
  }

  async function token() {
    if (!editToken) editToken = (await getJson('/api/session')).editToken
    return editToken
  }

  function store(id) {
    if (!stores.has(id)) {
      const root = h('div', { class: 'settingspage' })
      // gen counts drafts replaced wholesale (a save or a discard), so rows bound to the old one rebuild.
      stores.set(id, { id, root, status: 'idle', data: null, saved: null, draft: null, ui: {}, binds: [], fieldKeys: new Set(), gen: 0, name: id })
    }
    return stores.get(id)
  }

  const unsaved = s => (s.draft ? Object.keys(changesOf(s.draft, s.saved)).length : 0)

  async function load(s, { reloaded = false } = {}) {
    s.status = 'loading'
    if (!s.data) s.root.replaceChildren(h('p', { class: 'muted' }, 'Loading settings…'))
    try {
      const data = await getJson(`/api/projects/${encodeURIComponent(s.id)}/settings`)
      s.data = data
      s.saved = toDraft(data.values)
      s.draft = toDraft(data.values)
      s.ui = { reloaded }
      s.status = 'ready'
      build(s)
    } catch (error) {
      s.status = 'error'
      s.root.replaceChildren(
        h('div', { class: 'alert alert--danger', role: 'alert' }, h('span', {}, h('strong', {}, 'Error:'), ` the settings couldn’t be loaded: ${error.message}`), h('button', { class: 'btn btn--secondary', onClick: () => load(s) }, 'Try again')),
      )
    }
    onDirty()
  }

  async function loadSkills(s) {
    if (skillsCache.has(s.id)) return
    skillsCache.set(s.id, [])
    try {
      skillsCache.set(s.id, (await getJson(`/api/projects/${encodeURIComponent(s.id)}/skills`)).skills)
    } catch {
      skillsCache.delete(s.id)
    }
  }

  /** Re-checks everything after any edit, and updates each bound part of the page in place. */
  function update(s, { edited = true } = {}) {
    if (edited) {
      s.ui.savedAt = null
      s.ui.reloaded = false
      s.ui.server = {}
      s.ui.failed = null
    }
    const changes = changesOf(s.draft, s.saved)
    const errs = { ...problemsOf(s.draft, changes, s.data.options.models), ...(s.ui.server ?? {}) }
    if (Object.keys(errs).length === 0) s.ui.summary = false
    const ctx = { changes, errs, count: Object.keys(changes).length }
    for (const bind of s.binds) bind(ctx)
    onDirty()
  }

  // ---------- parts that update in place ----------

  function field(s, { id, label, control, help, err, warn, wide }) {
    const helpNode = h('span', { class: 'field__help', id: `${id}-help` })
    const errNode = h('span', { class: 'field__error', id: `${id}-err`, hidden: true })
    const warnNode = h('span', { class: 'field__warn', id: `${id}-warn`, hidden: true })
    // A wrapped input (a number with its unit) carries the description and state itself.
    const target = control.matches('input, select') ? control : control.querySelector('input, select') ?? control
    target.setAttribute('aria-describedby', `${id}-help ${id}-warn ${id}-err`)
    if (err) s.fieldKeys.add(err)
    s.binds.push(ctx => {
      const text = typeof help === 'function' ? help(ctx) : help
      helpNode.textContent = text ?? ''
      helpNode.hidden = !text
      const message = err && ctx.errs[err]
      errNode.textContent = message ? `Error: ${message}` : ''
      errNode.hidden = !message
      target.setAttribute('aria-invalid', String(Boolean(message)))
      const caution = warn?.(ctx)
      warnNode.textContent = caution ?? ''
      warnNode.hidden = !caution
    })
    return h('div', { class: `field${wide ? ' field--wide' : ''}` }, h('label', { class: 'field__label', for: id }, label), control, helpNode, warnNode, errNode)
  }

  function input(s, { id, get, set, numeric, mono, placeholder }) {
    const node = h('input', { id, type: 'text', class: `input${mono ? ' input--mono' : ''}`, inputmode: numeric ? 'numeric' : null, spellcheck: mono ? 'false' : null, autocomplete: 'off', placeholder })
    node.value = get()
    node.addEventListener('input', () => {
      set(node.value)
      update(s)
    })
    s.binds.push(() => {
      if (document.activeElement !== node && node.value !== get()) node.value = get()
    })
    return node
  }

  /** Options are [value, label] pairs, or { group, options } for an optgroup. A function is re-read on each update. */
  function select(s, { id, options, get, set, disabled }) {
    const node = h('select', { id, class: 'input select' })
    const toNodes = list => list.map(item => (Array.isArray(item) ? h('option', { value: item[0] }, item[1]) : h('optgroup', { label: item.group }, toNodes(item.options))))
    let shown = ''
    const fill = () => {
      const list = typeof options === 'function' ? options() : options
      const key = JSON.stringify(list)
      if (key === shown) return
      shown = key
      node.replaceChildren(...toNodes(list))
    }
    fill()
    node.value = get()
    node.addEventListener('change', () => {
      set(node.value)
      update(s)
    })
    s.binds.push(() => {
      fill()
      if (node.value !== get()) node.value = get()
      node.disabled = Boolean(disabled?.())
    })
    return node
  }

  function toggle(s, { id, label, get, set, state, help }) {
    const word = h('span', { class: 'switch__word' })
    const knob = h('span', { class: 'switch__knob', 'aria-hidden': 'true' })
    const button = h('button', { type: 'button', role: 'switch', class: 'switch', 'aria-labelledby': `${id}-l`, 'aria-describedby': `${id}-help` }, knob)
    const helpNode = h('span', { class: 'field__help', id: `${id}-help` })
    button.addEventListener('click', () => {
      if (state().disabled) return
      set(!get())
      update(s)
    })
    s.binds.push(ctx => {
      const { on, disabled, text } = state(ctx)
      button.setAttribute('aria-checked', String(on))
      button.disabled = disabled
      word.textContent = on ? 'On' : 'Off'
      const helpText = typeof help === 'function' ? help(ctx) : help
      helpNode.textContent = text ?? helpText ?? ''
      helpNode.hidden = !helpNode.textContent
    })
    return h('div', { class: 'field' }, h('span', { class: 'field__label', id: `${id}-l` }, label), h('div', { class: 'switch__row' }, button, word), helpNode)
  }

  // ---------- skills, with autocomplete ----------

  function skillPicker(s, role) {
    const id = `skill-${role}`
    const list = h('div', { class: 'chips' })
    const listbox = h('ul', { class: 'combo__list', role: 'listbox', id: `${id}-list`, hidden: true, 'aria-label': `Skills to add to ${ROLE_NAME[role]}` })
    const box = h('input', {
      id,
      type: 'text',
      class: 'input input--mono',
      role: 'combobox',
      'aria-autocomplete': 'list',
      'aria-expanded': 'false',
      'aria-controls': `${id}-list`,
      autocomplete: 'off',
      spellcheck: 'false',
      placeholder: 'e.g. design:ux-copy',
    })
    const addButton = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Add')
    const errNode = h('span', { class: 'field__error', id: `${id}-err`, hidden: true })
    const warnNode = h('span', { class: 'field__warn', id: `${id}-warn`, hidden: true })
    box.setAttribute('aria-describedby', `${id}-err ${id}-warn`)
    let options = []
    let active = -1
    let error = ''

    const skills = () => s.draft.team[role].skills
    s.fieldKeys.add(`team.${role}.skills`)
    const known = () => skillsCache.get(s.id) ?? []

    function close() {
      listbox.hidden = true
      box.setAttribute('aria-expanded', 'false')
      box.removeAttribute('aria-activedescendant')
      active = -1
    }

    function showOptions() {
      const query = box.value.trim().toLowerCase()
      options = known()
        .filter(skill => !skills().includes(skill.name))
        .filter(skill => !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query))
        .sort((a, b) => Number(!a.name.toLowerCase().startsWith(query)) - Number(!b.name.toLowerCase().startsWith(query)))
        .slice(0, 8)
      active = Math.min(active, options.length - 1)
      listbox.replaceChildren(
        ...options.map((skill, index) =>
          h(
            'li',
            {
              id: `${id}-opt-${index}`,
              role: 'option',
              class: 'combo__option',
              'aria-selected': String(index === active),
              onMousedown: event => event.preventDefault(),
              onClick: () => add(skill.name),
            },
            h('span', { class: 'combo__name' }, skill.name),
            skill.description && h('span', { class: 'combo__desc' }, skill.description),
          ),
        ),
      )
      const open = options.length > 0 && document.activeElement === box
      listbox.hidden = !open
      box.setAttribute('aria-expanded', String(open))
      if (open && active >= 0) {
        box.setAttribute('aria-activedescendant', `${id}-opt-${active}`)
        listbox.children[active]?.scrollIntoView({ block: 'nearest' })
      } else box.removeAttribute('aria-activedescendant')
    }

    function add(name) {
      const value = (name ?? box.value).trim()
      if (!value) error = 'Type a skill name first.'
      else if (!SKILL_NAME.test(value)) error = 'Use a skill name like design:ux-copy: letters, digits, dots, dashes and underscores, with one optional colon.'
      else if (skills().includes(value)) error = `${value} is already added.`
      else {
        error = ''
        s.draft.team[role].skills = [...skills(), value]
        box.value = ''
        close()
        update(s)
        box.focus()
        return
      }
      update(s, { edited: false })
    }

    box.addEventListener('input', () => {
      error = ''
      active = -1
      showOptions()
      update(s, { edited: false })
    })
    box.addEventListener('focus', () => loadSkills(s).then(showOptions))
    box.addEventListener('blur', () => setTimeout(close, 100))
    box.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (listbox.hidden) showOptions()
        if (options.length === 0) return
        active = event.key === 'ArrowDown' ? (active + 1) % options.length : (active <= 0 ? options.length : active) - 1
        showOptions()
      } else if (event.key === 'Enter') {
        event.preventDefault()
        add(!listbox.hidden && active >= 0 ? options[active].name : undefined)
      } else if (event.key === 'Escape' && !listbox.hidden) {
        event.preventDefault()
        event.stopPropagation()
        close()
      }
    })
    addButton.addEventListener('click', () => add())

    let shown = ''
    s.binds.push(() => {
      const names = skills()
      const builtIn = [s.data.builtIn?.roles?.[role], role === 'qa' && s.data.builtIn?.browser?.[s.draft.driver]].filter(Boolean)
      const key = [...builtIn.map(item => item.label), ...names].join('\n')
      if (key !== shown || list.childElementCount === 0) {
        shown = key
        list.replaceChildren(
          ...builtIn.map(item =>
            h(
              'span',
              { class: 'skillchip skillchip--locked', title: `${item.description} Built into enki, so it’s always loaded and can’t be removed.` },
              icon.lock(),
              item.label,
              h('span', { class: 'sr-only' }, `: built into enki, can’t be removed. ${item.description}`),
            ),
          ),
          ...(names.length
            ? names.map(name =>
                h(
                  'span',
                  { class: 'skillchip' },
                  name,
                  h(
                    'button',
                    {
                      type: 'button',
                      class: 'skillchip__remove',
                      'aria-label': `Remove ${name} from ${ROLE_NAME[role]}`,
                      onClick: () => {
                        s.draft.team[role].skills = skills().filter(item => item !== name)
                        update(s)
                        box.focus()
                      },
                    },
                    icon.close(12),
                  ),
                ),
              )
            : [h('span', { class: 'chips__empty' }, builtIn.length ? 'No skills of your own' : 'No skills added')]),
        )
      }
    })
    s.binds.push(ctx => {
      const message = error || ctx.errs[`team.${role}.skills`]
      errNode.textContent = message ? `Error: ${message}` : ''
      errNode.hidden = !message
      box.setAttribute('aria-invalid', String(Boolean(message)))
    })
    s.binds.push(() => {
      const names = skills()
      const missing = known().length ? names.filter(name => !known().some(skill => skill.name === name)) : []
      warnNode.textContent = missing.length ? `Not installed on this machine: ${missing.join(', ')}. Team start will stop until ${missing.length === 1 ? 'it is' : 'they are'}.` : ''
      warnNode.hidden = !missing.length
    })

    return h(
      'div',
      { class: 'field field--skills' },
      h('label', { class: 'field__label', for: id }, 'Skills'),
      list,
      h('div', { class: 'combo' }, h('div', { class: 'combo__field' }, box, listbox), addButton),
      errNode,
      warnNode,
    )
  }

  // ---------- the page ----------

  function build(s) {
    s.binds = []
    s.fieldKeys = new Set(['ports.from', 'ports.to', 'worktrees'])
    const { data } = s
    const d = () => s.draft
    const catalog = data.options.models
    const modelIds = new Set(catalog.models.map(model => model.id))
    const ro = data.readOnly
    const isPrivate = ro.memory === 'private'

    const conflict = h('div', { class: 'alert alert--warning alert--row', role: 'alert', hidden: true }, h('span', {}, h('strong', {}, 'Changed elsewhere:'), ' the settings file was edited after this page loaded it. Reload to get the latest version. Unsaved changes on this page will be discarded.'), h('button', { type: 'button', class: 'btn btn--secondary', onClick: () => load(s, { reloaded: true }) }, 'Reload'))
    const invalid = data.invalid && h('div', { class: 'alert alert--danger', role: 'alert' }, h('span', {}, h('strong', {}, 'Error:'), ' the settings file has problems, so nothing can be saved until they’re fixed in .enki/config.json: ', data.invalid.join('; ')))
    const summary = h('div', { class: 'alert alert--danger', role: 'alert', tabindex: '-1', hidden: true })
    const failed = h('div', { class: 'alert alert--danger', role: 'alert', hidden: true })
    const saved = h('div', { class: 'alert alert--success', role: 'status', hidden: true }, icon.check(), h('span', {}))
    const reloaded = h('div', { class: 'alert alert--info', role: 'status', hidden: true }, h('span', {}, h('strong', {}, 'Reloaded.'), ' Showing the latest settings from the file.'))
    s.binds.push(ctx => {
      conflict.hidden = !s.ui.conflict
      const n = Object.keys(ctx.errs).length
      summary.hidden = !(s.ui.summary && n > 0)
      summary.replaceChildren(h('span', {}, h('strong', {}, 'Error:'), ` ${n} ${n === 1 ? 'field needs' : 'fields need'} fixing before you can save. Each one is marked below.`))
      failed.hidden = !s.ui.failed
      failed.replaceChildren(h('span', {}, h('strong', {}, 'Error:'), ` ${s.ui.failed ?? ''}`))
      saved.hidden = !(s.ui.savedAt && ctx.count === 0)
      saved.lastChild.replaceChildren(h('strong', {}, 'Saved'), ` at ${s.ui.savedAt}. The next agent started will use these settings.`)
      reloaded.hidden = !(s.ui.reloaded && ctx.count === 0)
    })

    const header = h(
      'section',
      { class: 'section settings__top' },
      h('div', { class: 'crumbs' }, `${s.name} / Settings`),
      h('h1', {}, 'Project settings'),
      h('div', { class: 'notice', role: 'note' }, icon.info(), h('span', {}, h('strong', {}, 'Changes apply to the next agent started.'), ' ', h('span', { class: 'muted' }, 'Agents that are already running keep the settings they started with.'))),
      conflict,
      invalid,
      summary,
      failed,
      saved,
      reloaded,
    )

    const panel = (id, title, note, ...body) => h('section', { class: 'panel form', 'aria-labelledby': id }, h('div', { class: 'form__head' }, h('h2', { id }, title), note && h('p', { class: 'form__note' }, note)), ...body)

    const source =
      catalog.source === 'claude-code'
        ? `Models and effort levels come from Claude Code’s list for your account${catalog.fetchedAt ? `, as of ${new Date(catalog.fetchedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}.`
        : 'Claude Code’s model list wasn’t found on this computer, so these are enki’s built-in models. Open /model in Claude Code once to fetch yours.'
    const roles = panel(
      'roles-h',
      'Agent roles',
      'The model, effort level and skills each role starts with.',
      h('p', { class: 'field__help form__source' }, source),
      ROLES.map(role => {
        const team = () => d().team[role]
        const current = s.saved.team[role].model
        const info = () => catalog.models.find(model => model.id === team().model)
        const group = (name, list) => list.length > 0 && { group: name, options: list.map(model => [model.id, model.label]) }
        const models = [group('Latest', catalog.models.filter(model => model.latest)), group('Older', catalog.models.filter(model => !model.latest)), !modelIds.has(current) && { group: 'In config.json', options: [[current, current]] }].filter(Boolean)
        // Only the levels the chosen model offers, plus the current one if it isn't among them, so it shows.
        const levels = () => info()?.efforts ?? data.options.efforts
        const efforts = () => {
          const list = levels().map(level => [level, EFFORT_LABELS[level] ?? level])
          return levels().includes(team().effort) ? list : [...list, [team().effort, levels().length ? `${EFFORT_LABELS[team().effort] ?? team().effort} (not offered)` : 'Not available']]
        }
        return h(
          'div',
          { class: 'rolerow' },
          h('div', { class: 'rolerow__name' }, chip(role, 14), h('span', {}, ROLE_NAME[role])),
          field(s, {
            id: `model-${role}`,
            label: 'Model',
            err: `team.${role}.model`,
            help: () => info()?.description ?? `Not in ${catalog.source === 'claude-code' ? 'Claude Code’s list for your account' : 'the model list'}.`,
            warn: () => (info() && !info().autoMode && ro.permissionMode === 'auto' ? `${info().label} can’t run in auto permission mode, which this project’s workers use.${info().autoModeNote ? ` ${info().autoModeNote}.` : ''}` : null),
            control: select(s, { id: `model-${role}`, options: models, get: () => team().model, set: value => (team().model = value) }),
          }),
          field(s, {
            id: `effort-${role}`,
            label: 'Effort',
            err: `team.${role}.effort`,
            help: () => (levels().length === 0 ? 'This model has no effort setting.' : info()?.defaultEffort ? `Claude Code’s default: ${EFFORT_LABELS[info().defaultEffort] ?? info().defaultEffort}.` : ''),
            control: select(s, { id: `effort-${role}`, options: efforts, disabled: () => levels().length === 0, get: () => team().effort, set: value => (team().effort = value) }),
          }),
          skillPicker(s, role),
        )
      }),
    )

    const workflow = panel(
      'flow-h',
      'Workflow',
      'How sessions become the orchestrator, and how many times the team retries.',
      h(
        'div',
        { class: 'form__grid' },
        field(s, { id: 'set-fix', label: 'Fix rounds', err: 'maxFixRounds', help: 'How many times the team retries after a failed test or review. 0 or more; default 3.', control: input(s, { id: 'set-fix', numeric: true, get: () => d().maxFixRounds, set: value => (d().maxFixRounds = value) }) }),
        field(s, {
          id: 'set-act',
          label: 'Activation',
          help: () => (d().mode === 'auto' ? 'Every Claude session in this project becomes the orchestrator.' : 'A session becomes the orchestrator only after /enki:task.'),
          control: select(s, { id: 'set-act', options: [['auto', 'Auto'], ['explicit', 'Explicit']], get: () => d().mode, set: value => (d().mode = value) }),
        }),
        toggle(s, {
          id: 'set-wt',
          label: 'Worktrees',
          get: () => d().worktrees,
          set: value => (d().worktrees = value),
          state: ctx => ({ on: d().worktrees, disabled: isPrivate && d().worktrees, text: ctx?.errs.worktrees }),
          help: () => (isPrivate ? 'Can’t be turned off while memory mode is private.' : 'Each task works in its own git worktree and branch.'),
        }),
      ),
    )

    const timeouts = panel(
      'to-h',
      'Timeouts',
      'Minutes each step may run before enki stops waiting for it.',
      h(
        'div',
        { class: 'form__grid form__grid--small' },
        TIMEOUTS.map(([key, label]) => {
          const id = `to-${key}`
          return field(s, { id, label, err: `timeouts.${key}`, control: h('div', { class: 'unit' }, input(s, { id, numeric: true, get: () => d().timeouts[key], set: value => (d().timeouts[key] = value) }), h('span', { class: 'unit__label', 'aria-hidden': 'true' }, 'min')) })
        }),
      ),
    )

    const portFrom = input(s, { id: 'set-pf', numeric: true, get: () => d().portFrom, set: value => (d().portFrom = value) })
    const portTo = input(s, { id: 'set-pt', numeric: true, get: () => d().portTo, set: value => (d().portTo = value) })
    const portErrs = h('div', { class: 'field__errors' })
    s.binds.push(ctx => {
      portFrom.setAttribute('aria-invalid', String(Boolean(ctx.errs['ports.from'])))
      portTo.setAttribute('aria-invalid', String(Boolean(ctx.errs['ports.to'])))
      portErrs.replaceChildren(...['ports.from', 'ports.to'].filter(key => ctx.errs[key]).map(key => h('span', { class: 'field__error', id: `${key === 'ports.from' ? 'set-pf' : 'set-pt'}-err` }, `Error: ${ctx.errs[key]}`)))
    })
    portFrom.setAttribute('aria-describedby', 'ports-help set-pf-err')
    portTo.setAttribute('aria-describedby', 'ports-help set-pt-err')

    const browser = panel(
      'br-h',
      'Browser and ports',
      'What QA uses to click through the app, and which ports task servers may take.',
      h(
        'div',
        { class: 'form__grid' },
        field(s, { id: 'set-drv', label: 'Browser driver', control: select(s, { id: 'set-drv', options: data.options.drivers.map(driver => [driver, DRIVER_LABELS[driver] ?? driver]), get: () => d().driver, set: value => (d().driver = value) }) }),
        toggle(s, {
          id: 'set-hl',
          label: 'Headless browser',
          get: () => d().headless,
          set: value => (d().headless = value),
          state: () => {
            const playwright = d().driver === 'playwright'
            return { on: playwright && d().headless, disabled: !playwright }
          },
          help: () => (d().driver === 'none' ? 'No browser driver is selected.' : d().driver === 'chrome' ? 'Only Playwright runs headless. Claude in Chrome uses your own browser window.' : 'Run the browser without a visible window.'),
        }),
        h(
          'fieldset',
          { class: 'field fieldset' },
          h('legend', { class: 'field__label' }, 'Port range'),
          h('div', { class: 'range-pair' }, h('div', { class: 'field' }, h('label', { class: 'field__sub', for: 'set-pf' }, 'From'), portFrom), h('span', { class: 'range-pair__dash', 'aria-hidden': 'true' }, '–'), h('div', { class: 'field' }, h('label', { class: 'field__sub', for: 'set-pt' }, 'To'), portTo)),
          h('span', { class: 'field__help', id: 'ports-help' }, 'Between 1024 and 65535.'),
          portErrs,
        ),
      ),
    )

    const envList = h('div', { class: 'envlist' })
    let envShape = ''
    const shown = new Set()
    const renderEnv = ({ focusIndex } = {}) => {
      envShape = `${s.gen}:${d().db.env.length}`
      envList.replaceChildren(
        ...d().db.env.map((item, index) => {
          const name = h('input', { type: 'text', class: 'input input--mono envlist__name', spellcheck: 'false', autocomplete: 'off', placeholder: 'NAME', 'aria-label': `Name ${index + 1}`, 'aria-describedby': `env-${index}-err` })
          const value = h('input', { type: shown.has(index) ? 'text' : 'password', class: 'input input--mono envlist__value', spellcheck: 'false', autocomplete: 'off', placeholder: 'value', 'aria-label': `Value ${index + 1}` })
          name.value = item.name
          value.value = item.value
          name.addEventListener('input', () => {
            item.name = name.value
            update(s)
          })
          value.addEventListener('input', () => {
            item.value = value.value
            update(s)
          })
          const label = () => item.name.trim() || `value ${index + 1}`
          const show = h('button', { type: 'button', class: 'btn btn--ghost', 'aria-pressed': String(shown.has(index)) }, icon.eye(), shown.has(index) ? 'Hide' : 'Show')
          show.addEventListener('click', () => {
            if (shown.has(index)) shown.delete(index)
            else shown.add(index)
            renderEnv()
            envList.querySelectorAll('.envlist__row')[index]?.querySelector('[aria-pressed]')?.focus()
          })
          const remove = h('button', { type: 'button', class: 'btn btn--ghost btn--icon', 'aria-label': `Remove ${label()}` }, icon.close(14))
          remove.addEventListener('click', () => {
            d().db.env.splice(index, 1)
            shown.clear()
            renderEnv()
            update(s)
            addEnv.focus()
          })
          const err = h('span', { class: 'field__error', id: `env-${index}-err`, hidden: true })
          s.binds.push(ctx => {
            if (!name.isConnected) return
            const message = ctx.errs[`database.env.${index}`]
            err.textContent = message ? `Error: ${message}` : ''
            err.hidden = !message
            name.setAttribute('aria-invalid', String(Boolean(message)))
            remove.setAttribute('aria-label', `Remove ${label()}`)
            if (document.activeElement !== name && name.value !== item.name) name.value = item.name
            if (document.activeElement !== value && value.value !== item.value) value.value = item.value
          })
          if (focusIndex === index) requestAnimationFrame(() => name.focus())
          return h('div', { class: 'envlist__item' }, h('div', { class: 'envlist__row' }, name, value, show, remove), err)
        }),
      )
    }
    const addEnv = h('button', { type: 'button', class: 'btn btn--ghost btn--add' }, icon.plus(), 'Add value')
    addEnv.addEventListener('click', () => {
      d().db.env.push({ name: '', value: '' })
      shown.add(d().db.env.length - 1)
      renderEnv({ focusIndex: d().db.env.length - 1 })
      update(s)
    })
    s.binds.push(() => {
      // A reload or discard can change how many rows there are.
      if (`${s.gen}:${d().db.env.length}` !== envShape) {
        shown.clear()
        renderEnv()
      }
    })
    renderEnv()

    const dbOff = h('div', { class: 'notice notice--dashed', role: 'note', hidden: true }, 'Database copying is off. The commands below are kept and will be used again when you turn it back on.')
    const dbBody = h(
      'div',
      { class: 'form__stack' },
      field(s, {
        id: 'set-dbd',
        label: 'Default database for plans',
        help: () => DATABASE_HELP[d().db.default] + (d().db.enabled || d().db.default !== 'copy' ? '' : ' While copying is off, plans that ask for a copy use the shared database.'),
        control: select(s, { id: 'set-dbd', options: data.options.databaseModes.map(mode => [mode, mode[0].toUpperCase() + mode.slice(1)]), get: () => d().db.default, set: value => (d().db.default = value) }),
      }),
      field(s, { id: 'set-dbc', label: 'Copy command', err: 'database.copy', wide: true, help: 'Run when a task starts. You can use {task} and {port}.', control: input(s, { id: 'set-dbc', mono: true, get: () => d().db.copy, set: value => (d().db.copy = value) }) }),
      field(s, { id: 'set-dbx', label: 'Drop command', err: 'database.drop', wide: true, help: 'Run when a task finishes. You can use {task} and {port}.', control: input(s, { id: 'set-dbx', mono: true, get: () => d().db.drop, set: value => (d().db.drop = value) }) }),
      h('fieldset', { class: 'field fieldset' }, h('legend', { class: 'field__label' }, 'Environment values'), h('span', { class: 'field__help' }, 'Set for each task’s database. Values are hidden until you show them.'), envList, addEnv),
    )
    s.binds.push(() => {
      dbOff.hidden = d().db.enabled
      dbBody.classList.toggle('form__stack--off', !d().db.enabled)
    })
    const database = h(
      'section',
      { class: 'panel form', 'aria-labelledby': 'db-h' },
      h(
        'div',
        { class: 'form__head form__head--split' },
        h('div', {}, h('h2', { id: 'db-h' }, 'Database'), h('p', { class: 'form__note' }, 'Give each task its own copy of the database.')),
        toggle(s, { id: 'set-db', label: 'Database copying', get: () => d().db.enabled, set: value => (d().db.enabled = value), state: () => ({ on: d().db.enabled, disabled: false }) }),
      ),
      dbOff,
      dbBody,
    )

    const setup = h(
      'section',
      { class: 'panel form', 'aria-labelledby': 'ro-h' },
      h('div', { class: 'form__head form__head--split' }, h('h2', { id: 'ro-h' }, 'Project setup'), h('span', { class: 'lockpill' }, icon.lock(), 'Not editable here')),
      h(
        'dl',
        { class: 'readonly' },
        h(
          'div',
          {},
          h('dt', {}, 'Memory mode'),
          h('dd', {}, h('span', { class: 'readonly__value' }, isPrivate ? 'Private' : 'Repo'), h('span', { class: 'field__help' }, isPrivate ? 'Enki’s notes for each repo stay on this machine, in a local git repo outside your code, and are never committed.' : 'Enki’s notes live in each repo’s .enki folder and are committed with the code, so they reach others through git.')),
        ),
      ),
      ro.problem
        ? h('p', { class: 'field__error' }, `The repos couldn’t be read: ${ro.problem}`)
        : h(
            'div',
            { class: 'table-scroll' },
            h(
              'table',
              { class: 'rotable' },
              h('caption', { class: 'sr-only' }, 'Repos'),
              h('thead', {}, h('tr', {}, ['Name', 'Path', 'Branch', 'Test commands', 'Dev server'].map(label => h('th', { scope: 'col' }, label)))),
              h(
                'tbody',
                {},
                ro.repos.map(repo =>
                  h(
                    'tr',
                    {},
                    h('td', {}, repo.name),
                    h('td', { class: 'mono' }, repo.path),
                    h('td', {}, repo.branch ?? '—'),
                    h('td', { class: 'mono' }, repo.test.length ? repo.test.map(command => h('div', {}, command)) : '—'),
                    h('td', { class: 'mono' }, repo.devServer ?? '—'),
                  ),
                ),
              ),
            ),
          ),
    )

    const barText = h('span', { class: 'savebar__text' })
    const discard = h('button', { type: 'button', class: 'btn btn--secondary' }, 'Discard changes')
    const save = h('button', { type: 'button', class: 'btn btn--primary' }, 'Save')
    discard.addEventListener('click', () => {
      s.draft = clone(s.saved)
      s.gen += 1
      s.ui = { conflict: s.ui.conflict }
      update(s, { edited: false })
    })
    save.addEventListener('click', () => submit(s, summary))
    s.binds.push(ctx => {
      const n = Object.keys(ctx.errs).length
      const changed = `${ctx.count} unsaved ${ctx.count === 1 ? 'change' : 'changes'}`
      barText.textContent = s.ui.conflict ? 'Reload before saving: the file changed elsewhere.' : s.ui.saving ? 'Saving…' : ctx.count && n ? `${changed} · ${n} ${n === 1 ? 'field needs' : 'fields need'} fixing` : ctx.count ? changed : s.ui.savedAt ? 'All changes saved' : 'No unsaved changes'
      barText.dataset.tone = s.ui.conflict ? 'warning' : ctx.count && n ? 'danger' : ctx.count ? 'strong' : ''
      discard.disabled = !ctx.count || s.ui.conflict || s.ui.saving
      save.disabled = !ctx.count || s.ui.conflict || s.ui.saving || Boolean(data.invalid)
    })
    const bar = h('div', { class: 'savebar' }, barText, h('div', { class: 'savebar__actions' }, discard, save))

    s.root.replaceChildren(header, roles, workflow, timeouts, browser, database, setup, bar)
    update(s, { edited: false })
  }

  async function submit(s, summary) {
    const changes = changesOf(s.draft, s.saved)
    if (Object.keys(changes).length === 0 || s.ui.conflict) return
    if (Object.keys(problemsOf(s.draft, changes, s.data.options.models)).length > 0) {
      s.ui.summary = true
      update(s, { edited: false })
      summary.focus()
      return
    }
    s.ui.saving = true
    update(s, { edited: false })
    let response
    let body = {}
    try {
      response = await fetch(`/api/projects/${encodeURIComponent(s.id)}/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-enki-edit': await token() },
        body: JSON.stringify({ base: s.data.hash, changes }),
      })
      body = await response.json().catch(() => ({}))
    } catch (error) {
      body = { error: error.message }
    }
    s.ui.saving = false
    if (response?.ok) {
      s.data = body
      s.saved = toDraft(body.values)
      s.draft = toDraft(body.values)
      s.gen += 1
      s.ui = { savedAt: clock() }
      update(s, { edited: false })
      return
    }
    if (response?.status === 409) s.ui.conflict = true
    else if (response?.status === 422) {
      const problems = body.problems ?? []
      const placed = problem => problem.path && (s.fieldKeys.has(fieldOf(problem.path)) || problem.path.startsWith('database.env.'))
      s.ui.server = Object.fromEntries(problems.filter(placed).map(problem => [fieldOf(problem.path), problem.message]))
      const loose = problems.filter(problem => !placed(problem)).map(problem => (problem.path ? `${problem.path}: ${problem.message}` : problem.message))
      s.ui.summary = true
      if (loose.length) s.ui.failed = loose.join(' ')
    } else if (response?.status === 403) {
      editToken = null
      s.ui.failed = 'The dashboard refused the save. Reload this browser page and try again.'
    } else s.ui.failed = `Saving failed: ${body.error ?? `HTTP ${response?.status}`}`
    update(s, { edited: false })
    if (s.ui.summary) summary.focus()
  }

  return {
    /** The page for a project, built on first use and kept with its draft from then on. */
    mount(id, name) {
      const s = store(id)
      s.name = name ?? id
      if (s.status === 'idle') load(s)
      return s.root
    },
    unsaved: id => (stores.has(id) ? unsaved(stores.get(id)) : 0),
    /** The live stream's config fingerprints: quietly reload a clean page, or flag a conflict. */
    configsChanged(configs) {
      for (const s of stores.values()) {
        if (s.status !== 'ready' || s.ui.saving || !(s.id in configs) || configs[s.id] === s.data.hash) continue
        if (unsaved(s) === 0) load(s)
        else if (!s.ui.conflict) {
          s.ui.conflict = true
          update(s, { edited: false })
        }
      }
    },
  }
}

const ROLE_NAME = { scout: 'Scout', coder: 'Coder', tester: 'Tester', qa: 'QA', reviewer: 'Reviewer' }
