import './mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { instrumentExecutorRecovery } from './session-executor-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const source = String(result.source), changed = instrumentExecutorRecovery(source, relative(root, fileURLToPath(url)), 'node-loader')
  return changed === source ? result : { ...result, source: changed }
} })
