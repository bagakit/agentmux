import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

export const root = resolve(import.meta.dirname, '../../../../..')
const common = resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim())
export const installedRoot = dirname(common)
export const desktopRequire = createRequire(resolve(installedRoot, 'apps/desktop/package.json'))
export const aliases = []
for (const name of ['core', 'demand', 'layout']) {
  const directory = resolve(root, 'packages', name)
  const exports = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')).exports
  for (const [key, value] of Object.entries(exports)) {
    const target = typeof value === 'string' ? value : value.import
    aliases.push({ find: new RegExp('^@agentmux/' + name + (key === '.' ? '' : key.slice(1)) + '$'),
      replacement: resolve(directory, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')) })
  }
}
const client = resolve(root, 'packages/client-ui/src')
aliases.unshift(
  { find: /^@agentmux\/client-ui\/input$/u, replacement: client + '/input/index.ts' },
  { find: /^@agentmux\/client-ui\/input\/styles.css$/u, replacement: client + '/input/input.css' },
  { find: /^@agentmux\/client-ui\/theme$/u, replacement: client + '/theme/index.ts' },
  { find: /^@agentmux\/client-ui\/icons$/u, replacement: client + '/theme/icons.tsx' },
  { find: /^@agentmux\/client-ui\/styles.css$/u, replacement: client + '/styles/index.css' },
  { find: /^@agentmux\/client-ui\/note\/(.+)$/u, replacement: client + '/note/$1.ts' },
  { find: /^@agentmux\/client-ui\/styles\/(.+)$/u, replacement: client + '/styles/$1' },
  { find: /^@agentmux\/client-ui\/components\/(.+)$/u, replacement: client + '/components/$1.tsx' },
  { find: /^@agentmux\/client-ui\/terminal\/(.+)$/u, replacement: client + '/terminal/$1.ts' },
  { find: /^@agentmux\/client-ui\/platform$/u, replacement: client + '/platform.tsx' },
  { find: /^@agentmux\/client-ui$/u, replacement: client + '/index.ts' },
  { find: /^@agentmux\/client-ui\/(.+)$/u, replacement: client + '/lib/$1.ts' })
for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom', 'react-dom/client']) {
  aliases.unshift({ find: new RegExp('^' + name + '$'), replacement: desktopRequire.resolve(name) })
}

/** Resolve installed dependencies without rebuilding or modifying any shared workspace. */
export function installedDependency(source, importer) {
  if (source.startsWith('.') || source.startsWith('/') || source.startsWith('\0') || source.startsWith('@agentmux/') || source === 'vitest' || source.startsWith('node:')) return
  const packageName = importer?.startsWith(root + '/packages/') ? relative(resolve(root, 'packages'), importer).split('/')[0] : null
  const question = source.indexOf('?'), bare = question < 0 ? source : source.slice(0, question), query = question < 0 ? '' : source.slice(question)
  if (packageName) {
    try { return createRequire(resolve(installedRoot, 'packages', packageName, 'package.json')).resolve(bare) + query } catch {}
  }
  try { return desktopRequire.resolve(bare) + query } catch { return undefined }
}
