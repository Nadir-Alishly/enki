// The models the settings page offers: Claude Code's own catalog for this account, the list its
// /model picker shows, cached under ~/.claude/cache/model-catalog. It isn't a documented file, so
// anything unexpected falls back to enki's built-in list, and the page says which one it shows.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { EFFORTS, MODELS } from '../src/config.mjs'

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

function normalize(model) {
  if (typeof model?.id !== 'string' || !model.id) return null
  const runtime = model.runtime && typeof model.runtime === 'object' ? model.runtime : null
  const levels = runtime?.effort_levels
  return {
    id: model.id,
    label: typeof model.name === 'string' && model.name ? model.name : model.id,
    description: typeof model.description === 'string' ? model.description : '',
    latest: model.section === 'main',
    // A model the catalog describes without effort levels has none; one it doesn't describe at all might.
    efforts: Array.isArray(levels) ? levels.filter(level => EFFORTS.includes(level)) : runtime ? [] : null,
    defaultEffort: typeof runtime?.default_effort === 'string' ? runtime.default_effort : null,
    autoMode: model.auto_permission_mode !== 'unavailable',
    autoModeNote: typeof model.auto_permission_mode_note === 'string' ? model.auto_permission_mode_note : null,
  }
}

/** Claude Code's newest catalog for the CLI, else for any of its apps, else null. */
function readCatalog() {
  const dir = join(claudeDir(), 'cache', 'model-catalog')
  if (!existsSync(dir)) return null
  const found = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    try {
      const data = JSON.parse(readFileSync(join(dir, name), 'utf8'))
      const models = data?.catalog?.config?.models
      if (Array.isArray(models) && models.length > 0) found.push({ cli: data.catalog.surface === 'cc', at: Number(data.fetchedAt) || 0, models })
    } catch {
      // A file being rewritten, or one in another shape: skip it.
    }
  }
  found.sort((a, b) => Number(b.cli) - Number(a.cli) || b.at - a.at)
  const best = found[0]
  if (!best) return null
  const models = best.models.map(normalize).filter(Boolean)
  return models.length ? { source: 'claude-code', fetchedAt: best.at ? new Date(best.at).toISOString() : null, models } : null
}

export function modelCatalog() {
  return (
    readCatalog() ?? {
      source: 'enki',
      fetchedAt: null,
      models: MODELS.map(model => ({ ...model, description: '', latest: true, efforts: null, defaultEffort: null, autoMode: true, autoModeNote: null })),
    }
  )
}
