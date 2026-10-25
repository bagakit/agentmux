import './mobile-web-node-loader.mjs'
import { registerHooks } from 'node:module'
import { relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { instrumentGoalOwnerRecovery } from './goal-owner-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({
  resolve(id, context, next) {
    const file = id === '@agentmux/demand' ? 'index' : id.startsWith('@agentmux/demand/') ? id.slice('@agentmux/demand/'.length) : null
    return next(file === null ? id : pathToFileURL(resolve(root, 'packages/demand/src', file + '.ts')).href, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    if (!url.startsWith('file:')) return result
    const source = instrumentGoalOwnerRecovery(String(result.source), relative(root, fileURLToPath(url)), 'node-process')
    return source === String(result.source) ? result : { ...result, source }
  }
})
