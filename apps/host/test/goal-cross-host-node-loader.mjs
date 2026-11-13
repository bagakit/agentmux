import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { repositoryRoot, sourceAliases, instrumentCrossHostSource } from './goal-cross-host-source.mjs'

registerHooks({
  resolve(specifier, context, next) {
    const mapped = sourceAliases.find(entry => entry.find === specifier || entry.find.includes('*') && specifier.startsWith(entry.find.split('*')[0]))
    let file = mapped?.replacement.replace('*', specifier.slice(mapped.find.indexOf('*')))
    if (!file && specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = resolve(dirname(fileURLToPath(context.parentURL)), specifier)
      if (candidate === resolve(repositoryRoot, 'packages/core/dist/agentmux.js')) file = resolve(repositoryRoot, 'packages/core/src/agentmux.ts')
      else if (candidate.endsWith('.js') && !existsSync(candidate) && existsSync(candidate.slice(0, -3) + '.ts')) file = candidate.slice(0, -3) + '.ts'
    }
    return next(file ? pathToFileURL(file).href : specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    if (!url.startsWith('file:') || result.source == null) return result
    return { ...result, source: instrumentCrossHostSource(String(result.source), fileURLToPath(url), 'public-cli') }
  }
})
