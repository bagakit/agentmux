import '../../../../apps/host/test/mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { relative } from 'node:path'
import { instrumentInitialization } from './platform-initialization-mutations.mjs'
const root = resolve(import.meta.dirname, '../../../..')
const compiled = process.env.AMX_SESSION_STATE_COMPILED
function compiledCore(file) {
  if (!compiled) return
  for (const directory of ['src', 'dist']) {
    const prefix = resolve(root, 'packages/core', directory) + '/'
    if (file.startsWith(prefix)) {
      const target = resolve(compiled, file.slice(prefix.length).replace(/\.ts$/u, '.js'))
      if (!existsSync(target)) throw new Error('The exact private compiled Core input is missing: ' + relative(compiled, target))
      return target
    }
  }
}
registerHooks({ resolve(specifier, context, next) {
  if (!compiled && specifier === '@agentmux/providers/grok/input-initialization') {
    return next(pathToFileURL(resolve(root, 'packages/providers/src/grok/input-initialization.ts')).href, context)
  }
  const file = specifier.startsWith('file:') ? fileURLToPath(specifier)
    : specifier.startsWith('.') && context.parentURL?.startsWith('file:')
      ? resolve(dirname(fileURLToPath(context.parentURL)), specifier) : specifier
  const exact = compiledCore(file)
  if (exact) return next(pathToFileURL(exact).href, context)
  for (const packageName of ['core', 'connectors']) {
    const prefix = resolve(root, 'packages', packageName, 'dist') + '/'
    if (file.startsWith(prefix) && file.endsWith('.js')) {
      const source = resolve(root, 'packages', packageName, 'src', file.slice(prefix.length).replace(/\.js$/u, '.ts'))
      if (existsSync(source)) return next(pathToFileURL(source).href, context)
    }
  }
  const result = next(specifier, context)
  const target = result.url.startsWith('file:') ? compiledCore(fileURLToPath(result.url)) : undefined
  return target ? next(pathToFileURL(target).href, context) : result
}, load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const source = String(result.source), loaded = instrumentInitialization(source, relative(root, fileURLToPath(url)), 'node')
  return loaded === source ? result : { ...result, source: loaded }
} })
