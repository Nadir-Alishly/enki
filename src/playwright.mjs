// QA's browser: the Playwright MCP server, installed once into enki's own folder.
// It never touches a project, and nothing downloads unless someone runs `enki playwright install`.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { enkiHome } from './state.mjs'

/** Pinned, and at least two weeks old when chosen, so a brand-new release can't slip in. */
export const MCP_VERSION = '0.0.83'
export const MCP_SIZE = 'about 20 MB'
export const BROWSER_SIZE = 'about 150 MB'

export const playwrightHome = () => join(enkiHome(), 'playwright')
const packageDir = () => join(playwrightHome(), 'node_modules', '@playwright', 'mcp')
export const mcpCli = () => join(packageDir(), 'cli.js')
const browsersDir = () => join(playwrightHome(), 'browsers')

export function installedVersion() {
  try {
    return JSON.parse(readFileSync(join(packageDir(), 'package.json'), 'utf8')).version
  } catch {
    return null
  }
}

const SYSTEM_BROWSERS = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome']
const MAC_BROWSERS = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']

function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const path = join(dir, name)
    try {
      if (statSync(path).isFile()) return path
    } catch {
      // Not in this folder.
    }
  }
  return null
}

const downloadedBrowser = () => existsSync(browsersDir()) && readdirSync(browsersDir()).some(name => name.startsWith('chromium'))

/** The configured browser, then an installed Chrome or Chromium, then one enki downloaded. */
export function findBrowser(config) {
  const configured = config.browser.executable
  if (configured) return existsSync(configured) ? { kind: 'configured', path: configured } : { kind: 'missing', path: configured }
  for (const name of SYSTEM_BROWSERS) {
    const path = onPath(name)
    if (path) return { kind: 'system', path }
  }
  const mac = MAC_BROWSERS.find(path => existsSync(path))
  if (mac) return { kind: 'system', path: mac }
  return downloadedBrowser() ? { kind: 'downloaded', path: null } : null
}

/** Why QA can't have its browser, or null. */
export function playwrightProblem(config) {
  if (installedVersion() !== MCP_VERSION) {
    return `Playwright isn't installed for enki. Ask the user, then run: enki playwright install (downloads @playwright/mcp ${MCP_VERSION}, ${MCP_SIZE}, into ${playwrightHome()})`
  }
  const browser = findBrowser(config)
  if (browser?.kind === 'missing') return `browser.executable doesn't exist: ${browser.path}`
  if (!browser) return `No Chrome or Chromium was found. Ask the user, then run: enki playwright install --browser (downloads Chromium, ${BROWSER_SIZE}), or set browser.executable in .enki/config.json`
  return null
}

export function install({ browser = false } = {}) {
  mkdirSync(playwrightHome(), { recursive: true })
  const npm = process.env.ENKI_NPM_BIN || 'npm'
  const run = (command, args, env = {}) =>
    execFileSync(command, args, { cwd: playwrightHome(), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 600000 })
  const steps = []
  if (installedVersion() !== MCP_VERSION) {
    run(npm, ['install', '--prefix', playwrightHome(), '--no-audit', '--no-fund', '--ignore-scripts', `@playwright/mcp@${MCP_VERSION}`])
    steps.push(`Installed @playwright/mcp ${MCP_VERSION}.`)
  } else steps.push(`@playwright/mcp ${MCP_VERSION} is already installed.`)
  if (browser) {
    const cli = join(playwrightHome(), 'node_modules', 'playwright-core', 'cli.js')
    run(process.execPath, [cli, 'install', 'chromium'], { PLAYWRIGHT_BROWSERS_PATH: browsersDir() })
    steps.push('Downloaded Chromium.')
  }
  return steps
}

/** The MCP config for one QA agent: headless, isolated, and pointed at the project's own pages. */
export function mcpConfig({ config, origins, outputDir }) {
  const browser = findBrowser(config)
  const args = [mcpCli(), '--headless', '--isolated', '--output-dir', outputDir, '--allowed-origins', origins.join(';')]
  const env = {}
  if (browser.kind === 'downloaded') env.PLAYWRIGHT_BROWSERS_PATH = browsersDir()
  else args.push('--executable-path', browser.path)
  if (config.browser.headless === false) args.splice(args.indexOf('--headless'), 1)
  return { mcpServers: { playwright: { command: process.execPath, args, env } } }
}

export function status(config) {
  const version = installedVersion()
  const browser = findBrowser(config)
  return [
    version ? `@playwright/mcp ${version}${version === MCP_VERSION ? '' : ` (enki needs ${MCP_VERSION}: run enki playwright install)`}` : `@playwright/mcp not installed (enki playwright install, ${MCP_SIZE})`,
    browser?.path ? `Browser: ${browser.path} (${browser.kind})` : browser ? 'Browser: Chromium downloaded by enki' : `Browser: none found (enki playwright install --browser, ${BROWSER_SIZE})`,
    `Headless: ${config.browser.headless !== false}`,
  ]
}
