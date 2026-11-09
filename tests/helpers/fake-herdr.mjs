#!/usr/bin/env node
// Stands in for herdr. Response shapes were captured from herdr 0.9.5 (see docs/spike-results.md).
// Behaviour is scripted through the JSON file named by FAKE_HERDR_STATE.
import { spawn } from 'node:child_process'
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'

const path = process.env.FAKE_HERDR_STATE

// Real herdr takes parallel calls, so this file has to as well.
const lock = `${path}.lock`
for (;;) {
  try {
    closeSync(openSync(lock, 'wx'))
    break
  } catch {
    try {
      if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { force: true })
    } catch {}
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}
process.on('exit', () => rmSync(lock, { force: true }))

const fresh = { next: 1, panes: {}, agents: {}, calls: [], script: {} }
const state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fresh
const args = process.argv.slice(2)
state.calls.push(args)

const save = () => writeFileSync(path, JSON.stringify(state, null, 2))
const ok = (result, id = 'cli') => { save(); process.stdout.write(`${JSON.stringify({ id, result })}\n`); process.exit(0) }
const fail = (code, message) => { save(); process.stderr.write(`${JSON.stringify({ error: { code, message }, id: 'cli' })}\n`); process.exit(1) }
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const envOf = () => Object.fromEntries(args.flatMap((a, i) => a === '--env' ? [args[i + 1].split(/=(.*)/s).slice(0, 2)] : []))
const agent = name => {
  const found = state.agents[name]
  if (!found) fail('agent_not_found', `agent target ${name} not found`)
  return found
}
const session = name => ({ agent: 'claude', kind: 'id', source: 'herdr:claude', value: `session-${name}` })
const shape = (name, status) => ({ agent: { agent: 'claude', agent_status: status, name, pane_id: state.agents[name]?.pane, agent_session: session(name) } })
const shift = (key, name, fallback) => { const queue = state.script[key]?.[name]; return queue?.length ? queue.shift() : fallback }

const [group, command, target] = args
if (group === '--version') { process.stdout.write('herdr 0.9.5\n'); process.exit(0) }

if (group === 'tab' && command === 'create') {
  const root = `w1:p${state.next++}`
  const tab = `w1:t${state.next++}`
  state.panes[root] = { env: envOf(), tab, cwd: option('--cwd'), rect: { x: 0, y: 0, width: 160, height: 44 } }
  ok({ tab: { tab_id: tab }, root_pane: { pane_id: root } })
}
if (group === 'pane' && command === 'split') {
  const parent = state.panes[target]
  const rect = { ...parent.rect }
  const direction = option('--direction')
  if (direction === 'right') { rect.width = parent.rect.width /= 2; rect.x += rect.width }
  else if (state.script.brokenLayout) { rect.width = parent.rect.width /= 2; rect.x += rect.width }
  else { rect.height = parent.rect.height /= 2; rect.y += rect.height }
  const id = `w1:p${state.next++}`
  state.panes[id] = { env: envOf(), tab: state.panes[target].tab, rect }
  ok({ pane: { pane_id: id } })
}
if (group === 'pane' && command === 'run') {
  // Runs for real, so enki's readiness check talks to a live port.
  const child = spawn('sh', ['-c', args[3]], { detached: true, stdio: 'ignore', cwd: state.panes[target].cwd })
  child.unref()
  state.panes[target].pid = child.pid
  save()
  process.exit(0)
}
if (group === 'pane' && command === 'read') { save(); process.stdout.write('server log line\n'); process.exit(0) }
if (group === 'tab' && command === 'close') {
  for (const pane of Object.values(state.panes)) {
    if (pane.tab === target && pane.pid) {
      try { process.kill(-pane.pid, 'SIGTERM') } catch {}
      delete pane.pid
    }
  }
  ok({ type: 'ok' })
}
if (group === 'pane' && command === 'layout') {
  const { tab } = state.panes[option('--pane')]
  ok({ layout: { panes: Object.entries(state.panes).filter(([, pane]) => pane.tab === tab).map(([pane_id, pane]) => ({ pane_id, rect: pane.rect })) } })
}
if (group === 'notification') { save(); process.stdout.write('{}\n'); process.exit(0) }

if (group === 'agent') {
  if (command === 'start') {
    const pane = option('--pane')
    if (state.script.blockStart?.includes(target)) {
      state.agents[target] = { pane, status: 'blocked' }
      state.script.blockStart = state.script.blockStart.filter(name => name !== target)
      fail('agent_not_ready', `agent ${target} is blocked during startup and is not ready for prompts`)
    }
    state.agents[target] = { pane, status: 'idle' }
    if (!state.script.noHooks) {
      const { recordEvent } = await import(new URL('../../src/state.mjs', import.meta.url))
      recordEvent(state.panes[pane].env.ENKI_TASK, 'worker.hooks_ready', { role: state.panes[pane].env.ENKI_ROLE })
    }
    ok(shape(target, 'idle'))
  }
  if (command === 'get') { const found = agent(target); ok({ agent: { agent: 'claude', agent_status: found.status, name: target, pane_id: found.pane, agent_session: session(target) } }) }
  if (command === 'list') {
    // The orchestrator is an unnamed agent in its own pane, as in real herdr.
    const orchestrator = process.env.HERDR_PANE_ID ? [{ agent: 'claude', agent_status: state.script.orchestratorStatus ?? 'working', pane_id: process.env.HERDR_PANE_ID, agent_session: session('orchestrator') }] : []
    // Read-only, and unrecorded: the dashboard polls it while the CLI changes the state.
    process.stdout.write(`${JSON.stringify({ id: 'cli', result: { agents: [...orchestrator, ...Object.entries(state.agents).filter(([, found]) => !found.gone).map(([name, found]) => ({ agent: 'claude', agent_status: found.status, name, pane_id: found.pane, agent_session: session(name) }))] } })}\n`)
    process.exit(0)
  }
  if (command === 'prompt') {
    agent(target)
    const outcome = shift('prompt', target, 'working')
    if (outcome === 'stall') fail('agent_prompt_stalled', 'agent prompt produced no observed working or blocked state')
    if (outcome === 'pasted') { state.agents[target].pasted = true; fail('agent_prompt_stalled', 'stalled') }
    state.agents[target].status = outcome
    ok(shape(target, outcome))
  }
  if (command === 'send-keys') {
    state.agents[target].pasted = false
    if (state.agents[target].status === 'blocked') state.agents[target].status = 'working'
    ok({ type: 'ok' })
  }
  if (command === 'wait') {
    const outcome = shift('wait', target, 'done')
    if (outcome === 'timeout') fail('timeout', 'timed out')
    state.agents[target].status = outcome
    ok(shape(target, outcome))
  }
  if (command === 'read') {
    agent(target)
    if (state.agents[target].pasted) { save(); process.stdout.write('[Pasted text #1]\n'); process.exit(0) }
    if (state.agents[target].status === 'blocked' && option('--lines')) fail('agent_not_idle', 'cannot read while blocked')
    save(); process.stdout.write(state.agents[target].status === 'blocked' ? (state.script.screen ?? 'Do you want to proceed?\n') : `summary from ${target}\n`); process.exit(0)
  }
}
fail('unknown', `fake herdr: ${args.join(' ')}`)
