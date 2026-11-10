// The band above the orchestrator's prompt while it runs a task: a pointer to the dashboard,
// with a button that opens the task's page. Enki's CLI decides whether this session is an
// orchestrator with an open task, so workers (which may not run `enki dashboard`) never show it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BandTask } from '../types'

const ORANGE = '#ff5c01'

const bandTask = atom({ plugin: 'enki', key: 'bandTask' } as const, null)

const isBandTask = (value: unknown): value is BandTask =>
  typeof value === 'object' &&
  value !== null &&
  ['slug', 'phase', 'url'].every(key => typeof (value as Record<string, unknown>)[key] === 'string')

/** Asks the CLI which task this pane orchestrates. Anything unexpected hides the band. */
async function refresh($: EngineInterface) {
  let found: BandTask | null = null
  try {
    const { exitCode, stdout } = await $.process.run(['node', `${$.plugin.root}/bin/enki`, 'dashboard', 'link'], { timeoutMs: 10000 })
    if (exitCode === 0) {
      const task: unknown = JSON.parse(stdout).task
      found = isBandTask(task) ? task : null
    }
  } catch {
    found = null
  }
  await update($, bandTask, () => found)
}

/** Starts the dashboard if it's down, and opens this task's page in the browser. */
async function openDashboard($: EngineInterface, url: string) {
  const { exitCode } = await $.process.run(['node', `${$.plugin.root}/bin/enki`, 'dashboard', '--open', '--quiet'], { timeoutMs: 20000 })
  if (exitCode !== 0) $.ui.toast(`The dashboard didn't start. Open ${url} yourself.`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    void refresh($)
    return started
  })

  // A task starts and finishes inside a turn, so its end is when to look again.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    void refresh($)
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const task = await read($, bandTask)
    if (e.props.hasSurvey || task === null) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    // Framed in enki's orange, with room around it, so it reads as enki's and not as chat.
    return (
      <Box marginTop={1} width={e.props.bodyColumns}>
        <Box
          flexDirection="row"
          justifyContent="space-between"
          alignItems="center"
          gap={2}
          paddingX={1}
          borderStyle="round"
          borderColor={ORANGE}
          width={e.props.bodyColumns}
        >
          <Text wrap="truncate-end">
            <Text bold color={ORANGE}>Enki</Text>
            <Text>  {task.slug}</Text>
            <Text dimColor> · {task.phase} · check the team's status in the dashboard</Text>
          </Text>
          <Button key="dashboard" variant="primary" label="Go to dashboard" onPress={() => openDashboard($, task.url)} />
        </Box>
      </Box>
    )
  })
}
