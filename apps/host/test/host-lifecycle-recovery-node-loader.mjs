import { registerHooks } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
const root = resolve(import.meta.dirname, '../../..')
const listener = resolve(root, 'packages/core/dist/control-endpoint-listener-worker.js')
registerHooks({ resolve(specifier, context, next) {
  const path = specifier.startsWith('file:') ? fileURLToPath(specifier) : specifier
  if (path === listener) {
    const file = process.env.HOST_LIFECYCLE_LISTENER_ENTRY
    if (!file) throw Error('The private source listener bundle is required')
    return next(pathToFileURL(file).href, context)
  }
  return next(specifier, context)
} })
