import { defineConfig } from 'vitest/config'
import crossHost from './vitest.goal-cross-host.config.mts'

const changes = {
  'omit-original-report-host': { path: 'apps/host/src/goals.ts',
    from: "'message.dispatch.read', { hostId: 'local', sourceMessageId }, { principal: person }",
    to: "'message.dispatch.read', { sourceMessageId }, { principal: person }" },
  'append-drop-published-nodes': { path: 'packages/demand/src/demand-store.ts',
    from: 'const savedNodes = appending ? [...(current?.nodes ?? []), ...issued.nodes] : issued.nodes', to: 'const savedNodes = issued.nodes' },
  'active-omit-managed-goals': { path: 'packages/demand/src/goal-active-index.ts', from: "SELECT content FROM active_goal ORDER BY id", to: "SELECT content FROM active_goal WHERE 0" },
  'trust-altered-ticket': { path: 'packages/demand/src/goal-ticket-crypto.ts', from: '!verify(null, original, key, signature)', to: 'false' },
  'omit-claim-completion': { path: 'packages/demand/src/demand-store.ts', from: 'predecessors: freezeGoalTicketDependencies(signer, id, plan, basis.predecessors)', to: 'predecessors: []' },
  'ignore-absent-completion': { path: 'packages/demand/src/goal-plan.ts', from: "review?.verdict === 'pass' && !review.completion", to: 'false' },
  'ignore-older-grounding': { path: 'packages/demand/src/goal-grounding.ts',
    from: "staleCriteria.includes(criterionId) || unknown.includes('predecessors')",
    to: "delegation?.alignmentRevision !== alignment.revision || staleCriteria.includes(criterionId) || unknown.includes('predecessors')" },
  'ignore-grounding-dependencies': { path: 'packages/demand/src/goal-grounding.ts',
    from: 'new Set(contributions.flatMap(source => source.replaces))', to: 'new Set<string>()' },
  'skip-delivery-review-match': { path: 'packages/demand/src/demand-store.ts', from: 'if (projection.delegation.report?.delivery?.hash !== review.deliveryHash)', to: 'if (false)' },
  'omit-delivery-author': { path: 'packages/demand/src/demand-store.ts', from: 'scope.authorRuntimeId, report.authorAgentSessionId,', to: '' },
  'omit-delivery-report': { path: 'packages/demand/src/demand-store.ts', from: 'report.replyMessageId, report.grounding])).digest', to: 'report.replyMessageId])).digest' },
  'active-full-snapshot': { path: 'packages/demand/src/demand-store.ts', from: 'if (generation === null) return []', to: 'await this.readConfirmedSnapshot(); if (generation === null) return []' },
  'allow-related': { path: 'apps/host/src/goal-plan-assignment.ts', from: "if (!role?.assignee) denied('A related Session has no work role. Claiming requires this Goal’s current Supervisor or assignee.')",
    to: "if (!role?.assignee) return" },
  'restore-old-token': { path: 'packages/demand/src/goal-plan.ts', from: 'node.check, changedAt.get(node.id), alignmentRevision', to: 'node.check, alignmentRevision' },
  'whole-plan-token': { path: 'packages/demand/src/goal-plan.ts', from: 'goalPlanClaimToken(claimScope, claimOpeningOperationId, claimBasis)', to: 'goalPlanClaimToken(claimScope, claimOpeningOperationId, claimBasis + plan.revision)' },
  'drop-predecessors': { path: 'packages/core/src/goal-delegation-source.ts', from: '...(saved.predecessors ? { predecessors: saved.predecessors } : {})', to: '...{}' },
  'stale-first-dispatch': { path: 'packages/demand/src/demand-store.ts', from: 'demand.status === \'done\' || demand.status === \'cancelled\')\n        this.rejectDelegation(\'The saved attempt', to: 'demand.status === \'done\' || demand.status === \'cancelled\')\n        void(\'The saved attempt' },
  'lose-executor': { path: 'packages/demand/src/demand-store.ts', from: 'node.executor = { hostId: author.hostId, agentSessionId: author.id }', to: 'node.executor = null' }
}
export default defineConfig({ ...crossHost, plugins: [...(crossHost.plugins ?? []), { name: 'goal-node-claims-mutation', enforce: 'pre',
  transform(source: string, id: string) {
    const label = process.env.NODE_CLAIM_MUTATION as keyof typeof changes | undefined
    if (!label) return
    const change = changes[label]
    if (!id.split('?')[0]!.endsWith('/' + change.path)) return
    if (source.split(change.from).length !== 2) throw new Error('Claim mutation must match one exact original expression')
    process.stderr.write('Goal claim mutation loaded: ' + change.path + '\n')
    return source.replace(change.from, change.to)
  } }], test: { ...crossHost.test, testTimeout: 120_000, include: ['apps/host/test/goal-claim-role.test.ts', 'apps/host/test/goal-node-claims.test.ts',
      'apps/host/test/goal-active-cost.test.ts', 'apps/host/test/goal-ticket-journeys.test.ts', 'apps/host/test/goal-plan-revision-product.test.ts', 'packages/demand/test/goal-plan-revision.test.ts', 'packages/demand/test/goal-plan.test.ts', 'packages/demand/test/demand-delegation-hosts.test.ts'] } })
