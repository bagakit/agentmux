import './goal-cross-host-node-loader.mjs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { instrumentPlanningSource } from './goal-planning-discussion-source.mjs'
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.startsWith('file:') || result.source == null) return result
  const source = String(result.source), changed = instrumentPlanningSource(source, fileURLToPath(url), 'public-cli')
  return changed === source ? result : { ...result, source: changed }
} })
