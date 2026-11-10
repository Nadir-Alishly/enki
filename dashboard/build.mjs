// A fingerprint of the dashboard's own code, so a plugin update replaces an older running server.
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const dashboardDir = dirname(fileURLToPath(import.meta.url))

export function buildId() {
  const hash = createHash('sha256')
  for (const dir of [dashboardDir, join(dashboardDir, 'public')]) {
    for (const name of readdirSync(dir).sort()) {
      if (!/\.(mjs|js|css|html|svg)$/.test(name)) continue
      hash.update(name).update(readFileSync(join(dir, name)))
    }
  }
  return hash.digest('hex').slice(0, 12)
}
