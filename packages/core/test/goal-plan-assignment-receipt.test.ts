import { describe, expect, it } from 'vitest'
import { parseGoalDelegationParams, parseGoalDelegationRpcResult } from '../src/goal-delegation.js'

const target = { goalId: 'release', nodeId: 'verify', expectedRevision: 1, operationId: 'pick-up' }
const author = { kind: 'agent', id: 'worker', hostId: 'source', runtimeId: 'runtime' }
const executor = { hostId: 'source', agentSessionId: 'worker' }
const node = { id: 'verify', title: 'Verify', outcome: 'Verify build', criterionIds: ['build'], check: 'pnpm test', dependsOn: [], executor }
const first = { operationId: 'plan', revision: 1, revisedAt: 1, author }
const claim = { operationId: 'pick-up', revision: 2, revisedAt: 2, author, change: { nodeId: 'verify', assignment: { kind: 'claim' } } }
const result = { goalId: 'release', goalUpdatedAt: 2, delegations: [], diskDurability: 'confirmed',
  plan: { alignmentRevision: 1, revision: 2, nodes: [node], history: [first, claim], reviews: [] } }

describe('Goal node assignment receipts', () => {
  it('admits the saved claim for the original revision and retains it after later reassignment', () => {
    expect(parseGoalDelegationRpcResult('goal.plan.claim', result, target).plan?.nodes[0]?.executor).toEqual(executor)
    const next = { ...result.plan, revision: 3, nodes: [{ ...node, executor: { ...executor, agentSessionId: 'successor' } }],
      history: [...result.plan.history, { ...first, revision: 3, operationId: 'new-plan' }] }
    expect(parseGoalDelegationRpcResult('goal.plan.claim', { ...result, plan: next }, target).plan?.history[1]).toEqual(claim)
  })

  it('an unrelated history entry, executor or manager action cannot confirm the original operation', () => {
    for (const record of [{ ...claim, operationId: 'other' }, { ...claim, change: { ...claim.change, nodeId: 'other' } },
      { ...claim, author: { kind: 'user', id: 'local' } }]) {
      const plan = { ...result.plan, history: [first, record] }
      expect(() => parseGoalDelegationRpcResult('goal.plan.claim', { ...result, plan }, target)).toThrow()
    }
    const plan = { ...result.plan, nodes: [{ ...node, executor: { ...executor, hostId: 'other' } }] }
    expect(() => parseGoalDelegationRpcResult('goal.plan.claim', { ...result, plan }, target)).toThrow()
    expect(() => parseGoalDelegationRpcResult('goal.plan.assignment', result, { ...target, assignment: { kind: 'open' } })).toThrow()
  })

  it('scope pins comprise a Runtime and namespace, and only the connection supplies the claimant', () => {
    const expectedOwner = { runtimeId: 'runtime', namespace: 'scope' }
    expect(parseGoalDelegationParams('goal.plan.claim', { ...target, expectedOwner })).toEqual({ ...target, expectedOwner })
    for (const extra of [{ expectedOwner: { runtimeId: 'runtime' } }, { actor: author }, { executor }, { expectedRevision: 0 }])
      expect(() => parseGoalDelegationParams('goal.plan.claim', { ...target, ...extra })).toThrow()
  })
})
