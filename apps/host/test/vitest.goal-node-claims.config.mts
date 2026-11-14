import { defineConfig } from 'vitest/config'
import crossHost from './vitest.goal-cross-host.config.mts'
import { writeFileSync } from 'node:fs'

const changes = {
  'allow-related': { path: 'apps/host/src/goal-plan-assignment.ts', from: "if (!goal.assigneeSessionIds.includes(actor.id)) denied(",
    to: "if (!goal.assigneeSessionIds.includes(actor.id) && !goal.sessionIds.includes(actor.id)) denied(" },
  'lose-executor': { path: 'packages/demand/src/demand-store.ts', from: 'node.executor = { hostId: author.hostId, agentSessionId: author.id }', to: 'node.executor = null' }
}
export default defineConfig({ ...crossHost, plugins: [...(crossHost.plugins ?? []), { name: 'goal-node-claims-mutation', enforce: 'pre',
  transform(source: string, id: string) {
    const label = process.env.NODE_CLAIM_MUTATION as keyof typeof changes | undefined
    if (!label) return
    const change = changes[label]
    if (!id.split('?')[0]!.endsWith('/' + change.path)) return
    if (source.split(change.from).length !== 2) throw new Error('Claim mutation must match one exact original expression')
    writeFileSync(process.env.NODE_CLAIM_WITNESS!, change.path)
    return source.replace(change.from, change.to)
  } }], test: { ...crossHost.test, testTimeout: 120_000, include: ['apps/host/test/goal-claim-role.test.ts', 'apps/host/test/goal-node-claims.test.ts',
      'apps/host/test/goal-plan-revision-product.test.ts', 'packages/demand/test/goal-plan-revision.test.ts', 'packages/demand/test/goal-plan.test.ts'] } })
