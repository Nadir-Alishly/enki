import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The plugin's own folder. Works in any install location, and in Bash, where the plugin variables aren't set. */
export const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
