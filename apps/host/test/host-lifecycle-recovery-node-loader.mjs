import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { instrumentLifecycleRecovery, lifecycleSource } from './host-lifecycle-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({ resolve(specifier, context, next) {
  let file = lifecycleSource(root, specifier)
  if (!file && (specifier.startsWith(root + '/') || specifier.startsWith('file:'))) {
    const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
    if (path.startsWith(root + '/') && path.includes('/dist/') && path.endsWith('.js')) {
      const source = path.replace('/dist/', '/src/').replace(/\.js$/u, '.ts')
      if (!existsSync(source)) throw Error('No source for the private Node worker: ' + path)
      file = source
    }
  }
  if (!file && specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const candidate = resolve(dirname(fileURLToPath(context.parentURL)), specifier)
    if (candidate.endsWith('.js') && !existsSync(candidate) && existsSync(candidate.slice(0, -3) + '.ts')) file = candidate.slice(0, -3) + '.ts'
  }
  return next(file ? pathToFileURL(file).href : specifier, context)
}, load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const source = String(result.source), changed = instrumentLifecycleRecovery(source, relative(root, fileURLToPath(url)), 'node-source')
  return changed === source ? result : { ...result, source: changed }
} })
