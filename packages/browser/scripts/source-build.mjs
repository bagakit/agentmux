import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

/** Native proof bundles must consume this candidate's source, while published consumers use dist. */
export function browserSourceBuild(module) {
  if (module && typeof module.then === 'function') return module.then(browserSourceBuild)
  const packageSource = fileURLToPath(new URL('../src', import.meta.url))
  const options = input => {
    const candidate = input.absWorkingDir ? resolve(input.absWorkingDir, 'packages/browser/src') : null
    const source = candidate && existsSync(candidate) ? candidate : packageSource
    return { ...input, alias: { ...input.alias, '@agentmux/browser': source } }
  }
  return { ...module, build: input => module.build(options(input)), buildSync: input => module.buildSync(options(input)) }
}
