import './mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { instrumentGoalOwnerRecovery, goalOwnerRecoverySource } from './goal-owner-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({
  resolve(id, context, next) {
    const file = goalOwnerRecoverySource(root, id)
    return next(file ? pathToFileURL(file).href : id, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    if (!url.startsWith('file:')) return result
    const source = instrumentGoalOwnerRecovery(String(result.source), relative(root, fileURLToPath(url)), 'node-process')
    return source === String(result.source) ? result : { ...result, source }
  }
})
