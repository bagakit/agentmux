import assert from 'node:assert/strict'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from '../../../../../vitest.config'
const root = resolve(import.meta.dirname, '../../../../..')
const mutations: Record<string, [string, string, string]> = {
  retention: ['apps/desktop/src/renderer/src/lib/renderer-performance.ts', 'if (slowEvents.length === 32) slowEvents.shift()', '/* mutant: unbounded retention */'],
  cleanup: ['apps/desktop/src/renderer/src/components/TerminalView.tsx', '      releasePerformance()', '      /* mutant: leaked Terminal reader */'],
  projection: ['apps/desktop/src/main/resource-usage-control.ts', 'performance: result.performance', 'performance: undefined'],
  visibility: ['apps/desktop/src/renderer/src/lib/renderer-performance.ts', "consumers[kind][visible ? 'visible' : 'hidden']\n      cost.checks++", "consumers[kind].visible\n      cost.checks++"]
}
export default defineConfig({ ...base, root, plugins: [{ name: 'terminal-cost-behavioral-mutation', enforce: 'pre', transform(code, id) {
  const change = mutations[process.env.AGENTMUX_TERMINAL_COST_MUTANT ?? '']
  if (change && relative(root, id.split('?')[0]!) === change[0]) {
    assert.equal(code.split(change[1]).length - 1, 1, 'Mutation must hit exactly one production anchor')
    process.stderr.write(`MUTATION_APPLIED=${process.env.AGENTMUX_TERMINAL_COST_MUTANT}\n`)
    return { code: code.replace(change[1], change[2]), map: null }
  }
} }], test: { ...base.test, include: ['apps/desktop/test/renderer-performance.test.tsx', 'apps/desktop/test/metrics-main-control.test.ts',
  'apps/desktop/test/terminal-webgl-visibility.test.tsx'], passWithNoTests: false, testTimeout: 12_000, fileParallelism: false, maxWorkers: 1 } })
