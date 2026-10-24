import './mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instrumentHandoffSource } from './goal-discussion-handoff-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:')) return result
  const source = String(result.source), changed = instrumentHandoffSource(source, relative(root, fileURLToPath(url)), 'node-loader')
  return changed === source ? result : { ...result, source: changed }
} })
