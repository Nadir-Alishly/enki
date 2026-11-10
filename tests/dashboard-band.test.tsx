// The band above the orchestrator's prompt. Run with: claude plugin test .
import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'enki',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: true, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

const TASK = { slug: 'dark-mode', phase: 'coding', url: 'http://localhost:4747/#/p/p1/t/2026-11-11-dark-mode' }
const stored = (value: unknown) => () => ({ value: { value, version: 1 } })
const ran = (exitCode: number, stdout = '', stderr = '') => ({ exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false })
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

test('an orchestrator with an open task sees the band, and the button opens the dashboard', async ($, on) => {
  on('state.get', stored(TASK))
  const runs: string[][] = []
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: ran(0) }
  })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /dark-mode/ }))?.text).toMatch(/check the team's status in the dashboard/)
  await ui.press({ key: 'dashboard' })
  expect(runs).toHaveLength(1)
  expect(runs[0]?.slice(-3)).toEqual(['dashboard', '--open', '--quiet'])
  await ui.unmount()
})

test('with no open task, or under a survey, the band is left to the engine', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  on('state.get', stored(null))
  const none = await $.ui.mount({ ...BAND, surface: 'terminal' })
  expect((await none.find({ type: 'Text' }))?.text).toBe('engine')
  await none.unmount()
})

test('a survey keeps the band', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>survey</Text>
  })
  on('state.get', stored(TASK))
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'terminal' })
  expect((await ui.find({ type: 'Text' }))?.text).toBe('survey')
  await ui.unmount()
})

test('the session asks enki for its task when it starts, and a failure hides the band', async ($, on) => {
  const saved: unknown[] = []
  on('state.get', stored(null))
  on('state.set', (_, e) => {
    saved.push(e.value)
    return { value: { isSet: true, version: saved.length + 1 } }
  })
  let answer = ran(0, JSON.stringify({ url: 'http://localhost:4747/', task: TASK }))
  on('process.run', () => ({ value: answer }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', () => ({ text: 'done' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await settle()
  expect(saved.at(-1)).toEqual(TASK)

  answer = ran(1, '', 'Workers can’t run "enki dashboard".')
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await settle()
  expect(saved.at(-1)).toBe(null)
})
