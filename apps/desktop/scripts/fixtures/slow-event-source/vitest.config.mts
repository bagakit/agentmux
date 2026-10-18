import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import base from '../terminal-restart-memory/vitest.config.mts'
const store = 'apps/desktop/src/renderer/src/store.ts'
const interaction = 'apps/desktop/src/renderer/src/lib/terminal-interaction-observation.ts'
const mutations = {
  event: [store, 'rendererPerformance.sessionEvent(event.event.type, observationStarted, observationSource)',
    'rendererPerformance.sessionEvent(event.event.type, observationStarted, null)'],
  request: [interaction, "current.slow('write-request', elapsed, startedAt, source)",
    "current.slow('write-request', elapsed, startedAt, { ...current.readSource() })"]
} as const
export default { ...base, plugins: [...(base.plugins ?? []), {
  name: 'slow-event-source', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(base.root!, id.split('?')[0]!)
    if (![store, interaction, 'apps/desktop/src/renderer/src/components/TerminalView.tsx',
      'apps/desktop/src/renderer/src/lib/renderer-performance.ts'].includes(path)) return
    let code = source, applied: string | null = null
    const mutation = process.env.AGENTMUX_SLOW_SOURCE_MUTATION
    if (mutation) {
      assert.ok(Object.hasOwn(mutations, mutation))
      const [target, from, to] = mutations[mutation as keyof typeof mutations]
      if (path === target) { assert.equal(code.split(from).length - 1, 1); code = code.replace(from, to); applied = mutation }
    }
    if (process.env.AGENTMUX_SLOW_SOURCE_LOADED) appendFileSync(process.env.AGENTMUX_SLOW_SOURCE_LOADED,
      JSON.stringify({ path, mutation: applied, sourceSHA256: createHash('sha256').update(source).digest('hex'),
        effectiveSHA256: createHash('sha256').update(code).digest('hex') }) + '\n')
    return code === source ? undefined : { code, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/session-event-cost.test.ts', 'apps/desktop/test/session-event-store.test.tsx',
  'apps/desktop/test/terminal-incident-product.test.tsx', 'apps/desktop/test/renderer-performance-event-coverage.test.tsx'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false } }
