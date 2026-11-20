import { fileURLToPath } from 'node:url'
import { resolve, join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const packageSource = fileURLToPath(new URL('../src', import.meta.url))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

/** Resolve the declared package entries to the matching candidate source. */
export function browserSourceAliases(source = packageSource) {
  return Object.fromEntries(Object.entries(manifest.exports).sort(([a], [b]) => b.length - a.length).map(([key, entry]) => [
    manifest.name + (key === '.' ? '' : key.slice(1)),
    join(source, entry.import.replace(/^\.\/dist\//u, '').replace(/\.js$/u, '.ts'))
  ]))
}

/** Native proof bundles consume the candidate's source, and published consumers use dist. */
export function browserSourceBuild(module) {
  if (module && typeof module.then === 'function') return module.then(browserSourceBuild)
  const options = input => {
    const candidate = input.absWorkingDir ? resolve(input.absWorkingDir, 'packages/browser/src') : null
    const source = candidate && existsSync(candidate) ? candidate : packageSource
    return { ...input, alias: { ...input.alias, ...browserSourceAliases(source) } }
  }
  return { ...module, build: input => module.build(options(input)), buildSync: input => module.buildSync(options(input)) }
}
