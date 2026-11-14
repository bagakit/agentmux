import '../../../../apps/host/test/mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { relative } from 'node:path'
import { instrumentInitialization } from './platform-initialization-mutations.mjs'
const root = resolve(import.meta.dirname, '../../../..')
registerHooks({ resolve(specifier, context, next) {
  const file = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
  const prefix = resolve(root, 'packages/core/dist') + '/'
  if (file.startsWith(prefix) && file.endsWith('.js')) {
    const source = resolve(root, 'packages/core/src', file.slice(prefix.length).replace(/\.js$/u, '.ts'))
    if (existsSync(source)) return next(pathToFileURL(source).href, context)
  }
  return next(specifier, context)
}, load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const source = String(result.source), loaded = instrumentInitialization(source, relative(root, fileURLToPath(url)), 'node')
  return loaded === source ? result : { ...result, source: loaded }
} })
