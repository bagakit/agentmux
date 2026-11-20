import { defineConfig } from 'vitest/config'
import owner from './vitest.goal-cross-host.config.mts'

export default defineConfig({
  ...owner,
  plugins: [...owner.plugins ?? [], { name: 'goal-workflow-budget-mutation', enforce: 'pre', transform(source, id) {
    if (process.env.AGENTMUX_WORKFLOW_BUDGET_MUTATION !== 'skip-parallel' ||
        !id.split('?')[0]!.endsWith('/packages/demand/src/demand-store.ts')) return
    const original = 'maxConcurrent > 0 && inFlight >= maxConcurrent'
    if (source.split(original).length !== 2) throw new Error('Expected one active workflow admission guard')
    return source.replace(original, 'false')
  } }],
  test: { ...owner.test, include: ['apps/host/test/goal-workflow-budget.test.ts'], testTimeout: 120_000 }
})
