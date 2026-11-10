// Bringing the dashboard's browser window forward after opening it. Desktops on Wayland only
// let a window take the focus with a token from the app the person just used, and enki opens
// the page from a background process that has none. On KDE, KWin raises it for us: a small
// script, loaded over D-Bus, finds the window by its page title and activates it, switching
// virtual desktops if needed. Elsewhere this does nothing, and the page opens as before.
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The dashboard's page titles: "<task> · Enki", "Settings · <project> · Enki", "Enki dashboard". */
export const PAGE_TITLE = '· Enki|Enki dashboard'

export const isKde = (env = process.env) => process.platform === 'linux' && /KDE/i.test(env.XDG_CURRENT_DESKTOP ?? '')

/** The KWin script: Plasma 6 names (windowList, activeWindow), with Plasma 5's as a fallback. */
export function kwinScript(title = PAGE_TITLE) {
  return `const pattern = new RegExp(${JSON.stringify(title)})
const windows = workspace.windowList ? workspace.windowList() : workspace.clientList()
const pages = windows.filter(w => w.normalWindow && pattern.test(w.caption))
const target = pages[pages.length - 1]
if (target) {
  target.minimized = false
  if (!target.onAllDesktops && target.desktops && target.desktops.length && target.desktops.indexOf(workspace.currentDesktop) === -1) {
    workspace.currentDesktop = target.desktops[0]
  }
  if ('activeWindow' in workspace) workspace.activeWindow = target
  else workspace.activeClient = target
}
`
}

const gdbus = (args, path) =>
  execFileSync('gdbus', ['call', '--session', '--dest', 'org.kde.KWin', '--object-path', path, '--method', ...args], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })

function runOnce(file, name) {
  const id = gdbus(['org.kde.kwin.Scripting.loadScript', file, name], '/Scripting').replace(/\D/g, '')
  try {
    // Plasma 6 puts the script at /Scripting/Script<id>, Plasma 5 at /<id>.
    try {
      gdbus(['org.kde.kwin.Script.run'], `/Scripting/Script${id}`)
    } catch {
      gdbus(['org.kde.kwin.Script.run'], `/${id}`)
    }
  } finally {
    gdbus(['org.kde.kwin.Scripting.unloadScript', name], '/Scripting')
  }
}

const sleep = ms => new Promise(done => setTimeout(done, ms))

/**
 * Raises the browser window showing a dashboard page, on KDE. It tries twice, as the page's
 * title only appears once the new tab has loaded. Any failure (no KDE, no gdbus) is silent.
 */
export async function raiseDashboardWindow({ title = PAGE_TITLE, delays = [800, 1600] } = {}) {
  if (!isKde()) return false
  const name = `enki-raise-${process.pid}`
  const file = join(tmpdir(), `${name}.js`)
  try {
    writeFileSync(file, kwinScript(title))
    for (const delay of delays) {
      await sleep(delay)
      runOnce(file, name)
    }
    return true
  } catch {
    return false
  } finally {
    rmSync(file, { force: true })
  }
}
