import '../../../../apps/host/test/mote-presence-node-loader.mjs'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'

const root = new URL('../../', import.meta.url)
const exports = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')).exports
registerHooks({ resolve(specifier, context, next) {
  if (specifier === '@agentmux/core' || specifier.startsWith('@agentmux/core/')) {
    const entry = exports[specifier === '@agentmux/core' ? '.' : `.${specifier.slice('@agentmux/core'.length)}`]?.import
    if (entry) return next(new URL(entry, root).href, context)
  }
  return next(specifier, context)
} })
