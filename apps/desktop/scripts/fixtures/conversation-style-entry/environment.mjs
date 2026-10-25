import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { aliases as baseAliases, root, installedRoot, desktopRequire, installedDependency } from '../settings-resource-library/environment.mjs'
// This fixture consumes the current Worktree's public Host exports. Shared resolver stays intact.
const host = resolve(root, 'apps/host'), exports = JSON.parse(readFileSync(resolve(host, 'package.json'), 'utf8')).exports
export const aliases = [...Object.entries(exports).map(([key, value]) => {
  const target = typeof value === 'string' ? value : value.import
  return { find: new RegExp('^@agentmux/host' + (key === '.' ? '' : key.slice(1)) + '$'),
    replacement: resolve(host, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')) }
}), ...baseAliases]
export { root, installedRoot, desktopRequire, installedDependency }
