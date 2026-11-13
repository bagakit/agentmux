import { builtinModules, createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { candidateAlias } from '../../candidate-package-resolve.mjs'

export const root = resolve(import.meta.dirname, '../../../../..')
const common = resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
export const installedRoot = dirname(common)
export const desktopRequire = createRequire(resolve(installedRoot, 'apps/desktop/package.json'))
export const aliases = [candidateAlias(root, { source: true, browser: true })]
for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']) {
  aliases.unshift({ find: new RegExp('^' + name + '$'), replacement: desktopRequire.resolve(name) })
}

/** Resolve installed dependencies without rebuilding or modifying any shared workspace. */
export function installedDependency(source, importer) {
  if (builtinModules.includes(source) || source.startsWith('.') || source.startsWith('/') || source.startsWith('\0') || source.startsWith('@agentmux/') || source === 'vitest' || source.startsWith('node:')) return
  const packageName = importer?.startsWith(root + '/packages/') ? relative(resolve(root, 'packages'), importer).split('/')[0] : null
  const question = source.indexOf('?'), bare = question < 0 ? source : source.slice(0, question), query = question < 0 ? '' : source.slice(question)
  if (packageName) {
    try { return createRequire(resolve(installedRoot, 'packages', packageName, 'package.json')).resolve(bare) + query } catch {}
  }
  try { return desktopRequire.resolve(bare) + query } catch { return undefined }
}
