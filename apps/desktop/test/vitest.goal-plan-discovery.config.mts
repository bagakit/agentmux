import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const owners = new Set([
  'apps/desktop/test/goal-plan-discovery-product.test.tsx', 'apps/desktop/test/helpers/host-goal-discussion-fixture.ts', 'apps/desktop/test/helpers/host-goal-transport.ts',
  'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx',
  'apps/desktop/src/renderer/src/components/GoalDetail.tsx',
  'apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx',
  'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts',
  'apps/host/src/goals.ts', 'apps/host/src/goal-discussions.ts',
  'apps/host/src/goal-delegation-owner.ts', 'apps/host/src/goal-projection.ts',
  'apps/host/src/goal-pmo-origin.ts', 'apps/host/src/goal-participation-owner.ts',
  'packages/demand/src/demand-store.ts', 'packages/demand/src/goal-plan.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc.ts'
])
const mutant = process.env.GOAL_PLAN_DISCOVERY_MUTANT ? JSON.parse(process.env.GOAL_PLAN_DISCOVERY_MUTANT) : undefined
export default { ...original, plugins: [...(original.plugins ?? []), {
  name: 'goal-plan-discovery-evaluated-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(repository, id.split('?')[0]!)
    if (!owners.has(path)) return
    const originalSHA256 = createHash('sha256').update(source).digest('hex')
    if (mutant?.path === path) {
      if (source.split(mutant.anchor).length !== 2) throw Error('The discovery mutant must match one exact owner: ' + mutant.id)
      source = source.replace(mutant.anchor, mutant.replacement)
    }
    // Select the shipping native-data branch exactly as the existing native
    // workbench storage consumer does. API remains the controlled IPC port.
    const nativeStorage = ['apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/lib/desktop-user-state.ts', 'apps/desktop/src/renderer/src/lib/launcher-state.ts'].includes(path)
    if (nativeStorage) source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    const loadedSHA256 = createHash('sha256').update(source).digest('hex')
    const receipt = { path, consumer: 'mounted-renderer-public-host', originalSHA256, loadedSHA256,
      ...(nativeStorage ? { selectedBranch: 'shipping-native-user-data' } : {}), ...(mutant?.path === path ? { mutant: mutant.id } : {}) }
    const proof = process.env.GOAL_PLAN_DISCOVERY_LOADED
    if (!proof) return source
    return `import { appendFileSync as __goalPlanDiscoveryLoaded } from 'node:fs'; __goalPlanDiscoveryLoaded(${JSON.stringify(proof)}, ${JSON.stringify(JSON.stringify(receipt) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-plan-discovery-product.test.tsx'],
  passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 35_000, hookTimeout: 30_000 } }
