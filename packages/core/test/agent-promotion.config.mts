import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.AGENT_PROMOTION_CORE_MUTANT
if (mutant && !['source-zone-binding', 'foreign-receipt', 'omit-owner'].includes(mutant)) throw Error('Unknown promotion Core mutation')
export default defineConfig({ root,
  plugins: [{ name: 'agent-promotion-core-mutations', enforce: 'pre', transform(source, id) {
    if (!mutant) return
    let before: string, after: string
    if (mutant === 'source-zone-binding' && id.endsWith('/src/agent-promotion.ts')) {
      before = '  const next = structuredClone(graph)'
      after = "  const next = structuredClone(graph); next.bindings.push({spaceId:input.spaceId,zoneId:sourceTab.zoneId!})"
    } else if (mutant === 'foreign-receipt' && id.endsWith('/src/agent-promotion.ts')) {
      before = '!sameTarget(original, input.target)'
      after = 'false'
    } else if (mutant === 'omit-owner' && id.endsWith('/src/public-rpc-service.ts')) {
      before = 'const result = this.ports.agentPromotions ? await this.ports.agentPromotions.call(method, input, context)'
      after = 'const result = false ? await this.ports.agentPromotions!.call(method, input, context)'
    } else return
    if (source.split(before).length !== 2) throw Error('Promotion mutation anchor must match exactly once: ' + mutant)
    return { code: source.replace(before, after), map: null }
  } }], test: { include: ['packages/core/test/agent-promotion.test.ts'], environment: 'node',
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false,
    testTimeout: 15_000, hookTimeout: 15_000 } })
