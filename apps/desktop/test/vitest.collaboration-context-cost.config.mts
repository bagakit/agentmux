import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from './vitest.collaboration-space-product.config.mts'
export const collaborationContextMutation = {
  name: 'unscoped-context', file: 'components/AgentCollaborationMap.tsx',
  before: 'const refresh = new Set([...contextDemand, ...contextCache.current.keys()])', after: 'const refresh = new Set(catalog.sessions.keys())',
  assertion: 'keeps the full map world while bounding production contexts and reads to the visible and selected Agents'
} as const
export const collaborationContextMutations = [collaborationContextMutation, {
  name: 'stale-held-context', file: 'components/AgentCollaborationMap.tsx',
  before: 'const refresh = new Set([...contextDemand, ...contextCache.current.keys()])', after: 'const refresh = new Set(contextDemand)',
  assertion: 'refreshes retained exact Agent metadata outside body demand'
}] as const
const selected = process.env.AGENTMUX_COLLABORATION_CONTEXT_MUTATION
const mutation = collaborationContextMutations.find(item => item.name === selected)
if (selected && !mutation) throw Error('Unknown context mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...shared, plugins: [...shared.plugins ?? [], { name: 'collaboration-context-source-proof', enforce: 'pre', transform(source, id) {
  const path = relative(process.cwd(), id.split('?')[0]!)
  if (!path.startsWith('apps/desktop/src/') && !path.startsWith('packages/')) return
  let code = source
  if (mutation && path === 'apps/desktop/src/renderer/src/' + mutation.file) {
    if (code.split(mutation.before).length !== 2) throw Error('Unique context mutation anchor required')
    code = code.replace(mutation.before, mutation.after)
  }
  if (process.env.AGENTMUX_COLLABORATION_CONTEXT_LOADED) appendFileSync(process.env.AGENTMUX_COLLABORATION_CONTEXT_LOADED, JSON.stringify({ path, originalSHA256: hash(source), effectiveSHA256: hash(code), mutated: source !== code }) + '\n')
  if (source !== code) return { code, map: null }
} }], test: { ...shared.test, include: ['apps/desktop/test/collaboration-context-cost.test.tsx'], passWithNoTests: false } })
