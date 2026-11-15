import { createHash, generateKeyPairSync } from 'node:crypto'
import { openDemandStore } from '../../src/demand-store.js'
import { goalTicketSigner } from '../../src/goal-ticket-crypto.js'
import type { DemandDelegationReportInput } from '../../src/delegations.js'
import type { GoalPlanReviewInput, GoalPlanReviewer, GoalPlanRevisionInput } from '../../src/goal-plan.js'

/** Friendly fixture labels are translated to the IDs returned by the actual publication. */
export function goalTickets(root: string, owner = { runtimeId: 'owner-runtime', namespace: 'namespace' }) {
  const keys = generateKeyPairSync('ed25519'), key = keys.publicKey.export({ format: 'der', type: 'spki' })
  const issuer = goalTicketSigner(owner, key.toString('base64url'), createHash('sha256').update(key).digest('hex'), keys.privateKey)
  const store = openDemandStore({ root, goalTicketSigner: async () => issuer })
  const aliases = new Map<string, string>()
  const id = (draft: string) => aliases.get(draft) ?? draft
  return { store, owner, id, draft(id: string) { return Array.from(aliases).find(([, ticket]) => id === ticket)?.[0] ?? id },
    async revise(goalId: string, input: GoalPlanRevisionInput, author: GoalPlanReviewer) {
      const existing = new Map<string, string>()
      const current = await store.get(goalId)
      for (const revision of current?.plan?.history ?? []) {
        if (revision.revision > input.expectedRevision) break
        for (const ticket of revision.createdTickets ?? []) if (ticket.record.kind === 'issued') existing.set(ticket.record.draftId, ticket.hash)
      }
      const resolve = (key: string) => existing.get(key) ?? key
      const result = await store.revisePlan(goalId, { ...input, nodes: input.nodes.map(node => ({ ...node, id: resolve(node.id), dependsOn: node.dependsOn.map(resolve) })) }, author)
      for (const entry of result.demand.plan?.history ?? []) for (const ticket of entry.createdTickets ?? [])
        if (ticket.record.kind === 'issued') aliases.set(ticket.record.draftId, ticket.hash)
      return result
    },
    async submit(goalId: string, attemptId: string, input: DemandDelegationReportInput, worker: string) {
      const entry = await store.inspectDelegation(goalId, attemptId)
      return store.submitDelegationReport(goalId, attemptId, input, worker,
        { ownerRuntimeId: owner.runtimeId, namespace: owner.namespace, authorRuntimeId: entry?.runtimeIdentity?.workerRuntimeId ?? owner.runtimeId })
    },
    async review(goalId: string, input: GoalPlanReviewInput, author: GoalPlanReviewer) {
      const entry = await store.inspectDelegation(goalId, input.delegationOperationId).catch(() => null)
      const hash = entry?.report?.delivery?.hash
      return store.reviewPlanNode(goalId, { ...input, nodeId: id(input.nodeId), ...(hash && !input.deliveryHash ? { deliveryHash: hash } : {}) }, author)
    },
  }
}
