import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/** Resolve a declared workspace export to its original source for private proofs. */
export function workspaceSourceExport(root, specifier) {
  const matched = /^@agentmux\/([^/]+)(.*)$/u.exec(specifier)
  if (!matched) return
  const directory = resolve(root, matched[1] === 'host' ? 'apps/host' : 'packages/' + matched[1])
  const manifest = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'))
  const key = matched[2] ? '.' + matched[2] : '.'
  let entry = manifest.exports?.[key], substitution
  if (!entry) for (const [pattern, value] of Object.entries(manifest.exports ?? {}).sort(([a], [b]) => b.length - a.length)) {
    const [prefix, suffix] = pattern.split('*')
    if (pattern.includes('*') && key.startsWith(prefix) && key.endsWith(suffix)) {
      entry = value; substitution = key.slice(prefix.length, suffix ? -suffix.length : undefined); break
    }
  }
  let path = typeof entry === 'string' ? entry : entry?.types ?? entry?.import
  if (substitution !== undefined) path = path?.replace('*', substitution)
  if (typeof path !== 'string') throw Error('Declared workspace source export is unavailable: ' + specifier)
  const file = resolve(directory, path.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts'))
  if (existsSync(file)) return file
  if (existsSync(file.replace(/\.ts$/u, '.tsx'))) return file.replace(/\.ts$/u, '.tsx')
  throw Error('Declared workspace source is unavailable: ' + specifier)
}
